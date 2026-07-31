import { error, redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import {
	getMovie,
	getPlayable,
	isPlayReady,
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
	// (not just behind ?play) so the detail page can show "Converting…"/"Queued"/"failed" instead
	// of a Play link while the file isn't direct-playable yet (phase-5-media-pipeline.md "UI
	// status").
	const media = getPlayable(params.id);
	const conversionState: ConversionJobInfo | null = media?.conversionState ?? null;
	const ready = isPlayReady(conversionState);
	// Threaded to the "Generate H.264 version" button (advanced profiles only, HEVC-only,
	// no-existing-variant — see GenerateFallbackButton.svelte / phase-5 amendment).
	const primaryVideoCodec = media?.variants?.primary.videoCodec ?? media?.videoCodec ?? null;
	const hasH264Variant = media?.variants?.h264 != null;
	// Threaded to the "Downmix audio to stereo" button (advanced profiles only, multichannel-audio
	// only — see DownmixAudioButton.svelte).
	const audioIsMultichannel = media?.audioIsMultichannel ?? false;

	// ?play reveals the inline player in place of the poster (desktop mode — see phase-3.md §7).
	// Only built once the media is actually ready to play — a stale/forged ?play on a converting
	// title should fall back to the status badge, not a broken player.
	let player: InlinePlayerData | null = null;
	if (url.searchParams.has('play') && ready && media) {
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
		ready,
		player,
		primaryVideoCodec,
		hasH264Variant,
		audioIsMultichannel
	};
};
