# Phase 4b — Server-side HLS remux (replaces client-side WASM remux)

**Why (2026-07-29).** The Phase-4 client-side libav.js MSE remux was browser-divergent, slow,
and broken in Safari (real bugs found: Safari returns `"maybe"` for `video/x-matroska` →
mis-detected as direct-play; libav `limit:1` packet loop → slow start; no subtitles because the
library was never rescanned so `video_codec`/`embedded_subtitles` were null). User chose to
replace it with **server-side stream-copy remux → HLS**: one consistent player everywhere,
native HLS in Safari, `hls.js` in Chrome/Firefox, original quality, `ffmpeg -c copy` (no
re-encode) so it's cheap on the weak VPS.

This supersedes phase-4.md's client `remux.ts` path. Capability probing + server-side embedded
subtitle extraction from Phase 4 **stay**; only the container-gap playback path changes.

## Validated facts (live, against the real Nextcloud — do not re-litigate)

- `ffmpeg -c copy -f hls` over the WebDAV URL (auth via `-headers`) produces a playlist with
  keyframe-aligned mpegts segments (h264+aac), at **~26× realtime** — a 52-min episode fully
  remuxes in ~2 min. Source ≈ **443 MB**.
- **Use `-hls_playlist_type event`, NOT `vod`.** VOD writes `index.m3u8` only once, at the very
  end of the whole remux (~2 min) — verified live, so a playlist request 404s on the timeout.
  EVENT writes the playlist incrementally as each segment lands (playlist present at ~0.8 s),
  and ffmpeg appends `#EXT-X-ENDLIST` on completion, yielding a complete, fully-seekable VOD.
- Exact working command (use verbatim, adjusting paths/streams):
  ```
  ffmpeg -y -headers "Authorization: Basic <b64>\r\n" -i <webdav-url> \
    -map 0:v:0 -map 0:a:0? -c copy \
    -f hls -hls_time 6 -hls_playlist_type vod -hls_segment_type mpegts \
    -hls_flags independent_segments -hls_list_size 0 \
    -hls_segment_filename <dir>/seg%05d.ts <dir>/index.m3u8
  ```
  `-hls_list_size 0` keeps the full VOD playlist (all segments listed) so the player gets total
  duration + full seek. ffmpeg splits on keyframes automatically. `?` on the audio map so files
  without a matching audio stream still remux.

## Architecture — session-based full remux, LRU-bounded

Because a whole episode remuxes in ~2 min at 26×, we let **one ffmpeg per media** produce the
entire VOD to a per-media cache dir; the player streams segments as they land and can seek
across everything ffmpeg has produced (nearly the whole file within a couple minutes).

### `src/lib/server/hls.ts` (new) — session manager

- Session dirs live under `config.dataDir/hls/<mediaId>/`.
- `ensureSession(mediaId, relPath)`:
  - If a live session for `mediaId` exists, touch its `lastAccess` and return it.
  - Else enforce the job cap (`config.maxTranscodeJobs`, default 1): if at cap, evict the
    **least-recently-accessed idle** session (no access in the last ~30 s) — kill its ffmpeg and
    delete its dir; if none idle, throw a `busy` error (route → 503 with a clear message,
    mirroring plan.md §7's "server busy" behavior).
  - Create the dir, spawn ffmpeg (command above, auth from `webdavAuthHeader()`, url from
    `webdavFileUrl(relPath)`). Track `{ mediaId, dir, child, lastAccess, done }`. Mark `done`
    on ffmpeg exit. Never throw from ffmpeg errors into the request path — log + record.
- `waitForFile(session, name, timeoutMs)`: resolve once `<dir>/<name>` exists (poll ~100 ms);
  reject on timeout or if the session's ffmpeg exited without producing it. Used so an early
  playlist/segment request waits for ffmpeg to create it rather than 404ing.
- `sweepCache()`: if total `dataDir/hls` size > `config.hlsCacheMaxMb`, delete
  least-recently-accessed **non-active** session dirs until under budget. Call opportunistically
  on `ensureSession`. Also delete all `hls/*` on server start (stale dirs from a prior run) —
  wire into the same startup path as migrations (`db/index.ts` init) or a lazy once-guard.
- `stopAll()` best-effort on process exit (`SIGTERM`/`SIGINT`) — kill children.

### Routes — `src/routes/hls/[mediaId]/[file]/+server.ts`

Single dynamic `[file]` param (values: `index.m3u8` or `seg#####.ts`). Reject anything else /
path-traversal (`..`, `/`) with 400. Auth is already enforced by `hooks.server.ts` (`/hls` is
**not** in `PUBLIC_PATHS` — confirm during verification, same as `/stream`).

- `GET`: `getPlayable(mediaId)` → 404 if missing. `ensureSession(mediaId, media.path)`.
  - `index.m3u8`: `waitForFile(session, 'index.m3u8', ~15 s)`, read + return with
    `Content-Type: application/vnd.apple.mpegurl`, `Cache-Control: no-store`.
  - `seg#####.ts`: `waitForFile(session, file, ~30 s)` (covers a seek just ahead of production),
    stream the file with `Content-Type: video/mp2t`. If it never appears (seek far past the
    end / ffmpeg died) → 404 so hls.js can retry/stall gracefully.
  - Touch `lastAccess` on every hit (keeps the active session from being evicted).

### Config

Reuse existing `config.hlsCacheMaxMb` (default 512 — **bump the default to ~2048** since one
remuxed episode ≈ 450 MB and we now keep whole episodes; note in `.env.example` if present),
`config.maxTranscodeJobs`, `config.dataDir`. No new env keys required.

## Client changes

### `src/lib/capabilities.ts`

- **Fix the Safari bug:** a container is natively playable only when it's **mp4** — `.mkv`/`.avi`
  are never direct-play regardless of what `canPlayType` claims. Rewrite `choosePlaybackPath`:
  - `mode === 'tv'` → `'direct'` (unchanged; TVs keep today's behavior — a follow-up may route
    TV `.mkv` to HLS too, but don't change/risk it now).
  - `container === 'mp4'` && codec supported natively (`h264`→`nativeH264`, `hevc`→`nativeHevc`)
    → `'direct'`.
  - codec is h264/avc1/null → `'hls'` (the container-gap fix — covers `.mkv`/`.avi` H.264).
  - else (e.g. HEVC without hardware) → `'unsupported'`.
- Rename the `PlaybackPath` member `'remux'` → `'hls'`. Keep the sessionStorage cap probe; the
  MSE-remux-specific `mseH264`/`mseHevc` fields can stay (harmless) or be trimmed.

### `src/lib/components/Player.svelte`

- Replace the `attachRemux` import/usage with HLS attachment:
  - path `'hls'` + `videoEl`: hls URL = `resolve('/hls/[mediaId]/[file]', { mediaId, file: 'index.m3u8' })`.
    - If `videoEl.canPlayType('application/vnd.apple.mpegurl')` is non-empty (Safari) → set
      `videoEl.src = hlsUrl` (native HLS).
    - Else → `const { default: Hls } = await import('hls.js')`; if `Hls.isSupported()`, create
      an `Hls()`, `hls.loadSource(hlsUrl)`, `hls.attachMedia(videoEl)`; keep the instance and
      `hls.destroy()` in the effect cleanup / `onDestroy`.
  - path `'direct'` → unchanged (`src={directSrc}`). path `'unsupported'` → existing overlay.
- Everything else (subtitles menu, TextTrack toggling, resume-seek on `loadedmetadata`,
  progress reporting) is unchanged — it operates on the `<video>` element and works with HLS.
  `<track>` subtitle elements work over HLS too.

### Dependencies

- **Add** `hls.js@1.6.16` (latest). Dynamic-import it (client only) so it's not in the SSR
  bundle.
- **Remove** the client libav path entirely: delete `src/lib/remux.ts`, `scripts/copy-libav.mjs`,
  `static/libav/`, the `@libav.js/variant-default` dependency, and the postinstall/copy step +
  any `build/client/libav` wiring. Confirm `lint`/`check`/`build` stay clean after removal.

## Data / rescan (REQUIRED — this is why subtitles were missing)

The DB still has `video_codec = NULL` and `embedded_subtitles = NULL` for every row (no scan
since Phase 4). After the code lands, **a library rescan must run** to populate them (verified:
ffprobe finds 42 embedded subrip tracks in the S02 file). The path decision also reads
`videoCodec`; with it null the code still routes `.mkv` → `'hls'` (null treated as h264), so
playback works pre-rescan, but **subtitles need the rescan**. No schema change here — migration
`0003` columns already exist.

## Verification

- `npm run lint`, `npm run check`, `npm run build` clean (after libav removal + hls.js add).
- **Live (Claude, machine-checkable):** hit `/hls/<s02EpisodeId>/index.m3u8` with a dev session
  → 200 `application/vnd.apple.mpegurl`, valid `#EXTM3U … #EXT-X-PLAYLIST-TYPE:VOD`; fetch
  `seg00000.ts` → 200 `video/mp2t`, ffprobe-valid h264+aac; no-cookie → redirect to login;
  a second concurrent different-media request respects the job cap / busy path; cache dir stays
  under budget after playback. Trigger a rescan and confirm the S02 row gets `video_codec=h264`
  - embedded tracks.
- **Browser eyeball (user):** Chrome, Firefox/Zen, **and Safari** all play a Season-2 episode
  via the same HLS player, seek works, and the embedded subtitle languages appear in the CC
  menu.

## Known tradeoffs (documented, acceptable for 1–2 viewers)

- **One whole episode (~450 MB) is cached during playback**, evicted by LRU across media. This
  is a deliberate relaxation of plan.md §10 ("don't cache whole videos") in exchange for full
  VOD seeking; bounded by `hlsCacheMaxMb`.
- **Far-forward seek before ffmpeg has produced that segment waits** for catch-up — but at 26×
  realtime the whole file is usually available within ~2 min, so this is rarely hit. A
  restart-ffmpeg-at-offset optimization is a possible follow-up, not built now.
- **TV mode unchanged** (still direct). Routing TV `.mkv` → HLS is a later consideration.
- **Delegation:** implementation to a Sonnet subagent with this doc as the spec; Claude reviews
  - runs the live HLS/rescan verification.

## Code landed (2026-07-29)

Built by a Sonnet subagent per this spec, reviewed by Claude (all changed files read in full).

**Delivered:** `src/lib/server/hls.ts` (new — `ensureSession`/`waitForFile`/`sweepCache`/
`stopAll`/`HlsBusyError`, in-memory session map, lazy startup wipe + SIGTERM/SIGINT hooks, LRU
idle eviction under `config.maxTranscodeJobs`); `src/routes/hls/[mediaId]/[file]/+server.ts`
(new — serves `index.m3u8`/`seg#####.ts`, 400 on anything else, 503 on `HlsBusyError`, 404 on a
segment/playlist that never appears); `src/lib/capabilities.ts` (rewritten — `PlaybackPath`
`'remux'` → `'hls'`, container check narrowed to `mp4`-only for `'direct'`, the Safari `.mkv`
bug fix); `src/lib/components/Player.svelte` (rewritten HLS-attach: native `<video src>` when
`canPlayType('application/vnd.apple.mpegurl')`, else dynamic `import('hls.js')`, `Hls.destroy()`
on cleanup); `config.hlsCacheMaxMb` default bumped 512 → 2048. Removed entirely: `src/lib/remux.ts`,
`scripts/copy-libav.mjs`, the `postinstall` script, `@libav.js/variant-default` dependency, and
the `/static/libav` `.gitignore` entry (the directory itself was never present on disk in this
checkout). Added `hls.js@1.6.16` as a regular dependency (dynamic-imported client-side only).

**Verified (Claude, machine-checkable):** `npm run lint`, `npm run check` (370 files, 0
errors/warnings), and `npm run build` all clean. Repo-wide grep for
`libav|remux\.ts|attachRemux|RemuxHandle|copy-libav` outside `node_modules` turns up only
historical-context comments in `capabilities.ts`/`hls.ts` explaining what this phase replaced —
no dangling code references. `/hls/...` confirmed not in `hooks.server.ts`'s `PUBLIC_PATHS`, so
auth is inherited automatically, unchanged.

**Not yet done — needs a live pass:** the actual `/hls/<mediaId>/index.m3u8` → segment →
ffprobe-valid-h264+aac round trip against the real WebDAV/Nextcloud source, the job-cap/busy-503
path under concurrent requests, cache-eviction-under-budget behavior, and the library rescan to
populate `video_codec`/`embedded_subtitles` (still NULL for every row). Also unverified: real
playback in Chrome/Firefox/Safari (browser eyeball, per this doc's Verification section). These
are the logical next step before calling Phase 4b done end-to-end.
