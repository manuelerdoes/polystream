// Server-only TMDB v3 client (native fetch, no package — plan.md §1). The API key never
// reaches the client: this module is only ever imported from other `$lib/server/*` files.
// Misses (no search result, network hiccup) resolve to `null` rather than throwing, so a
// scan never aborts over one unmatched title — the UI just shows a placeholder tile.

import { config } from '$lib/server/config';

const TMDB_BASE = 'https://api.themoviedb.org/3';

export interface TmdbMatch {
	tmdbId: number;
	name: string;
	overview: string | null;
	posterPath: string | null;
	backdropPath: string | null;
	/** first_air_date for shows, release_date for movies — same field, same meaning ("year"). */
	firstAirDate: string | null;
}

export interface TmdbEpisode {
	name: string | null;
	overview: string | null;
	stillPath: string | null;
	airDate: string | null;
	runtime: number | null;
}

interface TmdbSearchItem {
	id: number;
	name?: string;
	title?: string;
	overview?: string | null;
	poster_path?: string | null;
	backdrop_path?: string | null;
	first_air_date?: string | null;
	release_date?: string | null;
}

interface TmdbSearchResponse {
	results: TmdbSearchItem[];
}

interface TmdbEpisodeResponse {
	name?: string | null;
	overview?: string | null;
	still_path?: string | null;
	air_date?: string | null;
	runtime?: number | null;
}

// Only warn once per process about a likely v3/v4 key mix-up, not once per failed request.
let warnedAboutAuth = false;

async function tmdbGet<T>(
	path: string,
	params: Record<string, string | number | undefined>
): Promise<T | null> {
	const url = new URL(TMDB_BASE + path);
	url.searchParams.set('api_key', config.tmdbApiKey);
	url.searchParams.set('language', 'en-US');
	for (const [key, value] of Object.entries(params)) {
		if (value !== undefined && value !== '') url.searchParams.set(key, String(value));
	}

	let response: Response;
	try {
		response = await fetch(url);
	} catch (err) {
		console.warn(`[tmdb] request errored: ${path}`, err);
		return null;
	}

	if (response.status === 401) {
		if (!warnedAboutAuth) {
			console.warn(
				'[tmdb] got 401 Unauthorized. TMDB_API_KEY is being sent as a v3 "api_key" query ' +
					'param — if this key is actually a v4 read access token, TMDB expects it as ' +
					'"Authorization: Bearer <token>" instead. Check the key type at ' +
					'https://www.themoviedb.org/settings/api.'
			);
			warnedAboutAuth = true;
		}
		return null;
	}

	if (!response.ok) {
		console.warn(`[tmdb] request failed: ${response.status} ${path}`);
		return null;
	}

	return (await response.json()) as T;
}

function bestMatch(results: TmdbSearchItem[] | undefined): TmdbSearchItem | null {
	return results?.[0] ?? null;
}

export async function searchShow(title: string, year?: number): Promise<TmdbMatch | null> {
	const data = await tmdbGet<TmdbSearchResponse>('/search/tv', {
		query: title,
		first_air_date_year: year
	});
	const match = bestMatch(data?.results);
	if (!match) return null;

	return {
		tmdbId: match.id,
		name: match.name ?? title,
		overview: match.overview ?? null,
		posterPath: match.poster_path ?? null,
		backdropPath: match.backdrop_path ?? null,
		firstAirDate: match.first_air_date ?? null
	};
}

export async function searchMovie(title: string, year?: number): Promise<TmdbMatch | null> {
	const data = await tmdbGet<TmdbSearchResponse>('/search/movie', { query: title, year });
	const match = bestMatch(data?.results);
	if (!match) return null;

	return {
		tmdbId: match.id,
		name: match.title ?? title,
		overview: match.overview ?? null,
		posterPath: match.poster_path ?? null,
		backdropPath: match.backdrop_path ?? null,
		firstAirDate: match.release_date ?? null
	};
}

export async function getEpisode(
	tmdbId: number,
	season: number,
	episode: number
): Promise<TmdbEpisode | null> {
	const data = await tmdbGet<TmdbEpisodeResponse>(
		`/tv/${tmdbId}/season/${season}/episode/${episode}`,
		{}
	);
	if (!data) return null;

	return {
		name: data.name ?? null,
		overview: data.overview ?? null,
		stillPath: data.still_path ?? null,
		airDate: data.air_date ?? null,
		runtime: data.runtime ?? null
	};
}
