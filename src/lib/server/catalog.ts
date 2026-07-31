// Read-only queries over the `catalog`/`metadata`/`scan_state` tables (see migrations
// 0001_init.sql, 0002_library.sql). Pages load exclusively from here — WebDAV/TMDB are only
// ever touched inside scanner.scan(), never on a page request (phase-2.md §5).

import { getDb } from '$lib/server/db';

export type CatalogType = 'movie' | 'show' | 'season' | 'episode';

export interface SubtitleRef {
	lang: string;
	path: string;
}

/** An in-container subtitle track discovered by the scanner's ffprobe pass (phase-4.md §5). */
export interface EmbeddedSubtitleRef {
	/** Subtitle-relative index — see ffmpeg.ts's ProbedSubtitleStream. */
	index: number;
	lang: string | null;
	/** False for bitmap formats (PGS/VobSub) that can't be converted to WebVTT text. */
	text: boolean;
}

interface JoinedRow {
	media_id: string;
	type: CatalogType;
	title: string;
	path: string;
	parent_id: string | null;
	season: number | null;
	episode: number | null;
	year: number | null;
	sort_title: string | null;
	mtime: number | null;
	subtitles: string | null;
	video_codec: string | null;
	audio_codec: string | null;
	audio_channel_layout: string | null;
	embedded_subtitles: string | null;
	// LEFT-joined metadata columns — null when there's no match yet.
	tmdb_id: number | null;
	overview: string | null;
	poster_path: string | null;
	backdrop_path: string | null;
	name: string | null;
	still_path: string | null;
	air_date: string | null;
	runtime: number | null;
}

export interface MediaCard {
	mediaId: string;
	title: string;
	year: number | null;
	overview: string | null;
	posterPath: string | null;
}

export interface ShowDetail extends MediaCard {
	backdropPath: string | null;
	seasons: SeasonSummary[];
}

export interface SeasonSummary {
	mediaId: string;
	season: number;
}

export interface Episode {
	mediaId: string;
	season: number;
	episode: number;
	title: string;
	overview: string | null;
	stillPath: string | null;
	airDate: string | null;
	runtime: number | null;
	subtitles: SubtitleRef[];
	/** Current conversion job for this episode, if any (Stage 2's per-episode status UI). */
	conversionState: ConversionJobInfo | null;
	/** Whether an H.264 fallback variant exists — lets the UI offer the compatibility toggle. */
	hasH264Variant: boolean;
	/** True codec from ffprobe (e.g. "h264"/"hevc") of the primary variant. */
	videoCodec: string | null;
	/** Raw ffprobe channel_layout of the primary's audio (e.g. "5.1", "stereo"); null if unprobed. */
	audioChannelLayout: string | null;
	/** True when the audio has a DEFINED layout that isn't stereo/mono — see audioIsMultichannel. */
	audioIsMultichannel: boolean;
}

export interface ContinueWatchingItem extends MediaCard {
	mediaType: 'movie' | 'episode';
	/**
	 * The actual playable media_id to resume — for episodes this is the last-watched episode,
	 * while `mediaId`/title/poster above describe its parent show (the card's identity). For
	 * movies it equals `mediaId`.
	 */
	resumeMediaId: string;
	positionSeconds: number;
	durationSeconds: number | null;
}

/** One physical file behind a media_id — either the primary or its H.264 fallback. */
export interface VariantInfo {
	kind: 'primary' | 'h264';
	/** WebDAV path, relative to WEBDAV_URL. */
	path: string;
	videoCodec: string | null;
	audioCodec: string | null;
}

/** A media's known variants (phase-5-media-pipeline.md) — always a primary, maybe a fallback. */
export interface MediaVariants {
	primary: VariantInfo;
	h264: VariantInfo | null;
}

export type ConversionState = 'queued' | 'running' | 'done' | 'error';
export type ConversionKind = 'remux' | 'reencode' | 'h264';

export interface ConversionJobInfo {
	mediaId: string;
	state: ConversionState;
	kind: ConversionKind;
	/** 0–1. */
	progress: number;
	error: string | null;
	updatedAt: number;
}

export interface PlayableMedia {
	mediaId: string;
	type: 'movie' | 'episode';
	title: string;
	/** For episodes, the parent show's title (two hops up the catalog tree); null for movies. */
	showTitle: string | null;
	/** WebDAV path, relative to WEBDAV_URL — consumed by /stream and /subtitles. */
	path: string;
	subtitles: SubtitleRef[];
	/** True codec as reported by ffprobe (e.g. "h264", "hevc"); null until scanned/probed. */
	videoCodec: string | null;
	/** True audio codec as reported by ffprobe (e.g. "aac", "ac3"); null until scanned/probed. */
	audioCodec: string | null;
	/** File extension derived from `path` (e.g. "mkv"), lowercased, no leading dot. */
	container: string;
	embeddedSubtitles: EmbeddedSubtitleRef[];
	/** Primary + optional H.264 fallback (phase-5-media-pipeline.md) — null if never scanned. */
	variants: MediaVariants | null;
	/** Current conversion job, if this media has ever needed one; null if none was enqueued. */
	conversionState: ConversionJobInfo | null;
	/** Raw ffprobe channel_layout of the primary's audio (e.g. "5.1", "stereo"); null if unprobed. */
	audioChannelLayout: string | null;
	/** True when the audio has a DEFINED layout that isn't stereo/mono — see audioIsMultichannel. */
	audioIsMultichannel: boolean;
}

export interface ScanState {
	status: 'idle' | 'running' | 'error';
	lastScanAt: number | null;
	lastError: string | null;
	itemCount: number;
}

const JOINED_SELECT = `
	SELECT
		c.media_id, c.type, c.title, c.path, c.parent_id, c.season, c.episode,
		c.year, c.sort_title, c.mtime, c.subtitles, c.video_codec, c.audio_codec,
		c.audio_channel_layout, c.embedded_subtitles,
		m.tmdb_id, m.overview, m.poster_path, m.backdrop_path, m.name, m.still_path,
		m.air_date, m.runtime
	FROM catalog c
	LEFT JOIN metadata m ON m.media_id = c.media_id
`;

function parseSubtitles(json: string | null): SubtitleRef[] {
	if (!json) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as SubtitleRef[]) : [];
	} catch {
		return [];
	}
}

function parseEmbeddedSubtitles(json: string | null): EmbeddedSubtitleRef[] {
	if (!json) return [];
	try {
		const parsed: unknown = JSON.parse(json);
		return Array.isArray(parsed) ? (parsed as EmbeddedSubtitleRef[]) : [];
	} catch {
		return [];
	}
}

/**
 * True when a ffprobe channel_layout is a DEFINED layout other than stereo/mono — the condition
 * DownmixAudioButton.svelte / /api/downmix use to decide "there's something to downmix". Excludes
 * null (unprobed, or the undefined-layout case the scanner already auto-fixes via 'remux') and
 * stereo/mono (already browser-safe, nothing to do).
 */
function computeAudioIsMultichannel(layout: string | null): boolean {
	return layout != null && layout !== 'stereo' && layout !== 'mono';
}

/** File extension from a WebDAV path, lowercased, no leading dot; "" if there isn't one. */
function containerOf(path: string): string {
	const match = /\.([^./]+)$/.exec(path);
	return match ? match[1]!.toLowerCase() : '';
}

function toCard(row: JoinedRow): MediaCard {
	return {
		mediaId: row.media_id,
		title: row.name ?? row.title,
		year: row.year,
		overview: row.overview,
		posterPath: row.poster_path
	};
}

function toEpisode(row: JoinedRow): Episode {
	return {
		mediaId: row.media_id,
		season: row.season ?? 0,
		episode: row.episode ?? 0,
		title: row.name ?? row.title,
		overview: row.overview,
		stillPath: row.still_path,
		airDate: row.air_date,
		runtime: row.runtime,
		subtitles: parseSubtitles(row.subtitles),
		conversionState: getConversionState(row.media_id),
		hasH264Variant: getVariants(row.media_id)?.h264 != null,
		videoCodec: row.video_codec,
		audioChannelLayout: row.audio_channel_layout,
		audioIsMultichannel: computeAudioIsMultichannel(row.audio_channel_layout)
	};
}

export function listMovies(): MediaCard[] {
	const rows = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.type = 'movie' ORDER BY c.sort_title ASC, c.title ASC`)
		.all() as JoinedRow[];
	return rows.map(toCard);
}

export function listShows(): MediaCard[] {
	const rows = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.type = 'show' ORDER BY c.sort_title ASC, c.title ASC`)
		.all() as JoinedRow[];
	return rows.map(toCard);
}

export function getMovie(id: string): MediaCard | null {
	const row = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.media_id = ? AND c.type = 'movie'`)
		.get(id) as JoinedRow | undefined;
	return row ? toCard(row) : null;
}

export function getShow(id: string): ShowDetail | null {
	const row = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.media_id = ? AND c.type = 'show'`)
		.get(id) as JoinedRow | undefined;
	if (!row) return null;

	const seasonRows = getDb()
		.prepare(
			`SELECT media_id, season FROM catalog
			 WHERE parent_id = ? AND type = 'season'
			 ORDER BY season ASC`
		)
		.all(id) as { media_id: string; season: number }[];

	return {
		...toCard(row),
		backdropPath: row.backdrop_path,
		seasons: seasonRows.map((s) => ({ mediaId: s.media_id, season: s.season }))
	};
}

export function getSeason(showId: string, seasonNumber: number): Episode[] {
	const season = getDb()
		.prepare(`SELECT media_id FROM catalog WHERE parent_id = ? AND type = 'season' AND season = ?`)
		.get(showId, seasonNumber) as { media_id: string } | undefined;
	if (!season) return [];

	const rows = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.parent_id = ? AND c.type = 'episode' ORDER BY c.episode ASC`)
		.all(season.media_id) as JoinedRow[];
	return rows.map(toEpisode);
}

/**
 * A profile's most recently updated, unfinished items — one card per **series** (episodes
 * collapse to their show; movies stand alone), Netflix-style. Each card carries the show's
 * poster/title but resumes the actual last-watched episode via `resumeMediaId`.
 *
 * An episode's show is two hops up the catalog tree: episode.parent_id → season.media_id,
 * season.parent_id → show.media_id. We group by `group_id` (the show for episodes, the movie
 * for movies) and keep only each group's most-recently-updated row. The ≥95%-watched filter
 * runs before ranking, so a finished episode drops out and its show's next unfinished episode
 * surfaces instead.
 */
export function continueWatching(profileId: string): ContinueWatchingItem[] {
	const rows = getDb()
		.prepare(
			`WITH watched AS (
				SELECT
					c.media_id AS resume_id,
					c.type,
					c.title AS item_title,
					c.year AS item_year,
					COALESCE(show.media_id, c.media_id) AS group_id,
					p.position_seconds,
					p.duration_seconds,
					p.updated_at
				FROM progress p
				JOIN catalog c ON c.media_id = p.media_id
				LEFT JOIN catalog season ON c.type = 'episode' AND season.media_id = c.parent_id
				LEFT JOIN catalog show ON show.media_id = season.parent_id
				WHERE p.profile_id = ? AND c.type IN ('movie', 'episode')
				-- Hide near-finished items (>=95% watched) — "continue watching" isn't useful once done.
				AND (p.duration_seconds IS NULL OR p.position_seconds < p.duration_seconds * 0.95)
			),
			ranked AS (
				SELECT *,
					ROW_NUMBER() OVER (PARTITION BY group_id ORDER BY updated_at DESC) AS rn
				FROM watched
			)
			SELECT
				r.group_id, r.resume_id, r.type, r.item_title, r.item_year,
				r.position_seconds, r.duration_seconds,
				-- Metadata joined on the group (show for episodes, movie for movies) so the card
				-- shows the series poster/title, not the individual episode's.
				g.year AS group_year, m.overview, m.poster_path, m.name
			 FROM ranked r
			 JOIN catalog g ON g.media_id = r.group_id
			 LEFT JOIN metadata m ON m.media_id = r.group_id
			 WHERE r.rn = 1
			 ORDER BY r.updated_at DESC
			 LIMIT 20`
		)
		.all(profileId) as {
		group_id: string;
		resume_id: string;
		type: 'movie' | 'episode';
		item_title: string;
		item_year: number | null;
		group_year: number | null;
		overview: string | null;
		poster_path: string | null;
		name: string | null;
		position_seconds: number;
		duration_seconds: number | null;
	}[];

	return rows.map((row) => ({
		mediaId: row.group_id,
		mediaType: row.type,
		resumeMediaId: row.resume_id,
		title: row.name ?? row.item_title,
		year: row.group_year,
		overview: row.overview,
		posterPath: row.poster_path,
		positionSeconds: row.position_seconds,
		durationSeconds: row.duration_seconds
	}));
}

interface VariantRow {
	kind: 'primary' | 'h264';
	path: string;
	video_codec: string | null;
	audio_codec: string | null;
}

function toVariantInfo(row: VariantRow): VariantInfo {
	return {
		kind: row.kind,
		path: row.path,
		videoCodec: row.video_codec,
		audioCodec: row.audio_codec
	};
}

/**
 * A media's variants (phase-5-media-pipeline.md): always a primary row once scanned, plus an
 * optional H.264 fallback. Null if the media has never been through a scan's variant pass.
 */
export function getVariants(mediaId: string): MediaVariants | null {
	const rows = getDb()
		.prepare(`SELECT kind, path, video_codec, audio_codec FROM variants WHERE media_id = ?`)
		.all(mediaId) as VariantRow[];

	const primary = rows.find((r) => r.kind === 'primary');
	if (!primary) return null;

	const h264 = rows.find((r) => r.kind === 'h264');
	return { primary: toVariantInfo(primary), h264: h264 ? toVariantInfo(h264) : null };
}

interface ConversionJobRow {
	media_id: string;
	state: ConversionState;
	kind: ConversionKind;
	progress: number;
	error: string | null;
	updated_at: number;
}

function toConversionJobInfo(row: ConversionJobRow): ConversionJobInfo {
	return {
		mediaId: row.media_id,
		state: row.state,
		kind: row.kind,
		progress: row.progress,
		error: row.error,
		updatedAt: row.updated_at
	};
}

/**
 * Whether a media can be handed to the player right now (Stage 2's status gating): no job was
 * ever needed, or the one that was has finished successfully. `queued`/`running`/`error` all mean
 * "don't offer Play yet" — the file behind `path` may still be the pre-conversion original.
 */
export function isPlayReady(conversionState: ConversionJobInfo | null): boolean {
	return conversionState === null || conversionState.state === 'done';
}

/** The current conversion job for one media, or null if none was ever enqueued for it. */
export function getConversionState(mediaId: string): ConversionJobInfo | null {
	const row = getDb()
		.prepare(
			`SELECT media_id, state, kind, progress, error, updated_at FROM conversion_jobs WHERE media_id = ?`
		)
		.get(mediaId) as ConversionJobRow | undefined;
	return row ? toConversionJobInfo(row) : null;
}

/**
 * Every conversion job's current state, newest-updated first — backs the `/api/conversions`
 * status surface (library-wide "Converting…"/"Queued"/"Conversion failed" indicators). UI
 * rendering is Stage 2; this just exposes the data.
 */
export function listConversionJobs(): ConversionJobInfo[] {
	const rows = getDb()
		.prepare(
			`SELECT media_id, state, kind, progress, error, updated_at FROM conversion_jobs ORDER BY updated_at DESC`
		)
		.all() as ConversionJobRow[];
	return rows.map(toConversionJobInfo);
}

/**
 * Looks up a single movie/episode for playback (used by /stream, /subtitles, /watch) — keeps
 * route handlers off raw SQL. 404s (returns null) for anything else, including shows/seasons.
 */
/**
 * An episode's show title is two hops up the catalog tree: episode.parent_id → season.media_id,
 * season.parent_id → show.media_id. Prefers the show's TMDB `name`, falling back to its raw title.
 */
function getShowTitleForEpisode(seasonId: string | null): string | null {
	if (!seasonId) return null;
	const row = getDb()
		.prepare(
			`SELECT COALESCE(m.name, show.title) AS title
			 FROM catalog season
			 JOIN catalog show ON show.media_id = season.parent_id AND show.type = 'show'
			 LEFT JOIN metadata m ON m.media_id = show.media_id
			 WHERE season.media_id = ? AND season.type = 'season'`
		)
		.get(seasonId) as { title: string | null } | undefined;
	return row?.title ?? null;
}

export function getPlayable(mediaId: string): PlayableMedia | null {
	const row = getDb()
		.prepare(`${JOINED_SELECT} WHERE c.media_id = ? AND c.type IN ('movie', 'episode')`)
		.get(mediaId) as JoinedRow | undefined;
	if (!row) return null;

	return {
		mediaId: row.media_id,
		type: row.type as 'movie' | 'episode',
		title: row.name ?? row.title,
		showTitle: row.type === 'episode' ? getShowTitleForEpisode(row.parent_id) : null,
		path: row.path,
		subtitles: parseSubtitles(row.subtitles),
		videoCodec: row.video_codec,
		audioCodec: row.audio_codec,
		container: containerOf(row.path),
		embeddedSubtitles: parseEmbeddedSubtitles(row.embedded_subtitles),
		variants: getVariants(row.media_id),
		conversionState: getConversionState(row.media_id),
		audioChannelLayout: row.audio_channel_layout,
		audioIsMultichannel: computeAudioIsMultichannel(row.audio_channel_layout)
	};
}

export function getScanState(): ScanState {
	const row = getDb()
		.prepare(`SELECT status, last_scan_at, last_error, item_count FROM scan_state WHERE id = 1`)
		.get() as
		| {
				status: ScanState['status'];
				last_scan_at: number | null;
				last_error: string | null;
				item_count: number;
		  }
		| undefined;

	return row
		? {
				status: row.status,
				lastScanAt: row.last_scan_at,
				lastError: row.last_error,
				itemCount: row.item_count
			}
		: { status: 'idle', lastScanAt: null, lastError: null, itemCount: 0 };
}
