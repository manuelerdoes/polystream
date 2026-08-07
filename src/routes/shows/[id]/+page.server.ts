import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import {
	getPlayable,
	getSeason,
	getShow,
	type EmbeddedSubtitleRef,
	type SubtitleRef
} from '$lib/server/catalog';
import { getProgress } from '$lib/server/progress';
import { getSubtitlePref, type SubtitlePref } from '$lib/server/subtitlePrefs';

interface InlinePlayerData {
	mediaId: string;
	title: string;
	subtitles: SubtitleRef[];
	startAt: number;
	subtitlePref: SubtitlePref;
	primaryVideoCodec: string | null;
	hasH264Variant: boolean;
	embeddedSubtitles: EmbeddedSubtitleRef[];
}

export const load: PageServerLoad = ({ locals, params, url }) => {
	const profile = locals.auth.profileId ? getProfile(locals.auth.profileId) : null;
	if (!profile) redirect(303, '/profiles');

	const show = getShow(params.id);
	if (!show) error(404, 'Show not found');

	// ?season=N picks a season; default to the first available one.
	const requestedSeason = Number(url.searchParams.get('season'));
	const season =
		show.seasons.find((s) => s.season === requestedSeason)?.season ??
		show.seasons[0]?.season ??
		null;

	const episodes = season !== null ? getSeason(show.mediaId, season) : [];

	// ?play=<episodeId> reveals the inline player above the episode list (desktop mode).
	let player: InlinePlayerData | null = null;
	const playId = url.searchParams.get('play');
	if (playId) {
		const media = getPlayable(playId);
		if (media) {
			const progress = getProgress(profile.id, media.mediaId);
			player = {
				mediaId: media.mediaId,
				title: media.title,
				subtitles: media.subtitles,
				startAt: progress?.positionSeconds ?? 0,
				subtitlePref: getSubtitlePref(profile.id),
				primaryVideoCodec: media.variants?.primary.videoCodec ?? media.videoCodec,
				hasH264Variant: media.variants?.h264 != null,
				embeddedSubtitles: media.embeddedSubtitles
			};
		}
	}

	return { profile, show, season, episodes, player };
};
