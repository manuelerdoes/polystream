-- Initial schema (plan.md section 5): profiles, progress, subtitle prefs, catalog cache, metadata cache.

CREATE TABLE profiles (
	id TEXT PRIMARY KEY,
	name TEXT NOT NULL,
	avatar TEXT,
	created_at INTEGER NOT NULL DEFAULT (unixepoch())
);

-- media_id = stable hash of the WebDAV path (see catalog table).
CREATE TABLE progress (
	profile_id TEXT NOT NULL REFERENCES profiles (id) ON DELETE CASCADE,
	media_id TEXT NOT NULL,
	position_seconds REAL NOT NULL DEFAULT 0,
	duration_seconds REAL,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch()),
	PRIMARY KEY (profile_id, media_id)
);

CREATE TABLE subtitle_prefs (
	profile_id TEXT PRIMARY KEY REFERENCES profiles (id) ON DELETE CASCADE,
	enabled INTEGER NOT NULL DEFAULT 0,
	language TEXT
);

-- Cached, normalized WebDAV listing. type: 'movie' | 'show' | 'season' | 'episode'.
CREATE TABLE catalog (
	media_id TEXT PRIMARY KEY,
	type TEXT NOT NULL,
	title TEXT NOT NULL,
	path TEXT NOT NULL,
	parent_id TEXT REFERENCES catalog (media_id) ON DELETE CASCADE,
	season INTEGER,
	episode INTEGER,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_catalog_parent_id ON catalog (parent_id);

-- Cached TMDB metadata, one row per matched catalog entry.
CREATE TABLE metadata (
	media_id TEXT PRIMARY KEY REFERENCES catalog (media_id) ON DELETE CASCADE,
	tmdb_id INTEGER,
	overview TEXT,
	poster_path TEXT,
	backdrop_path TEXT,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);

CREATE INDEX idx_progress_profile_id ON progress (profile_id);
