# Autoplay next episode (Netflix-style)

## Goal

When an episode finishes, show an "Up next" card with the next episode's title +
thumbnail and a ~10 s countdown that auto-advances to it. Buttons to **Play now**
or **Cancel**. Movies and last-episode-of-series get no card. If the next episode
isn't play-ready (still converting), treat it as "no next episode" — no card.

## Decisions (confirmed with user)

- **Trigger:** countdown overlay on `ended`, ~10 s, auto-advance. Play now / Cancel.
- **Not-ready next episode:** skip entirely (no card).

## What exists today

- `catalog.ts` holds the read queries; episodes are a tree: episode.parent_id →
  season.media_id, season.parent_id → show.media_id. Episodes carry `season` and
  `episode` number columns.
- `getPlayable(mediaId)` returns `PlayableMedia`; the watch load
  (`/watch/[mediaId]/+page.server.ts`) hands it plus `startAt`/`subtitlePref`/`ready`
  to `Player.svelte`.
- `Player.svelte` has full playback state but **no `onended` handler**.
- `isPlayReady(conversionState)` already gates readiness.

## Changes

### 1. `catalog.ts` — `getNextEpisode(mediaId)`

New exported function + `NextEpisode` type. Returns `null` for movies, unknown ids,
or when there is no play-ready successor.

Logic (single episode, walk the tree):
1. Load the current row; bail unless `type = 'episode'`.
2. Next in same season: smallest `episode` number `>` current, same `parent_id`
   (season), `type = 'episode'`.
3. Else first episode of the next season: find the season under the same show with
   the smallest `season` number `>` current season, then its lowest-numbered episode.
4. For the found episode, compute `isPlayReady(getConversionState(id))`; if not
   ready, return `null` (decision above).

`NextEpisode` shape (only what the card needs):
```
{ mediaId, season, episode, title, stillPath }
```
`stillPath` from `metadata.still_path` (TMDB), same as `Episode.stillPath`.

### 2. `/watch/[mediaId]/+page.server.ts`

Add `next: getNextEpisode(params.mediaId)` to the returned data (only meaningful for
episodes; null otherwise).

### 3. `watch/[mediaId]/+page.svelte`

Pass `next={data.next}` into `<Player>`.

### 4. `Player.svelte`

- New prop `next?: NextEpisode | null`.
- Add `onended={handleEnded}` to the `<video>`.
- New state: `showUpNext`, `countdown` (seconds), an interval handle.
- `handleEnded()`: if `next` is set, report final progress, then show the Up-next
  overlay and start a 10→0 s countdown (1 s interval). At 0, navigate.
- Navigation: `goto(resolve('/watch/[mediaId]', { mediaId: next.mediaId }))` from
  `$app/navigation`. Same-route param change re-runs the load, so the Player picks up
  the new media without a full reload.
- **Play now** button: cancel timer, navigate immediately.
- **Cancel** button: cancel timer, hide overlay (leaves the ended video paused on
  its last frame; controls stay visible since `playing` is false).
- Clear the interval in `onDestroy` and whenever the overlay hides.
- Poster thumbnail: TMDB still via the existing image URL helper (`$lib/tmdb`) if the
  Player can use it client-side; otherwise render title-only. (Check `tmdb.ts`.)

Overlay styling: bottom-right card, matches the control-bar visual language
(dark translucent, accent button for Play now). Auto-hide logic untouched — the
overlay is its own layer, always visible while counting down.

### TV mode

The Up-next card's buttons must be spatial-nav reachable (they're real `<button>`s,
so the global spatial-nav action picks them up). Default focus lands on **Play now**
so Enter confirms.

## Out of scope (ask before adding)

- Per-profile "autoplay next episode" on/off preference.
- "Skip intro" / credits detection.
- Binge counter ("Are you still watching?").

## Test

- Manual: play a non-last episode to the end → card appears, counts down, advances.
- Last episode of last season → no card.
- Next episode still converting → no card.
- Movie → no card.
