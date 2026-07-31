// Browser-only per-device variant selection (phase-5-media-pipeline.md "Playback (client)").
// Never imported from server code — everything here touches `navigator`/`sessionStorage`, which
// don't exist during SSR.
//
// History: Phase 4 routed container-gap H.264 through a client-side libav.js MSE remux; Phase 4b
// replaced that with server-side ffmpeg-to-HLS remux. Both were abandoned (too slow / no real
// seeking against the remote WebDAV source) in favor of Phase 5's pre-converted variants: every
// title is either already H.264 (universal) or a HEVC primary with an optional H.264 fallback.
// This module's only remaining job is picking between those two, per device.

export type DeviceMode = 'desktop' | 'tv';

/** What the player should actually request from `/stream`. */
export type VariantDecision = 'primary' | 'h264' | 'unavailable';

const HEVC_VERDICT_CACHE_KEY = 'polystream:hevc-verdict:v1';

// Real per-title dimensions aren't threaded through today — a reasonable stand-in for "typical
// HD content" is enough for decodingInfo's smoothness heuristic (phase-5-media-pipeline.md
// "Playback (client)": "use a reasonable resolution if exact dims aren't known").
const DEFAULT_PROBE_VIDEO = {
	width: 1920,
	height: 1080,
	bitrate: 8_000_000,
	framerate: 24
};

function isHevc(codec: string | null): boolean {
	return codec === 'hevc' || codec === 'h265';
}

/**
 * Probes whether this device can decode HEVC smoothly via `mediaCapabilities.decodingInfo()`,
 * caching the verdict in sessionStorage — the probe is per-device/browser, not per-title, so
 * there's no reason to redo it on every play within one tab session.
 */
async function probeHevcSmooth(): Promise<boolean> {
	const cached = sessionStorage.getItem(HEVC_VERDICT_CACHE_KEY);
	if (cached !== null) return cached === '1';

	let verdict = false;
	try {
		if ('mediaCapabilities' in navigator) {
			const result = await navigator.mediaCapabilities.decodingInfo({
				type: 'file',
				video: {
					contentType: 'video/mp4; codecs="hvc1.1.6.L93.B0"',
					...DEFAULT_PROBE_VIDEO
				}
			});
			// `powerEfficient` (hardware decode) is what makes HEVC actually viable on weak
			// devices, but `supported && smooth` is the documented signal to gate on — a software
			// decode path can still report smooth on a fast desktop CPU, which is fine too.
			verdict = result.supported && result.smooth;
		}
	} catch {
		// decodingInfo can throw on some browsers for edge-case inputs — treat as "can't tell",
		// which falls back to the universal H.264 variant below.
		verdict = false;
	}

	try {
		sessionStorage.setItem(HEVC_VERDICT_CACHE_KEY, verdict ? '1' : '0');
	} catch {
		// sessionStorage can throw (private-browsing quirks, quota) — not worth failing over.
	}

	return verdict;
}

export interface PickVariantInput {
	/** The primary variant's true codec from ffprobe (catalog.ts's VariantInfo.videoCodec). */
	primaryVideoCodec: string | null;
	/** Whether an H.264 fallback variant exists for this media (catalog.ts's MediaVariants.h264). */
	hasH264Variant: boolean;
}

/**
 * Picks which variant to actually play on this device (phase-5-media-pipeline.md "Playback
 * (client)"): a non-HEVC primary is always universal, so it's always the answer. A HEVC primary
 * is only played when this device can decode it smoothly; otherwise the H.264 fallback — or
 * `'unavailable'` if that fallback doesn't exist (yet), so the caller can show a clear message
 * instead of handing the browser a codec it can't play.
 */
export async function pickVariant({
	primaryVideoCodec,
	hasH264Variant
}: PickVariantInput): Promise<VariantDecision> {
	if (!isHevc(primaryVideoCodec)) return 'primary';

	const smooth = await probeHevcSmooth();
	if (smooth) return 'primary';
	return hasH264Variant ? 'h264' : 'unavailable';
}
