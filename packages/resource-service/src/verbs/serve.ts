// resctl serve: the reaper daemon, in the foreground. Holds daemon.lock; ticks every RESCTL_TICK.
import path from 'node:path';
import { daemonLockPath } from '../daemon.ts';
import { graceMs, stateDir, tickMs } from '../env.ts';
import { CliError, EXIT } from '../errors.ts';
import { holds, release, tryAcquire } from '../lockfile.ts';
import { tick } from '../reaper.ts';

export async function main(_argv: string[]): Promise<number> {
  const dir = stateDir();
  const got = tryAcquire(daemonLockPath(dir));
  if (!got.ok) throw new CliError(EXIT.refused, `resctl serve: already running${got.heldBy ? ` (pid ${got.heldBy.pid})` : ''} for ${dir}`);
  const lock = got.lock;
  const log = (m: string): void => void process.stderr.write(`${new Date().toISOString()} resctl serve: ${m}\n`);
  let stop: (() => void) | null = null;
  let stopping = false;
  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    process.on(sig, () => {
      stopping = true;
      stop?.();
    });
  }
  log(`serving ${path.join(dir, 'state.json')} (tick ${tickMs()}ms, grace ${graceMs()}ms, pid ${process.pid})`);
  try {
    while (!stopping) {
      if (!holds(lock)) {
        log('daemon.lock was taken over: exiting');
        return EXIT.failure;
      }
      try {
        await tick(dir, process.env, log);
      } catch (e) {
        log(`tick failed: ${(e as Error).message}`);
      }
      await new Promise<void>((resolve) => {
        const t = setTimeout(resolve, tickMs());
        stop = () => {
          clearTimeout(t);
          resolve();
        };
      });
    }
    log('stopped');
    return EXIT.ok;
  } finally {
    release(lock);
  }
}
