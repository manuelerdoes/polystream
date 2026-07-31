<script lang="ts">
	import { enhance } from '$app/forms';
	import { invalidateAll } from '$app/navigation';
	import { avatarColor, monogram } from '$lib/avatars';
	import { spatialNav } from '$lib/actions/spatialNav';
	import type { ActionData, PageData } from './$types';

	let { data, form }: { data: PageData; form: ActionData } = $props();

	let manageMode = $state(false);
	let editingId = $state<string | null>(null);
	let creating = $state(false);

	function startEditing(id: string) {
		editingId = id;
	}

	function stopEditing() {
		editingId = null;
	}
</script>

<svelte:head>
	<title>Who's watching? · Polystream</title>
</svelte:head>

<main>
	<h1>Who's watching?</h1>

	{#if form?.error}
		<p class="error" role="alert">{form.error}</p>
	{/if}

	{#if data.profiles.length === 0 && !creating}
		<p class="empty">No profiles yet — create the first one to get started.</p>
	{/if}

	<div class="grid" use:spatialNav>
		{#each data.profiles as profile (profile.id)}
			<div class="tile-wrap">
				{#if editingId === profile.id}
					<form
						method="POST"
						action="?/rename"
						class="rename-form"
						use:enhance={() => {
							return async ({ update }) => {
								await update();
								stopEditing();
							};
						}}
					>
						<input type="hidden" name="id" value={profile.id} />
						<!-- svelte-ignore a11y_autofocus -->
						<input
							name="name"
							value={profile.name}
							autofocus
							maxlength="40"
							aria-label="Rename profile"
						/>
						<div class="rename-actions">
							<button type="submit">Save</button>
							<button type="button" onclick={stopEditing}>Cancel</button>
						</div>
					</form>
				{:else}
					<form method="POST" action="?/select" use:enhance>
						<input type="hidden" name="id" value={profile.id} />
						<button type="submit" class="tile" disabled={manageMode}>
							<span class="monogram" style:background-color={avatarColor(profile.avatar)}>
								{monogram(profile.name)}
							</span>
							<span class="name">{profile.name}</span>
						</button>
					</form>

					{#if manageMode}
						<div class="manage-actions">
							<button type="button" onclick={() => startEditing(profile.id)}>Rename</button>
							<form
								method="POST"
								action="?/delete"
								use:enhance={() => {
									return async ({ update }) => {
										await update();
										await invalidateAll();
									};
								}}
							>
								<input type="hidden" name="id" value={profile.id} />
								<button type="submit" class="danger">Delete</button>
							</form>
						</div>
						<form
							method="POST"
							action="?/setAdvanced"
							class="advanced-toggle"
							use:enhance={() => {
								return async ({ update }) => {
									await update();
									await invalidateAll();
								};
							}}
						>
							<input type="hidden" name="id" value={profile.id} />
							<label>
								<input
									type="checkbox"
									name="advanced"
									checked={profile.advanced}
									onchange={(e) => e.currentTarget.form?.requestSubmit()}
								/>
								Advanced (can generate compatibility versions)
							</label>
						</form>
					{/if}
				{/if}
			</div>
		{/each}

		{#if creating}
			<div class="tile-wrap">
				<form
					method="POST"
					action="?/create"
					class="rename-form"
					use:enhance={() => {
						return async ({ update }) => {
							await update();
							creating = false;
							await invalidateAll();
						};
					}}
				>
					<!-- svelte-ignore a11y_autofocus -->
					<input
						name="name"
						placeholder="Name"
						autofocus
						maxlength="40"
						aria-label="New profile name"
					/>
					<label class="advanced-toggle">
						<input type="checkbox" name="advanced" />
						Advanced (can generate compatibility versions)
					</label>
					<div class="rename-actions">
						<button type="submit">Add</button>
						<button type="button" onclick={() => (creating = false)}>Cancel</button>
					</div>
				</form>
			</div>
		{:else}
			<button type="button" class="tile add-tile" onclick={() => (creating = true)}>
				<span class="monogram add-glyph">+</span>
				<span class="name">Add profile</span>
			</button>
		{/if}
	</div>

	{#if data.profiles.length > 0}
		<button type="button" class="manage-toggle" onclick={() => (manageMode = !manageMode)}>
			{manageMode ? 'Done' : 'Manage profiles'}
		</button>
	{/if}
</main>

<style>
	main {
		display: flex;
		min-height: 100vh;
		flex-direction: column;
		align-items: center;
		justify-content: center;
		gap: var(--space-4);
		padding: var(--space-3);
	}

	h1 {
		margin: 0;
		font-size: 1.75rem;
		font-weight: 600;
	}

	.empty {
		color: var(--text-muted);
	}

	.error {
		color: var(--danger);
	}

	.grid {
		display: flex;
		flex-wrap: wrap;
		gap: var(--space-4);
		justify-content: center;
		max-width: 50rem;
	}

	.tile-wrap {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
	}

	.tile {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		width: 8rem;
		padding: var(--space-3);
		background: transparent;
		border: none;
		border-radius: 12px;
		cursor: pointer;
		color: var(--text);
	}

	.tile:hover:not(:disabled) {
		background: var(--surface);
	}

	.tile:disabled {
		cursor: default;
		opacity: 0.5;
	}

	.monogram {
		display: flex;
		align-items: center;
		justify-content: center;
		width: 5.5rem;
		height: 5.5rem;
		border-radius: 50%;
		font-size: 2.25rem;
		font-weight: 700;
		color: #fff;
	}

	.add-glyph {
		background: var(--surface-raised);
		color: var(--text-muted);
	}

	.name {
		font-size: 0.95rem;
	}

	.manage-actions {
		display: flex;
		gap: var(--space-2);
	}

	.manage-actions button {
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
		background: var(--surface-raised);
		color: var(--text);
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}

	.manage-actions .danger {
		color: var(--danger);
	}

	.advanced-toggle {
		display: flex;
		align-items: center;
		gap: 0.35rem;
		font-size: 0.7rem;
		color: var(--text-muted);
		text-align: center;
	}

	.rename-form {
		display: flex;
		flex-direction: column;
		align-items: center;
		gap: var(--space-2);
		width: 8rem;
	}

	.rename-form input {
		width: 100%;
		padding: 0.4rem 0.5rem;
		background: var(--bg);
		color: var(--text);
		border: 1px solid rgba(255, 255, 255, 0.12);
		border-radius: 6px;
		text-align: center;
	}

	.rename-actions {
		display: flex;
		gap: var(--space-2);
	}

	.rename-actions button {
		font-size: 0.8rem;
		padding: 0.25rem 0.5rem;
		background: var(--accent);
		color: #fff;
		border: none;
		border-radius: 6px;
		cursor: pointer;
	}

	.manage-toggle {
		padding: 0.5rem 1rem;
		background: transparent;
		color: var(--text-muted);
		border: 1px solid rgba(255, 255, 255, 0.15);
		border-radius: 8px;
		cursor: pointer;
	}

	.manage-toggle:hover {
		color: var(--text);
	}
</style>
