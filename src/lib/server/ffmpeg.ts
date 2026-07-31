// ffprobe/ffmpeg wrappers. Originally Phase 4's compatibility work (phase-4.md §5): probing the
// true video codec + embedded subtitle tracks at scan time, and extracting a chosen embedded
// subtitle track to WebVTT on demand — both spawn against the WebDAV file's HTTP(S) URL
// directly (range-read by ffmpeg/ffprobe themselves, nothing downloaded in full here),
// credentials passed via `-headers`, never embedded in the URL (see webdav.ts). Phase 5
// (phase-5-media-pipeline.md) added `probeLocalFile` (verifying a converted temp file on disk,
// used by convert.ts) and `audioCodec`/`durationSeconds` on `ProbeResult`.

import { spawn } from 'node:child_process';
import { webdavAuthHeader, webdavFileUrl } from '$lib/server/webdav';

// Codecs ffmpeg can convert straight to WebVTT text cues.
const TEXT_SUBTITLE_CODECS = new Set(['subrip', 'ass', 'ssa', 'mov_text', 'webvtt']);
// Bitmap subtitle codecs — there's no text to extract, so these are flagged unsupported.
const BITMAP_SUBTITLE_CODECS = new Set(['hdmv_pgs_subtitle', 'dvd_subtitle', 'dvb_subtitle']);

export interface ProbedSubtitleStream {
	/**
	 * Subtitle-relative index (0-based, counting only subtitle streams) — this is what ffmpeg's
	 * `-map 0:s:<index>` stream specifier expects, NOT the absolute stream index ffprobe reports.
	 */
	index: number;
	lang: string | null;
	codec: string;
	/** True when the codec can be converted to WebVTT text; false for bitmap subtitle formats. */
	text: boolean;
}

export interface ProbeResult {
	videoCodec: string | null;
	audioCodec: string | null;
	/** Container duration in seconds, or null if ffprobe couldn't report one. */
	durationSeconds: number | null;
	embeddedSubtitles: ProbedSubtitleStream[];
	/**
	 * Video stream pixel format (e.g. "yuv420p", "yuv420p10le") — added by the "browser-
	 * playability" amendment (phase-5-media-pipeline.md, 2026-07-30): an H.264 stream that isn't
	 * 8-bit `yuv420p` (10-bit "High 10" etc.) decodes in NO browser, unlike a plain codec check.
	 */
	pixFmt: string | null;
	/** Audio stream channel count, or null if unprobed/unavailable. */
	audioChannels: number | null;
	/**
	 * Audio channel layout (e.g. "stereo", "5.1") — ffprobe reports "unknown" when a stream's
	 * layout is undefined, which can stall playback even for otherwise-valid AAC audio.
	 */
	audioChannelLayout: string | null;
}

interface FfprobeStream {
	index: number;
	codec_type: string;
	codec_name: string;
	pix_fmt?: string;
	channels?: number;
	channel_layout?: string;
	tags?: { language?: string };
}

interface FfprobeOutput {
	streams?: FfprobeStream[];
	format?: { duration?: string };
}

/** Builds the `-headers` argument ffmpeg/ffprobe expect: one header per line, CRLF-terminated. */
function headersArg(): string {
	return `Authorization: ${webdavAuthHeader()}\r\n`;
}

/** Runs a child process to completion, collecting stdout and stderr as strings. */
function run(command: string, args: string[]): Promise<{ stdout: string; stderr: string }> {
	return new Promise((resolve, reject) => {
		const child = spawn(command, args);
		let stdout = '';
		let stderr = '';

		child.stdout.on('data', (chunk: Buffer) => {
			stdout += chunk.toString('utf-8');
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderr += chunk.toString('utf-8');
		});

		child.on('error', reject);
		child.on('close', (code) => {
			if (code === 0) {
				resolve({ stdout, stderr });
			} else {
				reject(new Error(`${command} exited with code ${code}: ${stderr.trim()}`));
			}
		});
	});
}

/** Shared parse: raw ffprobe JSON -> our ProbeResult shape. */
function parseProbeOutput(stdout: string): ProbeResult {
	const parsed: FfprobeOutput = JSON.parse(stdout);
	const streams = parsed.streams ?? [];

	const videoStream = streams.find((s) => s.codec_type === 'video');
	const audioStream = streams.find((s) => s.codec_type === 'audio');
	// `index` here is subtitle-relative (0, 1, 2…), matching ffmpeg's `-map 0:s:N` specifier —
	// deliberately NOT ffprobe's absolute stream index (see ProbedSubtitleStream).
	const embeddedSubtitles: ProbedSubtitleStream[] = streams
		.filter((s) => s.codec_type === 'subtitle')
		.map((s, i) => ({
			index: i,
			lang: s.tags?.language ?? null,
			codec: s.codec_name,
			text: TEXT_SUBTITLE_CODECS.has(s.codec_name) && !BITMAP_SUBTITLE_CODECS.has(s.codec_name)
		}));

	const durationRaw = parsed.format?.duration ? Number.parseFloat(parsed.format.duration) : NaN;

	return {
		videoCodec: videoStream?.codec_name ?? null,
		audioCodec: audioStream?.codec_name ?? null,
		durationSeconds: Number.isFinite(durationRaw) ? durationRaw : null,
		embeddedSubtitles,
		pixFmt: videoStream?.pix_fmt ?? null,
		audioChannels: audioStream?.channels ?? null,
		audioChannelLayout: audioStream?.channel_layout ?? null
	};
}

/**
 * Probes a media file over WebDAV for its true video/audio codec, duration, and any embedded
 * subtitle tracks. Caps `-analyzeduration`/`-probesize` so a large file doesn't get read past
 * its first few MB (plan.md §13 / phase-4.md §6). Used by the scanner's codec pass and by the
 * conversion worker (convert.ts), which needs the source duration up front to size progress %.
 */
export async function probeMedia(relPath: string): Promise<ProbeResult> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-print_format',
		'json',
		'-show_streams',
		'-show_format',
		'-analyzeduration',
		'5M',
		'-probesize',
		'5M',
		'-headers',
		headersArg(),
		webdavFileUrl(relPath)
	]);

	return parseProbeOutput(stdout);
}

/**
 * Same as `probeMedia`, but for a local file on disk — used by the conversion worker to verify
 * a freshly-converted temp file (codec/duration/non-zero-size) before it's ever uploaded
 * (phase-5-media-pipeline.md's core safety rule: never touch the original until the
 * replacement is confirmed good). No `-headers`/WebDAV URL, and no probe-size cap: local reads
 * are free and we want an accurate duration for the tolerance check.
 */
export async function probeLocalFile(localPath: string): Promise<ProbeResult> {
	const { stdout } = await run('ffprobe', [
		'-v',
		'error',
		'-print_format',
		'json',
		'-show_streams',
		'-show_format',
		localPath
	]);

	return parseProbeOutput(stdout);
}

/**
 * Extracts one embedded subtitle stream as WebVTT, returned as a passthrough web
 * `ReadableStream` — never buffered in memory. Killing the returned stream's reader (via
 * `cancel()`) kills the underlying ffmpeg process, so an aborted HTTP response doesn't leave
 * it running. `index` is the subtitle-relative index from `ProbedSubtitleStream.index`.
 */
export function extractEmbeddedVtt(relPath: string, index: number): ReadableStream<Uint8Array> {
	const child = spawn('ffmpeg', [
		'-v',
		'error',
		'-headers',
		headersArg(),
		'-i',
		webdavFileUrl(relPath),
		'-map',
		`0:s:${index}`,
		'-f',
		'webvtt',
		'-'
	]);

	let stderr = '';
	child.stderr.on('data', (chunk: Buffer) => {
		stderr += chunk.toString('utf-8');
	});

	// A ReadableStream controller can only be closed/errored once, and never after cancel().
	// stdout 'end' and child 'close' both fire (in either order) and a non-zero exit can arrive
	// after stdout already ended — so every controller call goes through this `settled` guard.
	// Without it, the second call throws *inside a socket event handler*, which is uncaught and
	// crashes the whole process.
	let settled = false;

	return new ReadableStream<Uint8Array>({
		start(controller) {
			const safeClose = () => {
				if (settled) return;
				settled = true;
				try {
					controller.close();
				} catch {
					// Already closed/errored — nothing to do.
				}
			};
			const safeError = (err: Error) => {
				if (settled) return;
				settled = true;
				try {
					controller.error(err);
				} catch {
					// Already closed/errored — nothing to do.
				}
			};

			child.stdout.on('data', (chunk: Buffer) => {
				if (settled) return;
				try {
					controller.enqueue(new Uint8Array(chunk));
				} catch {
					// Enqueue after the stream is gone — drop the chunk.
				}
			});
			child.stdout.on('end', safeClose);
			child.on('error', safeError);
			child.on('close', (code) => {
				if (code !== 0 && code !== null) {
					safeError(new Error(`ffmpeg exited with code ${code}: ${stderr.trim()}`));
				} else {
					safeClose();
				}
			});
		},
		cancel() {
			// The response was aborted (client disconnected, etc.) — stop touching the controller
			// and don't let ffmpeg keep reading/writing against a WebDAV connection nobody wants.
			settled = true;
			child.kill();
		}
	});
}
