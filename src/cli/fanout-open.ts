// `orchestra fanout open` (#479) — open (or reuse) the PR `<branch> → <target>` at NOMINATION so CI runs while the verifier gates.
// Same code path as `fanout deliver --open-only`. Never merges: the only gh verbs here are `pr list|create|view`. Store-less, `gh` behind
// deliver's injectable runner. `deliver` later reuses this PR and still merges only at the verified head with CI green on that head.

import { DELIVER_EXIT, SAFE_REF } from '../shared/fanout-deliver.ts';
import { realDeps, type DeliverDeps, type GhResult } from './fanout-deliver.ts';

export interface OpenOpts {
  branch: string;
  into: string;
  ticket: string;
  repo?: string;
}

export interface OpenResult {
  verdict: 'opened' | 'refused' | 'unchecked';
  reason?: 'wrong-base' | 'pr-closed' | 'gh-failed' | 'bad-args';
  detail?: string;
  ticket: string;
  branch: string;
  into: string;
  pr?: number;
  url?: string;
  /** The PR head right now (full sha). CI runs on it; `deliver` refuses `head-moved` if the verified head differs. */
  head?: string;
  /** true ⇒ an already-open PR was reused, nothing was created. */
  reused?: boolean;
}

export const OPEN_USAGE = 'usage: orchestra fanout open --branch <b> --into <target> --ticket <id> [--repo <owner/name>]\n       (same as: orchestra fanout deliver --open-only --branch <b> --into <target> --ticket <id>)';

export type ParsedOpen = { ok: true; opts: OpenOpts } | { ok: false; error: string };

/** Strict argv parse (a ref that could be read as a gh option / shell metacharacter is a usage error, exit 1). */
export function parseOpenArgs(args: string[]): ParsedOpen {
  const v: Record<string, string> = {};
  const known = new Set(['--branch', '--into', '--ticket', '--repo']);
  for (let i = 0; i < args.length; i += 2) {
    const k = args[i];
    if (!known.has(k)) return { ok: false, error: `unknown argument: ${k} (open takes only --branch --into --ticket --repo; merge flags belong to deliver)\n${OPEN_USAGE}` };
    const val = args[i + 1];
    if (val === undefined) return { ok: false, error: `${k} needs a value\n${OPEN_USAGE}` };
    v[k] = val;
  }
  for (const k of ['--branch', '--into', '--ticket']) if (!v[k]) return { ok: false, error: `${k} is required\n${OPEN_USAGE}` };
  if (!SAFE_REF.test(v['--branch'])) return { ok: false, error: `unsafe --branch: ${v['--branch']}` };
  if (!SAFE_REF.test(v['--into'])) return { ok: false, error: `unsafe --into: ${v['--into']}` };
  if (v['--repo'] !== undefined && !/^[\w.-]+\/[\w.-]+$/.test(v['--repo'])) return { ok: false, error: '--repo must be <owner>/<name>' };
  return { ok: true, opts: { branch: v['--branch'], into: v['--into'], ticket: v['--ticket'], repo: v['--repo'] } };
}

interface ListedPr {
  number: number;
  url: string;
  state: string;
  baseRefName?: string;
  headRefOid?: string;
}

export async function openPr(opts: OpenOpts, deps: Pick<DeliverDeps, 'gh' | 'log'>): Promise<{ exit: number; result: OpenResult }> {
  const base = { ticket: opts.ticket, branch: opts.branch, into: opts.into };
  const done = (r: Omit<OpenResult, 'ticket' | 'branch' | 'into'>): { exit: number; result: OpenResult } => ({
    exit: r.verdict === 'refused' ? DELIVER_EXIT.refused : r.verdict === 'unchecked' ? DELIVER_EXIT.unchecked : DELIVER_EXIT.merged,
    result: { ...r, ...base },
  });
  if (!SAFE_REF.test(opts.into) || !SAFE_REF.test(opts.branch)) return done({ verdict: 'unchecked', reason: 'bad-args', detail: 'unsafe --into/--branch' });
  const repoArgs = opts.repo ? ['--repo', opts.repo] : [];
  const ghOk = async (args: string[]): Promise<string> => {
    const r: GhResult = await deps.gh([...args, ...repoArgs]);
    if (r.code !== 0) throw new Error(`gh ${args.slice(0, 2).join(' ')} failed (exit ${r.code}): ${r.stderr.trim().slice(0, 400)}`);
    return r.stdout;
  };
  let mergedNote = '';
  try {
    // No `--base` filter: an open PR of this branch on ANOTHER base must be seen (wrong-base), not silently shadowed by a second PR.
    const listed = (JSON.parse(await ghOk(['pr', 'list', '--head', opts.branch, '--state', 'all', '--json', 'number,url,state,baseRefName,headRefOid', '--limit', '20'])) as ListedPr[])
      .sort((a, b) => b.number - a.number);
    const open = listed.filter((p) => p.state === 'OPEN');
    const mine = open.find((p) => p.baseRefName === opts.into);
    if (mine) {
      deps.log(`reusing PR #${mine.number} ${mine.url}`);
      return done({ verdict: 'opened', pr: mine.number, url: mine.url, head: mine.headRefOid, reused: true });
    }
    if (open.length > 0) {
      const o = open[0];
      return done({ verdict: 'refused', reason: 'wrong-base', detail: `PR #${o.number} is open on base ${o.baseRefName ?? '?'}, expected ${opts.into}`, pr: o.number, url: o.url, head: o.headRefOid });
    }
    // Only PRs on THIS base count (deliver lists with --base too: a PR closed on an old target must not block a retarget).
    // Newest closed unmerged and nothing open ⇒ closed on purpose: no silent second PR. A MERGED newest one is an earlier round: open a new PR.
    const onBase = listed.filter((p) => p.baseRefName === opts.into);
    if (onBase[0] && onBase[0].state === 'CLOSED') {
      return done({ verdict: 'refused', reason: 'pr-closed', detail: `PR #${onBase[0].number} is closed (not merged); reopen it or use a new branch`, pr: onBase[0].number, url: onBase[0].url, head: onBase[0].headRefOid });
    }
    const m = onBase.find((p) => p.state === 'MERGED');
    if (m) mergedNote = ` (PR #${m.number} on this branch is already MERGED: nothing left to open?)`;
    const out = await ghOk([
      'pr', 'create', '--head', opts.branch, '--base', opts.into,
      '--title', `${opts.ticket}: ${opts.branch}`,
      '--body', `Ticket ${opts.ticket}. Opened at nomination by \`orchestra fanout open\` so CI runs during the gate; merged by \`fanout deliver\` at the verified head.`,
    ]);
    const url = out.trim().split('\n').pop() ?? '';
    const num = Number(/\/pull\/(\d+)\s*$/.exec(url)?.[1]);
    if (!Number.isInteger(num)) throw new Error(`gh pr create printed no PR url: ${out.trim().slice(0, 200)}`);
    deps.log(`opened PR #${num} ${url}`);
    const view = JSON.parse(await ghOk(['pr', 'view', String(num), '--json', 'headRefOid'])) as { headRefOid?: string };
    return done({ verdict: 'opened', pr: num, url, head: view.headRefOid, reused: false });
  } catch (e) {
    return done({ verdict: 'unchecked', reason: 'gh-failed', detail: (e instanceof Error ? e.message : String(e)) + mergedNote });
  }
}

export const OPEN_HELP = `${OPEN_USAGE}

open: at NOMINATION, open or reuse the PR <branch> → <target> so CI runs while the verifier gates
(idempotent, NEVER merges, coordinator-only). Prints ONE JSON line {verdict:"opened", pr, url, head,
reused}; feed the number to \`fanout state set <ticket> --pr <n>\`. \`fanout deliver\` later reuses this
PR and merges only at the verified head with CI green on that head (a head pushed after the gate ⇒ head-moved).
Refuses (exit 2): wrong-base (an open PR of the branch on another base — \`deliver\` would open a second one: fix the base first), pr-closed (newest PR on <target> closed unmerged).
Exit codes: 0 = opened or reused, 2 = refused, 1 = could not check (usage, gh failed).`;

/**
 * Routes the `open` half of the `fanout` namespace (`args` = what follows `fanout`): `open …` and `deliver … --open-only`
 * are the SAME code path. Returns undefined when it is neither — the caller then runs deliver / #469's state verbs.
 */
export async function runOpenRoute(args: string[], deps: Pick<DeliverDeps, 'gh' | 'log'> = realDeps()): Promise<{ exit: number; stdout?: string; error?: string } | undefined> {
  const flagForm = args[0] === 'deliver' && args.includes('--open-only');
  if (args[0] !== 'open' && !flagForm) return undefined;
  const rest = args.slice(1).filter((a) => !(flagForm && a === '--open-only'));
  const p = parseOpenArgs(rest);
  if (!p.ok) return { exit: 1, error: p.error };
  const { exit, result } = await openPr(p.opts, deps);
  return { exit, stdout: `${JSON.stringify(result)}\n` };
}
