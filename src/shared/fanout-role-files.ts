// #590 — the role texts installed under `<worktree>/.orchestra/roles/` under `seatRecords=on` (one file per role; I5 of ledger #591). `.orchestra/` is Orchestra's own dir (gitignored `*`), so the files exist
// whatever `verified-fanout` skill the repo carries. The installer writes them and removes them when the switch is off.
import { FANOUT_IMPLEMENTER_SKILL_PATH, renderFanoutImplementerSkill } from './fanout-implementer-skill.ts';
import { FANOUT_REVIEWER_SKILL_PATH, renderFanoutReviewerSkill } from './fanout-reviewer-skill.ts';
import { DEFAULT_SWITCHES, type Switches } from './fanout-state.ts';

export interface RoleTextFile { role: 'reviewer' | 'implementer'; /** relative to a worktree — the path the briefs name */ worktreePath: string; render: (switches?: Partial<Switches>) => string }
export const FANOUT_ROLE_FILES: readonly RoleTextFile[] = [
  { role: 'reviewer', worktreePath: FANOUT_REVIEWER_SKILL_PATH, render: renderFanoutReviewerSkill },
  { role: 'implementer', worktreePath: FANOUT_IMPLEMENTER_SKILL_PATH, render: renderFanoutImplementerSkill },
];
/** seatRecords=on ⇒ the role files are wanted; off ⇒ none (and an earlier install's copies go). */
export const fanoutRoleFilesWanted = (switches: Partial<Switches> = DEFAULT_SWITCHES): boolean => ({ ...DEFAULT_SWITCHES, ...switches }).seatRecords === 'on';
