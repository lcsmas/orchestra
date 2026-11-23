// #539 — the freeze classifier on REAL `node --test --test-reporter=tap` captures (src/shared/fanout-freeze-captures/, Node v22.22.0).
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { NODE_TEST, adapterFor, classifyRun, formatErrors, isExpectFailure, type ExecResult, type FreezeVerdict } from './fanout-freeze-classify.ts';

const DIR = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fanout-freeze-captures');
const cap = (n: string): string => fs.readFileSync(path.join(DIR, `${n}.tap.txt`), 'utf8');
const FROZEN = ['node', '--test', 't/x.test.mjs'];
const run = (n: string, over: Partial<ExecResult> = {}): FreezeVerdict => classifyRun(FROZEN, { exit: n === 'pass' || n === 'empty' || n === 'skip' || n === 'todoerr' ? 0 : 1, signal: null, timedOut: false, stdout: cap(n), ...over });
const errs = (v: FreezeVerdict): string[] => (v.kind === 'error' ? v.errors.map((e) => `${e.name} :: ${e.reason}`) : []);

test('all-pass is clean', () => {
  const v = run('pass');
  assert.equal(v.kind, 'clean');
  assert.deepEqual(v.kind === 'clean' && [v.pass, v.assertionFail], [2, 0]);
});

test('an assertion FAIL is accepted (the behaviour is not built yet)', () => {
  const v = run('assertfail');
  assert.equal(v.kind, 'clean');
  assert.deepEqual(v.kind === 'clean' && [v.pass, v.assertionFail], [1, 2]);
});

test('setup error (before hook): ERROR — the suite and the cancelled tests under it', () => {
  const v = run('setuperr');
  assert.equal(v.kind, 'error');
  assert.ok(errs(v).some((e) => /^suite :: setup\/teardown hook failed: fixture boom/.test(e)), errs(v).join('|'));
  assert.ok(errs(v).some((e) => /^suite › a :: cancelled/.test(e)));
});

test('beforeEach error: ERROR on the test it broke', () => {
  const v = run('beforeeach');
  assert.equal(v.kind, 'error');
  assert.deepEqual(errs(v), ['suite › a :: setup/teardown hook failed: each boom']);
});

test('afterAll error: ERROR even though every test passed or failed on an assertion', () => {
  const v = run('aftererr');
  assert.equal(v.kind, 'error');
  assert.deepEqual(errs(v), ['suite :: setup/teardown hook failed: teardown boom']);
  assert.equal(v.kind === 'error' && v.assertionFail, 1);
});

test('import error / syntax error / top-level throw: the file never loaded ⇒ ERROR', () => {
  for (const n of ['importerr', 'syntaxerr', 'toplevelthrow']) {
    const v = run(n);
    assert.equal(v.kind, 'error', n);
    assert.match(errs(v)[0], /the test file's process ended with exit 1 \(load failure/, n);
  }
});

test('a non-assertion exception in the test body (TypeError) is an ERROR, an uncaught async throw too', () => {
  assert.match(errs(run('typeerr'))[0], /TypeError/);
  assert.match(errs(run('asyncthrow'))[0], /uncaughtException: late async/);
});

test('timeouts: a runner-reported timeout and a wall-clock kill are ERRORs', () => {
  assert.match(errs(run('realtimeout'))[0], /^slow :: timeout: test timed out after 200ms/);
  const v = run('hangforever', { exit: null, signal: null, timedOut: true });
  assert.equal(v.kind, 'error');
  assert.match(errs(v)[0], /timeout/);
});

test('crash: a test that exits the process / is killed ⇒ ERROR; the runner killed by a signal too', () => {
  assert.match(errs(run('crash'))[0], /ended with exit 3/);
  assert.match(errs(run('sigkill'))[0], /ended with signal SIGKILL/);
  const v = run('pass', { exit: null, signal: 'SIGSEGV' });
  assert.equal(v.kind, 'error');
  assert.match(errs(v)[0], /killed by SIGSEGV/);
});

test('skip / todo are neither errors nor failures; subtests: the failing child carries the verdict', () => {
  const s = run('skip');
  assert.equal(s.kind, 'clean');
  assert.equal(s.kind === 'clean' && s.skipped, 2);
  const sub = run('subtests');
  assert.equal(sub.kind, 'clean');
  assert.deepEqual(sub.kind === 'clean' && [sub.pass, sub.assertionFail], [1, 1]);
});

test('classification is by structured fields, never prose: an afterAll error whose MESSAGE says AssertionError is still an ERROR', () => {
  const v = run('mixed');
  assert.equal(v.kind, 'error');
  assert.deepEqual(errs(v).map((e) => e.split(' :: ')[0]), ['suite']);
  assert.equal(v.kind === 'error' && v.assertionFail, 1);
});

test('fail closed: truncated output, no TAP, an empty report, a non-zero exit with all green, exit 0 with a failure', () => {
  const trunc = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: cap('assertfail').split('# tests')[0] });
  assert.equal(trunc.kind, 'unclassified');
  assert.match(trunc.kind === 'unclassified' ? trunc.why : '', /no TAP summary/);
  const spec = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: '✖ failing tests:\n▶ x\n' });
  assert.match(spec.kind === 'unclassified' ? spec.why : '', /no TAP header/);
  // a lost result block: the summary says 3 tests, only 2 are present
  const lost = cap('assertfail').replace(/# Subtest: ok\nok 3 - ok\n {2}---\n {2}duration_ms: .*\n {2}type: 'test'\n {2}\.\.\.\n/, '');
  assert.notEqual(lost, cap('assertfail'));
  const lostV = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: lost });
  assert.match(lostV.kind === 'unclassified' ? lostV.why : `(${lostV.kind})`, /does not match the 2 test result/);
  const green1 = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: cap('pass') });
  assert.equal(green1.kind, 'error');
  assert.match(errs(green1)[0], /exit 1 although every reported test passed/);
  const red0 = classifyRun(FROZEN, { exit: 0, signal: null, timedOut: false, stdout: cap('assertfail') });
  assert.equal(red0.kind, 'unclassified');
  assert.match(red0.kind === 'unclassified' ? red0.why : '', /exit 0 although 2 test/);
});

test('a runner without an adapter, or one that could not start, fails closed with a stated reason', () => {
  assert.equal(adapterFor(['vitest', 'run', 'a.test.ts']), null);
  const v = classifyRun(['vitest', 'run', 'a.test.ts'], { exit: 1, signal: null, timedOut: false, stdout: '{}' });
  assert.equal(v.kind, 'unclassified');
  assert.match(v.kind === 'unclassified' ? v.why : '', /no structured-output adapter for runner "vitest"/);
  const spawn = classifyRun(FROZEN, { exit: null, signal: null, timedOut: false, stdout: '', spawnError: 'ENOENT' });
  assert.equal(spawn.kind, 'unclassified');
});

test('the adapter forces the TAP reporter and drops another one; the refusal text names each error', () => {
  assert.deepEqual(NODE_TEST.argv(['node', '--test', '--test-reporter=spec', '--test-timeout=500', 'a.test.mjs']), ['node', '--test-reporter=tap', '--test', '--test-timeout=500', 'a.test.mjs']);
  const v = run('setuperr');
  assert.ok(v.kind === 'error');
  assert.match(formatErrors(v), /^3 test\(s\) ERRORED[\s\S]*- suite: setup\/teardown hook failed: fixture boom/);
});

test('a big deepStrictEqual diff (node elides lines with an indented `...` INSIDE the error block) is still an assertion FAIL', () => {
  assert.match(cap('bigdiff'), /\n {4}\.\.\.\n/, 'the capture holds the elision line that used to end the diagnostic block early');
  const v = run('bigdiff');
  assert.equal(v.kind, 'clean');
  assert.equal(v.kind === 'clean' && v.assertionFail, 1);
});

test('a todo test may fail on an assertion, but a todo test that THROWS (TypeError) is an ERROR', () => {
  const v = run('todoerr');
  assert.equal(v.kind, 'error');
  assert.match(errs(v)[0], /^todo broken :: TypeError/);
  assert.equal(run('skip').kind, 'clean'); // the todo there fails on an assertion
});

// ── jest: REAL `jest --json --outputFile` captures (jest 30.5.2) ────────────────────────────────────────────
const jcap = (n: string): string => fs.readFileSync(path.join(DIR, `${n}.jest.json`), 'utf8');
const JFROZEN = ['jest', 't/x.test.js'];
const jrun = (n: string, over: Partial<ExecResult> = {}): FreezeVerdict =>
  classifyRun(JFROZEN, { exit: n === 'pass' || n === 'skiptodo' ? 0 : 1, signal: null, timedOut: false, stdout: '', outText: jcap(n), ...over });

test('jest: all-pass is clean; skip/todo are skipped', () => {
  const v = jrun('pass');
  assert.deepEqual(v.kind === 'clean' && [v.pass, v.assertionFail], [2, 0]);
  const s = jrun('skiptodo');
  assert.equal(s.kind, 'clean');
  assert.equal(s.kind === 'clean' && s.skipped, 2);
});

test('jest: an expect() matcher failure is an assertion FAIL (accepted), a big diff too', () => {
  const v = jrun('assertfail');
  assert.equal(v.kind, 'clean');
  assert.deepEqual(v.kind === 'clean' && [v.pass, v.assertionFail], [1, 2]);
  assert.equal(jrun('bigdiff').kind, 'clean');
});

test('jest: hook errors (beforeAll / beforeEach / afterEach) are ERRORs — the test fails WITHOUT a matcherResult', () => {
  for (const n of ['beforeall', 'beforeeach', 'aftereach']) {
    const v = jrun(n);
    assert.equal(v.kind, 'error', n);
    assert.match(errs(v)[0], /not an expect\(\) matcher failure/, n);
  }
  assert.equal(jrun('beforeall').kind === 'error' && (jrun('beforeall') as { errors: unknown[] }).errors.length, 2);
});

test('jest: afterAll error — only the aggregate numRuntimeErrorTestSuites shows it — is an ERROR although every reported test passed or failed on a matcher', () => {
  const v = jrun('afterall');
  assert.equal(v.kind, 'error');
  assert.match(errs(v).join('|'), /1 suite\(s\) failed to run AFTER their tests/);
  assert.equal(v.kind === 'error' && v.assertionFail, 1);
});

test('jest: "Test suite failed to run" (import / syntax error, top-level throw, no test) is an ERROR', () => {
  for (const n of ['importerr', 'syntaxerr', 'toplevelthrow', 'notests']) {
    const v = jrun(n);
    assert.equal(v.kind, 'error', n);
    assert.match(errs(v)[0], /Test suite failed to run/, n);
  }
});

test('jest: a thrown exception, an async throw, a timeout and a node:assert failure are ERRORs (no matcherResult)', () => {
  for (const n of ['typeerr', 'asyncthrow', 'timeout', 'nodeassert']) assert.equal(jrun(n).kind, 'error', n);
  assert.match(errs(jrun('timeout'))[0], /Exceeded timeout of 200 ms/);
});

test('jest: classification is structural, not prose: an Error whose message QUOTES the matcher text is still an ERROR', () => {
  const v = jrun('fakematcher');
  assert.equal(v.kind, 'error');
  assert.match(errs(v)[0], /expect\(received\)\.toBe\(expected\)/); // it is in the report text…
  assert.equal(v.kind === 'error' && v.assertionFail, 0);          // …and did not make it an assertion fail
});

test('jest: fail closed — no results file (a crash: process.exit in a test), truncated JSON, a summary that does not match; wall-clock / signal are ERRORs', () => {
  const crash = classifyRun(JFROZEN, { exit: 3, signal: null, timedOut: false, stdout: '', outText: null });
  assert.equal(crash.kind, 'unclassified');
  assert.match(crash.kind === 'unclassified' ? crash.why : '', /wrote no results file/);
  assert.equal(jrun('assertfail', { outText: jcap('assertfail').slice(0, 300) }).kind, 'unclassified');
  const lost = JSON.parse(jcap('assertfail'));
  lost.testResults[0].assertionResults.pop();
  const lostV = jrun('assertfail', { outText: JSON.stringify(lost) });
  assert.match(lostV.kind === 'unclassified' ? lostV.why : `(${lostV.kind})`, /does not match the 2 test result/);
  assert.equal(jrun('pass', { exit: null, timedOut: true }).kind, 'error');
  assert.equal(jrun('pass', { exit: null, signal: 'SIGKILL' }).kind, 'error');
  const green1 = jrun('pass', { exit: 1 });
  assert.match(errs(green1)[0], /exit 1 although every reported test passed/);
  assert.equal(jrun('assertfail', { exit: 0 }).kind, 'unclassified');
});

test('jest: the adapter forces --json --outputFile, keeps the frozen flags/paths and drops --bail from ITS argv only', () => {
  assert.deepEqual(adapterFor(['jest', '--bail', 'a', 'b'])!.argv(['jest', '--bail', 'a', 'b'], '/o.json'), ['jest', '--json', '--outputFile=/o.json', '--no-watchman', 'a', 'b']);
  assert.deepEqual(adapterFor(['jest', '--ci', 't/a.test.js'])!.argv(['jest', '--ci', 't/a.test.js'], '/o.json'), ['jest', '--json', '--outputFile=/o.json', '--no-watchman', '--ci', 't/a.test.js']);
  assert.equal(adapterFor(['jest', 'a'])!.usesFile, true);
});

// ── Node 18 / 20 / 22: the same scenarios classify the same (18/20 label only SUITES with `type:`) ─────────────
const KIND: Record<string, FreezeVerdict['kind']> = {
  pass: 'clean', assertfail: 'clean', bigdiff: 'clean', skip: 'clean', subtests: 'clean', empty: 'clean',
  setuperr: 'error', beforeeach: 'error', aftererr: 'error', importerr: 'error', syntaxerr: 'error', toplevelthrow: 'error', typeerr: 'error', asyncthrow: 'error',
  crash: 'error', sigkill: 'error', realtimeout: 'error', mixed: 'error', timeout: 'error', todoerr: 'error',
};
const EXIT0 = new Set(['pass', 'skip', 'empty', 'todoerr']);
for (const ver of ['n18', 'n20']) {
  test(`node ${ver.slice(1)} captures: every scenario classifies as on Node 22 (leaf tests carry no type: field)`, () => {
    for (const [n, kind] of Object.entries(KIND)) {
      const out = fs.readFileSync(path.join(DIR, `${n}.${ver}.tap.txt`), 'utf8');
      assert.ok(!/^ *type: 'test'$/m.test(out), `${n}: the capture really has no type: 'test'`);
      const v = classifyRun(FROZEN, { exit: EXIT0.has(n) ? 0 : 1, signal: null, timedOut: false, stdout: out });
      assert.equal(v.kind, kind, `${ver} ${n}: ${v.kind === 'unclassified' ? v.why : ''}`);
    }
    const v = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: fs.readFileSync(path.join(DIR, `assertfail.${ver}.tap.txt`), 'utf8') });
    assert.deepEqual(v.kind === 'clean' && [v.pass, v.assertionFail], [1, 2]);
    const h = classifyRun(FROZEN, { exit: 1, signal: null, timedOut: false, stdout: fs.readFileSync(path.join(DIR, `aftererr.${ver}.tap.txt`), 'utf8') });
    assert.match(errs(h)[0], /^suite :: setup\/teardown hook failed: teardown boom/);
  });
}

// ── jest: failures the expect LIBRARY raises without a matcher (jest 29.7.0 and 30.5.2 captures) ───────────────
for (const suf of ['jest', 'jest29']) {
  const jc = (n: string): string => fs.readFileSync(path.join(DIR, `${n}.${suf}.json`), 'utf8');
  const jr = (n: string): FreezeVerdict => classifyRun(JFROZEN, { exit: 1, signal: null, timedOut: false, stdout: '', outText: jc(n) });
  test(`${suf}: .rejects on a promise that RESOLVES and expect.assertions / hasAssertions failures are assertion FAILs (the canonical "not built yet" red)`, () => {
    for (const n of ['rejects', 'assertions']) {
      const v = jr(n);
      assert.equal(v.kind, 'clean', n);
      assert.equal(v.kind === 'clean' && v.assertionFail, 2, n);
    }
    assert.match(JSON.stringify(JSON.parse(jc('rejects')).testResults[0].assertionResults[0].failureDetails), /^\[\{"message":/, 'the capture has the no-matcherResult shape that used to be an ERROR');
  });
  test(`${suf}: a custom matcher that THROWS and a plain thrown Error stay ERRORs; a matcher failure next to them is still an assertion FAIL`, () => {
    assert.equal(jr('custom').kind, 'error');
    const v = jr('viaframe');
    assert.equal(v.kind, 'error');
    assert.deepEqual(v.kind === 'error' && [v.errors.length, v.assertionFail], [1, 1]);
    assert.match(errs(v)[0], /plain thrown in test/);
  });
  test(`${suf}: .resolves on a promise that REJECTED with a harness error (TypeError) is an ERROR; a real .resolves mismatch next to it stays an assertion FAIL`, () => {
    const v = jr('resolvesrej');
    assert.equal(v.kind, 'error');
    assert.deepEqual(v.kind === 'error' && [v.errors.length, v.assertionFail], [1, 1]);
    assert.match(errs(v)[0], /resolves but the promise rejects/);
  });
  test(`${suf}: the phrase read is anchored to the .resolves header — a legit .rejects RED whose resolved VALUE quotes the phrase stays an assertion FAIL`, () => {
    assert.match(JSON.parse(jc('phrase')).testResults[0].assertionResults[0].failureDetails[0].message, /Resolved to value: "Received promise rejected instead of resolved"/);
    assert.equal(jr('phrase').kind, 'clean');
  });
  test(`${suf}: DOCUMENTED GAP — an expect() failing inside beforeAll reads as an assertion FAIL`, () => {
    assert.equal(jr('beforeallexpect').kind, 'clean');
  });
  test(`${suf}: DOCUMENTED GAP — an expect() failing inside beforeEach carries matcherResult like a test-body failure, so it reads as an assertion FAIL`, () => {
    assert.equal(jr('beforeeachexpect').kind, 'clean');
  });
}

test('isExpectFailure: structure only — `message` alone, or the right frame alone, is not enough', () => {
  const inLib = 'Error: x\n    at expect (/r/node_modules/expect/build/index.js:1:1)\n    at Object.<anonymous> (/r/t/a.test.js:1:1)';
  const inUser = 'Error: x\n    at Object.<anonymous> (/r/t/a.test.js:1:1)';
  assert.equal(isExpectFailure({ matcherResult: {} }, inUser), true);
  assert.equal(isExpectFailure({ message: 'm' }, inLib), true);
  assert.equal(isExpectFailure({ message: 'm' }, 'Error: x\n    at Object.assertions (/r/t/a.test.js:1:1)'), true);
  assert.equal(isExpectFailure({ message: 'm' }, inUser), false);   // node:assert / a user error that grew a `message` key
  assert.equal(isExpectFailure({}, inLib), false);                  // a plain Error serialises to {} — never an expect failure, whatever its frames
  assert.equal(isExpectFailure(null, inLib), false);
});

test('a runner that could not be started (exit 127 / 126 from `timeout`) is unclassified and says it resolves on the inherited PATH', () => {
  for (const exit of [127, 126]) {
    const v = classifyRun(JFROZEN, { exit, signal: null, timedOut: false, stdout: '', outText: null });
    assert.equal(v.kind, 'unclassified');
    assert.match(v.kind === 'unclassified' ? v.why : '', /"jest" could not be started \(exit \d+: not found \/ not executable on the PATH the freeze inherited — the gate resolves it the same way\)/);
  }
});
