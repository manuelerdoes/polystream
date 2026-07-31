// Converts a media item's external .srt subtitle (already recorded on catalog.subtitles at
// scan time, phase-2.md §3) to WebVTT on the fly. Cheap enough per-request that a persistent
// cache isn't worth it (phase-3.md §0).

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlayable } from '$lib/server/catalog';
import { streamFile } from '$lib/server/webdav';
import { srtToVtt } from '$lib/server/subtitles';

export const GET: RequestHandler = async ({ params }) => {
	const media = getPlayable(params.mediaId);
	if (!media) error(404, 'Not found');

	const sub = media.subtitles.find((s) => s.lang === params.lang);
	if (!sub) error(404, 'Subtitle not found');

	const upstream = await streamFile(sub.path);
	if (upstream.status >= 400 || !upstream.body) {
		error(upstream.status === 404 ? 404 : 502, 'Failed to fetch subtitle');
	}

	// `Response#text()` decodes as UTF-8 by default, tolerating (not stripping) a leading BOM —
	// srtToVtt strips it explicitly.
	const srt = await new Response(upstream.body).text();

	return new Response(srtToVtt(srt), {
		headers: { 'Content-Type': 'text/vtt; charset=utf-8' }
	});
};
