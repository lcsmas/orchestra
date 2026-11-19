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
  stateFile,
  updateState,
  type FanoutState,
  type Reality,
  type TicketReality,
} from '../shared/fanout-state.ts';

export interface RunResult { code: number; stdout: string; stderr: string }
/** The injectable git/gh seam: tests hand a fake; production spawns the real binary. */
export type Runner = (cmd: 'git' | 'gh', args: string[], cwd: string) => { code: number; stdout: string; stderr: string };

export interface FanoutDeps {
  env: NodeJS.ProcessEnv;
  cwd: string;
  runner: Runner;
  now: () => string;
  readStdin: () => string;
}

export function defaultRunner(cmd: 'git' | 'gh', args: string[], cwd: string): { code: number; stdout: string; stderr: string } {
  const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', timeout: 60_000, maxBuffer: 16 * 1024 * 1024 });
  if (r.error) return { code: 127, stdout: '', stderr: String(r.error.message) };
  return { code: r.status ?? 1, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}

export const FANOUT_USAGE = `usage: orchestra fanout state init --run <id> [--target <branch>] [--repo <owner/name>]
       orchestra fanout state set <ticket> [--run <id>] [--status s] [--branch b] [--pr n] [--head sha] [--verdict v]
                                  [--depends-on a,b] [--frozen-interface ref] [--json <object|->]
       orchestra fanout state show [--run <id>] [--json]
       orchestra fanout resume [--run <id>] [--cwd <repo dir>] [--no-fetch] [--no-write] [--json]

The vague's execution state: <ORCHESTRA_HOME>/fanout/<run>/state.json (one writer, atomic rewrite, unknown field refused).
  status   todo|started|nominated|gated|merged|dropped        verdict  none|pass|fail|approve|changes-requested
  A dependent may START against a frozen interface; 'nominated'/'gated'/'merged' is REFUSED while an upstream is not merged.
  resume   load → reconcile against git + gh → classify → next action per ticket → write back reality-ahead facts.
           exit 0 = state matches reality, 2 = divergences reported (state claims reality does not back are never auto-corrected).
  --run defaults to $ORCHESTRA_RUN_ID.`;

interface Parsed { pos: string[]; vals: Record<string, string>; bools: Set<string> }

/** Strict flag parser: an unknown flag is refused (never swallowed as a value or positional). */
function parseArgs(args: string[], valueFlags: string[], boolFlags: string[]): Parsed {
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

function homeOf(env: NodeJS.ProcessEnv): string {
  return env.ORCHESTRA_HOME && env.ORCHESTRA_HOME.trim() ? env.ORCHESTRA_HOME : path.join(os.homedir(), '.orchestra');
}
function runOf(p: Parsed, env: NodeJS.ProcessEnv): string {
  const run = p.vals['--run'] ?? env.ORCHESTRA_RUN_ID;
  if (!run) throw new FanoutStateError('no run: pass --run <id> (or set $ORCHESTRA_RUN_ID)');
  return run;
}
function loadOrFail(file: string): FanoutState {
  const s = readState(file);
  if (!s) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init --run <id>\` first`);
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
    const run = runOf(p, deps.env);
    const file = stateFile(homeOf(deps.env), run);
    updateState(file, (cur) => {
      if (cur) throw new FanoutStateError(`state already exists at ${file}`);
      return newState(run, { target: p.vals['--target'], repo: p.vals['--repo'] ?? null, now: deps.now() });
    });
    return { code: 0, stdout: `initialised ${file}\n`, stderr: '' };
  }
  if (verb === 'set') {
    const p = parseArgs(rest, ['--run', '--status', '--branch', '--pr', '--head', '--verdict', '--depends-on', '--frozen-interface', '--json'], []);
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
    const flagToKey: Record<string, string> = { '--status': 'status', '--branch': 'branch', '--pr': 'pr', '--head': 'head', '--verdict': 'verdict', '--depends-on': 'dependsOn', '--frozen-interface': 'frozenInterface' };
    for (const [flag, key] of Object.entries(flagToKey)) {
      const v = p.vals[flag];
      if (v === undefined) continue;
      patch[key] = key === 'pr' ? Number(v) : key === 'dependsOn' ? v.split(',').map((x) => x.trim()).filter(Boolean) : v;
    }
    if (Object.keys(patch).length === 0) throw new FanoutStateError(`nothing to set (settable: ${SETTABLE_KEYS.join(', ')})`);
    const file = stateFile(homeOf(deps.env), runOf(p, deps.env));
    const next = updateState(file, (cur) => {
      if (!cur) throw new FanoutStateError(`no state at ${file} — run \`orchestra fanout state init --run <id>\` first`);
      return applyTicketPatch(cur, ticket, patch, deps.now());
    });
    const t = next.tickets[ticket];
    return { code: 0, stdout: `${ticket}: ${t.status} verdict=${t.verdict} branch=${t.branch ?? '-'} pr=${t.pr ?? '-'} head=${t.head?.slice(0, 8) ?? '-'}\n`, stderr: '' };
  }
  if (verb === 'show') {
    const p = parseArgs(rest, ['--run'], ['--json']);
    if (p.pos.length) throw new FanoutStateError(`unexpected argument ${p.pos[0]}`);
    const file = stateFile(homeOf(deps.env), runOf(p, deps.env));
    const s = loadOrFail(file);
    if (p.bools.has('--json')) return { code: 0, stdout: `${JSON.stringify(s, null, 2)}\n`, stderr: '' };
    const rows = Object.entries(s.tickets).map(([id, t]) => [id, t.status, t.verdict, t.branch ?? '-', t.pr ? `#${t.pr}` : '-', t.head?.slice(0, 8) ?? '-', t.dependsOn.join(',') || '-', t.frozenInterface ?? '-']);
    const head = ['ticket', 'status', 'verdict', 'branch', 'pr', 'head', 'dependsOn', 'frozen'];
    const widths = head.map((h, i) => Math.max(h.length, ...rows.map((r) => r[i].length)));
    const fmt = (r: string[]): string => r.map((c, i) => c.padEnd(widths[i])).join('  ').trimEnd();
    return { code: 0, stdout: `run ${s.run} → ${s.repo ? `${s.repo} ` : ''}origin/${s.target}  (updated ${s.updatedAt}${s.reconciledAt ? `, reconciled ${s.reconciledAt}` : ''})\n${[fmt(head), ...rows.map(fmt)].join('\n')}\n`, stderr: '' };
  }
  throw new FanoutStateError(`usage: orchestra fanout state init|set|show\n${FANOUT_USAGE}`);
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
      else r.branchHead = l.stdout.trim() ? l.stdout.trim().split(/\s+/)[0] : null;
    }
    const probe = r.branchHead ?? t.head;
    if (probe && errs.length === 0) {
      const a = ancestor(probe);
      if (typeof a === 'string') errs.push(a);
      else r.mergedIntoTarget = a;
    }
    if (t.pr) {
      const g = runner('gh', ['pr', 'view', String(t.pr), ...(state.repo ? ['-R', state.repo] : []), '--json', 'state,headRefOid'], cwd);
      if (g.code !== 0) errs.push(`gh pr view ${t.pr}: exit ${g.code}`);
      else {
        try {
          const j = JSON.parse(g.stdout) as { state?: string; headRefOid?: string };
          if (j.state !== 'OPEN' && j.state !== 'MERGED' && j.state !== 'CLOSED') errs.push(`gh pr view ${t.pr}: unexpected state ${JSON.stringify(j.state)}`);
          else r.pr = { state: j.state, headRefOid: j.headRefOid ?? null };
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
  const file = stateFile(homeOf(deps.env), runOf(p, deps.env));
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
  if (p.bools.has('--json')) return { code, stdout: `${JSON.stringify({ run: state.run, divergences: plan.divergences, tickets: plan.tickets, writeBack: plan.writeBack }, null, 2)}\n`, stderr: '' };
  return { code, stdout: `${out.join('\n')}\n`, stderr: '' };
}
