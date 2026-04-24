import { BrowserWindow, Notification } from 'electron';
import { readFile } from 'node:fs/promises';
import { store } from './store';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// Robust "is the agent working?" detector.
//
// We observe the agent's own process tree via /proc instead of scraping TUI
// text. Every POLL_INTERVAL_MS we sum (utime + stime) CPU ticks across the
// PTY child and all its descendants. If that total grew since the last poll,
// the agent (or a tool subprocess it spawned) did CPU work. QUIET_SAMPLES
// consecutive zero-delta polls means the agent has returned to its input
// prompt — fire "finished".
//
// This is agent-agnostic: claude, codex, a plain shell, a future TUI — any of
// them look "busy" when they're burning cycles and "idle" when they're blocked
// in read()/epoll_wait() waiting for the next keypress.
//
// The tracker is gated by `armed` (flipped by noteSubmit) so startup replay —
// e.g. `claude --continue` redrawing the previous turn — can never trigger a
// fake finished event before the user has actually sent input this session.

const POLL_INTERVAL_MS = 500;
// 2s of low CPU = idle. Short enough to feel snappy, long enough to ride out
// API round-trips that leave every process blocked in epoll_wait for a beat.
const QUIET_SAMPLES = 4;
// Minimum per-poll CPU ticks to count as "busy". Idle claude/codex TUIs redraw
// a blinking cursor / status timer and rack up 1 tick every ~1–2 s; active
// turns produce 5–50+ ticks per poll. A threshold of 2 ticks (20 ms of CPU
// per 500 ms poll) cleanly separates real work from idle animation noise.
const BUSY_TICKS_THRESHOLD = 2;

interface Track {
  armed: boolean;
  running: boolean;
  pid: number | null;
  pollTimer: NodeJS.Timeout | null;
  lastTicks: number;
  quietStreak: number;
}

const tracks = new Map<string, Track>();

function getTrack(id: string): Track {
  let t = tracks.get(id);
  if (!t) {
    t = {
      armed: false,
      running: false,
      pid: null,
      pollTimer: null,
      lastTicks: 0,
      quietStreak: 0,
    };
    tracks.set(id, t);
  }
  return t;
}

async function collectDescendants(pid: number, acc = new Set<number>()): Promise<Set<number>> {
  if (acc.has(pid)) return acc;
  acc.add(pid);
  try {
    const data = await readFile(`/proc/${pid}/task/${pid}/children`, 'utf8');
    for (const c of data.trim().split(/\s+/).filter(Boolean)) {
      const cpid = Number(c);
      if (!Number.isNaN(cpid)) await collectDescendants(cpid, acc);
    }
  } catch {
    /* process exited mid-walk, fine */
  }
  return acc;
}

async function totalCpuTicks(pids: Set<number>): Promise<number> {
  let total = 0;
  for (const pid of pids) {
    try {
      const stat = await readFile(`/proc/${pid}/stat`, 'utf8');
      // /proc/<pid>/stat: "pid (comm with possibly spaces) state ppid ..."
      // After the last ')' the remaining fields are whitespace-separated and
      // stable. utime = field 14, stime = field 15 of the overall line,
      // i.e. index 11 and 12 in the post-')' tail (which starts at `state`).
      const tail = stat.slice(stat.lastIndexOf(')') + 2).split(/\s+/);
      const utime = Number(tail[11]);
      const stime = Number(tail[12]);
      if (!Number.isNaN(utime)) total += utime;
      if (!Number.isNaN(stime)) total += stime;
    } catch {
      /* pid gone, skip */
    }
  }
  return total;
}

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

function fireFinished(id: string, window: BrowserWindow) {
  const focused = window.isFocused();
  void setStatus(id, 'waiting', window).then((ws) => {
    if (!ws) return;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      // Ship the main-process focus state with the event. `document.hasFocus()`
      // is unreliable in the renderer (returns stale true on Wayland when the
      // window is hidden on another workspace / CDP is attached), so the
      // renderer trusts this flag instead.
      window.webContents.send('agent:finished', id, focused);
    }
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

async function poll(id: string, window: BrowserWindow): Promise<void> {
  const t = tracks.get(id);
  if (!t || !t.armed || t.pid == null) return;
  const descendants = await collectDescendants(t.pid);
  const ticks = await totalCpuTicks(descendants);
  const delta = ticks - t.lastTicks;
  t.lastTicks = ticks;

  if (delta > BUSY_TICKS_THRESHOLD) {
    t.quietStreak = 0;
    if (!t.running) {
      t.running = true;
      void setStatus(id, 'running', window);
    }
  } else {
    t.quietStreak += 1;
    if (t.running && t.quietStreak >= QUIET_SAMPLES) {
      t.running = false;
      t.pollTimer = null;
      fireFinished(id, window);
      return;
    }
  }
  t.pollTimer = setTimeout(() => void poll(id, window), POLL_INTERVAL_MS);
}

export function notePtyStart(id: string, pid: number) {
  const t = getTrack(id);
  t.pid = pid;
  // Seed the baseline so the first delta doesn't count pre-spawn CPU time.
  t.lastTicks = 0;
  t.quietStreak = 0;
}

export function noteSubmit(id: string, window: BrowserWindow) {
  const t = getTrack(id);
  t.armed = true;
  t.running = true;
  t.quietStreak = 0;
  void setStatus(id, 'running', window);
  if (t.pollTimer) clearTimeout(t.pollTimer);
  t.pollTimer = setTimeout(() => void poll(id, window), POLL_INTERVAL_MS);
}

// Retained for backwards compatibility with the IPC wiring; process-state
// polling replaces the old text-scraping path so incoming chunks are no-ops.
export function noteData(_id: string, _chunk: string, _window: BrowserWindow) {
  /* intentionally empty */
}

export function clearActivity(id: string) {
  const t = tracks.get(id);
  if (!t) return;
  if (t.pollTimer) clearTimeout(t.pollTimer);
  tracks.delete(id);
}
