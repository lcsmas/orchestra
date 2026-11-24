// #564 (closes #562) — switch preNominationChecks + `orchestra fanout check`. Every arm drives the production verbs (`state set`, `fanout check`) against a REAL git repo in a scratch dir;
// the shell commands are a fake exec except the timeout arm (a real `sleep`). Mutants of every clause: scripts/e2e-fanout-checks.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { defaultRunner, runFanout, type FanoutDeps } from './fanout-state.ts';
import { defaultCheckExec, runCheck } from './fanout-check.ts';
import { DEFAULT_SWITCHES, V378_DEFAULT_SWITCHES, parseState, readState, stateFile, switchesOf, type FanoutState } from '../shared/fanout-state.ts';
import { CHECKS_FILE, ChecksFileError, parseChecksFile, type CheckExec } from '../shared/fanout-checks.ts';
import { renderVerifiedFanoutSkill } from '../shared/verified-fanout-skill.ts';

const NOW = '2026-11-24T10:00:00.000Z';
const tmp = (t: { after: (fn: () => void) => void }, p: string): string => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), p));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const git = (cwd: string, ...a: string[]): string => {
  const r = spawnSync('git', ['-c', 'user.name=t', '-c', 'user.email=t@t', ...a], { cwd, encoding: 'utf8' });
  assert.equal(r.status, 0, `git ${a.join(' ')}: ${r.stderr}`);
  return r.stdout.trim();
};
interface Rig { home: string; repo: string; calls: string[]; deps: FanoutDeps; run: (...a: string[]) => ReturnType<typeof runCheck>; set: (...a: string[]) => ReturnType<typeof runFanout>; state: () => FanoutState }
/** A scratch home + a real repo with one commit; `exec` is the fake the commands run through (records each command). */
function rig(t: { after: (fn: () => void) => void }, opts: { checks?: unknown; switches?: string; base?: Record<string, string>; changes?: Record<string, string>; target?: string; exec?: (run: string, n: number) => { exit: number | null; timedOut?: boolean; output?: string } } = {}): Rig {
  const home = tmp(t, 'fanout-chk-home-');
  const repo = tmp(t, 'fanout-chk-repo-');
  git(repo, 'init', '-q', '-b', 'master');
  if (opts.checks !== undefined) { fs.mkdirSync(path.join(repo, '.orchestra')); fs.writeFileSync(path.join(repo, CHECKS_FILE), typeof opts.checks === 'string' ? opts.checks : JSON.stringify(opts.checks)); }
  fs.writeFileSync(path.join(repo, 'a.txt'), 'one\n');
  for (const [f, c] of Object.entries(opts.base ?? {})) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'one');
  git(repo, 'checkout', '-q', '-b', 'feat'); // the candidate: master + `changes` (default: one root file edited)
  for (const [f, c] of Object.entries(opts.changes ?? { 'a.txt': 'feat\n' })) { fs.mkdirSync(path.dirname(path.join(repo, f)), { recursive: true }); fs.writeFileSync(path.join(repo, f), c); }
  if (Object.keys(opts.changes ?? { x: 1 }).length) { git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'feat'); }
  const calls: string[] = [];
  const exec: CheckExec = (run) => { const n = calls.push(run); const r = (opts.exec ?? (() => ({ exit: 0 })))(run, n); return { exit: r.exit, timedOut: r.timedOut ?? false, output: r.output ?? '' }; };
  const deps: FanoutDeps = { env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' }, cwd: repo, runner: defaultRunner, now: () => NOW, readStdin: () => '', exec };
  const init = runFanout(['state', 'init', '--run', 'r1', '--switch', opts.switches ?? 'preNominationChecks=on', ...(opts.target ? ['--target', opts.target] : [])], deps);
  assert.equal(init.code, 0, init.stderr);
  return { home, repo, calls, deps, run: (...a) => runCheck([...a, '--run', 'r1'], deps), set: (...a) => runFanout(['state', 'set', '--run', 'r1', ...a], deps), state: () => readState(stateFile(home, 'r1'))! };
}
const headOf = (repo: string): string => git(repo, 'rev-parse', 'HEAD');
const nominate = (r: Rig, ticket = 'T1', head = headOf(r.repo)) => r.set(ticket, '--status', 'nominated', '--branch', 'b1', '--head', head);

// ── the switch: table, defaults in BOTH profiles, freeze ──────────────────────────────────────────────────
test('#564 D3: preNominationChecks is off by default in BOTH defaults profiles; a state written before keeps its behaviour; on is explicit', () => {
  assert.equal(DEFAULT_SWITCHES.preNominationChecks, 'off');
  assert.equal(V378_DEFAULT_SWITCHES.preNominationChecks, 'off');
  assert.equal(switchesOf(undefined).preNominationChecks, 'off');
  const old = parseState({ version: 1, run: 'r1', target: 'master', repo: null, switches: { earlyGate: 'on', acceptance: 'on', minorPolicy: 'spec' }, tickets: {}, updatedAt: NOW, reconciledAt: null });
  assert.equal(switchesOf(old).preNominationChecks, 'off', 'a frozen v0.5.378 set carries no such key: off');
  // the skill text of a default run says nothing about it; the `on` render does
  assert.ok(!renderVerifiedFanoutSkill({}).includes('fanout check'));
  assert.ok(renderVerifiedFanoutSkill({ preNominationChecks: 'on' }).includes('fanout check'));
});

test('#564 state show: the switch is printed with its default|explicit label, and `on` adds one record line per open ticket', (t) => {
  const d = rig(t, { switches: 'earlyGate=on' });
  assert.match(runFanout(['state', 'show', '--run', 'r1'], d.deps).stdout, /preNominationChecks=off \(default\)/);
  const on = rig(t);
  assert.match(runFanout(['state', 'show', '--run', 'r1'], on.deps).stdout, /preNominationChecks=on \(explicit\)/);
  const r = rig(t, { checks: { checks: [{ run: 'echo hi' }] } });
  r.set('T1', '--status', 'started', '--branch', 'b1', '--head', headOf(r.repo));
  assert.match(runFanout(['state', 'show', '--run', 'r1'], r.deps).stdout, /pre-nomination checks \(#564\):\n {2}T1 {2}no record for/);
  assert.equal(r.run('T1').code, 0);
  assert.match(runFanout(['state', 'show', '--run', 'r1'], r.deps).stdout, /T1 {2}pass {2}tree [0-9a-f]{8} {2}1 command\(s\)/);
});

test('#564 must-FAIL: the switch changed after the first spawn is refused (the generic freeze covers the new name)', (t) => {
  const r = rig(t, { switches: 'earlyGate=on' });
  assert.equal(r.set('T1', '--status', 'started', '--branch', 'b1').code, 0);
  const x = r.set('--switch', 'preNominationChecks=on');
  assert.equal(x.code, 1);
  assert.match(x.stderr, /cannot change.*first spawn/);
  assert.equal(switchesOf(r.state()).preNominationChecks, 'off');
});

// ── the checks file (ledger #565 D2) ──────────────────────────────────────────────────────────────────────
test('#564 D2: the file format — defaults, every refusal (unknown key, bad type, cwd leaving the repo, bad timeout, not JSON)', () => {
  assert.deepEqual(parseChecksFile('{"checks":[]}'), []);
  assert.deepEqual(parseChecksFile('{"checks":[{"run":"pnpm lint"},{"run":"x","cwd":"app","timeoutSec":9}]}'), [{ run: 'pnpm lint', cwd: '.', timeoutSec: 300 }, { run: 'x', cwd: 'app', timeoutSec: 9 }]);
  for (const bad of ['{', '[]', '{"checks":{}}', '{"checks":[],"x":1}', '{"checks":[{}]}', '{"checks":[{"run":""}]}', '{"checks":[{"run":1}]}', '{"checks":[{"run":"a","extra":1}]}',
    '{"checks":[{"run":"a","cwd":"/etc"}]}', '{"checks":[{"run":"a","cwd":"../x"}]}', '{"checks":[{"run":"a","cwd":""}]}', '{"checks":[{"run":"a","timeoutSec":0}]}', '{"checks":[{"run":"a","timeoutSec":1.5}]}', '{"checks":[{"run":"a","timeoutSec":"9"}]}']) {
    assert.throws(() => parseChecksFile(bad), ChecksFileError, bad);
  }
});

// ── nomination: must-PASS / must-FAIL ─────────────────────────────────────────────────────────────────────
test('#564 must-PASS: on + a passing record → the nomination is accepted; the record is keyed by the git tree', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'pnpm lint' }, { run: 'pnpm typecheck', cwd: '.' }] } });
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 0, c.stderr);
  assert.deepEqual(r.calls, ['pnpm lint', 'pnpm typecheck']);
  const tree = git(r.repo, 'rev-parse', 'HEAD^{tree}');
  const rec = r.state().tickets.T1.checks![tree];
  assert.equal(rec.ok, true); assert.equal(rec.vacuous, false); assert.equal(rec.results.length, 2);
  assert.equal(nominate(r).code, 0);
  assert.equal(r.state().tickets.T1.status, 'nominated');
});

test('#564 must-FAIL: on + no record → refused ("no check record for this head"); off + no record → accepted', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x' }] } });
  const x = nominate(r);
  assert.equal(x.code, 1);
  assert.match(x.stderr, /no check record for this head/);
  assert.equal(r.state().tickets.T1, undefined, 'a refused nomination wrote nothing');
  const g = r.set('T1', '--status', 'gated', '--branch', 'b1', '--head', headOf(r.repo));
  assert.equal(g.code, 1, 'jumping straight to gated is not a way around the record');
  assert.match(g.stderr, /no check record for this head/);
  const off = rig(t, { switches: 'earlyGate=on' });
  assert.equal(nominate(off).code, 0, 'the switch off asks nothing');
});

test('#564 must-FAIL: a failing command → recorded, exit 2, and the nomination is refused naming the command and its last lines', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'pnpm lint' }, { run: 'pnpm typecheck' }] }, exec: (run) => run === 'pnpm lint' ? { exit: 1, output: `${Array.from({ length: 40 }, (_, i) => `line ${i}`).join('\n')}\nerror: no-unused-vars` } : { exit: 0 } });
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 2);
  assert.match(c.stdout, /1\/2 check\(s\) FAILED/);
  assert.equal(r.calls.length, 2, 'every command runs: the implementer sees all failures at once');
  const x = nominate(r);
  assert.equal(x.code, 1);
  assert.match(x.stderr, /FAILED.*exit 1: `pnpm lint`/s);
  assert.match(x.stderr, /error: no-unused-vars/);
  assert.ok(!x.stderr.includes('line 5\n') && x.stderr.includes('line 39'), 'the LAST lines, bounded');
  assert.ok(!x.stderr.includes('pnpm typecheck'), 'a passing command is not blamed');
  assert.equal(r.state().tickets.T1.status, 'todo');
});

test('#564 must-FAIL: a command over its time limit is a failure (a real `sleep`, 1 s limit) and the refusal says timed out', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'sleep 20', timeoutSec: 1 }] } });
  r.deps.exec = defaultCheckExec;
  const t0 = Date.now();
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.ok(Date.now() - t0 < 10_000, 'killed at the limit, not run to its end');
  assert.equal(c.code, 2);
  assert.match(c.stdout, /TIMEOUT/);
  const x = nominate(r);
  assert.equal(x.code, 1);
  assert.match(x.stderr, /timed out after \d+s: `sleep 20`/);
  assert.equal(r.state().tickets.T1.checks![git(r.repo, 'rev-parse', 'HEAD^{tree}')].results[0].timedOut, true);
});

test('#564 the real exec: exit code, output tail, cwd, and a passing command', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'echo out; echo err >&2; exit 3' }, { run: 'pwd', cwd: 'sub' }, { run: 'true' }] } });
  fs.mkdirSync(path.join(r.repo, 'sub')); fs.writeFileSync(path.join(r.repo, 'sub', 'f'), 'x'); git(r.repo, 'add', '-A'); git(r.repo, 'commit', '-q', '-m', 'sub');
  r.deps.exec = defaultCheckExec;
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 2);
  const rec = Object.values(r.state().tickets.T1.checks!)[0];
  assert.equal(rec.results[0].exit, 3);
  assert.match(rec.results[0].tail, /out\nerr|err\nout/);
  assert.equal(rec.results[1].exit, 0);
  assert.equal(rec.results[1].tail, fs.realpathSync(path.join(r.repo, 'sub')), 'ran in the declared cwd');
  assert.equal(rec.results[2].exit, 0);
});

test('#564 must-PASS: the same tree after a rebase → accepted with NO new run; another tree needs its own record', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'pnpm lint' }] } });
  const h1 = headOf(r.repo);
  assert.equal(r.run('T1', '--head', h1).code, 0);
  assert.equal(r.calls.length, 1);
  git(r.repo, 'commit', '-q', '--amend', '--allow-empty', '-m', 'one, reworded'); // same tree, another sha (a rebase / author rewrite)
  const h2 = headOf(r.repo);
  assert.notEqual(h1, h2);
  const again = r.run('T1', '--head', h2);
  assert.equal(again.code, 0);
  assert.match(again.stdout, /already has a passing record.*nothing run/);
  assert.equal(r.calls.length, 1, 'the checks did not run again');
  assert.equal(nominate(r, 'T1', h2).code, 0, 'the nomination on the rebased sha is accepted on the tree\'s record');
  fs.writeFileSync(path.join(r.repo, 'a.txt'), 'two\n'); git(r.repo, 'commit', '-qam', 'two');
  const h3 = headOf(r.repo);
  const x = r.set('T1', '--status', 'nominated', '--head', h3);
  assert.equal(x.code, 1);
  assert.match(x.stderr, /no check record for this head/);
  assert.equal(r.run('T1', '--head', h3).code, 0);
  assert.equal(r.calls.length, 2, 'a different tree runs again');
  const fin = r.set('T1', '--status', 'nominated', '--head', h3); assert.equal(fin.code, 0, fin.stderr);
});

test('#564 must-FAIL: `fanout check` from a dirty worktree (tracked edit or untracked file) → refused, nothing run, nothing recorded', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x' }] } });
  fs.writeFileSync(path.join(r.repo, 'a.txt'), 'edited\n');
  let c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /not clean/);
  git(r.repo, 'checkout', '--', 'a.txt');
  fs.writeFileSync(path.join(r.repo, 'new.txt'), 'x');
  c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /not clean/);
  assert.equal(r.calls.length, 0);
  assert.equal(r.state().tickets.T1, undefined);
});

test('#564 must-FAIL: `fanout check` with a HEAD that is not the candidate (--head, or the ticket\'s recorded head) → refused', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x' }] } });
  const h1 = headOf(r.repo);
  fs.writeFileSync(path.join(r.repo, 'a.txt'), 'two\n'); git(r.repo, 'commit', '-qam', 'two');
  let c = r.run('T1', '--head', h1);
  assert.equal(c.code, 1); assert.match(c.stderr, /HEAD is [0-9a-f]{12}, not the candidate/);
  assert.equal(r.set('T1', '--status', 'started', '--head', h1).code, 0);
  c = r.run('T1');
  assert.equal(c.code, 1); assert.match(c.stderr, /not the candidate/, 'the recorded head is the candidate when --head is omitted');
  c = rig(t, { checks: { checks: [] } }).run('T9');
  assert.equal(c.code, 1); assert.match(c.stderr, /no candidate head/);
  assert.equal(r.calls.length, 0);
});

test('#564 `fanout check` is refused when the switch is off; a bad checks file is refused and records nothing', (t) => {
  const off = rig(t, { switches: 'earlyGate=on', checks: { checks: [{ run: 'x' }] } });
  const c = off.run('T1', '--head', headOf(off.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /preNominationChecks is off/);
  const bad = rig(t, { checks: '{"checks":[{"run":"x","oops":1}]}' });
  const b = bad.run('T1', '--head', headOf(bad.repo));
  assert.equal(b.code, 1); assert.match(b.stderr, /unknown key "oops"/);
  assert.equal(bad.state().tickets.T1, undefined);
});

test('#564 D2\': an explicit empty override = nothing to run, a vacuous pass (and it admits a nomination WITH changed files); no changed file at all is vacuous too', (t) => {
  const empty = rig(t, { checks: { checks: [] } });
  let c = empty.run('T1', '--head', headOf(empty.repo));
  assert.equal(c.code, 0); assert.match(c.stdout, /lists no check \(explicit\)/);
  const rec = Object.values(empty.state().tickets.T1.checks!)[0];
  assert.equal(rec.vacuous, true); assert.equal(rec.source, 'override'); assert.equal(rec.nothingFound, false);
  assert.equal(nominate(empty).code, 0);
  const none = rig(t, { changes: {} }); // HEAD == master: the candidate changes nothing
  c = none.run('T1', '--head', headOf(none.repo));
  assert.equal(c.code, 0); assert.match(c.stdout, /no file changed/);
  assert.equal(nominate(none).code, 0);
});

test('#564 D2\' NO SILENT GREEN: changed files + no lint script + no override file → recorded "nothing found", exit 2, the nomination REFUSED with that message', (t) => {
  const r = rig(t, { base: { 'package.json': '{"scripts":{"test":"x"}}' } }); // a package.json without a lint script
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 2); assert.match(c.stdout, /NOTHING FOUND — 1 changed file/);
  assert.equal(r.calls.length, 0);
  const rec = Object.values(r.state().tickets.T1.checks!)[0];
  assert.equal(rec.nothingFound, true); assert.equal(rec.ok, false); assert.equal(rec.vacuous, false);
  const x = nominate(r);
  assert.equal(x.code, 1); assert.match(x.stderr, /found NOTHING to run.*explicit \{"checks":\[\]\}/s);
  r.set('T1', '--status', 'started', '--head', headOf(r.repo));
  assert.match(runFanout(['state', 'show', '--run', 'r1'], r.deps).stdout, /T1 {2}FAIL {2}tree [0-9a-f]{8} {2}nothing found/);
});

const LINT = '{"scripts":{"lint":"eslint ."}}';
test('#564 D2\' must-PASS discovery in a 2-package fixture runs ONLY the changed package\'s lint (pnpm lockfile → pnpm run lint, from the package dir)', (t) => {
  const r = rig(t, { base: { 'pnpm-lock.yaml': '', 'pkg-a/package.json': LINT, 'pkg-b/package.json': LINT, 'pkg-a/src/x.ts': 'x', 'pkg-b/src/y.ts': 'y' }, changes: { 'pkg-a/src/x.ts': 'x2' } });
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 0, c.stdout + c.stderr);
  assert.deepEqual(r.calls, ['pnpm run lint']);
  const rec = Object.values(r.state().tickets.T1.checks!)[0];
  assert.equal(rec.source, 'discovered'); assert.equal(rec.changed, 1);
  assert.equal(rec.results.length, 1); assert.equal(rec.results[0].cwd, 'pkg-a');
  assert.match(rec.results[0].from!, /pkg-a\/package\.json lint ← pkg-a\/src\/x\.ts/);
  assert.match(c.stdout, /discovered from 1 changed file/);
  assert.equal(nominate(r).code, 0);
  const both = rig(t, { base: { 'pkg-a/package.json': LINT, 'pkg-b/package.json': LINT, 'pkg-a/x.ts': 'x', 'pkg-b/y.ts': 'y' }, changes: { 'pkg-a/x.ts': '1', 'pkg-b/y.ts': '2' } });
  assert.equal(both.run('T1', '--head', headOf(both.repo)).code, 0);
  assert.deepEqual(both.calls, ['npm run lint', 'npm run lint'], 'one per package; no lockfile = npm');
  assert.deepEqual(Object.values(both.state().tickets.T1.checks!)[0].results.map((x) => x.cwd), ['pkg-a', 'pkg-b']);
});

test('#564 D2\' discovery: the NEAREST package.json WITH a lint script (one without is skipped); the nearest lockfile picks the manager; a root script covers a root file', (t) => {
  const r = rig(t, { base: { 'yarn.lock': '', 'app/package.json': LINT, 'app/lib/package.json': '{"name":"lib"}', 'app/lib/deep/z.ts': 'z', 'app/package-lock.json': '' }, changes: { 'app/lib/deep/z.ts': 'z2' } });
  assert.equal(r.run('T1', '--head', headOf(r.repo)).code, 0);
  assert.deepEqual(r.calls, ['npm run lint'], 'app/package-lock.json is nearer than the root yarn.lock');
  assert.equal(Object.values(r.state().tickets.T1.checks!)[0].results[0].cwd, 'app');
  const root = rig(t, { base: { 'yarn.lock': '', 'package.json': LINT } }); // default change: a.txt at the root
  assert.equal(root.run('T1', '--head', headOf(root.repo)).code, 0);
  assert.deepEqual(root.calls, ['yarn run lint']);
  assert.equal(Object.values(root.state().tickets.T1.checks!)[0].results[0].cwd, '.');
});

test('#564 D2\' the override file WINS over discovery (narrowed / extended command set), and a failing discovered lint refuses the nomination naming it', (t) => {
  const r = rig(t, { base: { 'package.json': LINT }, checks: { checks: [{ run: 'fast-lint' }] } });
  assert.equal(r.run('T1', '--head', headOf(r.repo)).code, 0);
  assert.deepEqual(r.calls, ['fast-lint'], 'the discovered root lint did not run');
  assert.equal(Object.values(r.state().tickets.T1.checks!)[0].source, 'override');
  const f = rig(t, { base: { 'package.json': LINT }, exec: () => ({ exit: 1, output: 'eslint: 3 problems' }) });
  assert.equal(f.run('T1', '--head', headOf(f.repo)).code, 2);
  const x = nominate(f);
  assert.equal(x.code, 1); assert.match(x.stderr, /exit 1: `npm run lint`/); assert.match(x.stderr, /3 problems/);
});

test('#564 D2\' the changed files are read against the target branch: an unreadable base refuses (discovery never guesses); the override file needs no base', (t) => {
  const r = rig(t, { target: 'nope', base: { 'package.json': LINT } });
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /cannot list the files the candidate changes/);
  assert.equal(r.state().tickets.T1, undefined);
  const o = rig(t, { target: 'nope', checks: { checks: [{ run: 'x' }] } });
  assert.equal(o.run('T1', '--head', headOf(o.repo)).code, 0);
});

test('#564 a command that edits a tracked file (a --fix) invalidates the run: refused, nothing recorded', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'fixer' }] }, exec: () => { fs.writeFileSync(path.join(r0.repo, 'a.txt'), 'rewritten\n'); return { exit: 0 }; } });
  const r0 = r;
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /changed the worktree/);
  assert.equal(r.state().tickets.T1, undefined);
});

test('#564 a cwd that is a symlink out of the repo is a failed check, not a run outside the repo', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x', cwd: 'link' }] } });
  fs.symlinkSync(os.tmpdir(), path.join(r.repo, 'link')); git(r.repo, 'add', '-A'); git(r.repo, 'commit', '-q', '-m', 'link');
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 2);
  assert.equal(r.calls.length, 0, 'the command never ran');
  assert.match(c.stdout, /not a directory inside the repo/);
});

test('#564 a record cannot be forged by hand: `checks` is not settable, and a stored record whose ok contradicts its results is refused on read', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x' }] }, exec: () => ({ exit: 1 }) });
  r.run('T1', '--head', headOf(r.repo));
  const j = r.set('T1', '--json', JSON.stringify({ checks: {} }));
  assert.equal(j.code, 1); assert.match(j.stderr, /unknown field "checks"/);
  const file = stateFile(r.home, 'r1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  const tree = Object.keys(raw.tickets.T1.checks)[0];
  raw.tickets.T1.checks[tree].ok = true; // the failing run turned into a pass
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => readState(file), /ok \/ vacuous \/ nothingFound do not match/);
  raw.tickets.T1.checks[tree].ok = false; raw.tickets.T1.checks[tree].nothingFound = true; // "nothing found" next to commands that ran
  fs.writeFileSync(file, JSON.stringify(raw));
  assert.throws(() => readState(file), /do not match/);
});

test('#564 the unknown tree: a head whose tree cannot be read cannot be nominated on (fail closed)', (t) => {
  const r = rig(t, { checks: { checks: [] } });
  assert.equal(r.run('T1', '--head', headOf(r.repo)).code, 0);
  const x = r.set('T1', '--status', 'nominated', '--head', 'c'.repeat(40)); // not an object of this repo (and gh offline in the test env is not consulted for a wrong sha)
  assert.equal(x.code, 1);
  assert.match(x.stderr, /no check record for this head/);
});

test('#564 review: a repo config that hides untracked files cannot hide them from the clean check; a candidate that changes the override file is flagged', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'x' }] } });
  git(r.repo, 'config', 'status.showUntrackedFiles', 'no');
  fs.writeFileSync(path.join(r.repo, 'helper.ts'), 'untracked');
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 1); assert.match(c.stderr, /not clean/);
  fs.rmSync(path.join(r.repo, 'helper.ts'));
  const fixed = rig(t, { changes: { '.orchestra/pre-nomination-checks.json': '{"checks":[]}' } }); // the candidate itself ADDS the override
  const f = fixed.run('T1', '--head', headOf(fixed.repo));
  assert.equal(f.code, 0); assert.match(f.stderr, /ADDS \/ CHANGES \/ DELETES .orchestra\/pre-nomination-checks.json/);
  assert.doesNotMatch(r.run('T1', '--head', headOf(r.repo)).stderr, /ADDS/, 'an override that is the target\'s own is not flagged');
});

test('#564 review 2: the override is read from the COMMITTED head (an ignored / untracked file is not it); the candidate changing it is recorded and shown; uncovered changed files are recorded; a rename lints the old package too', (t) => {
  const r = rig(t, { base: { 'package.json': LINT } });
  fs.mkdirSync(path.join(r.repo, '.orchestra'), { recursive: true });
  fs.writeFileSync(path.join(r.repo, '.orchestra', '.gitignore'), '*\n');
  fs.writeFileSync(path.join(r.repo, CHECKS_FILE), '{"checks":[]}'); // ignored + uncommitted: passes `status`, is NOT in the tree
  const c = r.run('T1', '--head', headOf(r.repo));
  assert.equal(c.code, 0);
  assert.deepEqual(r.calls, ['npm run lint'], 'the uncommitted empty override did not win');
  const o = rig(t, { changes: { '.orchestra/pre-nomination-checks.json': '{"checks":[]}' } });
  assert.equal(o.run('T1', '--head', headOf(o.repo)).code, 0);
  assert.equal(Object.values(o.state().tickets.T1.checks!)[0].overrideChanged, true);
  o.set('T1', '--status', 'started', '--head', headOf(o.repo));
  assert.match(runFanout(['state', 'show', '--run', 'r1'], o.deps).stdout, /override file changed by this candidate/);
  const u = rig(t, { base: { 'pkg-a/package.json': LINT, 'pkg-a/x.ts': 'x', 'docs/readme.md': 'd' }, changes: { 'pkg-a/x.ts': 'x2', 'docs/readme.md': 'd2' } });
  const uc = u.run('T1', '--head', headOf(u.repo));
  assert.equal(uc.code, 0); assert.match(uc.stderr, /1 changed file\(s\) are under NO package with a lint script.*docs\/readme\.md/);
  assert.deepEqual(Object.values(u.state().tickets.T1.checks!)[0].uncovered, ['docs/readme.md']);
  const mv = rig(t, { base: { 'pkg-a/package.json': LINT, 'pkg-b/package.json': LINT, 'pkg-a/x.ts': 'unique content for rename detection\n'.repeat(5) } });
  git(mv.repo, 'mv', 'pkg-a/x.ts', 'pkg-b/x.ts'); git(mv.repo, 'commit', '-qam', 'move');
  assert.equal(mv.run('T1', '--head', headOf(mv.repo)).code, 0);
  assert.equal(mv.calls.length, 2, 'both packages are linted: the rename lists the old path too');
});

test('#564 fix round: the record rule also holds for a patch carrying a verdict (pass|approve); a resume write-back moving a nominated ticket onto a record-less tree demotes it to started; the nothing-found message and --help say `git add -f`', (t) => {
  const r = rig(t, { checks: { checks: [] } });
  const h = headOf(r.repo);
  const v = r.set('T1', '--head', h, '--verdict', 'pass'); // no record yet: a pass verdict on an unchecked head
  assert.equal(v.code, 1); assert.match(v.stderr, /no check record for this head/);
  assert.equal(r.set('T1', '--head', h, '--verdict', 'fail').code, 0, 'a non-pass verdict is not a candidate');
  assert.equal(r.run('T1', '--head', h).code, 0);
  assert.equal(nominate(r).code, 0);
  assert.equal(r.set('T1', '--verdict', 'pass').code, 0, 'with the record, the verdict form is accepted');
  // the branch moves to another tree (a push after nomination): reconcile + write-back
  fs.writeFileSync(path.join(r.repo, 'a.txt'), 'moved\n'); git(r.repo, 'commit', '-qam', 'moved');
  git(r.repo, 'init', '-q', '--bare', path.join(r.home, 'origin.git'));
  git(r.repo, 'remote', 'add', 'origin', path.join(r.home, 'origin.git'));
  git(r.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/b1');
  git(r.repo, 'push', '-q', 'origin', 'master:refs/heads/master'); git(r.repo, 'fetch', '-q', 'origin');
  const res = runFanout(['resume', '--run', 'r1', '--cwd', r.repo, '--no-fetch'], r.deps);
  assert.match(res.stdout, /head moved onto a tree with no passing pre-nomination check record/);
  const t1 = r.state().tickets.T1;
  assert.equal(t1.status, 'started'); assert.equal(t1.verdict, 'none'); assert.equal(t1.head, headOf(r.repo));
  const again = r.set('T1', '--verdict', 'pass');
  assert.equal(again.code, 1, 'the short form no longer leaks a pass onto the unchecked head');
  // the nothing-found message and the usage name the force-add
  const n = rig(t, { base: { 'package.json': '{"scripts":{"test":"x"}}' } });
  n.run('T1', '--head', headOf(n.repo));
  assert.match(nominate(n).stderr, /git add -f \.orchestra\/pre-nomination-checks\.json/);
  assert.match(runCheck(['--help'], n.deps).stdout, /git add -f \.orchestra\/pre-nomination-checks\.json/);
});

test('#564 fix round: a write-back onto a tree that DOES hold a passing record keeps the ticket nominated (no needless demotion)', (t) => {
  const r = rig(t, { checks: { checks: [] } });
  assert.equal(r.run('T1', '--head', headOf(r.repo)).code, 0);
  assert.equal(nominate(r).code, 0);
  fs.writeFileSync(path.join(r.repo, 'a.txt'), 'second\n'); git(r.repo, 'commit', '-qam', 'second');
  assert.equal(r.run('T1', '--head', headOf(r.repo)).code, 0, 'the new tree is checked first');
  git(r.repo, 'init', '-q', '--bare', path.join(r.home, 'origin.git'));
  git(r.repo, 'remote', 'add', 'origin', path.join(r.home, 'origin.git'));
  git(r.repo, 'push', '-q', 'origin', 'HEAD:refs/heads/b1'); git(r.repo, 'push', '-q', 'origin', 'master:refs/heads/master'); git(r.repo, 'fetch', '-q', 'origin');
  runFanout(['resume', '--run', 'r1', '--cwd', r.repo, '--no-fetch'], r.deps);
  const t1 = r.state().tickets.T1;
  assert.equal(t1.status, 'nominated'); assert.equal(t1.head, headOf(r.repo));
});

test('#564 verifier MINOR: a status-only `--status nominated` (head recorded earlier) is refused; a FAILED same-tree record is re-run (a flaky retry can pass); a timeout kill cannot be ignored by the command (SIGKILL)', (t) => {
  const r = rig(t, { checks: { checks: [{ run: 'lint' }] }, exec: (_run, n) => ({ exit: n === 1 ? 1 : 0 }) });
  const h = headOf(r.repo);
  assert.equal(r.set('T1', '--status', 'started', '--branch', 'b1', '--head', h).code, 0);
  const s = r.set('T1', '--status', 'nominated');
  assert.equal(s.code, 1, 'no --head in the patch: the recorded head still needs its record'); assert.match(s.stderr, /no check record for this head/);
  assert.equal(r.run('T1').code, 2);
  assert.equal(r.set('T1', '--status', 'nominated').code, 1, 'a failing record does not admit it either');
  assert.equal(r.run('T1').code, 0, 'the same tree, a FAILED record: the checks run again');
  assert.equal(r.calls.length, 2);
  assert.equal(r.set('T1', '--status', 'nominated').code, 0);
  const k = rig(t, { checks: { checks: [{ run: 'trap "" TERM; sleep 15', timeoutSec: 1 }] } });
  k.deps.exec = defaultCheckExec;
  const t0 = Date.now();
  assert.equal(k.run('T1', '--head', headOf(k.repo)).code, 2);
  assert.ok(Date.now() - t0 < 10_000, 'a command that ignores SIGTERM is still killed at the limit');
});
