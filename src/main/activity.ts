import path from 'node:path';
import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import { getBranchMergeState, getCurrentBranch, getReleaseState } from './git';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// Hook-driven activity tracker.
//
// Claude Code's UserPromptSubmit + Stop + Notification hooks (installed
// per-workspace in .claude/settings.local.json by workspaces.ts) POST
// `{id, event}` JSON to the hooks-server's Unix socket. The hooks-server
// forwards each event here.
//
// State is a clean function of those events:
//   submit → running
//   stop   → waiting (chime + finished-toast)
//   notify → waiting (chime + needs-input-toast) — Claude fires this when the
//            agent is prompting the user for an answer (permission prompts
//            and the 60s idle reminder).

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

// Workspaces with a real prompt in flight: armed on a non-empty submit (the
// user pressing Enter, captured losslessly in pty.ts — independent of the hook
// POST — or the hook's own `submit`), disarmed when the turn ends (`stop`/
// `notify`) or the PTY dies. This is the gate the output-activity safety net
// needs: it tells `reconcileRunningFromOutput` that streaming output is work,
// not a spawn/`--continue` scrollback reprint (which happens with nothing
// armed). Event-scoped, so it maps exactly to "a turn is currently running."
const turnsInFlight = new Set<string>();

export function armTurn(id: string): void {
  turnsInFlight.add(id);
}
export function disarmTurn(id: string): void {
  turnsInFlight.delete(id);
}
export function isTurnInFlight(id: string): boolean {
  return turnsInFlight.has(id);
}

/** Out-of-band safety net for the otherwise purely hook-driven status. The
 *  only thing that sets `running` is Claude's UserPromptSubmit POST, and that
 *  single event can be lost — the 1s curl `--max-time` timing out, hooks not
 *  yet reloaded by an already-running session, or a multi-instance socket
 *  mismatch — stranding a genuinely-working agent on `idle`. pty.ts calls this
 *  when a workspace streams output (the PTY stream can't be dropped the way the
 *  hook POST can), and we reconcile `idle` → `running`.
 *
 *  Two gates keep this from firing on output that isn't work:
 *   - `turnsInFlight`: a real prompt must be in flight. The killer false
 *     positive — the multi-second, bursty `--continue` scrollback reprint —
 *     happens with nothing armed, so it's ignored by construction.
 *   - status must be `idle`. `waiting` (the unread "finished / needs input"
 *     dot) is meaningful and user-cleared, and unlike a missed submit has no
 *     follow-up event to undo an erroneous flip. The transition OUT of running
 *     stays 100% hook-driven.
 *  Gated to Claude: Codex has no Stop hook to ever clear a synthetic running. */
export async function reconcileRunningFromOutput(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  if (!turnsInFlight.has(id)) return;
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  if (ws.agent !== 'claude') return;
  if (ws.status !== 'idle') return;
  await setStatus(id, 'running', window);
}

export function dispatchHookEvent(
  id: string,
  event: string,
  window: BrowserWindow,
): void {
  if (event === 'submit') {
    armTurn(id);
    void setStatus(id, 'running', window);
  } else if (event === 'stop') {
    disarmTurn(id);
    fireFinished(id, window);
  } else if (event === 'notify') {
    disarmTurn(id);
    fireNeedsInput(id, window);
  }
}
