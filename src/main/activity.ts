import path from 'node:path';
import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import {
  getBranchMergeState,
  getCurrentBranch,
  getReleaseVersionsContaining,
} from './git';
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

/** Update a workspace's status. Returns the workspace plus whether this call
 *  was a real transition (`changed`) — callers that fire a one-shot side effect
 *  on entering a state (a chime, an OS notification) gate on `changed` so a
 *  redundant event (e.g. a `notify` right after a `stop`, both → `waiting`)
 *  doesn't re-fire it. Returns null only when the workspace is gone/archived. */
async function setStatus(
  id: string,
  status: WorkspaceStatus,
  window: BrowserWindow,
): Promise<{ ws: Workspace; changed: boolean } | null> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return null;
  if (ws.status === status) return { ws, changed: false };
  const updated: Workspace = { ...ws, status };
  // Broadcast to the renderer first, then persist. upsertWorkspace mutates the
  // in-memory store synchronously (before its first await), so state is already
  // consistent here — but its disk flush is serialized through one write chain
  // (tmp-write + atomic rename of the whole store.json). The 8s stats poll
  // enqueues a save per workspace onto that same chain, so awaiting the flush
  // would make the status dot wait behind a batch of unrelated full-file
  // writes — the visible latency. The dot is ephemeral UI; it must not block on
  // durability, so fire the persist and let it flush in the background.
  void store.upsertWorkspace(updated).catch(() => {});
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
  return { ws: updated, changed: true };
}

function fireFinished(id: string, window: BrowserWindow): void {
  const focused = window.isFocused();
  void setStatus(id, 'waiting', window).then((res) => {
    if (!res) return;
    const { ws, changed } = res;
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
    // Only raise the OS notification on a real running→waiting transition. A
    // redundant terminal event that didn't move the status (already waiting)
    // must not pop a second toast.
    if (focused || !changed) return;
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
  void setStatus(id, 'waiting', window).then((res) => {
    if (!res) return;
    const { ws, changed } = res;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('agent:needs-input', id, focused);
    }
    if (focused || !changed) return;
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
  if (!ws || ws.archived || ws.kind === 'scratch') return;
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
  // Broadcast before persisting — see setStatus: the renderer must not wait on
  // the serialized store-write chain to reflect the merge pill / ↑N badge.
  void store.upsertWorkspace(updated).catch(() => {});
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
// Throttle the per-workspace out-of-band-rename probe. The stats poll calls
// this every 8s per workspace, but a `git branch -m` from a terminal is a rare,
// deliberate event — there's no value in spawning a `git rev-parse` per
// workspace 7-8 times a minute to catch it. Cap each workspace's probe to once
// per BRANCH_PROBE_MS; the rename is still adopted within a minute. With N
// workspaces this turns ~N·7.5 git spawns/min into ~N.
const BRANCH_PROBE_MS = 60_000;
const lastBranchProbe = new Map<string, number>();

export async function detectAndUpdateBranchName(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || ws.kind === 'scratch') return;
  const now = Date.now();
  const last = lastBranchProbe.get(id) ?? 0;
  if (now - last < BRANCH_PROBE_MS) return;
  lastBranchProbe.set(id, now);
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
  // Broadcast before persisting — see setStatus: don't gate the renamed-branch
  // UI on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch(() => {});
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
}

/** Detect every published GitHub Release whose build contains this branch's
 *  tip and stamp `releasedAt` + `releasedVersions` (and `releasedVersion`, the
 *  earliest, for back-compat). Skips unmerged branches (their work isn't on
 *  base, so no release can contain it). For merged branches it recomputes the
 *  full version list each call so the workspace accrues a badge as each later
 *  version ships — `getPublishedReleases` is cached per-repo (30s) and shared
 *  across that repo's workspaces, so this stays at roughly one `gh` call per
 *  repo per TTL even on the PR poll cadence. Writes/broadcasts only when the
 *  version list actually changes. Deliberately NOT wired into
 *  `detectAndUpdateMergeState`, which runs on the hot 8s stats poll and must
 *  stay network-free. */
export async function detectAndUpdateReleaseState(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived || ws.kind === 'scratch') return;
  // Which published releases did THIS branch's own work first ship in? One badge
  // per such release (v0.2.0, v0.2.1, …). getReleaseVersionsContaining derives
  // the branch's authored commit set (from its reflog, falling back to the
  // base..branch range) and maps each to its first containing release, so a
  // fresh branch cut from an old release commit it never authored gets nothing,
  // and a merged/stale-pointer branch still gets exactly what it shipped. No
  // separate "did the branch author its tip" gate is needed — an empty authored
  // set already yields no versions. getPublishedReleases is cached per-repo
  // (30s), so this costs at most one gh call per repo per TTL.
  const { versions, releasedAt } = await getReleaseVersionsContaining(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const prev = fresh.releasedVersions ?? (fresh.releasedVersion ? [fresh.releasedVersion] : []);
  // No change → avoid a redundant write/broadcast. (Covers both staying empty
  // and staying identical.)
  if (prev.length === versions.length && prev.every((v, i) => v === versions[i])) return;
  if (versions.length === 0) {
    // The branch shipped nothing (or a prior over-eager computation left stale
    // pills): clear the release fields so the badges disappear.
    const cleared: Workspace = {
      ...fresh,
      releasedAt: undefined,
      releasedVersion: undefined,
      releasedVersions: undefined,
    };
    void store.upsertWorkspace(cleared).catch(() => {});
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('workspace:update', cleared);
    }
    return;
  }
  const updated: Workspace = {
    ...fresh,
    // Recompute releasedAt from the fresh result rather than preserving a stale
    // one — the version list itself just changed, so the "shipped when" anchor
    // should track it.
    releasedAt: releasedAt ?? fresh.releasedAt ?? Date.now(),
    releasedVersion: versions[0], // earliest = the "shipped when" signal
    releasedVersions: versions,
  };
  // Broadcast before persisting — see setStatus: don't gate the released-version
  // pill on the serialized store-write chain.
  void store.upsertWorkspace(updated).catch(() => {});
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('workspace:update', updated);
  }
}

/** Reconciliation floor for the status dot: the agent's process is gone, so it
 *  cannot possibly still be `running`. Called from the PTY exit handler. This
 *  is the durability backstop that makes a lost terminal event self-heal — even
 *  if a `stop`/`notify` line were never delivered, the dot can never outlive the
 *  process. We move to `waiting` (not `idle`) so the workspace still reads as
 *  "has unreviewed output, go look" and keeps its yellow dot until the user
 *  opens it; a clean idle is reserved for never-run / already-seen workspaces.
 *  A no-op when the workspace already left `running` via a real stop/notify. */
export function reconcileExited(id: string, window: BrowserWindow): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.status !== 'running') return;
  void setStatus(id, 'waiting', window);
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
