import type { IPty } from 'node-pty';
import { BrowserWindow } from 'electron';

let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

interface Session {
  pty: IPty;
  id: string;
}

const sessions = new Map<string, Session>();

export async function startPty(opts: {
  id: string;
  cwd: string;
  command: string;
  args: string[];
  cols: number;
  rows: number;
  window: BrowserWindow;
}) {
  if (sessions.has(opts.id)) return; // already running
  const pty = await loadPty();
  const proc = pty.spawn(opts.command, opts.args, {
    name: 'xterm-256color',
    cols: Math.max(20, opts.cols),
    rows: Math.max(5, opts.rows),
    cwd: opts.cwd,
    env: { ...process.env, TERM: 'xterm-256color' },
  });
  sessions.set(opts.id, { pty: proc, id: opts.id });

  proc.onData((data) => {
    opts.window.webContents.send('pty:data', opts.id, data);
  });
  proc.onExit(({ exitCode }) => {
    opts.window.webContents.send('pty:exit', opts.id, exitCode);
    sessions.delete(opts.id);
  });
}

export function writePty(id: string, data: string) {
  const s = sessions.get(id);
  if (s) s.pty.write(data);
}

export function resizePty(id: string, cols: number, rows: number) {
  const s = sessions.get(id);
  if (s) s.pty.resize(Math.max(20, cols), Math.max(5, rows));
}

export function stopPty(id: string) {
  const s = sessions.get(id);
  if (s) {
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
