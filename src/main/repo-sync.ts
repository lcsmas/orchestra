import type { BrowserWindow } from 'electron';
import type { RepoSyncState } from '../shared/types';
import { store } from './store';
import { getBaseSyncState, syncBaseBranch } from './git';

/** In-memory cache of per-repo sync state. Renderer hydrates from this via
 *  IPC on load, then receives `repo:syncState` events for live updates.
 *  Key: `repoPath`. */
const states = new Map<string, RepoSyncState>();

export function snapshotSyncStates(): RepoSyncState[] {
  return Array.from(states.values());
}

function emit(window: BrowserWindow, state: RepoSyncState): void {
  states.set(state.repoPath, state);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('repo:syncState', state);
  }
}

function baseFor(repoPath: string): { baseBranch: string } | null {
  const repo = store.repos.find((r) => r.path === repoPath);
  if (!repo) return null;
  return { baseBranch: repo.defaultBranch };
}

/** Read the current sync state without doing any network I/O. Used on
 *  startup to populate the cache from whatever the local refs already say,
 *  before the first network fetch lands. */
async function refreshSyncStateLocal(
  repoPath: string,
  window: BrowserWindow,
): Promise<void> {
  const meta = baseFor(repoPath);
  if (!meta) return;
  const { behind, ahead, hasUpstream } = await getBaseSyncState(repoPath, meta.baseBranch);
  const prev = states.get(repoPath);
  emit(window, {
    repoPath,
    baseBranch: meta.baseBranch,
    behind,
    ahead,
    hasUpstream,
    syncedAt: prev?.syncedAt ?? 0,
    syncing: false,
    error: prev?.error,
  });
}

/** Fetch `origin/<base>` for one repo and recompute behind/ahead. Emits a
 *  `syncing: true` state up front so the UI can show a spinner, then the
 *  final state when done. */
export async function syncOneRepo(
  repoPath: string,
  window: BrowserWindow,
): Promise<void> {
  const meta = baseFor(repoPath);
  if (!meta) return;
  const baseBranch = meta.baseBranch;
  const prev = states.get(repoPath);
  emit(window, {
    repoPath,
    baseBranch,
    behind: prev?.behind ?? 0,
    ahead: prev?.ahead ?? 0,
    hasUpstream: prev?.hasUpstream ?? false,
    syncedAt: prev?.syncedAt ?? 0,
    syncing: true,
    error: undefined,
  });
  try {
    await syncBaseBranch(repoPath, baseBranch);
    const { behind, ahead, hasUpstream } = await getBaseSyncState(repoPath, baseBranch);
    emit(window, {
      repoPath,
      baseBranch,
      behind,
      ahead,
      hasUpstream,
      syncedAt: Date.now(),
      syncing: false,
    });
  } catch (e) {
    const { behind, ahead, hasUpstream } = await getBaseSyncState(repoPath, baseBranch).catch(
      () => ({ behind: 0, ahead: 0, hasUpstream: false }),
    );
    emit(window, {
      repoPath,
      baseBranch,
      behind,
      ahead,
      hasUpstream,
      syncedAt: prev?.syncedAt ?? 0,
      syncing: false,
      error: (e as Error).message?.split('\n')[0] || 'fetch failed',
    });
  }
}

/** Sync every known repo in parallel. Failures on one repo don't block the
 *  others. Used by the focus listener and on app startup. */
export async function syncAllRepos(window: BrowserWindow): Promise<void> {
  await Promise.all(store.repos.map((r) => syncOneRepo(r.path, window).catch(() => {})));
}

/** Populate the cache without fetching, so the renderer gets a state value
 *  for each repo on first paint even before a network fetch returns. */
export async function primeLocalSyncStates(window: BrowserWindow): Promise<void> {
  await Promise.all(
    store.repos.map((r) => refreshSyncStateLocal(r.path, window).catch(() => {})),
  );
}
