// Lazy singleton WebDAV client (mirrors the `getDb()` pattern in db/index.ts) so that
// `vite build`'s static-analysis pass — which imports every server module without a real
// .env — never opens a network connection. The client is only touched when a route handler
// actually calls one of these functions, which only happens during scanner.scan().

import { createReadStream } from 'node:fs';
import { stat } from 'node:fs/promises';
import { createClient, type WebDAVClient, type FileStat } from 'webdav';
import { config } from '$lib/server/config';

export interface DavEntry {
	name: string;
	/** Path relative to WEBDAV_URL (the account root), no leading slash. */
	path: string;
	isDir: boolean;
	size: number;
	/** Epoch milliseconds, or null if the server didn't report a parseable lastmod. */
	mtime: number | null;
}

let client: WebDAVClient | undefined;

function getClient(): WebDAVClient {
	if (!client) {
		client = createClient(config.webdavUrl, {
			username: config.webdavUsername,
			password: config.webdavAppPassword
		});
	}
	return client;
}

/** Strips any leading slashes so stored/compared paths are consistently account-relative. */
function normalizePath(path: string): string {
	return path.replace(/^\/+/, '');
}

/** Joins path segments into a single absolute WebDAV path (leading slash, no doubles). */
function joinDavPath(...parts: string[]): string {
	const cleaned = parts
		.flatMap((part) => part.split('/'))
		.map((part) => part.trim())
		.filter(Boolean);
	return '/' + cleaned.join('/');
}

/** Builds the full, percent-encoded URL for a path relative to WEBDAV_URL. */
function toAbsoluteUrl(relPath: string): string {
	const base = config.webdavUrl.endsWith('/') ? config.webdavUrl : `${config.webdavUrl}/`;
	const encoded = normalizePath(relPath).split('/').map(encodeURIComponent).join('/');
	return base + encoded;
}

/**
 * Absolute, percent-encoded URL for a path relative to WEBDAV_URL — for ffmpeg/ffprobe, which
 * take a URL argument directly (unlike streamFile, which does its own authenticated fetch).
 */
export function webdavFileUrl(relPath: string): string {
	return toAbsoluteUrl(relPath);
}

/**
 * `Authorization` header value for WebDAV Basic auth, so ffmpeg/ffprobe can authenticate via
 * `-headers` without embedding credentials in the URL itself.
 */
export function webdavAuthHeader(): string {
	return `Basic ${Buffer.from(`${config.webdavUsername}:${config.webdavAppPassword}`).toString('base64')}`;
}

function toEntry(stat: FileStat): DavEntry {
	const parsed = Date.parse(stat.lastmod);
	return {
		name: stat.basename,
		path: normalizePath(stat.filename),
		isDir: stat.type === 'directory',
		size: stat.size,
		mtime: Number.isNaN(parsed) ? null : parsed
	};
}

/** Root folder containing "movies" and "tv shows", relative to WEBDAV_URL. */
export function mediaRoot(): string {
	return normalizePath(config.webdavMediaRoot);
}

/** Lists the immediate children of `relPath` (relative to WEBDAV_URL, "" for account root). */
export async function listDir(relPath: string): Promise<DavEntry[]> {
	const davPath = joinDavPath(relPath);
	const stats = (await getClient().getDirectoryContents(davPath)) as FileStat[];
	// Some WebDAV servers include the directory itself in the multistatus response; filter
	// it out defensively (we only want children).
	const selfPath = normalizePath(relPath);
	return stats.map(toEntry).filter((entry) => entry.path !== selfPath);
}

/**
 * Recursively lists every descendant (directories and files) under `relPath`. The library
 * is small (a handful of shows/seasons), so a plain recursive walk is simple and cheap —
 * no need for a depth-limited/streaming variant.
 */
export async function walk(relPath: string): Promise<DavEntry[]> {
	const entries = await listDir(relPath);
	const result: DavEntry[] = [...entries];

	for (const entry of entries) {
		if (entry.isDir) {
			result.push(...(await walk(entry.path)));
		}
	}

	return result;
}

/**
 * Streamed PUT of a local file to `relPath` (relative to WEBDAV_URL), for the conversion
 * worker's upload step (phase-5-media-pipeline.md). Uses the `webdav` package's
 * `putFileContents` with a `fs.ReadStream` so a multi-GB video is never buffered into memory.
 * `contentLength` is passed explicitly (a streamed body can't self-report a length) so the
 * server gets a proper `Content-Length` rather than chunked transfer.
 *
 * Callers MUST only call this with a verified local file, and must not delete/replace the
 * WebDAV *source* until this resolves successfully — see convert.ts's ordering.
 */
export async function uploadFile(relPath: string, localFilePath: string): Promise<void> {
	const { size } = await stat(localFilePath);
	const davPath = joinDavPath(relPath);
	const ok = await getClient().putFileContents(davPath, createReadStream(localFilePath), {
		overwrite: true,
		contentLength: size
	});
	if (!ok) throw new Error(`WebDAV upload failed for ${relPath}`);
}

/**
 * Deletes a file at `relPath` (relative to WEBDAV_URL). Only ever called by the conversion
 * worker, and only after the replacement has been uploaded AND verified — never before
 * (phase-5-media-pipeline.md's core safety rule; see convert.ts).
 */
export async function deleteFile(relPath: string): Promise<void> {
	await getClient().deleteFile(joinDavPath(relPath));
}

export interface StreamFileResult {
	status: number;
	headers: Headers;
	/** Raw passthrough stream — never buffer this into memory (a 2GB episode would OOM). */
	body: ReadableStream<Uint8Array> | null;
}

/**
 * Authenticated, range-capable fetch of a single file's raw bytes, for the /stream and
 * /subtitles proxies. Uses native `fetch` (not the `webdav` package) so the response body
 * stays a passthrough `ReadableStream` instead of being buffered into a Buffer.
 */
export async function streamFile(
	relPath: string,
	{ range, method = 'GET' }: { range?: string | null; method?: 'GET' | 'HEAD' } = {}
): Promise<StreamFileResult> {
	const headers: Record<string, string> = { Authorization: webdavAuthHeader() };
	if (range) headers.Range = range;

	const response = await fetch(toAbsoluteUrl(relPath), { method, headers });
	return { status: response.status, headers: response.headers, body: response.body };
}
