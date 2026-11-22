// `orchestra fanout gate` (#495) — what the VERIFIER may skip: does the target repo have PR CI, and is it green on the head being verified?
// READ-ONLY (gh `api`/`pr list|view`/`run view`, never a write), store-less, open to every role. The decision is pure (decideGate in
// src/shared/fanout-deliver.ts, sharing deliver's `ciVerdict`); this file is the gh I/O. `deliver` stays the merge authority and re-checks at merge.

import os from 'node:os';
import path from 'node:path';
import { readState, resolveFanoutRun, stackView, stateFile, updateState, type StackView } from '../shared/fanout-state.ts';
import { DELIVER_EXIT, SAFE_REF, decideGate, type GateAnswer } from '../shared/fanout-deliver.ts';
import { readPrChecks, readTree, realDeps, type DeliverDeps } from './fanout-deliver.ts';
import { acceptanceFromState, checkAcceptanceInCheckout, realCheckoutIo, type AcceptanceRead, type CheckoutIo } from './fanout-acceptance.ts';
import { GATE_WAIT_DEFAULT_SEC, GATE_WAIT_MAX_SEC, openWait } from '../shared/fanout-acceptance.ts';
import type { Acceptance, FollowUpReason } from '../shared/fanout-state.ts';
import { askFollowUp, followUpFromState, type FollowUpReader } from './fanout-followup.ts';
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
  /** #515 — seconds the gate waits for a ticket's frozen tests that have not landed yet (default GATE_WAIT_DEFAULT_SEC; 0 = answer `pending` at once). */
  acceptWaitSec?: number;
  /** #515 — ms between two reads of the state while waiting (default 2000). */
  pollMs?: number;
}

export interface GateResult extends Partial<GateAnswer> {
  /** `pending` (#515, exit 3): the ticket has a registered spec whose tests were not frozen within the wait — everything else the gate answers is in this line; no round is consumed. */
  verdict: 'gate' | 'unchecked' | 'refused' | 'pending';
  reason?: 'gh-failed' | 'bad-args' | 'bad-state' | 'acceptance-pending' | FollowUpReason | GateAcceptance['reason'];
  /** #510 — present when `--ticket` names a ticket with frozen acceptance tests. */
  acceptance?: GateAcceptance | { consulted: false } | { pending: true; spec: string | null; writer: string | null; wait: { since: string; deadline: string; boundSec: number } | null; /** set when the freeze landed during the wait but the candidate does not carry the files yet */ frozen?: { branch: string; files: string[]; run: string } } | { waived: { decision: string; reason: string } };
  detail?: string;
  branch: string;
  into: string;
  /** The head asked about (echoed): a CI answer is only ever about THIS head. */
  head: string;
  pr?: number;
  /** #506 — present when `--ticket` was given: null = the state has no such ticket (or no state); else the ticket's upstream situation. */
  stack?: StackView | null;
}

export const GATE_USAGE = 'usage: orchestra fanout gate --branch <b> --into <target> --head <sha> [--repo <owner/name>] [--require-check <name>]… [--ticket <id> [--run <id>] [--cwd <checkout>] [--accept-wait <s>]]';

export type ParsedGate = { ok: true; opts: GateOpts } | { ok: false; error: string };

export function parseGateArgs(args: string[]): ParsedGate {
  const v: Record<string, string> = {};
  const required: string[] = [];
  const known = new Set(['--branch', '--into', '--head', '--repo', '--require-check', '--ticket', '--run', '--cwd', '--accept-wait']);
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
  let acceptWaitSec: number | undefined;
  if (v['--accept-wait'] !== undefined) {
    if (v['--ticket'] === undefined) return { ok: false, error: '--accept-wait only applies with --ticket' };
    const n = Number(v['--accept-wait']);
    if (!/^\d{1,5}$/.test(v['--accept-wait']) || n > GATE_WAIT_MAX_SEC) return { ok: false, error: `--accept-wait must be whole seconds, 0..${GATE_WAIT_MAX_SEC}` };
    acceptWaitSec = n;
  }
  return { ok: true, opts: { acceptWaitSec, branch: v['--branch'], into: v['--into'], head: v['--head'], repo: v['--repo'], requireChecks: required, ticket: v['--ticket'], run: v['--run'], cwd: v['--cwd'] } };
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
  /** #515 — clock (ms) for the wait window; absent = Date.now. */
  now?: () => number;
  /** #515 — persist the wait window (since, deadline, bound) on the ticket in the state it was found in; returns the window in force. Absent = not persisted. */
  openWait?: (o: { ticket: string; run: string; boundSec: number; nowMs: number }) => { since: string; deadline: string; boundSec: number };
  stack?: (o: { ticket: string; run?: string }) => StackView | null;
  /** #510 — the ticket's frozen acceptance tests. `known:false` = no state / no such ticket (only without an explicit --run; with one the reader throws ⇒ exit 1 `bad-state`). Absent = not consulted. */
  acceptance?: (o: { ticket: string; run?: string }) => Pick<AcceptanceRead, 'known' | 'acceptance'> & Partial<Pick<AcceptanceRead, 'phase' | 'ticket' | 'run'>>;
  checkout?: CheckoutIo;
  /** #514 — the follow-up rule for `--ticket` (a candidate on a merged ticket must name a BLOCKING|MAJOR finding it fixes). Absent = not consulted. */
  followUp?: FollowUpReader;
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
    let accept: GateResult['acceptance'];
    let got: ReturnType<NonNullable<GateDeps['acceptance']>> | null = null;
    try { got = opts.ticket !== undefined && deps.acceptance ? deps.acceptance({ ticket: opts.ticket, run: opts.run }) : null; } catch (e) {
      return { exit: DELIVER_EXIT.unchecked, result: { verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s frozen acceptance tests: ${(e as Error).message}`, ...base } };
    }
    if (got && !got.known) {
      accept = { consulted: false }; // not "no frozen tests": the state / ticket was not found, so NOTHING was checked
      deps.log(`gate: no fanout state / no ticket ${opts.ticket} found (pass --run <id>): frozen acceptance tests NOT checked (acceptance.consulted:false)`);
    }
    const frozen = got?.acceptance ?? null;
    let copyNeeded: Acceptance | null = null;
    if (frozen) {
      accept = checkAcceptanceInCheckout(frozen, { cwd: opts.cwd, head: opts.head, ticket: opts.ticket, log: deps.log }, deps.checkout ?? realCheckoutIo);
      if (!accept.ok && copyPending(accept, frozen, opts, deps.checkout ?? realCheckoutIo)) copyNeeded = frozen; // nominated BEFORE the freeze: answered below, after the CI half, as pending
      else if (!accept.ok) return { exit: DELIVER_EXIT.refused, result: { verdict: 'refused', reason: accept.reason, detail: accept.detail, acceptance: accept, ...base } };
    }
    // #514 — a follow-up candidate on a merged ticket without a BLOCKING|MAJOR finding it fixes is refused (exit 2) after the acceptance clause (its reader's strictness is pinned by A's rig first), before any CI read.
    if (opts.ticket !== undefined && deps.followUp) {
      let fu;
      try { fu = await askFollowUp(deps.followUp, { ticket: opts.ticket, run: opts.run, head: opts.head, branch: opts.branch }, (sha) => readTree(deps.gh, opts.repo, sha)); } catch (e) {
        return { exit: DELIVER_EXIT.unchecked, result: { verdict: 'unchecked', reason: 'bad-state', detail: `cannot read the fanout state for ${opts.ticket}'s follow-up rule: ${(e as Error).message}`, ...base } };
      }
      if (fu.refusal) return { exit: DELIVER_EXIT.refused, result: { verdict: 'refused', reason: fu.refusal.reason, detail: fu.refusal.detail, ...base } };
    }
    // #515 — a ticket whose spec is registered but whose tests are not frozen yet: NOT refused. The rest of the gate runs now; the wait for the freeze comes after it.
    const pendingRead = got && got.known && !got.acceptance && got.phase === 'pending' ? got : null;
    if (got?.known && !got.acceptance && got.phase === 'waived' && got.ticket?.accept?.waived) accept = { waived: { decision: got.ticket.accept.waived.decision, reason: got.ticket.accept.waived.reason } };
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
    // #512 — the PR head is another sha than the one verified: read both trees; the same tree means the PR's CI is about the content being verified.
    let headTree: string | null = null;
    let prTree: string | null = null;
    if (snap && snap.view.headRefOid !== opts.head) {
      [headTree, prTree] = [await readTree(deps.gh, opts.repo, opts.head), await readTree(deps.gh, opts.repo, snap.view.headRefOid)];
      if (!headTree || !prTree) deps.log('gate: could not read the git tree of --head / the PR head: the CI of another head is not accepted (compared by sha)');
    }
    const answer = decideGate({
      workflows, pr: snap ? { headRefOid: snap.view.headRefOid } : null, head: opts.head, checks: snap?.checks ?? [], requiredChecks: opts.requireChecks, into: opts.into, stable, prFiles, headTree, prTree,
    });
    if (workflows === null) deps.log('gate: could not read the target\'s .github/workflows — fullSuite stays on the verifier');
    const out: GateResult = { verdict: 'gate', ...answer, ...base, ...(pr ? { pr: pr.number } : {}), ...(stack !== undefined ? { stack } : {}), ...(accept ? { acceptance: accept } : {}) };
    if (copyNeeded) return { exit: DELIVER_EXIT.pending, result: copyPendingAnswer(out, copyNeeded, opts) };
    if (!pendingRead) return { exit: DELIVER_EXIT.merged, result: out };
    // Wait for the freeze (bounded; the window is printed in the state), then run the acceptance clause exactly as for an already-frozen ticket.
    if (!opts.cwd) { // never wait for a freeze the gate could then not run: say so up front, answer pending (#515 review m4)
      return { exit: DELIVER_EXIT.pending, result: { ...out, verdict: 'pending', reason: 'acceptance-pending', detail: `the frozen tests of ${opts.ticket} are not there yet and this gate has no --cwd (they are run and hashed in the candidate checkout): not waiting — re-run with --cwd <checkout at --head> after the freeze status`, acceptance: { pending: true, spec: pendingRead.ticket?.spec ?? null, writer: pendingRead.ticket?.accept?.acceptor?.name ?? null, wait: null } } };
    }
    const waited = await waitForFreeze(opts, deps, pendingRead);
    if (waited.waived) return { exit: DELIVER_EXIT.merged, result: out };
    if (waited.frozen) {
      const acc = checkAcceptanceInCheckout(waited.frozen, { cwd: opts.cwd, head: opts.head, ticket: opts.ticket, log: deps.log }, deps.checkout ?? realCheckoutIo);
      if (!acc.ok && copyPending(acc, waited.frozen, opts, deps.checkout ?? realCheckoutIo)) return { exit: DELIVER_EXIT.pending, result: copyPendingAnswer(out, waited.frozen, opts) };
      if (!acc.ok) return { exit: DELIVER_EXIT.refused, result: { ...out, verdict: 'refused', reason: acc.reason, detail: acc.detail, acceptance: acc } };
      return { exit: DELIVER_EXIT.merged, result: { ...out, acceptance: acc } };
    }
    return { exit: DELIVER_EXIT.pending, result: { ...out, verdict: 'pending', reason: 'acceptance-pending', detail: `the frozen tests of ${opts.ticket} have not landed${waited.wait ? ` (waited ${waited.wait.boundSec}s, deadline ${waited.wait.deadline})` : ''}: no round consumed — the freeze posts a status to the implementer and verifier; re-run this gate then`, acceptance: { pending: true, spec: pendingRead.ticket?.spec ?? null, writer: pendingRead.ticket?.accept?.acceptor?.name ?? null, wait: waited.wait } } };
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
Acceptance (#510): when the ticket has frozen acceptance tests (\`fanout acceptance freeze\`), \`--cwd <the candidate checkout>\` is REQUIRED: its HEAD must be --head and its tracked files clean, every frozen file is hashed there, then the frozen command runs there. Output gains \`acceptance: {ok, hash, files:[{path,status}], config?:{path,status}, ran, receipt:{head,hash,ok}}\` (config = the \`jest --config <path>\` file of the frozen command, #542) — save \`receipt\` for \`deliver --acceptance\`. Any failure ⇒ exit 2, verdict "refused", reason frozen-test-changed | frozen-config-changed (the runner config differs from the bytes recorded at freeze — also when the TARGET moved the config since: only the coordinator's \`acceptance amend\` fixes that) | frozen-test-failed | acceptance-unproven | acceptance-stale-checkout (before any CI read). The ticket is read from the fanout state like \`stack\` (pass --run when it is not your own run: with --run an absent state/ticket or an unreadable state ⇒ exit 1 bad-state; without it an absent state/ticket prints acceptance:{consulted:false} — NOTHING checked — and logs it). \`deliver\` is the authority and refuses a ticket with frozen tests that has no receipt.
Follow-up (#514): a --ticket that is a follow-up candidate on an already-merged ticket (\`state set --follow-up-of <merged> --fixes <ids>\`, or a head other than the one the ticket merged at, or the branch/PR of a ticket that merged) is refused (exit 2, verdict "refused", reason followup-undeclared | followup-no-finding | followup-unknown-finding | followup-minor-only | followup-base-not-merged) unless it fixes >= 1 BLOCKING|MAJOR finding recorded on the merged ticket (\`state set --finding <id>=<severity>\`); MINOR findings get no action. A read-only re-gate of a merged tree omits --ticket.
Forced flow (#515): a ticket registered with --spec whose tests are NOT frozen yet is never refused: the rest of the gate is answered, then the gate WAITS up to --accept-wait <s> (default 480; the bound + deadline are printed in \`fanout state show\`). The same HEAD never passes (D1: the frozen bytes must be at the candidate's head): when the freeze lands, or the bound ends, or there is no --cwd (not waited for at all), verdict "pending", exit 3, no round consumed — the implementer copies the files UNCHANGED and the verifier re-gates the NEW head — the freeze posts a status to the implementer and verifier; re-run then (on the new head once the implementer copied the files).
A PR head other than --head ⇒ headMatches:false, ciGreenOnHead:false: the CI of another head is not accepted — unless (#512) it has the SAME git tree (a rebase / author rewrite): then headMatches:true, sameTree:true (a verdict is keyed on content; unreadable trees ⇒ compared by sha). The receipt also names \`tree\` (the checkout's HEAD^{tree}) and \`ticket\`.
Prints ONE JSON line. Exit 0 = answered, 2 = refused (acceptance), 3 = pending (the frozen tests have not landed), 1 = could not check (usage, gh failed, unreadable state). \`deliver\` re-checks CI at merge.`;

/** #515 — a candidate nominated BEFORE the freeze cannot carry the frozen bytes (D1 wants them at its head), so "every frozen file absent" is NOT a refusal when the head commit is not newer
 *  than the freeze (committer time strictly before the freeze's second): the answer is copy, push, re-gate. A file present-but-different, a red run, a stale checkout, or an absent file in a head committed AFTER the freeze
 *  (deleted / renamed since) stays a hard refusal — and `deliver` re-reads the bytes at the PR head whatever this says. */
function copyPending(acc: GateAcceptance, frozen: Acceptance, opts: GateOpts, io: CheckoutIo): boolean {
  if (acc.ok || acc.reason !== 'frozen-test-changed' || acc.files.length === 0 || !acc.files.every((f) => f.status === 'missing') || !opts.cwd) return false;
  const ct = Number(io.git(['show', '-s', '--format=%ct', 'HEAD'], path.resolve(opts.cwd)).stdout.trim());
  return Number.isFinite(ct) && ct < Math.floor(Date.parse(frozen.frozenAt) / 1000); // strictly older (seconds): a head cut in the freeze's own second is not "before" it
}
function copyPendingAnswer(out: GateResult, frozen: Acceptance, opts: GateOpts): GateResult {
  const br = frozen.source.branch ?? '<the shared acceptance branch>';
  return { ...out, verdict: 'pending', reason: 'acceptance-pending', detail: `the tests of ${opts.ticket} are frozen (${br}), but ${opts.head.slice(0, 12)} was nominated before and does not carry them: the implementer copies them UNCHANGED (git checkout origin/${br} -- <paths>), pushes, and the verifier re-gates the new head — no round consumed`, acceptance: { pending: true, spec: null, writer: null, wait: null, frozen: { branch: br, files: Object.keys(frozen.files), run: frozen.run } } };
}

/** #515 — poll the state until the ticket's tests are frozen or the window closes. Returns the frozen set (or null) and the window in force. */
async function waitForFreeze(opts: GateOpts, deps: GateDeps, read: NonNullable<ReturnType<NonNullable<GateDeps['acceptance']>>>): Promise<{ frozen: Acceptance | null; waived?: boolean; wait: { since: string; deadline: string; boundSec: number } | null }> {
  const now = deps.now ?? (() => Date.now());
  const boundSec = opts.acceptWaitSec ?? GATE_WAIT_DEFAULT_SEC;
  const run = read.run ?? opts.run ?? '';
  const nowMs = now();
  // bound 0 = do not wait: nothing to record (the state only holds a real window)
  const wait = boundSec > 0 && deps.openWait && run ? deps.openWait({ ticket: opts.ticket!, run, boundSec, nowMs }) : { since: new Date(nowMs).toISOString(), deadline: new Date(nowMs + boundSec * 1000).toISOString(), boundSec };
  const deadline = Date.parse(wait.deadline);
  deps.log(`gate: ${opts.ticket}'s frozen acceptance tests are not there yet — the rest of the gate is answered; waiting up to ${boundSec}s (deadline ${wait.deadline}) for the freeze`);
  for (;;) {
    const cur = deps.acceptance!({ ticket: opts.ticket!, run: run || opts.run });
    if (cur.known && cur.acceptance) return { frozen: cur.acceptance, wait };
    if (cur.known && cur.phase === 'waived') return { frozen: null, waived: true, wait: null }; // waived while we waited: nothing is forced any more
    if (now() >= deadline) return { frozen: null, wait: boundSec > 0 ? wait : null };
    await deps.sleep(Math.min(opts.pollMs ?? 2000, Math.max(1, deadline - now())));
  }
}

/** Production deps: real gh + the state-file stack reader (a test drives `runGate` through THIS, so an unwired reader cannot pass). */
export const realGateDeps = (): GateDeps => ({
  ...realDeps(), stack: (o) => stackFromState(o), acceptance: (o) => acceptanceFromState({ ...o, lenient: !o.run }), followUp: (o) => followUpFromState({ ...o, lenient: o.run === undefined }),
  openWait: (o) => {
    let w: { since: string; deadline: string; boundSec: number } | undefined;
    updateState(stateFile(process.env.ORCHESTRA_HOME && process.env.ORCHESTRA_HOME.trim() ? process.env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra'), o.run), (cur) => {
      if (!cur) throw new Error(`no fanout state for run ${o.run}`);
      const r = openWait(cur, o.ticket, o.boundSec, o.nowMs);
      w = r.wait;
      return r.state;
    });
    return w!;
  },
});

export async function runGate(args: string[], deps: GateDeps = realGateDeps()): Promise<{ exit: number; stdout?: string; error?: string }> {
  const p = parseGateArgs(args);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await gatePr(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
