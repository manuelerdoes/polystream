<script lang="ts">
	// Rescan button + scan status (home page only — phase-2.md §5/§6).

	import { enhance } from '$app/forms';
	import type { ScanState } from '$lib/server/catalog';

	interface Props {
		scanState: ScanState;
		// Rescan is an advanced-only action; non-advanced profiles see status only.
		advanced: boolean;
	}

	let { scanState, advanced }: Props = $props();

	let submitting = $state(false);

	function formatTime(epochSeconds: number | null): string {
		if (!epochSeconds) return 'never';
		return new Date(epochSeconds * 1000).toLocaleString();
	}
</script>

<div class="scan-bar">
	{#if advanced}
		<form
			method="POST"
			action="?/rescan"
			use:enhance={() => {
				submitting = true;
				return async ({ update }) => {
					await update();
					submitting = false;
				};
			}}
		>
			<button type="submit" disabled={submitting || scanState.status === 'running'}>
				{scanState.status === 'running' || submitting ? 'Scanning…' : 'Rescan library'}
			</button>
		</form>
	{/if}

	<span class="status">
		{scanState.itemCount} item{scanState.itemCount === 1 ? '' : 's'} · last scan: {formatTime(
			scanState.lastScanAt
		)}
		{#if scanState.status === 'error' && scanState.lastError}
			<span class="error"> · scan failed: {scanState.lastError}</span>
		{/if}
	</span>
</div>

<style>
	.scan-bar {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
		margin-bottom: var(--space-4);
	}

	button {
		padding: 0.5rem 0.9rem;
		font-size: 0.9rem;
		font-weight: 600;
		color: #fff;
		background: var(--accent);
		border: none;
		border-radius: 8px;
		cursor: pointer;
	}

	button:hover:not(:disabled) {
		background: var(--accent-hover);
	}

	button:disabled {
		opacity: 0.6;
		cursor: default;
	}

	.status {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	.error {
		color: var(--danger);
	}
</style>
