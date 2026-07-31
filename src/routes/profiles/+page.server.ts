import { fail, redirect } from '@sveltejs/kit';
import type { Actions, PageServerLoad } from './$types';
import { setSession } from '$lib/server/auth';
import { pickAvatarForIndex } from '$lib/avatars';
import {
	createProfile,
	deleteProfile,
	getProfile,
	listProfiles,
	renameProfile,
	setProfileAdvanced
} from '$lib/server/profiles';

export const load: PageServerLoad = () => {
	return { profiles: listProfiles() };
};

export const actions: Actions = {
	select: async ({ request, cookies }) => {
		const formData = await request.formData();
		const id = String(formData.get('id') ?? '');

		const profile = getProfile(id);
		if (!profile) return fail(400, { error: 'Profile not found.' });

		setSession(cookies, { v: 1, auth: true, profileId: profile.id });
		redirect(303, '/');
	},

	create: async ({ request }) => {
		const formData = await request.formData();
		const name = String(formData.get('name') ?? '').trim();
		const advanced = formData.get('advanced') != null;

		if (!name) return fail(400, { error: 'Please enter a name.' });

		const existingCount = listProfiles().length;
		try {
			createProfile(name, pickAvatarForIndex(existingCount), advanced);
		} catch {
			return fail(400, { error: 'Please enter a valid name.' });
		}

		return { success: true };
	},

	rename: async ({ request }) => {
		const formData = await request.formData();
		const id = String(formData.get('id') ?? '');
		const name = String(formData.get('name') ?? '').trim();

		if (!name) return fail(400, { error: 'Please enter a name.' });

		try {
			const updated = renameProfile(id, name);
			if (!updated) return fail(400, { error: 'Profile not found.' });
		} catch {
			return fail(400, { error: 'Please enter a valid name.' });
		}

		return { success: true };
	},

	setAdvanced: async ({ request }) => {
		const formData = await request.formData();
		const id = String(formData.get('id') ?? '');
		const advanced = formData.get('advanced') != null;

		const updated = setProfileAdvanced(id, advanced);
		if (!updated) return fail(400, { error: 'Profile not found.' });

		return { success: true };
	},

	delete: async ({ request, cookies, locals }) => {
		const formData = await request.formData();
		const id = String(formData.get('id') ?? '');

		deleteProfile(id);

		// If the deleted profile was the active one, drop it from the session too.
		if (locals.auth.profileId === id) {
			setSession(cookies, { v: 1, auth: true });
		}

		return { success: true };
	}
};
