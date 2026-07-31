// Orchestrates a full library scan: WebDAV walk -> filename parse -> catalog upsert/prune
// -> TMDB match (shows/movies, then episodes) -> scan_state bookkeeping. Routes never call
// WebDAV/TMDB directly — this is the only place those run (phase-2.md §5, §6).

import { createHash } from 'node:crypto';
import { getDb } from '$lib/server/db';
import { walk, mediaRoot, type DavEntry } from '$lib/server/webdav';
import {
	cleanTitle,
	parseEpisode,
	parseMovie,
	parseSeasonFolder,
	parseSubtitle,
	sortTitle
} from '$lib/server/filename';
import { searchShow, searchMovie, getEpisode } from '$lib/server/tmdb';
import { probeMedia } from '$lib/server/ffmpeg';
import { kickConversionQueue } from '$lib/server/convert';

const VIDEO_EXTENSIONS = new Set(['mkv', 'mp4', 'avi']);
// Re-check TMDB matches at most weekly — avoids hammering the API on every manual rescan
// once a title is matched (phase-2.md §3 scanner notes: "skip if metadata already fresh").
const METADATA_FRESH_SECONDS = 7 * 24 * 60 * 60;

// In-memory single-flight lock: only one scan runs at a time per process. Matches the
// 1–2-viewer, single-weak-VPS deployment target (plan.md §1) — no queuing needed.
let scanning = false;

function extensionOf(name: string): string {
	const match = /\.([^.]+)$/.exec(name);
	return match ? match[1]!.toLowerCase() : '';
}

function stripExtension(name: string): string {
	return name.replace(/\.[^./\\]+$/, '');
}

function dirnameOf(path: string): string {
	const idx = path.lastIndexOf('/');
	return idx === -1 ? '' : path.slice(0, idx);
}

function pad2(n: number): string {
	return String(n).padStart(2, '0');
}

function mediaId(key: string): string {
	return createHash('sha1').update(key).digest('hex').slice(0, 16);
}

// Recognizes an app- or user-provided H.264 compatibility fallback sibling (phase-5-media-
// pipeline.md's naming convention): "<basename>.h264.mp4" next to its primary "<basename>.mp4"
// (or .mkv/.avi). Case-insensitive since real-world uploads mix case.
const H264_VARIANT_SUFFIX = /\.h264\.mp4$/i;

function isH264VariantFile(name: string): boolean {
	return H264_VARIANT_SUFFIX.test(name);
}

// The extensions the scanner recognizes as "video" (see VIDEO_EXTENSIONS), for stripping.
const VIDEO_EXTENSION_SUFFIX = /\.(mkv|mp4|avi)$/i;

/**
 * Derives the identity key a video file's `media_id` is hashed from: the path with its video
 * extension AND any `.h264` variant tag stripped (phase-5-media-pipeline.md "Stable media
 * identity"). This makes a primary, its H.264 fallback, and a re-containered version of the
 * primary (e.g. a `.mkv` remuxed to `.mp4`) all hash to the *same* media_id, so a conversion
 * never orphans watch progress or re-catalogs a title as "new". Deliberately only applied to
 * movie/episode video files — show/season folder names are hashed as-is (they may legitimately
 * contain dots that aren't an "extension", e.g. "Mr.Robot").
 */
function videoIdentityKey(path: string): string {
	return path.replace(VIDEO_EXTENSION_SUFFIX, '').replace(/\.h264$/i, '');
}

function videoMediaId(path: string): string {
	return mediaId(videoIdentityKey(path));
}

function yearFromDate(dateStr: string | null): number | null {
	if (!dateStr) return null;
	const year = Number.parseInt(dateStr.slice(0, 4), 10);
	return Number.isFinite(year) ? year : null;
}

/** Strips the media-root prefix and splits the remainder into path segments. */
function relativeSegments(path: string, root: string): string[] {
	const prefix = root ? `${root}/` : '';
	const rel = path.startsWith(prefix) ? path.slice(prefix.length) : path;
	return rel.split('/').filter(Boolean);
}

interface ShowNode {
	mediaId: string;
	path: string;
	title: string;
	mtime: number | null;
}

interface SeasonNode {
	mediaId: string;
	path: string;
	showMediaId: string;
	season: number;
}

interface SubtitleHit {
	lang: string;
	path: string;
}

interface EpisodeNode {
	mediaId: string;
	path: string;
	seasonMediaId: string;
	season: number;
	episode: number;
	mtime: number | null;
	subtitles: SubtitleHit[];
	/** WebDAV path of a `*.h264.mp4` sibling, if one exists — see videoIdentityKey. */
	h264VariantPath: string | null;
}

interface MovieNode {
	mediaId: string;
	path: string;
	title: string;
	year: number | null;
	mtime: number | null;
	subtitles: SubtitleHit[];
	/** WebDAV path of a `*.h264.mp4` sibling, if one exists — see videoIdentityKey. */
	h264VariantPath: string | null;
}

interface Discovery {
	shows: ShowNode[];
	seasons: SeasonNode[];
	episodes: EpisodeNode[];
	movies: MovieNode[];
}

/**
 * Walks the WebDAV library (bounded structure: root -> movies|tv shows -> ... -> files,
 * plan.md §2 / phase-2.md §0.1) and groups entries into show/season/episode/movie nodes,
 * attaching any sibling `.srt` files it finds along the way.
 */
async function discoverLibrary(): Promise<Discovery> {
	const root = mediaRoot();
	const entries = await walk(root);

	const shows: ShowNode[] = [];
	const seasons: SeasonNode[] = [];
	const episodes: EpisodeNode[] = [];
	const movies: MovieNode[] = [];

	// Subtitle siblings, grouped by directory, so each video can look up its own matches.
	const subsByDir = new Map<string, DavEntry[]>();
	for (const entry of entries) {
		if (entry.isDir || extensionOf(entry.name) !== 'srt') continue;
		const dir = dirnameOf(entry.path);
		const list = subsByDir.get(dir) ?? [];
		list.push(entry);
		subsByDir.set(dir, list);
	}

	// H.264 fallback siblings (`*.h264.mp4`, phase-5-media-pipeline.md), keyed by the identity
	// they SHARE with their primary (see videoIdentityKey) — never turned into their own
	// episode/movie node, just attached to the matching primary below. An entry that doesn't
	// end up matching any primary (no primary uploaded, or primary vanished) is simply never
	// looked up again — harmless, not a separate catalog row.
	const h264VariantsByMediaId = new Map<string, string>();
	for (const entry of entries) {
		if (entry.isDir || !isH264VariantFile(entry.name)) continue;
		h264VariantsByMediaId.set(videoMediaId(entry.path), entry.path);
	}

	function findSubtitles(dir: string, videoStem: string): SubtitleHit[] {
		const candidates = subsByDir.get(dir) ?? [];
		return candidates
			.map((sub) => ({ sub, parsed: parseSubtitle(sub.name) }))
			.filter(({ parsed }) => parsed.base === videoStem)
			.map(({ sub, parsed }) => ({ lang: parsed.lang, path: sub.path }));
	}

	for (const entry of entries) {
		const segments = relativeSegments(entry.path, root);
		if (segments.length === 0) continue;
		const category = segments[0]!.toLowerCase();

		if (category === 'tv shows') {
			if (entry.isDir && segments.length === 2) {
				shows.push({
					mediaId: mediaId(entry.path),
					path: entry.path,
					title: cleanTitle(entry.name),
					mtime: entry.mtime
				});
			} else if (entry.isDir && segments.length === 3) {
				const season = parseSeasonFolder(entry.name);
				if (season === null) continue;
				seasons.push({
					mediaId: mediaId(entry.path),
					path: entry.path,
					showMediaId: mediaId(dirnameOf(entry.path)),
					season
				});
			} else if (
				!entry.isDir &&
				segments.length === 4 &&
				VIDEO_EXTENSIONS.has(extensionOf(entry.name)) &&
				!isH264VariantFile(entry.name)
			) {
				const parsed = parseEpisode(entry.name);
				if (!parsed) continue;
				const dir = dirnameOf(entry.path);
				const id = videoMediaId(entry.path);
				episodes.push({
					mediaId: id,
					path: entry.path,
					seasonMediaId: mediaId(dir),
					season: parsed.season,
					episode: parsed.episode,
					mtime: entry.mtime,
					subtitles: findSubtitles(dir, stripExtension(entry.name)),
					h264VariantPath: h264VariantsByMediaId.get(id) ?? null
				});
			}
		} else if (
			category === 'movies' &&
			!entry.isDir &&
			VIDEO_EXTENSIONS.has(extensionOf(entry.name)) &&
			!isH264VariantFile(entry.name)
		) {
			// Support both "movies/Title (Year).ext" (flat) and "movies/Title (Year)/….ext"
			// (one folder per movie) — prefer the folder name when present, it's usually cleaner.
			const folderName = segments.length === 3 ? segments[1]! : null;
			const parsed = parseMovie(folderName ?? entry.name);
			const dir = dirnameOf(entry.path);
			const id = videoMediaId(entry.path);
			movies.push({
				mediaId: id,
				path: entry.path,
				title: parsed.title,
				year: parsed.year,
				mtime: entry.mtime,
				subtitles: findSubtitles(dir, stripExtension(entry.name)),
				h264VariantPath: h264VariantsByMediaId.get(id) ?? null
			});
		}
	}

	return { shows, seasons, episodes, movies };
}

/** Inserts/updates catalog rows for everything just discovered, then prunes vanished ones. */
function upsertCatalog(db: ReturnType<typeof getDb>, discovery: Discovery): void {
	const { shows, seasons, episodes, movies } = discovery;

	// `year` is deliberately left out of the UPDATE clause: it's set once (from TMDB for
	// shows, from the filename for movies) and rescans must not clobber it back to null.
	const upsert = db.prepare(`
		INSERT INTO catalog
			(media_id, type, title, path, parent_id, season, episode, year, sort_title, mtime, subtitles)
		VALUES
			(@mediaId, @type, @title, @path, @parentId, @season, @episode, @year, @sortTitle, @mtime, @subtitles)
		ON CONFLICT(media_id) DO UPDATE SET
			type = excluded.type,
			title = excluded.title,
			path = excluded.path,
			parent_id = excluded.parent_id,
			season = excluded.season,
			episode = excluded.episode,
			sort_title = excluded.sort_title,
			mtime = excluded.mtime,
			subtitles = excluded.subtitles,
			updated_at = unixepoch()
	`);

	const runUpsertAndPrune = db.transaction(() => {
		// Parents before children: `parent_id` is a foreign key and pragma foreign_keys=ON.
		for (const show of shows) {
			upsert.run({
				mediaId: show.mediaId,
				type: 'show',
				title: show.title,
				path: show.path,
				parentId: null,
				season: null,
				episode: null,
				year: null,
				sortTitle: sortTitle(show.title),
				mtime: show.mtime,
				subtitles: null
			});
		}

		for (const season of seasons) {
			upsert.run({
				mediaId: season.mediaId,
				type: 'season',
				title: `Season ${season.season}`,
				path: season.path,
				parentId: season.showMediaId,
				season: season.season,
				episode: null,
				year: null,
				sortTitle: null,
				mtime: null,
				subtitles: null
			});
		}

		for (const episode of episodes) {
			upsert.run({
				mediaId: episode.mediaId,
				type: 'episode',
				title: `S${pad2(episode.season)}E${pad2(episode.episode)}`,
				path: episode.path,
				parentId: episode.seasonMediaId,
				season: episode.season,
				episode: episode.episode,
				year: null,
				sortTitle: null,
				mtime: episode.mtime,
				subtitles: episode.subtitles.length ? JSON.stringify(episode.subtitles) : null
			});
		}

		for (const movie of movies) {
			upsert.run({
				mediaId: movie.mediaId,
				type: 'movie',
				title: movie.title,
				path: movie.path,
				parentId: null,
				season: null,
				episode: null,
				year: movie.year,
				sortTitle: sortTitle(movie.title),
				mtime: movie.mtime,
				subtitles: movie.subtitles.length ? JSON.stringify(movie.subtitles) : null
			});
		}

		// Prune anything no longer present on the WebDAV side. Cascading FKs (ON DELETE
		// CASCADE on catalog.parent_id and metadata.media_id) clean up children/metadata.
		const currentIds = new Set([
			...shows.map((s) => s.mediaId),
			...seasons.map((s) => s.mediaId),
			...episodes.map((e) => e.mediaId),
			...movies.map((m) => m.mediaId)
		]);
		const existing = db.prepare('SELECT media_id FROM catalog').all() as { media_id: string }[];
		const del = db.prepare('DELETE FROM catalog WHERE media_id = ?');
		for (const row of existing) {
			if (!currentIds.has(row.media_id)) del.run(row.media_id);
		}
	});

	runUpsertAndPrune();
}

/** TMDB matching for shows/movies (skipping fresh matches), then episode-level lookups. */
async function matchMetadata(db: ReturnType<typeof getDb>, discovery: Discovery): Promise<void> {
	const { shows, seasons, episodes, movies } = discovery;

	const metaUpsert = db.prepare(`
		INSERT INTO metadata
			(media_id, tmdb_id, overview, poster_path, backdrop_path, name, still_path, air_date, runtime)
		VALUES
			(@mediaId, @tmdbId, @overview, @posterPath, @backdropPath, @name, @stillPath, @airDate, @runtime)
		ON CONFLICT(media_id) DO UPDATE SET
			tmdb_id = excluded.tmdb_id,
			overview = excluded.overview,
			poster_path = excluded.poster_path,
			backdrop_path = excluded.backdrop_path,
			name = excluded.name,
			still_path = excluded.still_path,
			air_date = excluded.air_date,
			runtime = excluded.runtime,
			updated_at = unixepoch()
	`);

	function existingTmdbId(id: string): number | null {
		const row = db
			.prepare('SELECT tmdb_id, updated_at FROM metadata WHERE media_id = ?')
			.get(id) as { tmdb_id: number | null; updated_at: number } | undefined;
		return row?.tmdb_id ?? null;
	}

	function isFresh(id: string): boolean {
		const row = db
			.prepare('SELECT tmdb_id, updated_at FROM metadata WHERE media_id = ?')
			.get(id) as { tmdb_id: number | null; updated_at: number } | undefined;
		if (!row || row.tmdb_id == null) return false;
		return Date.now() / 1000 - row.updated_at < METADATA_FRESH_SECONDS;
	}

	// Sequential (not Promise.all) — TMDB's free tier is generous but there's no need to be
	// aggressive from a weak VPS, and it keeps error handling per-item simple.
	const showTmdbId = new Map<string, number>();
	for (const show of shows) {
		if (isFresh(show.mediaId)) {
			const id = existingTmdbId(show.mediaId);
			if (id != null) showTmdbId.set(show.mediaId, id);
			continue;
		}

		const match = await searchShow(show.title);
		if (!match) continue;

		metaUpsert.run({
			mediaId: show.mediaId,
			tmdbId: match.tmdbId,
			overview: match.overview,
			posterPath: match.posterPath,
			backdropPath: match.backdropPath,
			name: match.name,
			stillPath: null,
			airDate: match.firstAirDate,
			runtime: null
		});
		showTmdbId.set(show.mediaId, match.tmdbId);

		const year = yearFromDate(match.firstAirDate);
		if (year !== null) {
			db.prepare('UPDATE catalog SET year = ? WHERE media_id = ? AND year IS NULL').run(
				year,
				show.mediaId
			);
		}
	}

	for (const movie of movies) {
		if (isFresh(movie.mediaId)) continue;

		const match = await searchMovie(movie.title, movie.year ?? undefined);
		if (!match) continue;

		metaUpsert.run({
			mediaId: movie.mediaId,
			tmdbId: match.tmdbId,
			overview: match.overview,
			posterPath: match.posterPath,
			backdropPath: match.backdropPath,
			name: match.name,
			stillPath: null,
			airDate: match.firstAirDate,
			runtime: null
		});
	}

	const seasonToShow = new Map(seasons.map((s) => [s.mediaId, s.showMediaId]));

	for (const episode of episodes) {
		if (isFresh(episode.mediaId)) continue;

		const showId = seasonToShow.get(episode.seasonMediaId);
		const tmdbId = showId ? showTmdbId.get(showId) : undefined;
		if (!tmdbId) continue; // parent show wasn't matched — leave episode metadata empty.

		const match = await getEpisode(tmdbId, episode.season, episode.episode);
		if (!match) continue;

		metaUpsert.run({
			mediaId: episode.mediaId,
			tmdbId,
			overview: match.overview,
			posterPath: null,
			backdropPath: null,
			name: match.name,
			stillPath: match.stillPath,
			airDate: match.airDate,
			runtime: match.runtime
		});
	}
}

/**
 * ffprobes each movie/episode for its true video/audio codec + embedded subtitle tracks
 * (phase-4.md §5, extended by phase-5-media-pipeline.md with `audio_codec`), storing the
 * result on the catalog row. Freshness guard: skips a row that was already probed successfully
 * (`video_codec` set) whose `mtime` hasn't changed since — avoids re-probing every file on every
 * rescan. `previous` is captured *before* `upsertCatalog` runs, since that overwrites `mtime`
 * unconditionally.
 *
 * Sequential and best-effort: probing is a network round-trip per file, and a single failure
 * (WebDAV hiccup, corrupt file, ffprobe not installed) must never abort the whole scan — it
 * just leaves that row's columns as they were (null, for a first-time probe).
 */
async function probeCodecsAndSubtitles(
	db: ReturnType<typeof getDb>,
	discovery: Discovery,
	previous: Map<
		string,
		{ video_codec: string | null; pix_fmt: string | null; mtime: number | null }
	>
): Promise<void> {
	const update = db.prepare(
		`UPDATE catalog SET video_codec = ?, audio_codec = ?, embedded_subtitles = ?, pix_fmt = ?, audio_channel_layout = ? WHERE media_id = ?`
	);

	const targets = [
		...discovery.episodes.map((e) => ({ mediaId: e.mediaId, path: e.path, mtime: e.mtime })),
		...discovery.movies.map((m) => ({ mediaId: m.mediaId, path: m.path, mtime: m.mtime }))
	];

	for (const target of targets) {
		const prior = previous.get(target.mediaId);
		// Skip only a FULLY-probed, unchanged file. `pix_fmt` must also be present, so rows probed
		// before migration 0006 (video_codec set, pix_fmt null) get re-probed once to populate the
		// new playability columns — otherwise the pixel-format/audio detection would never fire on
		// the existing library.
		if (
			prior &&
			prior.video_codec !== null &&
			prior.pix_fmt !== null &&
			prior.mtime === target.mtime
		)
			continue;

		try {
			const probed = await probeMedia(target.path);
			// A successful probe that found no video stream is almost never a real "no video" file —
			// it's a transient read (a file mid-upload, a WebDAV hiccup, ffprobe not seeing the moov).
			// Don't let that overwrite a row's existing good codec data with nulls; leave it for the
			// next scan to re-probe (the freshness guard re-probes rows whose pix_fmt is still null).
			if (probed.videoCodec === null) {
				console.warn(`[scanner] probe found no video stream for ${target.path} — leaving as-is`);
				continue;
			}
			update.run(
				probed.videoCodec,
				probed.audioCodec,
				probed.embeddedSubtitles.length ? JSON.stringify(probed.embeddedSubtitles) : null,
				probed.pixFmt,
				probed.audioChannelLayout,
				target.mediaId
			);
		} catch (err) {
			console.error(`[scanner] probe failed for ${target.path}:`, err);
			// Leave video_codec/audio_codec/embedded_subtitles/pix_fmt/audio_channel_layout
			// untouched — null on a first probe, or the previous good value on a re-probe of an
			// already-known file.
		}
	}
}

type ConversionKind = 'remux' | 'reencode' | 'h264';

/**
 * Classifies a movie/episode against the processing matrix (phase-5-media-pipeline.md): what
 * (if anything) the conversion worker needs to do EAGERLY on scan. `null` means "leave it
 * alone" — already H.264+AAC+8-bit in an `.mp4`, already HEVC (fallback or not), or not probed
 * yet (unknown codec — nothing safe to decide until the next scan probes it).
 *
 * Amendment (2026-07-30, "lazy HEVC fallback"): this must NEVER return `'h264'`. The HEVC→H.264
 * re-encode is slow and often wasted (most viewers are on HEVC-capable devices), so it's no
 * longer auto-enqueued on scan — only an explicit "Generate H.264 version" button (advanced
 * profiles only, see convert.ts's `requestH264Fallback`) enqueues it. `hasH264Variant` is still
 * accepted (and still populates the `variants` table via applyConversionMatrix) but no longer
 * changes this function's answer for HEVC — it's kept as a parameter for that caller's benefit.
 * Remux stays eager (cheap, lossless): H.264-in-mkv/avi, non-AAC-audio (or undefined-layout-AAC)
 * mp4, and HEVC-in-mkv (container fix only, primary stays HEVC — no more automatic fallback
 * chaining afterwards).
 *
 * Amendment (2026-07-30, "browser-playability detection, not just codec"): an H.264 stream that
 * isn't 8-bit `yuv420p` (10-bit "High 10" etc.) is unplayable in EVERY browser, not just weak
 * ones — a plain codec-name check misses this. Order matters: the 10-bit check runs first and
 * wins outright ('reencode'), since re-encoding also fixes any container/audio problem the file
 * might additionally have. HEVC 10-bit is NOT re-encoded here — it hardware-decodes fine on
 * capable devices, so its (device-dependent) fallback stays lazy/button per the amendment above.
 */
function classifyConversion(
	container: string,
	videoCodec: string | null,
	pixFmt: string | null,
	audioCodec: string | null,
	audioChannelLayout: string | null,
	hasH264Variant: boolean
): ConversionKind | null {
	void hasH264Variant; // no longer affects the HEVC branch — see docstring

	// An H.264 stream that isn't 8-bit yuv420p (10-bit "High 10" etc.) decodes in NO browser —
	// unplayable everywhere, so it wins over the (cheaper) remux checks below.
	if (videoCodec === 'h264' && pixFmt != null && pixFmt !== 'yuv420p') return 'reencode';

	if (videoCodec === 'h264' || videoCodec === 'hevc') {
		// AAC with an undefined/unknown channel layout can stall playback even though the codec
		// name checks out — re-encoding audio (-c:a aac) assigns a valid layout while keeping the
		// channel count (e.g. 6ch -> 5.1, no forced stereo downmix).
		const audioNeedsFixing =
			audioCodec != null &&
			(audioCodec !== 'aac' || audioChannelLayout == null || audioChannelLayout === 'unknown');
		if (container !== 'mp4' || audioNeedsFixing) return 'remux';
		return null; // HEVC .mp4 (or already-fine H.264 .mp4) -> nothing eager needed
	}
	return null; // unknown/unprobed codec — nothing safe to decide yet
}

/**
 * Populates the `variants` table (primary + optional H.264 fallback) and enqueues conversion
 * jobs per the processing matrix, for every movie/episode just discovered. Reads catalog rows
 * back fresh (post-probe) rather than trusting `discovery`'s in-memory data, since probing can
 * be skipped this scan (freshness guard in probeCodecsAndSubtitles) — the catalog row is the
 * source of truth for "current codec". Vanished media are cleaned up for free: `variants` and
 * `conversion_jobs` both reference `catalog(media_id) ON DELETE CASCADE`, and upsertCatalog
 * already pruned anything no longer on the WebDAV side.
 */
function applyConversionMatrix(db: ReturnType<typeof getDb>, discovery: Discovery): void {
	const variantUpsert = db.prepare(`
		INSERT INTO variants (media_id, kind, path, video_codec, audio_codec)
		VALUES (@mediaId, @kind, @path, @videoCodec, @audioCodec)
		ON CONFLICT(media_id, kind) DO UPDATE SET
			path = excluded.path,
			video_codec = excluded.video_codec,
			audio_codec = excluded.audio_codec
	`);

	// Re-queues only on first sight or after a prior failure — leaves an in-flight
	// ('queued'/'running') or already-'done' job alone so nothing is reset or redone every scan.
	const jobUpsert = db.prepare(`
		INSERT INTO conversion_jobs (media_id, state, kind, progress, error, updated_at)
		VALUES (@mediaId, 'queued', @kind, 0, NULL, unixepoch())
		ON CONFLICT(media_id) DO UPDATE SET
			kind = excluded.kind,
			state = 'queued',
			progress = 0,
			error = NULL,
			updated_at = unixepoch()
		WHERE conversion_jobs.state = 'error'
	`);

	const getCatalogRow = db.prepare(
		`SELECT path, video_codec, audio_codec, pix_fmt, audio_channel_layout FROM catalog WHERE media_id = ?`
	);

	const targets = [
		...discovery.episodes.map((e) => ({ mediaId: e.mediaId, h264VariantPath: e.h264VariantPath })),
		...discovery.movies.map((m) => ({ mediaId: m.mediaId, h264VariantPath: m.h264VariantPath }))
	];

	for (const target of targets) {
		const row = getCatalogRow.get(target.mediaId) as
			| {
					path: string;
					video_codec: string | null;
					audio_codec: string | null;
					pix_fmt: string | null;
					audio_channel_layout: string | null;
			  }
			| undefined;
		if (!row) continue; // Shouldn't happen — upsertCatalog runs before this in scan().

		variantUpsert.run({
			mediaId: target.mediaId,
			kind: 'primary',
			path: row.path,
			videoCodec: row.video_codec,
			audioCodec: row.audio_codec
		});

		if (target.h264VariantPath) {
			// Trusted by naming convention: a `*.h264.mp4` sibling IS the universal fallback,
			// whether user-uploaded or previously generated by the conversion worker — not
			// re-probed here (keeps rescans cheap; convert.ts verifies anything it generates).
			variantUpsert.run({
				mediaId: target.mediaId,
				kind: 'h264',
				path: target.h264VariantPath,
				videoCodec: 'h264',
				audioCodec: 'aac'
			});
		}

		// Both eager kinds ('remux' and 'reencode') are enqueued here; 'h264' is deliberately
		// never returned by classifyConversion — it's only ever enqueued by the manual button
		// (requestH264Fallback in convert.ts).
		const kind = classifyConversion(
			extensionOf(row.path),
			row.video_codec,
			row.pix_fmt,
			row.audio_codec,
			row.audio_channel_layout,
			target.h264VariantPath !== null
		);
		if (kind) jobUpsert.run({ mediaId: target.mediaId, kind });
	}
}

/**
 * Runs a full scan: WebDAV walk -> parse -> catalog upsert/prune -> TMDB match -> codec/
 * subtitle probe -> variant/conversion-job bookkeeping -> kick the conversion queue. No-op
 * (and returns immediately) if a scan is already running. Never throws — failures are recorded
 * in `scan_state.last_error` for the UI to display.
 */
export async function scan(): Promise<void> {
	if (scanning) return;
	scanning = true;

	const db = getDb();
	db.prepare(`UPDATE scan_state SET status = 'running' WHERE id = 1`).run();

	try {
		const discovery = await discoverLibrary();

		// Snapshot pre-upsert state for the probe pass's freshness check — upsertCatalog is
		// about to overwrite `mtime` unconditionally.
		const previousProbeState = new Map(
			(
				db
					.prepare(
						`SELECT media_id, video_codec, pix_fmt, mtime FROM catalog WHERE type IN ('movie', 'episode')`
					)
					.all() as {
					media_id: string;
					video_codec: string | null;
					pix_fmt: string | null;
					mtime: number | null;
				}[]
			).map((row) => [
				row.media_id,
				{ video_codec: row.video_codec, pix_fmt: row.pix_fmt, mtime: row.mtime }
			])
		);

		upsertCatalog(db, discovery);
		await matchMetadata(db, discovery);
		await probeCodecsAndSubtitles(db, discovery, previousProbeState);
		applyConversionMatrix(db, discovery);

		const { n: itemCount } = db.prepare(`SELECT COUNT(*) AS n FROM catalog`).get() as {
			n: number;
		};

		db.prepare(
			`UPDATE scan_state SET status = 'idle', last_scan_at = unixepoch(), last_error = NULL, item_count = ? WHERE id = 1`
		).run(itemCount);

		// Feed the single-job conversion queue with anything just enqueued (spec: "fed after
		// each scan and on demand"). Fire-and-forget — conversion runs in the background and
		// must never block the scan (or the request that triggered it) from returning.
		kickConversionQueue();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		console.error('[scanner] scan failed:', err);
		db.prepare(`UPDATE scan_state SET status = 'error', last_error = ? WHERE id = 1`).run(message);
	} finally {
		scanning = false;
	}
}
