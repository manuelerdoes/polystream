# Phase 5 — Media pipeline: pre-processed direct-play + custom player

**Supersedes the Phase 4/4b playback fallbacks.** The client-side WASM remux (Phase 4) and the
server-side on-the-fly HLS remux (Phase 4b) are both **abandoned** — they were browser-divergent,
slow against a remote WebDAV source, and gave a "live broadcast / no seek" experience. This is
the agreed replacement, arrived at with the user over several rounds (2026-07-30).

## Core principle

**Everything the browser plays is a pre-processed, direct-play `.mp4`.** No HLS, no on-the-fly
remux, no JIT segments. A faststart `.mp4` served through the existing range-proxy (`/stream`)
already gives instant start, snappy byte-range seeking, and partial download (only the watched
bytes are fetched — verified in Phase 3). The app's job is to make sure every file _is_ such an
`.mp4`, and to render a **custom player UI** so the experience looks identical on every
browser/OS.

Why this works and the remux approaches didn't: the media is on a **remote Nextcloud**
(~0.4 s latency, ~4.7 MB/s). Instant seeking requires the file to already carry a byte index
(`.mp4` `moov`), which the browser + Nextcloud range-seek against. On-the-fly remux can't offer
that without either reading the whole file first or paying ~3 s per seek. So we pre-process.

## Decisions locked with the user

1. **Custom player UI, not native.** `<video>` with `controls` hidden; we draw play/pause, seek
   bar (with buffered ranges), time, volume, fullscreen, and the CC menu ourselves. Identical
   on every browser + OS. This is a primary requirement, independent of the streaming path.
2. **H.264 is universal; HEVC is device-dependent.** H.264/AAC `.mp4` plays everywhere. HEVC
   only decodes where there's hardware support (Macs, iPhones, modern TVs; often NOT generic
   Windows/Linux Chrome/Firefox). So HEVC is kept as a best-quality primary with an H.264
   fallback for weak devices.
3. **Per-device codec detection** via `navigator.mediaCapabilities.decodingInfo()` — reports
   `supported` / `smooth` / `powerEfficient` (hardware). Pick HEVC when capable, else the H.264
   fallback. Plus a manual "use compatibility version" toggle in the player as a safety valve.
4. **The app converts files server-side after a scan**, showing live status in the UI. It only
   does work that's actually needed (see the matrix). It **only generates an H.264 fallback when
   the primary is HEVC AND no H.264 version was already uploaded.** A file that's already H.264
   is left alone.
5. **After a successful, verified conversion, the original incompatible file is DELETED** from
   Nextcloud (user's explicit choice — not archived).

## Per-title processing matrix (background job, keyed off ffprobe: container + video + audio codec)

| Uploaded file                          | Problem                   | Action                                                                                                                                                                                                                 | Cost                                             |
| -------------------------------------- | ------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------ |
| **H.264 + AAC in `.mp4`**              | none                      | nothing                                                                                                                                                                                                                | —                                                |
| **H.264 in `.mkv`/`.avi`** (any audio) | container (± audio)       | remux → `.mp4`: `-c:v copy -c:a aac -movflags +faststart`; verify; upload; **delete original**; recatalog                                                                                                              | seconds (video is copied, lossless)              |
| **H.264 in `.mp4` but non-AAC audio**  | audio only                | remux audio → AAC, `-c:v copy`, replace                                                                                                                                                                                | seconds                                          |
| **HEVC in `.mp4`**                     | codec (weak devices only) | **keep original** (HEVC primary). If an uploaded H.264 fallback exists → use it. Else **generate** `H.264` fallback: `-c:v libx264 -crf 20 -preset medium -c:a aac -movflags +faststart`; upload alongside. Keep both. | re-encode: slow on the VPS, background, one-time |
| **HEVC in `.mkv`** (edge)              | container + codec         | remux → HEVC `.mp4` (capable devices) **and** generate H.264 `.mp4` fallback; delete `.mkv`                                                                                                                            | re-encode                                        |
| **Only an H.264 file present**         | —                         | it IS the universal version; **no fallback generated**                                                                                                                                                                 | —                                                |

- **Video is never re-encoded when it doesn't have to be** — H.264 is always stream-copied; only
  a HEVC→H.264 _fallback_ re-encodes (and never touches the HEVC primary).

## Fallback file naming convention (PROPOSAL — confirm)

A compatibility fallback lives beside its primary as **`<basename>.h264.mp4`**
(e.g. `Bad.Sisters.S01E01.mp4` → `Bad.Sisters.S01E01.h264.mp4`). The scanner:

- recognizes a `*.h264.mp4` file as the **H.264 variant of the matching primary**, not a
  separate episode/movie;
- treats "the user already uploaded an H.264 version" as "a `*.h264.mp4` sibling exists" (so the
  app won't regenerate it);
- app-generated fallbacks are written with this same name.

## Stable media identity (needed because paths change)

`media_id` is currently `sha1(path)`, so a remux (`.mkv`→`.mp4`) would change the id and orphan
progress. Fix: **derive identity from the path with the extension and any `.h264` tag stripped**
(`sha1(path_without_extension_or_variant_tag)`), so the primary + its fallback + a re-containered
version all share one stable `media_id`. One-time re-scan regenerates ids (progress from before
this change may reset once — acceptable).

## Data model (SQLite) additions

- `catalog`: add `audio_codec TEXT`. Keep `video_codec`, `embedded_subtitles` (Phase 4).
- Per media, track the **variants**: the primary (path + video codec) and an optional H.264
  fallback (path). Either a small `variants` table (`media_id, kind ['primary'|'h264'], path,
video_codec, audio_codec`) or fallback columns on `catalog`. Prefer a `variants` table — it
  generalizes and keeps `catalog` clean.
- `conversion_jobs`: `media_id, state ['queued'|'running'|'done'|'error'], kind ['remux'|'h264'],
progress REAL, error TEXT, updated_at` — drives the UI status + survives restarts (re-queue
  `running` on boot).

## Conversion worker (`src/lib/server/convert.ts`)

- **Single job at a time** (weak VPS; `config.maxTranscodeJobs`, default 1). In-process queue,
  fed after each scan and on demand.
- Steps per job: stream source from Nextcloud → `ffmpeg` to a **temp local file** (faststart
  needs a seekable output, so temp-then-upload, not a pipe) → **verify** (ffprobe: expected
  codec, duration within tolerance, non-zero) → **upload** to Nextcloud (`webdav` PUT) →
  delete original / write fallback as per matrix → update `catalog`/`variants` → clean temp.
- **Never delete the original until the new file is uploaded AND verified.** Any failure leaves
  the source untouched and records `error` for the UI.
- **Progress %:** parse ffmpeg `-progress` output (out_time vs total duration) → `conversion_jobs.progress`.
- Temp disk: one file at a time (~source size), always cleaned. Fits the few-GB budget.
- ffmpeg auth to Nextcloud via `-headers` (reuse `webdavAuthHeader`/`webdavFileUrl`).

## Playback (client) — variant selection + custom player

- **Variant pick:** on the play page, `mediaCapabilities.decodingInfo()` probes the primary's
  codec at the title's real resolution. `supported && smooth` (prefer `powerEfficient`) → play
  the **primary** (HEVC). Else → the **H.264 fallback**. Cache the HEVC verdict per device
  (sessionStorage). Manual "compatibility version" toggle forces the fallback.
- Both variants are just `/stream/[variantMediaId-or-path]` direct-play — instant + seek +
  partial-load. The server exposes the chosen variant's bytes.
- **Custom player (`Player.svelte` rewrite):** `<video>` (no `controls`) + our control bar:
  play/pause, seek bar showing `buffered`, current/total time, volume/mute, fullscreen, CC menu
  (reuse Phase 3/4 subtitle logic), keyboard + click + D-pad. Resume-seek + throttled progress
  reporting stay as-is. Styled to look identical everywhere.

## UI status

- Library cards / detail pages show conversion state: **"Converting… X%"**, **"Queued"**,
  **"Conversion failed"**, or nothing when ready. A not-yet-converted incompatible file is
  clearly marked and not (mis)played. Reuse/extend `ScanBar` for a global indicator.

## To delete (the abandoned approaches)

- `src/lib/server/hls.ts`, `src/routes/hls/[mediaId]/[file]/` route, the `hls.js` dependency,
  and the `'hls'` playback path in `capabilities.ts`/`Player.svelte`. (libav client remux and its
  assets were already removed.) Playback reverts to direct-play + the new variant/custom-player
  logic.

## Open items — CONFIRMED with user (2026-07-30)

1. Fallback naming convention **`*.h264.mp4`** — confirmed.
2. Variants stored as a **table** — confirmed.
3. **`media_id` derived from path without extension/variant tag**; one-time progress reset on
   first re-scan accepted — confirmed.
4. **HEVC-in-`.mkv` handled** (remux → HEVC `.mp4` + generate H.264 `.mp4` fallback, delete the
   `.mkv`) — confirmed in scope.

## Amendment (2026-07-30): browser-playability detection, not just codec

A file passing "video is H.264" is **not** enough — a **10-bit H.264** (`High 10` /
`yuv420p10le`) plays in **no** browser, and AAC with an **undefined channel layout** can stall
playback. So compatibility is judged on pixel format + audio layout too, and the pipeline gains
a third eager kind:

- **`reencode` (new, EAGER):** an H.264 primary whose `pix_fmt` isn't 8-bit `yuv420p` is
  unplayable everywhere → re-encode video to 8-bit (`libx264 -pix_fmt yuv420p`), audio→AAC,
  output `.mp4`, **replace the primary + delete the original** (same replace/delete semantics as
  `remux`; only the codec op differs — re-encode instead of copy). Lossy, but the original was
  unplayable. (HEVC 10-bit is left alone — it hardware-decodes fine on capable devices.)
- **Audio layout:** `remux` is also triggered when audio is AAC but its channel layout is
  `unknown`/undefined — the `-c:a aac` re-encode assigns a valid layout (e.g. 6ch → 5.1),
  **keeping the channels** (no forced stereo downmix). Non-AAC audio already triggered `remux`.
- **`classifyConversion` order:** h264 + non-`yuv420p` → `reencode`; else h264/hevc with bad
  container OR bad audio → `remux`; else `null` (hevc fallback stays lazy/button).
- **Schema:** migration `0006` adds `catalog.pix_fmt` + `catalog.audio_channel_layout`;
  `probeMedia` returns `pixFmt`, `audioChannels`, `audioChannelLayout`. The `h264` fallback
  recipe already forces `-pix_fmt yuv420p` (fixed 2026-07-30 — a 10-bit HEVC source would
  otherwise yield a 10-bit, unplayable fallback).

## Verification plan

- Unit-level: matrix classification from ffprobe output; naming-convention parsing.
- Live (Claude): remux an H.264 `.mkv` → verify the uploaded `.mp4` plays + seeks via `/stream`
  (range 206); generate an H.264 fallback from a HEVC `.mp4` → verify it's valid H.264/AAC;
  confirm originals are only deleted after verified upload; conversion never blocks the UI.
- Browser eyeball (user): custom player looks identical in Chrome/Firefox/Safari; HEVC plays on
  the Mac, the fallback is chosen on a non-HEVC device (or via the manual toggle).
- **Delegation:** implementation to a Sonnet subagent per the working agreement; Claude reviews
  the WebDAV-write/delete + conversion code especially carefully (it mutates the user's library)
  and runs the live verification.

## Subtitle preservation (added 2026-07-30, user chose "keep inside the MP4")

A `remux` maps the source's **text** subtitle tracks into the `.mp4` as `mov_text`
(`-map 0:s:<i>` per text-track index from the source probe, `-c:s mov_text`), so converting a
`.mkv` (whose original is then deleted) never loses subtitles. Bitmap subs (PGS/VobSub) can't
live in `.mp4` and are excluded. After conversion, `convert.ts` re-syncs `catalog.embedded_subtitles`
from the converted file's probe (mov_text tracks re-index 0..N-1), so the CC menu + the
`/subtitles/[mediaId]/embedded/[index]` endpoint stay correct. The `h264` fallback carries no
subs — they're served from the primary regardless of which variant plays.

## Stage 1 status — COMPLETE ✅ (2026-07-30)

Server-side pipeline built (Sonnet subagent) + reviewed + fixed (subtitle preservation) by
Claude. `check`/`lint`/`build` clean. Live-verified against the real Nextcloud **on throwaway
files only** (no real episode touched, no real scan run):

- remux flags → valid **faststart** H.264/AAC `.mp4`, duration drift 0.008s (< 1s gate);
- text subs (subrip) → carried into `.mp4` as `mov_text`, still extract to valid WEBVTT;
- WebDAV **upload** (streamed) works; converted `.mp4` **range-serves → 206** (instant seek);
- WebDAV **delete** works; deleting an already-gone file throws 404 (caught by convert.ts);
- code review confirms **verify → upload → delete** ordering; original untouched on any failure.

**Not yet done:** the real conversion has never been run on the live library.

```

## Amendment (2026-07-30): lazy HEVC fallback, advanced-profile button only

The HEVC→H.264 fallback re-encode is **slow** and, for a library watched mostly on HEVC-capable
devices, mostly wasted. So it is **NOT generated eagerly on scan** anymore. Changes to the matrix:

- **Remux stays eager on scan** (cheap, lossless container/audio fix): H.264-in-`.mkv`/`.avi`,
  non-AAC-audio `.mp4`, and HEVC-in-`.mkv` (→ HEVC `.mp4`, container fix only).
- **H.264 fallback is lazy + manual.** `classifyConversion` must **never** return `'h264'`, and
  convert.ts must **not** chain an `h264` job after a HEVC remux. A fallback is only enqueued by
  an explicit button.
- **Advanced-profile button (user's choice — "technical-profile button only").** Add an
  `advanced` boolean to `profiles` (migration `0005`), togglable in the profile manager
  (`/profiles`). Only advanced profiles see a **"Generate H.264 version"** button on HEVC titles
  that lack an `h264` variant. Button → `POST` an endpoint that enqueues an `h264` job (guarded:
  caller's profile must be `advanced`; media must be HEVC + have no existing `h264` variant) →
  the existing conversion-status UI shows its progress; the button hides once the variant exists.
- Non-advanced users on a non-HEVC device opening an HEVC title still get the existing
  `'unavailable'` message (no button) — accepted by the user.

**Stages 1–3 status — built, reviewed, machine-verified (2026-07-30):** server pipeline (safe
upload→verify→delete, subtitle preservation), custom player + variant selection +
conversion-status UI, and lazy advanced-profile fallback (`classifyConversion` never returns
`'h264'`; `requestH264Fallback` is the only enqueue path; `POST /api/fallback` guarded
advanced-only + HEVC-only + no-existing-variant + no-in-flight). `lint`/`check`/`build` clean.
**Still needs the user:** a real scan (remuxes the 2 S2 `.mkv`→`.mp4`, deletes the `.mkv`s; S1
HEVC left as-is) and a browser eyeball of the custom player in Chrome/Firefox/Safari.
```
