import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { safeRedirectTarget, setSession } from '$lib/server/auth';
import { getProfile } from '$lib/server/profiles';

export const load: PageServerLoad = ({ locals }) => {
	const profile = locals.auth.profileId ? getProfile(locals.auth.profileId) : null;
	if (!profile) redirect(303, '/profiles');
	return { profile };
};

export const actions: Actions = {
	select: async ({ request, cookies, locals, url }) => {
		const formData = await request.formData();
		const mode = String(formData.get('mode') ?? '');

		if (mode !== 'desktop' && mode !== 'tv') {
			return fail(400, { error: 'Please pick Desktop or TV.' });
		}

		// Re-sign the cookie, preserving the already-selected profile.
		setSession(cookies, {
			v: 1,
			auth: true,
			profileId: locals.auth.profileId ?? undefined,
			mode
		});

		redirect(303, safeRedirectTarget(url.searchParams.get('redirectTo')));
	}
};
