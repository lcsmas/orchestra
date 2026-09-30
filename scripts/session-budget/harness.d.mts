// Types for harness.mjs, so src/main/cli-budget-runner.ts (the packaged-app wiring, #211) type-checks against it.
import type { Judgement, SessionBudgetReport } from '../../src/shared/session-budget.ts';

export interface Containment {
  name: 'netns+pidns' | 'netns' | 'proxy-only';
  prefix: string[];
}

export interface SessionArmOptions {
  repo: string;
  arm: string;
  mutant?: string | null;
  profile?: object;
  replyDelayMs?: number;
  settleMs?: number;
  /** The turn timeout inside the runner. */
  timeoutMs?: number;
  /** Hard bound on the WHOLE run (default `timeoutMs + 60_000`). */
  killAfterMs?: number;
  keep?: boolean;
  containment?: Containment;
  /** Run the child at this niceness (everything it spawns inherits it). */
  niceness?: number;
  /** Kill the run's process tree; the result then carries `rc: 'CANCELLED'`. */
  signal?: AbortSignal;
  /** Swap the runner (default: the source runner). The packaged app passes its bundled one. */
  launch?: (root: string, cfg: object) => { argv: string[]; env?: Record<string, string>; cwd?: string };
}

export interface SessionArmResult {
  report?: SessionBudgetReport;
  judgement?: Judgement;
  void?: boolean;
  error?: string;
  rc?: unknown;
  root?: string;
  reaped?: number;
}

export function ensureBuilt(repo: string): { path: string; mtimeMs: number };
export function detectContainment(): Containment;
export function findOnPath(bin: string): string | null;
export function reapScratchProcesses(root: string): number;
export function runSessionArm(o: SessionArmOptions): Promise<SessionArmResult>;
