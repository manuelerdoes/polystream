// Manual "Downmix audio to stereo" endpoint (advanced-profile button, mirrors /api/fallback).
// The scanner's auto-remux only fires for a container mismatch or an UNDEFINED audio layout
// (see scanner.ts's classifyConversion) — a file with a DEFINED multichannel layout (e.g. "5.1")
// is left alone even though some browsers (Firefox) can't play multichannel AAC. This endpoint
// lets an advanced user force the same remux job (which already downmixes with `-ac 2`) on
// demand. Auth is already enforced by hooks.server.ts (/api isn't in PUBLIC_PATHS); this endpoint
// additionally requires the caller's profile to be `advanced`.

import type { RequestHandler } from './$types';
import { getPlayable } from '$lib/server/catalog';
import { getProfile } from '$lib/server/profiles';
import { requestRemux } from '$lib/server/convert';

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

	// H.264 only: downmixing an HEVC primary's audio doesn't change its Firefox playability, so
	// the button isn't offered on HEVC titles (see DownmixAudioButton.svelte) — reject it here too.
	const primaryCodec = media.variants?.primary.videoCodec ?? media.videoCodec;
	if (primaryCodec !== 'h264') {
		return new Response(JSON.stringify({ error: 'Downmix only applies to H.264 titles.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Only makes sense when there's actually a multichannel layout to fold down — re-requesting
	// this for an already-stereo/mono (or unprobed) file would be pointless work.
	if (!media.audioIsMultichannel) {
		return new Response(JSON.stringify({ error: 'Audio is not multichannel.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	// Refuse a second request while one's already queued/running — conversion_jobs has a single
	// row per media_id, so a duplicate POST would otherwise just re-queue (harmless, but pointless
	// and confusing progress-wise).
	const inFlight =
		media.conversionState != null &&
		(media.conversionState.state === 'queued' || media.conversionState.state === 'running');
	if (inFlight) {
		return new Response(JSON.stringify({ error: 'A conversion is already in progress.' }), {
			status: 400,
			headers: { 'Content-Type': 'application/json' }
		});
	}

	requestRemux(mediaId);
	return new Response(null, { status: 202 });
};
