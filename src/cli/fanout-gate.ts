// `orchestra fanout gate` (#495) — what the VERIFIER may skip: does the target repo have PR CI, and is it green on the head being verified?
// READ-ONLY (gh `api`/`pr list|view`/`run view`, never a write), store-less, open to every role. The decision is pure (decideGate in
// src/shared/fanout-deliver.ts, sharing deliver's `ciVerdict`); this file is the gh I/O. `deliver` stays the merge authority and re-checks at merge.

import { DELIVER_EXIT, SAFE_REF, decideGate, type GateAnswer } from '../shared/fanout-deliver.ts';
import { readPrChecks, realDeps, type DeliverDeps } from './fanout-deliver.ts';

export interface GateOpts {
  branch: string;
  into: string;
  /** The head the verifier verifies (full 40-hex). */
  head: string;
  repo?: string;
  requireChecks: string[];
  /** ms between the two check reads (default 5000). */
  settleMs?: number;
}

export interface GateResult extends Partial<GateAnswer> {
  verdict: 'gate' | 'unchecked';
  reason?: 'gh-failed' | 'bad-args';
  detail?: string;
  branch: string;
  into: string;
  /** The head asked about (echoed): a CI answer is only ever about THIS head. */
  head: string;
  pr?: number;
}

export const GATE_USAGE = 'usage: orchestra fanout gate --branch <b> --into <target> --head <sha> [--repo <owner/name>] [--require-check <name>]…';

export type ParsedGate = { ok: true; opts: GateOpts } | { ok: false; error: string };

export function parseGateArgs(args: string[]): ParsedGate {
  const v: Record<string, string> = {};
  const required: string[] = [];
  const known = new Set(['--branch', '--into', '--head', '--repo', '--require-check']);
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
  return { ok: true, opts: { branch: v['--branch'], into: v['--into'], head: v['--head'], repo: v['--repo'], requireChecks: required } };
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

export async function gatePr(opts: GateOpts, deps: Pick<DeliverDeps, 'gh' | 'log' | 'sleep'>): Promise<{ exit: number; result: GateResult }> {
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
    const workflows = await targetWorkflows(opts, deps);
    const open = JSON.parse(await ghOk(['pr', 'list', '--head', opts.branch, '--base', opts.into, '--state', 'open', '--json', 'number,headRefOid', '--limit', '5'])) as { number: number; headRefOid: string }[];
    const pr = open[0] ?? null;
    const cache = new Map<string, number>();
    let snap = pr ? await readPrChecks(ghOk, String(pr.number), cache) : null;
    let stable = true;
    if (snap) {
      // Two reads apart: a fast job registered before the slow suite's workflow must not read as the whole CI (deliver has the same two-poll rule).
      const first = JSON.stringify(snap.checks.map((c) => c.name).sort());
      await deps.sleep(opts.settleMs ?? 5000);
      snap = await readPrChecks(ghOk, String(pr!.number), cache);
      stable = JSON.stringify(snap.checks.map((c) => c.name).sort()) === first;
    }
    const answer = decideGate({
      workflows, pr: snap ? { headRefOid: snap.view.headRefOid } : null, head: opts.head, checks: snap?.checks ?? [], requiredChecks: opts.requireChecks, into: opts.into, stable,
    });
    if (workflows === null) deps.log('gate: could not read the target\'s .github/workflows — repo CI is judged from the checks on the PR head only');
    return { exit: DELIVER_EXIT.merged, result: { verdict: 'gate', ...answer, ...base, ...(pr ? { pr: pr.number } : {}) } };
  } catch (e) {
    return bad('gh-failed', e instanceof Error ? e.message : String(e));
  }
}

export const GATE_HELP = `${GATE_USAGE}

gate: the verifier's checklist, DERIVED (read-only, any role). Says whether the target has PR CI
(a pull_request workflow on <target> that provably runs for a PR into it: no paths filter, branches admit <target>, no ! pattern, types include synchronize; pull_request_target is not) and whether it is green on exactly
--head (the sha you checked out). With PR CI: fullSuite:"ci" — do NOT re-run the full suite, wait for
ciGreenOnHead:true (two reads 5s apart, check names stable), keep the checklist's keep list. A green check is the SUITE only if it is a test job of the PR workflow (derived: suiteChecks) or pinned with --require-check <name>; none ⇒ fullSuite:"verifier". Without it (or unreadable): fullSuite:"verifier".
A PR head other than --head ⇒ headMatches:false, ciGreenOnHead:false: the CI of another head is not accepted.
Prints ONE JSON line. Exit 0 = answered, 1 = could not check (usage, gh failed). \`deliver\` re-checks CI at merge.`;

export async function runGate(args: string[], deps: Pick<DeliverDeps, 'gh' | 'log' | 'sleep'> = realDeps()): Promise<{ exit: number; stdout?: string; error?: string }> {
  const p = parseGateArgs(args);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await gatePr(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
