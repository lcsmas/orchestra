// `orchestra fanout deliver` (#467) — one PR per ticket into the target branch, CI awaited (0 checks / 0 steps is NOT green),
// merged at the verified head in ONE `gh pr merge --match-head-commit` call. Store-less (no socket): it only runs `gh`.
// The decision is PURE (src/shared/fanout-deliver.ts); this file is the I/O around it, with `gh` behind an injectable runner.
// Shares the `fanout` namespace with #469 (state/resume, src/cli/fanout-state.ts): the `fanout` case in index.ts routes `deliver` here.

import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError,
  readState,
  resolveFanoutRun,
  seatRecordsOn,
  stateFile,
  switchesOf,
  updateState,
} from '../shared/fanout-state.ts';
import {
  classifyMergeFailure,
  combinedSuiteCommand,
  detectPackageManager,
  suiteCommandFor,
  DELIVER_EXIT,
  decideDelivery,
  isUserStep,
  normaliseRollupItem,
  parseActionsJobUrl,
  parseReviewVerdict,
  RIG_SELECTION_NOTE,
  rigSelectionOf,
  SAFE_REF,
  type DeliverCheck,
  type PrSnapshot,
  type RefuseReason,
  type ReviewVerdict,
  type RollupItem,
  type SuiteSource,
  type UpstreamFacts,
  decideUpstreams,
} from '../shared/fanout-deliver.ts';
import { decideDeliverReceipt, parseReceipt, type DeliverAcceptanceReason, type Receipt } from '../shared/fanout-acceptance.ts';
import type { Acceptance, FanoutState, FollowUpReason, TicketState } from '../shared/fanout-state.ts';
import { recordedVerdictOf } from '../shared/fanout-record.ts';
import { askFollowUp, followUpFromState, type FollowUpReader } from './fanout-followup.ts';
import { bypassInto, type AcceptancePhase } from '../shared/fanout-acceptance.ts';
import { acceptanceFromState, rereadFrozenAtHead } from './fanout-acceptance.ts';

export interface GhResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** `gh` behind a seam: tests pass a fake, production spawns the real binary (argv, never a shell). */
export type GhRunner = (args: string[]) => Promise<GhResult>;

export const realGh: GhRunner = (args) =>
  new Promise((resolve) => {
    execFile('gh', args, { maxBuffer: 16 * 1024 * 1024, timeout: 120_000 }, (err, stdout, stderr) => {
      const code = err ? (typeof (err as { code?: unknown }).code === 'number' ? ((err as { code: number }).code) : 1) : 0;
      resolve({ code, stdout: String(stdout), stderr: err && (err as { code?: unknown }).code === 'ENOENT' ? 'gh: command not found' : String(stderr) });
    });
  });

export interface DeliverOpts {
  branch: string;
  into: string;
  ticket: string;
  reviewVerdict?: string;
  /** `--no-review-gate`: the explicit opt-out of the review gate (#473). Without it, no `--review-verdict` is refused. */
  noReviewGate?: boolean;
  verifiedHead?: string;
  strategy: 'merge' | 'squash' | 'rebase';
  timeoutMs: number;
  intervalMs: number;
  noChecksGraceMs: number;
  suiteCmd?: string;
  repo?: string;
  requireChecks: string[];
  /** #506 — the fanout run whose state file names this ticket's upstreams (default: the caller's own run). */
  run?: string;
  /** `--no-acceptance-gate` (#515): the coordinator's recorded escape for a ticket whose frozen tests never landed (acceptance-pending). Never lifts an edited / red frozen test. */
  noAcceptanceGate?: boolean;
  /** #510 — the gate's receipt file (`acceptance.receipt`), required when the ticket has frozen acceptance tests. */
  acceptance?: string;
}

export const DELIVER_USAGE =
  'usage: orchestra fanout deliver --branch <b> --into <target> --ticket <id> (--review-verdict <file> | --no-review-gate) [--verified-head <sha>]\n' +
  '       [--strategy merge|squash|rebase] [--timeout <s>] [--interval <s>] [--no-checks-grace <s>] [--suite-cmd <cmd>] [--repo <owner/name>] [--require-check <name>]… [--run <id>] [--acceptance <receipt.json>] [--no-acceptance-gate]';

export type ParsedArgs = { ok: true; opts: DeliverOpts } | { ok: false; error: string };

/** Strict argv parse: an unknown flag or a ref that could be read as a gh option / shell metacharacter is a usage error (exit 1). */
export function parseDeliverArgs(args: string[]): ParsedArgs {
  const v: Record<string, string> = {};
  const known = new Set(['--branch', '--into', '--ticket', '--review-verdict', '--verified-head', '--strategy', '--timeout', '--interval', '--no-checks-grace', '--suite-cmd', '--repo', '--require-check', '--run', '--acceptance']);
  const required: string[] = [];
  let noReviewGate = false;
  let noAcceptanceGate = false;
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (k === '--no-review-gate') { noReviewGate = true; i -= 1; continue; } // valueless flag
    if (k === '--no-acceptance-gate') { noAcceptanceGate = true; i -= 1; continue; } // valueless flag (#515)
    if (!known.has(k)) return { ok: false, error: `unknown argument: ${k}\n${DELIVER_USAGE}` };
    const val = args[i + 1];
    if (val === undefined) return { ok: false, error: `${k} needs a value\n${DELIVER_USAGE}` };
    if (k === '--require-check') required.push(val);
    else v[k] = val;
  }
  if (noReviewGate && v['--review-verdict'] !== undefined) return { ok: false, error: '--no-review-gate contradicts --review-verdict: give one' };
  for (const k of ['--branch', '--into', '--ticket']) if (!v[k]) return { ok: false, error: `${k} is required\n${DELIVER_USAGE}` };
  if (!SAFE_REF.test(v['--branch'])) return { ok: false, error: `unsafe --branch: ${v['--branch']}` };
  if (!SAFE_REF.test(v['--into'])) return { ok: false, error: `unsafe --into: ${v['--into']}` };
  if (v['--verified-head'] !== undefined && !/^[0-9a-f]{40}$/.test(v['--verified-head'])) return { ok: false, error: '--verified-head must be a full 40-hex sha' };
  if (v['--repo'] !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(v['--repo'])) return { ok: false, error: '--repo must be <owner>/<name>' };
  if (v['--run'] !== undefined && !/^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/.test(v['--run'])) return { ok: false, error: '--run must be a plain run id' };
  const strategy = v['--strategy'] ?? 'merge';
  if (strategy !== 'merge' && strategy !== 'squash' && strategy !== 'rebase') return { ok: false, error: '--strategy must be merge, squash or rebase' };
  const secs = (flag: string, dflt: number): number | null => {
    if (v[flag] === undefined) return dflt;
    const n = Number(v[flag]);
    return v[flag].trim() !== '' && Number.isFinite(n) && n >= 0 ? n : null;
  };
  const timeout = secs('--timeout', 1800);
  const interval = secs('--interval', 20);
  const grace = secs('--no-checks-grace', 120);
  if (timeout === null || interval === null || interval < 1 || grace === null) return { ok: false, error: '--timeout/--interval/--no-checks-grace take non-negative seconds (--interval ≥ 1)' };
  return {
    ok: true,
    opts: {
      branch: v['--branch'],
      into: v['--into'],
      ticket: v['--ticket'],
      reviewVerdict: v['--review-verdict'],
      noReviewGate,
      noAcceptanceGate,
      verifiedHead: v['--verified-head'],
      strategy,
      timeoutMs: timeout * 1000,
      intervalMs: interval * 1000,
      noChecksGraceMs: grace * 1000,
      suiteCmd: v['--suite-cmd'],
      repo: v['--repo'],
      requireChecks: required,
      run: v['--run'],
      acceptance: v['--acceptance'],
    },
  };
}

export interface DeliverResult {
  verdict: 'merged' | 'already-merged' | 'refused' | 'unchecked';
  reason?: RefuseReason | 'typed-verdict' | 'ungated-merge' | 'record-missing' | 'no-verdict' | 'timeout' | 'gh-failed' | 'bad-verdict' | 'no-verified-head' | 'merge-failed' | 'bad-args' | 'bad-state' | 'acceptance-pending' | FollowUpReason | DeliverAcceptanceReason;
  detail?: string;
  ticket: string;
  branch: string;
  into: string;
  pr?: number;
  url?: string;
  /** The head the merge was bound to: the PR's real head (= the verified head unless #512's same-tree rule applied). */
  head?: string;
  /** #512 — present when the verdict was kept by CONTENT: the PR head / the review verdict's head is another sha than `verifiedHead` with the same git tree. */
  viaTree?: { verifiedHead: string; tree: string };
  mergeCommit?: string;
  /** false ⇒ the merge was NOT gated by a review round (only possible with an explicit `--no-review-gate`). */
  reviewGated: boolean;
  /** Run this on the target after the merges (the verb never runs a repo suite). Present when the PR is on the target. */
  combinedSuite?: string;
  /** #506 — true: the state named this ticket and its upstreams (maybe none) were checked; false: NO state was consulted (none found, no --run), so order/content were NOT checked. Absent: refused before the check. */
  upstreamsChecked?: boolean;
  /** #589 (seatRecords=on) — the verdict came from the state: the recorded reviewer, its round, the word it recorded, the counts DERIVED from its open findings. Absent = the verdict file / no review gate (seatRecords off). */
  recorded?: { reviewer: string; round: number; verdict: string; blocking: number; major: number; minor: number };
  /** #510 — true: the ticket's frozen acceptance tests were proven (gate receipt for this head + this hash, and every frozen file re-read byte-identical at the head through gh). Absent: the ticket has none. */
  acceptanceChecked?: boolean;
  /** #515 — the ticket carries a spec but no frozen tests and was merged anyway: `bypassed` = `--no-acceptance-gate` (recorded in the state), `waived` = a recorded `acceptance waive`. */
  acceptanceGate?: 'bypassed' | 'waived';
  /** #487 — where `combinedSuite`'s test command came from: --suite-cmd, package.json packageManager, a lockfile on the target, or the npm fallback. */
  combinedSuiteSource?: SuiteSource;
  /** #595 — `by-path`: the PR CI that gated this merge ran only the rigs the changed files select; `rigSelectionNote` says what that means. Absent = every rig / not read. */
  rigSelection?: 'by-path';
  rigSelectionNote?: string;
}

export interface DeliverDeps {
  gh: GhRunner;
  sleep: (ms: number) => Promise<void>;
  now: () => number;
  readFile: (p: string) => string;
  /** Progress lines (stderr in production). */
  log: (s: string) => void;
  /** #506 — the upstreams the state file names for `ticket` (none when there is no state / no such ticket). Absent = none. */
  upstreams?: (opts: { ticket: string; run?: string }) => UpstreamRef[] | null;
  /** #510 — the ticket's frozen acceptance tests from the state (`consulted:false` = no state read). Absent = the clause is not consulted. Throws on an unreadable state / explicit --run with none / unknown ticket (⇒ exit 1). */
  acceptance?: (opts: { ticket: string; run?: string }) => { consulted: boolean; acceptance: Acceptance | null; phase?: AcceptancePhase; ticket?: TicketState; run?: string };
  /** #514 — the follow-up rule (a candidate on a merged ticket must name a BLOCKING|MAJOR finding it fixes). Throws like `acceptance` ⇒ exit 1. Absent = not consulted. */
  followUp?: FollowUpReader;

  /** #563 — the run's `verifier` switch, read only when `--no-review-gate` is given (off = no verifier seat: the review verdict is the only gate, so the ungated merge is refused). null = no state consulted. Throws like `acceptance` ⇒ exit 1. Absent = not consulted. */
  verifierSwitch?: (opts: { ticket: string; run?: string }) => 'on' | 'off' | null;

  /** #589 — the run's fanout state when its `seatRecords` switch is ON (the verdict is then READ from it, `--review-verdict` / `--no-review-gate` refused); null = off / no state consulted. Throws like `acceptance` ⇒ exit 1. Absent = not consulted. */
  recorded?: (opts: { ticket: string; run?: string }) => FanoutState | null;

  /** #515 — leave the `--no-acceptance-gate` bypass on the ticket in the state (best effort; a failure is logged, the escape is also in the printed result). */
  recordBypass?: (o: { ticket: string; run: string; head: string }) => void;
}

/** One upstream of the ticket being delivered, as the fanout state records it. */
export interface UpstreamRef {
  id: string;
  branch: string | null;
  pr: number | null;
  /** The upstream head the dependent was built on (state `builtOn[id]`), if recorded. */
  builtOn: string | null;
  /** state `mergedAccepted` set: the human override, nothing is checked. */
  accepted: boolean;
  /** #512 — tree of `builtOn` as recorded when it was set (state `builtOnTree`): the content key that survives the old commit being rewritten away. null = not recorded (read through gh). */
  builtOnTree?: string | null;
}

/** Production reader: `<ORCHESTRA_HOME>/fanout/<run>/state.json`. FAILS CLOSED (throws ⇒ could-not-check, exit 1) on an explicit `--run` with no state, a
 *  ticket the existing state does not name, or an unreadable state; null = no state consulted at all (no --run, none at the caller's own run): the
 *  pre-#506 store-less delivery, reported as `upstreamsChecked:false`. */
export function upstreamsFromState(opts: { ticket: string; run?: string }, env: NodeJS.ProcessEnv = process.env): UpstreamRef[] | null {
  const { run } = resolveFanoutRun(opts.run, env);
  if (!run) return null;
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  const state = readState(stateFile(home, run));
  if (!state) {
    if (opts.run) throw new FanoutStateError(`no fanout state for --run ${opts.run} (${stateFile(home, run)}): a wrong run id would skip the order rule`);
    return null;
  }
  const t = state.tickets[opts.ticket];
  if (!t) throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run} (known: ${Object.keys(state.tickets).slice(0, 12).join(', ') || 'none'}): a mistyped --ticket would skip the order rule`);
  const early = switchesOf(state).earlyGate === 'on'; // #554: earlyGate off = before #506: the order rule stays (the upstream must be merged), the built-on content check (upstream-changed) is absent
  return t.dependsOn.map((id) => {
    const u = state.tickets[id];
    return { id, branch: u?.branch ?? null, pr: u?.pr ?? null, builtOn: early ? t.builtOn[id] ?? null : null, builtOnTree: early ? t.builtOnTree[id] ?? null : null, accepted: !!u?.mergedAccepted && u.status === 'merged' };
  });
}

/** #563 — the `verifier` switch of the run that names `ticket`, with the same run resolution + fail-closed rules as `upstreamsFromState` (an explicit `--run` with no state / an unknown ticket throws). */
export function verifierSwitchFromState(opts: { ticket: string; run?: string }, env: NodeJS.ProcessEnv = process.env): 'on' | 'off' | null {
  const { run, inherited } = resolveFanoutRun(opts.run, env);
  if (!run) return null;
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  let sawState = false;
  for (const r of opts.run || !inherited ? [run] : [run, inherited]) {
    const state = readState(stateFile(home, r));
    if (!state) continue;
    sawState = true;
    if (state.tickets[opts.ticket]) return switchesOf(state).verifier;
  }
  if (!sawState) {
    if (opts.run) throw new FanoutStateError(`no fanout state for --run ${opts.run}: a wrong run id would skip the verifier switch`);
    return null;
  }
  throw new FanoutStateError(`ticket ${opts.ticket} is not in the fanout state of run ${run}: a mistyped --ticket would skip the verifier switch`);
}

/** #589 — the state of the run that names `ticket` when its `seatRecords` is ON; null = off, no state, or a ticket the state does not name (LENIENT: the strict readers — upstreams, acceptance — refuse those cases themselves, so a seatRecords-off run behaves exactly as before). An unreadable state throws. */
export function recordedStateFor(opts: { ticket: string; run?: string }, env: NodeJS.ProcessEnv = process.env): FanoutState | null {
  const { run, inherited } = resolveFanoutRun(opts.run, env);
  if (!run) return null;
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  for (const r of opts.run || !inherited ? [run] : [run, inherited]) {
    const state = readState(stateFile(home, r));
    if (state?.tickets[opts.ticket]) {
      if (!seatRecordsOn(state) && opts.run) { // a `--run` naming ANOTHER run that is off, while the caller's own run records: a decoy run would skip the switch
        const own = resolveFanoutRun(undefined, env).run;
        const ownState = own && own !== r ? readState(stateFile(home, own)) : null;
        if (ownState && seatRecordsOn(ownState)) throw new FanoutStateError(`[run-switch] --run ${r} has seatRecords=off but your own run ${own} has seatRecords=on: a delivery under another run would skip the recorded-verdict rule — deliver under your own run (drop --run)`);
      }
      return seatRecordsOn(state) ? state : null;
    }
  }
  return null;
}

export const realDeps = (): DeliverDeps => ({
  gh: realGh,
  sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
  now: () => Date.now(),
  readFile: (p) => fs.readFileSync(p, 'utf8'),
  log: (s) => process.stderr.write(`${s}\n`),
  upstreams: (o) => upstreamsFromState(o),
  acceptance: (o) => acceptanceFromState(o),
  followUp: (o) => followUpFromState(o),
  verifierSwitch: (o) => verifierSwitchFromState(o),
  recorded: (o) => recordedStateFor(o),
  recordBypass: (o) => {
    const home = process.env.ORCHESTRA_HOME && process.env.ORCHESTRA_HOME.trim() ? process.env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
    updateState(stateFile(home, o.run), (cur) => { if (!cur) throw new Error('no state'); return bypassInto(cur, o.ticket, { head: o.head, now: new Date().toISOString() }); });
  },
});

class GhError extends Error {}

/** #512 — the git tree of `sha` as GitHub reports it (`gh api commits/<sha>`); null = unreadable (the sha comparison then stands: never looser). */
export async function readTree(gh: (args: string[]) => Promise<GhResult>, repo: string | undefined, sha: string): Promise<string | null> {
  if (!/^[0-9a-f]{7,40}$/.test(sha)) return null;
  const r = await gh(['api', `repos/${repo ?? '{owner}/{repo}'}/commits/${sha}`]);
  if (r.code !== 0) return null;
  try {
    const t = (JSON.parse(r.stdout) as { commit?: { tree?: { sha?: unknown } } }).commit?.tree?.sha;
    return typeof t === 'string' && /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(t) ? t : null;
  } catch { return null; }
}

export interface DeliverOutcome {
  exit: number;
  result: DeliverResult;
}

/** #487 — the target repo's test command, read from `<target>` on GitHub (root listing + package.json), never from this checkout. */
export async function suiteCommandForTarget(opts: Pick<DeliverOpts, 'into' | 'repo' | 'suiteCmd'>, gh: GhRunner): Promise<{ cmd: string; source: SuiteSource }> {
  if (opts.suiteCmd) return { cmd: opts.suiteCmd, source: 'flag' };
  const base = `repos/${opts.repo ?? '{owner}/{repo}'}/contents`;
  const ref = `?ref=${encodeURIComponent(opts.into)}`;
  try {
    const root = await gh(['api', `${base}${ref}`]);
    if (root.code !== 0) throw new Error('root listing');
    const names = (JSON.parse(root.stdout) as { name?: string }[]).map((e) => String(e.name));
    const pj = names.includes('package.json') ? await gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/package.json${ref}`]) : null;
    const found = detectPackageManager(pj && pj.code === 0 ? pj.stdout : null, names);
    if (found) return { cmd: suiteCommandFor(found.pm), source: found.source };
  } catch { /* could not read the target: the fallback below */ }
  return { cmd: suiteCommandFor(null), source: 'fallback' };
}

/** One snapshot of a PR: its state/head and its checks, an Actions check's step count read from the run (cached once terminal). Shared by `deliver` and `fanout gate` (#495). */
export async function readPrChecks(ghOk: (args: string[]) => Promise<string>, prId: string, stepCache: Map<string, number>): Promise<{ view: PrSnapshot; checks: DeliverCheck[] }> {
  const view = JSON.parse(
    await ghOk(['pr', 'view', prId, '--json', 'state,baseRefName,headRefOid,mergeable,statusCheckRollup']),
  ) as PrSnapshot & { statusCheckRollup?: RollupItem[] };
  const rollup = view.statusCheckRollup ?? [];
  const stepsByUrl = new Map<string, number | null>();
  for (const it of rollup) {
    const url = it.detailsUrl ?? it.targetUrl;
    const job = parseActionsJobUrl(url);
    if (!url || !job || (it.conclusion ?? '').toUpperCase() !== 'SUCCESS' || stepsByUrl.has(url)) continue;
    const key = `${job.run}/${job.job ?? ''}`;
    let n = stepCache.get(key);
    if (n === undefined) {
      // Fail closed: an Actions job whose steps cannot be read is could-not-check, never "no steps to worry about".
      const jobs = JSON.parse(await ghOk(['run', 'view', job.run, '--json', 'jobs'])) as { jobs?: { databaseId?: number; steps?: { name?: string; conclusion?: string }[] }[] };
      const mine = (jobs.jobs ?? []).filter((j) => job.job === null || String(j.databaseId) === job.job);
      if (mine.length === 0) throw new GhError(`gh run view ${job.run}: job ${job.job} not found`);
      n = mine.reduce((a, j) => a + (j.steps ?? []).filter((s) => (s.conclusion ?? '').toLowerCase() === 'success' && isUserStep(s.name)).length, 0);
      stepCache.set(key, n);
    }
    stepsByUrl.set(url, n);
  }
  const checks: DeliverCheck[] = rollup.map((it) => normaliseRollupItem(it, (u) => (u && stepsByUrl.has(u) ? (stepsByUrl.get(u) as number | null) : null)));
  return { view, checks };
}

/** #506 — read what GitHub says about each upstream and whether the dependent's verified head sits on it. Any unreadable fact throws (could-not-check, exit 1). */
export async function gatherUpstreamFacts(
  refs: UpstreamRef[], opts: Pick<DeliverOpts, 'into' | 'repo'>, verifiedHeads: string | string[],
  gh: GhRunner, ghOk: (args: string[]) => Promise<string>,
): Promise<UpstreamFacts[]> {
  const api = async (rel: string): Promise<Record<string, unknown>> => {
    const r = await gh(['api', `repos/${opts.repo ?? '{owner}/{repo}'}/${rel}`]);
    if (r.code !== 0) throw new GhError(`gh api ${rel.split('?')[0]} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 300)}`);
    return JSON.parse(r.stdout) as Record<string, unknown>;
  };
  const treeOf = async (sha: string): Promise<string> => {
    const t = ((await api(`commits/${sha}`)).commit as { tree?: { sha?: string } } | undefined)?.tree?.sha;
    if (!t) throw new GhError(`gh api commits/${sha.slice(0, 12)}: no tree in the answer`);
    return t;
  };
  /** `base` is an ancestor of (or equal to) `head`. */
  const contains = async (head: string, base: string): Promise<boolean> => {
    const st = (await api(`compare/${base}...${head}`)).status;
    if (typeof st !== 'string') throw new GhError(`gh api compare ${base.slice(0, 12)}...${head.slice(0, 12)}: no status in the answer`);
    return st === 'ahead' || st === 'identical';
  };
  const heads = Array.isArray(verifiedHeads) ? verifiedHeads : [verifiedHeads]; // #512: every sha the verdict covers (same tree): any of them may be the one sitting on the upstream
  const containsAny = async (base: string): Promise<boolean> => { for (const h of heads) if (await contains(h, base)) return true; return false; };
  type PrRow = { number: number; state: 'OPEN' | 'MERGED' | 'CLOSED'; baseRefName: string; headRefOid: string; mergeCommit?: { oid?: string } | null };
  const out: UpstreamFacts[] = [];
  for (const u of refs) {
    const base: UpstreamFacts = { id: u.id, accepted: u.accepted, builtOn: u.builtOn, pr: null, sameTree: null, dependentOnBuiltOn: null, dependentOnMerge: null };
    if (u.accepted) { out.push(base); continue; }
    const fields = 'number,state,baseRefName,headRefOid,mergeCommit';
    let row: PrRow | undefined;
    if (u.pr) {
      // The recorded PR is THE upstream PR (fail closed): never a look-alike picked by branch name — its own base/state decide.
      row = JSON.parse(await ghOk(['pr', 'view', String(u.pr), '--json', fields])) as PrRow;
    } else if (u.branch) {
      const rows = JSON.parse(await ghOk(['pr', 'list', '--head', u.branch, '--base', opts.into, '--state', 'all', '--json', fields, '--limit', '10'])) as PrRow[];
      row = rows.find((r) => r.state === 'MERGED') ?? rows[0];
    } else {
      throw new GhError(`upstream ${u.id}: the state records neither a branch nor a PR, so its merge cannot be read`);
    }
    base.pr = row ? { state: row.state, baseRefName: row.baseRefName, headRefOid: row.headRefOid, mergeCommit: row.mergeCommit?.oid ?? null } : null;
    if (base.pr && base.pr.state === 'MERGED' && base.pr.baseRefName === opts.into && u.builtOn) {
      const mergedHead = base.pr.headRefOid;
      if (typeof mergedHead !== 'string' || !mergedHead) throw new GhError(`upstream ${u.id}: GitHub reported no head for its merged PR`);
      if (!(mergedHead.startsWith(u.builtOn) || u.builtOn.startsWith(mergedHead))) base.sameTree = (u.builtOnTree ?? (await treeOf(u.builtOn))) === (await treeOf(mergedHead));
      base.dependentOnBuiltOn = await containsAny(u.builtOn);
      base.dependentOnMerge = base.pr.mergeCommit ? await containsAny(base.pr.mergeCommit) : false;
    }
    out.push(base);
  }
  return out;
}

/** The TARGET branch's workflow files (contents read from GitHub, never this checkout). `[]` = the repo has none (404); `null` = could not read. */
export async function targetWorkflows(opts: { repo?: string; into: string }, deps: Pick<DeliverDeps, 'gh'>): Promise<string[] | null> {
  const base = `repos/${opts.repo ?? '{owner}/{repo}'}/contents/.github/workflows`;
  const ref = `?ref=${encodeURIComponent(opts.into)}`;
  const list = await deps.gh(['api', `${base}${ref}`]);
  if (list.code !== 0) return /404|Not Found/i.test(list.stderr) ? [] : null;
  let names: string[];
  try {
    names = (JSON.parse(list.stdout) as { name?: string; type?: string }[]).filter((e) => e.type !== 'dir' && /\.ya?ml$/i.test(String(e.name))).map((e) => String(e.name));
  } catch {
    return null;
  }
  const out: string[] = [];
  for (const n of names) {
    const f = await deps.gh(['api', '-H', 'Accept: application/vnd.github.raw+json', `${base}/${encodeURIComponent(n)}${ref}`]);
    if (f.code !== 0) return null; // an unreadable workflow could be the PR one: not "none"
    out.push(f.stdout);
  }
  return out;
}

export async function deliver(opts: DeliverOpts, deps: DeliverDeps): Promise<DeliverOutcome> {
  const out = await deliverGated(opts, deps);
  if (out.result.combinedSuite === undefined) return out;
  const s = await suiteCommandForTarget(opts, deps.gh);
  if (s.source === 'fallback') deps.log('combinedSuite: could not tell the target repo\'s package manager (no packageManager field / lockfile read) — using "npm test"; pass --suite-cmd to set it');
  const result: DeliverResult = { ...out.result, combinedSuite: combinedSuiteCommand(opts.into, s.cmd), combinedSuiteSource: s.source };
  // #595 — say it when the merged PR's CI selected rigs by path (best effort: an unreadable workflow adds nothing, it never changes the verdict).
  try {
    if (rigSelectionOf(await targetWorkflows(opts, deps), opts.into) === 'by-path') { result.rigSelection = 'by-path'; result.rigSelectionNote = RIG_SELECTION_NOTE; }
  } catch { /* informational only */ }
  return { exit: out.exit, result };
}

async function deliverGated(opts: DeliverOpts, deps: DeliverDeps): Promise<DeliverOutcome> {
  const base = { ticket: opts.ticket, branch: opts.branch, into: opts.into };
  let upstreamsChecked: boolean | undefined;
  let acceptanceChecked: boolean | undefined;
  let verdictVia: DeliverResult['viaTree'];
  let headVia: DeliverResult['viaTree'];
  let acceptanceGate: 'bypassed' | 'waived' | undefined;
  let recordedInfo: DeliverResult['recorded'];
  let bypassRec: { run: string; head: string } | null = null;
  const done = (result: Omit<DeliverResult, 'ticket' | 'branch' | 'into' | 'reviewGated'>, reviewGated: boolean): DeliverOutcome => {
    if (bypassRec && (result.verdict === 'merged' || result.verdict === 'already-merged')) {
      try { deps.recordBypass?.({ ticket: opts.ticket, run: bypassRec.run, head: bypassRec.head }); } catch (e) { deps.log(`acceptance: could not record the bypass in the state (${(e as Error).message}); it is in this result (acceptanceGate:"bypassed")`); }
      bypassRec = null;
    }
    const full: DeliverResult = { ...result, ...base, reviewGated, ...(upstreamsChecked !== undefined ? { upstreamsChecked } : {}), ...(acceptanceChecked ? { acceptanceChecked } : {}), ...(acceptanceGate ? { acceptanceGate } : {}), ...(recordedInfo ? { recorded: recordedInfo } : {}), ...((headVia ?? verdictVia) ? { viaTree: headVia ?? verdictVia } : {}) };
    if (result.verdict === 'merged' || result.verdict === 'already-merged') full.combinedSuite = combinedSuiteCommand(opts.into, opts.suiteCmd);
    const exit = full.verdict === 'refused' ? DELIVER_EXIT.refused : full.verdict === 'unchecked' ? DELIVER_EXIT.unchecked : DELIVER_EXIT.merged;
    return { exit, result: full };
  };
  const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
  const gh = async (args: string[]): Promise<GhResult> => deps.gh([...args, ...repoArgs]);
  const ghOk = async (args: string[]): Promise<string> => {
    const r = await gh(args);
    if (r.code !== 0) throw new GhError(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 400)}`);
    return r.stdout;
  };

  if (!SAFE_REF.test(opts.into) || !SAFE_REF.test(opts.branch)) {
    return { exit: DELIVER_EXIT.unchecked, result: { verdict: 'unchecked', reason: 'bad-args', detail: 'unsafe --into/--branch', ...base, reviewGated: false } };
  }
  // 1. The review verdict (required unless `--no-review-gate`, #473) and the verified head.
  // #512 — a verdict is keyed on CONTENT: the git tree of a sha, read once per sha.
  const treeMemo = new Map<string, Promise<string | null>>();
  const treeOf = (sha: string): Promise<string | null> => { let p = treeMemo.get(sha); if (!p) { p = readTree(gh, opts.repo, sha); treeMemo.set(sha, p); } return p; };
  // 0. #589 — seatRecords=on: the verdict is the recorded reviewer's, read from the state; a typed verdict file and the ungated merge are refused.
  let recState: FanoutState | null = null;
  if (deps.recorded) {
    try { recState = deps.recorded({ ticket: opts.ticket, run: opts.run }); } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s seatRecords switch: ${(e as Error).message}` }, false);
    }
  }
  let recordedHead: string | undefined;
  let verdict: ReviewVerdict | undefined;
  if (recState) {
    if (opts.reviewVerdict) return done({ verdict: 'refused', reason: 'typed-verdict', detail: `[typed-verdict] seatRecords=on: the review verdict is the reviewer's recorded one (\`orchestra fanout record\`), read from the state — a verdict file typed by the coordinator is refused. Drop --review-verdict` }, false);
    if (opts.noReviewGate) return done({ verdict: 'refused', reason: 'ungated-merge', detail: `[ungated-merge] seatRecords=on: a merge needs the recorded reviewer's verdict on the delivered head — --no-review-gate is refused. Spawn / wake the reviewer: \`orchestra fanout review ${opts.ticket}\`` }, false);
    recordedHead = opts.verifiedHead ?? recState.tickets[opts.ticket]?.head ?? undefined;
    if (!recordedHead || !/^[0-9a-f]{40}$/.test(recordedHead)) return done({ verdict: 'unchecked', reason: 'no-verified-head', detail: `give --verified-head <40-hex sha>: the merge is bound to the head the recorded verdict speaks about (the state records ${recState.tickets[opts.ticket]?.head ?? 'none'})` }, false);
    const rd = recordedVerdictOf(recState, opts.ticket, recordedHead, await treeOf(recordedHead));
    if (!rd.ok) return done({ verdict: 'refused', reason: rd.reason, detail: rd.detail, head: recordedHead }, false);
    verdict = { round: rd.recorded.round, blocking: rd.recorded.blocking, major: rd.recorded.major, minor: rd.recorded.minor, head: rd.recorded.head };
    recordedInfo = { reviewer: rd.recorded.reviewer, round: rd.recorded.round, verdict: rd.recorded.verdict, blocking: rd.recorded.blocking, major: rd.recorded.major, minor: rd.recorded.minor };
  }
  if (!recState && !opts.reviewVerdict && !opts.noReviewGate) {
    return done({ verdict: 'refused', reason: 'no-verdict', detail: 'no review verdict: pass --review-verdict <file> (the round\'s counts + head), or --no-review-gate to merge without a review round (reviewGated:false stays in the result)' }, false);
  }
  if (!recState && opts.noReviewGate && deps.verifierSwitch) { // #563: verifier=off — the reviewer's verdict is the only gate left, never skippable
    let sw: 'on' | 'off' | null;
    try { sw = deps.verifierSwitch({ ticket: opts.ticket, run: opts.run }); } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s verifier switch: ${(e as Error).message}` }, false);
    }
    if (sw === 'off') return done({ verdict: 'refused', reason: 'no-verdict', detail: 'verifier=off (#563): there is no verifier seat, the review verdict is the only gate — pass --review-verdict <file>; --no-review-gate is refused' }, false);
  }
  if (!recState && opts.reviewVerdict) {
    let raw: string;
    try {
      raw = deps.readFile(opts.reviewVerdict);
    } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-verdict', detail: `cannot read verdict file: ${(e as Error).message}` }, false);
    }
    const p = parseReviewVerdict(raw);
    if (!p.ok) return done({ verdict: 'unchecked', reason: 'bad-verdict', detail: p.error }, false);
    verdict = p.verdict;
  }
  const reviewGated = verdict !== undefined;
  const verifiedArg = opts.verifiedHead ?? recordedHead; // #589: under seatRecords the delivered head is the state's own
  const verifiedHead = verifiedArg ?? verdict?.head;
  if (!verifiedHead) {
    return done({ verdict: 'unchecked', reason: 'no-verified-head', detail: 'give --verified-head <sha> or --review-verdict <file> (its "head"): the merge is bound to a head' }, reviewGated);
  }
  // #512 — the review round's head and the verified head may be different shas (rebase, author rewrite) if their git trees are equal.
  let verdictSameTree = false;
  if (verifiedArg && verdict && verdict.head !== verifiedArg) {
    const [a, b] = [await treeOf(verdict.head), await treeOf(verifiedArg)];
    if (a && a === b) { verdictSameTree = true; verdictVia = { verifiedHead: verifiedArg, tree: a }; deps.log(`review verdict is for ${verdict.head.slice(0, 12)}, verified head is ${verifiedArg.slice(0, 12)}: same git tree ${a.slice(0, 12)} — the verdict stands`); }
    else {
      return done(
        { verdict: 'refused', reason: 'verdict-head-mismatch', detail: `--verified-head ${verifiedArg.slice(0, 12)} != the verdict's head ${verdict.head.slice(0, 12)}${a && b ? ' (the trees differ: the content changed)' : ' (trees unreadable: compared by sha)'}`, head: verifiedArg },
        reviewGated,
      );
    }
  }

  // 1a0. #514 — a follow-up candidate on an already-merged ticket must name a BLOCKING|MAJOR finding it fixes (before the PR is opened and before any wait).
  if (deps.followUp) {
    let fu;
    try { fu = await askFollowUp(deps.followUp, { ticket: opts.ticket, run: opts.run, head: verifiedHead, branch: opts.branch }, treeOf); } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s follow-up rule: ${(e as Error).message}` }, reviewGated);
    }
    if (fu.refusal) return done({ verdict: 'refused', reason: fu.refusal.reason, detail: fu.refusal.detail, head: verifiedHead }, reviewGated);
  }
  // 1a. #510 — frozen acceptance tests: the gate's RECEIPT for this head + this frozen set, AND an independent byte re-read of every frozen file at the head through gh.
  // Before the PR is opened and before any wait: a refusal never depends on CI. The receipt is the coordinator's own file; the re-read is not.
  if (deps.acceptance) {
    let got: ReturnType<NonNullable<DeliverDeps['acceptance']>>;
    try {
      got = deps.acceptance({ ticket: opts.ticket, run: opts.run });
    } catch (e) {
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state to find ${opts.ticket}'s frozen acceptance tests: ${(e as Error).message}` }, reviewGated);
    }
    if (opts.acceptance !== undefined && !got.acceptance) {
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `--acceptance was given but ${got.consulted ? `ticket ${opts.ticket} has no frozen acceptance tests in the fanout state` : 'no fanout state was found (pass --run)'}` }, reviewGated);
    }
    if (!got.consulted) deps.log(`acceptance: no fanout state consulted for ${opts.ticket} (no --run, none at your own run) — frozen acceptance tests NOT checked`);
    if (got.acceptance) {
      let receipt: Receipt | null = null;
      if (opts.acceptance !== undefined) {
        let text: string | null = null;
        try { text = deps.readFile(opts.acceptance); } catch (e) { return done({ verdict: 'refused', reason: 'acceptance-unproven', detail: `cannot read the acceptance receipt ${opts.acceptance}: ${(e as Error).message}`, head: verifiedHead }, reviewGated); }
        const pr = parseReceipt(text);
        if (!pr.ok) return done({ verdict: 'refused', reason: 'acceptance-unproven', detail: `${opts.acceptance}: ${pr.error}`, head: verifiedHead }, reviewGated);
        receipt = pr.receipt;
      }
      const rd = decideDeliverReceipt(got.acceptance, receipt, verifiedHead, { ticket: opts.ticket, headTree: receipt && receipt.head !== verifiedHead && receipt.tree ? await treeOf(verifiedHead) : null });
      if (!rd.ok) return done({ verdict: 'refused', reason: rd.reason, detail: rd.detail, head: verifiedHead }, reviewGated);
      let files;
      try { files = await rereadFrozenAtHead(got.acceptance, verifiedHead, opts.repo, deps.gh); } catch (e) { return done({ verdict: 'unchecked', reason: 'gh-failed', detail: e instanceof Error ? e.message : String(e) }, reviewGated); }
      const bad = files.filter((f) => f.status !== 'same');
      if (bad.length) return done({ verdict: 'refused', reason: bad.every((f) => f.config) ? 'frozen-config-changed' : 'frozen-test-changed', detail: `frozen test file(s)${bad.some((f) => f.config) ? ' / runner config' : ''} at ${verifiedHead.slice(0, 12)} differ from the frozen bytes: ${bad.slice(0, 8).map((f) => `${f.path} (${f.status})`).join(', ')}`, head: verifiedHead }, reviewGated);
      acceptanceChecked = true;
      deps.log(`acceptance ok: ${files.length} frozen file(s) byte-identical at ${verifiedHead.slice(0, 12)}, receipt for hash ${got.acceptance.hash.slice(0, 12)}`);
    } else if (got.phase === 'pending' || got.phase === 'unspecified') {
      // #515: a spec is registered and nothing was frozen (or waived): the merge waits. The only ways through are the freeze, `acceptance waive` or the recorded `--no-acceptance-gate`.
      const w = got.ticket?.accept?.acceptor;
      if (!opts.noAcceptanceGate) {
        const ways = `three ways out: (1) register --spec so the test writer is spawned and the tests are frozen, (2) coordinator, recorded: \`fanout acceptance waive ${opts.ticket} --decision <ledger comment naming it> --reason …\`, (3) coordinator, recorded: \`fanout deliver … --no-acceptance-gate\``;
        return done({ verdict: 'refused', reason: 'acceptance-pending', detail: got.phase === 'unspecified'
          ? `${opts.ticket} has no registered spec, no frozen acceptance tests and no waiver: ${ways}`
          : `${opts.ticket} has a registered spec (${got.ticket?.spec ?? '?'}) but its acceptance tests are not frozen${w ? ` (writer ${w.name}${w.id ? ` ${w.id}` : ''}${w.error ? `, spawn failed: ${w.error}` : ''})` : ' (no writer spawned: `fanout acceptance spawn`)'}: wait for the freeze status, or ${ways}`, head: verifiedHead }, reviewGated);
      }
      acceptanceGate = 'bypassed';
      deps.log(`acceptance: ${opts.ticket} has no frozen tests — merging anyway on --no-acceptance-gate (recorded)`);
      if (got.run) bypassRec = { run: got.run, head: verifiedHead }; // recorded in the state only once the merge LANDED (see `done`): a red CI / timeout leaves the ticket pending
    } else if (got.phase === 'waived') acceptanceGate = 'waived';
  }

  try {
    // 1b. #506 — order + content: every upstream merged, and this head still sits on the upstream content it was built on and gated against.
    // Before the PR is opened and before any wait: a refusal never depends on CI, and a dependent that would merge out of order opens nothing.
    let refs: UpstreamRef[];
    try {
      const got = deps.upstreams ? deps.upstreams({ ticket: opts.ticket, run: opts.run }) : null;
      upstreamsChecked = got !== null;
      refs = got ?? [];
    } catch (e) {
      const bad = e instanceof FanoutStateError;
      return done({ verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state to find ${opts.ticket}'s upstreams: ${bad ? e.message : (e as Error).message}` }, reviewGated);
    }
    if (refs.length > 0) {
      const facts = await gatherUpstreamFacts(refs, opts, verdictSameTree && verdict ? [verifiedHead, verdict.head] : verifiedHead, gh, ghOk);
      const u = decideUpstreams(facts, opts.into);
      if (!u.ok) return done({ verdict: 'refused', reason: u.reason, detail: u.detail, head: verifiedHead }, reviewGated);
      deps.log(`upstreams ok: ${refs.map((r) => r.id).join(', ')}`);
    } else if (!upstreamsChecked) {
      deps.log(`upstreams: no fanout state consulted for ${opts.ticket} (no --run, none at your own run) — order/content NOT checked (upstreamsChecked:false)`);
    }
    // 2. Open or reuse the PR.
    const listed = JSON.parse(
      await ghOk(['pr', 'list', '--head', opts.branch, '--base', opts.into, '--state', 'all', '--json', 'number,url,state,headRefOid', '--limit', '10']),
    ) as { number: number; url: string; state: string; headRefOid?: string }[];
    // A MERGED PR is reused only when it was merged AT the verified head; a stale one from an earlier round must not shadow a new PR.
    let pr = listed.find((p) => p.state === 'OPEN') ?? listed.find((p) => p.state === 'MERGED' && p.headRefOid === verifiedHead);
    if (!pr) {
      const out = await ghOk([
        'pr', 'create', '--head', opts.branch, '--base', opts.into,
        '--title', `${opts.ticket}: ${opts.branch}`,
        '--body', `Ticket ${opts.ticket}. Delivered by \`orchestra fanout deliver\` (merge bound to head ${verifiedHead.slice(0, 12)}).`,
      ]);
      const url = out.trim().split('\n').pop() ?? '';
      const num = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1]);
      if (!Number.isInteger(num)) throw new GhError(`gh pr create printed no PR url: ${out.trim().slice(0, 200)}`);
      pr = { number: num, url, state: 'OPEN' };
      deps.log(`opened PR #${num} ${url}`);
    } else {
      deps.log(`reusing PR #${pr.number} (${pr.state}) ${pr.url}`);
    }
    const prId = String(pr.number);
    const prInfo = { pr: pr.number, url: pr.url };

    // 3. Wait → decide, until merge / refuse / timeout.
    const stepCache = new Map<string, number>(); // `${run}/${job}` → steps; only terminal (success) jobs are cached
    const t0 = deps.now();
    let prevNames: string | null = null;
    for (;;) {
      const { view, checks } = await readPrChecks(ghOk, prId, stepCache);
      const names = JSON.stringify(checks.map((c) => c.name).sort());
      const stable = names === prevNames;
      prevNames = names;
      // #512 — the PR head is another sha than the verified one: the verdict still holds when the git trees are equal (a rebase / an author rewrite changes shas, not content).
      let headSameTree = false;
      let treesDiffer = false;
      if (view.headRefOid !== verifiedHead && view.state !== 'CLOSED') {
        const [a, b] = [await treeOf(view.headRefOid), await treeOf(verifiedHead)];
        headSameTree = !!a && a === b;
        treesDiffer = !!a && !!b && a !== b;
      }
      headVia = headSameTree ? { verifiedHead, tree: (await treeOf(verifiedHead))! } : undefined;
      const d = decideDelivery({
        pr: view, checks, stable, requiredChecks: opts.requireChecks, into: opts.into, verifiedHead, verdict,
        waitedMs: deps.now() - t0, noChecksGraceMs: opts.noChecksGraceMs, headSameTree, verdictSameTree, treesDiffer,
      });
      if (d.action === 'already-merged') return done({ verdict: 'already-merged', detail: 'the PR was already merged at the verified head (not re-gated by the review verdict or CI)', ...prInfo, head: view.headRefOid }, reviewGated);
      if (d.action === 'refuse') return done({ verdict: 'refused', reason: d.reason, detail: d.detail, ...prInfo, head: view.headRefOid }, reviewGated);
      if (d.action === 'merge') {
        // ONE call: the head is checked by GitHub inside the merge, so a push between decide and act makes it fail, not merge the wrong thing.
        const m = await gh(['pr', 'merge', prId, `--${opts.strategy}`, '--match-head-commit', d.head]);
        if (m.code !== 0) {
          if (classifyMergeFailure(m.stderr) === 'head-moved') {
            return done({ verdict: 'refused', reason: 'head-moved', detail: `the head moved during the merge call: ${m.stderr.trim().slice(0, 300)}`, ...prInfo, head: d.head }, reviewGated);
          }
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge failed (exit ${m.code}): ${m.stderr.trim().slice(0, 400)}`, ...prInfo, head: d.head }, reviewGated);
        }
        // Read it back: exit 0 can mean "queued" (merge queue / auto-merge), which is not merged. Unknown state ⇒ could-not-check, never "merged".
        let after: { state?: string; mergeCommit?: { oid?: string } | null };
        try {
          after = JSON.parse(await ghOk(['pr', 'view', prId, '--json', 'state,mergeCommit']));
        } catch (e) {
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge exited 0 but the PR state could not be read back: ${(e as Error).message}`, ...prInfo, head: d.head }, reviewGated);
        }
        if (after.state !== 'MERGED') {
          return done({ verdict: 'unchecked', reason: 'merge-failed', detail: `gh pr merge exited 0 but the PR is ${after.state ?? 'in an unknown state'} (merge queue / auto-merge?), not MERGED`, ...prInfo, head: d.head }, reviewGated);
        }
        const mergeCommit = after.mergeCommit?.oid ?? undefined;
        return done({ verdict: 'merged', ...prInfo, head: d.head, ...(mergeCommit ? { mergeCommit } : {}) }, reviewGated);
      }
      if (deps.now() - t0 + opts.intervalMs > opts.timeoutMs) {
        return done({ verdict: 'unchecked', reason: 'timeout', detail: `still waiting after ${Math.round((deps.now() - t0) / 1000)}s: ${d.why}`, ...prInfo }, reviewGated);
      }
      deps.log(`waiting: ${d.why}`);
      await deps.sleep(opts.intervalMs);
    }
  } catch (e) {
    return done({ verdict: 'unchecked', reason: 'gh-failed', detail: e instanceof Error ? e.message : String(e) }, reviewGated);
  }
}

/** `orchestra help fanout` text for the deliver half (appended to #469's FANOUT_USAGE in help.ts). */
export const DELIVER_HELP = `usage: orchestra fanout deliver --branch <b> --into <target> --ticket <id> (--review-verdict <file> | --no-review-gate) [--verified-head <sha>]
                                [--strategy merge|squash|rebase] [--timeout <s>] [--interval <s>] [--no-checks-grace <s>]
                                [--suite-cmd <cmd>] [--repo <owner/name>] [--require-check <name>]… [--run <id>] [--acceptance <receipt.json>] [--no-acceptance-gate]

deliver: open or reuse the PR <branch> → <target>, wait for CI, then merge with
\`gh pr merge --match-head-commit <verified head>\` (check and merge are ONE call).
Order (#506): a ticket whose upstreams the fanout state names (--run, default your own run) merges ONLY after each upstream
merged into <target> (upstream-not-merged), and only if its verified head still sits on the upstream content it was built on
and gated against (state builtOn; a fix round or refusal on the upstream since = upstream-changed: re-gate). Nominating and gating early is allowed; merging out of order is not.
Content key (#512): a verdict is keyed on the git TREE, not the sha. The PR head, --verified-head and the review verdict's head may be different shas of ONE tree (rebase, author rewrite):
the merge then binds to the REAL PR head (result head, viaTree:{verifiedHead,tree}); trees that differ, or cannot be read, keep the old sha refusals (head-moved, verdict-head-mismatch).
A gate receipt for another sha holds only if its tree = the verified head's tree and its ticket = --ticket (acceptance-stale otherwise; a changed frozen set/command is still acceptance-stale).
Follow-up (#514): a follow-up candidate on an already-merged ticket (\`state set --follow-up-of <merged> --fixes <ids>\`; or --ticket naming a merged ticket with a head other than the one it merged at, or carrying the branch/PR of one) is refused (exit 2, before any PR is opened) unless it fixes >= 1 BLOCKING|MAJOR finding recorded on the merged ticket: followup-undeclared | followup-no-finding | followup-unknown-finding | followup-minor-only | followup-base-not-merged. MINOR findings get no action — except (#552) a MINOR carrying a specSentence that is a literal sentence of the ticket's captured spec: it may be named in --fixes, and while unsettled / undecided it refuses the merge (exit 2, reason finding-unsettled, before any PR is opened). Code checks the sentence is IN the spec, not that it is really broken (judging that stays with the reviewer).
Acceptance (#510): a ticket with frozen acceptance tests (the fanout state, \`fanout acceptance freeze\`) needs --acceptance <receipt.json> (the gate's
acceptance.receipt {head,tree,ticket,hash,ok} for THIS verified head (or its tree) and THIS frozen set, ok:true — else acceptance-unproven | acceptance-stale | frozen-test-failed) AND every frozen file is re-read
at the verified head through gh and must be byte-identical (else frozen-test-changed); so must the runner config of a \`jest --config\` command (else frozen-config-changed, #542). Unreadable state / unknown ticket with --acceptance ⇒ exit 1. A ticket without frozen tests is unchanged.
Forced flow (#515): a ticket registered with --spec and NOT frozen is refused (exit 2, acceptance-pending) — the freeze lands, or the coordinator waives it (\`fanout acceptance waive\`) or passes --no-acceptance-gate (recorded in the state and in the result as acceptanceGate:"bypassed"). Neither lifts a refusal for an edited or red frozen test.
verifier=off (#563, \`state set --switch verifier=off\`): no verifier seat — the reviewer's verdict (0 BLOCKING / 0 MAJOR on the delivered head, tree-keyed #512) AND a green CI on that head are the whole gate; --no-review-gate is refused (no-verdict) when the fanout state says off.
Refuses on: no review verdict (pass --review-verdict <file>, or --no-review-gate to
merge ungated: the result then says reviewGated:false), 0 checks, a passing check with 0 steps, red CI, BLOCKING/MAJOR > 0 in
the verdict file, a head that is not the verified head, a conflict, a --require-check
that is missing or skipped (name external CI with it: statuses alone are not green).
Prints ONE JSON line (verdict, reason, pr, head, combinedSuite = the command to run
on <target> after N merges, its test command read from the target: package.json
packageManager, else the lockfile, else "npm test"; --suite-cmd overrides). Verdict file: {"round":1,"blocking":0,"major":0,"minor":2,"head":"<40-hex>"}.
Exit codes: 0 = merged (or already merged at the verified head), 2 = refused,
            1 = could not check (usage, gh failed, timeout, unreadable verdict)`;

/** `orchestra fanout deliver <args>` — `args` is what follows `deliver`. The `fanout` case in index.ts routes here; #469's runFanout owns state/resume. */
export async function runDeliver(args: string[], deps: DeliverDeps = realDeps()): Promise<{ exit: number; stdout?: string; error?: string }> {
  const p = parseDeliverArgs(args);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await deliver(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
