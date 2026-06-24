import type { IPty } from 'node-pty';
import type {
  SessionTransport,
  TransportDisposable,
  TransportExit,
  TransportSpawnOptions,
} from './types';

/** node-pty is a native addon; keep the lazy import so the module only loads
 *  when a local PTY is actually spawned (mirrors the prior `loadPty` in pty.ts). */
let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) ptyMod = await import('node-pty');
  return ptyMod;
}

/** Local backend: a `SessionTransport` over node-pty. This is the only
 *  transport wired up today and preserves the exact spawn behavior the PTY
 *  layer relied on before the seam was introduced. */
class LocalPtyTransport implements SessionTransport {
  constructor(private readonly proc: IPty) {}

  get pid(): number | undefined {
    return this.proc.pid;
  }

  onData(listener: (data: string) => void): TransportDisposable {
    return this.proc.onData(listener);
  }

  onExit(listener: (e: TransportExit) => void): TransportDisposable {
    return this.proc.onExit(({ exitCode }) => listener({ exitCode }));
  }

  write(data: string): void {
    this.proc.write(data);
  }

  resize(cols: number, rows: number): void {
    this.proc.resize(cols, rows);
  }

  kill(): void {
    this.proc.kill();
  }
}

/** Spawn a local node-pty and return it behind the transport interface. Throws
 *  if the underlying `pty.spawn` fails — the caller logs and unwinds. */
export const createLocalPtyTransport = async (
  opts: TransportSpawnOptions,
): Promise<SessionTransport> => {
  const pty = await loadPty();
  const proc = pty.spawn(opts.command, opts.args, {
    name: 'xterm-256color',
    cols: opts.cols,
    rows: opts.rows,
    cwd: opts.cwd,
    env: opts.env,
  });
  return new LocalPtyTransport(proc);
};
