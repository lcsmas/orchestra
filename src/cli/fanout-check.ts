// #564 (closes #562) — `orchestra fanout check <ticket> [--head <sha>] [--run <id>]`: run the target repo's pre-nomination checks (.orchestra/pre-nomination-checks.json, ledger #565 D2)
// from a CLEAN worktree whose HEAD is the candidate head, and record the result in the state keyed by the git TREE of that head. `state set --status nominated` reads the record.
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { FanoutStateError, recordChecks, stateFile, switchesOf, updateState } from '../shared/fanout-state.ts';
import { CHECKS_FILE, ChecksFileError, buildRecord, discoverChecks, outputTail, parseChecksFile, type CheckExec, type CheckResult, type CheckSpec } from '../shared/fanout-checks.ts';
import { homeOf, loadOrFail, parseArgs, runOf, type FanoutDeps, type RunResult } from './fanout-state.ts';

export const CHECK_USAGE = `usage: orchestra fanout check <ticket> [--head <sha>] [--run <id>]
         (#564, switch preNominationChecks=on) run the candidate's fast checks from a CLEAN worktree whose HEAD is the candidate (--head, else the ticket's recorded head), and record each
         command's exit code and duration in the state, keyed by the git TREE of that head. The commands are DISCOVERED: each file the candidate changes vs origin/<target> maps to the nearest
         package.json with a \`lint\` script, run from that directory (pnpm / yarn / npm by the nearest lockfile; a monorepo has one per package). ${CHECKS_FILE} is an optional OVERRIDE that wins
         ({"checks":[{"run":"<shell command>","cwd":"<path in the repo, default .>","timeoutSec":<default 300>}]}; {"checks":[]} = explicit no-check). NO SILENT GREEN: changed files and nothing
         found (no lint script, no override) is recorded as "nothing found" and the nomination stays refused. \`state set <ticket> --status nominated --head <sha>\` is REFUSED without a passing record for that tree (a coordinator with no checkout nominates on the record).
         A command over its limit is a failure. A tree already recorded as passing (a rebase that kept the content) is not run again. No changed file / an explicit empty override = vacuous pass, recorded as such.
         Exit 0 = passing record · 2 = a command failed or timed out, or nothing found (recorded; the nomination stays refused) · 1 = refused (dirty worktree, HEAD is not the candidate, switch off, bad file).
         A worker (no run of its own) passes the coordinator's --run.`;

const SHA_ARG = /^[0-9a-f]{7,40}$/;
const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** Production exec: `sh -c`, output to a temp file (a grandchild holding a pipe cannot hang the verb past its limit), SIGKILL at the limit. */
export const defaultCheckExec: CheckExec = (run, cwd, timeoutMs, env) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-check-'));
  const file = path.join(dir, 'out');
  const fd = fs.openSync(file, 'w');
  try {
    const r = spawnSync('/bin/sh', ['-c', run], { cwd, env, timeout: timeoutMs, killSignal: 'SIGKILL', stdio: ['ignore', fd, fd] });
    fs.closeSync(fd);
    const timedOut = (r.error as NodeJS.ErrnoException | undefined)?.code === 'ETIMEDOUT';
    const spawnErr = r.error && !timedOut ? `${r.error.message}\n` : '';
    return { exit: timedOut ? null : r.status, timedOut, output: spawnErr + fs.readFileSync(file, 'utf8') };
  } finally { fs.rmSync(dir, { recursive: true, force: true }); }
};

/** `dir` exists, is a directory, and (symlinks resolved) lies inside the repo root. */
function insideRepo(root: string, dir: string): boolean {
  try {
    const real = fs.realpathSync(dir);
    const base = fs.realpathSync(root);
    return fs.statSync(real).isDirectory() && (real === base || real.startsWith(base + path.sep));
  } catch { return false; }
}

/** Paths the candidate (HEAD) changes vs the target branch (merge-base diff against origin/<target>, else the local branch). Unreadable = refused: discovery never guesses. */
function changedFiles(git: (...a: string[]) => { code: number; stdout: string; stderr: string }, target: string): string[] {
  for (const base of [`origin/${target}`, target]) {
    const d = git('diff', '--name-only', '--no-renames', '-z', `${base}...HEAD`);
    if (d.code === 0) return d.stdout.split('\0').filter(Boolean);
  }
  throw new FanoutStateError(`cannot list the files the candidate changes against origin/${target} (not fetched?) — discovery needs them: git fetch origin ${target}, or declare the commands in ${CHECKS_FILE}`);
}

export function runCheck(args: string[], deps: FanoutDeps): RunResult {
  try { return check(args, deps); } catch (e) {
    if (e instanceof FanoutStateError || e instanceof ChecksFileError) return { code: 1, stdout: '', stderr: `${e.message}\n` };
    throw e;
  }
}

function check(args: string[], deps: FanoutDeps): RunResult {
  if (args[0] === '--help' || args[0] === '-h') return { code: 0, stdout: `${CHECK_USAGE}\n`, stderr: '' };
  const p = parseArgs(args, ['--run', '--head'], []);
  const [ticket, ...extra] = p.pos;
  if (!ticket || extra.length) throw new FanoutStateError(CHECK_USAGE);
  const r = runOf(p, deps, 'write');
  const file = stateFile(homeOf(deps.env), r.run);
  const state = loadOrFail(file);
  if (switchesOf(state).preNominationChecks !== 'on') throw new FanoutStateError(`run ${state.run}: the switch preNominationChecks is off — nothing reads a check record (switch it on before the first spawn: orchestra fanout state set --switch preNominationChecks=on)`);
  const recorded = state.tickets[ticket]?.head ?? null;
  const want = p.vals['--head'] ?? recorded;
  if (!want) throw new FanoutStateError(`${ticket}: no candidate head — pass --head <sha> (or record one with state set ${ticket} --head <sha>)`);
  if (!SHA_ARG.test(want)) throw new FanoutStateError(`--head must be 7-40 lowercase hex (got ${JSON.stringify(want)})`);
  const git = (...a: string[]): { code: number; stdout: string; stderr: string } => deps.runner('git', a, deps.cwd);
  const top = git('rev-parse', '--show-toplevel');
  if (top.code !== 0) throw new FanoutStateError(`not inside a git worktree (${deps.cwd}): run the checks from the worktree whose HEAD is the candidate ${want.slice(0, 12)}`);
  const root = top.stdout.trim();
  const headOf = (): string => git('rev-parse', 'HEAD').stdout.trim();
  const head = headOf();
  if (!head || !sameSha(head, want)) throw new FanoutStateError(`${ticket}: this worktree's HEAD is ${head.slice(0, 12) || '(unreadable)'}, not the candidate ${want.slice(0, 12)} — check out the candidate head, then re-run`);
  const dirty = git('-c', 'status.showUntrackedFiles=all', 'status', '--porcelain', '--untracked-files=all', '--ignore-submodules=none'); // flags, not config: a repo setting must not hide an untracked file the checks could read
  if (dirty.code !== 0) throw new FanoutStateError(`git status failed in ${root}: ${dirty.stderr.trim()}`);
  if (dirty.stdout.trim()) throw new FanoutStateError(`${ticket}: the worktree is not clean (${dirty.stdout.trim().split('\n').slice(0, 5).join('; ')}${dirty.stdout.trim().split('\n').length > 5 ? '; …' : ''}) — the record speaks about the committed head: commit or discard, then re-run`);
  const tr = git('rev-parse', '--verify', '-q', 'HEAD^{tree}');
  const tree = tr.stdout.trim();
  if (tr.code !== 0 || !/^(?:[0-9a-f]{40}|[0-9a-f]{64})$/.test(tree)) throw new FanoutStateError(`cannot read the git tree of HEAD in ${root}`);
  const have = state.tickets[ticket]?.checks?.[tree];
  if (have?.ok) return { code: 0, stdout: `${ticket}: tree ${tree.slice(0, 8)} already has a passing record (${have.vacuous ? 'vacuous — nothing to run' : `${have.results.length} command(s)`}, head ${have.head.slice(0, 8)}, ${have.at}) — nothing run\n`, stderr: r.note };
  // D2': the override file wins (an explicit empty list = no check); else DISCOVER from the files the candidate changes vs the target branch
  // everything is read from the COMMITTED head (an untracked / ignored file passes the clean check but is not in the tree the record is keyed by)
  const blob = (rel: string): string | null => { const g = git('show', `HEAD:${rel}`); return g.code === 0 ? g.stdout : null; };
  let specs: CheckSpec[];
  let source: 'override' | 'discovered' = 'override';
  let changed = 0;
  let uncovered: string[] = [];
  let overrideChanged = false;
  const override = blob(CHECKS_FILE);
  if (override !== null) {
    specs = parseChecksFile(override);
    try { overrideChanged = changedFiles(git, state.target).includes(CHECKS_FILE); } catch { /* no base to compare: the file alone decides */ }
  } else {
    source = 'discovered';
    const files = changedFiles(git, state.target);
    changed = files.length;
    const readPkg = (dir: string): { lint: boolean } | null => {
      const t = blob(dir === '.' ? 'package.json' : `${dir}/package.json`);
      if (t === null) return null;
      try { const j = JSON.parse(t) as { scripts?: Record<string, unknown> }; return { lint: typeof j?.scripts?.lint === 'string' && j.scripts.lint.trim() !== '' }; } catch { return null; }
    };
    ({ specs, uncovered } = discoverChecks(files, readPkg, (f) => blob(f) !== null));
  }
  const nothingFound = source === 'discovered' && changed > 0 && specs.length === 0;
  const overrideNote = overrideChanged ? `note: this candidate ADDS / CHANGES / DELETES ${CHECKS_FILE} vs origin/${state.target} — the commands it is checked by are its own; the reviewer should read that diff\n` : '';
  const uncoveredNote = uncovered.length ? `note: ${uncovered.length} changed file(s) are under NO package with a lint script and were not linted: ${uncovered.slice(0, 5).join(', ')}${uncovered.length > 5 ? ', …' : ''}\n` : '';
  const exec = deps.exec ?? defaultCheckExec;
  const results: CheckResult[] = [];
  for (const s of specs) {
    const cwd = path.resolve(root, s.cwd);
    const t0 = Date.now();
    if (!insideRepo(root, cwd)) {
      results.push({ run: s.run, cwd: s.cwd, exit: null, timedOut: false, durationMs: 0, tail: `working directory ${s.cwd} is not a directory inside the repo`, ...(s.from ? { from: s.from } : {}) });
      continue;
    }
    const x = exec(s.run, cwd, s.timeoutSec * 1000, deps.env);
    results.push({ run: s.run, cwd: s.cwd, exit: x.exit, timedOut: x.timedOut, durationMs: Date.now() - t0, tail: outputTail(x.output), ...(s.from ? { from: s.from } : {}) });
  }
  if (specs.length) { // a command that moved HEAD or edited a tracked file ran against a different content than the one recorded
    const after = git('status', '--porcelain', '--untracked-files=no', '--ignore-submodules=none');
    if (!sameSha(headOf(), head) || after.stdout.trim()) throw new FanoutStateError(`${ticket}: the checks changed the worktree (${sameSha(headOf(), head) ? after.stdout.trim().split('\n').slice(0, 3).join('; ') : 'HEAD moved'}) — nothing recorded: make them read-only (no --fix) and re-run`);
  }
  const rec = buildRecord(tree, head, deps.now(), source, changed, nothingFound, results, uncovered.slice(0, 20), overrideChanged);
  updateState(file, (cur) => {
    if (!cur) throw new FanoutStateError(`no state at ${file}`);
    return recordChecks(cur, ticket, rec, deps.now());
  });
  const lines = results.map((x) => `  ${x.timedOut ? 'TIMEOUT' : x.exit === 0 ? 'ok     ' : `FAIL ${x.exit ?? '-'}`}  ${(x.durationMs / 1000).toFixed(1)}s  ${x.run}${x.cwd !== '.' ? `  (in ${x.cwd})` : ''}${x.from ? `  [${x.from}]` : ''}`);
  const head8 = `${ticket}: tree ${tree.slice(0, 8)} (head ${head.slice(0, 8)})`;
  if (rec.nothingFound) return { code: 2, stdout: `${head8}: NOTHING FOUND — ${changed} changed file(s) vs origin/${state.target}, no package.json with a lint script above them, no ${CHECKS_FILE}. Recorded; the nomination stays refused (an explicit {"checks":[]} override is the only way to nominate with no check)\n`, stderr: r.note + overrideNote + uncoveredNote };
  if (rec.vacuous) return { code: 0, stdout: `${head8}: ${source === 'override' ? `${CHECKS_FILE} lists no check (explicit)` : `no file changed vs origin/${state.target}`} — nothing to run, recorded as a vacuous pass\n`, stderr: r.note + overrideNote + uncoveredNote };
  const where = source === 'override' ? `commands from ${CHECKS_FILE} (override)` : `discovered from ${changed} changed file(s) vs origin/${state.target}`;
  if (rec.ok) return { code: 0, stdout: `${head8}: ${results.length} check(s) passed (${where}), recorded\n${lines.join('\n')}\n`, stderr: r.note + overrideNote + uncoveredNote };
  const bad = results.filter((x) => x.exit !== 0 || x.timedOut);
  return { code: 2, stdout: `${head8}: ${bad.length}/${results.length} check(s) FAILED, recorded (${where}) — the nomination stays refused\n${lines.join('\n')}\n${bad.map((x) => `--- ${x.run}\n${x.tail}`).join('\n')}\n`, stderr: r.note + overrideNote + uncoveredNote };
}
