# TV-remote / D-pad navigation fix

## Problem

The app is meant to be usable with a TV remote (arrows + OK only — no pointer, no Tab).
Today only in-player seeking responds to arrows; browsing does not.

Root cause (two structural issues):

1. **No initial focus.** The `spatialNav` action only reacts when focus is _already inside_
   its container (`node.contains(document.activeElement)`). On any page load / client-side
   navigation `document.activeElement` is `<body>`, and a remote has no way to place that
   first focus. So arrows are ignored everywhere outside the player (where focus arrives via
   the click/activation that started playback).
2. **Isolated islands.** Each `use:spatialNav` container only moves focus among its _own_
   descendants. `AppHeader` has none at all, and the home page has three separate `MediaRow`
   islands — so focus can't cross between header, rows, grids, or detail controls.

## Decision (confirmed with user)

- **Global controller + autofocus.** One document-level spatial-nav manager, mounted once in
  `+layout.svelte`, reusing the existing geometry (`findNearest`). Remove the per-container
  islands.
- **Autofocus target:** first focusable element inside the page's `<main>`, seeded after each
  navigation. Header reachable by pressing Up.

## Implementation

### `src/lib/actions/spatialNav.ts` — rewrite to a global controller

- Keep the geometry (`findNearest`, `Rect`, scoring) unchanged.
- `getCandidates` now scans the whole `document` (all visible focusable elements), not one
  container. Visibility test switches from `offsetParent !== null` to a non-zero
  `getBoundingClientRect()` so `position: fixed` elements (fullscreen player, watch page) are
  still reachable.
- Export `installGlobalSpatialNav(): () => void` — attaches one `keydown` listener on
  `document`, returns a cleanup fn.
- Export `focusFirstInMain(): void` — focuses the first focusable inside `<main>`.
- Handler guards (in order):
  1. not an arrow key → ignore.
  2. `event.defaultPrevented` → ignore. Lets closer handlers win: the player root's
     seek/volume arrows call `preventDefault()`, so the global controller stands down while
     the video/player-root is focused.
  3. focus is in a form field (`input`/`textarea`/`select`/contenteditable) → ignore, so
     native behavior runs (typing, the volume `range` slider, native selects).
  4. no focus / focus on `<body>` → seed focus to the first focusable (fallback for the rare
     case autofocus didn't run).
  5. otherwise move focus to the nearest focusable in the arrow direction + `scrollIntoView`.

The player's seek bar already `stopPropagation`s its arrows, so the document listener never
sees them.

### `src/routes/+layout.svelte`

- `$effect(() => installGlobalSpatialNav())` — install once, auto-cleanup.
- `afterNavigate(() => requestAnimationFrame(() => focusFirstInMain()))` — seed focus on the
  initial load and every client-side navigation, one frame later so the new page is laid out.
- `focusFirstInMain` skips if something is already focused (respects existing `autofocus`
  inputs on login / profile create/rename) and skips pages with no `<main>` (the fullscreen
  `/watch` player manages its own focus).

### Remove the now-redundant per-container islands (`use:spatialNav` + import)

- `PosterGrid.svelte`, `MediaRow.svelte`, `EpisodeList.svelte`
- `routes/shows/[id]/+page.svelte` (seasons nav)
- `routes/mode/+page.svelte`, `routes/profiles/+page.svelte`
- `Player.svelte` — drop `use:spatialNav`; keep `handleRootKeydown` (its `preventDefault` is
  what makes the global controller stand down during playback). Update the now-stale comments.

## Verify

- `npm run lint` + `npm run check` clean (no unused imports).
- Manual: from a fresh load, arrows alone move a visible focus ring across header ↔ rows ↔
  grids ↔ detail controls; OK activates; in-player seek/volume still work.
