// Client-safe TMDB image helpers — no API key here (image.tmdb.org paths are public and
// don't require auth), so this module can be imported from Svelte components/pages.

export const TMDB_POSTER_SIZE = 'w342';
export const TMDB_BACKDROP_SIZE = 'w1280';
export const TMDB_STILL_SIZE = 'w300';

const TMDB_IMAGE_BASE = 'https://image.tmdb.org/t/p';

/** Builds a full TMDB image URL, or null when there's no path (caller renders a placeholder). */
export function tmdbImage(path: string | null | undefined, size: string): string | null {
	if (!path) return null;
	return `${TMDB_IMAGE_BASE}/${size}${path}`;
}
