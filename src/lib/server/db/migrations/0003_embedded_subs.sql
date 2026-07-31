-- Phase 4: embedded subtitle + true-codec support (plan.md §11 Phase 4, phase-4.md §5).

-- True video codec as reported by ffprobe (e.g. "h264", "hevc"), null until first probed.
ALTER TABLE catalog ADD COLUMN video_codec TEXT;
-- JSON array of { index, lang, codec, text } for embedded (in-container) subtitle streams,
-- discovered by the scanner's probe pass. Null until first probed.
ALTER TABLE catalog ADD COLUMN embedded_subtitles TEXT;
