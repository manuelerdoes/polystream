<script lang="ts">
	// Poster tile: TMDB image or a gradient+title placeholder. A real <a> so Tab/Enter and
	// D-pad (via the spatialNav action on the parent grid/row) work without extra plumbing.

	interface Props {
		href: string;
		title: string;
		year?: number | null;
		imageUrl?: string | null;
	}

	let { href, title, year = null, imageUrl = null }: Props = $props();

	// Keep the focused card in view when arrow-navigating a scrolling row/grid (phase-2.md §7).
	function handleFocus(event: FocusEvent) {
		(event.currentTarget as HTMLElement).scrollIntoView({ block: 'nearest', inline: 'nearest' });
	}
</script>

<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- href is a caller-supplied, already-resolve()d path (see PosterGrid/MediaRow hrefFor) -->
<a class="card" {href} onfocus={handleFocus}>
	<span class="poster">
		{#if imageUrl}
			<img src={imageUrl} alt="" loading="lazy" />
		{:else}
			<span class="placeholder">{title}</span>
		{/if}
	</span>
	<span class="title">
		{title}{#if year}<span class="year"> ({year})</span>{/if}
	</span>
</a>

<style>
	.card {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		width: 100%;
		text-decoration: none;
		color: var(--text);
	}

	.poster {
		position: relative;
		display: block;
		width: 100%;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		border-radius: 8px;
		background: var(--surface-raised);
		transition: outline-color 0.15s ease;
		outline: 2px solid transparent;
	}

	.card:hover .poster {
		outline-color: var(--accent);
	}

	.poster img {
		display: block;
		width: 100%;
		height: 100%;
		object-fit: cover;
	}

	.placeholder {
		display: flex;
		height: 100%;
		align-items: center;
		justify-content: center;
		padding: var(--space-2);
		text-align: center;
		font-size: 0.9rem;
		font-weight: 600;
		color: var(--text-muted);
		background: linear-gradient(160deg, var(--surface-raised), var(--surface));
	}

	.title {
		font-size: 0.85rem;
		line-height: 1.25;
		overflow: hidden;
		text-overflow: ellipsis;
		white-space: nowrap;
	}

	.year {
		color: var(--text-muted);
	}
</style>
