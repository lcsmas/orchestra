// #470: write the bundled verified-fanout v2 (SKILL.md + v1's references/ and scripts/ledger-set, ledger D8, + the v2 situational references, #474) under <worktree>/.claude/skills/.
// Pure fs (no Electron) so the installer test drives it directly. NEVER throws: a skill failure must not abort the hook install it sits in
// (the settings.local.json merge + the HOOKS_VERSION stamp come after it). A repo's OWN verified-fanout (no generated marker line, or a symlink) is never touched.
import { chmod, lstat, mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { VERIFIED_FANOUT_MARKER, VERIFIED_FANOUT_SKILL, VERIFIED_FANOUT_SKILL_NAME } from '../shared/verified-fanout-skill.ts';
import { VERIFIED_FANOUT_FILES, VERIFIED_FANOUT_V2_REFERENCES } from '../shared/verified-fanout-files.ts';

/** 'written' = SKILL.md + files (re)written; 'skipped-foreign' = the repo's own skill (unmarked SKILL.md, or the dir is a symlink), nothing touched; 'skipped-error' = an fs error, reported to `onError`. */
export type VerifiedFanoutInstall = 'written' | 'skipped-foreign' | 'skipped-error';

/** The marker is a line of its own (`<!-- orchestra-generated: … -->`): a foreign SKILL.md that merely QUOTES it is not ours. An empty file (a crash between truncate and write) is ours. */
const isGenerated = (text: string): boolean => text.trim() === '' || text.split('\n').some((l) => l.startsWith(`<!-- ${VERIFIED_FANOUT_MARKER}`));

async function writeAtomic(dest: string, body: string, mode?: number): Promise<void> {
  const tmp = `${dest}.${randomUUID()}.tmp`;
  try {
    await writeFile(tmp, body, mode === undefined ? undefined : { mode });
    await rename(tmp, dest);
  } catch (e) { await rm(tmp, { force: true }).catch(() => {}); throw e; }
}

export async function installVerifiedFanoutSkill(skillsDir: string, onError?: (e: unknown) => void): Promise<VerifiedFanoutInstall> {
  try {
    const dir = path.join(skillsDir, VERIFIED_FANOUT_SKILL_NAME);
    const skillFile = path.join(dir, 'SKILL.md');
    let st = null;
    try { st = await lstat(dir); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (st?.isSymbolicLink()) return 'skipped-foreign'; // a tracked symlink into a personal dir: never write THROUGH it
    let existing: string | null = null;
    try { existing = await readFile(skillFile, 'utf8'); } catch (e) { if ((e as NodeJS.ErrnoException).code !== 'ENOENT') throw e; }
    if (existing !== null && !isGenerated(existing)) return 'skipped-foreign';
    await mkdir(dir, { recursive: true });
    for (const f of [...VERIFIED_FANOUT_FILES, ...VERIFIED_FANOUT_V2_REFERENCES]) {
      const dest = path.join(dir, f.path);
      await mkdir(path.dirname(dest), { recursive: true });
      await writeAtomic(dest, f.content, f.mode);
      await chmod(dest, f.mode); // the exact mode whatever the umask
    }
    // SKILL.md LAST (#474 review): a failure part-way never leaves a NEW SKILL.md pointing at references that did not land.
    await writeAtomic(skillFile, VERIFIED_FANOUT_SKILL);
    return 'written';
  } catch (e) {
    try { onError?.(e); } catch { /* the reporter must not throw either */ }
    return 'skipped-error';
  }
}
