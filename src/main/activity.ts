import { BrowserWindow, Notification } from 'electron';
import { execFile } from 'node:child_process';
import os from 'node:os';
import { promisify } from 'node:util';
import pidusage from 'pidusage';
import { store } from './store';
import { getPtyPid } from './pty';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// "Agent finished" is a composite decision across three signals. Each one is
// imperfect on its own — combining them avoids the 2-minute-overrun bug where
// a long-running bash child silenced the Claude Code spinner and caused a
// premature "finished".
//
// 1. Marker-gone (original signal): Claude Code re-renders a status line like
//    `✻ Cogitating… (3s · ↓ 163 tokens · thinking)` on every frame while a
//    turn is in flight. When the marker is absent for MARKER_GONE_MS, the
//    turn *looks* idle from the TUI's point of view.
//
// 2. CPU-idle (new): we walk the PTY's process tree every second via
//    `pidusage` and treat the agent as busy whenever the tree's aggregate
//    CPU% is above CPU_BUSY_THRESHOLD. A long `rg`, `tsc`, or `bash` child
//    keeps CPU high even when the spinner has been replaced by child stdout.
//
// 3. Prompt-seen (new): once we've observed at least one busy marker since
//    the last submit, the re-appearance of the REPL prompt footer (`? for
//    shortcuts` etc.) is a positive signal that the turn actually ended.
//    Short-circuits the CPU gate for fast turns.
//
// Finish rule: marker-gone AND (prompt-seen OR cpu-idle-settled OR cpu-sampler
// unavailable). Prompt-seen short-circuits when we're confident; CPU acts as
// the hard guard against the long-bash case.
const MARKER_GONE_MS = 4000;
const CPU_POLL_MS = 1000;
const CPU_BUSY_THRESHOLD = 8; // percent — below this, the tree is idle
const CPU_IDLE_MS = 2500; // tree must stay below threshold this long

// Substrings we consider "agent is busy". Case-insensitive.
const BUSY_MARKERS = [
  'tokens ·',          // Claude Code spinner line, reliable
  'tokens)',           // fallback if the · glyph mangles
  'esc to interrupt',  // older Claude / Codex
  'ctrl+c to interrupt',
  'press esc',
];

// Gerund words that close Claude Code's spinner line: "... · thinking)".
const BUSY_GERUND_RE =
  /\b(thinking|working|cogitating|pondering|generating|analyzing|loading|fetching|streaming|searching|querying|reading|writing|computing|processing|brewing|baking|herding|bubbling)\)/i;

// Footer strings Claude Code / Codex show in the idle input footer — only
// rendered when the turn is not in flight. Best-effort list: false negatives
// (prompt not detected) fall back to CPU gate; false positives are guarded by
// the `sawBusyMarker` flag so we only trust the prompt after a spinner has
// actually come and gone.
const PROMPT_MARKERS = [
  '? for shortcuts',
  'bypassing permissions',
  'shift+tab',
  'esc to clear',
  'esc to cancel',
];

// Strip ANSI escape sequences + cursor/color controls so substring matching
// is reliable across redraws.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface Track {
  running: boolean;
  markerTimer: NodeJS.Timeout | null;
  lastMarkerAt: number;
  cpuTimer: NodeJS.Timeout | null;
  cpuIdleSince: number | null; // null while above threshold or unknown
  cpuSamplerFailed: boolean;   // sampler broken → skip CPU gate
  sawBusyMarker: boolean;      // at least one marker since last submit
  promptSeen: boolean;         // prompt reappeared after busy marker
  tail: string;
  window: BrowserWindow | null;
}

const tracks = new Map<string, Track>();

function getTrack(id: string): Track {
  let t = tracks.get(id);
  if (!t) {
    t = {
      running: false,
      markerTimer: null,
      lastMarkerAt: 0,
      cpuTimer: null,
      cpuIdleSince: null,
      cpuSamplerFailed: false,
      sawBusyMarker: false,
      promptSeen: false,
      tail: '',
      window: null,
    };
    tracks.set(id, t);
  }
  return t;
}

function hasBusyMarker(buf: string): boolean {
  const lower = buf.toLowerCase();
  if (BUSY_MARKERS.some((m) => lower.includes(m))) return true;
  return BUSY_GERUND_RE.test(buf);
}

function hasPromptMarker(buf: string): boolean {
  const lower = buf.toLowerCase();
  return PROMPT_MARKERS.some((m) => lower.includes(m));
}

const execFileAsync = promisify(execFile);

// Walk the PTY's process tree. On Linux/macOS we parse `ps -A -o pid=,ppid=`
// once per sample and DFS from the root. On Windows this degrades to the
// single root pid (pidusage still works, but child CPU is invisible).
async function treePids(root: number): Promise<number[]> {
  if (os.platform() === 'win32') return [root];
  try {
    const { stdout } = await execFileAsync('ps', ['-A', '-o', 'pid=,ppid='], {
      maxBuffer: 4 * 1024 * 1024,
    });
    const byParent = new Map<number, number[]>();
    for (const line of stdout.split('\n')) {
      const m = line.trim().match(/^(\d+)\s+(\d+)$/);
      if (!m) continue;
      const pid = Number(m[1]);
      const ppid = Number(m[2]);
      const arr = byParent.get(ppid);
      if (arr) arr.push(pid);
      else byParent.set(ppid, [pid]);
    }
    const out: number[] = [root];
    const stack: number[] = [root];
    while (stack.length) {
      const p = stack.pop() as number;
      const kids = byParent.get(p);
      if (!kids) continue;
      for (const k of kids) {
        out.push(k);
        stack.push(k);
      }
    }
    return out;
  } catch {
    return [root];
  }
}

// Returns aggregate CPU% across the tree, or -1 if sampling failed.
async function sampleTreeCpu(root: number): Promise<number> {
  try {
    const pids = await treePids(root);
    // pidusage accepts an array and returns { [pid]: { cpu, ... } } for
    // pids still alive. Dead pids are silently dropped.
    const stats = (await pidusage(pids)) as Record<string, { cpu: number }>;
    let total = 0;
    for (const s of Object.values(stats)) {
      if (s && typeof s.cpu === 'number') total += s.cpu;
    }
    return total;
  } catch {
    return -1;
  }
}

function startCpuSampler(id: string, t: Track) {
  if (t.cpuTimer) return;
  const tick = async () => {
    if (!tracks.has(id) || !t.running) return;
    const pid = getPtyPid(id);
    if (pid == null) {
      t.cpuSamplerFailed = true;
      return;
    }
    const cpu = await sampleTreeCpu(pid);
    if (cpu < 0) {
      t.cpuSamplerFailed = true;
      return;
    }
    t.cpuSamplerFailed = false;
    const now = Date.now();
    if (cpu < CPU_BUSY_THRESHOLD) {
      if (t.cpuIdleSince == null) t.cpuIdleSince = now;
    } else {
      t.cpuIdleSince = null;
    }
    if (t.window) maybeFinish(id, t.window);
  };
  t.cpuTimer = setInterval(() => {
    void tick();
  }, CPU_POLL_MS);
  void tick();
}

function stopCpuSampler(t: Track) {
  if (t.cpuTimer) {
    clearInterval(t.cpuTimer);
    t.cpuTimer = null;
  }
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
  void setStatus(id, 'waiting', window).then((ws) => {
    if (!ws) return;
    if (!window.isDestroyed() && !window.webContents.isDestroyed()) {
      window.webContents.send('agent:finished', id);
    }
    if (window.isFocused()) return; // skip the OS popup when already here
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

// Evaluate the composite gate. Called from the marker-gone timer, CPU poll
// tick, and prompt-detected data path. Firing is idempotent via t.running.
function maybeFinish(id: string, window: BrowserWindow) {
  const t = tracks.get(id);
  if (!t || !t.running) return;
  const now = Date.now();
  const markerGone = now - t.lastMarkerAt >= MARKER_GONE_MS;
  if (!markerGone) return;
  const cpuIdleSettled =
    t.cpuIdleSince != null && now - t.cpuIdleSince >= CPU_IDLE_MS;
  // If the sampler is broken, we can't gate on CPU — fall back to
  // marker-only (current-day behavior) rather than getting stuck.
  const cpuReady = t.cpuSamplerFailed || cpuIdleSettled;
  // Prompt-seen is a strong positive signal; short-circuit the CPU gate.
  const ready = t.promptSeen || cpuReady;
  if (!ready) return;

  t.running = false;
  if (t.markerTimer) {
    clearTimeout(t.markerTimer);
    t.markerTimer = null;
  }
  stopCpuSampler(t);
  fireFinished(id, window);
}

export function noteSubmit(id: string, window: BrowserWindow) {
  // Optimistic: flip to running immediately so the dot reacts fast. The next
  // data chunk with a busy marker confirms it and extends the deadline. If
  // the spinner never renders (one-line response), the fallback marker timer
  // still fires and the CPU gate lets us finish.
  const t = getTrack(id);
  t.running = true;
  t.window = window;
  t.lastMarkerAt = Date.now();
  t.sawBusyMarker = false;
  t.promptSeen = false;
  t.cpuIdleSince = null;
  t.cpuSamplerFailed = false;
  if (t.markerTimer) clearTimeout(t.markerTimer);
  t.markerTimer = setTimeout(() => {
    t.markerTimer = null;
    maybeFinish(id, window);
  }, MARKER_GONE_MS);
  startCpuSampler(id, t);
  void setStatus(id, 'running', window);
}

export function noteData(id: string, chunk: string, window: BrowserWindow) {
  const t = getTrack(id);
  t.window = window;
  const stripped = stripAnsi(chunk);
  // Bigger tail than before so full prompt-footer lines (which can run long
  // with keymap hints) still match when split across chunk boundaries.
  const probe = t.tail + stripped;
  t.tail = probe.slice(-512);

  const busy = hasBusyMarker(probe);
  const prompt = hasPromptMarker(probe);

  if (busy) {
    t.lastMarkerAt = Date.now();
    t.sawBusyMarker = true;
    // If the prompt was previously visible (e.g. between turns) and a new
    // busy marker arrives, the user has resubmitted — clear the stale
    // prompt-seen flag so we don't short-circuit the next idle check.
    t.promptSeen = false;
    if (!t.running) {
      t.running = true;
      startCpuSampler(id, t);
      void setStatus(id, 'running', window);
    }
    if (t.markerTimer) clearTimeout(t.markerTimer);
    t.markerTimer = setTimeout(() => {
      t.markerTimer = null;
      maybeFinish(id, window);
    }, MARKER_GONE_MS);
    return;
  }

  // Only trust the prompt footer once we've seen a busy marker this turn —
  // otherwise the idle footer that was already on screen at submit time
  // would trivially flip promptSeen=true and short-circuit the gate.
  if (prompt && t.running && t.sawBusyMarker && !t.promptSeen) {
    t.promptSeen = true;
    maybeFinish(id, window);
  }
}

export function clearActivity(id: string) {
  const t = tracks.get(id);
  if (!t) return;
  if (t.markerTimer) clearTimeout(t.markerTimer);
  stopCpuSampler(t);
  tracks.delete(id);
}
