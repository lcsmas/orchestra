// #468 — the fleet-role sentinel `.orchestra/role` the role guard reads (src/shared/role-guard.ts). Kept out of workspaces.ts
// (Electron-bound) so a test can drive it. Absent file ⇒ the guard is INERT.
import { existsSync } from 'node:fs';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { workspaceRole, type FleetRole } from '../shared/fleet-roles.ts';
import { ROLE_SENTINEL_FILE, TICKET_BRANCH_FILE } from '../shared/role-guard.ts';

/** Write `.orchestra/role` (the role frozen at spawn, else the role word of the `--name` prefix), or remove it when neither carries a role. Idempotent (no
 *  write when unchanged). Best-effort: a failure leaves the guard inert and never blocks a spawn. Returns the role now in force. */
export async function writeRoleSentinel(worktreePath: string, name: string | undefined | null, spawnRole?: FleetRole | null): Promise<string | null> {
  const file = path.join(worktreePath, '.orchestra', ROLE_SENTINEL_FILE);
  const branchFile = path.join(worktreePath, '.orchestra', TICKET_BRANCH_FILE);
  try {
    const role = workspaceRole({ branch: name, spawnRole }); // #489: the role frozen at spawn wins over whatever the name is now
    if (!role) {
      await rm(file, { force: true });
      await rm(branchFile, { force: true });
      return null;
    }
    // #683: an implementer pushes its ticket branch only — the guard reads the name from here (any other role: no file, no push rule)
    if (role === 'implementer' && name) { if (!existsSync(branchFile) || (await readFile(branchFile, 'utf8')).trim() !== name) { await mkdir(path.dirname(branchFile), { recursive: true }); await writeFile(branchFile, `${name}\n`); } } else await rm(branchFile, { force: true });
    if (existsSync(file) && (await readFile(file, 'utf8')).trim() === role) return role;
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, `${role}\n`);
    return role;
  } catch {
    return null;
  }
}
