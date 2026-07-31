// Single shared better-sqlite3 connection for the whole server process.
// better-sqlite3 is synchronous, so no connection pool is needed.
//
// Lazily initialized (rather than at module load) so that `vite build`'s static-analysis
// pass — which imports every server module without a real .env or writable cwd guaranteed —
// never touches the filesystem or opens a DB connection.

import { mkdirSync } from 'node:fs';
import { join } from 'node:path';
import Database from 'better-sqlite3';
import { config } from '$lib/server/config';
import { applyMigrations, type Migration } from './migrate';

// Migrations are inlined into the server bundle at build time (via `?raw`) rather than
// read from disk at runtime, so they survive Vite's build step without extra file copying.
const migrationModules = import.meta.glob('./migrations/*.sql', {
	eager: true,
	query: '?raw',
	import: 'default'
}) as Record<string, string>;

const migrations: Migration[] = Object.entries(migrationModules).map(([path, sql]) => ({
	name: path.split('/').pop()!,
	sql
}));

let instance: Database.Database | undefined;

function openDb(): Database.Database {
	mkdirSync(config.dataDir, { recursive: true });

	const database = new Database(join(config.dataDir, 'polystream.db'));
	database.pragma('journal_mode = WAL');
	database.pragma('foreign_keys = ON');
	applyMigrations(database, migrations);

	return database;
}

export function getDb(): Database.Database {
	if (!instance) instance = openDb();
	return instance;
}
