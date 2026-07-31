<script lang="ts">
	// Per-title conversion status badge (phase-5-media-pipeline.md "UI status"): shown in place of
	// a normal Play control while a file isn't direct-playable yet. Renders nothing once ready
	// (state is null, or a finished job) — see catalog.ts's isPlayReady for the same condition.

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
				return 'Conversion failed';
			case 'done':
				return null;
		}
	});
</script>

{#if label}
	<span
		class="conversion-status"
		class:error={state?.state === 'error'}
		title={state?.state === 'error' ? (state.error ?? undefined) : undefined}
	>
		{label}
	</span>
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

	.conversion-status.error {
		color: var(--danger);
	}
</style>
