import { redirect } from '@sveltejs/kit';
import type { PageServerLoad } from './$types';
import { getProfile } from '$lib/server/profiles';
import { listShows } from '$lib/server/catalog';

export const load: PageServerLoad = ({ locals }) => {
	const profile = locals.auth.profileId ? getProfile(locals.auth.profileId) : null;
	if (!profile) redirect(303, '/profiles');

	return { profile, shows: listShows() };
};
