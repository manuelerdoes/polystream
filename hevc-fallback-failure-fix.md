# Fix: a failed H.264 conversion must never take away Play

_2026-08-06_

## The bug

Requesting "Generate H.264 version" on an HEVC title and having the job fail leaves the title
**unplayable**, permanently:

- `catalog.ts`'s `isPlayReady()` returns `false` for **any** job state other than `done` —
  including `error`, and including a job whose `kind` is `'h264'`.
- Every play surface gates on it: the movie page's Play link, `EpisodeList`'s per-episode Play,
  `/watch`, the `?play=` inline player, and `getNextEpisode()` (autoplay skips the successor).
  All of them render `<ConversionStatus>` — "Conversion failed" — **in place of** the Play control.
- The `conversion_jobs` row is one-per-media and never cleared, so the badge is permanent, and
  `GenerateFallbackButton`'s `showButton` hides itself whenever any h264 job exists — so there is
  no retry either. Dead end.

This gating is wrong on the facts. `convert.ts` guarantees `stream → local temp → verify → upload
→ only then replace the original`, so **a failed job never touched the library**, and an `'h264'`
job is purely additive — it never touches the primary even on success. The HEVC file that was
playable before the attempt is still exactly as playable after it.

## The fix

1. **`isPlayReady` (moved to `src/lib/playReady.ts`, pure + client-safe, re-exported from
   `catalog.ts`)** — only a _queued/running_ `remux`/`reencode` job blocks Play:
   - no job → ready
   - `kind: 'h264'` → ready in every state (never touches the primary)
   - `error` → ready (source untouched by the safety ordering)
   - `done` → ready
     `EpisodeList` imports the shared helper instead of re-implementing it.

2. **`GenerateFallbackButton`** — an errored job no longer hides the button: it comes back as
   "Retry H.264 version", with the failure shown as a non-blocking note beside it (never in place
   of Play). `/api/fallback` already allows a re-request after an error, so retry just works.

3. **Dismissable failure** — `DELETE /api/conversions` (`clearConversionJob`) drops a job row that
   is `error`/`done` only (never one in flight), so a failure the user has read can be cleared for
   good instead of sitting under the title forever.

4. **`DownmixAudioButton`** — identical retry/dismiss treatment; it mirrors the fallback button by
   design and had the same dead end.

## Deliberately unchanged

- A queued/running `remux`/`reencode` still hides Play: those _do_ replace the primary, and the
  pre-conversion file is the one the browser couldn't play in the first place.
- `pickVariant`'s `'unavailable'` verdict (HEVC primary, no fallback, device can't decode HEVC) is
  a separate, correct message from the player — not touched here.
