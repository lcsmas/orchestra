// Shared "is this the same directory?" identity — the ONE definition (account-inherit's sync guards and the
// account-migration transcript move both need it; never compare config dirs by raw string).
import fs from 'node:fs';
import path from 'node:path';

/** Same filesystem object, however spelled: identical resolved path (`~/.claude/`, `..`, `//`), identical
 *  realpath (symlink alias, symlinked HOME), or identical dev+inode (bind mount, hard link, case-folding FS).
 *  Works on files too. A path that cannot be stat'ed is never "the same" (false). */
export function sameDir(a: string, b: string): boolean {
  if (path.resolve(a) === path.resolve(b)) return true;
  try {
    if (fs.realpathSync(a) === fs.realpathSync(b)) return true;
  } catch {
    /* one side missing/unreadable: fall through to the inode identity, which will also fail */
  }
  try {
    const sa = fs.statSync(a, { bigint: true });
    const sb = fs.statSync(b, { bigint: true });
    return sa.ino !== 0n && sa.dev === sb.dev && sa.ino === sb.ino; // ino 0 = a FS without stable inodes: no claim
  } catch {
    return false;
  }
}
