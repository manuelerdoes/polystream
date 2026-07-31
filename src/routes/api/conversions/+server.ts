// Status surface for the conversion worker (phase-5-media-pipeline.md): lets the UI show
// per-title "Converting… X%" / "Queued" / "Conversion failed" indicators without touching
// SQLite directly. Auth is already enforced by hooks.server.ts (/api isn't in PUBLIC_PATHS).
// Rendering this is Stage 2's job — this endpoint just exposes the data.

import type { RequestHandler } from './$types';
import { listConversionJobs } from '$lib/server/catalog';

export const GET: RequestHandler = () => {
	return new Response(JSON.stringify(listConversionJobs()), {
		headers: { 'Content-Type': 'application/json' }
	});
};
