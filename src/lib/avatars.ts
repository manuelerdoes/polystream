// Shared (client + server safe) avatar presets: colored monograms, no uploads/emoji/assets.
// `avatar` on a profile row stores one of these preset keys; the glyph is derived from the
// profile's name at render time (never stored), so renames stay in sync automatically.

export const AVATAR_PRESETS = {
	c1: '#e04f5f',
	c2: '#e0854f',
	c3: '#d8b53f',
	c4: '#4fae62',
	c5: '#3f9fd8',
	c6: '#5f6fe0',
	c7: '#9a4fe0',
	c8: '#e04fa8'
} as const;

export type AvatarKey = keyof typeof AVATAR_PRESETS;

export const AVATAR_KEYS = Object.keys(AVATAR_PRESETS) as AvatarKey[];

const DEFAULT_COLOR = AVATAR_PRESETS.c5;

/** Resolve a preset key (possibly unrecognized/stale data) to a CSS color. */
export function avatarColor(key: string | null | undefined): string {
	if (key && key in AVATAR_PRESETS) return AVATAR_PRESETS[key as AvatarKey];
	return DEFAULT_COLOR;
}

/** First letter of a profile name, uppercased, for the avatar glyph. Falls back to "?". */
export function monogram(name: string | null | undefined): string {
	const trimmed = name?.trim() ?? '';
	return trimmed ? trimmed[0]!.toUpperCase() : '?';
}

/** Pick a deterministic-ish preset for a brand-new profile (spread across the palette). */
export function pickAvatarForIndex(index: number): AvatarKey {
	return AVATAR_KEYS[index % AVATAR_KEYS.length]!;
}
