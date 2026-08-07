import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import {
	getMovie,
	getPlayable,
	type ConversionJobInfo,
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

	const movie = getMovie(params.id);
	if (!movie) error(404, 'Movie not found');

	// The playable row also carries the conversion status + variants — fetched unconditionally
	// (not just behind ?play) so the detail page can show a "Converting…"/"Queued" badge beside
	// the Play link. It never gates Play (see catalog.ts).
	const media = getPlayable(params.id);
	const conversionState: ConversionJobInfo | null = media?.conversionState ?? null;
	// Threaded to the "Generate H.264 version" button (advanced profiles only, HEVC-only,
	// no-existing-variant — see GenerateFallbackButton.svelte / phase-5 amendment).
	const primaryVideoCodec = media?.variants?.primary.videoCodec ?? media?.videoCodec ?? null;
	const hasH264Variant = media?.variants?.h264 != null;
	// Threaded to the "Downmix audio to stereo" button (advanced profiles only, multichannel-audio
	// only — see DownmixAudioButton.svelte).
	const audioIsMultichannel = media?.audioIsMultichannel ?? false;

	// ?play reveals the inline player in place of the poster (desktop mode — see phase-3.md §7).
	let player: InlinePlayerData | null = null;
	if (url.searchParams.has('play') && media) {
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

	return {
		profile,
		movie,
		conversionState,
		player,
		primaryVideoCodec,
		hasH264Variant,
		audioIsMultichannel
	};
};
