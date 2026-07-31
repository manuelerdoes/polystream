<script lang="ts">
	// Reached only via direct navigation (GET) — the header's own logout button POSTs here
	// directly and never renders this. Kept minimal: a single confirming action.
</script>

<svelte:head>
	<title>Log out · Polystream</title>
</svelte:head>

<main>
	<form method="POST">
		<p>Log out of Polystream?</p>
		<button type="submit">Log out</button>
	</form>
</main>

<style>
	main {
		display: flex;
		min-height: 100vh;
		align-items: center;
		justify-content: center;
	}

	form {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-5);
		background: var(--surface);
		border-radius: 12px;
	}

	button {
		padding: 0.65rem 1.25rem;
		font-size: 1rem;
		font-weight: 600;
		color: #fff;
		background: var(--danger);
		border: none;
		border-radius: 8px;
		cursor: pointer;
	}
</style>
