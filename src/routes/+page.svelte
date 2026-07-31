<script lang="ts">
	import { resolve } from '$app/paths';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ConversionBar from '$lib/components/ConversionBar.svelte';
	import MediaRow from '$lib/components/MediaRow.svelte';
	import ScanBar from '$lib/components/ScanBar.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const isEmpty = $derived(data.movies.length === 0 && data.shows.length === 0);
</script>

<svelte:head>
	<title>Polystream</title>
</svelte:head>

<AppHeader profileName={data.profile.name} profileAvatar={data.profile.avatar} mode={data.mode} />

<main>
	<h1>Welcome back, {data.profile.name}</h1>

	<div class="status-row">
		<ScanBar scanState={data.scanState} advanced={data.profile.advanced} />
		<ConversionBar initialJobs={data.conversionJobs} />
	</div>

	{#if isEmpty}
		<div class="empty-state">
			<p>Your library is empty.</p>
			<p class="hint">Scan your WebDAV library above to bring in movies and TV shows.</p>
		</div>
	{:else}
		<MediaRow
			title="Continue Watching"
			items={data.continueWatching}
			hrefFor={(item) => resolve('/watch/[mediaId]', { mediaId: item.resumeMediaId })}
		/>

		<MediaRow
			title="Movies"
			seeAllHref={resolve('/movies')}
			items={data.movies}
			hrefFor={(m) => resolve('/movies/[id]', { id: m.mediaId })}
		/>

		<MediaRow
			title="TV Shows"
			seeAllHref={resolve('/shows')}
			items={data.shows}
			hrefFor={(s) => resolve('/shows/[id]', { id: s.mediaId })}
		/>
	{/if}
</main>

<style>
	main {
		display: flex;
		flex-direction: column;
		gap: var(--space-2);
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}

	h1 {
		margin: 0 0 var(--space-2);
		font-size: 1.75rem;
		font-weight: 600;
	}

	.status-row {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-3);
	}

	.empty-state {
		display: flex;
		flex-direction: column;
		gap: var(--space-1);
		padding: var(--space-5);
		text-align: center;
		color: var(--text-muted);
		background: var(--surface);
		border-radius: 12px;
	}

	.hint {
		font-size: 0.9rem;
	}
</style>
