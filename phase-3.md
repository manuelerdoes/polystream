# Phase 3 — Direct-play playback

Build plan for Phase 3 (see `plan.md` §11). Scope: a range-proxy streaming endpoint,
a video player, external `.srt` → WebVTT subtitles, per-profile progress + resume, and
remembered subtitle preferences. Plus a new **device-mode** step (desktop vs TV) that
decides _how_ the player is presented.

Out of scope (later phases): device capability probing, client-side WASM decode, embedded
subtitle extraction (Phase 4); server-side transcode to HLS (Phase 5). Phase 3 is
**direct-play only** — we proxy the original file bytes and let the browser's native
`<video>` decode them.

---

## 0. Decisions locked with the user (2026-07-29)

- **Device mode (new).** After the "who's watching?" profile pick, the user chooses
  **Desktop** or **TV**. The choice drives player presentation:
  - **Desktop → inline player** embedded in the detail page (video plays in-page).
  - **TV → fullscreen player** on a dedicated `/watch/[id]` route, immersive, big controls.
    The mode is stored in the signed session cookie (per-device, alongside `profileId`) and is
    switchable later from the app header.
- **Player controls.** Native `<video controls>` for transport (play/seek/volume/fullscreen)
  plus a **small custom subtitles button** (on/off + language). No hand-built transport UI
  this phase — that's the Phase 6 polish pass.
- **Subtitles.** **In-house `.srt` → WebVTT converter, no new dependency** (~40 lines:
  `WEBVTT` header + comma→dot timestamp fix + cue passthrough). Converted on the fly by a
  subtitle endpoint; cheap enough to skip a persistent cache (one small file per track).
- **Direct-play only + codec caveat.** We serve original bytes; the browser decodes. The
  current sample library is HEVC/x265 in `.mp4` (S01) and x264 in `.mkv` (S02). Desktop
  Chrome cannot play the `.mkv` container, and only plays HEVC with a hardware decoder (the
  dev Mac likely can; a generic desktop cannot). Smart TVs direct-play the HEVC fine. So the
  **endpoint, seeking, subtitles, and resume are fully testable now**, but end-to-end desktop
  playback may only succeed for the HEVC `.mp4` on capable hardware. The `.mkv`/x264-anywhere
  gap is exactly what Phase 4 (WASM) and Phase 5 (transcode) close. Not a regression.

---

## 1. Dependencies

**None added.** Native `fetch` (adapter-node/undici) proxies WebDAV range requests and
streams the body straight through. The `.srt`→VTT converter is in-house. `hls.js` / WASM
decoder are Phase 4–5.

## 2. Data model

**No migration needed.** `progress(profile_id, media_id, position_seconds,
duration_seconds, updated_at)` and `subtitle_prefs(profile_id, enabled, language)` already
exist from `0001_init.sql`. Phase 3 finally populates them.

The session payload gains a `mode` field (see §3), which is cookie state — not DB.

## 3. Device-mode flow

### `auth.ts`

- Extend `SessionPayload` → `{ v: 1, auth: true, profileId?: string, mode?: 'desktop' | 'tv' }`.
- Extend `SessionData` → add `mode: 'desktop' | 'tv' | null`; `readSession` reads it.
- No signature/format change — just an extra optional field in the signed JSON.

### `hooks.server.ts`

- Add `/mode` to the set of paths reachable with a profile but before a mode is chosen.
- New guard rung: authenticated **and** `profileId` set **but** no `mode` → redirect to
  `/mode` (except `/mode`, `/profiles`, `/logout`). Mirrors the existing profile guard.

### Route `/mode`

- `+page.svelte`: two large focusable cards — **Desktop** and **TV** (reuse `spatialNav`,
  the same visual language as the profile picker). Big, D-pad friendly (a TV user is on this
  screen with a remote).
- `+page.server.ts` action: set `mode` on the session (re-sign cookie via `setSession`,
  preserving `profileId`), then redirect to `safeRedirectTarget` / `/`.

### Header switcher

- `AppHeader.svelte`: small "Desktop / TV" indicator that links to `/mode` so the choice is
  changeable without logging out.

## 4. Streaming endpoint — `src/routes/stream/[mediaId]/+server.ts`

Range-proxy the original file from WebDAV to the `<video>` element.

- `GET`: look up `catalog` by `mediaId` → `{ path, type }`. 404 if missing or not a
  playable type (`movie` | `episode`).
- Build the absolute WebDAV URL (`config.webdavUrl` + account-relative `path`) and issue a
  **native `fetch`** with:
  - `Authorization: Basic base64(user:appPassword)` (don't leak creds in a URL).
  - **Forward the client's `Range` header** verbatim when present.
- **Pass the upstream response straight through**: propagate `status` (200 or **206**),
  and headers `Content-Range`, `Content-Length`, `Accept-Ranges: bytes`, and a
  `Content-Type` derived from the file extension (`.mp4`→`video/mp4`,
  `.mkv`→`video/x-matroska`, `.avi`→`video/x-msvideo`; fallback
  `application/octet-stream`). Stream `response.body` (a web `ReadableStream`) as the
  SvelteKit `Response` body — no buffering the whole file in memory (critical on the weak
  VPS).
- Handle `HEAD` (metadata/size probe) and upstream errors (map 4xx/5xx to a clean status).
- **Auth:** `/stream` is not in `PUBLIC_PATHS`, so `hooks.server.ts` already requires a
  valid session — no extra check needed, but confirm during verification.

> WebDAV helper: add `streamFile(path, { range })` to `webdav.ts` that performs the
> authenticated fetch and returns `{ status, headers, body }`, keeping the raw-fetch detail
> out of the route. Verifies the Phase-3 risk in `plan.md §13` (Nextcloud honors `Range`).

## 5. Subtitle endpoint — `src/routes/subtitles/[mediaId]/[lang]/+server.ts`

- `GET`: look up the media's `subtitles` JSON (already stored per episode/movie in
  `catalog.subtitles` from Phase 2) → find the entry matching `[lang]`. 404 if none.
- Fetch the `.srt` bytes from WebDAV (reuse `streamFile`/`getFileContents`), decode as UTF-8
  (tolerate a leading BOM), run the in-house converter → WebVTT, return with
  `Content-Type: text/vtt; charset=utf-8`.
- Converter (`src/lib/server/subtitles.ts`, pure + unit-checkable): prepend `WEBVTT\n\n`,
  replace `,` with `.` in `HH:MM:SS,mmm` timestamps, drop numeric cue-index lines, normalize
  newlines. Keep it small and forgiving (malformed cue → pass through rather than throw).

## 6. Player — `src/lib/components/Player.svelte`

One mode-agnostic component, hosted two ways (§7).

- Props: `{ mediaId, title, subtitles: SubtitleRef[], startAt: number, initialSubPref:
{ enabled, language } }`.
- `<video>` with `controls`, `preload="metadata"`, `src={/stream/[mediaId]}`, and one
  `<track kind="subtitles" srclang label src={/subtitles/[mediaId]/[lang]}>` per available
  language.
- **Resume:** on `loadedmetadata`, if `startAt > 0` and `startAt < 0.95 × duration`, seek to
  `startAt`.
- **Subtitles button:** small overlay button → menu of "Off" + each language. Selecting sets
  the matching `TextTrack.mode` (`showing`/`disabled`) and persists the choice (§8).
  Apply `initialSubPref` once tracks are ready.
- **Progress reporting (§8):** throttled `timeupdate` (every ~15 s) + on `pause` and on
  `visibilitychange`/`beforeunload` (via `navigator.sendBeacon` so the last position isn't
  lost on unload).

## 7. Player hosts

- **TV → `/watch/[mediaId]` route.** `+page.server.ts` loads the media (title, `startAt`
  from `progress`, subtitle pref) and gates on `mode === 'tv'` conceptually but works for
  either. Fullscreen-first layout: black background, video fills the viewport, title overlay.
  Episode/movie **Play** buttons link here when `mode === 'tv'`.
- **Desktop → inline.** In `mode === 'desktop'`, Play renders `<Player>` **in-page**:
  - Movie detail (`/movies/[id]`): Play swaps the poster/hero area for the inline player.
  - Show detail (`/shows/[id]`): Play on an episode reveals the inline player at the top of
    the episode list (`?play=<episodeId>` drives which one; server load supplies `startAt`
    - pref for the chosen episode). `EpisodeList.svelte`'s stub button becomes a real link.
- Both hosts render the **same `<Player>`**; only the surrounding container differs. Play
  buttons pick their target from `data.mode`.

## 8. Progress + subtitle prefs (server)

### `src/lib/server/progress.ts`

- `getProgress(profileId, mediaId)` → `{ positionSeconds, durationSeconds } | null`.
- `saveProgress(profileId, mediaId, position, duration)` → upsert
  (`INSERT … ON CONFLICT(profile_id, media_id) DO UPDATE`), refresh `updated_at`.
- Endpoint `POST /api/progress` (`+server.ts`): JSON `{ mediaId, position, duration }`,
  scoped to `locals.auth.profileId`. Accepts `sendBeacon` payloads. Returns 204.
- `continueWatching()` (already written in `catalog.ts`) now returns real rows → the home
  page "Continue watching" section populates automatically. Optionally hide near-finished
  items (position ≥ 95%).

### `src/lib/server/subtitlePrefs.ts`

- `getSubtitlePref(profileId)` → `{ enabled, language }` (default `{ enabled:false,
language:null }`).
- `saveSubtitlePref(profileId, enabled, language)` → upsert into `subtitle_prefs`.
- Endpoint `POST /api/subtitle-pref`: persists the player's on/off + language choice.

## 9. Catalog read helper

- Add `getPlayable(mediaId)` to `catalog.ts` → `{ mediaId, type, title, path, subtitles }`
  for `movie`/`episode` rows (used by `/stream`, `/subtitles`, `/watch`). Keeps route
  handlers off raw SQL.

## 10. TV / D-pad

- `/mode` cards, the subtitles menu, and the `/watch` layout are all real
  `<a>`/`<button>`s using `spatialNav`. Native `<video controls>` are keyboard-reachable;
  full remote-driven transport is a Phase 6 concern (noted, not built now).

## 11. Verification / acceptance

- `npm run lint`, `npm run check`, `npm run build` all clean.
- **Range mechanics (Claude runs, hardware-independent):** with a dev session cookie,
  `curl -H 'Range: bytes=0-1023'` against `/stream/<episodeId>` returns **206** with correct
  `Content-Range` / `Content-Length` / `Accept-Ranges: bytes`; a no-Range request returns
  200 with the full length. Confirms Nextcloud range support end-to-end (`plan.md §13`).
- **Subtitles:** `/subtitles/<episodeId>/de` and `/en` return valid `WEBVTT` payloads with
  dot-timestamps.
- **Progress + resume:** POST a position → row appears in `progress`; reopening the player
  seeks to it; the home "Continue watching" row shows the item.
- **Subtitle pref:** toggling language persists to `subtitle_prefs` and re-applies on reload.
- **Real playback (best-effort, hardware-dependent):** on the dev Mac, load the HEVC `.mp4`
  episode in the inline (desktop) player and confirm it plays + seeks. The `.mkv`/x264 file
  is expected **not** to direct-play in Chrome — documented, deferred to Phase 4/5, not a
  failure of this phase.
- Device-mode flow: fresh login → profile → `/mode` → landing; header switcher flips
  desktop/TV and changes where Play sends you.

## 12. Notes / risks

- **Streaming through nginx (prod):** buffering must be off for range/streaming to behave —
  already called out in the Phase-0 nginx block; re-verify when deployed.
- **No whole-file buffering:** the proxy must stream (`ReadableStream` passthrough), never
  `await response.arrayBuffer()` — a 2 GB episode would OOM the weak VPS otherwise.
- **`sendBeacon` size:** progress payload is tiny JSON — fine for beacon limits.
- **Codec caveat** (see §0): desktop direct-play coverage is partial by design this phase.
- **Delegation:** implementation delegated to a Sonnet subagent per the working agreement;
  Claude reviews + runs the range/subtitle/progress verification.

---

## 13. Completion (2026-07-29) ✅

Built (Sonnet subagent) and verified (Claude). `npm run lint`, `npm run check`, `npm run
build` all clean. Live verification against the real Nextcloud + dev server (forged session
cookie, temp profile — both removed after):

- **Range proxy:** `Range: bytes=0-1023` → **206**, `Content-Range: bytes 0-1023/826876230`,
  `Content-Length: 1024`, `Accept-Ranges: bytes`, `video/mp4`. No-Range → **200** full length.
  A mid-file `bytes=1000000-1000009` returned **exactly 10 bytes / 206** — Nextcloud honors
  arbitrary ranges, so `<video>` seeking works (closes the `plan.md §13` risk).
- **Auth gate:** `/stream/<id>` with no cookie → **303** to `/login` (hooks guard covers it).
- **Subtitles:** `/subtitles/<id>/de` + `/en` → **200** `text/vtt; charset=utf-8`, valid
  `WEBVTT` with dot-timestamps. Bracketed filenames (`[eztv.re]`) fetch fine — per-segment
  `encodeURIComponent` in `toAbsoluteUrl`.
- **Progress:** `POST /api/progress` → **204**, row upserted (`position_seconds=123.5`).
  `startAt` is threaded to the `/watch` client payload for resume-seek. "Continue watching"
  section renders the item on `/`.
- **Subtitle pref:** `POST /api/subtitle-pref` → **204**, persisted (`enabled=1, language=en`).
- **Player markup:** `/watch/<id>` and `/shows/<id>?season=1&play=<id>` both render a
  `<video>` with `/stream/<id>` + a `<track>` per language. Pages return 200: `/`, `/mode`,
  `/watch/<id>`, `/movies`, `/shows`, show-detail with `?play=`.

**Not machine-verifiable here (hardware/browser-dependent, by design):** whether a given file
_decodes_ in a _desktop_ browser. The bytes stream correctly; the HEVC `.mp4` should play on
the dev Mac (hardware HEVC), the x264 `.mkv` will not direct-play in Chrome — that gap is
Phase 4 (WASM) / Phase 5 (transcode), as planned. Worth an eyeball in an actual browser.
