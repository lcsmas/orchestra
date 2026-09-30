// Re-run the session budget suite when the installed `claude` changes (#211) — the PURE half: the durable record,
// the run/skip decision, how a suite result becomes an outcome, and the notice text. I/O half:
// src/main/cli-budget-rerun.ts. The budget NUMBERS are not here — they live only in ./session-budget.ts (#208).
//
// Why: the CLI is not our code; its costs can change on a `claude update` with no Orchestra commit. A version
// different from the last BUDGETED one triggers one background run; only a broken budget is announced.
import { parseCliVersion } from './cli-runtime.ts';
import type { Judgement, SessionBudgetReport } from './session-budget.ts';

/** Bounds of the background run (all named so a rig/test can pin them). */
export const CLI_BUDGET_RERUN = Object.freeze({
  /** After boot: never compete with session restore/attach. */
  startupDelayMs: 90_000,
  /** A `claude update` re-points a symlink: the poll only stats it, and spawns `--version` when it moved. */
  pollMs: 10 * 60_000,
  /** Whole-run hard bound (a normal run is 6-13 s); the turn inside gets `turnTimeoutMs`. */
  runTimeoutMs: 150_000,
  turnTimeoutMs: 60_000,
  /** Launches per version when a run measures nothing (void/error) — a pass/broken verdict is final. */
  maxAttempts: 3,
  /** Between such launches (a crash-looping run must not re-run on every boot). */
  retryAfterMs: 6 * 3_600_000,
  /** D7 (ledger #237): never add to a saturated machine. Deferred (not consumed) until it clears. */
  minAvailableRamMB: 2048,
  maxLoad1: 20,
  /** Everything the run spawns inherits this niceness (low priority). */
  nice: 19,
});

export type RerunStatus = 'running' | 'pass' | 'broken' | 'void' | 'error';

export interface BrokenBudget {
  /** Stable budget id, e.g. `session.beforeFirstReply.countTokensRequests`. */
  id: string;
  message: string;
}

/** The durable record: ONE entry, about the last version the suite was launched for. */
export interface RerunRecord {
  schema: 1;
  /** The CLI version this record is about (`2.1.284`). */
  version: string;
  status: RerunStatus;
  /** Launches for this version. */
  attempts: number;
  startedAt: number;
  finishedAt: number | null;
  broken: BrokenBudget[];
  /** One line: why a run was void/error. */
  note?: string;
  /** Owner of a `running` record (a crash leaves it behind). */
  pid?: number;
}

/** A version is BUDGETED once a run judged it — pass or broken. void/error measured nothing. */
export function isBudgeted(r: RerunRecord | null | undefined, version: string): boolean {
  return !!r && r.version === version && (r.status === 'pass' || r.status === 'broken');
}

/** Tolerant parse: anything malformed reads as "no record" (⇒ one run, which rewrites it). */
export function parseRecord(raw: string): RerunRecord | null {
  try {
    const o = JSON.parse(raw) as Partial<RerunRecord>;
    const statuses: RerunStatus[] = ['running', 'pass', 'broken', 'void', 'error'];
    if (o?.schema !== 1 || typeof o.version !== 'string' || !o.version || !statuses.includes(o.status as RerunStatus)) return null;
    return {
      schema: 1,
      version: o.version,
      status: o.status as RerunStatus,
      attempts: Number.isFinite(o.attempts) ? Number(o.attempts) : 1,
      startedAt: Number.isFinite(o.startedAt) ? Number(o.startedAt) : 0,
      finishedAt: typeof o.finishedAt === 'number' ? o.finishedAt : null,
      broken: Array.isArray(o.broken) ? o.broken.filter((b) => typeof b?.id === 'string').map((b) => ({ id: b.id, message: String(b.message ?? '') })) : [],
      ...(typeof o.note === 'string' ? { note: o.note } : {}),
      ...(typeof o.pid === 'number' ? { pid: o.pid } : {}),
    };
  } catch {
    return null;
  }
}

export type SkipReason =
  | 'no-cli'
  | 'unsupported'
  | 'runner-missing'
  | 'no-containment'
  | 'same-version'
  | 'in-flight'
  | 'other-run-live'
  | 'campaign'
  | 'attempts-exhausted'
  | 'retry-backoff'
  | 'ram'
  | 'load'
  | 'check-failed';

export interface DecideInput {
  /** The installed CLI version now; null = none on PATH / unprobeable. */
  version: string | null;
  record: RerunRecord | null;
  now: number;
  /** This process already has a run in flight. */
  inFlight: boolean;
  /** LIVE owner of the `suite` lock other than this process (a `running` record's owner is checked the same way). */
  suiteHeldByOther: boolean;
  /** LIVE owner of the `campaign` lock (a load/soak campaign, D7). */
  campaignLive: boolean;
  supported: boolean;
  runnerAvailable: boolean;
  /** The harness can contain the run in a network + pid namespace (bwrap). Without it the only guard against the CLI
   *  reaching a real host is a refusing proxy — not good enough for an UNATTENDED run on a user's machine (D6). */
  containmentOk: boolean;
  availableRamMB: number | null;
  load1: number | null;
}

export type Decision = { action: 'run'; attempt: number } | { action: 'skip'; reason: SkipReason };

/**
 * Should the suite run now? Skips that DEFER (ram/load/campaign/in-flight/runner) consume nothing: the next poll
 * asks again. Order matters only for which reason is reported; `same-version` wins early — a budgeted version
 * never re-triggers, whatever the machine is doing.
 */
export function decideRerun(i: DecideInput): Decision {
  if (!i.supported) return { action: 'skip', reason: 'unsupported' };
  if (!i.version) return { action: 'skip', reason: 'no-cli' };
  if (isBudgeted(i.record, i.version)) return { action: 'skip', reason: 'same-version' };
  if (i.inFlight) return { action: 'skip', reason: 'in-flight' };
  if (!i.runnerAvailable) return { action: 'skip', reason: 'runner-missing' };
  if (!i.containmentOk) return { action: 'skip', reason: 'no-containment' };
  const sameVersion = i.record?.version === i.version;
  const attempts = sameVersion ? (i.record?.attempts ?? 0) : 0;
  if (attempts >= CLI_BUDGET_RERUN.maxAttempts) return { action: 'skip', reason: 'attempts-exhausted' };
  if (sameVersion && i.record && i.now - i.record.startedAt < CLI_BUDGET_RERUN.retryAfterMs) return { action: 'skip', reason: 'retry-backoff' };
  if (i.suiteHeldByOther) return { action: 'skip', reason: 'other-run-live' };
  if (i.campaignLive) return { action: 'skip', reason: 'campaign' };
  // An unmeasured machine is not "fine" (LESSONS: never silently plenty) — but on a host that cannot report,
  // deferring forever would silently disable the alarm; unmeasured RAM/load does not block, low priority still holds.
  if (i.availableRamMB !== null && i.availableRamMB < CLI_BUDGET_RERUN.minAvailableRamMB) return { action: 'skip', reason: 'ram' };
  if (i.load1 !== null && i.load1 > CLI_BUDGET_RERUN.maxLoad1) return { action: 'skip', reason: 'load' };
  return { action: 'run', attempt: attempts + 1 };
}

/** The runner adds `error` (a turn error / teardown failure) to the report it emits. */
type RunReport = SessionBudgetReport & { error?: string };

/** What the harness hands back (`runSessionArm`), plus how the I/O half ended it. */
export interface SuiteRun {
  result: {
    report?: RunReport;
    judgement?: Judgement;
    error?: string;
    void?: boolean;
    rc?: unknown;
  } | null;
  timedOut?: boolean;
  cancelled?: boolean;
}

export type Outcome =
  | { status: 'pass'; version: string | null; broken: []; note: '' }
  | { status: 'broken'; version: string | null; broken: BrokenBudget[]; note: '' }
  | { status: 'void' | 'error'; version: string | null; broken: []; note: string }
  | { status: 'cancelled'; version: string | null; broken: []; note: '' };

const oneLine = (s: string, n = 240): string => s.replace(/\s+/g, ' ').trim().slice(0, n);

/**
 * A suite result → an outcome. The JUDGE (session-budget.ts) is the single source: a run that raised (`report.error`) or whose
 * subject never mounted is VOID — never a pass, never a notice, even when a budget also broke. Errors here are the harness
 * failing to produce a judgeable report.
 * `version` = the CLI the RUN reported (it can differ from the probe when `claude update` landed mid-run).
 */
export function classifySuiteRun(run: SuiteRun): Outcome {
  if (run.cancelled) return { status: 'cancelled', version: null, broken: [], note: '' };
  const res = run.result;
  if (run.timedOut) return { status: 'error', version: null, broken: [], note: 'suite exceeded its run bound and was killed' };
  if (!res) return { status: 'error', version: null, broken: [], note: 'the suite returned no result' };
  if (res.void) return { status: 'void', version: null, broken: [], note: oneLine(res.error ?? 'the suite could not run') };
  const report = res.report;
  const judgement = res.judgement;
  if (!report || !judgement) return { status: 'error', version: null, broken: [], note: oneLine(res.error ?? 'the suite produced no report') };
  const version = parseCliVersion(report.cli?.version ?? '') ?? null;
  if (judgement.void) {
    const why = judgement.verdicts.filter((v) => v.kind === 'instrument' && !v.ok).map((v) => v.message).slice(0, 2).join(' | ');
    return { status: 'void', version, broken: [], note: oneLine(why || 'an instrument check failed') };
  }
  const broken = judgement.verdicts.filter((v) => v.kind === 'budget' && !v.ok).map((v) => ({ id: v.id, message: v.message }));
  if (broken.length > 0) return { status: 'broken', version, broken, note: '' };
  return judgement.ok ? { status: 'pass', version, broken: [], note: '' } : { status: 'error', version, broken: [], note: 'judgement not ok but no budget broke' };
}

export interface BudgetNotice {
  title: string;
  body: string;
}

/** The one user-visible artefact (D5: an OS notice like the watchdog's + a log line — no new UI element). */
export function budgetNotice(version: string, broken: BrokenBudget[]): BudgetNotice {
  const shown = broken.slice(0, 3).map((b) => b.message.replace(/^BUDGET BROKEN /, '').split(' — ')[0]).join(' · ');
  const more = broken.length > 3 ? ` (+${broken.length - 3} more)` : '';
  return {
    title: `Claude Code ${version} broke a session budget`,
    body: `${shown}${more} — claude ${version}, session-budget suite (details: app log, "cli-budget").`,
  };
}
