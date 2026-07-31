<script lang="ts">
	// Responsive poster grid for /movies and /shows (phase-2.md §5/§6).

	import MediaCard from './MediaCard.svelte';
	import { tmdbImage, TMDB_POSTER_SIZE } from '$lib/tmdb';
	import { spatialNav } from '$lib/actions/spatialNav';
	import type { MediaCard as MediaCardData } from '$lib/server/catalog';

	interface Props {
		items: MediaCardData[];
		hrefFor: (item: MediaCardData) => string;
	}

	let { items, hrefFor }: Props = $props();
</script>

<div class="grid" use:spatialNav>
	{#each items as item (item.mediaId)}
		<MediaCard
			href={hrefFor(item)}
			title={item.title}
			year={item.year}
			imageUrl={tmdbImage(item.posterPath, TMDB_POSTER_SIZE)}
		/>
	{/each}
</div>

<style>
	.grid {
		display: grid;
		grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
		gap: var(--space-4) var(--space-3);
	}
</style>
