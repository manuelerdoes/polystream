// Manual "Generate H.264 version" endpoint (phase-5-media-pipeline.md amendment 2026-07-30:
// "lazy HEVC fallback, advanced-profile button only"). The HEVC→H.264 re-encode is no longer
// enqueued automatically on scan — it's only ever requested here, from the button that's only
// shown to advanced profiles. Auth is already enforced by hooks.server.ts (/api isn't in
// PUBLIC_PATHS); this endpoint additionally requires the caller's profile to be `advanced`.

import type { RequestHandler } from './$types';
import { getPlayable } from '$lib/server/catalog';
import { getProfile } from '$lib/server/profiles';
import { requestH264Fallback } from '$lib/server/convert';

export const POST: RequestHandler = async ({ request, locals }) => {
	const profileId = locals.auth.profileId;
	if (!profileId) return new Response(null, { status: 401 });

	const profile = getProfile(profileId);
	if (!profile?.advanced) {
		return new Response(JSON.stringify({ error: 'Advanced profile required.' }), {
			status: 403,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	let body: unknown;
	try {
		body = JSON.parse(await request.text());
	} catch {
		return new Response(null, { status: 400 });
	}
	if (typeof body !== 'object' || body === null) return new Response(null, { status: 400 });
	const { mediaId } = body as Record<string, unknown>;
	if (typeof mediaId !== 'string' || !mediaId) return new Response(null, { status: 400 });

	const media = getPlayable(mediaId);
	if (!media) return new Response(null, { status: 400 });

	// Only makes sense for an HEVC primary — H.264 is already universal, and re-requesting a
	// fallback for a non-HEVC title would be pointless work.
	const primaryCodec = media.variants?.primary.videoCodec ?? media.videoCodec;
	if (primaryCodec !== 'hevc') {
		return new Response(JSON.stringify({ error: 'Media is not HEVC.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	if (media.variants?.h264 != null) {
		return new Response(JSON.stringify({ error: 'An H.264 version already exists.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Refuse a second request while one's already queued/running — conversion_jobs has a single
	// row per media_id, so a duplicate POST would otherwise just re-queue (harmless, but pointless
	// and confusing progress-wise).
	const inFlight =
		media.conversionState?.kind === 'h264' &&
		(media.conversionState.state === 'queued' || media.conversionState.state === 'running');
	if (inFlight) {
		return new Response(JSON.stringify({ error: 'A conversion is already in progress.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	requestH264Fallback(mediaId);
	return new Response(null, { status: 202 });
};
