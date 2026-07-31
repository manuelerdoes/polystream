// Exposes the device mode (desktop/tv) to every page's data without each +page.server.ts
// having to thread it through individually — SvelteKit merges layout load data into PageData.

import type { LayoutServerLoad } from './$types';

export const load: LayoutServerLoad = ({ locals }) => {
	return { mode: locals.auth.mode };
};
