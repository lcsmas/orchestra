// #468 — the fleet-role sentinel `.orchestra/role` the role guard reads (src/shared/role-guard.ts). Kept out of workspaces.ts
// (Electron-bound) so a test can drive it. Absent file ⇒ the guard is INERT.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { roleOfName } from '../shared/fleet-roles.ts';
import { ROLE_SENTINEL_FILE } from '../shared/role-guard.ts';

/** Write `.orchestra/role` (the role word of the `--name` prefix), or remove it when the name carries no role. Idempotent (no
 *  write when unchanged). Best-effort: a failure leaves the guard inert and never blocks a spawn. Returns the role now in force. */
export async function writeRoleSentinel(worktreePath: string, name: string | undefined | null): Promise<string | null> {
  const file = path.join(worktreePath, '.orchestra', ROLE_SENTINEL_FILE);
  try {
    const role = roleOfName(name);
    if (!role) {
      await rm(file, { force: true });
      return null;
    }
    if (existsSync(file) && (await readFile(file, 'utf8')).trim() === role) return role;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${role}\n`);
    return role;
  } catch {
    return null;
  }
}
