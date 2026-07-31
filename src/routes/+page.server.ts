import { redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import {
	continueWatching,
	getScanState,
	listConversionJobs,
	listMovies,
	listShows
} from '$lib/server/catalog';
import { scan } from '$lib/server/scanner';

// Home page preview rows show a handful of items each; full lists live on /movies, /shows.
const PREVIEW_COUNT = 12;

// hooks.server.ts already guarantees authenticated + profileId set before this load runs,
// but a profile can vanish between requests (e.g. deleted from another tab) — handle that.
export const load: PageServerLoad = async ({ locals }) => {
	const profile = locals.auth.profileId ? getProfile(locals.auth.profileId) : null;

	if (!profile) {
		redirect(303, '/profiles');
	}

	let scanState = getScanState();

	// First-run convenience (phase-2.md §0): if the catalog has never been scanned, scan
	// once automatically so the library isn't permanently empty behind a button nobody
	// knows to press yet. Later scans are manual-only (the Rescan button).
	if (scanState.status === 'idle' && scanState.itemCount === 0) {
		await scan();
		scanState = getScanState();
	}

	return {
		profile,
		scanState,
		movies: listMovies().slice(0, PREVIEW_COUNT),
		shows: listShows().slice(0, PREVIEW_COUNT),
		continueWatching: continueWatching(profile.id),
		conversionJobs: listConversionJobs()
	};
};

export const actions: Actions = {
	rescan: async () => {
		await scan();
		return { success: true };
	}
};
