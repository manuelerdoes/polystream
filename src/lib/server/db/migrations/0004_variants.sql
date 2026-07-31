-- Phase 5: media pipeline — variant tracking + conversion jobs (phase-5-media-pipeline.md).

-- True audio codec as reported by ffprobe (e.g. "aac", "ac3"), null until first probed.
ALTER TABLE catalog ADD COLUMN audio_codec TEXT;

-- Tracks the physical file(s) behind one media_id: always a 'primary' row, plus an optional
-- 'h264' row when a compatibility fallback exists (user-uploaded `*.h264.mp4` sibling, or one
-- the conversion worker generated). media_id is stable across a remux (see scanner.ts's
-- videoMediaId) so a primary's path can change (mkv -> mp4) without orphaning this row.
CREATE TABLE variants (
	media_id TEXT NOT NULL REFERENCES catalog (media_id) ON DELETE CASCADE,
	kind TEXT NOT NULL, -- 'primary' | 'h264'
	path TEXT NOT NULL, -- WebDAV path, relative to WEBDAV_URL
	video_codec TEXT,
	audio_codec TEXT,
	PRIMARY KEY (media_id, kind)
);

-- Drives the conversion worker (convert.ts) + the UI status surface. Survives restarts: a
-- 'running' row is re-queued on boot since its ffmpeg child died with the process.
-- One row per media_id — a title needing two conversions in sequence (HEVC-in-mkv: remux,
-- then generate an H.264 fallback) reuses the same row, re-queued with the next `kind` once
-- the first job completes (see convert.ts).
CREATE TABLE conversion_jobs (
	media_id TEXT PRIMARY KEY REFERENCES catalog (media_id) ON DELETE CASCADE,
	state TEXT NOT NULL DEFAULT 'queued', -- 'queued' | 'running' | 'done' | 'error'
	kind TEXT NOT NULL, -- 'remux' | 'h264'
	progress REAL NOT NULL DEFAULT 0,
	error TEXT,
	updated_at INTEGER NOT NULL DEFAULT (unixepoch())
);
