import type { IPty } from 'node-pty';
import type {
  SessionTransport,
  TransportDisposable,
  TransportExit,
  TransportSpawnOptions,
} from './types';
import { requirePinnedNative } from '../native-pin.ts';

/** node-pty is a native addon; keep the lazy load so the module only resolves
 *  when a local PTY is actually spawned (mirrors the prior `loadPty` in pty.ts).
 *
 *  #126: route the load through the PINNED resolver, not a bare
 *  `import('node-pty')`. In a packaged app electron-builder unpacks node-pty
 *  (it contains a .node) but ALSO leaves a copy inside app.asar; a bare require
 *  can resolve the in-archive copy, whose `.node` cannot be dlopen'd — "correct
 *  only by coincidence". requirePinnedNative loads node-pty from its UNPACKED
 *  package dir and refuses if that binary is missing.
 *
 *  node-pty is N-API (ABI-stable) and loads its native at import time, so a
 *  successful load IS the construction/ABI proof — no separate construct step
 *  (unlike better-sqlite3, which defers and needs a `new Database()`). */
let ptyMod: typeof import('node-pty') | null = null;
async function loadPty() {
  if (!ptyMod) {
    ptyMod = requirePinnedNative<typeof import('node-pty')>(
      'node-pty',
      'build/Release/pty.node',
    );
  }
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
