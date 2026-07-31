// Range-proxy: streams the original file bytes from WebDAV straight through to the <video>
// element. Never buffers the whole file in memory — critical on the weak VPS (phase-3.md §4,
// plan.md §13). Auth is already enforced by hooks.server.ts (/stream isn't in PUBLIC_PATHS).

import { error } from '@sveltejs/kit';
import type { RequestHandler } from './$types';
import { getPlayable } from '$lib/server/catalog';
import { streamFile } from '$lib/server/webdav';

const CONTENT_TYPES: Record<string, string> = {
	mp4: 'video/mp4',
	mkv: 'video/x-matroska',
	avi: 'video/x-msvideo'
};

function contentTypeFor(path: string): string {
	const ext = path.split('.').pop()?.toLowerCase() ?? '';
	return CONTENT_TYPES[ext] ?? 'application/octet-stream';
}

async function proxy(
	mediaId: string,
	range: string | null,
	method: 'GET' | 'HEAD',
	variant: 'primary' | 'h264'
) {
	const media = getPlayable(mediaId);
	if (!media) error(404, 'Not found');

	// Primary's path is always `catalog.path` (kept in sync by the scanner/conversion worker —
	// phase-5-media-pipeline.md), so only the h264 fallback needs a real variants lookup. A
	// `?v=h264` request for a media with no fallback (yet, or ever) is a clean 404 rather than
	// silently falling back to the primary — the client only sends `?v=h264` when it already
	// knows the fallback exists (capabilities.ts's pickVariant).
	const path = variant === 'h264' ? (media.variants?.h264?.path ?? null) : media.path;
	if (path === null) error(404, 'Variant not available');

	const upstream = await streamFile(path, { range, method });

	// Map upstream failures to a clean status rather than leaking WebDAV's own error body.
	if (upstream.status >= 400) {
		error(upstream.status === 404 ? 404 : 502, 'Failed to stream file');
	}

	const headers = new Headers();
	headers.set('Content-Type', contentTypeFor(path));
	headers.set('Accept-Ranges', 'bytes');

	const contentRange = upstream.headers.get('content-range');
	if (contentRange) headers.set('Content-Range', contentRange);
	const contentLength = upstream.headers.get('content-length');
	if (contentLength) headers.set('Content-Length', contentLength);

	// Pass status through verbatim: 200 for a full read, 206 for a satisfied Range request.
	return new Response(method === 'HEAD' ? null : upstream.body, {
		status: upstream.status,
		headers
	});
}

function variantOf(url: URL): 'primary' | 'h264' {
	return url.searchParams.get('v') === 'h264' ? 'h264' : 'primary';
}

export const GET: RequestHandler = ({ params, request, url }) => {
	return proxy(params.mediaId, request.headers.get('range'), 'GET', variantOf(url));
};

export const HEAD: RequestHandler = ({ params, request, url }) => {
	return proxy(params.mediaId, request.headers.get('range'), 'HEAD', variantOf(url));
};
