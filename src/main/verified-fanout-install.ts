// #470: write the bundled verified-fanout v2 (SKILL.md + v1's references/ and scripts/ledger-set, ledger D8) under <worktree>/.claude/skills/.
// Pure fs (no Electron) so the installer test drives it directly. A repo's OWN project-level verified-fanout/SKILL.md (no generated marker) is never overwritten.
import { chmod, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { VERIFIED_FANOUT_MARKER, VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME } from '../shared/verified-fanout-skill.ts';
import { VERIFIED_FANOUT_FILES } from '../shared/verified-fanout-files.ts';

/** 'written' = SKILL.md + files (re)written; 'skipped-foreign' = a SKILL.md without the marker exists (the repo's own skill), nothing touched. */
export async function installVerifiedFanoutSkill(skillsDir: string): Promise<'written' | 'skipped-foreign'> {
  const dir = path.join(skillsDir, VERIFIED_FANOUT_SKILL_NAME);
  const skillFile = path.join(dir, 'SKILL.md');
  let existing: string | null = null;
  try { existing = await readFile(skillFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
  if (existing !== null && !existing.includes(VERIFIED_FANOUT_MARKER)) return 'skipped-foreign';
  await mkdir(dir, { recursive: true });
  await writeFile(skillFile, VERIFIED_FANOUT_SKILL);
  for (const f of VERIFIED_FANOUT_FILES) {
    const dest = path.join(dir, f.path);
    await mkdir(path.dirname(dest), { recursive: true });
    await writeFile(dest, f.content);
    await chmod(dest, f.mode); // writeFile's mode only applies on create
  }
  return 'written';
}
