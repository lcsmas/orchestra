// #539 — `acceptance freeze` runs the frozen tests once on the target tip and refuses an ERROR. REAL git (bare origin + writer clone) and the REAL runner (node --test);
// the production classifier and I/O. Mutants + the built CLI: scripts/e2e-fanout-freeze-check.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, type FanoutDeps } from './fanout-state.ts';
import { runAcceptance } from './fanout-acceptance.ts';
import { applyTicketPatch, newState, readState, stateFile, updateState, writeStateAtomic } from '../shared/fanout-state.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const T = "const test = require('node:test'); const assert = require('node:assert');\n";

/** Frozen-test bodies by scenario; each one is the shape of a real incident class. */
const BODIES: Record<string, string> = {
  'assert-fail': `${T}const { f } = require('../src/impl.js');\ntest('f is 1', () => { assert.equal(f(), 1); });\n`,
  'pass': `${T}test('trivial', () => {});\n`,
  'setup-error': `const { describe, it, before } = require('node:test'); const assert = require('node:assert');\ndescribe('s', () => { before(() => { throw new Error('fixture boom'); }); it('a', () => { assert.equal(1, 2); }); });\n`,
  'teardown-error': `const { describe, it, after } = require('node:test'); const assert = require('node:assert');\ndescribe('s', () => { after(() => { throw new Error('AssertionError: ERR_ASSERTION in teardown'); }); it('a', () => { assert.equal(1, 2); }); });\n`,
  'import-error': `${T}const { g } = require('../src/missing-module.js');\ntest('x', () => { assert.ok(g); });\n`,
  'helper-import': `${T}const { h } = require('./helper.js');\ntest('x', () => { assert.ok(h); });\n`,
  'type-error': `${T}test('x', () => { globalThis.nope(); });\n`,
  'hang': `${T}const fs = require('node:fs');\ntest('spins', () => new Promise(() => { fs.writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000); }));\n`,
};

function world(t: { after: (fn: () => void) => void }, body: string, o: { run?: string; role?: 'coordinator' | 'writer'; spec?: boolean } = {}) {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'freeze-539-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const bare = path.join(root, 'origin.git'), work = path.join(root, 'work'), home = path.join(root, 'home');
  execFileSync('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: GIT_ENV });
  execFileSync('git', ['clone', '-q', bare, work], { env: GIT_ENV, stdio: 'ignore' });
  const w = git(work);
  w('checkout', '-q', '-b', 'master');
  fs.mkdirSync(path.join(work, 'src'));
  fs.writeFileSync(path.join(work, 'src/impl.js'), 'exports.f = () => 0;\n');
  w('add', '.'); w('commit', '-q', '-m', 'base'); w('push', '-q', 'origin', 'master');
  w('checkout', '-q', '-b', 'writer');
  fs.mkdirSync(path.join(work, 't'));
  fs.writeFileSync(path.join(work, 't/spec.test.js'), body);
  fs.writeFileSync(path.join(work, 't/helper.js'), 'exports.h = 1;\n'); // committed on the writer's branch, NOT frozen
  w('add', '.'); w('commit', '-q', '-m', 'writer'); w('push', '-q', 'origin', 'writer');
  const caller = o.role === 'writer' ? 'w1' : 'r1';
  writeStateAtomic(stateFile(home, 'r1'), applyTicketPatch(newState('r1', { switches: { acceptance: 'on', minorPolicy: 'spec' }, now: NOW }), 'T1', { branch: 'impl', ...(o.spec ? { spec: 'spec.md' } : {}) }, NOW));
  updateState(stateFile(home, 'r1'), (s) => ({ ...s!, tickets: { ...s!.tickets, T1: { ...s!.tickets.T1, accept: { acceptor: { id: 'w1', name: 'accept-T1', at: NOW }, wait: null, waived: null } } } }));
  const deps = (extra: Record<string, string> = {}): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: caller, ...extra }, cwd: work, runner: defaultRunner, now: () => NOW, readStdin: () => '' });
  const freeze = (extra: string[] = [], env: Record<string, string> = {}) => runAcceptance(['freeze', 'T1', '--run', 'r1', '--files', 't/spec.test.js', '--run-cmd', o.run ?? 'node --test t/spec.test.js', '--from', 'writer', ...extra], deps(env));
  return { root, work, bare, w, freeze, state: () => readState(stateFile(home, 'r1'))!.tickets.T1, acceptanceBranch: () => execFileSync('git', ['ls-remote', '--heads', bare, 'refs/heads/acceptance/r1'], { encoding: 'utf8' }).trim() };
}

test('an assertion FAIL on the target tip is accepted: frozen, the check recorded clean', (t) => {
  const r = world(t, BODIES['assert-fail']);
  const res = r.freeze();
  assert.equal(res.code, 0, res.stderr);
  assert.match(res.stdout, /freeze check: on master@[0-9a-f]{12}: 0 pass, 1 assertion-fail \(accepted/);
  const fc = r.state().acceptance!.freezeCheck!;
  assert.deepEqual([fc.result, fc.pass, fc.assertionFail, fc.target], ['clean', 0, 1, 'master']);
  assert.equal(fc.targetSha, git(r.work)('rev-parse', 'origin/master'));
});

test('a test that already passes on the tip is accepted too', (t) => {
  assert.equal(world(t, BODIES.pass).freeze().code, 0);
});

for (const [name, why] of [['setup-error', / s: setup\/teardown hook failed: fixture boom/], ['teardown-error', / s: setup\/teardown hook failed: AssertionError: ERR_ASSERTION in teardown/], ['import-error', /spec\.test\.js: the test file's process ended with exit 1 \(load failure/], ['type-error', /TypeError/]] as const) {
  test(`${name}: REFUSED (exit 2), the test + its error named, nothing recorded or published`, (t) => {
    const r = world(t, BODIES[name], { spec: true });
    const res = r.freeze();
    assert.equal(res.code, 2, res.stdout + res.stderr);
    assert.match(res.stderr, /^refused: freeze check on master@[0-9a-f]{12}/);
    assert.match(res.stderr, why);
    assert.match(res.stderr, /nothing was published or recorded/);
    assert.equal(r.state().acceptance, null);
    assert.equal(r.acceptanceBranch(), '', 'the forced flow publishes only after the check');
    assert.equal(res.hostCalls, undefined, 'no "frozen" bus status either');
  });
}

test('the check runs on the CLEAN target checkout, not the writer tree: a helper committed on the writer branch but not frozen is not there', (t) => {
  const r = world(t, BODIES['helper-import']);
  const res = r.freeze();
  assert.equal(res.code, 2);
  assert.match(res.stderr, /helper-import|spec\.test\.js: the test file's process ended with exit 1 \(load failure/);
});

test('the target tip is FETCHED FRESH: a tip that moved on origin after the writer cloned is the one that is run', (t) => {
  const r = world(t, BODIES['assert-fail']);
  const other = path.join(r.root, 'other');
  execFileSync('git', ['clone', '-q', r.bare, other], { env: GIT_ENV, stdio: 'ignore' });
  fs.writeFileSync(path.join(other, 'src/impl.js'), "throw new Error('target tip broke at load');\n");
  git(other)('commit', '-q', '-am', 'tip moves'); git(other)('push', '-q', 'origin', 'master');
  assert.notEqual(git(r.work)('rev-parse', 'origin/master'), git(other)('rev-parse', 'HEAD'), 'the writer clone has not seen the new tip');
  const res = r.freeze();
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, new RegExp(`master@${git(other)('rev-parse', 'HEAD').slice(0, 12)}`));
});

test('a wall-clock timeout is an ERROR and the hung process group is gone afterwards', (t) => {
  const r = world(t, BODIES.hang);
  const pidFile = path.join(r.root, 'hang.pid');
  process.env.PIDFILE = pidFile; // the runner inherits the real environment
  t.after(() => { delete process.env.PIDFILE; });
  const res = r.freeze([], { ORCHESTRA_FREEZE_CHECK_TIMEOUT_MS: '2000' });
  assert.equal(res.code, 2, res.stdout + res.stderr);
  assert.match(res.stderr, /timeout/);
  const pid = Number(fs.readFileSync(pidFile, 'utf8'));
  assert.throws(() => process.kill(pid, 0), /ESRCH/, `the hung test process ${pid} must not survive the freeze`);
});

test('unclassifiable output fails closed; only the coordinator may record the escape; it never lifts a classified ERROR', (t) => {
  const run = 'pytest t/spec.test.js'; // a runner with no adapter
  const r = world(t, BODIES.pass, { run });
  const closed = r.freeze();
  assert.equal(closed.code, 2);
  assert.match(closed.stderr, /cannot be classified — no structured-output adapter for runner "pytest" \(supported: node --test, jest\)/);
  assert.match(closed.stderr, /--accept-unclassified/);
  assert.equal(r.state().acceptance, null);
  const empty = r.freeze(['--accept-unclassified', '  ']);
  assert.equal(empty.code, 2);
  assert.match(empty.stderr, /needs a reason/);
  const ok = r.freeze(['--accept-unclassified', 'pytest has no adapter yet; checked by hand']);
  assert.equal(ok.code, 0, ok.stderr);
  const fc = r.state().acceptance!.freezeCheck!;
  assert.equal(fc.result, 'escaped');
  assert.deepEqual(fc.escape, { by: 'r1', reason: 'pytest has no adapter yet; checked by hand', unclassified: fc.escape!.unclassified });
  assert.match(fc.escape!.unclassified, /no structured-output adapter/);
});

test('the escape is the coordinator\'s alone (a test writer is refused), and an escape does not lift a classified ERROR', (t) => {
  const w = world(t, BODIES.pass, { run: 'pytest t/spec.test.js', role: 'writer' });
  const res = w.freeze(['--accept-unclassified', 'please']);
  assert.equal(res.code, 2);
  assert.match(res.stderr, /--accept-unclassified is the run's coordinator's alone/);
  assert.equal(w.state().acceptance, null);
  const e = world(t, BODIES['setup-error']);
  const res2 = e.freeze(['--accept-unclassified', 'let it through']);
  assert.equal(res2.code, 2);
  assert.match(res2.stderr, /ERRORED/);
  assert.equal(e.state().acceptance, null);
});

test('a clean run + --accept-unclassified records clean, not an escape', (t) => {
  const r = world(t, BODIES['assert-fail']);
  assert.equal(r.freeze(['--accept-unclassified', 'unneeded']).code, 0);
  assert.equal(r.state().acceptance!.freezeCheck!.result, 'clean');
});

test('the state schema: freezeCheck round-trips, and a hand-edited one (escaped without an escape, unknown key) is refused', (t) => {
  const r = world(t, BODIES['assert-fail']);
  assert.equal(r.freeze().code, 0);
  const file = stateFile(path.join(r.root, 'home'), 'r1');
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  const bad = (fn: (fc: Record<string, unknown>) => void): unknown => { const s = structuredClone(good); fn(s.tickets.T1.acceptance.freezeCheck); return s; };
  for (const [why, mut] of [['escaped without an escape', (fc: Record<string, unknown>) => { fc.result = 'escaped'; }], ['unknown key', (fc: Record<string, unknown>) => { fc.verdict = 'ok'; }], ['bad sha', (fc: Record<string, unknown>) => { fc.targetSha = 'nope'; }]] as const) {
    fs.writeFileSync(file, JSON.stringify(bad(mut)));
    assert.throws(() => readState(file), /freezeCheck/, why);
  }
});
