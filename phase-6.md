# Phase 6 — Polish

The final phase from `plan.md §11`: rescan controls, error/empty states, loading skeletons,
cache eviction jobs, TV UX pass, performance tuning. This is a grab-bag; this doc scopes it
into concrete workstreams grounded in the **current** code (post Phase 5 media pipeline), and
flags what already exists so we don't redo it.

## Current-state findings (2026-07-31)

- **Rescan** already exists: `ScanBar.svelte` + `?/rescan` action on the home page, with
  item count, last-scan time, and scan-error display. ✅ (basic form done)
- **Conversion status** UI exists (`ConversionBar`, `ConversionStatus`, `/api/conversions`).
- **Empty states** partially exist on some routes (home, movies, shows).
- **Skeletons**: only `MediaCard`/`EpisodeList` reference "loading"; no real skeleton pass.
- **Cache eviction — GAP.** `config.assetCacheMaxMb` (default 256) is **declared but never
  used anywhere**. Nothing enforces a disk budget.
- **Orphaned disk — GAP.** `data/hls/` holds **441 MB** of stale `.ts` segments from the
  abandoned Phase 4b HLS approach. The HLS _code_/route/dependency are already deleted; only
  the runtime directory on disk remains. Safe to delete + stop creating.
- **TV / D-pad nav**: global spatial-nav controller already landed (`tv-navigation.md`).
  A focused TV UX _pass_ (focus visibility, scroll-into-view edge cases, watch-page controls)
  is still open.
- `data/convert/` is the conversion temp dir (currently empty — cleaned per job). ✅

## Workstreams

### A. Cache eviction & disk hygiene — **DONE 2026-07-31 ✅**

Investigation (2026-07-31) found the caches `plan.md §10` assumed don't exist as on-disk
state: **artwork is hotlinked** from `image.tmdb.org` by the browser (never cached server-side),
**subtitles are converted in-memory** on demand, and **HLS is abandoned** (Phase 5). So under
`dataDir` the only things are the SQLite DB, the per-job convert temp, and the orphaned
`data/hls/`. `assetCacheMaxMb` therefore bounded nothing — it was dead config.

User decision (2026-07-31): **retire the dead config**; no server-side artwork cache for now
(revisit under Slice E / performance if desired). Done:

1. **Deleted the orphaned `data/hls/`** (441 MB of stale `.ts` from Phase 4b). Nothing in the
   codebase references or recreates it (grep clean), so no code change needed to "stop creating".
2. **Removed `assetCacheMaxMb`** from `config.ts` and `ASSET_CACHE_MAX_MB` from `.env.example`.
3. **Added a boot-time stale-temp sweep** to `convert.ts` (`sweepStaleTemps`, fired from
   `initOnce`): deletes files in `data/convert/` older than 6 h — the leftovers of a job whose
   ffmpeg died mid-run (crash/restart). A live job's temp keeps a fresh mtime, so it's never
   at risk. Complements the existing per-job `rm` cleanup + `requeueInterruptedJobs`.

`lint` (eslint clean) + `check` (0 errors) pass. `README.md` prettier warning is pre-existing
and unrelated.

### B. Error & empty states

- Audit every route for: WebDAV unreachable, TMDB failure, empty library, empty search/row,
  media missing/unplayable, conversion failed. Consistent, friendly messaging + retry where
  it makes sense. Reuse a small `EmptyState` / `ErrorState` component.

### C. Loading skeletons

- Poster grids, rows, and detail pages get skeleton placeholders during navigation/load
  (SvelteKit `+page` loading). Keep it CSS-only, theme-aware, no layout shift.

### D. TV UX pass

- Focus-ring visibility on every focusable, reliable `scrollIntoView` on focus move, watch-page
  custom-player controls fully D-pad operable, no focus traps. Test the arrows-only flow end
  to end.

### E. Performance tuning

- Measure first: catalog query cost, image sizes served, initial JS payload, range-proxy
  throughput. Then targeted fixes (downsized artwork, DB indices, lazy images, caching headers).

## Working agreement

- Pick a slice, plan the specifics in this doc, implement (Sonnet subagent for big coding
  tasks), verify (`lint`/`check`/`build` + manual), then move to the next slice.
- No big changes without checking in first.

## Status

- Plan drafted 2026-07-31.
- **Slice A (cache eviction & disk hygiene) — DONE 2026-07-31.**
- Next: user to pick B (error/empty states), C (skeletons), D (TV UX pass), or E (perf).
