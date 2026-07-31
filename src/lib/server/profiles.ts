// Profile CRUD over the `profiles` table (see migrations/0001_init.sql).
// No auth/session concerns here — that's auth.ts; this module is plain data access.

import { randomUUID } from 'node:crypto';
import { getDb } from '$lib/server/db';

export interface Profile {
	id: string;
	name: string;
	avatar: string | null;
	createdAt: number;
	/** Gates the manual "Generate H.264 version" button (phase-5-media-pipeline.md amendment). */
	advanced: boolean;
}

interface ProfileRow {
	id: string;
	name: string;
	avatar: string | null;
	created_at: number;
	advanced: number;
}

function toProfile(row: ProfileRow): Profile {
	return {
		id: row.id,
		name: row.name,
		avatar: row.avatar,
		createdAt: row.created_at,
		advanced: row.advanced === 1
	};
}

export function listProfiles(): Profile[] {
	const rows = getDb()
		.prepare('SELECT id, name, avatar, created_at, advanced FROM profiles ORDER BY created_at ASC')
		.all() as ProfileRow[];
	return rows.map(toProfile);
}

export function getProfile(id: string): Profile | null {
	const row = getDb()
		.prepare('SELECT id, name, avatar, created_at, advanced FROM profiles WHERE id = ?')
		.get(id) as ProfileRow | undefined;
	return row ? toProfile(row) : null;
}

/** Trims and validates a profile name; throws on empty input. */
function normalizeName(name: string): string {
	const trimmed = name.trim();
	if (!trimmed) throw new Error('Profile name cannot be empty.');
	return trimmed.slice(0, 40);
}

export function createProfile(name: string, avatar: string, advanced = false): Profile {
	const id = randomUUID();
	const cleanName = normalizeName(name);
	getDb()
		.prepare('INSERT INTO profiles (id, name, avatar, advanced) VALUES (?, ?, ?, ?)')
		.run(id, cleanName, avatar, advanced ? 1 : 0);
	return getProfile(id)!;
}

export function renameProfile(id: string, name: string): Profile | null {
	const cleanName = normalizeName(name);
	getDb().prepare('UPDATE profiles SET name = ? WHERE id = ?').run(cleanName, id);
	return getProfile(id);
}

export function setAvatar(id: string, avatar: string): Profile | null {
	getDb().prepare('UPDATE profiles SET avatar = ? WHERE id = ?').run(avatar, id);
	return getProfile(id);
}

/** Toggles the "advanced" flag (phase-5-media-pipeline.md amendment) from the profile manager. */
export function setProfileAdvanced(id: string, advanced: boolean): Profile | null {
	getDb()
		.prepare('UPDATE profiles SET advanced = ? WHERE id = ?')
		.run(advanced ? 1 : 0, id);
	return getProfile(id);
}

export function deleteProfile(id: string): void {
	getDb().prepare('DELETE FROM profiles WHERE id = ?').run(id);
}
