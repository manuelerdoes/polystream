# Phase 2 — Library browsing

Build plan for Phase 2 (see `plan.md` §11). Scope: scan the WebDAV source into a
normalized catalog, parse filenames, match against TMDB for artwork/overviews, and
build the browse UI (movies grid, shows → seasons → episodes, Continue Watching row).

Out of scope (later phases): actual playback / streaming endpoint, subtitle conversion,
transcode. Episode/movie "Play" buttons are stubs here (wired up in Phase 3).

---

## 0. Decisions locked with the user (2026-07-29)

- **Artwork:** served **directly from the TMDB image CDN** (`image.tmdb.org`). We store
  only TMDB's relative image paths; no server-side image download/caching. Zero VPS disk.
- **Scan trigger:** **manual "Rescan" button** in the UI, plus an automatic one-time scan
  if the catalog is empty on first load. No scan-on-every-boot.
- **Verification:** lint/check/build **and** a live scan against the real Nextcloud + TMDB
  (run by Claude) to confirm parsing/matching on the real library.

## 0.1 Ground truth from the live source (probed)

- WebDAV media root = `tv/`, containing `movies/` (currently **empty**) and `tv shows/`.
- One real show: `tv shows/Bad Sisters/Season 1/…`, `Season 2/…`.
- Episode filename style (dot-separated):
  `Bad.Sisters.S01E01.1080p.WEBRip.x265-RARBG[eztv.re].mp4`
  `Bad.Sisters.S02E01.WEB.x264-TORRENTGALAXY.mkv`
- External subtitles are **siblings** with a language suffix:
  `Bad.Sisters.S01E01.…_de.srt`, `…_en.srt`.
- Season folders: `Season 1`, `Season 2` (space + number, not zero-padded).
- Movies not yet present → build for the standard `Movie Name (Year).ext` style but only
  TV can be verified live this phase.

---

## 1. Dependencies

- Add **`webdav`** (latest, v5.x — ESM, fetch-based, works with adapter-node). Server-only.
- TMDB: no package — use native `fetch` (v3 API, `?api_key=…`). The configured key is a
  v3 key. Requests are server-side only (key never reaches the client).

## 2. Data model (migration `0002_library.sql`)

Extend, don't rewrite, the Phase-0 schema:

```sql
ALTER TABLE catalog ADD COLUMN year INTEGER;        -- release/first-air year (parsed or TMDB)
ALTER TABLE catalog ADD COLUMN sort_title TEXT;     -- lowercased, article-stripped, for A–Z
ALTER TABLE catalog ADD COLUMN mtime INTEGER;       -- WebDAV lastmod, for "recently added"

ALTER TABLE metadata ADD COLUMN name TEXT;          -- TMDB canonical title / episode name
ALTER TABLE metadata ADD COLUMN still_path TEXT;    -- episode still image (TMDB path)
ALTER TABLE metadata ADD COLUMN air_date TEXT;      -- episode/first air date
ALTER TABLE metadata ADD COLUMN runtime INTEGER;    -- minutes, when TMDB provides it

CREATE TABLE scan_state (
    id           INTEGER PRIMARY KEY CHECK (id = 1),
    status       TEXT NOT NULL DEFAULT 'idle',   -- idle | running | error
    last_scan_at INTEGER,
    last_error   TEXT,
    item_count   INTEGER NOT NULL DEFAULT 0
);
INSERT INTO scan_state (id) VALUES (1);
```

`catalog.type` values remain `movie | show | season | episode`.
`media_id` = stable hash (sha1, hex, first 16 chars) of the WebDAV path (unchanged).
For seasons/episodes, `parent_id` chains episode → season → show. Movies have no parent.

## 3. Server modules (`src/lib/server/`)

### `webdav.ts`

- Lazily build a single `webdav` client from `config` (like `getDb()`).
- `getClient()`, `listDir(path)` → normalized `{ name, path, isDir, size, mtime }[]`.
- A `walk()` helper that recursively lists under the media root (bounded depth: root →
  category → show → season → files; movies: root → category → file/folder).
- All paths are **relative to `WEBDAV_URL`**; store the account-relative path in `catalog.path`.

### `filename.ts` (pure, no I/O — easy to unit-check)

- `parseEpisode(name)` → `{ showName, season, episode }` from `S01E02` / `1x02` patterns;
  show name = text before the marker, dots/underscores → spaces, trimmed.
- `parseMovie(name)` → `{ title, year }` from `Title (2021)` / `Title.2021.…`.
- `parseSubtitle(name)` → `{ base, lang }` from `..._de.srt` / `..._en.srt` / `.srt`
  (lang defaults to `und` when absent). Used to attach external subs to episodes/movies.
- `cleanTitle()` — strip release tags (resolution, codec, group, brackets), collapse
  separators. `sortTitle()` — lowercase + strip leading `The `/`A `/`An `.
- `parseSeasonFolder(name)` → season number from `Season 1` / `Season 01` / `S1`.

### `tmdb.ts` (server-only)

- `searchShow(title, year?)`, `searchMovie(title, year?)` → best match `{ tmdbId, name,
overview, poster_path, backdrop_path, first_air_date }`.
- `getEpisode(tmdbId, season, episode)` → `{ name, overview, still_path, air_date, runtime }`.
- Gentle sequencing (small concurrency, TMDB free tier is generous but be polite); tolerate
  misses (no match → leave metadata null, UI falls back to a placeholder tile).
- `language=en-US` for now (UI subtitle language is separate; can revisit).

### `scanner.ts` (orchestrator)

- In-memory single-flight lock (single process, matches concurrency plan). If a scan is
  already `running`, return early.
- Steps: set `scan_state=running` → walk WebDAV → parse into catalog rows → **upsert**
  (INSERT … ON CONFLICT) so re-scans are idempotent and prune vanished paths → for each
  show/movie query TMDB (skip if metadata already fresh) → upsert metadata → for episodes,
  fetch episode-level TMDB data → set `scan_state=idle` + `last_scan_at` + `item_count`.
  On throw: `status=error`, `last_error`.
- Attach external `.srt` siblings to their episode/movie now (store the discovered subtitle
  paths — a small JSON column or a side table). **Decision:** add
  `ALTER TABLE catalog ADD COLUMN subtitles TEXT;` holding a JSON array of
  `{ lang, path }`, populated at scan time; Phase 3 consumes it. (Cheap, avoids a join.)

### `catalog.ts` (read queries for the UI)

- `listMovies()`, `listShows()` → cards (joined with metadata).
- `getShow(id)` → show + its seasons; `getSeason(showId, n)` → episodes (ordered).
- `getScanState()`; `continueWatching(profileId)` → joins `progress` (empty until Phase 3;
  build the query + row component now, render nothing when empty).

## 4. Shared client-safe helper (`src/lib/tmdb.ts`)

- `tmdbImage(path, size)` builds `https://image.tmdb.org/t/p/{size}{path}`.
  Sizes: poster `w342`, backdrop `w1280`, still `w300`. Returns `null` for null paths so
  cards can show a monogram/gradient placeholder. **No API key here** (images are public).

## 5. Routes

- `/` — home. Continue Watching row (hidden when empty) + "Movies" and "TV Shows" section
  links/preview rows. **Rescan** button (form action → `scanner.scan()`), shows scan status
  - last-scan time. Empty-catalog state → prominent "Scan your library" call to action.
- `/movies` — responsive poster grid of movies.
- `/shows` — responsive poster grid of shows.
- `/shows/[id]` — show detail: backdrop hero + overview, season selector, episode list
  (number, title, still, overview). Episode "Play" is a disabled/stub button (Phase 3).
- `/movies/[id]` — minimal movie detail (poster, overview, year); "Play" stub.
- Load functions pull from `catalog.ts` (cache only — never hit WebDAV/TMDB on a page load;
  those run only during a scan). `+page.server.ts` actions for rescan live on `/`.

## 6. Components (`src/lib/components/`)

- `MediaCard.svelte` — poster tile: TMDB image (lazy) or placeholder, title, year; wraps an
  `<a>` so Tab/Enter/D-pad work. Reuse the `spatialNav` action for arrow navigation.
- `PosterGrid.svelte` — responsive CSS grid of `MediaCard`s.
- `MediaRow.svelte` — horizontal scroll row (home page sections / Continue Watching).
- `EpisodeList.svelte` — season's episodes with still + title + overview.
- `ScanBar.svelte` — rescan button + status (idle/running/error/last-scan).
- Keep the dark-theme design tokens from `+layout.svelte`; add poster aspect-ratio (2:3)
  and skeleton/placeholder styles.

## 7. TV / D-pad

- Everything focusable is a real `<a>`/`<button>`; reuse `spatialNav`. Grids and rows must
  scroll the focused card into view (`scrollIntoView({ block: 'nearest' })` on focus).

## 8. Verification / acceptance

- `npm run lint`, `npm run check`, `npm run build` all clean.
- **Live scan (Claude runs):** `npm run dev`, log in, trigger Rescan → Bad Sisters appears
  under TV Shows with a TMDB poster + overview; its Season 1/2 episodes list with matched
  titles; external `_de`/`_en` subs recorded on episodes; movies section empty (expected).
- Re-scan is idempotent (no duplicates, counts stable).

## 9. Notes / risks

- **TMDB key type:** configured key is treated as a **v3** key (`api_key` query param). If
  TMDB returns 401, fall back to `Authorization: Bearer` (v4). Detect and report clearly.
- **Filename fuzziness:** curator naming is clean, so exact-ish matching is fine; unmatched
  items still render with placeholder art and parsed titles (never break the grid).
- **Scan cost on weak VPS:** scan is manual + single-flight; TMDB calls are sequential-ish.
  Acceptable for a small library.
- **Delegation:** implementation delegated to a Sonnet subagent per the working agreement;
  Claude reviews + runs the live scan.

---

## 10. Completion (2026-07-29) ✅

Built and verified. `npm run lint`, `npm run check` (0/0), `npm run build` all clean.

**Live scan against the real Nextcloud + TMDB confirmed everything end-to-end:**

- Catalog: 15 items — 1 show (Bad Sisters), 2 seasons, 12 episodes. Movies empty (expected).
- TMDB match: Bad Sisters → tmdb 199318, year 2022, poster + backdrop + overview.
- Episode-level TMDB: correct titles ("The Prick", "Explode a Man", …) + stills on all 12.
- External subs attached per episode with correct `de`/`en` langs and WebDAV paths.
- **Rescan is idempotent** — counts stable (15 catalog / 13 metadata rows), no duplicates.
- Pages render 200: `/`, `/movies` (empty state), `/shows`, `/shows/[id]`, `?season=2`;
  show detail serves posters/stills straight from `image.tmdb.org` as designed.
- TMDB key worked as a **v3** key — no 401, no v4 fallback needed.

**Dev-env papercut — FIXED (2026-07-29).** Originally `config.ts` read `process.env`
directly, which `vite dev` does not populate from `.env`, so a bare `npm run dev` threw
"missing required env var". Fixed the idiomatic SvelteKit way: `config.ts` now sources from
`$env/dynamic/private` (runtime read, Docker-injectable, Vite auto-loads `.env` in dev). No
build baking, `building` guard kept. Verified: plain `npm run dev` (no `.env` sourcing)
serves `/login` 200 with zero config errors; lint/check/build still clean.
