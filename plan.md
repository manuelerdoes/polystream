# Polystream — Implementation Plan

A SvelteKit web app that streams movies and TV shows from a WebDAV source, with an
appealing, easy-to-use UI. This document is the single source of truth for scope and
architecture. We build it in phases but the full design is planned upfront.

---

## 1. Locked decisions

These come from our Q&A and drive everything below.

| Area                  | Decision                                                                                                                                                                                       |
| --------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| **Framework**         | SvelteKit (latest), Svelte 5 (runes), TypeScript. Use Svelte-native solutions first.                                                                                                           |
| **Server**            | Weak / VPS-like (~2 cores, ~2–4 GB RAM, few GB disk). Assume CPU is scarce.                                                                                                                    |
| **Deployment**        | Docker container (SvelteKit Node adapter + bundled `ffmpeg`) bound to `127.0.0.1:3000`, reverse-proxied by the VPS's **existing nginx** (TLS via certbot). No Caddy — reuse the running nginx. |
| **Playback strategy** | Capability-based, per device: **1)** direct-play compatible files → **2)** client-side WASM decode fallback → **3)** optional user-triggered server-side transcode (last resort).              |
| **Target devices**    | Desktop Chrome/Edge + Smart TV browsers (Tizen/webOS/Android TV).                                                                                                                              |
| **Concurrency**       | 1–2 simultaneous viewers. Server transcode capped at **1 concurrent job**.                                                                                                                     |
| **Metadata / art**    | TMDB API, matched from folder names. Cached locally.                                                                                                                                           |
| **Auth**              | One shared hardcoded password → then a lightweight "who's watching?" profile picker (Netflix-style, no per-user passwords).                                                                    |
| **Watch progress**    | Stored server-side **per profile**; drives resume + "Continue watching".                                                                                                                       |
| **Subtitles**         | Support embedded + external `.srt`. Convert to WebVTT. **Remember last choice** (on/off + language) per profile.                                                                               |
| **Caching**           | Cache only small, high-value data (index, subtitles, artwork, short rolling HLS window). Never cache whole video files.                                                                        |

---

## 2. The core problem: browser codec compatibility

Files are `mkv` / `mp4` / `avi`, video is **H.264 or H.265 (HEVC)**.

- **Desktop Chrome/Edge:** play H.264 in MP4 natively. Cannot play MKV, AVI, or H.265.
- **Smart TVs:** usually have **hardware HEVC decoders** → can direct-play H.265 in native
  `<video>`, but are **too weak to run WASM decoding**.

So there is no one-size playback path. The app must **probe each device's capabilities**
and choose the cheapest path that works:

```
For a given file + device:
  1. Can the device natively play this container+codec?  → DIRECT PLAY (best, zero CPU)
  2. Else, is the device powerful enough for WASM decode? → CLIENT-SIDE DECODE
  3. Else / user opts in ("I'm on a weak device")         → SERVER TRANSCODE to HLS
```

- **Container remux vs. re-encode:** many MKVs are already H.264 — for those the server can
  **remux** (copy streams into fMP4/HLS, no re-encoding) which is cheap even on a weak VPS.
  Only true H.265→H.264 re-encoding is CPU-expensive. The transcode layer must prefer remux.

---

## 3. Architecture overview

```
Browser (SvelteKit client)
  │  password + profile → session cookie
  │  browse library, request playback
  ▼
SvelteKit server (Node adapter, in Docker)
  ├─ Auth: shared password → session; profile selection
  ├─ Library service:  WebDAV listing → normalized catalog (cached)
  ├─ Metadata service: TMDB match + artwork (cached)
  ├─ Stream router:    /stream/... → proxied range requests to WebDAV
  ├─ Subtitle service: extract embedded / read .srt → WebVTT (cached)
  ├─ Transcode service: ffmpeg → HLS, 1 job max, rolling-segment cache
  └─ Progress store:   per-profile resume points (SQLite)
  ▼
WebDAV source (movies / tv shows / seasons / episodes)
```

**External deps at runtime:** WebDAV server, TMDB API, `ffmpeg` binary.

---

## 4. Tech stack

- **SvelteKit** (`@sveltejs/adapter-node`), **Svelte 5 runes**, **TypeScript**, **Vite**.
- **WebDAV client:** `webdav` (npm) for listing + range reads.
- **DB:** **SQLite** via `better-sqlite3` (tiny footprint, fits a weak VPS). Stores profiles,
  progress, subtitle prefs, and the metadata/catalog cache.
- **Video player:** custom Svelte wrapper around `<video>` + **hls.js** (for HLS transcode
  path) + a WASM decoder for the fallback (candidate: `libav.js` / `ffmpeg.wasm`; evaluated
  in Phase 4 — see Risks).
- **Transcoding:** system `ffmpeg` (in the image), spawned as child process → HLS (fMP4).
- **Subtitles:** `ffmpeg` for embedded track extraction; `subsrt`-style conversion to WebVTT.
- **Styling:** plain Svelte + CSS (design-system-agnostic), responsive + TV-navigable.

> If any package forces an older-than-latest version, that will be called out before install.

---

## 5. Data model (SQLite)

```
profiles(id, name, avatar, created_at)
progress(profile_id, media_id, position_seconds, duration_seconds, updated_at)
subtitle_prefs(profile_id, enabled, language)
catalog(media_id, type, title, path, parent_id, season, episode, ...)      -- cached listing
metadata(media_id, tmdb_id, overview, poster_path, backdrop_path, ...)      -- cached TMDB
```

`media_id` = stable hash of the WebDAV path.

---

## 6. Library / metadata pipeline

1. **Scan** WebDAV recursively → build normalized catalog (movies, shows → seasons → episodes).
2. **Parse** folder/file names (title, year, SxxEyy) with a filename parser.
3. **Match** against TMDB → posters, backdrops, overviews, episode titles.
4. **Cache** catalog + metadata in SQLite; refresh on a schedule / manual "rescan" button.
5. Serve the browse UI entirely from cache (fast, no per-request WebDAV/TMDB calls).

---

## 7. Streaming & transcode strategy (detail)

- **Direct play:** `/stream/[mediaId]` proxies the file with **HTTP Range** support so the
  `<video>` element can seek. (⚠️ depends on WebDAV honoring range requests — see Risks.)
- **Client-side decode:** for incompatible files on capable desktops, feed the WASM decoder;
  keep it behind a capability check so we never hand it to a TV.
- **Server transcode (opt-in):** user clicks "playing poorly? switch to server mode" →
  spawn ffmpeg → HLS. **Prefer remux (stream copy)** when video is already H.264; only
  re-encode H.265 when necessary. **Hard cap: 1 concurrent job.** A 2nd request while busy
  gets a clear "server busy, try direct/client mode" message.
- **Rolling segment cache:** keep only a short window of HLS segments on disk, auto-evicted,
  to respect the small storage.

---

## 8. Subtitles

- **External `.srt`:** detected as sibling files → converted to WebVTT on demand, cached.
- **Embedded:** enumerate tracks via `ffprobe`; extract selected track → WebVTT on demand.
- Exposed as `<track>` elements; UI lets the user toggle on/off and pick language.
- **Remember last choice** (enabled + language) per profile.

---

## 9. Auth & profiles

- Single shared password (from env) → sets an httpOnly session cookie.
- After login, a **"who's watching?"** screen lists profiles (create/rename/delete).
- Selected profile id rides in the session → scopes progress + subtitle prefs.
- No per-profile passwords (matches "everyone knows one password").

---

## 10. Caching policy (answering "what do you think about storage")

**Do cache (small, high value):** catalog index, TMDB metadata + downsized artwork,
converted subtitles, a short rolling window of HLS segments.
**Do not cache:** whole video files, full transcoded copies.
All caches are size-bounded with eviction so disk usage stays predictable on the weak VPS.

---

## 11. Build phases

### Phase 0 — Project setup

- SvelteKit + TS + Svelte 5 scaffold, adapter-node, lint/format.
- Dockerfile with Node + `ffmpeg`; `docker-compose.yml` binding the app to `127.0.0.1:3000`.
- Example **nginx server block** (reverse proxy, buffering off, HTTP/1.1, long timeouts) +
  certbot notes, to add to the existing nginx.
- `.env` handling (WebDAV creds, TMDB key, shared password, session secret).
- SQLite init + migrations.

### Phase 1 — Auth, profiles, shell

- Password login → session. "Who's watching?" profile picker. App layout/nav (mouse + TV
  D-pad friendly focus handling).

### Phase 2 — Library browsing (MVP-visible)

- WebDAV scan → catalog. Filename parsing. TMDB matching + artwork. Browse UI: movies grid,
  shows → seasons → episodes. "Continue watching" row (from progress store).

### Phase 3 — Direct-play playback

- Range-proxy streaming endpoint. Player wrapper. External `.srt` → WebVTT subtitles.
- Progress tracking + resume. Remembered subtitle prefs.
- **Device-mode step** (added 2026-07-29): after the profile pick, the user chooses
  **Desktop** (inline in-page player) or **TV** (fullscreen `/watch/[id]` route). Stored in
  the session cookie, switchable from the header. Native `<video controls>` + a small custom
  subtitles menu; in-house `.srt`→WebVTT converter (no new dependency). Detail: `phase-3.md`.

### Phase 4 — Compatibility fallbacks — **Complete 2026-07-29 ✅** (`phase-4.md §7`)

- Device capability probing. Client-side compat path (desktop only). Embedded subtitle
  extraction. **Reframed 2026-07-29** (detail: `phase-4.md`): research showed full WASM
  _decode_ is the wrong primary tool — the browser can't open `.mkv`/`.avi` but _can_
  hardware-decode the H.264 inside, so the desktop fallback is a cheap **libav.js container
  remux → MSE** (stream-copy, native hardware decode), not a software decoder. HEVC on a
  desktop without a hardware HEVC decoder can't be solved client-side (WebCodecs shares the
  same hardware limit) → routed to Phase 5 server transcode. Embedded subtitles are extracted
  **server-side** with the bundled `ffmpeg`/`ffprobe` (device-independent). Decoder pick
  (open question 5) is resolved by this.

### Phase 4b — Server-side HLS remux — **Code landed 2026-07-29** (`phase-4b-hls-remux.md`)

- Replaced Phase 4's client-side libav.js MSE remux with **server-side `ffmpeg -c copy` → HLS**:
  one session per media produces a whole VOD playlist on disk (~26× realtime measured live), the
  client plays it via native HLS (Safari) or `hls.js` (Chrome/Firefox) — one consistent path
  everywhere, fixing a real Safari bug where `.mkv` was mis-detected as direct-playable. Session
  lifecycle is LRU-bounded by `maxTranscodeJobs` + `hlsCacheMaxMb` (bumped to 2048). `lint`/
  `check`/`build` clean; live HLS playback + library rescan verification still pending (detail:
  `phase-4b-hls-remux.md`).

### Phase 5 — Server-side transcode (opt-in)

- ffmpeg → HLS with remux-preferred logic, 1-job cap + queue/busy messaging, rolling
  segment cache. hls.js integration + "switch to server mode" UI.

### Phase 6 — Polish

- Rescan controls, error/empty states, loading skeletons, cache eviction jobs, TV UX pass,
  performance tuning.

---

## 12. Open questions / need from you

1. **WebDAV source — RESOLVED: Nextcloud.** Nextcloud speaks WebDAV and honors HTTP Range
   requests, so direct-play + seeking work. Credentials go in `.env` (from `.env.example`) —
   see that file for exactly what to collect. **Use a Nextcloud _App Password_** (Settings →
   Security), not the real password. If media is _shared into_ your account rather than owned
   by it, the WebDAV path may differ — flag that if so.
2. **TMDB API key:** you'll obtain one → goes in `.env`.
3. **Naming conventions — RESOLVED: very clean** (single curator, careful naming). Parser can
   assume tidy `Show Name/Season 01/Show Name - S01E02.ext` style names; less fuzzy-matching
   needed.
4. **Domain / HTTPS — RESOLVED: reuse the VPS's existing nginx.** The VPS already runs nginx
   (static sites + Next.js reverse proxies, no Docker yet). Polystream runs as a Docker
   container bound to `127.0.0.1:3000`; a new nginx `server` block reverse-proxies the chosen
   (sub)domain → `:3000`, with TLS via certbot like the other sites. No Caddy (would conflict
   on 80/443). Streaming needs specific proxy settings (buffering off, HTTP/1.1, long
   timeouts) — provided in Phase 0. **Need from you:** the (sub)domain to use, e.g.
   `stream.example.com`.
5. **WASM decoder pick (Phase 4) — RESOLVED 2026-07-29.** Reframed away from a software
   decoder: the desktop fallback is **`libav.js@6.9.8` in container-remux (stream-copy) mode →
   MSE**, single-threaded build (no COOP/COEP needed). Full WASM decode is not shipped — the
   only case it would serve (HEVC without hardware) is better handled by Phase 5 transcode.
   Rationale + build plan in `phase-4.md`.

### Still needed to start coding

- ~~Filled-in `.env`~~ — **DONE** (kept by you, not shared; app password used).
- ~~Media ownership~~ — **DONE:** owned by your account, so the standard WebDAV path applies.
- **The (sub)domain** to serve on (e.g. `stream.example.com`) for the nginx block + cert.

---

## 13. Key risks

- **WebDAV range support** — Nextcloud supports `Range`, so this is low risk. Still verify
  once against the live instance during Phase 3.
- **WASM decode on desktop** — heavy on CPU/battery; may be unusable for 4K/H.265. Gate by
  capability + resolution; server-transcode remains the escape hatch.
- **Single weak VPS + transcode** — 1 concurrent job only; a TV that can't direct-play H.265
  AND can't run WASM is fully dependent on that one slot. Acceptable at 1–2 viewers, but a
  real constraint to keep in mind.
- **TMDB matching accuracy** — depends on filename quality (see open question 3).

---

## 14. Working agreements

- Plans live in markdown (this file); update it as decisions change.
- No big changes without checking in first.
- Big coding tasks delegated to Sonnet subagents to save tokens.
- When something is unknown that you'd know — ask, don't assume.
