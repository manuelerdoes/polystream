<script
	lang="ts"
	generics="T extends { mediaId: string; title: string; year: number | null; posterPath: string | null }"
>
	// Horizontal scrolling row (home page sections + Continue Watching). Generic over any
	// item shape that looks like a MediaCard so it can also take ContinueWatchingItem, which
	// carries extra fields (mediaType, progress) that hrefFor/callers can still use.
	// Renders nothing when `items` is empty — the caller doesn't need to guard for that.

	import MediaCard from './MediaCard.svelte';
	import { tmdbImage, TMDB_POSTER_SIZE } from '$lib/tmdb';

	interface Props {
		title?: string;
		seeAllHref?: string;
		items: T[];
		hrefFor: (item: T) => string;
	}

	let { title = '', seeAllHref, items, hrefFor }: Props = $props();
</script>

{#if items.length > 0}
	<section>
		{#if title}
			<div class="heading">
				<h2>{title}</h2>
				{#if seeAllHref}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- seeAllHref is caller-supplied and already resolve()d -->
					<a class="see-all" href={seeAllHref}>See all</a>
				{/if}
			</div>
		{/if}

		<div class="row">
			{#each items as item (item.mediaId)}
				<div class="row-item">
					<MediaCard
						href={hrefFor(item)}
						title={item.title}
						year={item.year}
						imageUrl={tmdbImage(item.posterPath, TMDB_POSTER_SIZE)}
					/>
				</div>
			{/each}
		</div>
	</section>
{/if}

<style>
	section {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		margin-bottom: var(--space-4);
	}

	.heading {
		display: flex;
		align-items: baseline;
		justify-content: space-between;
	}

	h2 {
		margin: 0;
		font-size: 1.1rem;
		font-weight: 600;
	}

	.see-all {
		font-size: 0.85rem;
		color: var(--text-muted);
		text-decoration: none;
	}

	.see-all:hover {
		color: var(--text);
	}

	.row {
		display: flex;
		gap: var(--space-3);
		overflow-x: auto;
		padding-bottom: var(--space-2);
	}

	.row-item {
		flex: 0 0 150px;
	}
</style>
