<script lang="ts">
	// Season's episodes: still + title + overview + a real Play link. `playHrefFor` picks the
	// target per the caller's device mode (inline ?play= reveal on desktop, /watch on TV).

	import { tmdbImage, TMDB_STILL_SIZE } from '$lib/tmdb';
	import { spatialNav } from '$lib/actions/spatialNav';
	import ConversionStatus from '$lib/components/ConversionStatus.svelte';
	import DownmixAudioButton from '$lib/components/DownmixAudioButton.svelte';
	import GenerateFallbackButton from '$lib/components/GenerateFallbackButton.svelte';
	import { isPlayReady } from '$lib/playReady';
	import type { Episode } from '$lib/server/catalog';

	interface Props {
		episodes: Episode[];
		playHrefFor: (episode: Episode) => string;
		/** Gates the per-episode "Generate H.264 version" button — see GenerateFallbackButton. */
		advanced: boolean;
	}

	let { episodes, playHrefFor, advanced }: Props = $props();
</script>

<ul class="list" use:spatialNav>
	{#each episodes as ep (ep.mediaId)}
		<li class="episode">
			<span class="still">
				{#if tmdbImage(ep.stillPath, TMDB_STILL_SIZE)}
					<img src={tmdbImage(ep.stillPath, TMDB_STILL_SIZE)} alt="" loading="lazy" />
				{:else}
					<span class="placeholder">E{ep.episode}</span>
				{/if}
			</span>

			<div class="info">
				<div class="heading">
					<span class="ep-number">{ep.episode}.</span>
					<span class="ep-title">{ep.title}</span>
				</div>
				{#if ep.overview}
					<p class="overview">{ep.overview}</p>
				{/if}
			</div>

			<div class="actions">
				{#if isPlayReady(ep.conversionState)}
					<!-- eslint-disable-next-line svelte/no-navigation-without-resolve -- playHrefFor is caller-supplied and already resolve()d -->
					<a class="play" href={playHrefFor(ep)}>Play</a>
				{:else}
					<ConversionStatus state={ep.conversionState} />
				{/if}
				<GenerateFallbackButton
					mediaId={ep.mediaId}
					videoCodec={ep.videoCodec}
					hasH264Variant={ep.hasH264Variant}
					conversionState={ep.conversionState}
					{advanced}
				/>
				<DownmixAudioButton
					mediaId={ep.mediaId}
					videoCodec={ep.videoCodec}
					audioIsMultichannel={ep.audioIsMultichannel}
					conversionState={ep.conversionState}
					{advanced}
				/>
			</div>
		</li>
	{/each}
</ul>

<style>
	.list {
		display: flex;
		flex-direction: column;
		gap: var(--space-3);
		margin: 0;
		padding: 0;
		list-style: none;
	}

	.episode {
		display: flex;
		align-items: center;
		gap: var(--space-3);
		padding: var(--space-2);
		background: var(--surface);
		border-radius: 10px;
	}

	.still {
		flex: 0 0 8rem;
		aspect-ratio: 16 / 9;
		overflow: hidden;
		border-radius: 6px;
		background: var(--surface-raised);
	}

	.still img {
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
		font-weight: 600;
		color: var(--text-muted);
	}

	.info {
		flex: 1 1 auto;
		min-width: 0;
	}

	.heading {
		display: flex;
		gap: var(--space-1);
		font-weight: 600;
	}

	.ep-number {
		color: var(--text-muted);
	}

	.overview {
		margin: var(--space-1) 0 0;
		font-size: 0.85rem;
		color: var(--text-muted);
		display: -webkit-box;
		-webkit-line-clamp: 2;
		line-clamp: 2;
		-webkit-box-orient: vertical;
		overflow: hidden;
	}

	.actions {
		display: flex;
		flex: 0 0 auto;
		flex-direction: column;
		align-items: flex-end;
		gap: var(--space-2);
	}

	.play {
		flex: 0 0 auto;
		padding: 0.5rem 0.85rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: #fff;
		text-decoration: none;
		background: var(--accent);
		border-radius: 8px;
	}

	.play:hover {
		background: var(--accent-hover);
	}
</style>
