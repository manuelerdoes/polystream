<script lang="ts">
	// Global "something is converting" indicator (phase-5-media-pipeline.md "UI status": "Reuse/
	// extend ScanBar for a global indicator"). Kept as a sibling component rather than folded into
	// ScanBar since it has its own polling lifecycle, independent of the rescan button.
	//
	// Polls /api/conversions only while at least one job is queued/running — once the library
	// settles, the interval stops itself rather than polling forever in the background.

	import { onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import type { ConversionJobInfo } from '$lib/server/catalog';

	interface Props {
		initialJobs: ConversionJobInfo[];
	}

	let { initialJobs }: Props = $props();

	// Seeded once from the server-loaded snapshot, then owned by the poll loop below — `untrack`
	// tells the compiler this one-time read is intentional (matches the pattern in Player.svelte).
	let jobs = $state<ConversionJobInfo[]>(untrack(() => initialJobs));
	let timer: ReturnType<typeof setInterval> | undefined;

	const POLL_INTERVAL_MS = 4000;

	const active = $derived(jobs.filter((j) => j.state === 'queued' || j.state === 'running'));
	const running = $derived(active.find((j) => j.state === 'running') ?? null);

	async function poll() {
		try {
			const res = await fetch(resolve('/api/conversions'));
			if (res.ok) jobs = (await res.json()) as ConversionJobInfo[];
		} catch {
			// Best-effort — a failed poll just tries again on the next tick.
		}
	}

	// Starts/stops the interval as `active` crosses zero, so the tab isn't quietly polling
	// forever once every conversion is done.
	$effect(() => {
		if (active.length > 0 && !timer) {
			timer = setInterval(poll, POLL_INTERVAL_MS);
		} else if (active.length === 0 && timer) {
			clearInterval(timer);
			timer = undefined;
		}
	});

	onDestroy(() => {
		if (timer) clearInterval(timer);
	});
</script>

{#if active.length > 0}
	<span class="conversion-bar">
		Converting {active.length} file{active.length === 1 ? '' : 's'}…
		{#if running}
			{Math.round(running.progress * 100)}%
		{:else}
			queued
		{/if}
	</span>
{/if}

<style>
	.conversion-bar {
		font-size: 0.85rem;
		color: var(--text-muted);
	}
</style>
