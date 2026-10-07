// Rigs that drive AUTOMATIC starts of fleet members (spawn / restart) must not depend on the HOST's real MemAvailable: below 6 GB the real memory
// guard holds those starts (#286 Admission) and the rig would read RED for a reason that has nothing to do with its subject. This pins a plentiful
// fixed reading through the guard's injectable source. An older tree without the guard has nothing to neutralize (returns false).
import fs from 'node:fs';
import path from 'node:path';

export async function neutralizeMemoryGuard(repo) {
  const f = path.join(repo, 'src/main/memory-guard.ts');
  if (!fs.existsSync(f)) return false;
  const g = await import(f);
  g.__rebuildMemoryGuardForTests({ schedule: () => ({}), cancel: () => {} }, () => 16 * 1024 ** 3).start();
  return true;
}
