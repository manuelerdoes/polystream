<script lang="ts">
	import { resolve } from '$app/paths';
	import AppHeader from '$lib/components/AppHeader.svelte';
	import ConversionStatus from '$lib/components/ConversionStatus.svelte';
	import DownmixAudioButton from '$lib/components/DownmixAudioButton.svelte';
	import GenerateFallbackButton from '$lib/components/GenerateFallbackButton.svelte';
	import Player from '$lib/components/Player.svelte';
	import { tmdbImage, TMDB_POSTER_SIZE } from '$lib/tmdb';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	const posterUrl = $derived(tmdbImage(data.movie.posterPath, TMDB_POSTER_SIZE));

	// TV mode plays fullscreen on /watch; desktop mode reveals the inline player on this page.
	const playHref = $derived(
		data.mode === 'tv'
			? resolve('/watch/[mediaId]', { mediaId: data.movie.mediaId })
			: `${resolve('/movies/[id]', { id: data.movie.mediaId })}?play=1`
	);
</script>

<svelte:head>
	<title>{data.movie.title} · Polystream</title>
</svelte:head>

<AppHeader profileName={data.profile.name} profileAvatar={data.profile.avatar} mode={data.mode} />

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

	<div class="content">
		<div class="poster">
			{#if posterUrl}
				<img src={posterUrl} alt="" />
			{:else}
				<span class="placeholder">{data.movie.title}</span>
			{/if}
		</div>

		<div class="details">
			<h1>
				{data.movie.title}{#if data.movie.year}<span class="year"> ({data.movie.year})</span>{/if}
			</h1>
			{#if data.movie.overview}
				<p class="overview">{data.movie.overview}</p>
			{/if}
			{#if !data.player}
				<!-- Play is unconditional — see catalog.ts on why conversion state never gates it. -->
				<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- playHref is built from resolve() plus an appended query string -->
				<a class="play" href={playHref}>Play</a>
				<ConversionStatus state={data.conversionState} />
				<div class="fallback">
					<GenerateFallbackButton
						mediaId={data.movie.mediaId}
						videoCodec={data.primaryVideoCodec}
						hasH264Variant={data.hasH264Variant}
						conversionState={data.conversionState}
						advanced={data.profile.advanced}
					/>
					<DownmixAudioButton
						mediaId={data.movie.mediaId}
						videoCodec={data.primaryVideoCodec}
						audioIsMultichannel={data.audioIsMultichannel}
						conversionState={data.conversionState}
						advanced={data.profile.advanced}
					/>
				</div>
			{/if}
		</div>
	</div>
</main>

<style>
	main {
		max-width: 60rem;
		margin: 0 auto;
		padding: var(--space-4) var(--space-3);
	}

	.player-wrap {
		max-width: 60rem;
		margin: 0 auto var(--space-4);
	}

	.content {
		display: flex;
		gap: var(--space-4);
	}

	.poster {
		flex: 0 0 14rem;
		aspect-ratio: 2 / 3;
		overflow: hidden;
		border-radius: 10px;
		background: var(--surface-raised);
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
		font-weight: 600;
		color: var(--text-muted);
		background: linear-gradient(160deg, var(--surface-raised), var(--surface));
	}

	.details {
		flex: 1 1 auto;
		min-width: 0;
	}

	h1 {
		margin: 0 0 var(--space-2);
		font-size: 1.75rem;
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

	.play {
		display: inline-block;
		margin-top: var(--space-3);
		padding: 0.6rem 1.1rem;
		font-size: 0.9rem;
		font-weight: 600;
		color: #fff;
		text-decoration: none;
		background: var(--accent);
		border-radius: 8px;
	}

	.play:hover {
		background: var(--accent-hover);
	}

	.fallback {
		display: flex;
		flex-wrap: wrap;
		align-items: center;
		gap: var(--space-2);
		margin-top: var(--space-3);
	}
</style>
