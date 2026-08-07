// The single "may this title be handed to the player right now?" rule. Lives here rather than in
// catalog.ts because both sides need it: the server routes that gate `?play=`/`/watch`, and the
// client components that render a Play control (EpisodeList) — and catalog.ts pulls in
// $lib/server/db, which can't be imported from a client-rendered component.

import type { ConversionJobInfo } from '$lib/server/catalog';

/**
 * Whether a media can be played right now. Only a *pending* job that replaces the primary file
 * blocks Play — everything else is playable, because of how convert.ts is ordered:
 *
 *   stream -> local temp -> verify -> upload -> only THEN replace the original
 *
 * so a job that failed never touched the library, and the file behind `catalog.path` is exactly
 * the one that was there before the attempt. And an 'h264' job is purely additive in the first
 * place (it writes a `<name>.h264.mp4` alongside the HEVC primary and never touches it), so it
 * must not gate Play in ANY state: an HEVC title stays playable while its fallback encodes, and
 * stays playable if that encode fails. A failed conversion is a missing convenience, never a
 * reason to take playback away.
 */
export function isPlayReady(conversionState: ConversionJobInfo | null): boolean {
	if (conversionState === null) return true;
	if (conversionState.kind === 'h264') return true;
	// 'remux'/'reencode' replace the primary in place, and while one is queued/running the file
	// on Nextcloud is still the pre-conversion original — the very file the scanner decided the
	// browser can't direct-play. That case (and only that case) keeps hiding Play.
	return conversionState.state === 'done' || conversionState.state === 'error';
}

/**
 * A job whose failure the user should see, or null. Callers render this *next to* the Play
 * control, never instead of it (see isPlayReady) — with `isPlayReady` true for errors, the
 * failure would otherwise be invisible.
 */
export function conversionError(conversionState: ConversionJobInfo | null): string | null {
	if (conversionState?.state !== 'error') return null;
	return conversionState.error ?? 'Conversion failed.';
}
