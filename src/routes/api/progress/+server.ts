// Player progress reporting (throttled timeupdate + pause + sendBeacon on unload). Reads the
// body as text rather than via request.json() so it tolerates sendBeacon's Blob payload,
// which may not carry an application/json Content-Type in every browser.

import type { RequestHandler } from './$types';
import { saveProgress } from '$lib/server/progress';

export const POST: RequestHandler = async ({ request, locals }) => {
	const profileId = locals.auth.profileId;
	if (!profileId) return new Response(null, { status: 401 });

	let body: unknown;
	try {
		body = JSON.parse(await request.text());
	} catch {
		return new Response(null, { status: 400 });
	}

	if (typeof body !== 'object' || body === null) return new Response(null, { status: 400 });
	const { mediaId, position, duration } = body as Record<string, unknown>;

	if (typeof mediaId !== 'string' || !mediaId) return new Response(null, { status: 400 });
	if (typeof position !== 'number' || !Number.isFinite(position) || position < 0) {
		return new Response(null, { status: 400 });
	}
	const safeDuration = typeof duration === 'number' && Number.isFinite(duration) ? duration : null;

	saveProgress(profileId, mediaId, position, safeDuration);
	return new Response(null, { status: 204 });
};
