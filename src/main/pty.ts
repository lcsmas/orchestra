import type { IPty, IDisposable } from 'node-pty';
import { BrowserWindow } from 'electron';
import path from 'node:path';
import os from 'node:os';
import fs from 'node:fs';
import { mkdir } from 'node:fs/promises';
import { getHookSocketPath } from './hooks-server';

let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

interface Session {
  pty: IPty;
  id: string;
  disposables: IDisposable[];
  stopped: boolean;
  logStream: fs.WriteStream | null;
  logBytes: number;
  logPath: string;
}

const sessions = new Map<string, Session>();

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

export function hasScrollback(id: string): boolean {
  const p = logFileFor(id);
  try {
    return fs.existsSync(p) && fs.statSync(p).size > 0;
  } catch {
    return false;
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
    disposables: [],
    stopped: false,
    logStream,
    logBytes: initialSize,
    logPath,
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
  if (s && !s.stopped) s.pty.write(data);
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
