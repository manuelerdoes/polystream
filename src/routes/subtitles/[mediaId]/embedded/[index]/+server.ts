// Extracts one embedded (in-container) subtitle track to WebVTT on demand (phase-4.md §5),
// sibling to /subtitles/[mediaId]/[lang] which handles external .srt files. Streamed straight
// from ffmpeg's stdout — never buffered — and the ffmpeg child is killed if the response is
// cancelled (see extractEmbeddedVtt in ffmpeg.ts).

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlayable } from '$lib/server/catalog';
import { extractEmbeddedVtt } from '$lib/server/ffmpeg';

export const GET: RequestHandler = ({ params }) => {
	const media = getPlayable(params.mediaId);
	if (!media) error(404, 'Not found');

	const index = Number.parseInt(params.index, 10);
	const track = media.embeddedSubtitles.find((t) => t.index === index);
	if (!track) error(404, 'Subtitle track not found');
	if (!track.text) error(404, 'Subtitle track is not text-based (cannot convert to WebVTT)');

	const body = extractEmbeddedVtt(media.path, index);

	return new Response(body, {
		headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
	});
};
