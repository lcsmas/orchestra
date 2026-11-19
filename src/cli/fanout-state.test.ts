import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { defaultRunner, runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';

const NOW = '2026-11-19T10:00:00.000Z';
const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = path.resolve(here, '..', '..', 'dist-electron', 'cli.js');

function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), 'fanout-cli-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
function deps(home: string, runner: Runner, extra: Partial<FanoutDeps> = {}): FanoutDeps {
  return { env: { ORCHESTRA_HOME: home }, cwd: home, runner, now: () => NOW, readStdin: () => '', ...extra };
}
const noRunner: Runner = () => { throw new Error('git/gh must not be called'); };
const set = (d: FanoutDeps, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], d);

test('init → set → show, flags and --json both work; unknown flag / field refused', (t) => {
  const d = deps(mkHome(t), noRunner);
  assert.equal(runFanout(['state', 'init', '--run', 'r1', '--target', 'bench/x'], d).code, 0);
  assert.match(runFanout(['state', 'init', '--run', 'r1'], d).stderr, /already exists/);
  assert.equal(set(d, 'A', '--status', 'started', '--branch', 'a', '--pr', '7').code, 0);
  assert.equal(set(d, 'B', '--json', '{"dependsOn":["A"],"frozenInterface":"#471","status":"started"}').code, 0);
  assert.equal(set(deps(d.env.ORCHESTRA_HOME!, noRunner, { readStdin: () => '{"head":"abc12345"}' }), 'A', '--json', '-').code, 0);
  const show = runFanout(['state', 'show', '--run', 'r1'], d).stdout;
  assert.match(show, /origin\/bench\/x/);
  assert.match(show, /A\s+started\s+none\s+a\s+#7\s+abc12345/);
  const j = JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], d).stdout);
  assert.deepEqual(j.tickets.B.dependsOn, ['A']);
  // must-FAIL arms: the writer refuses
  assert.match(set(d, 'A', '--colour', 'red').stderr, /unknown flag --colour/);
  assert.match(set(d, 'A', '--json', '{"colour":1}').stderr, /unknown field "colour"/);
  assert.match(set(d, 'B', '--status', 'nominated').stderr, /not merged yet/);
  assert.equal(set(d, 'B', '--status', 'nominated').code, 1);
  assert.match(set(d, 'C', '--depends-on', 'A', '--status', 'started').stderr, /no frozen interface/);
  assert.match(runFanout(['state', 'show', '--run', '../x'], d).stderr, /unsafe run id/);
  assert.match(runFanout(['state', 'show', '--run', 'none'], d).stderr, /no state at/);
  assert.equal(runFanout(['bogus'], d).code, 1);
});

/** Real git against a scratch bare origin + a fake gh: the reads are the ones production makes. */
function gitRepo(t: { after: (fn: () => void) => void }): { home: string; clone: string; git: (...a: string[]) => string } {
  const home = mkHome(t);
  const origin = path.join(home, 'origin.git');
  const clone = path.join(home, 'clone');
  const env = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
  const g = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env, encoding: 'utf8' }).trim();
  fs.mkdirSync(origin);
  g(origin)('init', '--bare', '-b', 'master');
  g(home)('clone', '-q', origin, clone);
  const git = g(clone);
  git('commit', '--allow-empty', '-q', '-m', 'root');
  git('push', '-q', 'origin', 'master');
  return { home, clone, git };
}
/** git → real, gh → the fake. */
const hybrid = (gh: (args: string[]) => { code: number; stdout: string }): Runner => (cmd, args, cwd) =>
  cmd === 'gh' ? { ...gh(args), stderr: '' } : defaultRunner(cmd, args, cwd);

test('resume against real git: merged-in-state-but-not-in-git is reported (exit 2); merged-in-git-not-in-state is written back', (t) => {
  const { home, clone, git } = gitRepo(t);
  git('checkout', '-q', '-b', 'feat-a');
  git('commit', '--allow-empty', '-q', '-m', 'a');
  git('push', '-q', 'origin', 'feat-a');
  const headA = git('rev-parse', 'HEAD');
  git('checkout', '-q', '-b', 'feat-b', 'master');
  git('commit', '--allow-empty', '-q', '-m', 'b');
  git('push', '-q', 'origin', 'feat-b');
  const headB = git('rev-parse', 'HEAD');
  git('checkout', '-q', 'master');
  git('merge', '-q', '--no-ff', '-m', 'merge b', 'feat-b');
  git('push', '-q', 'origin', 'master');

  const d = deps(home, hybrid((a) => ({ code: 1, stdout: `no PR ${a.join(' ')}` })), { cwd: clone });
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'A', '--branch', 'feat-a', '--head', headA, '--status', 'nominated');
  set(d, 'B', '--branch', 'feat-b', '--head', headB, '--status', 'nominated');
  // The coordinator CLAIMS A merged (forced by editing the file: the writer would allow it too — A has no upstream).
  set(d, 'A', '--status', 'merged');
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone], d);
  assert.equal(r.code, 2, r.stdout + r.stderr);
  assert.match(r.stdout, /! A state-merged-reality-not/);
  assert.match(r.stdout, /! B reality-merged-state-not/);
  assert.match(r.stdout, /1\/5 load[\s\S]*2\/5 reconcile[\s\S]*3\/5 classify[\s\S]*4\/5 next action[\s\S]*5\/5 write back/);
  const after = JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], d).stdout);
  assert.equal(after.tickets.B.status, 'merged', 'reality-ahead fact written back');
  assert.equal(after.tickets.A.status, 'merged', 'a state-ahead claim is reported, never auto-corrected');
  assert.ok(after.reconciledAt);
});

test('resume: a clean state exits 0; --no-write leaves the file byte-exact', (t) => {
  const { home, clone, git } = gitRepo(t);
  git('checkout', '-q', '-b', 'feat-a');
  git('commit', '--allow-empty', '-q', '-m', 'a');
  git('push', '-q', 'origin', 'feat-a');
  const head = git('rev-parse', 'HEAD');
  const d = deps(home, hybrid(() => ({ code: 1, stdout: '' })), { cwd: clone });
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'A', '--branch', 'feat-a', '--head', head, '--status', 'nominated');
  const file = path.join(home, 'fanout', 'r1', 'state.json');
  const before = fs.readFileSync(file);
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone, '--no-write'], d);
  assert.equal(r.code, 0, r.stdout);
  assert.match(r.stdout, /A\s+awaiting-gate\s+gate/);
  assert.ok(before.equals(fs.readFileSync(file)));
});

test('resume: head moved after the verdict is reported; unreachable git is UNKNOWN, not "gone"', (t) => {
  const { home, clone, git } = gitRepo(t);
  git('checkout', '-q', '-b', 'feat-a');
  git('commit', '--allow-empty', '-q', '-m', 'a');
  git('push', '-q', 'origin', 'feat-a');
  const old = git('rev-parse', 'HEAD');
  git('commit', '--allow-empty', '-q', '-m', 'a2');
  git('push', '-q', 'origin', 'feat-a');
  const d = deps(home, hybrid(() => ({ code: 1, stdout: '' })), { cwd: clone });
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'A', '--branch', 'feat-a', '--head', old, '--status', 'gated', '--verdict', 'pass');
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone], d);
  assert.match(r.stdout, /! A head-moved/);
  assert.match(r.stdout, /A\s+diverged\s+re-gate/);
  const st = JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], d).stdout);
  assert.deepEqual([st.tickets.A.verdict, st.tickets.A.status], ['none', 'nominated']);
  // git unreachable: every git call fails
  const dead: Runner = (cmd) => ({ code: cmd === 'git' ? 128 : 1, stdout: '', stderr: 'boom' });
  const u = runFanout(['resume', '--run', 'r1', '--cwd', clone, '--no-write'], deps(home, dead, { cwd: clone }));
  assert.equal(u.code, 2);
  assert.match(u.stdout, /! A reality-unreadable/);
  assert.doesNotMatch(u.stdout, /branch-gone|state-merged-reality-not/);
});

test('gh is consulted for the PR (squash merge: branch gone + PR MERGED = merged)', (t) => {
  const { home, clone, git } = gitRepo(t);
  const d = deps(home, hybrid((a) => (a[0] === 'pr' && a[1] === 'view' && a[2] === '9' ? { code: 0, stdout: JSON.stringify({ state: 'MERGED', headRefOid: 'f'.repeat(40), baseRefName: 'master' }) } : { code: 1, stdout: '' })), { cwd: clone });
  void git;
  runFanout(['state', 'init', '--run', 'r1', '--repo', 'o/r'], d);
  set(d, 'A', '--branch', 'gone-branch', '--head', 'f'.repeat(40), '--pr', '9', '--status', 'started');
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone, '--no-write'], d);
  assert.match(r.stdout, /! A reality-merged-state-not/);
});

test('built CLI: `orchestra fanout` is dispatched, exits 2 on divergence and 1 on a refusal', { skip: fs.existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' }, (t) => {
  const home = mkHome(t);
  const cli = (...a: string[]) => spawnSync('node', [CLI, 'fanout', ...a], { env: { PATH: process.env.PATH ?? '', ORCHESTRA_HOME: home }, encoding: 'utf8' });
  assert.equal(cli('state', 'init', '--run', 'r1').status, 0);
  assert.equal(cli('state', 'set', 'A', '--run', 'r1', '--status', 'started').status, 0);
  const bad = cli('state', 'set', 'B', '--run', 'r1', '--depends-on', 'A', '--status', 'nominated');
  assert.equal(bad.status, 1);
  assert.match(bad.stderr, /not merged yet/);
  assert.equal(cli('state', 'show', '--run', 'r1').status, 0);
});

test('pre-review MAJOR: merged, branch deleted, no head/PR recorded → UNKNOWN (unverifiable), not "not merged"', (t) => {
  const { home, clone } = gitRepo(t);
  const d = deps(home, hybrid(() => ({ code: 1, stdout: '' })), { cwd: clone });
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'C', '--branch', 'c-gone', '--status', 'merged');
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone, '--no-write'], d);
  assert.match(r.stdout, /! C reality-unreadable/);
  assert.doesNotMatch(r.stdout, /state-merged-reality-not/);
  assert.match(set(d, 'C', '--pr', '0x10').stderr, /pr must be/);
  assert.match(set(d, 'C', '--head', '--help').stderr, /needs a value|head/);
});

test('review MAJOR 1 (CLI): gh without baseRefName is UNKNOWN; MERGED into another base is reported', (t) => {
  const { home, clone } = gitRepo(t);
  let reply = JSON.stringify({ state: 'MERGED', headRefOid: 'f'.repeat(40) });
  const d = deps(home, hybrid(() => ({ code: 0, stdout: reply })), { cwd: clone });
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'A', '--branch', 'gone-branch', '--head', 'f'.repeat(40), '--pr', '9', '--status', 'nominated');
  assert.match(runFanout(['resume', '--run', 'r1', '--cwd', clone, '--no-write'], d).stdout, /! A reality-unreadable.*no baseRefName/);
  reply = JSON.stringify({ state: 'MERGED', headRefOid: 'f'.repeat(40), baseRefName: 'feature-upstream' });
  const r = runFanout(['resume', '--run', 'r1', '--cwd', clone], d);
  assert.match(r.stdout, /! A pr-merged-other-base/);
  assert.equal(JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], d).stdout).tickets.A.status, 'nominated');
});

test('follow-up MINOR 2 (CLI): --accept-merged is recorded, shown in --json, refused on a non-merged ticket', (t) => {
  const d = deps(mkHome(t), noRunner);
  runFanout(['state', 'init', '--run', 'r1'], d);
  set(d, 'A', '--status', 'merged', '--branch', 'a');
  assert.match(set(d, 'B', '--status', 'started', '--branch', 'b', '--accept-merged', 'why').stderr, /only applies to a merged ticket/);
  assert.equal(set(d, 'A', '--accept-merged', 'landed via U squash').code, 0);
  assert.equal(JSON.parse(runFanout(['state', 'show', '--run', 'r1', '--json'], d).stdout).tickets.A.mergedAccepted, 'landed via U squash');
});
