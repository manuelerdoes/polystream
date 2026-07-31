<script lang="ts">
	// Fullscreen-first host for TV mode (phase-3.md §7): black background, video fills the
	// viewport, no chrome besides a back link. Works fine for desktop too if navigated here
	// directly, but Play buttons only send desktop mode to the inline player.

	import { resolve } from '$app/paths';
	import ConversionStatus from '$lib/components/ConversionStatus.svelte';
	import Player from '$lib/components/Player.svelte';
	import type { PageData } from './$types';

	let { data }: { data: PageData } = $props();

	// Kept in sync with the player's auto-hiding control bar so the Back link fades out with it
	// (in TV fullscreen the controls hide during playback; the back chrome should follow).
	let controlsVisible = $state(true);
</script>

<svelte:head>
	<title>{data.media.title} · Polystream</title>
</svelte:head>

<div class="stage">
	<a class="back" class:hidden={!controlsVisible} href={resolve('/')}>‹ Back</a>
	{#if data.ready}
		<Player
			bind:controlsVisible
			mediaId={data.media.mediaId}
			title={data.media.title}
			showTitle={data.media.showTitle}
			subtitles={data.media.subtitles}
			startAt={data.startAt}
			initialSubPref={data.subtitlePref}
			primaryVideoCodec={data.media.variants?.primary.videoCodec ?? data.media.videoCodec}
			hasH264Variant={data.media.variants?.h264 != null}
			embeddedSubtitles={data.media.embeddedSubtitles}
			next={data.next}
			mode={data.mode ?? 'tv'}
		/>
	{:else}
		<div class="not-ready">
			<ConversionStatus state={data.media.conversionState} />
		</div>
	{/if}
</div>

<style>
	.stage {
		position: fixed;
		inset: 0;
		z-index: 10;
		display: flex;
		align-items: center;
		background: #000;
	}

	.not-ready {
		display: flex;
		width: 100%;
		align-items: center;
		justify-content: center;
	}

	.stage :global(.player) {
		width: 100%;
		height: 100%;
	}

	.stage :global(video) {
		width: 100%;
		height: 100%;
		aspect-ratio: auto;
		border-radius: 0;
	}

	.back {
		position: absolute;
		top: var(--space-2);
		left: var(--space-2);
		z-index: 2;
		padding: 0.4rem 0.75rem;
		font-size: 0.85rem;
		color: #fff;
		text-decoration: none;
		background: rgba(0, 0, 0, 0.5);
		border-radius: 6px;
		transition: opacity 0.2s ease;
	}

	.back:hover {
		background: rgba(0, 0, 0, 0.75);
	}

	.back.hidden {
		opacity: 0;
		pointer-events: none;
	}
</style>
