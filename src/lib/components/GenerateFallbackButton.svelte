<script lang="ts">
	// Manual "Generate H.264 version" button (phase-5-media-pipeline.md amendment 2026-07-30:
	// "lazy HEVC fallback, advanced-profile button only"). Shown only for advanced profiles, only
	// on an HEVC title that has no h264 variant yet. Owns its own small poll loop (mirrors
	// ConversionBar.svelte's pattern) so progress updates without a full page reload/invalidate —
	// deliberately NOT calling invalidateAll(), so the page's own Play/ConversionStatus gating
	// (computed once at load, from BEFORE this job existed) keeps showing the HEVC primary as
	// playable while the fallback re-encodes in the background.

	import { onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import ConversionStatus from '$lib/components/ConversionStatus.svelte';
	import type { ConversionJobInfo } from '$lib/server/catalog';

	interface Props {
		mediaId: string;
		videoCodec: string | null;
		hasH264Variant: boolean;
		conversionState: ConversionJobInfo | null;
		advanced: boolean;
	}

	let { mediaId, videoCodec, hasH264Variant, conversionState, advanced }: Props = $props();

	// Seeded once from the server-loaded initial value, then owned by the poll loop below —
	// mirrors ConversionBar.svelte's same `untrack` pattern for the same reason.
	let jobState = $state<ConversionJobInfo | null>(untrack(() => conversionState));
	let requesting = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	const POLL_INTERVAL_MS = 3000;

	// Only an h264-kind job on this media is relevant here — a lingering 'remux' job (already
	// finished by the time this button can even appear) is not this component's concern.
	const h264Job = $derived(jobState?.kind === 'h264' ? jobState : null);
	// A failed job is NOT a dead end: nothing was touched on Nextcloud (see convert.ts's ordering),
	// the HEVC primary is still playable, and /api/fallback accepts a fresh request after an error.
	// So the button comes back as a retry, and the failure is reported beside it — never in place
	// of the page's Play control (that gating is $lib/playReady's job, and it stays ready here).
	const failed = $derived(h264Job?.state === 'error' ? h264Job : null);
	const showButton = $derived(
		advanced && videoCodec === 'hevc' && !hasH264Variant && (!h264Job || failed !== null)
	);

	function stopPolling(): void {
		if (timer) {
			clearInterval(timer);
			timer = undefined;
		}
	}

	async function poll(): Promise<void> {
		try {
			const res = await fetch(resolve('/api/conversions'));
			if (!res.ok) return;
			const jobs = (await res.json()) as ConversionJobInfo[];
			const mine = jobs.find((j) => j.mediaId === mediaId) ?? null;
			jobState = mine;
			if (!mine || mine.state === 'done' || mine.state === 'error') stopPolling();
		} catch {
			// Best-effort — a failed poll just tries again on the next tick.
		}
	}

	function startPolling(): void {
		if (timer) return;
		timer = setInterval(poll, POLL_INTERVAL_MS);
	}

	async function generate(): Promise<void> {
		requesting = true;
		errorMessage = null;
		try {
			const res = await fetch(resolve('/api/fallback'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
			if (!res.ok) {
				const body = (await res.json().catch(() => null)) as { error?: string } | null;
				errorMessage = body?.error ?? 'Failed to start conversion.';
				return;
			}
			jobState = {
				mediaId,
				state: 'queued',
				kind: 'h264',
				progress: 0,
				error: null,
				updatedAt: Date.now() / 1000
			};
			startPolling();
		} finally {
			requesting = false;
		}
	}

	/** Forgets a failed job server-side, so its note doesn't come back on the next page load. */
	async function dismiss(): Promise<void> {
		jobState = null;
		errorMessage = null;
		try {
			await fetch(resolve('/api/conversions'), {
				method: 'DELETE',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ mediaId })
			});
		} catch {
			// Best-effort — it's already hidden locally; worst case it reappears after a reload.
		}
	}

	onDestroy(stopPolling);
</script>

{#if showButton}
	<button type="button" class="generate-fallback" onclick={generate} disabled={requesting}>
		{requesting ? 'Starting…' : failed ? 'Retry H.264 version' : 'Generate H.264 version'}
	</button>
{/if}
{#if failed}
	<span class="error">
		<span class="error-text" title={failed.error ?? undefined}>
			H.264 version failed — the original still plays.
		</span>
		<button type="button" class="dismiss" onclick={dismiss} aria-label="Dismiss">×</button>
	</span>
{:else if errorMessage}
	<span class="error">{errorMessage}</span>
{:else if h264Job}
	<ConversionStatus state={h264Job} />
{/if}

<style>
	.generate-fallback {
		padding: 0.4rem 0.75rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text);
		background: var(--surface-raised);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		cursor: pointer;
	}

	.generate-fallback:hover:not(:disabled) {
		color: #fff;
		background: var(--accent);
	}

	.generate-fallback:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.error {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		margin-top: 0.3rem;
		font-size: 0.75rem;
		color: var(--danger);
	}

	.error-text {
		cursor: help;
	}

	.dismiss {
		padding: 0 0.25rem;
		font-size: 0.9rem;
		line-height: 1;
		color: inherit;
		background: none;
		border: none;
		cursor: pointer;
	}
</style>
