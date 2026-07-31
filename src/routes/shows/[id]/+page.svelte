<script lang="ts">
	import { resolve } from '$app/paths';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import EpisodeList from '$lib/components/EpisodeList.svelte';
	import Player from '$lib/components/Player.svelte';
	import { tmdbImage, TMDB_BACKDROP_SIZE } from '$lib/tmdb';
	import type { Episode } from '$lib/server/catalog';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const backdropUrl = $derived(tmdbImage(data.show.backdropPath, TMDB_BACKDROP_SIZE));

	function seasonHref(season: number): string {
		return `${resolve('/shows/[id]', { id: data.show.mediaId })}?season=${season}`;
	}

	// TV mode plays fullscreen on /watch; desktop mode reveals the inline player on this page.
	function playHrefFor(ep: Episode): string {
		if (data.mode === 'tv') return resolve('/watch/[mediaId]', { mediaId: ep.mediaId });
		const base = `${resolve('/shows/[id]', { id: data.show.mediaId })}?season=${data.season}`;
		return `${base}&play=${ep.mediaId}`;
	}
</script>

<svelte:head>
	<title>{data.show.title} · Polystream</title>
</svelte:head>

<AppHeader profileName={data.profile.name} profileAvatar={data.profile.avatar} mode={data.mode} />

{#if !data.player}
	<div class="hero" style:background-image={backdropUrl ? `url(${backdropUrl})` : 'none'}>
		<div class="hero-content">
			<h1>
				{data.show.title}{#if data.show.year}<span class="year"> ({data.show.year})</span>{/if}
			</h1>
			{#if data.show.overview}
				<p class="overview">{data.show.overview}</p>
			{/if}
		</div>
	</div>
{/if}

<main>
	{#if data.player}
		<div class="player-wrap">
			<Player
				mediaId={data.player.mediaId}
				title={data.player.title}
				subtitles={data.player.subtitles}
				startAt={data.player.startAt}
				initialSubPref={data.player.subtitlePref}
				primaryVideoCodec={data.player.primaryVideoCodec}
				hasH264Variant={data.player.hasH264Variant}
				embeddedSubtitles={data.player.embeddedSubtitles}
				mode={data.mode ?? 'desktop'}
			/>
		</div>
	{/if}

	{#if data.show.seasons.length === 0}
		<p class="empty">No seasons found for this show yet.</p>
	{:else}
		<nav class="seasons">
			{#each data.show.seasons as s (s.mediaId)}
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- seasonHref() builds on resolve(), just appends the ?season= query param -->
				<a class="season-link" class:active={s.season === data.season} href={seasonHref(s.season)}>
					Season {s.season}
				</a>
			{/each}
		</nav>

		{#if data.episodes.length === 0}
			<p class="empty">No episodes found for this season.</p>
		{:else}
			<EpisodeList episodes={data.episodes} {playHrefFor} advanced={data.profile.advanced} />
		{/if}
	{/if}
</main>

<style>
	.hero {
		position: relative;
		display: flex;
		align-items: flex-end;
		min-height: 18rem;
		padding: var(--space-4) var(--space-3);
		background-color: var(--surface);
		background-size: cover;
		background-position: center;
	}

	.hero::before {
		content: '';
		position: absolute;
		inset: 0;
		background: linear-gradient(to top, var(--bg) 5%, rgba(11, 11, 15, 0.3) 60%, transparent 100%);
	}

	.hero-content {
		position: relative;
		max-width: 75rem;
		margin: 0 auto;
		width: 100%;
	}

	h1 {
		margin: 0 0 var(--space-2);
		font-size: 2rem;
		font-weight: 700;
	}

	.year {
		color: var(--text-muted);
		font-weight: 400;
	}

	.overview {
		max-width: 40rem;
		color: var(--text-muted);
	}

	main {
		max-width: 75rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}

	.player-wrap {
		max-width: 60rem;
		margin: 0 auto var(--space-4);
	}

	.seasons {
		display: flex;
		gap: var(--space-2);
		margin-bottom: var(--space-3);
	}

	.season-link {
		padding: 0.4rem 0.9rem;
		font-size: 0.9rem;
		color: var(--text-muted);
		text-decoration: none;
		background: var(--surface);
		border-radius: 999px;
	}

	.season-link:hover {
		color: var(--text);
	}

	.season-link.active {
		color: #fff;
		background: var(--accent);
	}

	.empty {
		color: var(--text-muted);
	}
</style>
