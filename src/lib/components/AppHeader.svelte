<script lang="ts">
	import { resolve } from '$app/paths';
	import { page } from '$app/state';
	import { avatarColor, monogram } from '$lib/avatars';

	interface Props {
		profileName: string;
		profileAvatar: string | null;
		mode?: 'desktop' | 'tv' | null;
	}

	let { profileName, profileAvatar, mode = null }: Props = $props();

	// Hierarchical "up" target derived from the current route (not browser history, so it's
	// predictable even on a fresh page load): a detail page goes up to its list, a list goes up
	// to home, and home shows no back button. Keyed off route.id so it's base-path/param safe.
	const upHref = $derived.by(() => {
		switch (page.route.id) {
			case '/':
				return null;
			case '/movies/[id]':
				return resolve('/movies');
			case '/shows/[id]':
				return resolve('/shows');
			default:
				return resolve('/');
		}
	});
</script>

<header>
	<div class="left">
		{#if upHref}
			<a class="back" href={upHref} aria-label="Go back">‹ Back</a>
		{/if}
		<a class="brand" href={resolve('/')}>Polystream</a>
	</div>

	<div class="right">
		<div class="profile">
			<span class="monogram" style:background-color={avatarColor(profileAvatar)}>
				{monogram(profileName)}
			</span>
			<span class="name">{profileName}</span>
		</div>

		<a class="link" href={resolve('/mode')}>{mode === 'tv' ? 'TV' : 'Desktop'} mode</a>

		<a class="link" href={resolve('/profiles')}>Switch profile</a>

		<form class="logout-form" method="POST" action={resolve('/logout')}>
			<button type="submit" class="link-button">Log out</button>
		</form>
	</div>
</header>

<style>
	header {
		display: flex;
		align-items: center;
		justify-content: space-between;
		gap: 1rem;
		padding: 0.75rem 1.5rem;
		background: var(--surface);
		border-bottom: 1px solid rgba(255, 255, 255, 0.08);
	}

	.left {
		display: flex;
		align-items: center;
		gap: 1rem;
	}

	.back {
		display: inline-flex;
		align-items: center;
		padding: 0.3rem 0.7rem;
		font-size: 0.9rem;
		color: var(--text-muted);
		text-decoration: none;
		background: var(--surface-raised, rgba(255, 255, 255, 0.06));
		border: 1px solid rgba(255, 255, 255, 0.08);
		border-radius: 999px;
	}

	.back:hover {
		color: var(--text);
	}

	.back:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}

	.brand {
		font-size: 1.25rem;
		font-weight: 700;
		letter-spacing: 0.02em;
		color: var(--text);
		text-decoration: none;
	}

	.brand:hover {
		color: var(--accent-hover, var(--text));
	}

	.brand:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
		border-radius: 4px;
	}

	.right {
		display: flex;
		align-items: center;
		gap: 1.25rem;
	}

	.profile {
		display: flex;
		align-items: center;
		gap: 0.5rem;
	}

	.monogram {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 2rem;
		height: 2rem;
		border-radius: 50%;
		font-weight: 700;
		color: #fff;
		font-size: 0.9rem;
	}

	.name {
		color: var(--text);
		font-size: 0.95rem;
	}

	.link,
	.link-button {
		color: var(--text-muted);
		text-decoration: none;
		font-size: 0.9rem;
		background: none;
		border: none;
		cursor: pointer;
		padding: 0.25rem 0.25rem;
		border-radius: 4px;
	}

	.logout-form {
		display: contents;
	}

	.link:hover,
	.link-button:hover {
		color: var(--text);
	}

	.link:focus-visible,
	.link-button:focus-visible {
		outline: 2px solid var(--focus-ring);
		outline-offset: 2px;
	}
</style>
