// Hand-rolled spatial navigation: Arrow keys move focus to the nearest focusable
// descendant in that direction, geometry-based (getBoundingClientRect). Meant as a
// TV-remote/D-pad proxy — Enter/Space already activate buttons/links natively, so we
// don't touch those.
//
// Usage: <div use:spatialNav> ...focusable children... </div>

import type { Action } from 'svelte/action';

const FOCUSABLE_SELECTOR =
	'a[href], button:not([disabled]), [tabindex]:not([tabindex="-1"]), input:not([disabled]), select:not([disabled])';

const ARROW_KEYS = new Set(['ArrowUp', 'ArrowDown', 'ArrowLeft', 'ArrowRight']);

function isTextInput(el: Element | null): boolean {
	if (!el) return false;
	const tag = el.tagName;
	return tag === 'INPUT' || tag === 'TEXTAREA' || tag === 'SELECT';
}

interface Rect {
	el: HTMLElement;
	centerX: number;
	centerY: number;
	top: number;
	left: number;
}

function getCandidates(container: HTMLElement, current: HTMLElement): Rect[] {
	const all = Array.from(container.querySelectorAll<HTMLElement>(FOCUSABLE_SELECTOR));
	return all
		.filter((el) => el !== current && el.offsetParent !== null) // skip hidden elements
		.map((el) => {
			const r = el.getBoundingClientRect();
			return {
				el,
				centerX: r.left + r.width / 2,
				centerY: r.top + r.height / 2,
				top: r.top,
				left: r.left
			};
		});
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

/**
 * Svelte action: attach to a container to enable Arrow-key spatial navigation between its
 * focusable descendants. Ignored while focus is inside a text input/select (so typing and
 * dropdown use aren't hijacked).
 */
export const spatialNav: Action<HTMLElement> = (node) => {
	function handleKeydown(event: KeyboardEvent) {
		if (!ARROW_KEYS.has(event.key)) return;
		if (isTextInput(document.activeElement)) return;

		const current = document.activeElement as HTMLElement | null;
		if (!current || !node.contains(current)) return;

		const direction =
			event.key === 'ArrowUp'
				? 'up'
				: event.key === 'ArrowDown'
					? 'down'
					: event.key === 'ArrowLeft'
						? 'left'
						: 'right';

		const candidates = getCandidates(node, current);
		const target = findNearest(direction, current.getBoundingClientRect(), candidates);

		if (target) {
			event.preventDefault();
			target.focus();
		}
	}

	node.addEventListener('keydown', handleKeydown);

	return {
		destroy() {
			node.removeEventListener('keydown', handleKeydown);
		}
	};
};
