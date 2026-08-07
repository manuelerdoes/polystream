// Status surface for the conversion worker (phase-5-media-pipeline.md): lets the UI show
// per-title "Converting… X%" / "Queued" / "Conversion failed" indicators without touching
// SQLite directly. Auth is already enforced by hooks.server.ts (/api isn't in PUBLIC_PATHS).
// Rendering this is Stage 2's job — this endpoint just exposes the data.

import type { RequestHandler } from './$types';
import { listConversionJobs } from '$lib/server/catalog';
import { clearConversionJob } from '$lib/server/convert';
import { getProfile } from '$lib/server/profiles';

export const GET: RequestHandler = () => {
	return new Response(JSON.stringify(listConversionJobs()), {
		headers: { 'Content-Type': 'application/json' }
	});
};

/**
 * Dismisses a settled job (`{ mediaId }`), so a failure the user has read stops being reported
 * forever — see convert.ts's clearConversionJob for what may be cleared. Advanced profiles only,
 * mirroring /api/fallback and /api/downmix: those buttons are the only place a job gets created
 * by hand, and this is their undo.
 */
export const DELETE: RequestHandler = async ({ request, locals }) => {
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

	// A no-op (nothing to clear, or the job is still in flight) is not an error — the caller's
	// intent, "stop showing me this", holds either way.
	clearConversionJob(mediaId);
	return new Response(null, { status: 204 });
};
