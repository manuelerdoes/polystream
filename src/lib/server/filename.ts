// Pure filename/foldername parsing (no I/O — easy to unit-check by hand).
// The curated library uses clean, dot-separated release-style names (phase-2.md §0.1/§3):
//   "Bad.Sisters.S01E01.1080p.WEBRip.x265-RARBG[eztv.re].mp4"
//   "Bad.Sisters.S01E01.1080p.WEBRip.x265-RARBG[eztv.re]_de.srt"
//   "Season 1", "Season 2"

export interface ParsedEpisode {
	showName: string;
	season: number;
	episode: number;
}

export interface ParsedMovie {
	title: string;
	year: number | null;
}

export interface ParsedSubtitle {
	base: string;
	lang: string;
}

/** Strips the final ".ext" from a filename, if present. */
function stripExtension(filename: string): string {
	return filename.replace(/\.[^./\\]+$/, '');
}

// Resolution / codec / source / misc release tags to strip from titles. Word-boundaried so
// e.g. "4k" doesn't eat into an unrelated token.
const RELEASE_TAG_PATTERN =
	/\b(2160p|1080p|720p|480p|4k|x264|x265|h264|h265|hevc|avc|webrip|web-dl|web|bluray|brrip|bdrip|dvdrip|hdtv|hdrip|remux|proper|repack|extended|unrated|amzn|nf|dsnp)\b/gi;

/**
 * Strips release-group noise (bracketed annotations, resolution/codec/source tags, trailing
 * "-GROUP" suffix) from a raw title fragment and normalizes dot/underscore separators to
 * spaces. Safe to call on an already-clean fragment (e.g. the show-name prefix before an
 * SxxEyy marker) — it's a no-op there beyond separator normalization.
 */
export function cleanTitle(raw: string): string {
	let title = raw;
	title = title.replace(/[[({][^\])}]*[\])}]/g, ' '); // [eztv.re], (2021), etc.
	title = title.replace(/[._]+/g, ' '); // dots/underscores -> spaces
	title = title.replace(RELEASE_TAG_PATTERN, ' ');
	title = title.replace(/-[A-Za-z0-9]+$/, ' '); // trailing "-RELEASEGROUP"
	title = title.replace(/\s+/g, ' ').trim();
	return title;
}

/** Lowercased, leading-article-stripped title for A–Z sorting ("The Wire" -> "wire"). */
export function sortTitle(title: string): string {
	return title.toLowerCase().replace(/^(the|a|an)\s+/, '');
}

// Ordered by specificity: SxxEyy is unambiguous; NxM is checked second since it can't be
// confused with codec tags like "x265" (those have no leading digit before the "x").
const EPISODE_PATTERNS: RegExp[] = [/s(\d{1,2})e(\d{1,3})/i, /(\d{1,2})x(\d{1,3})/i];

/**
 * Parses "Show.Name.S01E02.…ext" / "Show Name 1x02 …" style episode filenames.
 * Returns null when no season/episode marker is found.
 */
export function parseEpisode(filename: string): ParsedEpisode | null {
	const stem = stripExtension(filename);

	for (const pattern of EPISODE_PATTERNS) {
		const match = pattern.exec(stem);
		if (!match) continue;

		const showName = cleanTitle(stem.slice(0, match.index));
		if (!showName) continue;

		return {
			showName,
			season: Number.parseInt(match[1]!, 10),
			episode: Number.parseInt(match[2]!, 10)
		};
	}

	return null;
}

/**
 * Parses "Title (2021).ext" / "Title.2021.WEBRip.x264-GROUP.ext" style movie filenames.
 * Year is null when no 4-digit year token can be found (title still returned, cleaned).
 */
export function parseMovie(filename: string): ParsedMovie {
	const stem = stripExtension(filename);

	const parenMatch = /^(.*)\((\d{4})\)/.exec(stem);
	if (parenMatch) {
		return { title: cleanTitle(parenMatch[1]!), year: Number.parseInt(parenMatch[2]!, 10) };
	}

	const yearMatch = /(?:^|[.\s_])(19\d{2}|20\d{2})(?:[.\s_]|$)/.exec(stem);
	if (yearMatch) {
		return {
			title: cleanTitle(stem.slice(0, yearMatch.index)),
			year: Number.parseInt(yearMatch[1]!, 10)
		};
	}

	return { title: cleanTitle(stem), year: null };
}

// 2-3 letter language code, dot/underscore/dash-separated, immediately before ".srt".
const SUBTITLE_LANG_PATTERN = /[._-]([a-z]{2,3})$/i;

/**
 * Parses an external subtitle filename into its base (matches the sibling video's stem)
 * and language code. `lang` falls back to "und" (undetermined) when no suffix is present.
 */
export function parseSubtitle(filename: string): ParsedSubtitle {
	const stem = filename.replace(/\.srt$/i, '');
	const match = SUBTITLE_LANG_PATTERN.exec(stem);

	if (match) {
		return { base: stem.slice(0, match.index), lang: match[1]!.toLowerCase() };
	}

	return { base: stem, lang: 'und' };
}

/** Parses a season folder name ("Season 1", "Season 01", "S1") into its season number. */
export function parseSeasonFolder(name: string): number | null {
	const match = /season\s*(\d{1,2})/i.exec(name) ?? /^s(\d{1,2})$/i.exec(name.trim());
	return match ? Number.parseInt(match[1]!, 10) : null;
}
