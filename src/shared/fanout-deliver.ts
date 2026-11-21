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

/** #495 — the ONE reading of "is this PR's CI green" (deliver merges on it, `fanout gate` tells the verifier it may skip the full suite on it). */
export type CiVerdict =
  | { kind: 'none' }
  | { kind: 'red'; detail: string }
  | { kind: 'missing'; names: string[] }
  | { kind: 'pending'; detail: string }
  | { kind: 'unstable'; detail: string }
  | { kind: 'zero-steps'; detail: string }
  | { kind: 'green' };

export function ciVerdict(checks: DeliverCheck[], required: string[], stable: boolean): CiVerdict {
  if (checks.length === 0) return { kind: 'none' };
  const failed = checks.filter((c) => c.state === 'failure');
  if (failed.length > 0) return { kind: 'red', detail: `red: ${failed.map((c) => c.name).join(', ')}` };
  const missing = required.filter((n) => !checks.some((c) => c.name === n));
  if (missing.length > 0) return { kind: 'missing', names: missing };
  const pending = checks.filter((c) => c.state === 'pending');
  if (pending.length > 0) return { kind: 'pending', detail: `${pending.length}/${checks.length} check(s) pending` };
  if (!stable) return { kind: 'unstable', detail: 'the check set changed since the last poll — confirming it is complete' };
  // All terminal and none red. Green needs ≥1 SUCCESS check, and an Actions check that passed must have run ≥1 step.
  const succeeded = checks.filter((c) => c.state === 'success');
  const empty = succeeded.filter((c) => c.steps === 0);
  if (empty.length > 0) return { kind: 'zero-steps', detail: `green with 0 steps: ${empty.map((c) => c.name).join(', ')}` };
  // A REQUIRED check must have actually run: skipped/neutral is "ran nothing", the green this rule exists to refuse.
  const notRun = checks.filter((c) => required.includes(c.name) && c.state !== 'success');
  if (notRun.length > 0) return { kind: 'zero-steps', detail: `required check(s) skipped/neutral, never ran: ${notRun.map((c) => c.name).join(', ')}` };
  // Without --require-check, green needs ≥1 check with COUNTED steps: an external status / non-Actions check (steps null) alone proves nothing ran.
  if (required.length === 0 && !succeeded.some((c) => c.steps !== null && c.steps > 0)) {
    return { kind: 'zero-steps', detail: 'no Actions check with counted steps passed (all skipped/neutral/external) — name external CI with --require-check' };
  }
  return { kind: 'green' };
}

/** The decision. Order matters: cheap/permanent refusals first, then the head, then CI. A refusal never depends on a wait. */
export function decideDelivery(i: DecideInput): Decision {
  const { pr, checks, verdict } = i;
  if (pr.state === 'MERGED') {
    // "Already merged" is only the answer when it was merged AT the verified head — else it is a different head's merge.
    if (pr.headRefOid !== i.verifiedHead) {
      return { action: 'refuse', reason: 'head-moved', detail: `PR was merged at ${short(pr.headRefOid)}, verified head is ${short(i.verifiedHead)}` };
    }
    if (verdict && (verdict.blocking > 0 || verdict.major > 0)) {
      return { action: 'refuse', reason: 'review-blocking', detail: `PR already merged, but review round ${verdict.round} has ${verdict.blocking} BLOCKING / ${verdict.major} MAJOR` };
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

  const c = ciVerdict(checks, i.requiredChecks ?? [], i.stable);
  switch (c.kind) {
    case 'none':
      if (i.waitedMs < i.noChecksGraceMs) return { action: 'wait', why: 'no checks registered yet' };
      return { action: 'refuse', reason: 'no-checks', detail: `0 checks on ${short(pr.headRefOid)} after ${Math.round(i.waitedMs / 1000)}s — a PR with no CI is not green` };
    case 'red':
      return { action: 'refuse', reason: 'ci-red', detail: c.detail };
    case 'missing':
      if (i.waitedMs < i.noChecksGraceMs) return { action: 'wait', why: `required check(s) not registered: ${c.names.join(', ')}` };
      return { action: 'refuse', reason: 'no-checks', detail: `required check(s) never registered: ${c.names.join(', ')}` };
    case 'pending':
    case 'unstable':
      return { action: 'wait', why: c.detail };
    case 'zero-steps':
      return { action: 'refuse', reason: 'zero-steps', detail: c.detail };
    case 'green':
      break;
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

export type PackageManager = 'pnpm' | 'yarn' | 'npm' | 'bun';
export type SuiteSource = 'flag' | 'packageManager' | 'lockfile' | 'fallback';

/** #487 — the package manager of the TARGET repo: `package.json` `packageManager` ("pnpm@9.1.0") wins, else the root lockfile
 *  (pnpm-lock.yaml > yarn.lock > bun.lock[b] > package-lock.json), else null (the caller falls back). Pure: the I/O is the caller's. */
export function detectPackageManager(packageJson: string | null, rootFiles: readonly string[]): { pm: PackageManager; source: 'packageManager' | 'lockfile' } | null {
  if (packageJson) {
    try {
      const field = (JSON.parse(packageJson) as { packageManager?: unknown }).packageManager;
      const m = typeof field === 'string' ? /^(pnpm|yarn|npm|bun)(@|$)/.exec(field.trim()) : null;
      if (m) return { pm: m[1] as PackageManager, source: 'packageManager' };
    } catch { /* unparseable package.json: fall through to the lockfile */ }
  }
  const has = (f: string) => rootFiles.includes(f);
  if (has('pnpm-lock.yaml') || has('pnpm-workspace.yaml')) return { pm: 'pnpm', source: 'lockfile' };
  if (has('yarn.lock')) return { pm: 'yarn', source: 'lockfile' };
  if (has('bun.lock') || has('bun.lockb')) return { pm: 'bun', source: 'lockfile' };
  if (has('package-lock.json') || has('npm-shrinkwrap.json')) return { pm: 'npm', source: 'lockfile' };
  return null;
}

/** The test command of a package manager. `npm test` is also the fallback when the repo names none (works in any node repo with a test script). */
export function suiteCommandFor(pm: PackageManager | null): string {
  return pm === 'pnpm' ? 'pnpm run test' : pm === 'yarn' ? 'yarn test' : pm === 'bun' ? 'bun run test' : 'npm test';
}

/** The command the COORDINATOR runs on the target after N merges (the verb never runs a repo suite itself). */
export function combinedSuiteCommand(into: string, suiteCmd = suiteCommandFor(null)): string {
  if (!SAFE_REF.test(into)) throw new Error(`unsafe target ref: ${into}`);
  return `git fetch origin ${into} && git checkout --detach origin/${into} && git rev-list --count HEAD..origin/${into} && ${suiteCmd}`;
}

// ---- #495 — `orchestra fanout gate`: the verifier's checklist is DERIVED, not prose -------------------------------------------------

const globRe = (g: string): RegExp => new RegExp(`^${g.replace(/[.+^${}()|[\]\\]/g, '\\$&').replace(/\*\*/g, '\u0000').replace(/\*/g, '[^/]*').replace(/\u0000/g, '.*')}$`);
const unq = (x: string): string => x.trim().replace(/^['"]|['"]$/g, '');
/** `[a, b]` / `- a` items of a YAML list value, from the inline remainder and the following more-indented lines. */
function listOf(rest: string, following: string[]): string[] {
  const inline = rest.trim();
  if (inline.startsWith('[')) return inline.replace(/^\[|\]\s*$/g, '').split(',').map(unq).filter(Boolean);
  if (inline) return [unq(inline)];
  return following.map((l) => /^\s*-\s*(.*)$/.exec(l)?.[1]).filter((x): x is string => x !== undefined).map(unq);
}

/**
 * True only when the workflow PROVABLY runs on a push to a PR into `into`: `on: pull_request` (scalar, list, block map or flow map) whose
 * `branches` admit `into`, `branches-ignore` does not exclude it, `types` (when given) include `synchronize`, and no `paths` filter
 * (a path-filtered run may not exist for this diff). Anything it cannot read the same way is FALSE: the verifier then keeps the suite (fail closed).
 */
export function workflowRunsOnPr(yaml: string, into = 'main'): boolean {
  const lines = yaml.replace(/#.*$/gm, '').split('\n');
  const at = lines.findIndex((l) => /^['"]?on['"]?\s*:/.test(l));
  if (at < 0) return false;
  const rest = lines[at].replace(/^['"]?on['"]?\s*:/, '').trim();
  const isPr = (t: string) => /^pull_request(_target)?$/.test(t);
  if (rest) {
    if (rest.startsWith('{')) return /[{,]\s*['"]?pull_request(_target)?['"]?\s*:\s*(\{\s*\}|[,}])/.test(rest); // a flow map with ANY filter is unreadable here: false
    return rest.replace(/^\[|\]$/g, '').split(',').map(unq).some(isPr);
  }
  const body: string[] = [];
  for (const l of lines.slice(at + 1)) {
    if (l.trim() === '') continue;
    if (!/^\s/.test(l)) break; // next top-level key
    body.push(l);
  }
  if (body.length === 0) return false;
  const indent = (l: string) => /^\s*/.exec(l)![0].length;
  const top = Math.min(...body.map(indent));
  const children = body.filter((l) => indent(l) === top);
  if (children.some((l) => isPr(unq(/^\s*-\s*(.*)$/.exec(l)?.[1] ?? '')))) return true; // list form: no filters possible
  const idx = body.findIndex((l) => indent(l) === top && /^\s*['"]?pull_request(_target)?['"]?\s*:/.test(l));
  if (idx < 0) return false;
  const sub: string[] = [];
  for (const l of body.slice(idx + 1)) { if (indent(l) <= top) break; sub.push(l); }
  const subTop = sub.length ? Math.min(...sub.map(indent)) : 0;
  const keys = new Map<string, { rest: string; following: string[] }>();
  sub.forEach((l, i) => {
    const m = indent(l) === subTop ? /^\s*([\w-]+)\s*:(.*)$/.exec(l) : null;
    if (!m) return;
    const following: string[] = [];
    for (const f of sub.slice(i + 1)) { if (indent(f) <= subTop) break; following.push(f); }
    keys.set(m[1], { rest: m[2], following });
  });
  const val = (k: string) => { const e = keys.get(k); return e ? listOf(e.rest, e.following) : null; };
  if (keys.has('paths') || keys.has('paths-ignore')) return false;
  for (const k of keys.keys()) if (!['branches', 'branches-ignore', 'types'].includes(k)) return false; // an unknown key: not read the same way
  const br = val('branches'), ign = val('branches-ignore'), ty = val('types');
  if (br !== null && !br.some((g) => globRe(g).test(into))) return false;
  if (ign !== null && ign.some((g) => globRe(g).test(into))) return false;
  if (ty !== null && !ty.includes('synchronize')) return false;
  return true;
}

export type GateInput = {
  /** Workflow files of the TARGET branch (null = the listing could not be read). */
  workflows: string[] | null;
  /** The open PR `<branch> → <target>` (null = none opened yet). */
  pr: { headRefOid: string } | null;
  /** The head the verifier checked out and verifies. Full 40-hex. */
  head: string;
  checks: DeliverCheck[];
  requiredChecks?: string[];
  /** The target branch (a workflow's `branches` filter must admit it). */
  into?: string;
  /** The check-name set is identical across two reads a few seconds apart (a late-registering check can't hide behind an early green). */
  stable: boolean;
};

export type GateAnswer = {
  /** `pr-workflows` = the target has a pull_request workflow (or checks already run on the PR head); `none` = it has not; `unknown` = could not read. */
  repoCi: 'pr-workflows' | 'none' | 'unknown';
  /** CI state of the PR's CURRENT head — and only that head. */
  ci: 'no-pr' | 'none' | 'pending' | 'red' | 'zero-steps' | 'green';
  /** The PR head right now (null without a PR). */
  prHead: string | null;
  /** true ⇒ the CI answer above is about the head the verifier verifies. false ⇒ a CI-green of another head is NOT accepted. */
  headMatches: boolean;
  /** WHO runs the full test suite: `ci` (the verifier does not) / `verifier` (its seat — no PR CI to trust, or could not tell). */
  fullSuite: 'ci' | 'verifier';
  /** The verifier may sign PASS on the CI side ONLY when true: PR CI exists, is green, on exactly `head`. Always false when fullSuite is `verifier`. */
  ciGreenOnHead: boolean;
  /** Names of the checks on the PR head: confirm one of them runs the test suite (a lint-only CI is not the suite; pin it with --require-check). */
  ciChecks: string[];
  checklist: { skip: string[]; wait: string[]; keep: string[]; run: string[] };
  detail: string;
};

const KEEP = ['real entry-point drive of the changed flow', 'mutants of every changed clause', 'browser / UI drive for a user-facing surface', 'rigs the ticket names', 'anything the CI checks do not cover (a CI check that does not run the test suite is not the suite: run it, or pin the check with --require-check)'];

/** Pure. Fail closed: every doubt (no workflow listing, no PR, a moved head, red/pending/zero-step CI) leaves the verifier NOT trusting CI. */
export function decideGate(i: GateInput): GateAnswer {
  const prHead = i.pr?.headRefOid ?? null;
  const headMatches = prHead === i.head;
  const verdict: CiVerdict | null = i.pr ? ciVerdict(i.checks, i.requiredChecks ?? [], i.stable) : null;
  const ci: GateAnswer['ci'] = !i.pr ? 'no-pr' : verdict!.kind === 'none' ? 'none' : verdict!.kind === 'red' ? 'red' : verdict!.kind === 'zero-steps' || verdict!.kind === 'missing' ? 'zero-steps' : verdict!.kind === 'green' ? 'green' : 'pending';
  const repoCi: GateAnswer['repoCi'] =
    i.workflows === null ? 'unknown'
    : i.workflows.some((w) => workflowRunsOnPr(w, i.into)) ? 'pr-workflows'
    : 'none'; // readable workflows with no provable PR trigger: a check on the head (push workflow, external status) is NOT PR CI
  const hasCi = repoCi === 'pr-workflows';
  const h = i.head.slice(0, 12);
  if (!hasCi) {
    return {
      repoCi, ci, prHead, headMatches, fullSuite: 'verifier', ciGreenOnHead: false, ciChecks: [],
      checklist: { skip: [], wait: [], keep: [], run: ['full test suite on the verifier seat, once per candidate', 'typecheck', ...KEEP.slice(0, -1)] },
      detail: repoCi === 'none' ? 'the target has no PR CI: the full suite stays on the verifier\'s seat' : 'could not read the target\'s workflows: full suite stays on the verifier\'s seat',
    };
  }
  const ciGreenOnHead = ci === 'green' && headMatches;
  const why = !i.pr ? 'no PR open: `orchestra fanout open` first (CI runs while you gate)'
    : !headMatches ? `PR head is ${(prHead ?? '').slice(0, 12)}, you verify ${h}: re-fetch and re-gate; the CI of another head is not accepted`
    : ci === 'green' ? `CI green on ${h}` : `CI ${ci} on ${h}: do not sign PASS until green`;
  return {
    repoCi, ci, prHead, headMatches, fullSuite: 'ci', ciGreenOnHead, ciChecks: i.checks.map((c) => c.name),
    checklist: { skip: ['full test suite (the PR CI runs it)'], wait: [`CI green on exactly ${h} (re-run this verb after any push)`], keep: KEEP, run: [] },
    detail: why,
  };
}
