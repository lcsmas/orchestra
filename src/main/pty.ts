import type { IPty, IDisposable } from 'node-pty';
import { BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { getHookSocketPath } from './hooks-server';
import { agentCliBinDir } from './cli-shim';
import { getEventsDir } from './events-spool';
import { reconcileExited } from './activity';
import { log } from './logger';

let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

interface Session {
  pty: IPty;
  id: string;
  /** Workspace id for agent PTYs (undefined for nvim/run PTYs). Surfaces the
   *  $ORCHESTRA_WS_ID / $ORCHESTRA_EVENTS_DIR env the activity hooks write to. */
  workspaceId?: string;
  disposables: IDisposable[];
  stopped: boolean;
  logStream: fs.WriteStream | null;
  logBytes: number;
  logPath: string;
  /** Last winsize applied to the pty. Lets resizePty drop no-op resizes so the
   *  renderer can re-assert the size on focus/activate (to heal drift) without
   *  spamming SIGWINCH and forcing the TUI to repaint. */
  cols: number;
  rows: number;
  /** Coalescing buffer for `pty:data`. node-pty emits many tiny chunks during
   *  heavy output; we accumulate them and flush a few larger IPC messages on a
   *  short timer instead. See FLUSH_* constants. */
  outBuf: string;
  flushTimer: ReturnType<typeof setTimeout> | null;
}

const sessions = new Map<string, Session>();

const LOG_DIR = path.join(os.homedir(), '.orchestra', 'logs');
const MAX_LOG_BYTES = 2 * 1024 * 1024; // 2 MB cap per workspace

// pty:data coalescing. All main→renderer IPC — terminal output AND the
// latency-sensitive workspace:update (status dot), agent:tool, etc. — shares a
// single ordered queue per renderer. Sending one IPC message per node-pty chunk
// floods that queue with hundreds of tiny messages during a burst of agent
// output, head-of-line-blocking the status events queued behind them (the
// reported multi-second status-dot lag) and, with several agents streaming at
// once, burning main-process time on per-message structured-clone + dispatch.
// Buffering a frame's worth of output into one message collapses a burst of
// chunks into a handful of sends. FLUSH_MS bounds the added terminal latency;
// FLUSH_BYTES forces an early flush so a fast producer can't grow the buffer
// unbounded or stall output behind the timer.
const FLUSH_MS = 8;
const FLUSH_BYTES = 64 * 1024;

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

// How much of the tail to return from readScrollback. Callers (the renderer's
// scrollback restore, the peer `/read` socket route) only ever show the last
// screenful-to-few-hundred lines, so loading the full 2 MB log just to slice
// the end — and, for `/read`, ANSI-scrubbing all 2 MB of it — is wasted I/O and
// CPU. 256 KB comfortably covers hundreds of lines of TUI output.
const SCROLLBACK_TAIL_BYTES = 256 * 1024;

export function readScrollback(id: string): string {
  const p = logFileFor(id);
  try {
    const stat = fs.statSync(p);
    if (stat.size <= SCROLLBACK_TAIL_BYTES) return fs.readFileSync(p, 'utf8');
    // Read only the trailing window. We may slice mid-UTF8-sequence at the
    // start; decoding as utf8 yields at most one replacement char at the very
    // front, harmless for terminal scrollback.
    const fd = fs.openSync(p, 'r');
    try {
      const buf = Buffer.alloc(SCROLLBACK_TAIL_BYTES);
      const read = fs.readSync(fd, buf, 0, SCROLLBACK_TAIL_BYTES, stat.size - SCROLLBACK_TAIL_BYTES);
      return buf.subarray(0, read).toString('utf8');
    } finally {
      fs.closeSync(fd);
    }
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

/** Send whatever output has accumulated for this session as one `pty:data`
 *  message and clear the buffer + pending timer. Safe to call when empty. */
function flushPtyData(s: Session, window: BrowserWindow): void {
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  if (!s.outBuf) return;
  const data = s.outBuf;
  s.outBuf = '';
  if (canSend(window)) window.webContents.send('pty:data', s.id, data);
}

/** Buffer a chunk and ensure a flush is scheduled. Flushes immediately once the
 *  buffer crosses FLUSH_BYTES so a fast producer doesn't sit behind the timer. */
function queuePtyData(s: Session, window: BrowserWindow, data: string): void {
  s.outBuf += data;
  if (s.outBuf.length >= FLUSH_BYTES) {
    flushPtyData(s, window);
    return;
  }
  if (!s.flushTimer) {
    s.flushTimer = setTimeout(() => {
      s.flushTimer = null;
      flushPtyData(s, window);
    }, FLUSH_MS);
  }
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
  if (opts.workspaceId) {
    // Absolute worktree root for hook commands — the rename hook resolves its
    // script via this so it survives the agent `cd`-ing into a subdirectory
    // (relative paths broke once cwd != worktree root).
    env.ORCHESTRA_WORKTREE = opts.cwd;
    // Guarantee a bare `orchestra` resolves in the agent shell: the injected
    // skills/hooks invoke the CLI directly, and the GUI's inherited login PATH
    // can't be trusted to contain any shim dir (and has none at all on macOS).
    // Prepend the orchestra-owned bin dir written by installAgentCliShim().
    // On Windows the shim is orchestra.cmd, resolved via PATHEXT (default).
    const binDir = agentCliBinDir();
    env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
  }
  if (opts.workspaceId) {
    // Surfaced to the activity hooks: the workspace id tags every appended
    // event, and the spool dir is where the durable hook helper writes the
    // JSONL that events-spool.ts tails. Independent of the socket below — the
    // spool is the primary, can't-be-dropped activity path.
    env.ORCHESTRA_WS_ID = opts.workspaceId;
    env.ORCHESTRA_EVENTS_DIR = getEventsDir();
  }
  const sock = getHookSocketPath();
  if (sock && opts.workspaceId) {
    // Still needed for the agent-driven /rename and /spawn round-trips, which
    // require a synchronous reply the socket gives and a spool file can't.
    env.ORCHESTRA_SOCK = sock;
  }

  let proc: IPty;
  try {
    proc = pty.spawn(opts.command, opts.args, {
      name: 'xterm-256color',
      cols: Math.max(20, opts.cols),
      rows: Math.max(5, opts.rows),
      cwd: opts.cwd,
      env,
    });
  } catch (e) {
    log.error(`pty spawn failed id=${opts.id} cmd=${opts.command}`, e);
    try {
      logStream.end();
    } catch {
      /* ignore */
    }
    throw e;
  }
  log.info(`pty spawned id=${opts.id} cmd=${opts.command} pid=${proc.pid} cwd=${opts.cwd}`);
  const session: Session = {
    pty: proc,
    id: opts.id,
    workspaceId: opts.workspaceId,
    disposables: [],
    stopped: false,
    logStream,
    logBytes: initialSize,
    logPath,
    cols: Math.max(20, opts.cols),
    rows: Math.max(5, opts.rows),
    outBuf: '',
    flushTimer: null,
  };
  sessions.set(opts.id, session);

  session.disposables.push(
    proc.onData((data) => {
      if (session.stopped) return;
      // Log every chunk as it arrives (the WriteStream is async + cheap) so the
      // on-disk scrollback stays byte-exact and the trim/rotate accounting is
      // unaffected by IPC coalescing below.
      if (session.logStream) {
        session.logStream.write(data);
        session.logBytes += Buffer.byteLength(data);
        if (session.logBytes > MAX_LOG_BYTES * 1.5) {
          session.logStream.end();
          session.logBytes = trimLogIfNeeded(session.logPath);
          session.logStream = fs.createWriteStream(session.logPath, { flags: 'a' });
        }
      }
      // Coalesce the IPC send so a burst of tiny chunks doesn't flood the
      // shared renderer queue and stall the status dot. Order is preserved:
      // appends and flushes are FIFO on this single buffer.
      queuePtyData(session, opts.window, data);
    }),
  );
  session.disposables.push(
    proc.onExit(({ exitCode }) => {
      log.info(`pty exited id=${opts.id} code=${exitCode}${session.stopped ? ' (stopped)' : ''}`);
      // Flush any buffered tail before the exit notification so the terminal
      // shows the process's final output, and so it can't arrive after exit.
      flushPtyData(session, opts.window);
      if (!session.stopped && canSend(opts.window)) {
        opts.window.webContents.send('pty:exit', opts.id, exitCode);
      }
      // Reconciliation floor: once the agent process is gone it can't be
      // `running`, so self-heal the status (the stuck-green "working" dot) to
      // `waiting` — the status can never outlive the process even if the spool
      // dropped a stop. This fires for a natural exit AND for an in-session
      // deliberate stop (agent:restart, branch-switch, manual stop): in both
      // cases there is no live agent, so the dot must not keep reading as
      // "working". The ONE exception is app shutdown (`shuttingDown`): there we
      // deliberately leave a `running` status untouched, because that persisted
      // status is the resume marker `resumeRunningWorkspaces` keys off to
      // relaunch the agent with `--continue` on the next launch. Only agent
      // PTYs carry a workspaceId; nvim/run PTYs have no status.
      //
      // `replacedByLive` guards the restart/branch-switch path: those stop the
      // PTY and immediately re-spawn a fresh agent under the same id. If this
      // (stale) exit handler runs after that re-spawn, the map already holds a
      // DIFFERENT, live session — reconciling then would wrongly knock the new
      // agent back to `waiting`. A natural exit still has this very session in
      // the map (it's deleted just below), and a stopped-and-gone agent has no
      // entry at all; both correctly reconcile.
      const taken = sessions.get(opts.id);
      const replacedByLive = taken !== undefined && taken !== session;
      if (!shuttingDown && !replacedByLive && session.workspaceId && canSend(opts.window)) {
        reconcileExited(session.workspaceId, opts.window);
      }
      disposeSession(session);
      sessions.delete(opts.id);
    }),
  );
}

function disposeSession(s: Session) {
  s.stopped = true;
  // Drop any buffered output and its pending flush — the session is going away
  // (process exited or was stopped), so there's no live terminal to send to.
  if (s.flushTimer) {
    clearTimeout(s.flushTimer);
    s.flushTimer = null;
  }
  s.outBuf = '';
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
  s.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number) {
  const s = sessions.get(id);
  if (!s || s.stopped) return;
  const c = Math.max(20, cols);
  const r = Math.max(5, rows);
  if (s.cols === c && s.rows === r) return; // no-op — don't churn SIGWINCH/repaint
  s.cols = c;
  s.rows = r;
  s.pty.resize(c, r);
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

// Set once the app is tearing down (before-quit / window-all-closed). It flips
// the exit handler from "self-heal the status dot" to "preserve `running` as a
// resume marker": an agent that was working when the app closed should come
// back live on the next launch, so its `running` status must survive to disk
// untouched. An in-session stop leaves this false, so the dot reconciles
// normally and never sticks on green.
let shuttingDown = false;

export function stopAll() {
  shuttingDown = true;
  for (const id of sessions.keys()) stopPty(id);
}

export function isRunning(id: string) {
  return sessions.has(id);
}
