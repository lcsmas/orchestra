// #590 — the role texts installed beside the coordinator skill under `seatRecords=on` (one file per role; I5 of ledger #591). The installer writes these and removes them when the switch is off.
import { FANOUT_IMPLEMENTER_SKILL_PATH, renderFanoutImplementerSkill } from './fanout-implementer-skill.ts';
import { FANOUT_REVIEWER_SKILL_PATH, renderFanoutReviewerSkill } from './fanout-reviewer-skill.ts';
import { DEFAULT_SWITCHES, type Switches } from './fanout-state.ts';

const SKILL_DIR = '.claude/skills/verified-fanout/';
export interface RoleTextFile { role: 'reviewer' | 'implementer'; /** relative to the verified-fanout skill dir */ path: string; /** relative to a worktree */ worktreePath: string; render: (switches?: Partial<Switches>) => string }
export const FANOUT_ROLE_FILES: readonly RoleTextFile[] = [
  { role: 'reviewer', path: FANOUT_REVIEWER_SKILL_PATH.slice(SKILL_DIR.length), worktreePath: FANOUT_REVIEWER_SKILL_PATH, render: renderFanoutReviewerSkill },
  { role: 'implementer', path: FANOUT_IMPLEMENTER_SKILL_PATH.slice(SKILL_DIR.length), worktreePath: FANOUT_IMPLEMENTER_SKILL_PATH, render: renderFanoutImplementerSkill },
];
/** seatRecords=on ⇒ the role files are wanted; off ⇒ none (and an earlier install's copies go). */
export const fanoutRoleFilesWanted = (switches: Partial<Switches> = DEFAULT_SWITCHES): boolean => ({ ...DEFAULT_SWITCHES, ...switches }).seatRecords === 'on';
