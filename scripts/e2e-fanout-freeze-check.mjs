#!/usr/bin/env node
// #539 rig — `orchestra fanout acceptance freeze` runs the frozen tests ONCE on the target tip and refuses an ERROR, through the BUILT CLI (dist-electron/cli.js) with the REAL
// `node --test` runner against a scratch bare origin + writer clone. Light: no Electron, no network, no tokens, scratch under $TMPDIR. A few arms put a stub `node` first on PATH
// to feed the classifier output no real runner emits (truncated / inconsistent TAP) — a test double for "unclassifiable", never for a verdict on real output.
//   node scripts/e2e-fanout-freeze-check.mjs            baseline: every arm must PASS
//   node scripts/e2e-fanout-freeze-check.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawnSync } from 'node:child_process';
import { EXIT_SURVIVED, exitAfterFlush, runMutantChildren } from './lib/mutant-pool.mjs';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const T = "const test = require('node:test'); const assert = require('node:assert');\n";
const HOOK = (kind, body) => `const { describe, it, ${kind} } = require('node:test'); const assert = require('node:assert');\ndescribe('s', () => { ${kind}(() => { ${body} }); it('a', () => { assert.equal(1, 2); }); });\n`;
/** name → { body, run? }: the shapes of the incident classes (the same as src/shared/fanout-freeze-captures/). */
const SCENARIOS = {
  assertfail: { body: `${T}const { f } = require('../src/impl.js');\ntest('f is 1', () => { assert.equal(f(), 1); });\n` },
  bigdiff: { body: `${T}const a = Array.from({ length: 40 }, (_, i) => i); const b = a.slice(); b[30] = 'x';\ntest('big array', () => { assert.deepStrictEqual(a, b); });\n` },
  setuperr: { body: HOOK('before', "throw new Error('fixture boom');") },
  teardownprose: { body: HOOK('after', "throw new Error('AssertionError: ERR_ASSERTION says the teardown');") },
  importerr: { body: `${T}const { g } = require('../src/missing-module.js');\ntest('x', () => { assert.ok(g); });\n` },
  helper: { body: `${T}const { h } = require('./helper.js');\ntest('x', () => { assert.ok(h); });\n` },
  typeerr: { body: `${T}test('x', () => { throw new TypeError('AssertionError-looking message, ERR_ASSERTION'); });\n` },
  hang: { body: `${T}const fs = require('node:fs');\ntest('spins', () => new Promise(() => { fs.writeFileSync(process.env.PIDFILE, String(process.pid)); setInterval(() => {}, 1000); }));\n` },
  stale: { body: `${T}const { f } = require('../src/impl.js');\ntest('f is 1', () => { assert.equal(f(), 1); });\n` },
  noadapter: { body: `${T}test('x', () => {});\n`, run: 'pytest t/noadapter.test.js' },
  stub: { body: `${T}test('x', () => {});\n` },
  jassert: { body: `${T}test('x', () => {});\n`, run: 'jest t/jassert.test.js' },
  jhook: { body: `${T}test('x', () => {});\n`, run: 'jest t/jhook.test.js' },
  jafter: { body: `${T}test('x', () => {});\n`, run: 'jest t/jafter.test.js' },
  jimport: { body: `${T}test('x', () => {});\n`, run: 'jest t/jimport.test.js' },
  jfake: { body: `${T}test('x', () => {});\n`, run: 'jest t/jfake.test.js' },
  jcrash: { body: `${T}test('x', () => {});\n`, run: 'jest t/jcrash.test.js' },
  jlost: { body: `${T}test('x', () => {});\n`, run: 'jest t/jlost.test.js' },
  stubnode20: { body: `${T}test('x', () => {});\n` },
  stubnode20b: { body: `${T}test('x', () => {});\n` },
  rjrejects: { body: "test('rejects but the promise resolves', async () => { await expect(Promise.resolve(1)).rejects.toThrow(); });\n", run: 'jest t/rjrejects.test.js' },
  rjassertions: { body: "test('expect.assertions(2) with one', () => { expect.assertions(2); expect(1).toBe(1); });\n", run: 'jest t/rjassertions.test.js' },
  rjbail: { body: "test('a', () => { expect(1).toBe(2); });\ntest('b', () => { expect(1).toBe(3); });\n", run: 'jest --bail t/rjbail.test.js' },
  rjhook: { body: "describe('s', () => { beforeAll(() => { throw new Error('fixture boom'); }); test('a', () => { expect(1).toBe(2); }); });\n", run: 'jest t/rjhook.test.js' },
  rjnodeassert: { body: "const assert = require('node:assert');\ntest('node:assert is not an expect failure', () => { assert.strictEqual(1, 2); });\n", run: 'jest t/rjnodeassert.test.js' },
  rjpath: { body: "test('a', () => { expect(1).toBe(2); });\n", run: 'jest t/rjpath.test.js' },
  rjresolves: { body: "const helper = null;\ntest('resolves but the promise rejects with a harness TypeError', async () => { await expect((async () => helper.nope())()).resolves.toBe(1); });\n", run: 'jest t/rjresolves.test.js' },
  rjphrase: { body: "test('a legit RED: .rejects on a resolved promise whose VALUE quotes the jest phrase', async () => { await expect(Promise.resolve('Received promise rejected instead of resolved')).rejects.toThrow(); });\n", run: 'jest t/rjphrase.test.js' },
  rjconfig: { body: "test('a', () => { expect(1).toBe(2); });\n", run: 'jest --config jest.config.js t/rjconfig.test.js' },
  rjbail2: { body: "test('a', () => { expect(1).toBe(2); });\n", second: "test('b', () => { expect(1).toBe(3); });\n", run: 'jest --bail t/rjbail2.test.js t/rjbail2-2.test.js' },
  stubfile: { body: `${T}test('x', () => {});\n` },
};
/** A REAL jest (30.5.2), installed once into a cache dir under $TMPDIR (needs the network the first time); null = it could not be installed (the real-jest arms then FAIL, never skip). */
function realJest() {
  const dir = path.join(tmpBase, 'orchestra-freeze-rig-jest');
  const bin = path.join(dir, 'node_modules', '.bin');
  if (!fs.existsSync(path.join(bin, 'jest'))) {
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'package.json'), '{"name":"freeze-rig-jest","version":"1.0.0","private":true}');
    const r = spawnSync('npm', ['i', '--no-audit', '--no-fund', '--silent', 'jest@30.5.2'], { cwd: dir, encoding: 'utf8', timeout: 280_000 });
    if (r.status !== 0 || !fs.existsSync(path.join(bin, 'jest'))) return null;
  }
  return { dir, bin, nodeModules: path.join(dir, 'node_modules') };
}
const CAPS = path.join(ROOT, 'src', 'shared', 'fanout-freeze-captures');
/** A `jest` that runs nothing: it writes a REAL jest 30 capture (src/shared/fanout-freeze-captures/<name>.jest.json) to its --outputFile — and exits 2 unless it was asked for `--json` + `--outputFile=`. */
const JEST_SHIM = `#!${process.execPath}\nconst fs = require('node:fs');\nconst a = process.argv.slice(2);\nconst o = a.find((x) => x.startsWith('--outputFile='));\nif (!a.includes('--json') || !o) { console.error('jest shim: --json and --outputFile= are required'); process.exit(2); }\nif (process.env.JEST_FIXTURE) {\n  let t = fs.readFileSync(process.env.JEST_FIXTURE, 'utf8');\n  if (process.env.JEST_DROP) { const d = JSON.parse(t); d.testResults[0].assertionResults.pop(); t = JSON.stringify(d); }\n  fs.writeFileSync(o.slice('--outputFile='.length), t);\n}\nprocess.exit(Number(process.env.JEST_EXIT ?? 1));\n`;
const tap = (n, summary = { tests: n, pass: n, fail: 0, cancelled: 0 }) => `TAP version 13\n${Array.from({ length: n }, (_, i) => `# Subtest: t${i}\nok ${i + 1} - t${i}\n  ---\n  duration_ms: 1\n  type: 'test'\n  ...\n`).join('')}1..${n}\n${summary ? `# tests ${summary.tests}\n# suites 0\n# pass ${summary.pass}\n# fail ${summary.fail}\n# cancelled ${summary.cancelled}\n# skipped 0\n# todo 0\n# duration_ms 5\n` : ''}`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function world(cliPath, jest) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'freeze-check-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), home = path.join(dir, 'home'), shim = path.join(dir, 'shim');
  for (const d of [home, shim]) fs.mkdirSync(d);
  const jshim = path.join(dir, 'jshim'); fs.mkdirSync(jshim); fs.writeFileSync(path.join(jshim, 'jest'), JEST_SHIM, { mode: 0o755 });
  fs.writeFileSync(path.join(shim, 'node'), '#!/bin/sh\ncat "$SHIM_OUT"\nexit "${SHIM_EXIT:-1}"\n', { mode: 0o755 });
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const g = (cwd) => (...a) => sh('git', a, { cwd, env: gitEnv }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv });
  const gw = g(work);
  gw('checkout', '-q', '-b', 'master');
  fs.mkdirSync(path.join(work, 'src')); fs.writeFileSync(path.join(work, 'src/impl.js'), 'exports.f = () => 0;\n'); fs.writeFileSync(path.join(work, 'jest.config.js'), 'module.exports = {};\n'); fs.writeFileSync(path.join(work, 'package.json'), '{"name":"rig","version":"1.0.0"}\n');
  gw('add', '.'); gw('commit', '-q', '-m', 'base'); gw('push', '-q', 'origin', 'master');
  for (const [name, s] of Object.entries(SCENARIOS)) {
    gw('checkout', '-q', '-b', `w-${name}`, 'master');
    fs.mkdirSync(path.join(work, 't'), { recursive: true });
    fs.writeFileSync(path.join(work, `t/${name}.test.js`), s.body);
    if (s.second) fs.writeFileSync(path.join(work, `t/${name}-2.test.js`), s.second);
    fs.writeFileSync(path.join(work, 't/helper.js'), 'exports.h = 1;\n'); // committed on the writer's branch, never frozen
    gw('add', '.'); gw('commit', '-q', '-m', name); gw('push', '-q', 'origin', `w-${name}`); gw('checkout', '-q', 'master');
  }
  gw('checkout', '-q', 'w-assertfail'); // the writer's checkout stays on a branch that carries t/helper.js
  if (jest) fs.symlinkSync(jest.nodeModules, path.join(work, 'node_modules'), 'dir'); // the writer repo's top-level node_modules (untracked): the freeze check links it into its scratch
  const env = { PATH: process.env.PATH, TMPDIR: tmpBase, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', GIT_CONFIG_GLOBAL: '/dev/null', ...gitEnv };
  const cli = (args, envExtra = {}) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env: { ...env, ...envExtra }, timeout: 120_000, cwd: work });
    return { code: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r', '--switch', 'acceptance=on,minorPolicy=spec']);
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  for (const name of Object.keys(SCENARIOS)) cli(['state', 'set', `T-${name}`, '--run', 'rig', '--status', 'todo']);
  const patchTicket = (name, fn) => { const s = readState(); fn(s.tickets[`T-${name}`]); fs.writeFileSync(statePath, JSON.stringify(s)); };
  const freeze = (name, extra = [], envExtra = {}) => cli(['acceptance', 'freeze', `T-${name}`, '--run', 'rig', '--files', [`t/${name}.test.js`, ...(SCENARIOS[name].second ? [`t/${name}-2.test.js`] : [])].join(','), '--run-cmd', SCENARIOS[name].run ?? `node --test t/${name}.test.js`, '--from', `w-${name}`, ...extra], envExtra);
  const pubBranch = () => sh('git', ['ls-remote', '--heads', bare, 'refs/heads/acceptance/rig'], { env: gitEnv }).stdout.trim();
  return { dir, work, bare, shim, jshim, cli, freeze, readState, patchTicket, pubBranch, gw, gitEnv, ticket: (n) => readState().tickets[`T-${n}`], cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `exit=${r.code} stdout=${JSON.stringify(r.stdout.slice(0, 500))} stderr=${JSON.stringify(r.stderr.slice(0, 700))}`;
  const JEST = realJest();
  const W = world(cliPath, JEST);
  try {
    // 1 — an assertion FAIL on the target tip is accepted, and the check is recorded
    const a = W.freeze('assertfail');
    const fc = W.ticket('assertfail').acceptance?.freezeCheck;
    arm('A1 must-PASS an assertion FAIL (the behaviour is not built) freezes: exit 0, freezeCheck {clean, assertionFail:1, target master}', a.code === 0 && fc?.result === 'clean' && fc.assertionFail === 1 && fc.pass === 0 && fc.target === 'master' && /freeze check: on master@[0-9a-f]{12}: 0 pass, 1 assertion-fail/.test(a.stdout), `${J(a)} fc=${JSON.stringify(fc)}`);
    const bd = W.freeze('bigdiff');
    arm('A1c must-PASS a big deepStrictEqual diff (an indented `...` line inside the error block) is still an assertion FAIL: freezes', bd.code === 0 && W.ticket('bigdiff').acceptance?.freezeCheck?.assertionFail === 1, J(bd));
    const sh1 = W.cli(['acceptance', 'show', 'T-assertfail', '--run', 'rig']);
    arm('A1b must-PASS `show` prints the recorded freeze check', /freeze check: on master@[0-9a-f]{12}: 0 pass, 1 assertion-fail/.test(sh1.stdout), J(sh1));

    // 2 — a setup ERROR is refused (exit 2), named, and NOTHING is published or recorded (the ticket has a spec: the forced flow would publish)
    W.patchTicket('setuperr', (t) => { t.spec = 'spec.md'; });
    const b = W.freeze('setuperr');
    arm('A2 must-FAIL a before-hook ERROR: exit 2, the suite + its error named, nothing recorded, nothing published to acceptance/<run>', b.code === 2 && /^refused: freeze check on master@/.test(b.stderr) && /s: setup\/teardown hook failed: fixture boom/.test(b.stderr) && /nothing was published or recorded/.test(b.stderr) && !W.ticket('setuperr').acceptance && W.pubBranch() === '', J(b));

    // 3 — prose is not the classifier: a teardown ERROR whose MESSAGE says AssertionError, next to a real assertion failure
    const c = W.freeze('teardownprose');
    arm('A3 must-FAIL an afterAll ERROR is refused although the output also holds a real assertion failure and the words AssertionError / ERR_ASSERTION', c.code === 2 && /s: setup\/teardown hook failed: AssertionError: ERR_ASSERTION says the teardown/.test(c.stderr) && !W.ticket('teardownprose').acceptance, J(c));
    const d = W.freeze('typeerr');
    arm('A3b must-FAIL a non-assertion exception (TypeError) whose message says AssertionError / ERR_ASSERTION is an ERROR', d.code === 2 && /TypeError/.test(d.stderr) && !W.ticket('typeerr').acceptance, J(d));

    // 4 — a file that does not load
    const e = W.freeze('importerr');
    arm('A4 must-FAIL an import error (the file never loads): exit 2, the file process exit named', e.code === 2 && /importerr\.test\.js: the test file's process ended with exit 1 \(load failure/.test(e.stderr) && !W.ticket('importerr').acceptance, J(e));

    // 5 — a timeout, and the hung process is gone afterwards (the whole process group was killed)
    const pidFile = path.join(W.dir, 'hang.pid');
    const h = W.freeze('hang', [], { ORCHESTRA_FREEZE_CHECK_TIMEOUT_MS: '2000', PIDFILE: pidFile });
    let alive = true;
    try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 0); } catch { alive = false; }
    if (alive) { try { process.kill(Number(fs.readFileSync(pidFile, 'utf8')), 'SIGKILL'); } catch { /* gone */ } } // a mutant that leaves it running must not leave it behind
    arm('A5 must-FAIL a timeout: exit 2 "timeout", nothing recorded', h.code === 2 && /timeout/.test(h.stderr) && !W.ticket('hang').acceptance, J(h));
    arm('A5b must-PASS the hung test process (a grandchild of the runner) is gone after the freeze', fs.existsSync(pidFile) && !alive, `pidfile=${fs.existsSync(pidFile)} alive=${alive}`);

    // 6 — the tip is fetched fresh: origin/master moved after the writer cloned
    const other = path.join(W.dir, 'other');
    sh('git', ['clone', '-q', W.bare, other], { env: W.gitEnv });
    fs.writeFileSync(path.join(other, 'src/impl.js'), "throw new Error('target tip broke at load');\n");
    sh('git', ['commit', '-q', '-am', 'tip moves'], { cwd: other, env: W.gitEnv }); sh('git', ['push', '-q', 'origin', 'master'], { cwd: other, env: W.gitEnv });
    const newTip = sh('git', ['rev-parse', 'HEAD'], { cwd: other, env: W.gitEnv }).stdout.trim();
    const f = W.freeze('stale');
    arm('A6 must-FAIL the CURRENT origin tip is what runs (the writer clone is behind it): refused, names the new tip', f.code === 2 && f.stderr.includes(`master@${newTip.slice(0, 12)}`) && !W.ticket('stale').acceptance, J(f));

    // 7 — a CLEAN checkout of the target, not the writer's tree (t/helper.js is on the writer's branch only)
    const hp = W.freeze('helper');
    arm('A7 must-FAIL a helper that exists only in the writer\'s tree is not there: load failure, refused', hp.code === 2 && /helper\.test\.js: the test file's process ended with exit 1 \(load failure/.test(hp.stderr) && !W.ticket('helper').acceptance, J(hp));

    // 8 — unclassifiable: fail closed, the coordinator's recorded escape
    const na = W.freeze('noadapter');
    arm('A8 must-FAIL a runner without an adapter fails closed with the reason + names the escape', na.code === 2 && /cannot be classified — no structured-output adapter for runner "pytest" \(supported: node --test, jest\)/.test(na.stderr) && /--accept-unclassified/.test(na.stderr) && !W.ticket('noadapter').acceptance, J(na));
    W.patchTicket('noadapter', (t) => { t.accept = { acceptor: { id: 'w1', name: 'accept-T', at: '2026-11-22T10:00:00.000Z' }, wait: null, waived: null }; });
    const wr = W.freeze('noadapter', ['--accept-unclassified', 'no adapter yet'], { ORCHESTRA_WS_ID: 'w1' });
    arm('A9 must-FAIL the escape is the coordinator\'s alone: the ticket\'s writer is refused, nothing recorded', wr.code === 2 && /coordinator's alone/.test(wr.stderr) && !W.ticket('noadapter').acceptance, J(wr));
    const co = W.freeze('noadapter', ['--accept-unclassified', 'no adapter yet; checked by hand']);
    const esc = W.ticket('noadapter').acceptance?.freezeCheck;
    arm('A10 must-PASS the coordinator\'s escape freezes and is RECORDED {result:escaped, by, reason, unclassified}', co.code === 0 && esc?.result === 'escaped' && esc.escape?.by === 'rig' && esc.escape?.reason === 'no adapter yet; checked by hand' && /no structured-output adapter/.test(esc.escape?.unclassified ?? ''), `${J(co)} fc=${JSON.stringify(esc)}`);
    const lift = W.freeze('setuperr', ['--accept-unclassified', 'let it through']);
    arm('A11 must-FAIL an escape never lifts a CLASSIFIED error', lift.code === 2 && /ERRORED/.test(lift.stderr) && !W.ticket('setuperr').acceptance, J(lift));

    // 9 — output no real runner emits, through the stub `node` first on PATH
    const stub = (out, exit) => { const f = path.join(W.dir, `stub-${Math.random().toString(36).slice(2)}.out`); fs.writeFileSync(f, out); return { PATH: `${W.shim}:${process.env.PATH}`, SHIM_OUT: f, SHIM_EXIT: String(exit) }; };
    const s1 = W.freeze('stub', [], stub(tap(1, null), 1));
    arm('A12 must-FAIL truncated TAP (no summary, no timeout): unclassifiable, fail closed — not a verdict', s1.code === 2 && /cannot be classified — no TAP summary/.test(s1.stderr) && !W.ticket('stub').acceptance, J(s1));
    const s2 = W.freeze('stub', [], stub(tap(2), 1));
    arm('A13 must-FAIL exit 1 although every reported test passed: an ERROR (a failure outside the tests)', s2.code === 2 && /exit 1 although every reported test passed/.test(s2.stderr) && !W.ticket('stub').acceptance, J(s2));
    const s3 = W.freeze('stub', [], stub(tap(2, { tests: 3, pass: 3, fail: 0, cancelled: 0 }), 0));
    arm('A14 must-FAIL a summary that does not match the parsed results (a lost block): unclassifiable', s3.code === 2 && /does not match the 2 test result/.test(s3.stderr) && !W.ticket('stub').acceptance, J(s3));
    const s4 = W.freeze('stubfile', [], stub(tap(2), 0));
    arm('A15 must-PASS a consistent all-green report with exit 0 freezes (the stub path is not just refusing)', s4.code === 0 && W.ticket('stubfile').acceptance?.freezeCheck?.result === 'clean', J(s4));

    // 10 — jest: REAL captures through a stub `jest` (the rig must stay light: no npm install); the stub insists on the forced --json --outputFile
    const jest = (name, fixture, exit, extra = {}) => W.freeze(name, [], { PATH: `${W.jshim}:${process.env.PATH}`, ...(fixture ? { JEST_FIXTURE: path.join(CAPS, `${fixture}.jest.json`) } : {}), JEST_EXIT: String(exit), ...extra });
    const j1 = jest('jassert', 'assertfail', 1);
    const jfc = W.ticket('jassert').acceptance?.freezeCheck;
    arm('J1 must-PASS jest: expect() matcher failures freeze (1 pass, 2 assertion-fail), the check recorded — the forced --json --outputFile reached jest', j1.code === 0 && jfc?.result === 'clean' && jfc.assertionFail === 2 && jfc.pass === 1, `${J(j1)} fc=${JSON.stringify(jfc)}`);
    const j2 = jest('jhook', 'beforeall', 1);
    arm('J2 must-FAIL jest: a beforeAll error (tests fail WITHOUT matcherResult) is refused, named', j2.code === 2 && /not an expect\(\) matcher failure/.test(j2.stderr) && /fixture boom/.test(j2.stderr) && !W.ticket('jhook').acceptance, J(j2));
    const j3 = jest('jafter', 'afterall', 1);
    arm('J3 must-FAIL jest: an afterAll error (only numRuntimeErrorTestSuites shows it) is refused', j3.code === 2 && /failed to run AFTER their tests/.test(j3.stderr) && !W.ticket('jafter').acceptance, J(j3));
    const j4 = jest('jimport', 'importerr', 1);
    arm('J4 must-FAIL jest: "Test suite failed to run" (import error) is refused', j4.code === 2 && /Test suite failed to run/.test(j4.stderr) && !W.ticket('jimport').acceptance, J(j4));
    const j5 = jest('jfake', 'fakematcher', 1);
    arm('J5 must-FAIL jest: an Error whose MESSAGE quotes expect(received) is an ERROR (structure, not prose)', j5.code === 2 && /not an expect\(\) matcher failure/.test(j5.stderr) && !W.ticket('jfake').acceptance, J(j5));
    const j6 = jest('jcrash', null, 3);
    arm('J6 must-FAIL jest: no results file (a crash) is unclassifiable, fail closed', j6.code === 2 && /cannot be classified — jest wrote no results file/.test(j6.stderr) && !W.ticket('jcrash').acceptance, J(j6));
    const j7 = jest('jlost', 'assertfail', 1, { JEST_DROP: '1' });
    arm('J7 must-FAIL jest: a results file whose counts do not match its tests (a lost entry) is unclassifiable', j7.code === 2 && /does not match the 2 test result/.test(j7.stderr) && !W.ticket('jlost').acceptance, J(j7));

    const s5 = W.freeze('stubnode20', [], stub(fs.readFileSync(path.join(CAPS, 'assertfail.n20.tap.txt'), 'utf8'), 1));
    arm('A16 must-PASS Node 20 TAP (leaf tests carry no type: field; real capture through the stub node) classifies: 1 pass, 2 assertion-fail, freezes', s5.code === 0 && W.ticket('stubnode20').acceptance?.freezeCheck?.assertionFail === 2, J(s5));
    const s6 = W.freeze('stubnode20b', [], stub(fs.readFileSync(path.join(CAPS, 'setuperr.n20.tap.txt'), 'utf8'), 1));
    arm('A17 must-FAIL Node 20 TAP of a before-hook error is refused as an ERROR (not "unclassified")', s6.code === 2 && /ERRORED/.test(s6.stderr) && /fixture boom/.test(s6.stderr), J(s6));
    const stale = W.cli(['acceptance', 'show', 'T-stubnode20', '--run', 'rig']);
    arm('A18 must-PASS show prints the freeze check without STALE before any amendment', /freeze check: on master/.test(stale.stdout) && !/STALE/.test(stale.stdout), J(stale));
    W.patchTicket('stubnode20', (t) => { t.acceptance?.amendments.push({ at: '2026-11-22T10:00:00.000Z', decision: 'https://github.com/o/r/issues/1#issuecomment-1', specSentence: 'a sentence long enough', bodySha256: 'a'.repeat(64), hashBefore: 'b'.repeat(64), hashAfter: t.acceptance.hash }); });
    const stale2 = W.cli(['acceptance', 'show', 'T-stubnode20', '--run', 'rig']);
    arm('A19 must-FAIL show does not present the check as covering amended tests: STALE after an amendment', /freeze check: on master.*STALE: 1 amendment\(s\) since/.test(stale2.stdout), J(stale2));

    // 11 — REAL jest (cache install): the expect-library failures, --bail with a piped stdout, hooks, node:assert, and PATH resolution identical to the gate's
    const rj = (name, extra = []) => W.freeze(name, extra, { PATH: `${JEST?.bin ?? '/nonexistent'}:${process.env.PATH}` });
    arm('R0 must-PASS real jest 30.5.2 is available for the real-jest arms (npm install into $TMPDIR/orchestra-freeze-rig-jest on first use)', !!JEST, 'jest could not be installed — the real-jest arms below fail rather than skip');
    const r1 = rj('rjrejects'); const r1c = W.ticket('rjrejects').acceptance?.freezeCheck;
    arm('R1 must-PASS REAL jest: `.rejects.toThrow()` on a promise that RESOLVES (the canonical "validation not built yet" red) is an assertion FAIL: freezes', r1.code === 0 && r1c?.assertionFail === 1, `${J(r1)} fc=${JSON.stringify(r1c)}`);
    const r2 = rj('rjassertions'); const r2c = W.ticket('rjassertions').acceptance?.freezeCheck;
    arm('R2 must-PASS REAL jest: expect.assertions(2) with one assertion is an assertion FAIL: freezes', r2.code === 0 && r2c?.assertionFail === 1, `${J(r2)} fc=${JSON.stringify(r2c)}`);
    const r3 = rj('rjbail'); const r3c = W.ticket('rjbail').acceptance?.freezeCheck;
    arm('R3 must-PASS REAL jest: a frozen `--bail` command (one file) freezes with assertion fails', r3.code === 0 && r3c?.assertionFail >= 1, `${J(r3)} fc=${JSON.stringify(r3c)}`);
    const r4 = rj('rjhook');
    arm('R4 must-FAIL REAL jest: a beforeAll error is refused, named', r4.code === 2 && /not an expect\(\) matcher failure/.test(r4.stderr) && /fixture boom/.test(r4.stderr) && !W.ticket('rjhook').acceptance, J(r4));
    const r5 = rj('rjnodeassert');
    arm('R5 must-FAIL REAL jest: a node:assert failure (shape {message}, frame in the test file) is NOT an expect failure: refused', r5.code === 2 && /not an expect\(\) matcher failure/.test(r5.stderr) && !W.ticket('rjnodeassert').acceptance, J(r5));
    const r6 = W.freeze('rjpath');
    arm('R6 must-FAIL the runner is resolved on the PATH the freeze INHERITS, as the gate does: jest only in the repo node_modules/.bin is "could not be started", not silently found', r6.code === 2 && /"jest" could not be started \(exit 127/.test(r6.stderr) && !W.ticket('rjpath').acceptance, J(r6));

    const r9 = rj('rjphrase');
    arm('R9 must-PASS REAL jest: a legit .rejects RED whose resolved VALUE quotes the "rejected instead of resolved" phrase is still an assertion FAIL (the phrase read is anchored)', r9.code === 0 && W.ticket('rjphrase').acceptance?.freezeCheck?.assertionFail === 1, J(r9));
    const r10 = rj('rjconfig'); const r10t = W.ticket('rjconfig').acceptance;
    arm('R10 must-PASS REAL jest + #542: `jest --config <tracked file>` runs through the freeze check (the config is in the scratch, --config reaches jest) and freezes, config recorded', r10.code === 0 && r10t?.config?.path === 'jest.config.js' && r10t?.freezeCheck?.assertionFail === 1, `${J(r10)} acc=${JSON.stringify(r10t)?.slice(0, 400)}`);
    const r7 = rj('rjresolves');
    arm('R7 must-FAIL REAL jest: .resolves on a promise that REJECTED with a harness TypeError is an ERROR (not an assertion FAIL)', r7.code === 2 && /not an expect\(\) matcher failure/.test(r7.stderr) && /rjresolves\.test\.js › resolves but the promise rejects/.test(r7.stderr) && !W.ticket('rjresolves').acceptance, J(r7));
    const r8 = rj('rjbail2'); const r8c = W.ticket('rjbail2').acceptance?.freezeCheck;
    arm('R8 must-PASS REAL jest --bail with TWO test files, the first failing, still writes its results: freezes (the frozen command keeps --bail)', r8.code === 0 && r8c?.assertionFail >= 1 && /--bail/.test(W.ticket('rjbail2').acceptance?.run ?? ''), `${J(r8)} fc=${JSON.stringify(r8c)}`);

    const help = W.cli(['acceptance', '--help']);
    arm('H1 must-PASS `acceptance --help` documents the freeze check, its refusals and the escape', /freeze check \(#539\)/.test(help.stdout) && /ERROR = REFUSED/.test(help.stdout) && /--accept-unclassified/.test(help.stdout), J(help));
  } finally { W.cleanup(); }
  return res;
}

function report(title, res) {
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// Each mutant breaks ONE clause in the BUILT bundle; every anchor must occur exactly once. Not mutated: `cancelledByParent ⇒ ERROR` (always accompanied by its cause — a hook,
// crash or timeout — which is itself an ERROR, so removing it changes no verdict).
const mutants = [
  { name: 'ERROR class not refused (the check runs, the verdict is ignored)', find: 'if (chk.verdict.kind === "error") throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'an assertion FAIL wrongly refused', find: 'if (type === "test" && isAssertion(e.fields)) {', put: () => 'if (false) {' },
  { name: 'hook (setup/teardown) failures ignored', find: 'if (ft === "subtestsFailed" && failedBelow(e)) return;', put: () => 'if (ft === "subtestsFailed" && failedBelow(e)) return;\n    if (ft === "hookFailed") return;' },
  { name: 'a non-assertion exception counts as an assertion fail', find: 'const isAssertion = (f) =>', put: () => 'const isAssertion = (f) => true || ' },
  { name: 'classification by PROSE: any ERR_ASSERTION / AssertionError in the output ⇒ no error', find: 'const errors = tests.filter((t) => t.kind === "error");', put: () => 'const errors = /ERR_ASSERTION|AssertionError/.test(r.stdout) ? [] : tests.filter((t) => t.kind === "error");' },
  { name: 'classification by PROSE: the assertion test is the error MESSAGE', find: 'const isAssertion = (f) =>', put: () => 'const isAssertion = (f) => /AssertionError|ERR_ASSERTION/.test(f.error ?? "") || ' },
  { name: 'the diagnostic block ends at ANY `...` line (a big assertion diff is cut before its code field)', find: 'while (j < lines.length && lines[j] !== end) block.push(lines[j++]);', put: () => 'while (j < lines.length && lines[j].trim() !== "...") block.push(lines[j++]);' },
  { name: 'jest: any failing test is an assertion fail (no matcherResult needed)', find: 'const matcher = det.length > 0 && det.every(', put: () => 'const matcher = true || det.length > 0 && det.every(' },
  { name: 'jest: classification by PROSE (the failure message quotes expect(received))', find: 'const matcher = det.length > 0 && det.every((x, i) => isExpectFailure(x, stacks[i] ?? ""));', put: () => 'const matcher = /expect\\(received\\)/.test(String(t.failureMessages));' },
  { name: 'jest: an afterAll failure (aggregate numRuntimeErrorTestSuites) ignored', find: 'if (late > 0) {', put: () => 'if (false) {' },
  { name: 'jest: "Test suite failed to run" files ignored', find: 'if (f.status === "failed" && tests.length === 0) {', put: () => 'if (false) {' },
  { name: 'jest: the summary counts are not cross-checked', find: 'if (seen.total !== num$1(d, "numTotalTests") || seen.passed !== num$1(d, "numPassedTests") || seen.failed !== num$1(d, "numFailedTests") || seen.pending !== num$1(d, "numPendingTests") || seen.todo !== num$1(d, "numTodoTests")) {', put: () => 'if (false) {' },
  { name: 'jest: --json is not forced', find: '["jest", "--json", `--outputFile=${outFile}`', put: () => '["jest", `--outputFile=${outFile}`' },
  { name: 'jest: the results file is never read', find: 'res.outText = fs.existsSync(outFile) ? fs.readFileSync(outFile, "utf8") : null;', put: () => 'res.outText = null;' },
  { name: 'Node 18/20 TAP: a leaf result without `type:` is not a test (unclassified)', find: 'const type = e.fields.type ?? (Object.keys(e.fields).length > 0 ? "test" : void 0);', put: () => 'const type = e.fields.type;' },
  { name: 'show presents a freeze check as current after an amendment (no STALE)', find: '${a.amendments.length ?', put: () => '${false ?' },
  { name: 'jest: the expect library\'s own failures (no matcherResult: .rejects / expect.assertions) are ERRORs again', find: 'if (!("message" in detail)) return false;', put: () => 'return false;' },
  { name: 'jest: any {message} error (node:assert, a user error) counts as an expect failure — no frame check', find: 'return !!first && (', put: () => 'return true || !!first && (' },
  { name: 'freeze: the scratch node_modules/.bin is prepended to PATH (freezes with a runner every gate answers 127)', find: 'delete env.NODE_TEST_CONTEXT;\n    const secs', put: () => 'delete env.NODE_TEST_CONTEXT;\n    env.PATH = cwd + "/node_modules/.bin:" + env.PATH;\n    const secs' },
  { name: 'a runner that never started (exit 127) is not reported as such', find: 'if (r.exit === 127 || r.exit === 126) return', put: () => 'if (false) return' },
  { name: 'jest: .resolves on a REJECTED promise (a harness error) counts as an expect failure', find: 'if (typeof m === "string" && RESOLVES_REJECTED.test(m)) return false;', put: () => '' },
  { name: 'jest: the phrase read is unanchored (includes): a .rejects RED whose VALUE quotes the phrase becomes an ERROR', find: 'RESOLVES_REJECTED.test(m)', put: () => 'm.includes(REJECTED_INSTEAD_OF_RESOLVED)' },
  { name: 'jest: --bail stays in the freeze check\'s own jest argv (2+ files: no results file)', find: '...frozen.slice(1).filter((t) => t !== "--bail")', put: () => '...frozen.slice(1)' },
  { name: 'a file that does not load (process exit) ignored', find: 'const fileProc = "exitCode" in e.fields || "signal" in e.fields;', put: () => 'const fileProc = "exitCode" in e.fields || "signal" in e.fields;\n    if (fileProc) return;' },
  { name: 'the wall-clock timeout is not an ERROR', find: 'if (r.timedOut) return procError(', put: () => 'if (false) return procError(' },
  { name: 'the runner is killed alone on timeout (no process-group kill: the hung grandchild survives)', find: 'spawnSync("timeout", ["--kill-after=10"', put: () => 'spawnSync("timeout-not-installed", ["--kill-after=10"' },
  { name: 'the target tip is not fetched (the writer clone\'s stale origin ref is used)', find: 'const f = git(["fetch", "--quiet", "origin", `refs/heads/${o.target}`]);', put: () => 'const f = { code: 0, stdout: "", stderr: "" };', extra: [{ find: '"FETCH_HEAD^{commit}"', put: () => '"refs/remotes/origin/" + o.target + "^{commit}"' }] },
  { name: 'the run happens in the WRITER\'s tree, not a clean checkout', find: 'o.io.exec(adapter.argv(frozenArgv, outFile), dir, o.timeoutMs)', put: () => 'o.io.exec(adapter.argv(frozenArgv, outFile), o.repo, o.timeoutMs)' },
  { name: 'unclassifiable output accepted', find: 'if (chk.verdict.kind === "unclassified" && !escape) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'every runner is treated as node --test (no fail-closed for a runner without an adapter)', find: 'return argv[0] === "node" ? NODE_TEST : argv[0] === "jest" ? JEST : null;', put: () => 'return NODE_TEST;' },
  { name: 'the escape is open to the test writer', find: 'if (caller !== r.run) throw new Refusal(`--accept-unclassified', put: () => 'if (false) throw new Refusal(`--accept-unclassified' },
  { name: 'the escape lifts a classified ERROR', find: 'if (chk.verdict.kind === "error") throw new Refusal(', put: () => 'if (chk.verdict.kind === "error" && !escape) throw new Refusal(' },
  { name: 'the escape is not recorded in the ticket', find: 'now: deps.now(), freezeCheck });', put: () => 'now: deps.now() });' },
  { name: 'a non-zero exit with every reported test green is accepted', find: 'if (r.exit !== 0 && assertionFail === 0)', put: () => 'if (false)' },
  { name: 'the TAP summary is not required (truncated output classified from what is there)', find: 'if (summary[k] === void 0) throw new Unclassifiable(', put: () => 'if (false) throw new Unclassifiable(' },
  { name: 'the summary counts are not cross-checked (a lost block passes)', find: 'if (leaves !== tests || okLeaves !== pass || notOkLeaves !== fail2) {', put: () => 'if (false) {' },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('accept-unclassified')) { console.error('dist-electron/cli.js has no freeze check — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const CHILD = process.env.MUT_CHILD; // #623: set by the parent — run this ONE mutant only (baseline + anchors were checked by the parent)
const baselineBad = CHILD !== undefined ? 0 : report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

if (CHILD === undefined) { // #623: the mutants run in parallel, each in its own child process (own scratch + own temp dirs); output printed in mutant order
  const ids = mutants.map((_, i) => i).filter((i) => !process.env.MUT_ONLY || process.env.MUT_ONLY.split(',').includes(String(i)));
  const { survived, broken } = await runMutantChildren(ids);
  if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
  console.log(`\n${mutants.length - survived - broken}/${mutants.length} mutants killed; real bundle byte-identical`);
  exitAfterFlush(survived || broken ? 1 : 0);
}
let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'freeze-check-mut-'));
for (const [i, m] of mutants.entries()) {
  if (String(i) !== CHILD) continue; // iterate on a few: MUT_ONLY=3,4
  let src = orig;
  for (const step of [m, ...(m.extra ?? [])]) {
    const n = src.split(step.find).length - 1;
    if (n !== 1) { console.error(`MUTANT ${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
    src = src.replace(step.find, () => step.put(step.find));
  }
  const file = path.join(scratch, `mutant-${i}.js`);
  fs.writeFileSync(file, src);
  if (src === orig) { console.error(`MUTANT ${i} did not change the bundle`); process.exit(1); }
  const bad = report(`MUTANT ${i}: ${m.name}`, scenarios(file));
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
fs.rmSync(scratch, { recursive: true, force: true });
process.exit(survived ? EXIT_SURVIVED : 0);
