# Phase 4 — Compatibility fallbacks

Scope (plan.md §11): **1)** device capability probing, **2)** a client-side decode/compat
fallback for desktop, **3)** embedded subtitle extraction. This doc is the analysis +
proposal; the concrete build plan (§5) is finalized once the decisions in §3 are confirmed.

Phase 3 gave us **direct play** — proxy the original bytes, let native `<video>` decode
them. That leaves two known gaps in the current library:

- **S02 = H.264 (x264) in `.mkv`.** The _codec_ is universally supported; the _container_
  (`.mkv`) is not playable by Chrome/Edge `<video>`. This is the common, cheap-to-fix case.
- **S01 = H.265 (HEVC) in `.mp4`.** Plays on the dev Mac (hardware HEVC), and on Smart TVs
  (hardware HEVC). Does **not** play on a desktop lacking a hardware HEVC decoder.

---

## 1. What actually solves each gap (the research that changes the plan)

The original plan named "client-side WASM decode (`libav.js` vs `ffmpeg.wasm`)" as the Phase 4
fallback. Having looked closer, **full software WASM decode is the wrong primary tool** for
this app. Breaking the problem into container vs codec makes the cheap wins obvious:

### The container gap (`.mkv` / `.avi` holding H.264) — cheap, high value

The browser can't _open_ the container, but it can _decode_ the codec in hardware. So we don't
need to decode anything in JS — we only need to **repackage** (remux, stream-copy, no
re-encoding) the H.264/AAC elementary streams into fragmented MP4 and feed them to the native
`<video>` through **Media Source Extensions (MSE)**. Native hardware decode still does the
heavy lifting; the client cost is trivial. This closes the **entire S02/`.mkv` gap** and every
future "already-compatible-codec, wrong-container" file.

Tool for this: **`libav.js` in _remux_ mode** (`-c copy`). It demuxes MKV/AVI and muxes fMP4
without touching the frames. This is the small, fast use of libav — not the full decoder.
(`ffmpeg.wasm` can also `-c copy`, but its API is built around whole-file CLI invocations,
which is awkward for progressive/streamed playback and seeking. `libav.js` exposes the
demux/mux primitives we actually want.)

### The codec gap (HEVC on a desktop with no hardware HEVC) — genuinely hard

Key finding: **WebCodecs `VideoDecoder` does _not_ add HEVC where `<video>` lacks it.** Both
rely on the same OS/GPU hardware HEVC decoder. On a desktop without one, the _only_
client-side option is **full software decode of every frame in WASM** — which for 1080p/4K
HEVC is CPU-brutal and likely not real-time, exactly the risk flagged in plan.md §13. The
sane answer for this case is **Phase 5 server-side transcode**, not a WASM decoder that
probably can't keep up. So Phase 4 should _detect_ this case and route the user toward "switch
to server mode" (Phase 5), rather than ship a heavy decoder that disappoints.

### Net: Phase 4's realistic client-side win is the **MSE remux path**, plus a capability

probe that classifies each file into: direct-play / remux / needs-server-transcode.

---

## 2. Capability probing

A small client module builds a per-device capability profile once and caches it (sessionStorage):

- `MediaSource.isTypeSupported('video/mp4; codecs="avc1.640028,mp4a.40.2")` → can we MSE-remux
  H.264 into fMP4? (yes on all target desktops)
- `video.canPlayType(...)` / `MediaSource.isTypeSupported(...hvc1...)` → native/MSE HEVC?
- `VideoDecoder.isConfigSupported(...)` (where WebCodecs exists) → corroborates HEVC hardware.
- Device class: TVs are marked (from the session `mode === 'tv'`) as **direct-play only, never
  remux/decode in JS** (plan.md §2 — TVs are too weak for WASM and have hardware HEVC anyway).

The server already knows each file's container from its extension; the true codec (H.264 vs
HEVC) is confirmed by the `ffprobe` step we add in §4 for subtitles, and stored on the catalog
row. Playback path is then chosen server-side-informed + client-probed:

```
container playable by <video>?      → DIRECT PLAY (Phase 3, unchanged)
else codec supported in hardware?   → MSE REMUX in browser (libav.js -c copy)   ← new
else                                → "needs server mode" notice (→ Phase 5 transcode)
```

## 3. Decisions needed from you (before coding)

1. **Client fallback strategy** — the reframed "decoder pick". My recommendation:
   **libav.js remux → MSE, no software decode.** See §1. The alternatives (add a WebCodecs
   canvas path; or ship a full software WASM decoder) buy little extra coverage for a lot of
   code and, for HEVC, are blocked by the same hardware limit anyway.
2. **Embedded subtitle extraction** — recommend **server-side, this phase**, using the
   `ffmpeg`/`ffprobe` already bundled in the runtime image. `ffprobe` (over the WebDAV file's
   HTTP URL, range-read, no full download) enumerates embedded subtitle tracks during a scan;
   a `/subtitles/[mediaId]/embedded/[index]` endpoint extracts the chosen track → WebVTT on
   demand. Device-independent (helps TV _and_ desktop), and container-agnostic — it keeps
   working even when the video itself is being remuxed client-side.

## 4. Embedded subtitles — sketch (pending decision 2)

- **Scan (`scanner.ts`):** for each episode/movie, `ffprobe -show_streams` the WebDAV URL to
  list `subtitle` streams (index, `language` tag, codec). Store alongside the existing external
  `.srt` list. Likely a new `embedded_subtitles` JSON column (migration `0003`) so we don't
  overload the current `subtitles` external-file column. Confirm the true video codec here too
  (feeds §2's path choice) — candidate `video_codec` column.
- **Endpoint:** `/subtitles/[mediaId]/embedded/[index]` → `ffmpeg -i <url> -map 0:s:<i> -f webvtt`
  streamed out as `text/vtt`. Text subs (SRT/ASS/mov_text) convert directly; bitmap subs
  (PGS/VobSub) can't become WebVTT — mark them unsupported in the UI.
- **Player/UI:** merge embedded tracks into the existing subtitles menu next to external `.srt`.

## 5. Build plan (decisions locked 2026-07-29: remux→MSE + server-side embedded subs)

Package: **`@libav.js/variant-default@6.9.8`** (latest — no old-version caveat). Use the
**single-threaded** wasm build so we do **not** need `SharedArrayBuffer` / COOP+COEP headers
(those would force `crossorigin` on every TMDB image). libav dist assets are copied to
`static/libav/` (build step) and `LibAV.base` points there; the wasm loads at runtime, not
bundled by Vite.

### Server

- **`webdav.ts`** — export two small helpers so ffmpeg can reach files without re-deriving auth:
  `webdavFileUrl(relPath)` (absolute percent-encoded URL) and `webdavAuthHeader()`
  (`Basic …`). Pass the header to ffmpeg/ffprobe via `-headers`, never creds in the URL.
- **`src/lib/server/ffmpeg.ts`** (new) —
  - `probeMedia(relPath)` → spawn `ffprobe -v error -print_format json -show_streams
-analyzeduration 5M -probesize 5M -headers <auth> <url>`; parse to
    `{ videoCodec: string|null, embeddedSubtitles: { index, lang, codec, text: boolean }[] }`.
    Text codecs (`subrip`/`ass`/`ssa`/`mov_text`/`webvtt`) → `text:true`; bitmap
    (`hdmv_pgs_subtitle`/`dvd_subtitle`/`dvb_subtitle`) → `text:false` (extractable-to-VTT = no).
  - `extractEmbeddedVtt(relPath, index)` → spawn `ffmpeg -v error -headers <auth> -i <url>
-map 0:s:<index> -f webvtt -` and return the child's stdout as a web `ReadableStream`
    (passthrough, no buffering); kill the child if the response is cancelled.
- **Migration `0003_embedded_subs.sql`** — `ALTER TABLE catalog ADD COLUMN video_codec TEXT;`
  and `ADD COLUMN embedded_subtitles TEXT;` (JSON, null when none).
- **`scanner.ts`** — after discovery, `probeMedia` each movie/episode and store `video_codec`
  - `embedded_subtitles`. Freshness guard: skip probing a row whose `video_codec` is already
    set **and** whose `mtime` is unchanged (avoid re-probing every rescan). Runs after the
    catalog upsert so rows exist; sequential, best-effort (a probe failure leaves the columns
    null, never fails the scan).
- **`catalog.ts`** — new `EmbeddedSubtitleRef { index, lang, text }`; `PlayableMedia` and the
  episode/movie player payloads gain `videoCodec: string|null`, `container` (ext), and
  `embeddedSubtitles`. `getPlayable` reads the two new columns.
- **Endpoint `src/routes/subtitles/[mediaId]/embedded/[index]/+server.ts`** — validate the
  index exists and is `text`; `extractEmbeddedVtt` → `text/vtt; charset=utf-8`. 404 otherwise.

### Client

- **`src/lib/capabilities.ts`** (new, browser-only) — `detectCapabilities()` probes
  `video.canPlayType(...)`, `MediaSource.isTypeSupported('video/mp4; codecs="avc1.42E01E,
mp4a.40.2")` (H.264 remux target) and HEVC mime variants; cache in `sessionStorage`.
  `choosePlaybackPath({ container, videoCodec, mode })` → `'direct' | 'remux' | 'unsupported'`:
  TV mode ⇒ always `direct`; native-playable container+codec ⇒ `direct`; H.264 in a
  non-native container with MSE avc1 support ⇒ `remux`; else ⇒ `unsupported`.
- **`src/lib/remux.ts`** (new) — libav.js MSE remuxer. Feed `/stream/[mediaId]` bytes into a
  libav **reader device**, `ff_init_demuxer_file`, set up an fMP4 **writer device** muxer
  (`movflags=frag_keyframe+empty_moov+default_base_moof`, stream-copy — no encoder), loop
  `av_read_frame → av_interleaved_write_frame`, append emitted fMP4 to a `SourceBuffer` with
  `updateend` backpressure. Derive the SourceBuffer codec string from the video `codecpar`
  (fallback `avc1.640029,mp4a.40.2`). **MVP = progressive append**: seek within the buffered
  range is free; forward-seek-past-buffer is a documented polish follow-up (§6).
- **`Player.svelte`** — new props `videoCodec`, `container`. On mount (client only) compute the
  path. `direct` ⇒ unchanged Phase-3 behavior (`src={streamUrl}`). `remux` ⇒ don't set `src`;
  hand `videoEl` to the remuxer. `unsupported` ⇒ overlay: "This file needs server mode
  (coming in Phase 5) on this device." Subtitles/progress/resume logic is path-agnostic and
  stays as-is. Merge `embeddedSubtitles` into the existing `<track>` list + language menu
  (unique keys/labels so an embedded + external of the same lang don't collide).
- **Player hosts** (`/watch`, `/movies/[id]`, `/shows/[id]`) — thread `videoCodec`/`container`/
  `embeddedSubtitles` through their `load` payloads into `<Player>`.

### Delegation & verification

Implementation delegated to a **Sonnet subagent** (working agreement). Claude reviews the
server code + libav glue, then verifies what's machine-checkable: `lint`/`check`/`build`;
`ffprobe` finds the true codec + embedded tracks on a real file; the embedded-subtitle endpoint
returns valid `WEBVTT`; `choosePlaybackPath` classifies the S01 (HEVC/.mp4) and S02 (x264/.mkv)
samples correctly. **Real MSE-remux playback is browser-dependent** (like Phase 3's codec
caveat) — verified by an eyeball in Chrome, flagged not machine-verifiable here.

## 6. Risks / notes

- **libav.js size & COOP/COEP:** libav.js WASM is a real download (a remux-only build is far
  smaller than a full-decode build — we pick the smallest that demuxes MKV/AVI). Multithreaded
  builds need `SharedArrayBuffer` → `Cross-Origin-Opener-Policy`/`-Embedder-Policy` headers
  (set in hooks + the nginx block). A single-threaded remux build avoids that header
  requirement — evaluate which is needed. Flag to user before install (per CLAUDE.md).
- **Seeking through MSE remux:** progressive append makes seeks within the buffered range free;
  seeking ahead of the buffer needs a demuxer re-seek to a keyframe. MVP = progressive append
  (precise arbitrary seek is a polish follow-up); note it.
- **HEVC-no-hardware desktop stays unsolved in Phase 4 by design** — routed to Phase 5.
- **ffprobe/ffmpeg over WebDAV:** pass the authenticated URL; both range-read, so no full
  download. Cap `ffprobe -analyzeduration`/`-probesize` so it doesn't read too much.

---

## 7. Completion (2026-07-29) ✅

Built by a Sonnet subagent (working agreement), reviewed by Claude (all changed files read in
full), and verified. `npm run lint`, `npm run check`, `npm run build` all clean.

**Delivered:** server — `webdav.ts` helpers (`webdavFileUrl`/`webdavAuthHeader`), new
`ffmpeg.ts` (`probeMedia`/`extractEmbeddedVtt`, stream-safe, child killed on cancel), migration
`0003_embedded_subs.sql` (`video_codec`, `embedded_subtitles`), `scanner.ts` probe pass with a
pre-upsert mtime/codec freshness snapshot, `catalog.ts` types + `getPlayable`, and
`/subtitles/[mediaId]/embedded/[index]` (404s on missing/bitmap). Client — `capabilities.ts`
(`detectCapabilities`/`choosePlaybackPath`), `remux.ts` (libav.js MSE remuxer, progressive
append), `Player.svelte` (mount-time path selection: direct / remux / unsupported; unified
subtitle menu with `ext:`/`emb:` keys), and all three player hosts threading
`videoCodec`/`container`/`embeddedSubtitles`.

**Package:** `@libav.js/variant-default@6.9.8` (latest). Single-threaded build only — a
`postinstall` (`scripts/copy-libav.mjs`) copies just the non-`.thr.` assets into
`static/libav/` (`libav-default.js`, `libav-6.9.8.1-default.wasm.js`,
`libav-6.9.8.1-default.wasm.wasm`); confirmed present in `build/client/libav/` too. No
COOP/COEP headers added (no `SharedArrayBuffer` needed).

**Live-verified against the real Nextcloud (Claude, machine-checkable parts):**

- `probeMedia` (real ffprobe, `-headers` auth, 5M cap): S02 `.mkv` → `videoCodec: h264` +
  **42 embedded `subrip` (text) tracks** detected; S01 `.mp4` → `videoCodec: hevc`, no embedded
  subs. So `choosePlaybackPath` gets **remux** for the `.mkv` (the core Phase-4 win) and
  direct/unsupported-by-hardware for the HEVC `.mp4`, as designed.
- `extractEmbeddedVtt` (real `ffmpeg -f webvtt` on the `.mkv`, embedded track 0/eng): valid
  `WEBVTT` output with dot-timestamps and real cues. (The trailing `Broken pipe` in the test is
  just the timeboxed `kill` closing the pipe early — the same benign signal the endpoint's
  `cancel()` handler produces on client disconnect.)

**Deviations (documented in-code):** remux loop uses libav.js `ff_read_frame_multi`/
`ff_write_multi` wrappers rather than hand-rolled `av_*`; `EmbeddedSubtitleRef.index` is
subtitle-relative (matches `-map 0:s:N`); `subtitle_prefs` schema unchanged, so an embedded vs.
external track of the same language isn't distinguished across reloads (falls back
external-first by language).

**Not machine-verifiable here (browser-dependent, by design — same class as Phase 3's codec
caveat):** the actual libav.js demux→mux→`SourceBuffer` **remux playback in Chrome** against
the live `.mkv`/x264 sample. Bytes, probe, and subtitle extraction are all confirmed; the
in-browser MSE pipeline needs a real eyeball. Recommended next: `npm run dev`, log in, pick
**Desktop**, open Bad Sisters → a **Season 2** (`.mkv`) episode, and confirm it plays + the
embedded subtitle languages appear in the CC menu.
