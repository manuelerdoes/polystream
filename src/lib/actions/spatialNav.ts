// Global spatial (D-pad / TV-remote) navigation.
//
// A single document-level keydown listener moves focus to the nearest focusable element in
// the arrow direction, using geometry (getBoundingClientRect). This makes the whole screen
// one navigable surface — focus crosses freely between the header, content rows, grids and
// detail controls — which the previous per-container islands could not do. Enter/Space
// already activate buttons/links natively, so we don't touch those.
//
// Mounted once from +layout.svelte via installGlobalSpatialNav(). Initial/roving focus is
// seeded by focusFirstInMain() after each navigation, so a remote-only user (arrows + OK,
// no pointer, no Tab) always has a starting point and a visible focus ring.

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled])';

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

/** Focus is in a field that owns arrow keys natively (typing, range sliders, native selects). */
function isFormField(el: Element | null): boolean {
	if (!el) return false;
	const tag = el.tagName;
	if (tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT') return true;
	return (el as HTMLElement).isContentEditable;
}

interface Rect {
	el: HTMLElement;
	centerX: number;
	centerY: number;
	top: number;
	left: number;
}

/** Every visible, focusable element on the page except `current`. */
function getCandidates(current: HTMLElement | null): Rect[] {
	const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
	const out: Rect[] = [];
	for (const el of all) {
		if (el === current) continue;
		const r = el.getBoundingClientRect();
		// Non-zero box == laid out and visible. (offsetParent would wrongly exclude
		// position:fixed elements like the fullscreen player / watch page.)
		if (r.width === 0 || r.height === 0) continue;
		out.push({
			el,
			centerX: r.left + r.width / 2,
			centerY: r.top + r.height / 2,
			top: r.top,
			left: r.left
		});
	}
	return out;
}

/**
 * Pick the best candidate in `direction` from `from`, using a primary-axis distance plus a
 * penalized cross-axis offset (so nav prefers elements roughly aligned with the current one).
 */
function findNearest(
	direction: 'up' | 'down' | 'left' | 'right',
	from: DOMRect,
	candidates: Rect[]
): HTMLElement | null {
	const fromCenterX = from.left + from.width / 2;
	const fromCenterY = from.top + from.height / 2;

	let best: HTMLElement | null = null;
	let bestScore = Infinity;

	for (const candidate of candidates) {
		const dx = candidate.centerX - fromCenterX;
		const dy = candidate.centerY - fromCenterY;

		let primary: number; // distance along the direction of travel (must be positive)
		let cross: number; // perpendicular offset (penalized, encourages alignment)

		switch (direction) {
			case 'up':
				primary = -dy;
				cross = dx;
				break;
			case 'down':
				primary = dy;
				cross = dx;
				break;
			case 'left':
				primary = -dx;
				cross = dy;
				break;
			case 'right':
				primary = dx;
				cross = dy;
				break;
		}

		if (primary <= 0) continue; // wrong side entirely

		// Cross-axis offset is weighted heavier so we don't jump to a far-off row/column
		// just because it's slightly closer in the primary direction.
		const score = primary + Math.abs(cross) * 2;
		if (score < bestScore) {
			bestScore = score;
			best = candidate.el;
		}
	}

	return best;
}

function firstFocusableIn(scope: ParentNode): HTMLElement | null {
	for (const el of scope.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR)) {
		const r = el.getBoundingClientRect();
		if (r.width > 0 && r.height > 0) return el;
	}
	return null;
}

function focusAndReveal(el: HTMLElement) {
	el.focus();
	el.scrollIntoView({ block: 'nearest', inline: 'nearest' });
}

function directionFor(key: string): 'up' | 'down' | 'left' | 'right' {
	return key === 'ArrowUp'
		? 'up'
		: key === 'ArrowDown'
			? 'down'
			: key === 'ArrowLeft'
				? 'left'
				: 'right';
}

function handleKeydown(event: KeyboardEvent) {
	if (!ARROW_KEYS.has(event.key)) return;
	// A closer handler already dealt with it — notably the player root's seek/volume arrows,
	// which preventDefault() while the video/player is focused. Stand down there.
	if (event.defaultPrevented) return;
	// Let fields that own arrow keys natively keep them (typing, range sliders, native selects).
	if (isFormField(document.activeElement)) return;

	const current = document.activeElement as HTMLElement | null;

	// No usable focus yet (e.g. autofocus didn't run) — seed it rather than move.
	if (!current || current === document.body) {
		const first = firstFocusableIn(document.body);
		if (first) {
			event.preventDefault();
			focusAndReveal(first);
		}
		return;
	}

	const target = findNearest(
		directionFor(event.key),
		current.getBoundingClientRect(),
		getCandidates(current)
	);
	if (target) {
		event.preventDefault();
		focusAndReveal(target);
	}
}

/** Attach the global D-pad navigation. Returns a cleanup fn. Call once (from +layout.svelte). */
export function installGlobalSpatialNav(): () => void {
	document.addEventListener('keydown', handleKeydown);
	return () => document.removeEventListener('keydown', handleKeydown);
}

/**
 * Seed focus on the first focusable element inside the page's <main>, so a remote-only user
 * has a starting point after navigation. No-ops when something is already focused (respects
 * existing autofocus inputs) or when the page has no <main> (the fullscreen /watch player
 * manages its own focus).
 */
export function focusFirstInMain(): void {
	const active = document.activeElement;
	if (active && active !== document.body) return;

	const main = document.querySelector('main');
	if (!main) return;

	const first = firstFocusableIn(main);
	if (first) focusAndReveal(first);
}
