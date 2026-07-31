import { redirect } from '@sveltejs/kit';
import type { Actions } from './$types';
import { clearSession } from '$lib/server/auth';

export const actions: Actions = {
	default: ({ cookies }) => {
		clearSession(cookies);
		redirect(303, '/login');
	}
};
