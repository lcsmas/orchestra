// `orchestra fanout deliver` (#467, verified-fanout v2 lever 3) — the PURE half: given a PR snapshot,
// its checks, the review verdict file and the head that was verified, decide wait / refuse / merge.
// No I/O here; the verb (src/cli/fanout-deliver.ts) feeds it gh output and acts on the answer.
//
// The four merge rules this code carries:
//   1. a green run with 0 checks, or with 0 steps, is NOT green;
//   2. refuse on BLOCKING > 0 or MAJOR > 0 in the review verdict file;
//   3. refuse when the PR head != the verified head — and the merge call itself carries that head
//      (`gh pr merge --match-head-commit`), so check and act are ONE call, never check-then-act;
//   4. after N merges the coordinator runs the combined suite on the target (`combinedSuiteCommand`).

/** Exit codes of the verb — the 0/2/1 split of `verify-landed`: a refusal is an ANSWER, could-not-check is not. */
export const DELIVER_EXIT = { merged: 0, refused: 2, unchecked: 1 } as const;

/** Review verdict file (frozen, #467): `{"round":2,"blocking":0,"major":0,"minor":3,"head":"<40-hex sha reviewed>"}`. */
export interface ReviewVerdict {
  round: number;
  blocking: number;
  major: number;
  minor: number;
  head: string;
}

export type ParsedVerdict = { ok: true; verdict: ReviewVerdict } | { ok: false; error: string };

const HEX_SHA = /^[0-9a-f]{40}$/;
const isCount = (v: unknown): v is number => typeof v === 'number' && Number.isInteger(v) && v >= 0;

/** Strict parse: a missing/ill-typed field is an ERROR (could-not-check), never a silent 0 — a verdict that reads as "0 MAJOR" by default would merge. */
export function parseReviewVerdict(raw: string): ParsedVerdict {
  let j: unknown;
  try {
    j = JSON.parse(raw);
  } catch (e) {
    return { ok: false, error: `verdict file is not JSON: ${(e as Error).message}` };
  }
  if (typeof j !== 'object' || j === null || Array.isArray(j)) return { ok: false, error: 'verdict file must be a JSON object' };
  const o = j as Record<string, unknown>;
  for (const k of ['round', 'blocking', 'major', 'minor'] as const) {
    if (!isCount(o[k])) return { ok: false, error: `verdict field "${k}" must be a non-negative integer` };
  }
  if (typeof o.head !== 'string' || !HEX_SHA.test(o.head)) return { ok: false, error: 'verdict field "head" must be a full 40-hex commit sha' };
  return {
    ok: true,
    verdict: { round: o.round as number, blocking: o.blocking as number, major: o.major as number, minor: o.minor as number, head: o.head },
  };
}

/** One check on the PR head. `steps` = job step count when known (GitHub Actions job), `null` = not countable (external status). */
export interface DeliverCheck {
  name: string;
  /** Normalised: pending (queued/in progress/expected), success, neutral (neutral/skipped), failure (everything else terminal). */
  state: 'pending' | 'success' | 'neutral' | 'failure';
  steps: number | null;
}

export interface PrSnapshot {
  state: 'OPEN' | 'MERGED' | 'CLOSED';
  baseRefName: string;
  /** Full sha of the PR head right now. */
  headRefOid: string;
  /** GitHub's mergeable word; CONFLICTING refuses, UNKNOWN is not a verdict. */
  mergeable: string;
}

export interface DecideInput {
  pr: PrSnapshot;
  checks: DeliverCheck[];
  into: string;
  /** The head that was verified (flag, or the verdict's). Full 40-hex. */
  verifiedHead: string;
  /** Present when `--review-verdict` was given. */
  verdict?: ReviewVerdict;
  /** ms spent waiting so far / how long an EMPTY check list is tolerated (checks register a moment after a push). */
  waitedMs: number;
  noChecksGraceMs: number;
  /** `--require-check` names: each must be present (a fast status can register before the real CI workflow does). */
  requiredChecks?: string[];
  /** The set of check names is identical to the previous poll's — a merge needs it, so a late-registering check can't be skipped by the first poll. */
  stable: boolean;
}

export type RefuseReason =
  | 'pr-closed'
  | 'wrong-base'
  | 'review-blocking'
  | 'verdict-head-mismatch'
  | 'head-moved'
  | 'merge-conflict'
  | 'no-checks'
  | 'zero-steps'
  | 'ci-red';

export type Decision =
  | { action: 'already-merged' }
  | { action: 'wait'; why: string }
  | { action: 'refuse'; reason: RefuseReason; detail: string }
  | { action: 'merge'; head: string };

const short = (s: string): string => s.slice(0, 12);

/** The decision. Order matters: cheap/permanent refusals first, then the head, then CI. A refusal never depends on a wait. */
export function decideDelivery(i: DecideInput): Decision {
  const { pr, checks, verdict } = i;
  if (pr.state === 'MERGED') {
    // "Already merged" is only the answer when it was merged AT the verified head — else it is a different head's merge.
    if (pr.headRefOid !== i.verifiedHead) {
      return { action: 'refuse', reason: 'head-moved', detail: `PR was merged at ${short(pr.headRefOid)}, verified head is ${short(i.verifiedHead)}` };
    }
    return { action: 'already-merged' };
  }
  if (pr.state === 'CLOSED') return { action: 'refuse', reason: 'pr-closed', detail: 'the PR is closed (not merged)' };
  if (pr.baseRefName !== i.into) {
    return { action: 'refuse', reason: 'wrong-base', detail: `PR base is ${pr.baseRefName}, expected ${i.into}` };
  }
  if (verdict) {
    if (verdict.blocking > 0 || verdict.major > 0) {
      return {
        action: 'refuse',
        reason: 'review-blocking',
        detail: `review round ${verdict.round}: ${verdict.blocking} BLOCKING / ${verdict.major} MAJOR (merge needs 0 / 0)`,
      };
    }
    if (verdict.head !== i.verifiedHead) {
      return {
        action: 'refuse',
        reason: 'verdict-head-mismatch',
        detail: `the verdict reviewed ${short(verdict.head)} but the verified head is ${short(i.verifiedHead)}`,
      };
    }
  }
  if (pr.headRefOid !== i.verifiedHead) {
    return { action: 'refuse', reason: 'head-moved', detail: `PR head is ${short(pr.headRefOid)}, verified head is ${short(i.verifiedHead)}` };
  }
  if (pr.mergeable === 'CONFLICTING') return { action: 'refuse', reason: 'merge-conflict', detail: 'the PR conflicts with its base' };

  if (checks.length === 0) {
    if (i.waitedMs < i.noChecksGraceMs) return { action: 'wait', why: 'no checks registered yet' };
    return { action: 'refuse', reason: 'no-checks', detail: `0 checks on ${short(pr.headRefOid)} after ${Math.round(i.waitedMs / 1000)}s — a PR with no CI is not green` };
  }
  const failed = checks.filter((c) => c.state === 'failure');
  if (failed.length > 0) return { action: 'refuse', reason: 'ci-red', detail: `red: ${failed.map((c) => c.name).join(', ')}` };
  const missing = (i.requiredChecks ?? []).filter((n) => !checks.some((c) => c.name === n));
  if (missing.length > 0) {
    if (i.waitedMs < i.noChecksGraceMs) return { action: 'wait', why: `required check(s) not registered: ${missing.join(', ')}` };
    return { action: 'refuse', reason: 'no-checks', detail: `required check(s) never registered: ${missing.join(', ')}` };
  }
  const pending = checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) return { action: 'wait', why: `${pending.length}/${checks.length} check(s) pending` };
  if (!i.stable) return { action: 'wait', why: 'the check set changed since the last poll — confirming it is complete' };

  // All terminal and none red. Green needs ≥1 SUCCESS check, and an Actions check that passed must have run ≥1 step.
  const succeeded = checks.filter((c) => c.state === 'success');
  const empty = succeeded.filter((c) => c.steps === 0);
  if (empty.length > 0) return { action: 'refuse', reason: 'zero-steps', detail: `green with 0 steps: ${empty.map((c) => c.name).join(', ')}` };
  if (!succeeded.some((c) => c.steps === null || c.steps > 0)) {
    return { action: 'refuse', reason: 'zero-steps', detail: 'no check actually passed (all skipped/neutral)' };
  }
  return { action: 'merge', head: i.verifiedHead };
}

/** gh `statusCheckRollup` items (CheckRun / StatusContext) → {@link DeliverCheck}. `stepsOf(detailsUrl)` supplies the step count. */
export interface RollupItem {
  __typename?: string;
  name?: string;
  context?: string;
  status?: string;
  conclusion?: string;
  state?: string;
  detailsUrl?: string;
  targetUrl?: string;
}

export function normaliseRollupItem(it: RollupItem, stepsOf: (url: string | undefined) => number | null): DeliverCheck {
  const name = it.name ?? it.context ?? 'unnamed-check';
  if (it.__typename === 'StatusContext' || (it.context !== undefined && it.name === undefined)) {
    const s = (it.state ?? '').toUpperCase();
    const state = s === 'SUCCESS' ? 'success' : s === 'PENDING' || s === 'EXPECTED' || s === '' ? 'pending' : 'failure';
    return { name, state, steps: null };
  }
  if ((it.status ?? '').toUpperCase() !== 'COMPLETED') return { name, state: 'pending', steps: null };
  const c = (it.conclusion ?? '').toUpperCase();
  if (c === 'SUCCESS') return { name, state: 'success', steps: stepsOf(it.detailsUrl ?? it.targetUrl) };
  if (c === 'NEUTRAL' || c === 'SKIPPED') return { name, state: 'neutral', steps: null };
  return { name, state: 'failure', steps: null };
}

/** `https://github.com/o/r/actions/runs/123/job/456` → `{run:'123', job:'456'}`; anything else → null (not an Actions job). */
export function parseActionsJobUrl(url: string | undefined): { run: string; job: string | null } | null {
  const m = /\/actions\/runs\/(\d+)(?:\/jobs?\/(\d+))?/.exec(url ?? '');
  return m ? { run: m[1], job: m[2] ?? null } : null;
}

/** Real Actions jobs always carry "Set up job" / "Complete job" (and "Post …") steps: they are not work done by the workflow. */
export function isUserStep(name: string | undefined): boolean {
  return !/^(Set up job|Complete job|Post )/.test(name ?? '');
}

/** A merge call that gh refused: was it the head-moved guard (a REFUSAL — the answer is no) or something else (could-not-check)? */
export function classifyMergeFailure(stderr: string): 'head-moved' | 'other' {
  return /head branch was modified|head (commit|sha) .*(does not match|mismatch)|expected head sha/i.test(stderr) ? 'head-moved' : 'other';
}

/** Names that are safe to splice into a shell line and into `gh` argv (no leading `-`, no metacharacters). */
export const SAFE_REF = /^[A-Za-z0-9._][A-Za-z0-9._/-]*$/;

/** The command the COORDINATOR runs on the target after N merges (the verb never runs a repo suite itself). */
export function combinedSuiteCommand(into: string, suiteCmd = 'pnpm run test'): string {
  if (!SAFE_REF.test(into)) throw new Error(`unsafe target ref: ${into}`);
  return `git fetch origin ${into} && git checkout --detach origin/${into} && git rev-list --count HEAD..origin/${into} && ${suiteCmd}`;
}
