// Typed, validated access to environment configuration.
// Sourced from SvelteKit's `$env/dynamic/private` rather than `process.env`: it's read at
// runtime (not inlined at build like `$env/static/private`), so Docker can inject secrets
// per-deploy without baking them into the image, and Vite auto-loads `.env` for it in dev
// (a bare `process.env` read does NOT see `.env` under `vite dev`). We still validate here so
// a single missing/blank var produces one clear startup error instead of a cryptic failure.

import { building } from '$app/environment';
import { env } from '$env/dynamic/private';

interface PolystreamConfig {
	webdavUrl: string;
	webdavUsername: string;
	webdavAppPassword: string;
	webdavMediaRoot: string;
	appSharedPassword: string;
	sessionSecret: string;
	tmdbApiKey: string;
	publicAppUrl: string;
	port: number;
	maxTranscodeJobs: number;
	/** Directory holding the SQLite DB file + on-disk caches. */
	dataDir: string;
}

// Required: the app cannot function without these.
const REQUIRED_KEYS = [
	'WEBDAV_URL',
	'WEBDAV_USERNAME',
	'WEBDAV_APP_PASSWORD',
	'APP_SHARED_PASSWORD',
	'SESSION_SECRET',
	'TMDB_API_KEY'
] as const;

function readConfig(): PolystreamConfig {
	const missing = REQUIRED_KEYS.filter((key) => !env[key] || env[key]?.trim() === '');
	// `building` is true during `vite build`'s static analysis pass, which imports every
	// server module (including this one) before real env is available (dynamic env is empty
	// then). Skip the throw there — the real validation still runs the moment the server boots.
	if (missing.length > 0 && !building) {
		throw new Error(
			`Polystream config error: missing required environment variable(s): ${missing.join(', ')}.\n` +
				`Copy .env.example to .env and fill in the values (see README.md).`
		);
	}

	const toInt = (value: string | undefined, fallback: number) => {
		if (!value) return fallback;
		const n = Number.parseInt(value, 10);
		return Number.isFinite(n) ? n : fallback;
	};

	return {
		// Empty-string fallbacks only matter during the `building` static-analysis pass above;
		// any real request path is guaranteed to have these validated non-empty by then.
		webdavUrl: env.WEBDAV_URL ?? '',
		webdavUsername: env.WEBDAV_USERNAME ?? '',
		webdavAppPassword: env.WEBDAV_APP_PASSWORD ?? '',
		webdavMediaRoot: env.WEBDAV_MEDIA_ROOT ?? '',
		appSharedPassword: env.APP_SHARED_PASSWORD ?? '',
		sessionSecret: env.SESSION_SECRET ?? '',
		tmdbApiKey: env.TMDB_API_KEY ?? '',
		publicAppUrl: env.PUBLIC_APP_URL ?? 'http://localhost:3000',
		port: toInt(env.PORT, 3000),
		maxTranscodeJobs: toInt(env.MAX_TRANSCODE_JOBS, 1),
		dataDir: env.DATA_DIR ?? './data'
	};
}

// Validated once at module load, so any deployment missing config fails fast on boot.
export const config = readConfig();
