<script lang="ts">
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();
</script>

<svelte:head>
	<title>Choose a device · Polystream</title>
</svelte:head>

<main>
	<h1>How are you watching?</h1>
	<p class="hint">You can change this anytime from the header.</p>

	{#if form?.error}
		<p class="error" role="alert">{form.error}</p>
	{/if}

	<div class="grid">
		<form method="POST" action="?/select">
			<input type="hidden" name="mode" value="desktop" />
			<button type="submit" class="tile">
				<span class="label">Desktop</span>
				<span class="desc">Inline player, mouse &amp; keyboard</span>
			</button>
		</form>

		<form method="POST" action="?/select">
			<input type="hidden" name="mode" value="tv" />
			<button type="submit" class="tile">
				<span class="label">TV</span>
				<span class="desc">Fullscreen player, D-pad friendly</span>
			</button>
		</form>
	</div>
</main>

<style>
	main {
		display: flex;
		min-height: 100vh;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-4);
		padding: var(--space-3);
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
		font-weight: 600;
	}

	.hint {
		margin: 0;
		color: var(--text-muted);
	}

	.error {
		color: var(--danger);
	}

	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		justify-content: center;
	}

	.tile {
		display: flex;
		width: 16rem;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-2);
		padding: var(--space-5);
		background: var(--surface);
		border: 2px solid transparent;
		border-radius: 16px;
		cursor: pointer;
		color: var(--text);
	}

	.tile:hover {
		border-color: var(--accent);
	}

	.label {
		font-size: 1.5rem;
		font-weight: 700;
	}

	.desc {
		font-size: 0.85rem;
		text-align: center;
		color: var(--text-muted);
	}
</style>
