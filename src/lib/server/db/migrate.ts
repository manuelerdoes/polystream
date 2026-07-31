// Minimal migration runner: applies migrations in order, once each, tracked in a
// `_migrations` table. No down-migrations — this is an append-only log.
// Pure w.r.t. I/O: callers supply the migration contents (see index.ts / scripts/migrate.ts),
// since *how* migrations are loaded differs between the Vite-bundled app and the plain-Node CLI.

import type Database from 'better-sqlite3';

export interface Migration {
	name: string;
	sql: string;
}

export function applyMigrations(db: Database.Database, migrations: Migration[]): void {
	db.exec(`
		CREATE TABLE IF NOT EXISTS _migrations (
			name TEXT PRIMARY KEY,
			applied_at INTEGER NOT NULL DEFAULT (unixepoch())
		)
	`);

	const appliedRows = db.prepare('SELECT name FROM _migrations').all() as { name: string }[];
	const applied = new Set(appliedRows.map((row) => row.name));

	const ordered = [...migrations].sort((a, b) => a.name.localeCompare(b.name));

	for (const { name, sql } of ordered) {
		if (applied.has(name)) continue;

		const applyMigration = db.transaction(() => {
			db.exec(sql);
			db.prepare('INSERT INTO _migrations (name) VALUES (?)').run(name);
		});

		applyMigration();
		console.log(`[db] applied migration ${name}`);
	}
}
