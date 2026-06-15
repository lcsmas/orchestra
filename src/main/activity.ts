import path from 'node:path';
import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import { getBranchMergeState, getCurrentBranch, getReleaseState } from './git';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// Hook-driven activity tracker.
//
// Claude Code's lifecycle hooks (installed per-workspace in
// .claude/settings.local.json by workspaces.ts) append one JSON line per event
// to a durable per-workspace spool file; events-spool.ts tails it and calls
// `applyAgentEvent` here. (A legacy Unix-socket path still feeds
// `dispatchHookEvent` for any pre-upgrade session whose hooks were not yet
// rewritten — same handling, minus the per-tool detail.)
//
// State is a clean function of those events:
//   submit   → running
//   pretool  → running, with the active tool name surfaced to the renderer
//   posttool → running, tool cleared
//   stop     → waiting (chime + finished-toast)
//   notify   → waiting (chime + needs-input-toast) — Claude fires this when the
//              agent is prompting the user for an answer (permission prompts
//              and the 60s idle reminder).

async function setStatus(
  id: string,
  status: WorkspaceStatus,
  window: BrowserWindow,
): Promise<Workspace | null> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return null;
  if (ws.status === status) return ws;
  const updated: Workspace = { ...ws, status };
  await store.upsertWorkspace(updated);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
  return updated;
}

function fireFinished(id: string, window: BrowserWindow): void {
  const focused = window.isFocused();
  void setStatus(id, 'waiting', window).then((ws) => {
    if (!ws) return;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      // Ship the main-process focus state with the event. document.hasFocus()
      // is unreliable in the renderer (returns stale true on Wayland when the
      // window is hidden on another workspace / CDP is attached), so the
      // renderer trusts this flag instead.
      window.webContents.send('agent:finished', id, focused);
    }
    // Re-evaluate "is this branch in sync with base after a merge, or has
    // it diverged again?" each time the agent's turn ends. Agents drive the
    // merge themselves via the Merge button's prompt, and may keep working
    // on the branch afterward — so the pill cycles on/off with each merge
    // and re-divergence rather than being a one-shot terminal state.
    void detectAndUpdateMergeState(id, window);
    if (focused) return;
    try {
      const n = new Notification({
        title: 'Agent finished',
        body: `${ws.name} is ready for review`,
        silent: true,
      });
      n.on('click', () => {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
          window.webContents.send('workspace:focus', id);
        }
      });
      n.show();
    } catch {
      /* notifications unsupported on this platform */
    }
  });
}

function fireNeedsInput(id: string, window: BrowserWindow): void {
  const focused = window.isFocused();
  void setStatus(id, 'waiting', window).then((ws) => {
    if (!ws) return;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('agent:needs-input', id, focused);
    }
    if (focused) return;
    try {
      const n = new Notification({
        title: 'Agent needs input',
        body: `${ws.name} is waiting for your answer`,
        silent: true,
      });
      n.on('click', () => {
        if (!window.isDestroyed()) {
          window.show();
          window.focus();
          window.webContents.send('workspace:focus', id);
        }
      });
      n.show();
    } catch {
      /* notifications unsupported on this platform */
    }
  });
}

export async function detectAndUpdateMergeState(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  const { merged, diverged, unpushedAhead, stalePointer } = await getBranchMergeState(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  // mergedAt is "timestamp of most recent merge" — set/refresh on every
  // merge cycle. `divergedFromBase` is what tells the renderer whether the
  // branch is currently in sync with that merge (pill visible) or has new
  // commits since (pill hidden, button enabled). Cleared only on
  // `stalePointer`, which signals the branch tip is just an old commit on
  // base's history with no real merge — clears false positives written by
  // the pre-fix detection.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const nextMergedAt = merged ? Date.now() : stalePointer ? undefined : fresh.mergedAt;
  const nextDiverged = diverged;
  const nextUnpushed = unpushedAhead;
  const changed =
    nextMergedAt !== fresh.mergedAt ||
    Boolean(fresh.divergedFromBase) !== nextDiverged ||
    (fresh.unpushedAhead ?? 0) !== nextUnpushed;
  if (!changed) return;
  const updated: Workspace = {
    ...fresh,
    mergedAt: nextMergedAt,
    divergedFromBase: nextDiverged,
    unpushedAhead: nextUnpushed,
  };
  await store.upsertWorkspace(updated);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
}

/** Reconcile the stored branch name with what's actually checked out in the
 *  worktree. A branch renamed outside orchestra — `git branch -m` in a
 *  terminal, an editor's VCS UI, a teammate's script — leaves `ws.branch`
 *  stale, and that name is threaded into every downstream git call (merge
 *  state, PR lookup, the rename instruction's env), so a stale value quietly
 *  poisons all of them. We piggyback this on the hot 8s stats poll: one cheap
 *  `rev-parse` per workspace. When the live HEAD differs from the stored
 *  branch we adopt it, refresh the display name, and set `branchManuallySet` —
 *  an out-of-band rename is a deliberate choice, so the auto-rename
 *  instruction should stop firing. Detached HEAD (getCurrentBranch → '') is
 *  ignored: there's no branch to adopt and the worktree is mid-rebase/bisect. */
export async function detectAndUpdateBranchName(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  const live = await getCurrentBranch(ws.worktreePath);
  if (!live || live === ws.branch) return;
  // Re-read after the await — a concurrent orchestra-driven rename may have
  // already adopted the same name, in which case there's nothing left to do.
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived || fresh.branch === live) return;
  const repoName = path.basename(fresh.repoPath);
  const updated: Workspace = {
    ...fresh,
    branch: live,
    name: `${repoName} · ${live}`,
    branchManuallySet: true,
  };
  await store.upsertWorkspace(updated);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
}

/** Detect whether this branch's work has shipped in a published GitHub Release
 *  and, if so, stamp `releasedAt`/`releasedVersion` once. Unlike merge state
 *  this is monotonic — shipping is terminal, so we never clear it and, once
 *  set, never re-check (the early-out below). It also short-circuits before
 *  any `gh` call for branches that can't possibly be released yet:
 *    - already released → nothing to do
 *    - never merged → its work isn't on base, so no release can contain it
 *  That keeps this off the network for all but the small set of merged-but-
 *  not-yet-released branches, even though it's invoked on the PR poll cadence.
 *  Deliberately NOT wired into `detectAndUpdateMergeState`, which runs on the
 *  hot 8s stats poll and must stay network-free. */
export async function detectAndUpdateReleaseState(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.releasedAt) return; // terminal — already known shipped
  if (!ws.mergedAt) return; // unmerged work can't be in a release yet
  const { released, version, releasedAt } = await getReleaseState(ws.repoPath, ws.branch);
  if (!released) return;
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived || fresh.releasedAt) return;
  const updated: Workspace = {
    ...fresh,
    releasedAt: releasedAt ?? Date.now(),
    releasedVersion: version,
  };
  await store.upsertWorkspace(updated);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
}

/** Push the agent's currently-running tool (or null to clear) to the renderer.
 *  This is ephemeral UI state — it rides its own IPC channel rather than
 *  `Workspace.status`/the store so per-tool churn never writes store.json. */
function emitTool(id: string, tool: string | null, window: BrowserWindow): void {
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('agent:tool', id, tool);
  }
}

/** Apply one lifecycle event to a workspace's status. Fed by the durable spool
 *  tailer (with the per-tool `tool` for pretool/posttool) and, for legacy
 *  sessions, by the Unix-socket route via `dispatchHookEvent`. `setStatus`
 *  only writes the store on a real transition, so the idempotent `running`
 *  re-assertions on every pretool are free. */
export function applyAgentEvent(
  id: string,
  event: string,
  tool: string | undefined,
  window: BrowserWindow,
): void {
  switch (event) {
    case 'submit':
      emitTool(id, null, window);
      void setStatus(id, 'running', window);
      break;
    case 'pretool':
      emitTool(id, tool ?? null, window);
      void setStatus(id, 'running', window);
      break;
    case 'posttool':
      // Stay running between tools; just clear the active-tool label.
      emitTool(id, null, window);
      break;
    case 'stop':
      emitTool(id, null, window);
      fireFinished(id, window);
      break;
    case 'notify':
      emitTool(id, null, window);
      fireNeedsInput(id, window);
      break;
  }
}

/** Legacy Unix-socket entry point (hooks-server `/event` route). Pre-upgrade
 *  workspaces still POST bare `{id, event}` here until their hooks are
 *  rewritten on the next pty:start; they carry no per-tool detail. */
export function dispatchHookEvent(
  id: string,
  event: string,
  window: BrowserWindow,
): void {
  applyAgentEvent(id, event, undefined, window);
}
