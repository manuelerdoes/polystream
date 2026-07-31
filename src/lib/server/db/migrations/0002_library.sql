-- Phase 2: library scan support (plan.md §11 Phase 2, phase-2.md §2/§3).

ALTER TABLE catalog ADD COLUMN year INTEGER; -- release/first-air year (parsed or TMDB)
ALTER TABLE catalog ADD COLUMN sort_title TEXT; -- lowercased, article-stripped, for A–Z
ALTER TABLE catalog ADD COLUMN mtime INTEGER; -- WebDAV lastmod, for "recently added"
-- JSON array of { lang, path } for sibling external .srt files discovered at scan time.
ALTER TABLE catalog ADD COLUMN subtitles TEXT;

ALTER TABLE metadata ADD COLUMN name TEXT; -- TMDB canonical title / episode name
ALTER TABLE metadata ADD COLUMN still_path TEXT; -- episode still image (TMDB path)
ALTER TABLE metadata ADD COLUMN air_date TEXT; -- episode/first air date
ALTER TABLE metadata ADD COLUMN runtime INTEGER; -- minutes, when TMDB provides it

CREATE TABLE scan_state (
	id INTEGER PRIMARY KEY CHECK (id = 1),
	status TEXT NOT NULL DEFAULT 'idle', -- idle | running | error
	last_scan_at INTEGER,
	last_error TEXT,
	item_count INTEGER NOT NULL DEFAULT 0
);
INSERT INTO scan_state (id) VALUES (1);
