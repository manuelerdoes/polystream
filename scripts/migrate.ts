// Standalone CLI entry for `npm run db:migrate`. Runs outside Vite (so it can't use
// `import.meta.glob` or the `$lib` alias like src/lib/server/db/index.ts does) — reads
// migration files and env vars directly instead. Useful for running migrations without
// booting the whole app (e.g. in a deploy step).

import { mkdirSync, readdirSync, readFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import Database from 'better-sqlite3';
import { applyMigrations, type Migration } from '../src/lib/server/db/migrate.ts';

const migrationsDir = join(
	dirname(fileURLToPath(import.meta.url)),
	'../src/lib/server/db/migrations'
);

const migrations: Migration[] = readdirSync(migrationsDir)
	.filter((name) => name.endsWith('.sql'))
	.map((name) => ({ name, sql: readFileSync(join(migrationsDir, name), 'utf-8') }));

const dataDir = process.env.DATA_DIR ?? './data';
mkdirSync(dataDir, { recursive: true });

const db = new Database(join(dataDir, 'polystream.db'));
db.pragma('journal_mode = WAL');
db.pragma('foreign_keys = ON');

applyMigrations(db, migrations);
db.close();

console.log('[db] up to date');
