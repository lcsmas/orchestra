// The Claude Code on this machine (Orchestra ships none): which `claude` an env's PATH lands on, and its version. Electron-free.
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { parseCliVersion } from '../shared/cli-runtime.ts';

/** Find the `claude` executable on an env's PATH. Returns null when absent — dev falls back to the SDK's own binary; the packaged
 *  app ships none and refuses (agent-sdk.ts ensureSessionInner). */
export function resolveClaudeBinary(env: Record<string, string | undefined>): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** `claude --version` memo, keyed by the binary's realpath + mtime so a `claude update` (symlink re-pointed) is picked up without
 *  an app restart — and a re-read while nothing changed costs one realpath + stat, no process. */
const versionMemo = new Map<string, Promise<string | null>>();

/** The version of the binary `bin` resolves to NOW, or null (missing, not runnable, unreadable answer). NEVER rejects. `fresh`
 *  asks the program again whatever the memo says: a wrapper script (an asdf / volta shim) keeps its realpath and mtime when what it
 *  runs is updated. */
export async function claudeBinaryVersion(bin: string, o: { fresh?: boolean } = {}): Promise<string | null> {
  let real: string, key: string;
  try {
    real = fs.realpathSync(bin);
    key = `${real}\0${fs.statSync(real).mtimeMs}`;
  } catch {
    return null;
  }
  let p = o.fresh ? undefined : versionMemo.get(key);
  if (!p) {
    p = new Promise<string | null>((resolve) => {
      let out = '';
      const child = spawn(real, ['--version'], { stdio: ['ignore', 'pipe', 'ignore'] });
      const timer = setTimeout(() => child.kill('SIGKILL'), 10_000);
      child.stdout?.on('data', (c: Buffer) => (out += c.toString('utf8')));
      child.on('error', () => {
        clearTimeout(timer);
        resolve(null);
      });
      child.on('close', () => {
        clearTimeout(timer);
        resolve(parseCliVersion(out));
      });
    });
    versionMemo.set(key, p);
  }
  const version = await p;
  if (!version) versionMemo.delete(key); // don't memoize a failed probe
  return version;
}
