import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import { getPlayable, getNextEpisode, isPlayReady } from '$lib/server/catalog';
import { getProgress } from '$lib/server/progress';
import { getSubtitlePref } from '$lib/server/subtitlePrefs';

export const load: PageServerLoad = ({ locals, params }) => {
	const profile = locals.auth.profileId ? getProfile(locals.auth.profileId) : null;
	if (!profile) redirect(303, '/profiles');

	const media = getPlayable(params.mediaId);
	if (!media) error(404, 'Not found');

	const progress = getProgress(profile.id, media.mediaId);

	// `media` already carries videoCodec/embeddedSubtitles/variants/conversionState (catalog.ts's
	// PlayableMedia) — nothing extra to fetch for Player here. `ready` gates whether the page
	// shows the player at all or a conversion-status message (phase-5-media-pipeline.md "UI
	// status") — a direct /watch link to a still-converting title shouldn't hand the browser a
	// possibly-original, not-yet-compatible file.
	return {
		profile,
		media,
		ready: isPlayReady(media.conversionState),
		// Null for movies, the last episode, or a successor that isn't play-ready — the player
		// only shows its "Up next" autoplay card when this is set.
		next: getNextEpisode(params.mediaId),
		startAt: progress?.positionSeconds ?? 0,
		subtitlePref: getSubtitlePref(profile.id)
	};
};
