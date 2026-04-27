import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import { getBranchMergeState } from './git';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// PTY-quiescence watchdog. While `status === 'running'` we expect a constant
// trickle of bytes from claude's TUI (spinner, tool output, cursor blink).
// If the stream goes silent for STALL_TIMEOUT_MS, the agent is almost
// certainly wedged on a rate-limit / usage-disabled wall (no Stop hook fires
// in that case) — flip the dot to `stalled` so the user notices instead of
// staring at a fake spinner.
const STALL_TIMEOUT_MS = 45_000;
const STALL_CHECK_INTERVAL_MS = 5_000;
const lastPtyByteAt = new Map<string, number>();
let stallCheckTimer: NodeJS.Timeout | null = null;

/** Called by pty.ts on every byte from an agent PTY. Cheap — just stamps a
 * map. The periodic scan does the actual stall detection. */
export function noteAgentActivity(id: string): void {
  lastPtyByteAt.set(id, Date.now());
}

export function startStallWatchdog(window: BrowserWindow): void {
  if (stallCheckTimer) return;
  stallCheckTimer = setInterval(() => {
    const now = Date.now();
    for (const ws of store.workspaces) {
      if (ws.archived) continue;
      if (ws.status !== 'running') continue;
      const last = lastPtyByteAt.get(ws.id);
      if (last === undefined) {
        // First time seeing this workspace running — seed with `now` so the
        // timer measures silence from this point, not from epoch.
        lastPtyByteAt.set(ws.id, now);
        continue;
      }
      if (now - last >= STALL_TIMEOUT_MS) {
        void setStatus(ws.id, 'stalled', window);
      }
    }
  }, STALL_CHECK_INTERVAL_MS);
}

export function stopStallWatchdog(): void {
  if (stallCheckTimer) clearInterval(stallCheckTimer);
  stallCheckTimer = null;
  lastPtyByteAt.clear();
}

// Hook-driven activity tracker.
//
// Claude Code's UserPromptSubmit + Stop hooks (installed per-workspace in
// .claude/settings.local.json by workspaces.ts) POST `{id, event}` JSON to the
// hooks-server's Unix socket. The hooks-server forwards each event here.
//
// No /proc sampling, no PTY scraping, no per-workspace timer state — status
// transitions are 1:1 with Claude's own lifecycle events.

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

export async function detectAndUpdateMergeState(
  id: string,
  window: BrowserWindow,
): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  const { merged, diverged, unpushedAhead } = await getBranchMergeState(
    ws.repoPath,
    ws.branch,
    ws.baseBranch,
  );
  // mergedAt is "timestamp of most recent merge" — set/refresh on every
  // merge cycle, never cleared. The `divergedFromBase` flag is what tells
  // the renderer whether the branch is currently in sync with that merge
  // (pill visible) or has new commits since (pill hidden, button enabled).
  const fresh = store.getWorkspace(id);
  if (!fresh || fresh.archived) return;
  const nextMergedAt = merged ? Date.now() : fresh.mergedAt;
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

function fireNeedsInput(id: string, window: BrowserWindow): void {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  // Under --dangerously-skip-permissions, Claude's Notification hook only
  // fires for the 60s-idle reminder — never for permission prompts. If a
  // prior Stop already flipped status to `waiting`, this notify is a
  // redundant ping for a turn that already ended, so swallow it: don't
  // chime, don't pop a toast, leave status as-is. We only treat it as a
  // real "needs input" signal when status is still `running` / `stalled`,
  // i.e. the Stop event was lost or never fired.
  if (ws.status === 'waiting') return;
  const focused = window.isFocused();
  void setStatus(id, 'waiting', window);
  if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
    window.webContents.send('agent:needs-input', id, focused);
  }
  if (focused) return;
  try {
    // Louder than the gentle Stop notification — the agent is actively
    // blocked on the user, not just done with a turn. `silent: false` so
    // the OS plays the default alert sound.
    const n = new Notification({
      title: 'Agent needs your input',
      body: `${ws.name} is waiting for a reply`,
      silent: false,
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
}

export function dispatchHookEvent(
  id: string,
  event: string,
  window: BrowserWindow,
): void {
  if (event === 'submit') {
    // Seed the watchdog so silence is measured from now, not from whenever
    // the last byte happened to land before the user submitted.
    lastPtyByteAt.set(id, Date.now());
    void setStatus(id, 'running', window);
  } else if (event === 'stop') {
    lastPtyByteAt.delete(id);
    fireFinished(id, window);
  } else if (event === 'notify') {
    lastPtyByteAt.delete(id);
    fireNeedsInput(id, window);
  }
}
