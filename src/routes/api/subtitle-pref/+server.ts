// Persists the player's subtitle on/off + language choice, so it re-applies on the next play.

import type { RequestHandler } from './$types';
import { saveSubtitlePref } from '$lib/server/subtitlePrefs';

export const POST: RequestHandler = async ({ request, locals }) => {
	const profileId = locals.auth.profileId;
	if (!profileId) return new Response(null, { status: 401 });

	let body: unknown;
	try {
		body = await request.json();
	} catch {
		return new Response(null, { status: 400 });
	}

	if (typeof body !== 'object' || body === null) return new Response(null, { status: 400 });
	const { enabled, language } = body as Record<string, unknown>;

	if (typeof enabled !== 'boolean') return new Response(null, { status: 400 });
	const safeLanguage = typeof language === 'string' && language ? language : null;

	saveSubtitlePref(profileId, enabled, safeLanguage);
	return new Response(null, { status: 204 });
};
