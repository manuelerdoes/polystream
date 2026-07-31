<script lang="ts">
	// Custom player UI (phase-5-media-pipeline.md "Playback (client)"): a bare <video> (no native
	// `controls`) plus our own control bar, so playback looks identical on every browser/OS. Direct
	// -plays a pre-converted variant only — no HLS, no client remux, no "unsupported" fallback.
	// Stage 1 guarantees every title this component is asked to play is either already-compatible
	// H.264 or a HEVC primary with an H.264 fallback; a title still converting never reaches here
	// (the play hosts gate on catalog.ts's `isPlayReady` before rendering <Player>).
	//
	// Two things this component decides for itself, client-side only:
	//  1. which variant to request (`capabilities.ts`'s per-device HEVC probe, or the user's
	//     manual "compatibility version" override);
	//  2. the whole control bar (play/pause, seek incl. buffered ranges, volume, fullscreen, CC),
	//     since native `<video controls>` renders differently per browser/OS.
	// Subtitles/progress/resume are unchanged from Phase 3/4 — they only touch the <video> element
	// and its TextTracks, independent of which variant is playing.

	import { onDestroy, untrack } from 'svelte';
	import { resolve } from '$app/paths';
	import { goto } from '$app/navigation';
	import { spatialNav } from '$lib/actions/spatialNav';
	import { pickVariant, type DeviceMode, type VariantDecision } from '$lib/capabilities';
	import type { EmbeddedSubtitleRef, NextEpisode, SubtitleRef } from '$lib/server/catalog';
	import { tmdbImage, TMDB_STILL_SIZE } from '$lib/tmdb';

	interface SubtitlePref {
		enabled: boolean;
		language: string | null;
	}

	interface Props {
		mediaId: string;
		title: string;
		/** Parent show title for episodes; when set, shown as "showTitle: title". Null for movies. */
		showTitle?: string | null;
		subtitles: SubtitleRef[];
		/** Resume position in seconds; only seeked to if it's meaningfully short of the end. */
		startAt: number;
		initialSubPref: SubtitlePref;
		/** True codec of the PRIMARY variant from ffprobe (e.g. "h264"/"hevc"); null if unprobed. */
		primaryVideoCodec: string | null;
		/** Whether an H.264 fallback variant exists for this media. */
		hasH264Variant: boolean;
		embeddedSubtitles: EmbeddedSubtitleRef[];
		/** The play-ready episode to autoplay after this one; null for movies/last episode. */
		next?: NextEpisode | null;
		mode: DeviceMode;
		/** Bindable: whether the control bar is currently shown. Lets a host (the watch page) hide
		 *  its own chrome — e.g. the Back link — in lockstep with the auto-hiding controls. */
		controlsVisible?: boolean;
	}

	let {
		mediaId,
		title,
		showTitle = null,
		subtitles,
		startAt,
		initialSubPref,
		primaryVideoCodec,
		hasH264Variant,
		embeddedSubtitles,
		next = null,
		mode,
		controlsVisible = $bindable(true)
	}: Props = $props();

	let playerRoot: HTMLDivElement | undefined = $state();
	let videoEl: HTMLVideoElement | undefined = $state();
	let seekBarEl: HTMLDivElement | undefined = $state();

	let menuOpen = $state(false);

	// ---- Variant selection (HEVC primary vs H.264 fallback) --------------------------------

	// null until the client-only probe (mediaCapabilities.decodingInfo, browser-only — see
	// capabilities.ts) resolves. No <video> src is set before then, so we never fire a request a
	// device-incapable decision would immediately have to undo.
	let autoVariant = $state<VariantDecision | null>(null);
	// Manual "use compatibility version" override (phase-5-media-pipeline.md: "a manual toggle in
	// the player as a safety valve"). Only ever toggled on when `hasH264Variant` is true — the
	// button that flips this is itself hidden otherwise.
	let manualCompat = $state(false);

	const effectiveVariant = $derived<VariantDecision | null>(manualCompat ? 'h264' : autoVariant);

	function variantSrc(variant: 'primary' | 'h264'): string {
		const base = resolve('/stream/[mediaId]', { mediaId });
		return variant === 'h264' ? `${base}?v=h264` : base;
	}

	const src = $derived.by(() => {
		if (effectiveVariant === 'primary') return variantSrc('primary');
		if (effectiveVariant === 'h264') return variantSrc('h264');
		return undefined; // still probing, or 'unavailable'
	});

	// Runs once per mount — mediaCapabilities doesn't exist during SSR.
	$effect(() => {
		void pickVariant({ primaryVideoCodec, hasH264Variant }).then((decision) => {
			autoVariant = decision;
		});
	});

	// A compat-toggle flip swaps <video src>, which resets playback position — remember where we
	// were so handleLoadedMetadata can resume there instead of replaying from `startAt`.
	let pendingResumeAt: number | null = null;

	function toggleCompat() {
		if (videoEl && Number.isFinite(videoEl.currentTime)) pendingResumeAt = videoEl.currentTime;
		manualCompat = !manualCompat;
	}

	// ---- Subtitles (unchanged from Phase 3/4) -----------------------------------------------

	interface SubtitleOption {
		/** Unique across both external + embedded tracks — also used as the <track> label. */
		key: string;
		label: string;
		lang: string | null;
		url: string;
	}

	function subtitleUrl(lang: string): string {
		return resolve('/subtitles/[mediaId]/[lang]', { mediaId, lang });
	}

	function embeddedSubtitleUrl(index: number): string {
		return resolve('/subtitles/[mediaId]/embedded/[index]', { mediaId, index: String(index) });
	}

	// Embedded + external subtitles of the same language must stay distinguishable in the menu
	// (phase-4.md §5) — the " (embedded)" suffix on the label doubles as the unique <track>
	// label we match against when toggling TextTrack.mode.
	const subtitleOptions = $derived<SubtitleOption[]>([
		...subtitles.map((sub) => ({
			key: `ext:${sub.lang}`,
			label: sub.lang.toUpperCase(),
			lang: sub.lang,
			url: subtitleUrl(sub.lang)
		})),
		...embeddedSubtitles
			.filter((sub) => sub.text)
			.map((sub) => ({
				key: `emb:${sub.index}`,
				label: `${sub.lang ? sub.lang.toUpperCase() : `Track ${sub.index + 1}`} (embedded)`,
				lang: sub.lang,
				url: embeddedSubtitleUrl(sub.index)
			}))
	]);

	// Seeded once from the server-loaded pref, then owned by the user's in-player choices —
	// `untrack` tells the compiler this one-time read is intentional, not a missed dependency.
	// The stored pref only has a language, not a source, so on first load we just take whichever
	// option matches that language first (external before embedded).
	let activeKey = $state<string | null>(
		untrack(() =>
			initialSubPref.enabled
				? (subtitleOptions.find((opt) => opt.lang === initialSubPref.language)?.key ?? null)
				: null
		)
	);

	// Reflects `activeKey` onto the actual TextTrack objects (the <track> elements only set
	// the initial state; toggling afterwards has to go through TextTrack.mode directly). Tracks
	// are matched by label, since that's what we made unique above (language alone collides for
	// an embedded + external track of the same language).
	function applySubtitleTracks() {
		if (!videoEl) return;
		const activeLabel = subtitleOptions.find((opt) => opt.key === activeKey)?.label ?? null;
		for (const track of videoEl.textTracks) {
			track.mode = track.label === activeLabel ? 'showing' : 'disabled';
		}
	}

	$effect(() => {
		if (videoEl) applySubtitleTracks();
	});

	function selectSubtitle(key: string | null) {
		activeKey = key;
		menuOpen = false;
		applySubtitleTracks();
		const option = subtitleOptions.find((opt) => opt.key === key);
		void persistSubtitlePref(option?.lang ?? null);
	}

	async function persistSubtitlePref(lang: string | null) {
		try {
			await fetch(resolve('/api/subtitle-pref'), {
				method: 'POST',
				headers: { 'Content-Type': 'application/json' },
				body: JSON.stringify({ enabled: lang !== null, language: lang })
			});
		} catch {
			// Best-effort — a failed pref save shouldn't interrupt playback.
		}
	}

	// ---- Playback state (drives the control bar) --------------------------------------------

	let playing = $state(false);
	let currentTime = $state(0);
	let duration = $state(0);
	let buffered = $state<{ start: number; end: number }[]>([]);
	let volume = $state(1);
	let muted = $state(false);
	let fullscreen = $state(false);
	let seeking = $state(false);

	function formatTime(totalSeconds: number): string {
		if (!Number.isFinite(totalSeconds) || totalSeconds < 0) return '0:00';
		const whole = Math.floor(totalSeconds);
		const hours = Math.floor(whole / 3600);
		const minutes = Math.floor((whole % 3600) / 60);
		const seconds = whole % 60;
		const ss = String(seconds).padStart(2, '0');
		if (hours > 0) return `${hours}:${String(minutes).padStart(2, '0')}:${ss}`;
		return `${minutes}:${ss}`;
	}

	const progressPct = $derived(duration > 0 ? (currentTime / duration) * 100 : 0);
	const bufferedRanges = $derived(
		duration > 0
			? buffered.map((r) => ({
					leftPct: (r.start / duration) * 100,
					widthPct: ((r.end - r.start) / duration) * 100
				}))
			: []
	);

	function handleLoadedMetadata() {
		if (!videoEl) return;
		duration = videoEl.duration;
		const resumeAt = pendingResumeAt ?? startAt;
		pendingResumeAt = null;
		if (resumeAt > 0 && resumeAt < videoEl.duration * 0.95) {
			videoEl.currentTime = resumeAt;
			currentTime = resumeAt;
		}
		applySubtitleTracks();
		// Arrived here via "Up next" auto-advance — start the new episode without a click. If the
		// browser blocks it (no user activation), it stays paused and the user presses play.
		if (autoplayOnLoad) {
			autoplayOnLoad = false;
			void videoEl.play().catch(() => {});
		}
	}

	function updateBuffered() {
		if (!videoEl) return;
		const ranges: { start: number; end: number }[] = [];
		for (let i = 0; i < videoEl.buffered.length; i++) {
			ranges.push({ start: videoEl.buffered.start(i), end: videoEl.buffered.end(i) });
		}
		buffered = ranges;
	}

	function togglePlay() {
		if (!videoEl) return;
		if (videoEl.paused) void videoEl.play();
		else videoEl.pause();
	}

	function clamp(value: number, min: number, max: number): number {
		return Math.min(max, Math.max(min, value));
	}

	function seekBy(deltaSeconds: number) {
		if (!videoEl || !Number.isFinite(duration) || duration <= 0) return;
		const target = clamp(videoEl.currentTime + deltaSeconds, 0, duration);
		videoEl.currentTime = target;
		currentTime = target;
	}

	function seekToClientX(clientX: number) {
		if (!videoEl || !seekBarEl || duration <= 0) return;
		const rect = seekBarEl.getBoundingClientRect();
		const pct = clamp((clientX - rect.left) / rect.width, 0, 1);
		const target = pct * duration;
		videoEl.currentTime = target;
		currentTime = target;
	}

	function handleSeekPointerDown(event: PointerEvent) {
		seeking = true;
		seekBarEl?.setPointerCapture(event.pointerId);
		seekToClientX(event.clientX);
	}

	function handleSeekPointerMove(event: PointerEvent) {
		if (!seeking) return;
		seekToClientX(event.clientX);
	}

	function handleSeekPointerUp(event: PointerEvent) {
		seeking = false;
		seekBarEl?.releasePointerCapture(event.pointerId);
	}

	// The seek bar handles its own arrow keys and stops propagation — otherwise both this AND
	// spatialNav's container-level listener would react to the same keypress (spatialNav would
	// try to move focus off the bar instead of seeking).
	function handleSeekKeydown(event: KeyboardEvent) {
		if (event.key !== 'ArrowRight' && event.key !== 'ArrowLeft') return;
		event.preventDefault();
		event.stopPropagation();
		// stopPropagation keeps this off the global spatial-nav — but it also keeps it from bubbling
		// to the root's noteActivity, so reset the auto-hide countdown here or a long scrub on TV
		// would hide the bar and yank focus mid-seek.
		noteActivity();
		const step = event.shiftKey ? 10 : 5;
		seekBy(event.key === 'ArrowRight' ? step : -step);
	}

	function setVolume(next: number) {
		if (!videoEl) return;
		videoEl.volume = clamp(next, 0, 1);
		if (videoEl.volume > 0 && videoEl.muted) videoEl.muted = false;
		syncVolumeState();
	}

	function syncVolumeState() {
		if (!videoEl) return;
		volume = videoEl.volume;
		muted = videoEl.muted;
	}

	function toggleMute() {
		if (!videoEl) return;
		videoEl.muted = !videoEl.muted;
		syncVolumeState();
	}

	function handleVolumeInput(event: Event) {
		setVolume(Number((event.currentTarget as HTMLInputElement).value));
	}

	function handleFullscreenChange() {
		fullscreen = document.fullscreenElement === playerRoot;
	}

	async function toggleFullscreen() {
		if (!playerRoot) return;
		try {
			if (document.fullscreenElement === playerRoot) {
				await document.exitFullscreen();
			} else {
				await playerRoot.requestFullscreen();
			}
		} catch {
			// Fullscreen can reject (no user gesture, browser policy) — not worth surfacing an error
			// for what's a nice-to-have control.
		}
	}

	// ---- Auto-hiding controls ------------------------------------------------------------------

	const AUTOHIDE_MS = 3000;
	let hideTimer: ReturnType<typeof setTimeout> | undefined;
	// Set while we programmatically move focus to the player root on hide (TV), so the resulting
	// focusin isn't counted as "activity" and doesn't immediately re-show the controls.
	let suppressActivity = false;

	function clearHideTimer() {
		if (hideTimer !== undefined) {
			clearTimeout(hideTimer);
			hideTimer = undefined;
		}
	}

	function hideControls() {
		controlsVisible = false;
		hideTimer = undefined;
		// On TV a control (button/seek bar) may hold D-pad focus; hiding it would leave focus on an
		// invisible element. Move focus to the unstyled, tabindex=-1 player root so nothing appears
		// focused, while keydowns still route to handleRootKeydown (Enter = play/pause, Left/Right =
		// seek, Up/Down = reopen the bar).
		if (mode === 'tv' && playerRoot) {
			suppressActivity = true;
			playerRoot.focus();
			suppressActivity = false;
		}
	}

	// Any interaction anywhere in the player (mousemove, keydown, pointerdown, focus — these all
	// bubble up from the control bar's own children) resets the countdown. TV gets the same 3s
	// auto-hide as desktop now; the user brings the bar back with any key — and on TV, Up/Down also
	// hand focus to the controls so the CC/fullscreen buttons stay reachable (see handleRootKeydown).
	function noteActivity() {
		if (suppressActivity) return;
		controlsVisible = true;
		clearHideTimer();
		if (playing) {
			hideTimer = setTimeout(hideControls, AUTOHIDE_MS);
		}
	}

	// Always visible when paused (phase-5-media-pipeline.md); restarts the countdown on resume.
	$effect(() => {
		if (playing) noteActivity();
		else {
			controlsVisible = true;
			clearHideTimer();
		}
	});

	onDestroy(clearHideTimer);

	// ---- Keyboard shortcuts --------------------------------------------------------------------

	// Global player shortcuts only fire when the video itself (or the player container) has
	// focus — when a specific control (button/slider) is focused, its own handling (native for
	// buttons/range inputs, handleSeekKeydown for the seek bar) applies instead, and arrow keys
	// are left for spatialNav's D-pad focus movement between controls.
	function handleRootKeydown(event: KeyboardEvent) {
		noteActivity();
		if (event.target !== videoEl && event.target !== playerRoot) return;

		switch (event.key) {
			case ' ':
			case 'Spacebar':
			case 'Enter':
				event.preventDefault();
				togglePlay();
				break;
			case 'ArrowRight':
				event.preventDefault();
				seekBy(event.shiftKey ? 10 : 5);
				break;
			case 'ArrowLeft':
				event.preventDefault();
				seekBy(event.shiftKey ? -10 : -5);
				break;
			case 'ArrowUp':
			case 'ArrowDown':
				event.preventDefault();
				// TV: reveal the bar and land D-pad focus on it (the seek bar), from where spatial-nav
				// reaches the CC/subtitle and fullscreen buttons. Desktop keeps arrow-key volume.
				if (mode === 'tv') {
					seekBarEl?.focus();
				} else {
					setVolume(event.key === 'ArrowUp' ? volume + 0.05 : volume - 0.05);
				}
				break;
			case 'm':
			case 'M':
				toggleMute();
				break;
			case 'f':
			case 'F':
				void toggleFullscreen();
				break;
		}
	}

	function handleVideoClick() {
		videoEl?.focus();
		togglePlay();
	}

	// ---- Progress reporting (unchanged from Phase 3) ------------------------------------------

	const PROGRESS_INTERVAL_SECONDS = 15;
	let lastReportedAt = 0;

	function reportProgress(useBeacon = false) {
		if (!videoEl || !Number.isFinite(videoEl.duration)) return;
		const payload = JSON.stringify({
			mediaId,
			position: videoEl.currentTime,
			duration: videoEl.duration
		});

		if (useBeacon && navigator.sendBeacon) {
			navigator.sendBeacon(
				resolve('/api/progress'),
				new Blob([payload], { type: 'application/json' })
			);
			return;
		}

		void fetch(resolve('/api/progress'), {
			method: 'POST',
			headers: { 'Content-Type': 'application/json' },
			body: payload,
			keepalive: true
		});
	}

	function handleTimeUpdate() {
		if (!videoEl) return;
		currentTime = videoEl.currentTime;
		if (videoEl.currentTime - lastReportedAt >= PROGRESS_INTERVAL_SECONDS) {
			lastReportedAt = videoEl.currentTime;
			reportProgress();
		}
	}

	function handlePlay() {
		playing = true;
	}

	function handlePause() {
		playing = false;
		reportProgress();
	}

	function handleVisibilityChange() {
		if (document.visibilityState === 'hidden') reportProgress(true);
	}

	function handleBeforeUnload() {
		reportProgress(true);
	}

	// ---- Autoplay next episode ("Up next" card) ----------------------------------------------

	const UP_NEXT_COUNTDOWN = 10;
	let showUpNext = $state(false);
	let countdown = $state(UP_NEXT_COUNTDOWN);
	let countdownTimer: ReturnType<typeof setInterval> | undefined;

	const nextStill = $derived(next ? tmdbImage(next.stillPath, TMDB_STILL_SIZE) : null);

	function clearCountdown() {
		if (countdownTimer !== undefined) {
			clearInterval(countdownTimer);
			countdownTimer = undefined;
		}
	}

	// Set right before auto-advancing so the next episode starts playing on its own. The /watch
	// route reuses this Player instance across the param change, so the flag survives the goto and
	// is consumed by handleLoadedMetadata once the new src has loaded.
	let autoplayOnLoad = false;

	function goToNext() {
		if (!next) return;
		clearCountdown();
		showUpNext = false;
		autoplayOnLoad = true;
		void goto(resolve('/watch/[mediaId]', { mediaId: next.mediaId }));
	}

	function cancelUpNext() {
		clearCountdown();
		showUpNext = false;
	}

	// On end, report the final position and — if there's a play-ready successor — bring up the
	// countdown card. No successor (movie / last episode / still-converting next) just leaves the
	// video paused on its last frame with controls shown.
	function handleEnded() {
		reportProgress();
		if (!next) return;
		countdown = UP_NEXT_COUNTDOWN;
		showUpNext = true;
		clearCountdown();
		countdownTimer = setInterval(() => {
			countdown -= 1;
			if (countdown <= 0) goToNext();
		}, 1000);
	}

	onDestroy(clearCountdown);
</script>

<svelte:window onvisibilitychange={handleVisibilityChange} onbeforeunload={handleBeforeUnload} />
<svelte:document onfullscreenchange={handleFullscreenChange} />

<!-- role="toolbar" (rather than a plain non-interactive <div>) satisfies a11y-no-noninteractive-
     -element-interactions for the mousemove/pointerdown/keydown listeners below, which only
     drive the auto-hiding control bar + global keyboard shortcuts — every actual control inside
     is its own real, focusable, interactive element (button/slider). tabindex="-1" keeps the
     wrapper itself out of tab/D-pad order (spatialNav ignores tabindex="-1" the same way). -->
<div
	class="player"
	class:controls-hidden={!controlsVisible}
	role="toolbar"
	aria-label="Video player"
	tabindex="-1"
	bind:this={playerRoot}
	use:spatialNav
	onmousemove={noteActivity}
	onpointerdown={noteActivity}
	onfocusin={noteActivity}
	onkeydown={handleRootKeydown}
>
	{#if title}
		<div class="title-overlay">{showTitle ? `${showTitle}: ${title}` : title}</div>
	{/if}

	{#if effectiveVariant === 'unavailable'}
		<div class="status-overlay">
			This video needs a compatibility version — still converting or not available yet.
		</div>
	{:else}
		<!-- svelte-ignore a11y_media_has_caption -->
		<video
			bind:this={videoEl}
			tabindex="0"
			preload="metadata"
			{src}
			onclick={handleVideoClick}
			onloadedmetadata={handleLoadedMetadata}
			ontimeupdate={handleTimeUpdate}
			onprogress={updateBuffered}
			onplay={handlePlay}
			onpause={handlePause}
			onended={handleEnded}
			onvolumechange={syncVolumeState}
		>
			{#each subtitleOptions as opt (opt.key)}
				<track kind="subtitles" srclang={opt.lang ?? ''} label={opt.label} src={opt.url} />
			{/each}
		</video>

		<div class="controls">
			<div
				class="seek-bar"
				bind:this={seekBarEl}
				role="slider"
				tabindex="0"
				aria-label="Seek"
				aria-valuemin="0"
				aria-valuemax={duration}
				aria-valuenow={currentTime}
				aria-valuetext={`${formatTime(currentTime)} of ${formatTime(duration)}`}
				onpointerdown={handleSeekPointerDown}
				onpointermove={handleSeekPointerMove}
				onpointerup={handleSeekPointerUp}
				onkeydown={handleSeekKeydown}
			>
				{#each bufferedRanges as range, i (i)}
					<div class="buffered" style:left="{range.leftPct}%" style:width="{range.widthPct}%"></div>
				{/each}
				<div class="played" style:width="{progressPct}%"></div>
				<div class="thumb" style:left="{progressPct}%"></div>
			</div>

			<div class="control-row">
				<button
					type="button"
					class="icon-btn"
					aria-label={playing ? 'Pause' : 'Play'}
					onclick={togglePlay}
				>
					{playing ? '⏸' : '▶'}
				</button>

				<span class="time">{formatTime(currentTime)} / {formatTime(duration)}</span>

				<div class="volume">
					<button
						type="button"
						class="icon-btn"
						aria-label={muted || volume === 0 ? 'Unmute' : 'Mute'}
						onclick={toggleMute}
					>
						{muted || volume === 0 ? '🔇' : '🔊'}
					</button>
					<input
						class="volume-range"
						type="range"
						min="0"
						max="1"
						step="0.01"
						aria-label="Volume"
						value={muted ? 0 : volume}
						oninput={handleVolumeInput}
					/>
				</div>

				<div class="spacer"></div>

				{#if hasH264Variant}
					<button type="button" class="text-btn" aria-pressed={manualCompat} onclick={toggleCompat}>
						{manualCompat ? 'Use best quality' : 'Use compatibility version'}
					</button>
				{/if}

				{#if subtitleOptions.length > 0}
					<div class="subtitle-menu">
						<button type="button" class="text-btn" onclick={() => (menuOpen = !menuOpen)}>
							CC {activeKey
								? (subtitleOptions.find((opt) => opt.key === activeKey)?.label ?? 'Off')
								: 'Off'}
						</button>
						{#if menuOpen}
							<ul class="menu">
								<li>
									<button
										type="button"
										class:active={activeKey === null}
										onclick={() => selectSubtitle(null)}
									>
										Off
									</button>
								</li>
								{#each subtitleOptions as opt (opt.key)}
									<li>
										<button
											type="button"
											class:active={activeKey === opt.key}
											onclick={() => selectSubtitle(opt.key)}
										>
											{opt.label}
										</button>
									</li>
								{/each}
							</ul>
						{/if}
					</div>
				{/if}

				<button
					type="button"
					class="icon-btn"
					aria-label={fullscreen ? 'Exit fullscreen' : 'Fullscreen'}
					onclick={toggleFullscreen}
				>
					{fullscreen ? '⤢' : '⛶'}
				</button>
			</div>
		</div>

		{#if showUpNext && next}
			<div class="up-next" role="dialog" aria-label="Up next">
				<span class="up-next-label">Up next · S{next.season} E{next.episode}</span>
				<div class="up-next-body">
					{#if nextStill}
						<img class="up-next-still" src={nextStill} alt="" />
					{/if}
					<span class="up-next-title">{next.title}</span>
				</div>
				<div class="up-next-actions">
					<!-- svelte-ignore a11y_autofocus -->
					<button type="button" class="up-next-play" onclick={goToNext} autofocus>
						▶ Play now · {countdown}
					</button>
					<button type="button" class="up-next-cancel" onclick={cancelUpNext}>Cancel</button>
				</div>
			</div>
		{/if}
	{/if}
</div>

<style>
	.player {
		position: relative;
		width: 100%;
		background: #000;
		border-radius: 10px;
		overflow: hidden;
	}

	video {
		display: block;
		width: 100%;
		aspect-ratio: 16 / 9;
		background: #000;
		outline: none;
	}

	.title-overlay {
		position: absolute;
		top: var(--space-2);
		left: 50%;
		transform: translateX(-50%);
		max-width: min(70%, 60ch);
		padding: 0.3rem 0.6rem;
		font-size: 0.9rem;
		font-weight: 600;
		text-align: center;
		white-space: nowrap;
		overflow: hidden;
		text-overflow: ellipsis;
		color: #fff;
		background: rgba(0, 0, 0, 0.55);
		border-radius: 6px;
		pointer-events: none;
		z-index: 1;
		opacity: 1;
		transition: opacity 0.2s ease;
	}

	.status-overlay {
		position: absolute;
		inset: 0;
		z-index: 2;
		display: flex;
		align-items: center;
		justify-content: center;
		padding: var(--space-4);
		text-align: center;
		font-size: 1rem;
		font-weight: 600;
		color: #fff;
		background: rgba(0, 0, 0, 0.75);
		aspect-ratio: 16 / 9;
	}

	.controls {
		position: absolute;
		right: 0;
		bottom: 0;
		left: 0;
		z-index: 1;
		display: flex;
		flex-direction: column;
		gap: 0.4rem;
		padding: var(--space-3) var(--space-2) var(--space-2);
		background: linear-gradient(to top, rgba(0, 0, 0, 0.8), rgba(0, 0, 0, 0));
		opacity: 1;
		transition:
			opacity 0.2s ease,
			transform 0.2s ease;
	}

	.player.controls-hidden .controls {
		opacity: 0;
		transform: translateY(0.5rem);
		pointer-events: none;
	}

	.player.controls-hidden .title-overlay {
		opacity: 0;
	}

	.player.controls-hidden {
		cursor: none;
	}

	.seek-bar {
		position: relative;
		height: 0.9rem;
		cursor: pointer;
		touch-action: none;
	}

	.seek-bar::before {
		content: '';
		position: absolute;
		top: 50%;
		right: 0;
		left: 0;
		height: 0.3rem;
		background: rgba(255, 255, 255, 0.25);
		border-radius: 999px;
		transform: translateY(-50%);
	}

	.buffered,
	.played {
		position: absolute;
		top: 50%;
		height: 0.3rem;
		background: rgba(255, 255, 255, 0.45);
		border-radius: 999px;
		transform: translateY(-50%);
	}

	.played {
		left: 0;
		background: var(--accent);
	}

	.thumb {
		position: absolute;
		top: 50%;
		width: 0.8rem;
		height: 0.8rem;
		background: #fff;
		border-radius: 50%;
		transform: translate(-50%, -50%);
		box-shadow: 0 0 0 2px rgba(0, 0, 0, 0.3);
	}

	.seek-bar:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.control-row {
		display: flex;
		align-items: center;
		gap: var(--space-2);
	}

	.icon-btn {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2.2rem;
		height: 2.2rem;
		font-size: 1.1rem;
		color: #fff;
		background: transparent;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}

	.icon-btn:hover,
	.icon-btn:focus-visible {
		background: rgba(255, 255, 255, 0.15);
	}

	.text-btn {
		padding: 0.4rem 0.7rem;
		font-size: 0.8rem;
		font-weight: 600;
		color: #fff;
		background: rgba(255, 255, 255, 0.12);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		cursor: pointer;
		white-space: nowrap;
	}

	.text-btn:hover,
	.text-btn:focus-visible {
		background: rgba(255, 255, 255, 0.25);
	}

	button:focus-visible {
		outline: 2px solid var(--accent);
		outline-offset: 2px;
	}

	.time {
		font-size: 0.8rem;
		font-variant-numeric: tabular-nums;
		color: #fff;
		white-space: nowrap;
	}

	.volume {
		display: flex;
		align-items: center;
		gap: 0.3rem;
	}

	.volume-range {
		width: 5rem;
		accent-color: var(--accent);
	}

	.spacer {
		flex: 1 1 auto;
	}

	.subtitle-menu {
		position: relative;
	}

	.menu {
		position: absolute;
		right: 0;
		bottom: calc(100% + 0.4rem);
		display: flex;
		flex-direction: column;
		gap: 0.15rem;
		margin: 0;
		padding: 0.3rem;
		list-style: none;
		background: rgba(0, 0, 0, 0.9);
		border-radius: 8px;
	}

	.menu button {
		padding: 0.35rem 0.75rem;
		font-size: 0.8rem;
		text-align: left;
		color: var(--text-muted);
		background: none;
		border: none;
		border-radius: 4px;
		cursor: pointer;
		white-space: nowrap;
	}

	.menu button:hover {
		background: rgba(255, 255, 255, 0.1);
		color: #fff;
	}

	.menu button.active {
		color: var(--accent-hover);
		font-weight: 700;
	}

	.up-next {
		position: absolute;
		right: var(--space-3);
		bottom: var(--space-3);
		z-index: 3;
		display: flex;
		flex-direction: column;
		gap: 0.5rem;
		width: min(22rem, 70vw);
		padding: var(--space-3);
		color: #fff;
		background: rgba(0, 0, 0, 0.85);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 10px;
		box-shadow: 0 8px 30px rgba(0, 0, 0, 0.5);
	}

	.up-next-label {
		font-size: 0.72rem;
		font-weight: 700;
		text-transform: uppercase;
		letter-spacing: 0.05em;
		color: var(--text-muted);
	}

	.up-next-body {
		display: flex;
		align-items: center;
		gap: 0.6rem;
	}

	.up-next-still {
		width: 5.5rem;
		aspect-ratio: 16 / 9;
		object-fit: cover;
		border-radius: 6px;
		flex-shrink: 0;
	}

	.up-next-title {
		font-size: 0.95rem;
		font-weight: 600;
		line-height: 1.25;
	}

	.up-next-actions {
		display: flex;
		gap: 0.5rem;
	}

	.up-next-play {
		flex: 1 1 auto;
		padding: 0.5rem 0.8rem;
		font-size: 0.85rem;
		font-weight: 700;
		color: #000;
		background: var(--accent);
		border: none;
		border-radius: 6px;
		cursor: pointer;
		white-space: nowrap;
	}

	.up-next-play:hover,
	.up-next-play:focus-visible {
		background: var(--accent-hover);
	}

	.up-next-cancel {
		padding: 0.5rem 0.8rem;
		font-size: 0.85rem;
		font-weight: 600;
		color: #fff;
		background: rgba(255, 255, 255, 0.12);
		border: 1px solid rgba(255, 255, 255, 0.2);
		border-radius: 6px;
		cursor: pointer;
	}

	.up-next-cancel:hover,
	.up-next-cancel:focus-visible {
		background: rgba(255, 255, 255, 0.25);
	}
</style>
