#!/usr/bin/env node
// Read-only triage for stuck/failed conversions. Prints every conversion job that isn't 'done',
// the ffmpeg error that killed it, and the variant rows for that media — which together explain
// why a title still won't play. Touches nothing.
//
// Run it inside the container without copying anything in (the image ships only build/ and
// node_modules/, so the script is piped in over stdin and executed from /app):
//
//   docker compose exec -T polystream node < scripts/diagnose-conversions.cjs
//
// Locally: DATA_DIR=./data node < scripts/diagnose-conversions.cjs

/* eslint-disable @typescript-eslint/no-require-imports -- CJS on purpose: `node < file` (how this
   reaches the container without being copied in) executes stdin as CommonJS. */
const { join } = require('node:path');
const Database = require('better-sqlite3');

const dbPath = join(process.env.DATA_DIR ?? '/data', 'polystream.db');
const db = new Database(dbPath, { readonly: true });

const jobs = db
	.prepare(
		`SELECT j.media_id, j.kind, j.state, j.progress, j.error, j.updated_at,
		        c.title, c.path, c.video_codec, c.pix_fmt, c.audio_codec, c.audio_channel_layout
		 FROM conversion_jobs j
		 JOIN catalog c USING (media_id)
		 WHERE j.state != 'done'
		 ORDER BY j.updated_at DESC`
	)
	.all();

const variantsFor = db.prepare(
	`SELECT kind, path, video_codec, audio_codec FROM variants WHERE media_id = ?`
);

console.log(`db: ${dbPath}`);
console.log(`unfinished conversion jobs: ${jobs.length}\n`);

for (const j of jobs) {
	const variants = variantsFor.all(j.media_id);
	const h264 = variants.find((v) => v.kind === 'h264');

	console.log('─'.repeat(78));
	console.log(`${j.title}   [${j.media_id}]`);
	console.log(`  job:      ${j.kind} / ${j.state} (${Math.round(j.progress * 100)}%)`);
	console.log(`  updated:  ${new Date(j.updated_at * 1000).toISOString()}`);
	console.log(`  source:   ${j.path}`);
	console.log(
		`  codecs:   video=${j.video_codec} pix_fmt=${j.pix_fmt} audio=${j.audio_codec} layout=${j.audio_channel_layout}`
	);
	console.log(`  h264 variant registered: ${h264 ? h264.path : 'no'}`);
	if (j.error) console.log(`  error:    ${j.error}`);

	// Why this title is (or isn't) playable right now — mirrors $lib/playReady.
	const blocksPlay = j.kind !== 'h264' && (j.state === 'queued' || j.state === 'running');
	if (blocksPlay) {
		console.log(`  → Play is hidden: a ${j.kind} job is pending and it replaces the primary file.`);
	} else if (j.video_codec === 'hevc' && !h264) {
		console.log(
			`  → Play is offered, but this is HEVC with no H.264 fallback: it only plays on devices`
		);
		console.log(`    that can decode HEVC. Others get "needs a compatibility version".`);
	} else {
		console.log(`  → Playable (the source file was never touched by the failed job).`);
	}
	if (h264 && j.state === 'error' && j.kind === 'h264') {
		console.log(`  ! An h264 variant is registered even though the job failed — if that file is a`);
		console.log(
			`    truncated upload, delete it on the WebDAV and rescan, then retry the conversion.`
		);
	}
}

if (jobs.length) console.log('─'.repeat(78));
db.close();
