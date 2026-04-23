import { BrowserWindow, Notification } from 'electron';
import { store } from './store';
import type { Workspace, WorkspaceStatus } from '../shared/types';

// We detect "agent is working" by watching the TUI's own live spinner line.
// Claude Code re-renders a status line like
//
//   ✻ Cogitating… (3s · ↓ 163 tokens · thinking)
//
// on every frame while a turn is in flight — the "tokens ·" and "thinking)"
// variants inside the parens are the tell. Codex and Claude older builds use
// "esc to interrupt" instead. When none of these markers appears in any PTY
// chunk for MARKER_GONE_MS, we declare the agent idle.
//
// Design: a "deadline" timer gets reset every time we see a marker in a new
// chunk. If the deadline fires, no marker has been seen for that whole
// window → idle. This avoids the stale-buffer problem where a past-frame
// marker could linger and falsely keep us busy.
const MARKER_GONE_MS = 4000;

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

// Strip ANSI escape sequences + cursor/color controls so substring matching
// is reliable across redraws. Standard CSI/OSC pattern.
// eslint-disable-next-line no-control-regex
const ANSI_RE = /\x1B(?:[@-Z\\-_]|\[[0-?]*[ -/]*[@-~]|\][^\x07]*\x07)/g;
function stripAnsi(s: string): string {
  return s.replace(ANSI_RE, '');
}

interface Track {
  idleTimer: NodeJS.Timeout | null;
  running: boolean;
  // Small trailing context (last 256 stripped chars) so markers split across
  // chunk boundaries (e.g. "toke" + "ns ·") still register.
  tail: string;
}

const tracks = new Map<string, Track>();

function getTrack(id: string): Track {
  let t = tracks.get(id);
  if (!t) {
    t = { idleTimer: null, running: false, tail: '' };
    tracks.set(id, t);
  }
  return t;
}

function hasBusyMarker(buf: string): boolean {
  const lower = buf.toLowerCase();
  if (BUSY_MARKERS.some((m) => lower.includes(m))) return true;
  return BUSY_GERUND_RE.test(buf);
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

export function noteSubmit(id: string, window: BrowserWindow) {
  // Optimistic: flip to running immediately so the dot reacts fast. The next
  // data chunk with a busy marker confirms it and replaces this fallback
  // deadline with the real one. If the spinner never renders (e.g. a one-line
  // response), this deadline still fires and we go idle gracefully.
  const t = getTrack(id);
  t.running = true;
  if (t.idleTimer) clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    t.idleTimer = null;
    t.running = false;
    fireFinished(id, window);
  }, MARKER_GONE_MS);
  void setStatus(id, 'running', window);
}

export function noteData(id: string, chunk: string, window: BrowserWindow) {
  const t = getTrack(id);
  const stripped = stripAnsi(chunk);
  // Scan the stripped chunk plus a small tail from the previous chunk so a
  // marker split across a chunk boundary still matches.
  const probe = t.tail + stripped;
  t.tail = probe.slice(-256);

  if (!hasBusyMarker(probe)) return;

  // Marker seen → confirm running and reset the "marker gone" deadline. If no
  // further marker arrives within MARKER_GONE_MS, we flip to idle.
  if (!t.running) {
    t.running = true;
    void setStatus(id, 'running', window);
  }
  if (t.idleTimer) clearTimeout(t.idleTimer);
  t.idleTimer = setTimeout(() => {
    t.idleTimer = null;
    t.running = false;
    fireFinished(id, window);
  }, MARKER_GONE_MS);
}

export function clearActivity(id: string) {
  const t = tracks.get(id);
  if (!t) return;
  if (t.idleTimer) clearTimeout(t.idleTimer);
  tracks.delete(id);
}
