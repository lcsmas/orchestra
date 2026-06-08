import type { IPty, IDisposable } from 'node-pty';
import { BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { getHookSocketPath } from './hooks-server';
import { reconcileRunningFromOutput, armTurn, disarmTurn, isTurnInFlight } from './activity';

let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

interface Session {
  pty: IPty;
  id: string;
  /** Workspace id for agent PTYs (undefined for nvim/run PTYs). Drives the
   *  turn-in-flight arming and the output-activity reconcile. */
  workspaceId?: string;
  disposables: IDisposable[];
  stopped: boolean;
  logStream: fs.WriteStream | null;
  logBytes: number;
  logPath: string;
  /** Keystroke-scanner state (scanSubmit): whether any non-whitespace has been
   *  typed since the last newline, and the ANSI-escape parse stage (0 = none,
   *  1 = just saw ESC, 2 = inside a CSI/SS3 sequence awaiting its final byte). */
  inputHasContent: boolean;
  escState: 0 | 1 | 2;
  /** Debounce handle for the output-activity reconcile (onData). */
  reconcileTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();

// Coalesce the output-activity reconcile to at most once per this interval —
// the first chunk of a working turn flips status, the rest are no-ops.
const RECONCILE_DEBOUNCE_MS = 150;

// Scan user keystrokes for a *non-empty* prompt submission, so the output
// safety net only treats output as work when a real prompt is in flight.
// Terminal input arrives keystroke-by-keystroke, so content is tracked on the
// session across calls. ANSI escape sequences (arrow keys, etc.) and whitespace
// don't count — a bare Enter or pure navigation is not a submit. Returns true
// on the newline that closes a line containing real content.
function scanSubmit(session: Session, data: string): boolean {
  let submitted = false;
  for (let i = 0; i < data.length; i++) {
    const c = data.charCodeAt(i);
    if (session.escState === 2) {
      // Inside CSI/SS3: params/intermediates are 0x20–0x3f, the final byte is
      // 0x40–0x7e and ends the sequence (e.g. the 'A' of an up-arrow ESC[A).
      if (c >= 0x40 && c <= 0x7e) session.escState = 0;
      continue;
    }
    if (session.escState === 1) {
      // Byte after ESC: '[' (CSI) or 'O' (SS3) introduce a multi-byte sequence;
      // anything else is a 2-byte escape that ends right here.
      session.escState = c === 0x5b || c === 0x4f ? 2 : 0;
      continue;
    }
    if (c === 0x1b) {
      session.escState = 1;
    } else if (c === 0x0d || c === 0x0a) {
      if (session.inputHasContent) submitted = true;
      session.inputHasContent = false;
    } else if ((c >= 0x21 && c <= 0x7e) || c >= 0x80) {
      // Printable non-space, or any high byte (UTF-8 multibyte) → real content.
      session.inputHasContent = true;
    }
  }
  return submitted;
}

const LOG_DIR = path.join(os.homedir(), '.orchestra', 'logs');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB cap per workspace

function logFileFor(id: string) {
  return path.join(LOG_DIR, `${id}.log`);
}

async function ensureLogDir() {
  if (!fs.existsSync(LOG_DIR)) await mkdir(LOG_DIR, { recursive: true });
}

function trimLogIfNeeded(logPath: string): number {
  try {
    const stat = fs.statSync(logPath);
    if (stat.size <= MAX_LOG_BYTES) return stat.size;
    const fd = fs.openSync(logPath, 'r');
    const keep = Math.floor(MAX_LOG_BYTES / 2);
    const buf = Buffer.alloc(keep);
    fs.readSync(fd, buf, 0, keep, stat.size - keep);
    fs.closeSync(fd);
    fs.writeFileSync(logPath, buf);
    return keep;
  } catch {
    return 0;
  }
}

export function readScrollback(id: string): string {
  const p = logFileFor(id);
  try {
    if (!fs.existsSync(p)) return '';
    return fs.readFileSync(p, 'utf8');
  } catch {
    return '';
  }
}

export function clearScrollback(id: string) {
  const p = logFileFor(id);
  try {
    if (fs.existsSync(p)) fs.unlinkSync(p);
  } catch {
    /* ignore */
  }
}

function canSend(window: BrowserWindow): boolean {
  return !window.isDestroyed() && !window.webContents.isDestroyed();
}

export async function startPty(opts: {
  id: string;
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  window: BrowserWindow;
  /** Workspace id to surface to Claude hooks via $ORCHESTRA_WS_ID. Omit for
   * non-agent PTYs (nvim, etc.) that don't need to phone status home. */
  workspaceId?: string;
  /** Extra env vars merged into the spawned process env (after process.env,
   * before TERM and the hook vars). Used by the run-script PTY to expose
   * `ORCHESTRA_PORT`, `ORCHESTRA_ROOT_PATH`, etc. */
  extraEnv?: Record<string, string>;
}) {
  if (sessions.has(opts.id)) return; // already running
  if (!fs.existsSync(opts.cwd)) {
    throw new Error(
      `Workspace directory no longer exists: ${opts.cwd}. Delete this workspace from the sidebar or recreate the worktree.`,
    );
  }
  const pty = await loadPty();
  await ensureLogDir();
  const logPath = logFileFor(opts.id);
  const initialSize = trimLogIfNeeded(logPath);
  const logStream = fs.createWriteStream(logPath, { flags: 'a' });

  const env: Record<string, string> = {
    ...(process.env as Record<string, string>),
    ...(opts.extraEnv ?? {}),
    TERM: 'xterm-256color',
  };
  const sock = getHookSocketPath();
  if (sock && opts.workspaceId) {
    env.ORCHESTRA_SOCK = sock;
    env.ORCHESTRA_WS_ID = opts.workspaceId;
  }

  const proc = pty.spawn(opts.command, opts.args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols),
    rows: Math.max(5, opts.rows),
    cwd: opts.cwd,
    env,
  });
  const session: Session = {
    pty: proc,
    id: opts.id,
    workspaceId: opts.workspaceId,
    disposables: [],
    stopped: false,
    logStream,
    logBytes: initialSize,
    logPath,
    inputHasContent: false,
    escState: 0,
    reconcileTimer: null,
  };
  sessions.set(opts.id, session);

  session.disposables.push(
    proc.onData((data) => {
      if (session.stopped) return;
      if (session.logStream) {
        session.logStream.write(data);
        session.logBytes += Buffer.byteLength(data);
        if (session.logBytes > MAX_LOG_BYTES * 1.5) {
          session.logStream.end();
          session.logBytes = trimLogIfNeeded(session.logPath);
          session.logStream = fs.createWriteStream(session.logPath, { flags: 'a' });
        }
      }
      // Output-activity safety net: while a real prompt is in flight (armed by
      // a non-empty submit, disarmed on stop), streaming output is proof the
      // agent is working even if its UserPromptSubmit POST was dropped. The
      // reconcile gates on idle+armed, so this is a no-op once running or when
      // nothing is armed (e.g. a `--continue` reprint). Debounced per session.
      if (opts.workspaceId && !session.reconcileTimer && isTurnInFlight(opts.workspaceId)) {
        session.reconcileTimer = setTimeout(() => {
          session.reconcileTimer = null;
          if (!session.stopped) void reconcileRunningFromOutput(opts.id, opts.window);
        }, RECONCILE_DEBOUNCE_MS);
      }
      if (!canSend(opts.window)) return;
      opts.window.webContents.send('pty:data', opts.id, data);
    }),
  );
  session.disposables.push(
    proc.onExit(({ exitCode }) => {
      if (!session.stopped && canSend(opts.window)) {
        opts.window.webContents.send('pty:exit', opts.id, exitCode);
      }
      disposeSession(session);
      sessions.delete(opts.id);
    }),
  );
}

function disposeSession(s: Session) {
  s.stopped = true;
  if (s.reconcileTimer) {
    clearTimeout(s.reconcileTimer);
    s.reconcileTimer = null;
  }
  // PTY death ends any turn — clear the gate so a leaked arm can't outlive it.
  if (s.workspaceId) disarmTurn(s.workspaceId);
  for (const d of s.disposables) {
    try {
      d.dispose();
    } catch {
      /* ignore */
    }
  }
  s.disposables = [];
  if (s.logStream) {
    try {
      s.logStream.end();
    } catch {
      /* ignore */
    }
    s.logStream = null;
  }
}

export function writePty(id: string, data: string) {
  const s = sessions.get(id);
  if (!s || s.stopped) return;
  // Arm the turn-in-flight gate on a non-empty submit (covers both user typing
  // and the programmatic first-task injection, which both route through here).
  // Lossless and hook-independent, so it rescues a dropped UserPromptSubmit.
  if (s.workspaceId && scanSubmit(s, data)) armTurn(s.workspaceId);
  s.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number) {
  const s = sessions.get(id);
  if (s && !s.stopped) s.pty.resize(Math.max(20, cols), Math.max(5, rows));
}

export function stopPty(id: string) {
  const s = sessions.get(id);
  if (s) {
    disposeSession(s);
    try {
      s.pty.kill();
    } catch {
      /* ignore */
    }
    sessions.delete(id);
  }
}

export function stopAll() {
  for (const id of sessions.keys()) stopPty(id);
}

export function isRunning(id: string) {
  return sessions.has(id);
}
