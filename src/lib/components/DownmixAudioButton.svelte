<script lang="ts">
	// Manual "Downmix audio to stereo" button — mirrors GenerateFallbackButton.svelte exactly
	// (same poll loop, same deliberate avoidance of invalidateAll(), same reasoning). Shown only
	// for advanced profiles, only when the media's audio has a DEFINED multichannel layout (see
	// catalog.ts's audioIsMultichannel — the scanner already auto-fixes an UNDEFINED layout, so
	// this button only ever needs to handle the "technically valid but browser-hostile" case,
	// e.g. 5.1 AAC that Firefox won't play), and only when there's no conversion already running.

	import { onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import ConversionStatus from '$lib/components/ConversionStatus.svelte';
	import type { ConversionJobInfo } from '$lib/server/catalog';

	interface Props {
		mediaId: string;
		/** Primary video codec — the button only makes sense on H.264 titles (see showButton). */
		videoCodec: string | null;
		audioIsMultichannel: boolean;
		conversionState: ConversionJobInfo | null;
		advanced: boolean;
	}

	let { mediaId, videoCodec, audioIsMultichannel, conversionState, advanced }: Props = $props();

	// Seeded once from the server-loaded initial value, then owned by the poll loop below —
	// mirrors GenerateFallbackButton.svelte's same `untrack` pattern for the same reason.
	let jobState = $state<ConversionJobInfo | null>(untrack(() => conversionState));
	let requesting = $state(false);
	let errorMessage = $state<string | null>(null);
	let timer: ReturnType<typeof setInterval> | undefined;

	const POLL_INTERVAL_MS = 3000;

	// Only a remux-kind job on this media is relevant here — a lingering 'h264' job (irrelevant to
	// this button) is not this component's concern.
	const remuxJob = $derived(jobState?.kind === 'remux' ? jobState : null);
	// H.264 only: downmixing an HEVC primary's audio doesn't change its Firefox playability (HEVC
	// won't play there regardless — that's what the H.264 fallback is for), so the button would
	// just be noise on HEVC titles.
	const showButton = $derived(
		advanced && videoCodec === 'h264' && audioIsMultichannel && !remuxJob
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

	async function downmix(): Promise<void> {
		requesting = true;
		errorMessage = null;
		try {
			const res = await fetch(resolve('/api/downmix'), {
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
				kind: 'remux',
				progress: 0,
				error: null,
				updatedAt: Date.now() / 1000
			};
			startPolling();
		} finally {
			requesting = false;
		}
	}

	onDestroy(stopPolling);
</script>

{#if showButton}
	<button type="button" class="downmix-audio" onclick={downmix} disabled={requesting}>
		{requesting ? 'Starting…' : 'Downmix audio to stereo'}
	</button>
	{#if errorMessage}
		<span class="error">{errorMessage}</span>
	{/if}
{:else if remuxJob}
	<ConversionStatus state={remuxJob} />
{/if}

<style>
	.downmix-audio {
		padding: 0.4rem 0.75rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: var(--text);
		background: var(--surface-raised);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		cursor: pointer;
	}

	.downmix-audio:hover:not(:disabled) {
		color: #fff;
		background: var(--accent);
	}

	.downmix-audio:disabled {
		cursor: default;
		opacity: 0.6;
	}

	.error {
		display: block;
		margin-top: 0.3rem;
		font-size: 0.75rem;
		color: var(--danger);
	}
</style>
