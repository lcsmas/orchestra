// #469 — `orchestra fanout state init|set|show` and `orchestra fanout resume`. Pure of process globals: argv + deps in, {code,stdout,stderr} out,
// so index.ts only forwards and the tests drive it with a fake git/gh runner. Resume = 5 steps: load, reconcile, classify, next action, write back.
import { spawnSync } from 'node:child_process';
import os from 'node:os';
import path from 'node:path';
import {
  FanoutStateError,
  SETTABLE_KEYS,
  applyTicketPatch,
  applyWriteBack,
  newState,
  readState,
  reconcile,
  resolveFanoutRun,
  stateFile,
  updateState,
  type FanoutState,
  type Reality,
  type TicketReality,
  type TicketState,
} from '../shared/fanout-state.ts';
import { acceptancePhase, claimIsStale } from '../shared/fanout-acceptance.ts';

/** `hostCalls` (#515): requests the verb leaves for the HOST (the app owns the spawn and the bus) — index.ts sends each to its socket route after the state is written. */
export interface HostCall { route: '/fanoutAcceptance'; body: Record<string, unknown> }
export interface RunResult { code: number; stdout: string; stderr: string; hostCalls?: HostCall[] }
/** The injectable git/gh seam: tests hand a fake; production spawns the real binary. `env` (optional, extra variables) is how a verb points git at a scratch index. */
export type Runner = (cmd: 'git' | 'gh', args: string[], cwd: string, env?: Record<string, string>) => { code: number; stdout: string; stderr: string };

export interface FanoutDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  runner: Runner;
  now: () => string;
  readStdin: () => string;
}

export function defaultRunner(cmd: 'git' | 'gh', args: string[], cwd: string, env?: Record<string, string>): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024, ...(env ? { env: { ...process.env, ...env } } : {}) });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const FANOUT_USAGE = `usage: orchestra fanout state init --run <id> [--target <branch>] [--repo <owner/name>]
       orchestra fanout state set <ticket> [--run <id>] [--status s] [--branch b] [--pr n] [--head sha] [--verdict v]
                                  [--depends-on a,b] [--built-on a=sha,b=sha] [--frozen-interface ref] [--accept-merged <reason>] [--json <object|->]
                                  [--finding id=BLOCKING|MAJOR|MINOR[,…]] [--follow-up-of <merged ticket> --fixes <finding id>[,…]] [--forget-merge <reason>]
                                  [--spec <file|url|ledger section>] [--implementer <ws id>] [--verifier <ws id>]
       orchestra fanout state show [--run <id>] [--json]
       orchestra fanout acceptance freeze|amend|waive|spawn|show <ticket> …   (frozen acceptance tests, #510/#515 — orchestra fanout acceptance --help)
       orchestra fanout resume [--run <id>] [--cwd <repo dir>] [--no-fetch] [--no-write] [--json]

The vague's execution state: <ORCHESTRA_HOME>/fanout/<run>/state.json (one writer, atomic rewrite, unknown field refused).
  status   todo|started|nominated|gated|merged|dropped        verdict  none|pass|fail|approve|changes-requested
  A dependent may START against a frozen interface. While an upstream is not merged it may be 'nominated'/'gated' only on that upstream's
  verified candidate (nominated|gated, head recorded, no failing verdict) with --built-on <upstream>=<head it was built on> = that head;
  'merged' is REFUSED until every upstream is merged (fanout deliver re-proves order and content at merge time).
  resume   load → reconcile against git + gh → classify → next action per ticket → write back reality-ahead facts.
           exit 0 = state matches reality, 2 = divergences reported (state claims reality does not back are never auto-corrected).
  Content key (#512): \`set --head\` / \`--built-on\` also record the git TREE of each sha (derived, read-only; unreadable ⇒ unknown ⇒ sha-keyed). \`resume\` keeps a verdict whose head
           moved to another sha with the SAME tree (it records the new head); another tree = head-moved (verdict void).
  --spec <ref>  (#515) registers the ticket's spec: Orchestra then SPAWNS that ticket's \`accept-\` test writer itself (Opus 5.5, brief = spec + ticket only);
           its \`fanout acceptance freeze\` publishes the tests to branch acceptance/<run> and tells --implementer / --verifier (workspace ids) the path + command.
           \`state show\` prints each ticket's path + run command (or "pending"). A gate on an unfrozen ticket WAITS (bounded), deliver answers acceptance-pending.
  --accept-merged <reason>  a merged ticket counts as merged although git/gh do not show it on the target (stacked base later
           squash-landed): the only override of a reality that contradicts the state.
  Findings (#514): --finding records a verifier/review finding (id=severity) on the ticket it was raised on; a recorded severity is never re-graded.
           A follow-up candidate on an already-merged ticket (--follow-up-of <it> --fixes <ids>, as its own ticket) is registered, gated and delivered
           only if it fixes >= 1 BLOCKING|MAJOR finding recorded on that ticket — MINOR-only, none, or an unknown id is refused; \`state set\` also refuses
           to nominate/gate a ticket that ever merged on another head (the merged head outlives an un-merge; --forget-merge <reason> clears it when the merge was never real).
           Findings are the coordinator's own record (no report reference): one finding may justify more than one follow-up, and a brand-new branch under a fresh ticket id cannot
           be told from a new ticket — the rule catches the same branch/PR as a merged ticket, any head change on it, and every un-merge/--forget-merge path (the reason is kept in forgottenMerges, denied to a scribe).
  --run defaults to YOUR OWN run (your workspace id; init always); show/resume use your parent's run only when you have no state and it does; set needs your own state or --run (#486).`;

const SHA_ARG = /^[0-9a-f]{7,40}$/;
const TREE_OUT = /^(?:[0-9a-f]{40}|[0-9a-f]{64})$/;
/** #512 — the git tree of `sha`: the local object first, else GitHub's commit. null = UNREADABLE — the verdict then stays sha-keyed (never looser, never "no tree"). */
export function treeOfSha(runner: Runner, sha: string, cwd: string, repo: string | null): string | null {
  if (!SHA_ARG.test(sha)) return null;
  const g = runner('git', ['rev-parse', '--verify', '-q', `${sha}^{tree}`], cwd);
  if (g.code === 0 && TREE_OUT.test(g.stdout.trim())) return g.stdout.trim();
  const a = runner('gh', ['api', `repos/${repo ?? '{owner}/{repo}'}/commits/${sha}`], cwd);
  if (a.code !== 0) return null;
  try {
    const t = ((JSON.parse(a.stdout) as { commit?: { tree?: { sha?: unknown } } }).commit?.tree?.sha);
    return typeof t === 'string' && TREE_OUT.test(t) ? t : null;
  } catch { return null; }
}

export interface Parsed { pos: string[]; vals: Record<string, string>; bools: Set<string> }

/** Strict flag parser: an unknown flag is refused (never swallowed as a value or positional). */
export function parseArgs(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
  const out: Parsed = { pos: [], vals: {}, bools: new Set() };
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith('--')) {
      if (boolFlags.includes(a)) { out.bools.add(a); continue; }
      if (!valueFlags.includes(a)) throw new FanoutStateError(`unknown flag ${a}`);
      const v = args[i + 1];
      if (v === undefined) throw new FanoutStateError(`${a} needs a value`);
      out.vals[a] = v;
      i++;
    } else out.pos.push(a);
  }
  return out;
}

/** `--built-on UP=<sha>[,UP2=<sha>]` → {UP: sha}. `-` (or empty) clears it. */
function builtOnArg(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',').map((x) => x.trim()).filter((x) => x && x !== '-')) {
    const i = part.indexOf('=');
    if (i < 1) throw new FanoutStateError(`--built-on expects <upstream>=<sha>[,…] (got ${JSON.stringify(part)})`);
    out[part.slice(0, i)] = part.slice(i + 1);
  }
  return out;
}

/** `--finding ID=SEV[,ID2=SEV]` → {ID: SEV}. */
function findingsArg(v: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const part of v.split(',').map((x) => x.trim()).filter(Boolean)) {
    const i = part.indexOf('=');
    if (i < 1) throw new FanoutStateError(`--finding expects <id>=BLOCKING|MAJOR|MINOR[,…] (got ${JSON.stringify(part)})`);
    out[part.slice(0, i)] = part.slice(i + 1).toUpperCase();
  }
  return out;
}
/** #515 — does this ticket owe a writer spawn? spec registered, nothing frozen, not waived, and no live writer (a failed spawn and a claim older than CLAIM_STALE_SEC — the app died mid-spawn — are retried). */
export function needsAcceptor(t: TicketState | undefined, nowIso?: string): boolean {
  if (!t || acceptancePhase(t) !== 'pending') return false;
  const a = t.accept?.acceptor;
  return !a || !!a.error || claimIsStale(a, nowIso ?? new Date().toISOString());
}
export function spawnCall(run: string, ticket: string, deps: Pick<FanoutDeps, 'env'>, replace = false): HostCall {
  const from = (deps.env.ORCHESTRA_WS_ID || deps.env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
  return { route: '/fanoutAcceptance', body: { op: 'spawn', run, ticket, ...(from ? { from } : {}), ...(replace ? { replace: true } : {}) } };
}

export function homeOf(env: NodeJS.ProcessEnv): string {
  return env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
}
export function runOf(p: Parsed, deps: FanoutDeps, mode: 'init' | 'use' | 'write'): { run: string; note: string } {
  const { run, inherited } = resolveFanoutRun(p.vals['--run'], deps.env);
  if (!run) throw new FanoutStateError('no run: pass --run <id> (not inside an Orchestra workspace, so no own run to default to)');
  // #486 — `init` is ALWAYS the caller's own run. A scribe/verifier/worker (no run of its own) reads/updates the coordinator's state: set/show/resume
  // fall back to the parent's run ONLY when no state exists at the own run and one does at the parent's — said on stderr, never for init.
  // `set` (mode 'write') is refused there: an OPS that skipped `init` would write into its parent's state (#486 review MINOR 1) — a scribe passes --run.
  if (mode !== 'init' && inherited) {
    const has = (r: string): boolean => { try { return readState(stateFile(homeOf(deps.env), r)) !== null; } catch { return false; } };
    if (!has(run) && has(inherited)) {
      if (mode === 'write') throw new FanoutStateError(`no fanout state for your own run ${run} — run \`orchestra fanout state init\` first; to update your parent's run ${inherited} (a scribe), pass --run ${inherited}`);
      return { run: inherited, note: `note: no fanout state for your own run ${run}; using your parent's run ${inherited} (pass --run to choose)\n` };
    }
  }
  return { run, note: '' };
}
export function loadOrFail(file: string): FanoutState {
  const s = readState(file);
  if (!s) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
  return s;
}

export function runFanout(args: string[], deps: FanoutDeps): RunResult {
  const [sub, ...rest] = args;
  try {
    if (!sub || sub === '--help' || sub === '-h') return { code: sub ? 0 : 1, stdout: sub ? `${FANOUT_USAGE}\n` : '', stderr: sub ? '' : `${FANOUT_USAGE}\n` };
    if (sub === 'state') return runState(rest, deps);
    if (sub === 'resume') return runResume(rest, deps);
    return { code: 1, stdout: '', stderr: `unknown fanout verb "${sub}"\n${FANOUT_USAGE}\n` };
  } catch (e) {
    if (e instanceof FanoutStateError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function runState(args: string[], deps: FanoutDeps): RunResult {
  const [verb, ...rest] = args;
  if (verb === 'init') {
    const p = parseArgs(rest, ['--run', '--target', '--repo'], []);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
    const { run } = runOf(p, deps, 'init');
    const file = stateFile(homeOf(deps.env), run);
    updateState(file, (cur) => {
      if (cur) throw new FanoutStateError(`state already exists at ${file} (run ${cur.run}, ${Object.keys(cur.tickets).length} ticket(s), updated ${cur.updatedAt}) — an earlier vague's, or another coordinator's. Continue it: \`orchestra fanout resume --run ${run}\`; start a fresh one: \`orchestra fanout state init --run <new id>\` (default is your own run ${resolveFanoutRun(undefined, deps.env).run ?? '<id>'}).`);
      return newState(run, { target: p.vals['--target'], repo: p.vals['--repo'] ?? null, now: deps.now() });
    });
    return { code: 0, stdout: `initialised ${file}\n`, stderr: '' };
  }
  if (verb === 'set') {
    const p = parseArgs(rest, ['--run', '--status', '--branch', '--pr', '--head', '--verdict', '--depends-on', '--built-on', '--frozen-interface', '--accept-merged', '--finding', '--follow-up-of', '--fixes', '--forget-merge', '--spec', '--implementer', '--verifier', '--json'], []);
    const [ticket, ...extra] = p.pos;
    if (!ticket || extra.length) throw new FanoutStateError('usage: orchestra fanout state set <ticket> [--status s] [--branch b] …');
    const patch: Record<string, unknown> = {};
    if (p.vals['--json'] !== undefined) {
      const text = p.vals['--json'] === '-' ? deps.readStdin() : p.vals['--json'];
      let obj: unknown;
      try { obj = JSON.parse(text); } catch { throw new FanoutStateError('--json is not valid JSON'); }
      if (typeof obj !== 'object' || obj === null || Array.isArray(obj)) throw new FanoutStateError('--json must be an object');
      Object.assign(patch, obj);
    }
    const flagToKey: Record<string, string> = { '--status': 'status', '--branch': 'branch', '--pr': 'pr', '--head': 'head', '--verdict': 'verdict', '--depends-on': 'dependsOn', '--built-on': 'builtOn', '--frozen-interface': 'frozenInterface', '--accept-merged': 'mergedAccepted', '--finding': 'findings', '--follow-up-of': 'followUpOf', '--fixes': 'fixes', '--forget-merge': 'forgetMerge', '--spec': 'spec', '--implementer': 'implementer', '--verifier': 'verifier' };
    for (const [flag, key] of Object.entries(flagToKey)) {
      const v = p.vals[flag];
      if (v === undefined) continue;
      patch[key] = key === 'pr' ? (/^[0-9]+$/.test(v) ? Number(v) : NaN) : key === 'dependsOn' || key === 'fixes' ? v.split(',').map((x) => x.trim()).filter(Boolean) : key === 'findings' ? findingsArg(v) : key === 'builtOn' ? builtOnArg(v) : v;
    }
    if (Object.keys(patch).length === 0) throw new FanoutStateError(`nothing to set (settable: ${SETTABLE_KEYS.join(', ')})`);
    const r = runOf(p, deps, 'write');
    const file = stateFile(homeOf(deps.env), r.run);
    // #512 — the content keys are DERIVED here (git, then gh), never typed: the tree of the head and of each upstream head it was built on. Unreadable ⇒ unknown ⇒ sha-keyed.
    const derived: { tree?: string | null; builtOnTree?: Record<string, string> } = {};
    const notes: string[] = [];
    const repo = readState(file)?.repo ?? null;
    if (typeof patch.head === 'string') {
      derived.tree = treeOfSha(deps.runner, patch.head, deps.cwd, repo);
      if (!derived.tree) notes.push(`note: the tree of head ${patch.head.slice(0, 8)} is unreadable (not fetched? gh?): its verdict stays keyed on the sha, not the content\n`);
    }
    if (patch.builtOn && typeof patch.builtOn === 'object') {
      derived.builtOnTree = {};
      for (const [up, sha] of Object.entries(patch.builtOn as Record<string, unknown>)) {
        const tr = typeof sha === 'string' ? treeOfSha(deps.runner, sha, deps.cwd, repo) : null;
        if (tr) derived.builtOnTree[up] = tr; else notes.push(`note: the tree of ${up}@${String(sha).slice(0, 8)} is unreadable: ${up} stays keyed on the sha\n`);
      }
    }
    let prev: TicketState | undefined;
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init\` first`);
      prev = cur.tickets[ticket];
      return applyTicketPatch(cur, ticket, patch, deps.now(), derived);
    });
    const t = next.tickets[ticket];
    // #515: a ticket that carries a spec and has no live writer, no frozen tests and no waiver gets its `accept-` writer from the HOST (the call is made after the state is on disk).
    const hostCalls: HostCall[] = needsAcceptor(t, deps.now()) ? [spawnCall(r.run, ticket, deps)] : [];
    // a recipient recorded AFTER the freeze (the implementer does not exist at dispatch) still gets the frozen status (path + command), once (#515 review m7)
    const late = (['implementer', 'verifier'] as const).map((k) => t[k]).filter((id, i): id is string => !!id && id !== (prev?.[(['implementer', 'verifier'] as const)[i]] ?? null));
    if (t.acceptance && t.spec && late.length) hostCalls.push({ route: '/fanoutAcceptance', body: { op: 'frozen', run: r.run, ticket, to: [...new Set(late)], ...(deps.env.ORCHESTRA_WS_ID ? { from: deps.env.ORCHESTRA_WS_ID } : {}) } });
    // an unspecified ticket will be refused by `deliver` (acceptance-pending): say so now, not at merge time (#515 review M3)
    const notice = acceptancePhase(t) === 'unspecified' && t.status !== 'merged' && t.status !== 'dropped' ? `note: ${ticket} has no --spec, nothing frozen and no waiver: \`fanout deliver\` will refuse it (acceptance-pending) — register --spec <ref> (Orchestra spawns its test writer), \`fanout acceptance waive ${ticket} --decision <ledger comment> --reason …\`, or deliver with --no-acceptance-gate\n` : '';
    return { code: 0, stdout: `${ticket}: ${t.status} verdict=${t.verdict} branch=${t.branch ?? '-'} pr=${t.pr ?? '-'} head=${t.head?.slice(0, 8) ?? '-'}${t.tree ? ` tree=${t.tree.slice(0, 8)}` : ''}${t.followUpOf ? ` follow-up-of=${t.followUpOf} fixes=${t.fixes.join(',')}` : ''}${Object.keys(t.findings).length ? ` findings=${Object.entries(t.findings).map(([k, v]) => `${k}:${v}`).join(',')}` : ''}\n`, stderr: `${r.note}${notes.join('')}${notice}`, ...(hostCalls.length ? { hostCalls } : {}) };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
    const r = runOf(p, deps, 'use');
    const file = stateFile(homeOf(deps.env), r.run);
    const s = loadOrFail(file);
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(s, null, 2)}\n`, stderr: r.note };
    const rows = Object.entries(s.tickets).map(([id, t]) => [id, t.status, t.verdict, t.branch ?? '-', t.pr ? `#${t.pr}` : '-', t.head?.slice(0, 8) ?? '-', t.dependsOn.map((d) => (t.builtOn[d] ? `${d}@${t.builtOn[d].slice(0, 8)}` : d)).join(',') || '-', t.frozenInterface ?? '-']);
    const head = ['ticket', 'status', 'verdict', 'branch', 'pr', 'head', 'dependsOn', 'frozen'];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    const acc = Object.entries(s.tickets).map(([id, t]) => acceptanceLine(id, t)).filter((l): l is string => l !== null);
    return { code: 0, stdout: `run ${s.run} → ${s.repo ? `${s.repo} ` : ''}origin/${s.target}  (updated ${s.updatedAt}${s.reconciledAt ? `, reconciled ${s.reconciledAt}` : ''})\n${[fmt(head), ...rows.map(fmt)].join('\n')}\n${acc.length ? `acceptance (#515):\n${acc.map((l) => `  ${l}`).join('\n')}\n` : ''}`, stderr: r.note };
  }
  throw new FanoutStateError(`usage: orchestra fanout state init|set|show\n${FANOUT_USAGE}`);
}

/** One line per ticket with an acceptance story: where the frozen tests are + the run command, or what it waits for / why it is waived. null = nothing forced. */
export function acceptanceLine(id: string, t: TicketState): string | null {
  const ph = acceptancePhase(t);
  if (ph === 'none') return null;
  if (ph === 'unspecified') return t.status === 'merged' || t.status === 'dropped' ? null : `${id}  unspecified  no --spec, nothing frozen, not waived: \`fanout deliver\` refuses (acceptance-pending) — set --spec, \`fanout acceptance waive\`, or deliver with --no-acceptance-gate`;
  if (ph === 'frozen') {
    const a = t.acceptance!;
    return `${id}  frozen  ${a.source.branch ?? '-'}@${a.source.head.slice(0, 12)}  files: ${Object.keys(a.files).join(', ')}  run: ${a.run}`;
  }
  if (ph === 'waived') return `${id}  waived  ${t.accept!.waived!.decision} — ${t.accept!.waived!.reason}`;
  const w = t.accept?.acceptor;
  const wait = t.accept?.wait;
  return `${id}  pending  writer: ${w ? `${w.name}${w.id ? ` (${w.id})` : ''}${w.error ? ` — spawn failed: ${w.error}` : w.id ? '' : ' (spawning)'}` : 'none yet (`fanout acceptance spawn`)'}${wait ? `  gate waits until ${wait.deadline} (bound ${wait.boundSec}s)` : ''}`;
}

/** Read git + gh for every ticket that names a branch or a PR. A failed read is recorded as `error` (UNKNOWN), never as absence. */
export function gatherReality(state: FanoutState, runner: Runner, cwd: string, opts: { fetch: boolean }): Reality {
  const reality: Reality = {};
  let fetchError: string | undefined;
  if (opts.fetch) {
    const f = runner('git', ['fetch', '--quiet', 'origin'], cwd);
    if (f.code !== 0) fetchError = `git fetch origin: exit ${f.code}`;
  }
  const ancestor = (sha: string): boolean | string => {
    const r = runner('git', ['merge-base', '--is-ancestor', sha, `origin/${state.target}`], cwd);
    if (r.code === 0) return true;
    if (r.code === 1) return !fetchError ? false : `${fetchError} (ancestry of ${sha.slice(0, 8)} unverified)`;
    return `git merge-base --is-ancestor ${sha.slice(0, 8)} origin/${state.target}: exit ${r.code}`;
  };
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.status === 'todo' || t.status === 'dropped') continue;
    const r: TicketReality = {};
    const errs: string[] = [];
    if (!t.branch && !t.pr) {
      if (t.status === 'merged') errs.push('merged with no branch or PR recorded: nothing to verify');
      if (errs.length) { r.error = errs.join('; '); reality[id] = r; }
      continue;
    }
    if (t.branch) {
      const l = runner('git', ['ls-remote', '--heads', 'origin', `refs/heads/${t.branch}`], cwd);
      if (l.code !== 0) errs.push(`git ls-remote ${t.branch}: exit ${l.code}`);
      else {
        r.branchHead = l.stdout.trim() ? l.stdout.trim().split(/\s+/)[0] : null;
        if (r.branchHead) r.branchTree = r.branchHead === t.head ? t.tree : treeOfSha(runner, r.branchHead, cwd, state.repo); // #512: only a moved tip needs its content read
      }
    }
    const probe = r.branchHead ?? t.head;
    if (t.status === 'merged' && !probe && !t.pr && errs.length === 0) errs.push('merged with no head or PR recorded and the branch gone: nothing to verify');
    if (probe && errs.length === 0) {
      const a = ancestor(probe);
      if (typeof a === 'string') errs.push(a);
      else r.mergedIntoTarget = a;
    }
    if (t.pr) {
      const g = runner('gh', ['pr', 'view', String(t.pr), ...(state.repo ? ['-R', state.repo] : []), '--json', 'state,headRefOid,baseRefName'], cwd);
      if (g.code !== 0) errs.push(`gh pr view ${t.pr}: exit ${g.code}`);
      else {
        try {
          const j = JSON.parse(g.stdout) as { state?: string; headRefOid?: string; baseRefName?: string };
          if (j.state !== 'OPEN' && j.state !== 'MERGED' && j.state !== 'CLOSED') errs.push(`gh pr view ${t.pr}: unexpected state ${JSON.stringify(j.state)}`);
          else if (typeof j.baseRefName !== 'string' || !j.baseRefName) errs.push(`gh pr view ${t.pr}: no baseRefName (cannot tell which branch it merged into)`);
          else {
            r.pr = { state: j.state, headRefOid: j.headRefOid ?? null, baseRefName: j.baseRefName };
            if (j.headRefOid) r.prTree = j.headRefOid === t.head ? t.tree : treeOfSha(runner, j.headRefOid, cwd, state.repo);
          }
        } catch { errs.push(`gh pr view ${t.pr}: unparseable output`); }
      }
    }
    if (errs.length) r.error = errs.join('; ');
    reality[id] = r;
  }
  return reality;
}

function runResume(args: string[], deps: FanoutDeps): RunResult {
  const p = parseArgs(args, ['--run', '--cwd'], ['--no-fetch', '--no-write', '--json']);
  if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
  const r = runOf(p, deps, 'use');
  const file = stateFile(homeOf(deps.env), r.run);
  const out: string[] = [];
  // 1/5 load
  const state = loadOrFail(file);
  out.push(`resume ${state.run} → ${state.repo ? `${state.repo} ` : ''}origin/${state.target}`, `1/5 load        ${file}: ${Object.keys(state.tickets).length} ticket(s)`);
  // 2/5 reconcile
  const cwd = p.vals['--cwd'] ? path.resolve(deps.cwd, p.vals['--cwd']) : deps.cwd;
  const reality = gatherReality(state, deps.runner, cwd, { fetch: !p.bools.has('--no-fetch') });
  const plan = reconcile(state, reality);
  out.push(`2/5 reconcile   ${plan.divergences.length} divergence(s)`);
  for (const d of plan.divergences) out.push(`    ! ${d.ticket} ${d.kind}: ${d.detail}`);
  // 3/5 classify
  const counts: Record<string, number> = {};
  for (const t of Object.values(plan.tickets)) counts[t.class] = (counts[t.class] ?? 0) + 1;
  out.push(`3/5 classify    ${Object.entries(counts).map(([k, n]) => `${k}=${n}`).join(' ') || '(no tickets)'}`);
  // 4/5 next action
  out.push('4/5 next action');
  for (const [id, t] of Object.entries(plan.tickets)) out.push(`    ${id.padEnd(10)} ${t.class.padEnd(14)} ${t.next.action.padEnd(32)} ${t.next.detail}`);
  // 5/5 write back
  let wrote = 'skipped (--no-write)';
  if (!p.bools.has('--no-write')) {
    const now = deps.now();
    updateState(file, (cur) => applyWriteBack(cur ?? state, plan.writeBack, now));
    wrote = plan.writeBack.length ? plan.writeBack.map((w) => `${w.ticket}: ${w.why}`).join('; ') : 'nothing to correct; reconciledAt stamped';
  }
  out.push(`5/5 write back  ${wrote}`);
  const code = plan.divergences.length ? 2 : 0;
  if (p.bools.has('--json')) return { code, stdout: `${JSON.stringify({ run: state.run, divergences: plan.divergences, tickets: plan.tickets, writeBack: plan.writeBack }, null, 2)}\n`, stderr: r.note };
  return { code, stdout: `${out.join('\n')}\n`, stderr: r.note };
}
