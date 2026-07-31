-- Amendment (2026-07-30): browser-playability detection, not just codec. A file passing "video
-- is H.264" isn't enough — 10-bit H.264 plays in no browser, and AAC with an undefined channel
-- layout can stall playback. These columns let classifyConversion (scanner.ts) judge on pixel
-- format + audio layout too, not just codec name.

-- Video stream pixel format (e.g. "yuv420p", "yuv420p10le"), null until first probed.
ALTER TABLE catalog ADD COLUMN pix_fmt TEXT;
-- Audio stream channel layout (e.g. "stereo", "5.1", or "unknown" when undefined), null until
-- first probed.
ALTER TABLE catalog ADD COLUMN audio_channel_layout TEXT;
