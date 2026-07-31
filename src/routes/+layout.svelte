<script lang="ts">
	import favicon from '$lib/assets/favicon.svg';

	let { children } = $props();
</script>

<svelte:head>
	<link rel="icon" href={favicon} />
</svelte:head>

{@render children()}

<style>
	:global(:root) {
		--bg: #0b0b0f;
		--surface: #16161d;
		--surface-raised: #1f1f29;
		--text: #f2f2f5;
		--text-muted: #9a9aa5;
		--accent: #6f7bf0;
		--accent-hover: #838ef2;
		--danger: #e0525f;
		--focus-ring: #8fb4ff;

		--space-1: 0.25rem;
		--space-2: 0.5rem;
		--space-3: 1rem;
		--space-4: 1.5rem;
		--space-5: 2.5rem;
	}

	:global(*),
	:global(*::before),
	:global(*::after) {
		box-sizing: border-box;
	}

	:global(html) {
		color-scheme: dark;
	}

	:global(body) {
		margin: 0;
		min-height: 100vh;
		background: var(--bg);
		color: var(--text);
		font-family:
			system-ui,
			-apple-system,
			'Segoe UI',
			Roboto,
			sans-serif;
	}

	:global(button),
	:global(input),
	:global(select) {
		font-family: inherit;
	}

	/* Strong, TV-legible-from-across-the-room focus indicator. */
	:global(:focus-visible) {
		outline: 3px solid var(--focus-ring);
		outline-offset: 2px;
		border-radius: 4px;
	}
</style>
