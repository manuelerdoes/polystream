// Per-profile playback position over the `progress` table (0001_init.sql). Drives resume
// (Player's `startAt`) and the home page's "Continue watching" row (catalog.continueWatching).

import { getDb } from '$lib/server/db';

export interface Progress {
	positionSeconds: number;
	durationSeconds: number | null;
}

interface ProgressRow {
	position_seconds: number;
	duration_seconds: number | null;
}

export function getProgress(profileId: string, mediaId: string): Progress | null {
	const row = getDb()
		.prepare(
			`SELECT position_seconds, duration_seconds FROM progress
			 WHERE profile_id = ? AND media_id = ?`
		)
		.get(profileId, mediaId) as ProgressRow | undefined;

	return row
		? { positionSeconds: row.position_seconds, durationSeconds: row.duration_seconds }
		: null;
}

/** Upserts the resume point; `duration` is nullable since a beacon fired before metadata loads. */
export function saveProgress(
	profileId: string,
	mediaId: string,
	position: number,
	duration: number | null
): void {
	getDb()
		.prepare(
			`INSERT INTO progress (profile_id, media_id, position_seconds, duration_seconds, updated_at)
			 VALUES (?, ?, ?, ?, unixepoch())
			 ON CONFLICT (profile_id, media_id) DO UPDATE SET
				position_seconds = excluded.position_seconds,
				duration_seconds = excluded.duration_seconds,
				updated_at = excluded.updated_at`
		)
		.run(profileId, mediaId, position, duration);
}
