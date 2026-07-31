// In-house .srt → WebVTT converter (phase-3.md §5). Pure + unit-checkable: no I/O here. Kept
// small and forgiving — a slightly malformed cue should still render something rather than
// 500 the whole subtitle request.

const COMMA_TIMESTAMP = /(\d{2}:\d{2}:\d{2}),(\d{3})/g;
const BOM = '﻿';

/** Converts .srt text to WebVTT text. */
export function srtToVtt(srt: string): string {
	// Strip a leading UTF-8 BOM if present, then normalize newlines.
	const withoutBom = srt.startsWith(BOM) ? srt.slice(BOM.length) : srt;
	const normalized = withoutBom.replace(/\r\n?/g, '\n');

	// Drop bare numeric cue-index lines — WebVTT doesn't need them and their presence isn't
	// valid before a "-->" timestamp line in some strict parsers.
	const body = normalized
		.split('\n')
		.filter((line) => !/^\d+$/.test(line.trim()))
		.join('\n')
		// SRT uses a comma for the fractional-seconds separator; WebVTT requires a dot.
		.replace(COMMA_TIMESTAMP, '$1.$2');

	return `WEBVTT\n\n${body.trim()}\n`;
}
