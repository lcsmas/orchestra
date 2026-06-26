import path from 'node:path';
import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import {
  didBranchAuthorItsTip,
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

async function setStatus(
  id: string,
  status: WorkspaceStatus,
  window: BrowserWindow,
): Promise<Workspace | null> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return null;
  if (ws.status === status) return ws;
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
  // "Released" is pure reachability: does a published release tag contain this
  // branch's tip? It does NOT depend on orchestra's merge detection — a branch
  // shipped via a fast-forward / `update-ref` advance of base (which leaves no
  // `merge` reflog trace, so `mergedAt` may be unset) is still released. The one
  // false positive to avoid is a branch freshly cut from a base commit that's
  // already inside an old release: its tip is reachable from that release but it
  // did no work. Guard with "did this branch author its tip" instead of the old
  // `mergedAt` gate — the branch's own reflog answers that cheaply.
  if (!(await didBranchAuthorItsTip(ws.repoPath, ws.branch))) return;
  // Compute the FULL set of releases that contain the tip, so the workspace
  // accrues a badge per shipping version (v0.2.0, v0.2.1, …) rather than only
  // the first. getPublishedReleases is cached per-repo (30s), so re-running this
  // on the PR-poll cadence costs at most one gh call per repo per TTL, shared
  // across all its workspaces — cheap enough to drop the old tip-moved
  // short-circuit (which by design never noticed newer releases).
  const { versions, releasedAt } = await getReleaseVersionsContaining(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  if (versions.length === 0) return;
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  // No change → avoid a redundant write/broadcast.
  const prev = fresh.releasedVersions ?? (fresh.releasedVersion ? [fresh.releasedVersion] : []);
  if (prev.length === versions.length && prev.every((v, i) => v === versions[i])) return;
  const updated: Workspace = {
    ...fresh,
    releasedAt: fresh.releasedAt ?? releasedAt ?? Date.now(),
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
