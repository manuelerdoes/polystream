<script lang="ts">
	// Per-title conversion status badge (phase-5-media-pipeline.md "UI status"): rendered NEXT TO
	// the Play control, never instead of it — conversion state doesn't gate playback (see
	// catalog.ts). It reports work in progress only; a failure is reported by whichever button
	// requested it (GenerateFallbackButton / DownmixAudioButton), which is also where the retry
	// and dismiss live. Renders nothing when there's no job, or it's finished, or it failed.

	import type { ConversionJobInfo } from '$lib/server/catalog';

	interface Props {
		state: ConversionJobInfo | null;
	}

	let { state }: Props = $props();

	const label = $derived.by(() => {
		if (!state) return null;
		switch (state.state) {
			case 'queued':
				return 'Queued';
			case 'running':
				return `Converting… ${Math.round(state.progress * 100)}%`;
			case 'error':
			case 'done':
				return null;
		}
	});
</script>

{#if label}
	<span class="conversion-status">{label}</span>
{/if}

<style>
	.conversion-status {
		display: inline-block;
		padding: 0.35rem 0.75rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: var(--text-muted);
		background: var(--surface-raised);
		border-radius: 8px;
	}
</style>
