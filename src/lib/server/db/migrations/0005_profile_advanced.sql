-- Amendment (2026-07-30): lazy HEVC fallback, advanced-profile button only. `advanced` gates
-- the manual "Generate H.264 version" button — only profiles with this flag see it / may call
-- the endpoint that enqueues an h264 job (see /api/fallback + convert.ts's requestH264Fallback).
ALTER TABLE profiles ADD COLUMN advanced INTEGER NOT NULL DEFAULT 0;
