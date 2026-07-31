# Continue Watching — group by series, resume like Netflix

## Problem

"Continue Watching" lists **every** episode of a series you've started. It should list
each **series once**, and clicking it should jump straight into the last-watched episode,
resuming at the saved position (Netflix behaviour). Movies stay as one card each.

Secondary: today the episode card links to `/shows/[id]` using the _episode's_ media_id as
the show id (wrong target, and it doesn't resume playback).

## Design

### `continueWatching(profileId)` — `src/lib/server/catalog.ts`

Group progress rows by their **series** (movies group by themselves). Keep only the most
recently updated item per group.

- Resolve each episode's show via two self-joins on `catalog`:
  `episode.parent_id → season.media_id`, `season.parent_id → show.media_id`.
- `group_id = COALESCE(show.media_id, episode media_id)` — the card's identity/key.
- Window `ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY updated_at DESC)`, keep `rn = 1`.
- Join `metadata` on `group_id` so episodes display the **show's** poster/name/year, movies
  their own.
- Keep the existing "hide ≥95% watched" filter (applied before ranking, so a finished
  episode drops out and the next-most-recent unfinished one of that show surfaces).

`ContinueWatchingItem` fields:

- `mediaId` = `group_id` (show for episodes, movie for movies) — unique per card, used as
  the `{#each}` key and display identity.
- `resumeMediaId` = the actual playable episode/movie media_id — the `/watch` link target.
- `title/year/overview/posterPath` = the show's (episodes) or movie's.
- `mediaType`, `positionSeconds`, `durationSeconds` unchanged.

### Home page — `src/routes/+page.svelte`

Continue Watching `hrefFor` → `resolve('/watch/[mediaId]', { mediaId: item.resumeMediaId })`
for both movies and episodes. `/watch` already loads `startAt` from `progress`, so it
resumes automatically.

## Verify

- `npm run check` + `npm run lint` clean.
- Manual: start 3 episodes of one show → one card; click → resumes last episode at position.
