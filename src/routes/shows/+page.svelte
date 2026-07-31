<script lang="ts">
	import { resolve } from '$app/paths';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import PosterGrid from '$lib/components/PosterGrid.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();
</script>

<svelte:head>
	<title>TV Shows · Polystream</title>
</svelte:head>

<AppHeader profileName={data.profile.name} profileAvatar={data.profile.avatar} mode={data.mode} />

<main>
	<h1>TV Shows</h1>

	{#if data.shows.length === 0}
		<p class="empty">No TV shows in the library yet.</p>
	{:else}
		<PosterGrid items={data.shows} hrefFor={(s) => resolve('/shows/[id]', { id: s.mediaId })} />
	{/if}
</main>

<style>
	main {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}

	h1 {
		margin: 0 0 var(--space-3);
		font-size: 1.5rem;
		font-weight: 600;
	}

	.empty {
		color: var(--text-muted);
	}
</style>
