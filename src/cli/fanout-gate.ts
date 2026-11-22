// `orchestra fanout gate` (#495) — what the VERIFIER may skip: does the target repo have PR CI, and is it green on the head being verified?
// READ-ONLY (gh `api`/`pr list|view`/`run view`, never a write), store-less, open to every role. The decision is pure (decideGate in
// src/shared/fanout-deliver.ts, sharing deliver's `ciVerdict`); this file is the gh I/O. `deliver` stays the merge authority and re-checks at merge.

import os from 'node:os';
import path from 'node:path';
import { readState, resolveFanoutRun, stackView, stateFile, type StackView } from '../shared/fanout-state.ts';
import { DELIVER_EXIT, SAFE_REF, decideGate, type GateAnswer } from '../shared/fanout-deliver.ts';
import { readPrChecks, realDeps, type DeliverDeps } from './fanout-deliver.ts';
import { acceptanceFromState, checkAcceptanceInCheckout, realCheckoutIo, type CheckoutIo } from './fanout-acceptance.ts';
import type { Acceptance } from '../shared/fanout-state.ts';
import type { GateAcceptance } from '../shared/fanout-acceptance.ts';

export interface GateOpts {
  branch: string;
  into: string;
  /** The head the verifier verifies (full 40-hex). */
  head: string;
  repo?: string;
  requireChecks: string[];
  /** #506 — the ticket (and its fanout run) whose upstreams the answer reports as `stack`. */
  ticket?: string;
  run?: string;
  /** #510 — the candidate checkout the ticket's frozen acceptance tests are hashed + run in (required when the ticket has any). */
  cwd?: string;
  /** ms between the two check reads (default 5000). */
  settleMs?: number;
}

export interface GateResult extends Partial<GateAnswer> {
  verdict: 'gate' | 'unchecked' | 'refused';
  reason?: 'gh-failed' | 'bad-args' | GateAcceptance['reason'];
  /** #510 — present when `--ticket` names a ticket with frozen acceptance tests. */
  acceptance?: GateAcceptance;
  detail?: string;
  branch: string;
  into: string;
  /** The head asked about (echoed): a CI answer is only ever about THIS head. */
  head: string;
  pr?: number;
  /** #506 — present when `--ticket` was given: null = the state has no such ticket (or no state); else the ticket's upstream situation. */
  stack?: StackView | null;
}

export const GATE_USAGE = 'usage: orchestra fanout gate --branch <b> --into <target> --head <sha> [--repo <owner/name>] [--require-check <name>]… [--ticket <id> [--run <id>] [--cwd <checkout>]]';

export type ParsedGate = { ok: true; opts: GateOpts } | { ok: false; error: string };

export function parseGateArgs(args: string[]): ParsedGate {
  const v: Record<string, string> = {};
  const required: string[] = [];
  const known = new Set(['--branch', '--into', '--head', '--repo', '--require-check', '--ticket', '--run', '--cwd']);
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!known.has(k)) return { ok: false, error: `unknown argument: ${k}\n${GATE_USAGE}` };
    const val = args[i + 1];
    if (val === undefined) return { ok: false, error: `${k} needs a value\n${GATE_USAGE}` };
    if (k === '--require-check') required.push(val);
    else v[k] = val;
  }
  for (const k of ['--branch', '--into', '--head']) if (!v[k]) return { ok: false, error: `${k} is required\n${GATE_USAGE}` };
  if (!SAFE_REF.test(v['--branch'])) return { ok: false, error: `unsafe --branch: ${v['--branch']}` };
  if (!SAFE_REF.test(v['--into'])) return { ok: false, error: `unsafe --into: ${v['--into']}` };
  if (!/^[0-9a-f]{40}$/.test(v['--head'])) return { ok: false, error: '--head must be a full 40-hex sha' };
  if (v['--repo'] !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(v['--repo'])) return { ok: false, error: '--repo must be <owner>/<name>' };
  if (v['--run'] !== undefined && v['--ticket'] === undefined) return { ok: false, error: '--run only applies with --ticket' };
  if (v['--cwd'] !== undefined && v['--ticket'] === undefined) return { ok: false, error: '--cwd only applies with --ticket' };
  return { ok: true, opts: { branch: v['--branch'], into: v['--into'], head: v['--head'], repo: v['--repo'], requireChecks: required, ticket: v['--ticket'], run: v['--run'], cwd: v['--cwd'] } };
}

/** The TARGET branch's workflow files (contents read from GitHub, never this checkout). `[]` = the repo has none (404); `null` = could not read. */
async function targetWorkflows(opts: GateOpts, deps: Pick<DeliverDeps, 'gh'>): Promise<string[] | null> {
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

/** Production reader of `--ticket`'s stack from `<ORCHESTRA_HOME>/fanout/<run>/state.json`; null = no state / no such ticket. An unreadable state throws. */
export function stackFromState(opts: { ticket: string; run?: string }, env: NodeJS.ProcessEnv = process.env): StackView | null {
  const { run } = resolveFanoutRun(opts.run, env);
  if (!run) return null;
  const home = env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
  const state = readState(stateFile(home, run));
  return state ? stackView(state, opts.ticket) : null;
}

export type GateDeps = Pick<DeliverDeps, 'gh' | 'log' | 'sleep'> & {
  stack?: (o: { ticket: string; run?: string }) => StackView | null;
  /** #510 — the ticket's frozen acceptance tests (null = none / no state). Absent = the clause is not consulted. Throws on an unreadable state (⇒ exit 1). */
  acceptance?: (o: { ticket: string; run?: string }) => Acceptance | null;
  checkout?: CheckoutIo;
};

export async function gatePr(opts: GateOpts, deps: GateDeps): Promise<{ exit: number; result: GateResult }> {
  const base = { branch: opts.branch, into: opts.into, head: opts.head };
  const bad = (reason: 'gh-failed' | 'bad-args', detail: string) => ({ exit: DELIVER_EXIT.unchecked, result: { verdict: 'unchecked' as const, reason, detail, ...base } });
  if (!SAFE_REF.test(opts.into) || !SAFE_REF.test(opts.branch)) return bad('bad-args', 'unsafe --into/--branch');
  const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
  const ghOk = async (args: string[]): Promise<string> => {
    const r = await deps.gh([...args, ...repoArgs]);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 400)}`);
    return r.stdout;
  };
  try {
    // #510 — the acceptance clause first: a candidate whose frozen tests changed / fail / were not proven is refused (exit 2) before any CI read.
    let accept: GateAcceptance | undefined;
    const frozen = opts.ticket !== undefined && deps.acceptance ? deps.acceptance({ ticket: opts.ticket, run: opts.run }) : null;
    if (frozen) {
      accept = checkAcceptanceInCheckout(frozen, { cwd: opts.cwd, head: opts.head, log: deps.log }, deps.checkout ?? realCheckoutIo);
      if (!accept.ok) return { exit: DELIVER_EXIT.refused, result: { verdict: 'refused', reason: accept.reason, detail: accept.detail, acceptance: accept, ...base } };
    }
    const workflows = await targetWorkflows(opts, deps);
    const open = JSON.parse(await ghOk(['pr', 'list', '--head', opts.branch, '--base', opts.into, '--state', 'open', '--json', 'number,headRefOid', '--limit', '5'])) as { number: number; headRefOid: string }[];
    const pr = open[0] ?? null;
    const cache = new Map<string, number>();
    let snap = pr ? await readPrChecks(ghOk, String(pr.number), cache) : null;
    let stable = true;
    // A diff gh cannot produce (HTTP 406, > 300 files) is NOT 'no .github edits': null ⇒ decideGate answers fullSuite:"verifier".
    let prFiles: string[] | null = null;
    if (pr) {
      try { prFiles = (await ghOk(['pr', 'diff', String(pr.number), '--name-only'])).split('\n').map((f) => f.trim()).filter(Boolean); } catch (e) { deps.log(`gate: PR file list unread (${(e as Error).message.slice(0, 120)})`); }
    }
    if (snap) {
      // Two reads apart: a fast job registered before the slow suite's workflow must not read as the whole CI (deliver has the same two-poll rule).
      const first = JSON.stringify(snap.checks.map((c) => c.name).sort());
      await deps.sleep(opts.settleMs ?? 5000);
      snap = await readPrChecks(ghOk, String(pr!.number), cache);
      stable = JSON.stringify(snap.checks.map((c) => c.name).sort()) === first;
    }
    let stack: StackView | null | undefined;
    if (opts.ticket !== undefined) stack = deps.stack ? deps.stack({ ticket: opts.ticket, run: opts.run }) : null;
    const answer = decideGate({
      workflows, pr: snap ? { headRefOid: snap.view.headRefOid } : null, head: opts.head, checks: snap?.checks ?? [], requiredChecks: opts.requireChecks, into: opts.into, stable, prFiles,
    });
    if (workflows === null) deps.log('gate: could not read the target\'s .github/workflows — fullSuite stays on the verifier');
    return { exit: DELIVER_EXIT.merged, result: { verdict: 'gate', ...answer, ...base, ...(pr ? { pr: pr.number } : {}), ...(stack !== undefined ? { stack } : {}), ...(accept ? { acceptance: accept } : {}) } };
  } catch (e) {
    return bad('gh-failed', e instanceof Error ? e.message : String(e));
  }
}

export const GATE_HELP = `${GATE_USAGE}

gate: the verifier's checklist, DERIVED (read-only, any role). Says whether the target has PR CI
(a pull_request workflow on <target> that provably runs for a PR into it: no paths filter, branches admit <target>, no ! pattern, types include synchronize; pull_request_target is not) and whether it is green on exactly
--head (the sha you checked out). With PR CI: fullSuite:"ci" — do NOT re-run the full suite, wait for
ciGreenOnHead:true (two reads 5s apart, check names stable), keep the checklist's keep list. A green check is the SUITE only if it is a test job of the PR workflow (derived: suiteChecks) or pinned with --require-check <name>; none => fullSuite:"verifier". A reusable-workflow suite (caller job with uses:) is never derived: pin its full check name, e.g. ci / test. A PR that edits .github/ => fullSuite:"verifier" (its CI is the candidate's, not the target's read here). A suite check absent from the head is listed in absentSuiteChecks. NOT detected: a PR that changes what the test command runs (package.json scripts, runner config) — pin the check and review that diff. Without PR CI (or unreadable workflows): fullSuite:"verifier".
--ticket <id> [--run <id>] adds \`stack\` (#506, from the fanout state): order none | wait-upstream (stacked on a verified upstream candidate: gate it now, \`deliver\` merges only after the upstream) | re-gate (the upstream moved since this ticket was built on it: its verdict is void) | blocked (an upstream is no admissible candidate), plus one row per upstream.
Acceptance (#510): when the ticket has frozen acceptance tests (\`fanout acceptance freeze\`), \`--cwd <the candidate checkout>\` is REQUIRED: its HEAD must be --head and its tracked files clean, every frozen file is hashed there, then the frozen command runs there. Output gains \`acceptance: {ok, hash, files:[{path,status}], ran, receipt:{head,hash,ok}}\` — save \`receipt\` for \`deliver --acceptance\`. Any failure ⇒ exit 2, verdict "refused", reason frozen-test-changed | frozen-test-failed | acceptance-unproven | acceptance-stale-checkout (before any CI read). The ticket is read from the fanout state like \`stack\` (--run when it is not your own run; an unreadable state ⇒ exit 1, an absent state/ticket skips the clause — \`deliver\` is the authority and refuses a ticket with frozen tests that has no receipt).
A PR head other than --head ⇒ headMatches:false, ciGreenOnHead:false: the CI of another head is not accepted.
Prints ONE JSON line. Exit 0 = answered, 2 = refused (acceptance), 1 = could not check (usage, gh failed, unreadable state). \`deliver\` re-checks CI at merge.`;

/** Production deps: real gh + the state-file stack reader (a test drives `runGate` through THIS, so an unwired reader cannot pass). */
export const realGateDeps = (): GateDeps => ({ ...realDeps(), stack: (o) => stackFromState(o), acceptance: (o) => acceptanceFromState({ ...o, lenient: true }).acceptance });

export async function runGate(args: string[], deps: GateDeps = realGateDeps()): Promise<{ exit: number; stdout?: string; error?: string }> {
  const p = parseGateArgs(args);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await gatePr(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
