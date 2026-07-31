// Conversion worker (phase-5-media-pipeline.md): the single-job-at-a-time background queue
// that turns an incompatible-or-suboptimal upload into a direct-playable `.mp4`, per the
// processing matrix scanner.ts's `classifyConversion` decided. This is the module that mutates
// the user's real Nextcloud library, so the safety rule is absolute and enforced structurally
// by the order of operations in `runJob`:
//
//   stream source -> ffmpeg to a LOCAL temp file -> verify the temp file -> upload to Nextcloud
//   -> only THEN delete/replace the original -> update catalog/variants -> clean temp.
//
// The original is never touched until step 4 (upload) has succeeded and the file that produced
// it already passed step 3 (local verification). Any failure before that point leaves the
// source on Nextcloud completely untouched and records `error` on the job row for the UI.
//
// Lazily initialized (module import does no I/O) so `vite build`'s static-analysis pass stays
// side-effect free — mirrors the `getDb()`/webdav.ts pattern. `kickConversionQueue()` is cheap
// to call repeatedly (hooks.server.ts calls it on every request to guarantee the boot-time
// re-queue of any interrupted 'running' job actually runs even if no scan happens first).

import { spawn } from 'node:child_process';
import { mkdir, readdir, rm, stat } from 'node:fs/promises';
import { join } from 'node:path';
import { getDb } from '$lib/server/db';
import { config } from '$lib/server/config';
import { probeMedia, probeLocalFile, type ProbeResult } from '$lib/server/ffmpeg';
import { webdavAuthHeader, webdavFileUrl, uploadFile, deleteFile } from '$lib/server/webdav';

type ConversionKind = 'remux' | 'reencode' | 'h264';

interface ClaimedJob {
	mediaId: string;
	kind: ConversionKind;
}

interface CatalogRow {
	path: string;
	video_codec: string | null;
	audio_codec: string | null;
}

// Duration drift allowed between source and converted output before verification fails
// (phase-5-media-pipeline.md: "duration within ~1s tolerance").
const DURATION_TOLERANCE_SECONDS = 1;
// Minimum gap between progress-column writes, so a fast ffmpeg run (small file) doesn't hammer
// SQLite with one write per `-progress` line.
const PROGRESS_WRITE_THROTTLE_MS = 500;

let initialized = false;
let activeCount = 0;

function tempDir(): string {
	return join(config.dataDir, 'convert');
}

function tempFilePath(mediaId: string, kind: ConversionKind): string {
	return join(tempDir(), `${mediaId}-${kind}-${Date.now()}.mp4`);
}

/** Strips a trailing video extension (mkv/mp4/avi) — used to build sibling target paths. */
function stripVideoExt(path: string): string {
	return path.replace(/\.(mkv|mp4|avi)$/i, '');
}

/** `<basename>.mp4` — the remux target (same path as the source when it was already `.mp4`). */
function remuxTargetPath(sourcePath: string): string {
	return `${stripVideoExt(sourcePath)}.mp4`;
}

/** `<basename>.h264.mp4` — the fallback naming convention (phase-5-media-pipeline.md). */
function h264FallbackPath(sourcePath: string): string {
	return `${stripVideoExt(sourcePath)}.h264.mp4`;
}

function errMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

/** Builds the `-headers` argument ffmpeg expects: one header per line, CRLF-terminated. */
function headersArg(): string {
	return `Authorization: ${webdavAuthHeader()}\r\n`;
}

/**
 * ffmpeg args for one job. 'remux' always stream-copies video (never re-encoded — the matrix's
 * "video is never re-encoded when it doesn't have to be") and forces AAC audio, covering the
 * container/bad-audio matrix rows (H.264-in-mkv/avi, H.264-.mp4-with-bad-audio-or-layout,
 * HEVC-in-mkv) since they all reduce to "fix the container/audio, copy the video". 'reencode' and
 * 'h264' both re-encode video to libx264 8-bit — the two cases where CPU cost is unavoidable:
 * 'reencode' fixes an H.264 primary that's unplayable due to pixel format (10-bit etc., replacing
 * the primary in place); 'h264' generates a compatibility fallback from an HEVC primary (kept
 * alongside it). Same codec recipe, different target semantics — see runJob/finalizeCatalog.
 *
 * `textSubIndices` are the subtitle-relative indices of the source's TEXT subtitle tracks (from
 * the source probe). Both 'remux' and 'reencode' carry them into the `.mp4` as `mov_text` — they
 * both replace the primary in place, so losing subs on a container/pixfmt fix would be a
 * regression (phase-5-media-pipeline.md). Bitmap subs (PGS/VobSub) can't live in `.mp4` and are
 * excluded by only mapping the text indices. The 'h264' fallback carries no subs — they're served
 * from the primary regardless of which variant plays.
 */
function buildFfmpegArgs(
	kind: ConversionKind,
	sourceUrl: string,
	outPath: string,
	textSubIndices: number[]
): string[] {
	const maps = ['-map', '0:v:0', '-map', '0:a:0?'];
	const subMaps: string[] = [];
	if (kind === 'remux' || kind === 'reencode') {
		for (const i of textSubIndices) subMaps.push('-map', `0:s:${i}`);
	}

	// `-pix_fmt yuv420p` is critical: HEVC sources are often 10-bit, and libx264 would otherwise
	// preserve that (High 10 / yuv420p10le) — which NO browser can decode. Forcing 8-bit 4:2:0
	// yields a High-profile stream that plays everywhere. Same reasoning covers 'reencode': an
	// H.264 primary that's already 10-bit needs the exact same fix.
	//
	// `-ac 2` downmixes audio to stereo on every AAC path. Beyond being the browser-safe universal
	// choice, it's what makes AAC encoding robust: ffmpeg's native AAC encoder rejects an untagged
	// multichannel source — ffprobe reports the layout as the undefined mask "6 channels" rather
	// than "5.1", and the encoder fails the whole job with `Unsupported channel layout`. Folding to
	// stereo sidesteps that entirely, and is a no-op for sources already stereo/mono.
	const codecArgs =
		kind === 'remux'
			? ['-c:v', 'copy', '-c:a', 'aac', '-ac', '2']
			: [
					'-c:v',
					'libx264',
					'-pix_fmt',
					'yuv420p',
					'-crf',
					'20',
					'-preset',
					'medium',
					'-c:a',
					'aac',
					'-ac',
					'2'
				];
	const subCodec = subMaps.length ? ['-c:s', 'mov_text'] : [];

	// faststart requires a seekable output, hence writing to a local temp file rather than
	// piping straight to the WebDAV PUT (phase-5-media-pipeline.md).
	return [
		'-y',
		'-v',
		'error',
		'-headers',
		headersArg(),
		'-i',
		sourceUrl,
		...maps,
		...subMaps,
		...codecArgs,
		...subCodec,
		'-movflags',
		'+faststart',
		'-progress',
		'pipe:1',
		'-nostats',
		outPath
	];
}

/**
 * Runs ffmpeg to completion, parsing its `-progress pipe:1` stdout for `out_time=HH:MM:SS.ss`
 * lines to report fractional progress. `settled` guards against the child's 'close'/'error'
 * firing more than once being turned into a double resolve/reject — same discipline as the
 * `settled` guard in ffmpeg.ts's `extractEmbeddedVtt` (a socket-handler double-fire there
 * crashes the whole process; here it would just be a silently-ignored no-op, but the guard
 * costs nothing and keeps the two code paths consistent).
 */
function runFfmpeg(
	args: string[],
	durationSeconds: number | null,
	onProgress: (fraction: number) => void
): Promise<void> {
	return new Promise((resolvePromise, reject) => {
		const child = spawn('ffmpeg', args);

		let stdoutBuf = '';
		let stderrTail = '';
		let settled = false;

		const finish = (err?: Error) => {
			if (settled) return;
			settled = true;
			if (err) reject(err);
			else resolvePromise();
		};

		child.stdout.on('data', (chunk: Buffer) => {
			if (!durationSeconds) return; // Nothing to compute a fraction against.
			stdoutBuf += chunk.toString('utf-8');
			let newlineIndex: number;
			while ((newlineIndex = stdoutBuf.indexOf('\n')) !== -1) {
				const line = stdoutBuf.slice(0, newlineIndex).trim();
				stdoutBuf = stdoutBuf.slice(newlineIndex + 1);
				const match = /^out_time=(\d+):(\d{2}):(\d+(?:\.\d+)?)$/.exec(line);
				if (!match) continue;
				const seconds = Number(match[1]) * 3600 + Number(match[2]) * 60 + Number(match[3]);
				onProgress(Math.min(1, seconds / durationSeconds));
			}
		});
		child.stderr.on('data', (chunk: Buffer) => {
			stderrTail = (stderrTail + chunk.toString('utf-8')).slice(-4000);
		});

		child.on('error', (err) => finish(err));
		child.on('close', (code) => {
			if (code === 0) finish();
			else finish(new Error(`ffmpeg exited with code ${code}: ${stderrTail.trim()}`));
		});
	});
}

/** Throttled `conversion_jobs.progress` writer for one job's lifetime. */
function makeProgressUpdater(mediaId: string): (fraction: number) => void {
	const stmt = getDb().prepare(
		`UPDATE conversion_jobs SET progress = ?, updated_at = unixepoch() WHERE media_id = ?`
	);
	let lastWrite = 0;
	return (fraction: number) => {
		const now = Date.now();
		if (now - lastWrite < PROGRESS_WRITE_THROTTLE_MS) return;
		lastWrite = now;
		stmt.run(fraction, mediaId);
	};
}

/** Upserts the `variants` row for the file this job produced. */
function upsertVariant(
	kind: 'primary' | 'h264',
	mediaId: string,
	path: string,
	probe: ProbeResult
): void {
	getDb()
		.prepare(
			`INSERT INTO variants (media_id, kind, path, video_codec, audio_codec)
			 VALUES (@mediaId, @kind, @path, @videoCodec, @audioCodec)
			 ON CONFLICT(media_id, kind) DO UPDATE SET
			 	path = excluded.path, video_codec = excluded.video_codec, audio_codec = excluded.audio_codec`
		)
		.run({
			mediaId,
			kind,
			path,
			videoCodec: probe.videoCodec,
			audioCodec: probe.audioCodec
		});
}

/** Applies the successful job's result to `catalog`/`variants`. */
function finalizeCatalog(job: ClaimedJob, targetPath: string, probe: ProbeResult): void {
	if (job.kind === 'h264') {
		upsertVariant('h264', job.mediaId, targetPath, probe);
		return;
	}

	// A 'remux' or 'reencode' job replaces the primary itself (new path and/or newly-fixed
	// codecs/pixel format). Re-sync embedded_subtitles to what the CONVERTED file actually
	// carries (mov_text tracks re-index 0..N-1), so the subtitle menu + extraction endpoint stay
	// correct against the new `.mp4`.
	const embedded = probe.embeddedSubtitles.length ? JSON.stringify(probe.embeddedSubtitles) : null;
	// pix_fmt/audio_channel_layout must be refreshed too, not just the codec names — otherwise a
	// manual downmix (remux job forcing -ac 2) would leave the catalog row still reporting the
	// pre-conversion multichannel layout, and DownmixAudioButton would keep offering itself (and
	// the browser-compat gating that reads pix_fmt would stay stale) until the next full scan.
	getDb()
		.prepare(
			`UPDATE catalog SET path = ?, video_codec = ?, audio_codec = ?, embedded_subtitles = ?, pix_fmt = ?, audio_channel_layout = ?, updated_at = unixepoch() WHERE media_id = ?`
		)
		.run(
			targetPath,
			probe.videoCodec,
			probe.audioCodec,
			embedded,
			probe.pixFmt,
			probe.audioChannelLayout,
			job.mediaId
		);
	upsertVariant('primary', job.mediaId, targetPath, probe);
}

/** Marks the job row as failed, with `error` set for the UI. Never throws. */
function markError(mediaId: string, kind: ConversionKind, message: string): void {
	console.error(`[convert] job failed for ${mediaId} (${kind}): ${message}`);
	getDb()
		.prepare(
			`UPDATE conversion_jobs SET state = 'error', error = ?, updated_at = unixepoch() WHERE media_id = ?`
		)
		.run(message, mediaId);
}

/** Enqueues (or re-queues) a job, without disturbing one already in flight. */
function enqueue(mediaId: string, kind: ConversionKind): void {
	getDb()
		.prepare(
			`INSERT INTO conversion_jobs (media_id, state, kind, progress, error, updated_at)
			 VALUES (?, 'queued', ?, 0, NULL, unixepoch())
			 ON CONFLICT(media_id) DO UPDATE SET
			 	kind = excluded.kind, state = 'queued', progress = 0, error = NULL, updated_at = unixepoch()`
		)
		.run(mediaId, kind);
}

/**
 * Enqueues a manual H.264 fallback job and kicks the queue (amendment 2026-07-30: "lazy HEVC
 * fallback, advanced-profile button only"). This is the ONLY place an `h264` job gets created
 * now — scanner.ts's `classifyConversion` never returns `'h264'` and convert.ts no longer
 * chains one after a remux. The caller (the `/api/fallback` route) is responsible for all the
 * guarding (advanced profile, media is HEVC, no existing h264 variant/job) — this function just
 * does the enqueue + kick, kept here so the route stays off raw SQL.
 */
export function requestH264Fallback(mediaId: string): void {
	enqueue(mediaId, 'h264');
	kickConversionQueue();
}

/**
 * Enqueues a manual "downmix audio to stereo" job (advanced-profile button, DownmixAudioButton.
 * svelte). A 'remux' job already forces `-ac 2` (see buildFfmpegArgs) on every path — the scanner
 * only auto-enqueues 'remux' for container mismatches or an undefined/unknown audio layout, not
 * for a DEFINED multichannel layout (e.g. "5.1") since that's already a technically-valid AAC
 * stream. Some multichannel AAC still doesn't play in every browser (Firefox), so this lets an
 * advanced user force the same stream-copy-video/downmix-audio remux on demand. The caller (the
 * `/api/downmix` route) does all the guarding (advanced profile, audio is multichannel, no
 * existing job in flight) — this just does the enqueue + kick, kept here so the route stays off
 * raw SQL, mirroring requestH264Fallback.
 */
export function requestRemux(mediaId: string): void {
	enqueue(mediaId, 'remux');
	kickConversionQueue();
}

/**
 * Runs one job end-to-end: stream -> convert -> verify -> upload -> original-file action ->
 * catalog update -> temp cleanup. See the module docstring for the safety ordering — nothing
 * before the `uploadFile` call can affect the real Nextcloud library.
 */
async function runJob(job: ClaimedJob): Promise<void> {
	const db = getDb();

	const catalogRow = db
		.prepare(`SELECT path, video_codec, audio_codec FROM catalog WHERE media_id = ?`)
		.get(job.mediaId) as CatalogRow | undefined;
	if (!catalogRow) {
		// The media vanished (deleted from the library) since this job was enqueued. `catalog`'s
		// ON DELETE CASCADE should already have removed this job row too — nothing to do.
		return;
	}

	const sourcePath = catalogRow.path;
	// 'reencode' targets the exact same path shape as 'remux' (replaces the primary with a `.mp4`
	// at the same basename) — same replace/delete semantics, only the codec op differs.
	const targetPath =
		job.kind === 'h264' ? h264FallbackPath(sourcePath) : remuxTargetPath(sourcePath);
	// A 'remux' stream-copies video, so the output MUST carry the same video codec as the
	// source. 'reencode' and 'h264' both re-encode to libx264, so their whole point is producing
	// an H.264 stream. Either way, this is exactly what verification checks the local temp file
	// against below.
	const expectedVideoCodec =
		job.kind === 'reencode' || job.kind === 'h264' ? 'h264' : catalogRow.video_codec;

	await mkdir(tempDir(), { recursive: true });
	const localTempPath = tempFilePath(job.mediaId, job.kind);

	try {
		// Probe the remote source up front: gives an expected duration (for progress % and the
		// verification tolerance check) and fails fast if the source itself isn't reachable —
		// before spending any CPU/bandwidth converting it.
		const sourceProbe = await probeMedia(sourcePath);

		// Text-subtitle indices to carry into the mp4 as mov_text (remux only — see buildFfmpegArgs).
		const textSubIndices = sourceProbe.embeddedSubtitles.filter((s) => s.text).map((s) => s.index);
		const args = buildFfmpegArgs(
			job.kind,
			webdavFileUrl(sourcePath),
			localTempPath,
			textSubIndices
		);
		await runFfmpeg(args, sourceProbe.durationSeconds, makeProgressUpdater(job.mediaId));

		// --- Verification gate: everything above only touched a local temp file. Nothing past
		// this point is allowed to run against Nextcloud unless all three checks pass. ---
		const stats = await stat(localTempPath);
		if (stats.size <= 0) throw new Error('Converted file is empty');

		const outputProbe = await probeLocalFile(localTempPath);
		if (expectedVideoCodec && outputProbe.videoCodec !== expectedVideoCodec) {
			throw new Error(
				`Expected video codec "${expectedVideoCodec}", got "${outputProbe.videoCodec ?? 'unknown'}"`
			);
		}
		// Both re-encode kinds force `-pix_fmt yuv420p` (see buildFfmpegArgs) precisely so the
		// output is browser-playable — verify ffmpeg actually honored it before this ever reaches
		// Nextcloud, since a wrong pixel format is the exact defect 'reencode' exists to fix.
		if (
			(job.kind === 'reencode' || job.kind === 'h264') &&
			outputProbe.pixFmt != null &&
			outputProbe.pixFmt !== 'yuv420p'
		) {
			throw new Error(`Expected pix_fmt "yuv420p", got "${outputProbe.pixFmt}"`);
		}
		if (outputProbe.audioCodec && outputProbe.audioCodec !== 'aac') {
			throw new Error(`Expected AAC audio, got "${outputProbe.audioCodec}"`);
		}
		if (sourceProbe.durationSeconds != null && outputProbe.durationSeconds != null) {
			const drift = Math.abs(outputProbe.durationSeconds - sourceProbe.durationSeconds);
			if (drift > DURATION_TOLERANCE_SECONDS) {
				throw new Error(
					`Duration drifted by ${drift.toFixed(2)}s (source ${sourceProbe.durationSeconds.toFixed(2)}s, output ${outputProbe.durationSeconds.toFixed(2)}s)`
				);
			}
		}

		// --- Verified. Only now do we touch Nextcloud. ---
		await uploadFile(targetPath, localTempPath);

		// Matrix's original-file action. A 'h264' job is purely additive — the primary is never
		// touched. A 'remux' or 'reencode' job deletes the original ONLY when it uploaded to a
		// different path (container/extension changed); when the path is unchanged (e.g. an
		// H.264 .mp4 that only needed its audio track fixed, or a 10-bit .mp4 re-encoded in
		// place), the PUT above already replaced it in place — there is no separate "original"
		// left to delete. Same safety ordering as remux: verify -> upload -> only then delete.
		if (job.kind !== 'h264' && targetPath !== sourcePath) {
			try {
				await deleteFile(sourcePath);
			} catch (err) {
				// The new file is uploaded, verified, and already recorded as the new primary
				// below — only cleanup of the stale original failed. Surface it as an error (so
				// a leftover file doesn't silently sit forgotten on Nextcloud) without pretending
				// the conversion itself failed.
				finalizeCatalog(job, targetPath, outputProbe);
				markError(
					job.mediaId,
					job.kind,
					`Uploaded ${targetPath} but failed to delete original ${sourcePath}: ${errMessage(err)}`
				);
				return;
			}
		}

		finalizeCatalog(job, targetPath, outputProbe);
		db.prepare(
			`UPDATE conversion_jobs SET state = 'done', progress = 1, error = NULL, updated_at = unixepoch() WHERE media_id = ?`
		).run(job.mediaId);

		// No more automatic chaining here: a HEVC-in-mkv 'remux' used to auto-enqueue a follow-up
		// 'h264' fallback job. That's lazy + manual now (amendment 2026-07-30) — see
		// requestH264Fallback, which is the only place an 'h264' job gets enqueued.
	} catch (err) {
		markError(job.mediaId, job.kind, errMessage(err));
	} finally {
		await rm(localTempPath, { force: true });
	}
}

/** Claims the oldest queued job, atomically marking it 'running'. Null if none are queued. */
function claimNextJob(): ClaimedJob | null {
	const db = getDb();
	const next = db
		.prepare(
			`SELECT media_id, kind FROM conversion_jobs WHERE state = 'queued' ORDER BY updated_at ASC LIMIT 1`
		)
		.get() as { media_id: string; kind: ConversionKind } | undefined;
	if (!next) return null;

	const claim = db
		.prepare(
			`UPDATE conversion_jobs SET state = 'running', progress = 0, error = NULL, updated_at = unixepoch()
			 WHERE media_id = ? AND state = 'queued'`
		)
		.run(next.media_id);
	// Single in-process worker, so this can't actually race today — the guard is defensive.
	if (claim.changes === 0) return null;

	return { mediaId: next.media_id, kind: next.kind };
}

/** Pumps the queue up to `config.maxTranscodeJobs` concurrent jobs (default 1). */
function pump(): void {
	while (activeCount < Math.max(1, config.maxTranscodeJobs)) {
		const job = claimNextJob();
		if (!job) return;

		activeCount++;
		runJob(job)
			.catch((err: unknown) => {
				// runJob already records job-level errors on the row; this only catches a truly
				// unexpected throw (a bug) so it can't take down the whole process.
				console.error(`[convert] unhandled error running job for ${job.mediaId}:`, err);
			})
			.finally(() => {
				activeCount--;
				pump();
			});
	}
}

/**
 * One-time boot recovery: any job left 'running' when the process last exited (crash, restart)
 * had its ffmpeg child die with it — put it back in the queue so it gets retried.
 */
function requeueInterruptedJobs(): void {
	const { changes } = getDb()
		.prepare(
			`UPDATE conversion_jobs SET state = 'queued', updated_at = unixepoch() WHERE state = 'running'`
		)
		.run();
	if (changes > 0) {
		console.log(`[convert] re-queued ${changes} job(s) interrupted by a restart`);
	}
}

// A temp file is only ever written by an active, single-at-a-time job, and ffmpeg touches it
// continuously while running, so anything older than this must be the leftover of a job whose
// process died mid-run (crash/restart) — safe to delete. Generous enough to never race a slow
// re-encode (whose temp mtime stays fresh as bytes are written anyway).
const STALE_TEMP_MAX_AGE_MS = 6 * 60 * 60 * 1000;

/**
 * One-time boot cleanup: remove orphaned conversion temp files. A job killed mid-run (the same
 * crash/restart `requeueInterruptedJobs` recovers) leaves its partial `.mp4` in `data/convert/`;
 * without this they accumulate and eat the weak VPS's small disk (phase-6.md slice A).
 */
async function sweepStaleTemps(): Promise<void> {
	const dir = tempDir();
	let entries: string[];
	try {
		entries = await readdir(dir);
	} catch {
		return; // dir doesn't exist yet — nothing to sweep
	}
	const cutoff = Date.now() - STALE_TEMP_MAX_AGE_MS;
	let removed = 0;
	for (const name of entries) {
		const full = join(dir, name);
		try {
			const info = await stat(full);
			if (info.isFile() && info.mtimeMs < cutoff) {
				await rm(full, { force: true });
				removed++;
			}
		} catch {
			// racing another cleanup / permission — skip, best-effort
		}
	}
	if (removed > 0) {
		console.log(`[convert] swept ${removed} stale temp file(s) from ${dir}`);
	}
}

function initOnce(): void {
	if (initialized) return;
	initialized = true;
	requeueInterruptedJobs();
	// Fire-and-forget: temp hygiene must not block the request that triggered init.
	void sweepStaleTemps();
}

/**
 * Feeds the queue: called after every scan (new jobs may have been enqueued) and from
 * hooks.server.ts on every request (cheap — `initOnce` no-ops after the first call — so the
 * boot-time re-queue of an interrupted job runs even if the server restarts with a full
 * catalog and nobody triggers a rescan).
 */
export function kickConversionQueue(): void {
	initOnce();
	pump();
}
