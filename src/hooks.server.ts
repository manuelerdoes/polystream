// Populates `event.locals.auth` from the signed session cookie on every request, and
// enforces the auth/profile route guard described in phase-1.md §3.

import { redirect, type Handle } from '@sveltejs/kit';
import { readSession } from '$lib/server/auth';
import { kickConversionQueue } from '$lib/server/convert';

// Paths reachable without a session at all.
const PUBLIC_PATHS = new Set(['/login']);
// Paths reachable once authenticated even without a profile selected yet.
const NO_PROFILE_PATHS = new Set(['/profiles', '/logout']);
// Paths reachable once authenticated + profiled even without a device mode chosen yet.
const NO_MODE_PATHS = new Set(['/mode', '/profiles', '/logout']);

export const handle: Handle = async ({ event, resolve }) => {
	// Cheap after the first call (see convert.ts's initOnce) — guarantees the conversion
	// queue's boot-time recovery (re-queuing any job interrupted by a restart) actually runs,
	// even if the catalog is already populated and nobody triggers a manual rescan first.
	kickConversionQueue();

	event.locals.auth = readSession(event.cookies);

	const { pathname } = event.url;

	if (!PUBLIC_PATHS.has(pathname)) {
		if (!event.locals.auth.authenticated) {
			const redirectTo = encodeURIComponent(pathname + event.url.search);
			redirect(303, `/login?redirectTo=${redirectTo}`);
		}

		if (!event.locals.auth.profileId && !NO_PROFILE_PATHS.has(pathname)) {
			redirect(303, '/profiles');
		}

		if (event.locals.auth.profileId && !event.locals.auth.mode && !NO_MODE_PATHS.has(pathname)) {
			redirect(303, '/mode');
		}
	}

	return resolve(event);
};
