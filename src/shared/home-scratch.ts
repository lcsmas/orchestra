// Disk-backed scratch for tests/rigs that need $HOME's filesystem (btrfs, not
// tmpfs /tmp). Never the top of $HOME: killed runs skip cleanup and littered it.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

/** `~/.cache/orchestra-test` — same filesystem as $HOME, out of the user's way. */
export function homeScratchBase(home: string = process.env.HOME || os.homedir()): string {
  const base = path.join(home, '.cache', 'orchestra-test');
  fs.mkdirSync(base, { recursive: true });
  return base;
}

/** `mkdtemp` under {@link homeScratchBase}. */
export function mkHomeScratch(prefix: string, home?: string): string {
  return fs.mkdtempSync(path.join(homeScratchBase(home), prefix));
}
