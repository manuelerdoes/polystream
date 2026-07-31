<script lang="ts">
	import { enhance } from '$app/forms';
	import type { ActionData } from './$types';

	let { form }: { form: ActionData } = $props();

	let submitting = $state(false);
</script>

<svelte:head>
	<title>Log in · Polystream</title>
</svelte:head>

<main>
	<form
		method="POST"
		use:enhance={() => {
			submitting = true;
			return async ({ update }) => {
				await update();
				submitting = false;
			};
		}}
	>
		<h1>Polystream</h1>

		<label for="password">Password</label>
		<!-- svelte-ignore a11y_autofocus -->
		<input
			id="password"
			name="password"
			type="password"
			autocomplete="current-password"
			autofocus
			required
		/>

		{#if form?.error}
			<p class="error" role="alert">{form.error}</p>
		{/if}

		<button type="submit" disabled={submitting}>
			{submitting ? 'Checking…' : 'Enter'}
		</button>
	</form>
</main>

<style>
	main {
		display: flex;
		min-height: 100vh;
		align-items: center;
		justify-content: center;
		padding: var(--space-3);
	}

	form {
		display: flex;
		width: 100%;
		max-width: 22rem;
		flex-direction: column;
		gap: var(--space-2);
		padding: var(--space-5);
		background: var(--surface);
		border-radius: 12px;
	}

	h1 {
		margin: 0 0 var(--space-3);
		text-align: center;
		font-size: 1.75rem;
		letter-spacing: 0.02em;
	}

	label {
		font-size: 0.85rem;
		color: var(--text-muted);
	}

	input {
		padding: 0.65rem 0.75rem;
		font-size: 1rem;
		color: var(--text);
		background: var(--bg);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 8px;
	}

	button {
		margin-top: var(--space-2);
		padding: 0.65rem 0.75rem;
		font-size: 1rem;
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

	.error {
		margin: 0;
		color: var(--danger);
		font-size: 0.9rem;
	}
</style>
