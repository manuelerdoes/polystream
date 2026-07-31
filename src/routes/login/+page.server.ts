import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import {
	checkPassword,
	isThrottled,
	registerFailure,
	registerSuccess,
	safeRedirectTarget,
	setSession
} from '$lib/server/auth';

// Load: if already fully authenticated, there's nothing to do here — bounce onward.
export const load: PageServerLoad = ({ locals, url }) => {
	if (locals.auth.authenticated) {
		const target = safeRedirectTarget(url.searchParams.get('redirectTo'));
		redirect(303, locals.auth.profileId ? target : '/profiles');
	}
};

export const actions: Actions = {
	default: async ({ request, cookies, getClientAddress, url }) => {
		const ip = getClientAddress();

		if (isThrottled(ip)) {
			return fail(429, { error: 'Too many attempts. Please wait a moment and try again.' });
		}

		const formData = await request.formData();
		const password = String(formData.get('password') ?? '');

		if (!password || !checkPassword(password)) {
			registerFailure(ip);
			// Deliberately generic — never reveal whether the password was "close" or malformed.
			return fail(400, { error: 'Incorrect password.' });
		}

		registerSuccess(ip);
		setSession(cookies, { v: 1, auth: true });

		// No profile is selected yet, so the guard will route through /profiles regardless;
		// sanitize anyway to avoid ever emitting an attacker-controlled Location.
		redirect(303, safeRedirectTarget(url.searchParams.get('redirectTo')));
	}
};
