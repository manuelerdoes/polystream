// Per-profile remembered subtitle choice over the `subtitle_prefs` table (0001_init.sql).

import { getDb } from '$lib/server/db';

export interface SubtitlePref {
	enabled: boolean;
	language: string | null;
}

const DEFAULT_PREF: SubtitlePref = { enabled: false, language: null };

interface SubtitlePrefRow {
	enabled: number;
	language: string | null;
}

export function getSubtitlePref(profileId: string): SubtitlePref {
	const row = getDb()
		.prepare('SELECT enabled, language FROM subtitle_prefs WHERE profile_id = ?')
		.get(profileId) as SubtitlePrefRow | undefined;

	return row ? { enabled: row.enabled === 1, language: row.language } : DEFAULT_PREF;
}

export function saveSubtitlePref(
	profileId: string,
	enabled: boolean,
	language: string | null
): void {
	getDb()
		.prepare(
			`INSERT INTO subtitle_prefs (profile_id, enabled, language)
			 VALUES (?, ?, ?)
			 ON CONFLICT (profile_id) DO UPDATE SET
				enabled = excluded.enabled,
				language = excluded.language`
		)
		.run(profileId, enabled ? 1 : 0, language);
}
