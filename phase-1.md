# Phase 1 — Auth, Profiles, App Shell

Detailed build plan for Phase 1 (see `plan.md` §11). Scope: shared-password login →
session cookie, "who's watching?" profile picker, and the base app shell with
mouse + TV-remote (D-pad) friendly focus handling.

Out of scope (later phases): any library/WebDAV/TMDB/playback logic. The home screen
is a placeholder shell.

---

## 1. Auth model

- **Single shared password** from `config.appSharedPassword`.
- **Stateless signed session cookie** (no sessions table): cookie value is a small JSON
  payload `{ v, auth: true, profileId?: string }`, HMAC-SHA256 signed with
  `config.sessionSecret`. Format `base64url(payload).base64url(sig)`.
  - Rationale: fits a weak VPS (no DB round-trip per request), trivially revocable by
    rotating `SESSION_SECRET`, and profile selection just re-issues the cookie.
- Cookie flags: `httpOnly`, `sameSite: 'lax'`, `path: '/'`, `secure` in production,
  `maxAge` ~30 days.
- **Password check** uses `crypto.timingSafeEqual` (constant-time) to avoid timing leaks.
- **Login throttle**: lightweight in-memory failed-attempt counter keyed by client IP
  (e.g. 5 tries → 30s cooldown). In-memory is fine for 1–2 viewers / single process.

## 2. Server modules (`src/lib/server/`)

- `auth.ts`
  - `signSession(payload)` / `verifySession(cookie)` — HMAC sign/verify.
  - `checkPassword(input)` — constant-time compare against shared password.
  - `readSession(cookies)` / `setSession(cookies, payload)` / `clearSession(cookies)`.
  - `SESSION_COOKIE` name constant.
  - Simple in-memory `loginThrottle` helper.
- `profiles.ts` — DB CRUD (uses `getDb()`):
  - `listProfiles()`, `getProfile(id)`, `createProfile(name, avatar)`,
    `renameProfile(id, name)`, `setAvatar(id, avatar)`, `deleteProfile(id)`.
  - `id` = `crypto.randomUUID()`. `avatar` stores a preset key (see §5).

## 3. `hooks.server.ts`

- On every request: `event.locals.auth = verifySession(cookie)` → `{ authenticated,
profileId }` (or unauthenticated).
- Route guard:
  - Public: `/login` (+ its form action), static assets.
  - Authenticated but **no profile** → redirect to `/profiles` (except when already on
    `/profiles` or `/logout`).
  - Unauthenticated → redirect to `/login` (preserving intended path via `?redirectTo`).

## 4. Routes

- `/login` — `+page.svelte` (password form) + `+page.server.ts` form action.
  - Wrong password → re-render with error (no info leak), respect throttle.
  - Success → set auth cookie → redirect to `/profiles` (or `redirectTo`).
- `/profiles` — "Who's watching?" picker.
  - `+page.server.ts` `load` → `listProfiles()`.
  - Form actions: `select`, `create`, `rename`, `delete`.
  - `select` writes `profileId` into the cookie → redirect to `/`.
  - Empty state (no profiles yet) → prompt to create the first one.
- `/logout` — `+page.server.ts` action (or `+server.ts`) clears cookie → `/login`.
- `/` — protected home shell placeholder ("Continue watching / library coming in Phase 2"),
  shows the active profile.

## 5. Profile avatars

- Preset **colored monograms**: `avatar` column stores a preset key like `"c3"` mapping to
  one of ~8 fixed background colors; the glyph is the profile name's first letter.
  - No uploads (respects the small-storage constraint), no external assets, TV-safe.
  - A small emoji option can be layered on later if wanted.

## 6. App shell / layout

- `src/routes/+layout.svelte` — global styles, dark theme baseline, font, CSS custom
  properties for the design tokens (colors, focus ring, spacing).
- An **AppHeader** component (shown only when authenticated + profile selected): app name,
  active profile monogram, "Switch profile", "Log out".
- `/login` and `/profiles` render without the main header (own centered layout).

## 7. TV / D-pad focus handling

- Native focus-driven: everything interactive is a real focusable element (`<button>`,
  `<a>`), so Tab + Enter already work.
- Add a lightweight **spatial navigation** action (`src/lib/actions/spatialNav.ts` or a
  small module) handling Arrow keys → move focus to the nearest focusable element in that
  direction (geometry-based), plus Enter/OK activation and Back/Escape handling.
  - Hand-rolled (no dependency); keep it small and Svelte-idiomatic (a Svelte `action`).
- Visible **focus ring** via `:focus-visible` and a strong outline token, so the focused
  item is always obvious on a TV across the room.
- Test with keyboard arrows as a proxy for a remote D-pad.

## 8. Types

- `src/app.d.ts` → declare `App.Locals.auth` shape and `App.PageData` bits as needed.

## 9. Acceptance checks

- `npm run lint`, `npm run check`, `npm run build` all clean.
- Manual: visiting `/` unauthenticated → `/login`; wrong password rejected; correct
  password → `/profiles`; create + select a profile → `/`; header shows profile; switch
  profile returns to picker; logout clears session → `/login`.
- Keyboard-only: can navigate login, profile picker, and header entirely with
  Tab/Arrows/Enter, with a clearly visible focus ring.

## 10. Notes / decisions to confirm

- Session strategy: **stateless signed cookie** (recommended) vs sessions table.
- Avatars: **preset colored monograms** (recommended) vs emoji vs uploads.
- Spatial nav: **hand-rolled Svelte action** (recommended) vs a library.
</content>
