#!/usr/bin/env node
// #540 rig — `fanout acceptance amend --harness-only` through the BUILT CLI (dist-electron/cli.js) against a FAKE HOST (the REAL host half, src/shared/fanout-acceptance-host.ts) on a unix
// socket, a scratch bare origin and a fake `gh`. Forced flow: the ticket's tests live on acceptance/rig; the amend publishes there; gate / deliver pick the amended bytes up with no copy.
// Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-harness-amend.mjs            baseline: every arm must PASS (a must-PASS and a must-FAIL arm per clause)
//   node scripts/e2e-fanout-harness-amend.mjs --mutants  each patched copy of the BUILT bundle / of src/shared must be KILLED (≥1 arm FAILs); the baseline is the control
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const SHARED = path.join(ROOT, 'src', 'shared');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const sleepMs = (ms) => Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
const sha = (s) => createHash('sha256').update(s).digest('hex');
/** The frozen test: its body appends HARNESS to a marker beside the scratch root, so "which bytes ran" is observable. */
const SPEC = (tag, setup = '') => [
  "const test = require('node:test');", "const assert = require('node:assert');", "const fs = require('node:fs');", "const path = require('node:path');", "const { f } = require('../src/impl.js');",
  `const HARNESS = '${tag}';`, setup, "test('f is what the spec says', () => {",
  "  fs.appendFileSync(path.join(__dirname, '..', '..', 'marker.txt'), HARNESS + '\\n');",
  '  assert.equal(f(), 1);', "  assert.ok(typeof f === 'function');", '});', ''].join('\n');
const V0 = SPEC('v0'), V1 = SPEC('v1', 'const warm = true; // harness-only: new setup'), V2 = SPEC('v2', 'const warm = true;\nconst cool = false;');
const RB = (n) => `# ruby frozen test\nrequire_relative '../src/impl'\nexpect(f()).to eq(${n})\n`;
const HJS = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('../src/impl.js');\nconst check = assert.strictEqual;\nfunction expectOk(r) { return check(r, 1); }\nconst expectAlso = (r) => check(r, 1);\ntest('h', () => {\n  expectOk(f());\n  expectAlso(f());\n  assert.ok(true);\n});\n";
const HPY = 'import unittest\n\nclass TestH(unittest.TestCase):\n    def test_h(self):\n        self.assertEqual(1, 1)\n';
const SENTENCE = 'f must be a function and return one';
const DECISION = 'https://github.com/o/r/issues/540#issuecomment-900';

const FAKE_GH = `#!${process.execPath}
const fs = require('node:fs'); const { spawnSync } = require('node:child_process');
const S = process.env.FAKE_GH_STATE, BARE = process.env.FAKE_GH_BARE;
const st = JSON.parse(fs.readFileSync(S, 'utf8')); const save = () => fs.writeFileSync(S, JSON.stringify(st));
const git = (...a) => spawnSync('git', ['--git-dir', BARE, ...a], { encoding: 'utf8' });
const tip = (b) => { const r = git('rev-parse', '--verify', 'refs/heads/' + b); return r.status === 0 ? r.stdout.trim() : ''; };
let args = process.argv.slice(2); st.log.push(args.join(' '));
const ri = args.indexOf('--repo'); if (ri >= 0) args.splice(ri, 2);
const val = (f) => args[args.indexOf(f) + 1];
const out = (o) => { save(); process.stdout.write(typeof o === 'string' ? o : JSON.stringify(o)); process.exit(0); };
const fail = (m) => { save(); process.stderr.write(m + '\\n'); process.exit(1); };
const [a, b] = args;
const headOf = (p) => (p.state === 'OPEN' ? tip(p.headRefName) : p.head);
if (a === 'api') {
  const url = args[args.length - 1];
  let m = /^repos\\/o\\/r\\/issues\\/comments\\/(\\d+)$/i.exec(url);
  if (m) { const id = String(Number(m[1])); if (st.comments[id] === undefined) fail('gh: Not Found (HTTP 404)'); out({ body: st.comments[id] }); }
  m = /\\/contents\\/(.+)\\?ref=([0-9a-f]{40})$/.exec(url);
  if (/\\/commits\\/[0-9a-f]{40}$/.test(url)) out({});
  if (m) { const r = git('show', m[2] + ':' + decodeURIComponent(m[1])); if (r.status !== 0) fail('gh: Not Found (HTTP 404)'); out(r.stdout); }
  fail('gh: Not Found (HTTP 404)');
}
if (a === 'pr' && b === 'list') {
  const base = args.includes('--base') ? val('--base') : null, head = val('--head');
  const states = val('--state');
  out(st.prs.filter((p) => p.headRefName === head && (!base || p.base === base) && (states === 'all' || p.state.toLowerCase() === states)).map((p) => ({ number: p.number, url: p.url, state: p.state, baseRefName: p.base, headRefOid: headOf(p) })));
}
if (a === 'pr' && b === 'create') {
  const n = 100 + st.prs.length;
  st.prs.push({ number: n, url: 'https://github.com/o/r/pull/' + n, state: 'OPEN', base: val('--base'), headRefName: val('--head'), head: '' });
  out('https://github.com/o/r/pull/' + n + '\\n');
}
if (a === 'pr' && b === 'view') {
  const p = st.prs.find((x) => String(x.number) === args[2]); if (!p) fail('not found');
  const head = headOf(p); const green = st.ciGreen.includes(head);
  out({ state: p.state, baseRefName: p.base, headRefOid: head, mergeable: 'MERGEABLE', mergeCommit: { oid: head },
    statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: green ? 'COMPLETED' : 'IN_PROGRESS', conclusion: green ? 'SUCCESS' : '', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] });
}
if (a === 'run' && b === 'view') out({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }, { name: 'Complete job', conclusion: 'success' }] }] });
if (a === 'pr' && b === 'merge') {
  const p = st.prs.find((x) => String(x.number) === args[2]);
  const want = args.includes('--match-head-commit') ? val('--match-head-commit') : null;
  const held = tip(p.headRefName);
  if (want !== null && want !== held) fail('Pull request is not mergeable: the head branch was modified. Review and try the merge again.');
  p.state = 'MERGED'; p.head = held; out('');
}
fail('unexpected gh call: ' + args.join(' '));
`;

// The fake host: the REAL dispatchFanoutAcceptance behind a unix socket; spawn/post are recorded to host.log (jsonl).
const HOST_JS = `
import http from 'node:http'; import fs from 'node:fs';
const { dispatchFanoutAcceptance } = await import(process.env.SHARED_DIR + '/fanout-acceptance-host.ts');
const log = (o) => fs.appendFileSync(process.env.HOST_LOG, JSON.stringify(o) + '\\n');
let n = 0;
const deps = { home: process.env.ORCHESTRA_HOME, now: () => new Date().toISOString(), isWorkspace: (id) => id === process.env.RUN_ID, repoPath: () => undefined,
  spawn: async (i) => { n++; log({ kind: 'spawn', ...i }); return { ok: true, id: 'writer-' + n }; },
  post: (i) => { log({ kind: 'post', ...i }); } };
http.createServer((req, res) => { let b = ''; req.on('data', (c) => (b += c)); req.on('end', async () => {
  const out = req.url === '/fanoutAcceptance' ? await dispatchFanoutAcceptance(JSON.parse(b), deps) : {};
  res.setHeader('content-type', 'application/json'); res.end(JSON.stringify(out)); }); }).listen(process.env.SOCK, () => fs.writeFileSync(process.env.READY, '1'));
`;

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

function world(cliPath, sharedDir) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-harness-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), wr = path.join(dir, 'writer'), cand = path.join(dir, 'cand'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const ghState = path.join(dir, 'gh-state.json');
  fs.writeFileSync(ghState, JSON.stringify({ prs: [], ciGreen: [], log: [], comments: { 900: `Ledger decision: ${SENTENCE}.` } }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const gIn = (cwd) => (args, o = {}) => sh('git', args, { cwd, env: gitEnv, ...o }).stdout.trim();
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  for (const d of [wr, cand]) sh('git', ['clone', '-q', bare, d], { env: gitEnv, stdio: 'ignore' });
  const gr = gIn(wr), gc = gIn(cand);
  gr(['checkout', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(wr, 'src')); fs.writeFileSync(path.join(wr, 'src/impl.js'), 'exports.f = () => 0;\n');
  gr(['add', '.']); gr(['commit', '-q', '-m', 'base']); gr(['push', '-q', 'origin', 'master']);
  gc(['fetch', '-q', 'origin']);
  const sock = path.join(dir, 'sock'), ready = path.join(dir, 'ready'), hostLog = path.join(dir, 'host.log');
  fs.writeFileSync(hostLog, '');
  const hostFile = path.join(dir, 'host.mjs'); fs.writeFileSync(hostFile, HOST_JS);
  const hostProc = spawn(process.execPath, ['--experimental-strip-types', '--no-warnings', hostFile], { env: { PATH: process.env.PATH, SHARED_DIR: sharedDir, ORCHESTRA_HOME: home, RUN_ID: 'rig', SOCK: sock, READY: ready, HOST_LOG: hostLog }, stdio: 'ignore' });
  for (let k = 0; k < 100 && !fs.existsSync(ready); k++) sleepMs(100);
  if (!fs.existsSync(ready)) throw new Error('the fake host did not come up');
  const env = (id, extra = {}) => ({ ...gitEnv, PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: id, ORCHESTRA_SOCK: sock, FAKE_GH_STATE: ghState, FAKE_GH_BARE: bare, ...extra });
  const cli = (as, args, cwd = wr, extra = {}) => {
    const r = spawnSync(process.execPath, [cliPath, ...args], { encoding: 'utf8', env: env(as, extra), timeout: 90_000, cwd });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const tk = (id) => readState().tickets[id];
  const hostEvents = () => fs.readFileSync(hostLog, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l));
  const gh = () => JSON.parse(fs.readFileSync(ghState, 'utf8'));
  const patchGh = (fn) => { const s = gh(); fn(s); fs.writeFileSync(ghState, JSON.stringify(s)); };
  const originFile = (ref, file) => { const r = sh('git', ['--git-dir', bare, 'show', `${ref}:${file}`], { allowFail: true }); return r.status === 0 ? r.stdout : null; };
  const marks = () => { try { return fs.readFileSync(path.join(dir, 'marker.txt'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const clearMarks = () => fs.rmSync(path.join(dir, 'marker.txt'), { force: true });
  /** the writer commits `text` as t/spec.test.js on its local branch accept-T-1 (never pushed: the amend publishes) */
  const writerCommit = (file, text, branch = 'accept-T-1') => {
    gr(['checkout', '-q', '-B', branch, 'origin/master']); // each revision is a full commit of the file on a fresh branch off master
    fs.mkdirSync(path.dirname(path.join(wr, file)), { recursive: true }); fs.writeFileSync(path.join(wr, file), text);
    gr(['add', '-A']); gr(['commit', '-q', '-m', `writer ${file}`]);
  };
  /** a candidate branch off master holding `text` as t/spec.test.js (+ the impl), pushed; the checkout stays ON it */
  const candidate = (name, text, extra = {}) => {
    gc(['fetch', '-q', 'origin']); gc(['checkout', '-q', '-f', '-B', name, 'origin/master']);
    fs.mkdirSync(path.join(cand, 't'), { recursive: true }); fs.writeFileSync(path.join(cand, 't/spec.test.js'), text);
    fs.writeFileSync(path.join(cand, 'src/impl.js'), 'exports.f = () => 1;\n');
    gc(['add', '-A']); gc(['commit', '-q', '-m', name]); gc(['push', '-q', '-f', 'origin', name]);
    return { branch: name, head: gc(['rev-parse', 'HEAD']), ...extra };
  };
  const gate = (v) => { gc(['checkout', '-q', '-f', '--detach', v.head]); return gate0(v); };
  const gate0 = (v) => cli('verif-1', ['fanout', 'gate', '--branch', v.branch, '--into', 'master', '--head', v.head, '--ticket', 'T-1', '--run', 'rig', '--cwd', cand], cand);
  const deliver = (v, receipt) => cli('rig', ['fanout', 'deliver', '--branch', v.branch, '--into', 'master', '--ticket', 'T-1', '--run', 'rig', '--no-review-gate', '--verified-head', v.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', ...(receipt ? ['--acceptance', receipt] : [])], cand);
  const receiptFile = (name, r) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(r)); return f; };
  const amend = (extra = [], ticket = 'T-1', files = 't/spec.test.js', from = 'accept-T-1') => cli('rig', ['fanout', 'acceptance', 'amend', ticket, '--run', 'rig', '--harness-only', '--reason', 'composition: boot the shared db first', '--files', files, '--from', from, ...extra], wr);
  return { dir, wr, cand, cli, tk, gh, readState, statePath, hostEvents, patchGh, originFile, marks, clearMarks, writerCommit, candidate, gate, deliver, receiptFile, amend, gc, gr, setCi: (h) => patchGh((s) => s.ciGreen.push(h)), cleanup: () => { hostProc.kill(); fs.rmSync(dir, { recursive: true, force: true }); } };
}

/** Every arm; returns [{name, ok, detail}] for the bundle at `cliPath` and the host half at `sharedDir`. */
function scenarios(cliPath, sharedDir) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 600);
  const W = world(cliPath, sharedDir);
  try {
    // ── setup: register T-1 with a spec (the host spawns its writer), the writer freezes V0 → acceptance/rig
    W.cli('rig', ['fanout', 'state', 'init', '--run', 'rig', '--repo', 'o/r']);
    const reg = W.cli('rig', ['fanout', 'state', 'set', 'T-1', '--run', 'rig', '--spec', 'docs/spec.md#T-1', '--implementer', 'impl-1', '--verifier', 'verif-1']);
    W.writerCommit('t/spec.test.js', V0);
    const fz = W.cli('writer-1', ['fanout', 'acceptance', 'freeze', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js'], W.wr);
    if (reg.code !== 0 || fz.code !== 0) { arm('SETUP register + freeze', false, `${J(reg)} | ${J(fz)}`); return res; }
    const H0 = W.tk('T-1').acceptance.hash;
    const c0 = W.candidate('c-v0', V0); // a candidate that copied the V0 bytes (the documented step), before any amend
    const pre = W.gate(c0);
    const R0 = pre.json?.acceptance?.receipt;
    arm('G0 baseline: the gate on a V0 candidate before any amend passes, receipt for the V0 hash', pre.code === 0 && pre.json?.acceptance?.ok === true && R0?.hash === H0 && W.marks().join() === 'v0', J(pre));
    W.clearMarks();
    const dOld = W.candidate('d-old', V0); // the PR the deliver arms use: gated BEFORE the amend, so its receipt is for the V0 hash AND for this very head
    const pre2 = W.gate(dOld);
    const R0d = pre2.json?.acceptance?.receipt;
    W.clearMarks();

    // ── refused amends (state, branch and bus untouched)
    const tip0 = W.originFile('acceptance/rig', 't/spec.test.js');
    const refusedArm = (label, kind, text, mod) => {
      W.writerCommit('t/spec.test.js', text);
      const r = W.amend(mod);
      arm(label, r.code === 2 && new RegExp(`not a harness-only change \\(${kind}\\)`).test(r.stderr) && W.tk('T-1').acceptance.hash === H0 && W.tk('T-1').acceptance.amendments.length === 0 && W.originFile('acceptance/rig', 't/spec.test.js') === tip0, J(r));
    };
    refusedArm('A2 must-FAIL a MODIFIED assertion argument (f() 1 → 2): exit 2 "modified", state + shared branch untouched', 'modified', V0.replace('assert.equal(f(), 1)', 'assert.equal(f(), 2)'));
    refusedArm('A3a must-FAIL an ADDED assertion: exit 2 "added"', 'added', V0.replace('  assert.equal(f(), 1);', '  assert.equal(f(), 1);\n  assert.ok(true);'));
    refusedArm('A3b must-FAIL a REMOVED assertion: exit 2 "removed"', 'removed', V0.replace("  assert.ok(typeof f === 'function');\n", ''));
    refusedArm('A3c must-FAIL REORDERED assertions: exit 2 "reordered"', 'reordered', V0.replace("  assert.equal(f(), 1);\n  assert.ok(typeof f === 'function');", "  assert.ok(typeof f === 'function');\n  assert.equal(f(), 1);"));
    refusedArm('A4 must-FAIL a test neutralised by .skip (declaration head changed): exit 2', 'modified', V0.replace("test('f is", "test.skip('f is"));
    refusedArm('A4b must-FAIL a RENAMED test: exit 2', 'modified', V0.replace("test('f is what", "test('f is not what"));
    refusedArm('A4c must-FAIL a skip OPTION after the title (`test(title, { skip: true }, fn)`): exit 2', 'modified', V0.replace("test('f is what the spec says', () => {", "test('f is what the spec says', { skip: true }, () => {"));
    refusedArm('A4d must-FAIL an added supertest-shaped assertion (`request(app).get(\'/\').expect(500)` is READ as an assertion): exit 2 "added"', 'added', V0 + "request(app).get('/').expect(500);\n");
    // the measured bypasses of the adversarial review (MAJOR-1): one-line edits that would make every assertion vacuous
    refusedArm('B1 must-FAIL the RUNNER swapped (`const test = () => {}`): exit 2', 'modified', V0.replace("const test = require('node:test');", 'const test = () => {};'));
    refusedArm('B2 must-FAIL the ASSERT import swapped for a fake: exit 2', 'modified', V0.replace("const assert = require('node:assert');", "const assert = require('./fake-assert.js');"));
    refusedArm('B3 must-FAIL a callback PARAMETER shadowing assert (`(assert) =>`): exit 2', 'modified', V0.replace("test('f is what the spec says', () => {", "test('f is what the spec says', (assert) => {"));
    refusedArm('B4 must-FAIL a `return;` first in the test body: exit 2 "added"', 'added', V0.replace("test('f is what the spec says', () => {\n", "test('f is what the spec says', () => {\n  return;\n"));
    refusedArm('B5 must-FAIL `0 && assert…` (short-circuit prefix on the line): exit 2', 'modified', V0.replace('  assert.equal(f(), 1);', '  0 && assert.equal(f(), 1);'));
    refusedArm('B6 must-FAIL the assertion wrapped in try / catch: exit 2', 'modified', V0.replace('  assert.equal(f(), 1);', '  try { assert.equal(f(), 1); } catch {}'));
    refusedArm('B7 must-FAIL the assertion moved into a never-called function: exit 2', 'modified', V0.replace('  assert.equal(f(), 1);', '  function unused() {\n    assert.equal(f(), 1);\n  }'));
    refusedArm('B8 must-FAIL a process-level error swallower (`process.on(…)`): exit 2 "added"', 'added', V0.replace("test('f is what", "process.on('uncaughtException', () => {});\ntest('f is what"));
    refusedArm('B9 must-FAIL the assertion turned into an HTML-style comment (`<!-- …`): exit 2 "removed"', 'removed', V0.replace('  assert.equal(f(), 1);', '  <!-- assert.equal(f(), 1);'));
    W.writerCommit('t/spec.test.js', V1);
    const longReason = W.amend(['--reason', 'x'.repeat(301)]);
    arm('A4e must-FAIL a --reason over 300 chars is refused BEFORE anything is published: exit 2, shared branch untouched, nothing recorded', longReason.code === 2 && /--reason/.test(longReason.stderr) && W.originFile('acceptance/rig', 't/spec.test.js') === tip0 && W.tk('T-1').acceptance.amendments.length === 0, J(longReason));
    for (const [flag, val] of [['--decision', DECISION], ['--spec-sentence', SENTENCE], ['--run-cmd', 'node --test t/spec.test.js']]) {
      const r = W.amend([flag, val]);
      arm(`A5 must-FAIL ${flag} with --harness-only: exit 2 (the other mode's flag), nothing recorded`, r.code === 2 && /cannot go with --harness-only/.test(r.stderr) && W.tk('T-1').acceptance.amendments.length === 0, J(r));
    }
    const noReason = W.cli('rig', ['fanout', 'acceptance', 'amend', 'T-1', '--run', 'rig', '--harness-only', '--files', 't/spec.test.js', '--from', 'accept-T-1'], W.wr);
    arm('A5b must-FAIL no --reason: exit 2, nothing recorded', noReason.code === 2 && /--reason/.test(noReason.stderr) && W.tk('T-1').acceptance.amendments.length === 0, J(noReason));
    const stranger = W.cli('verif-1', ['fanout', 'acceptance', 'amend', 'T-1', '--run', 'rig', '--harness-only', '--reason', 'x', '--files', 't/spec.test.js', '--from', 'accept-T-1'], W.wr);
    arm('A5c must-FAIL a non-coordinator (the verifier) cannot amend: nothing recorded', stranger.code !== 0 && W.tk('T-1').acceptance.amendments.length === 0, J(stranger));
    // a second file in the set
    W.gr(['checkout', '-q', 'accept-T-1']); fs.writeFileSync(path.join(W.wr, 't/other.test.js'), V1); W.gr(['add', '-A']); W.gr(['commit', '-q', '-m', 'other']);
    const more = W.amend([], 'T-1', 't/spec.test.js,t/other.test.js');
    arm('A6 must-FAIL a changed FILE SET (an added test file): exit 2, nothing recorded', more.code === 2 && /SAME file set|keeps the frozen file set/.test(more.stderr) && W.tk('T-1').acceptance.amendments.length === 0, J(more));
    // unknown shape: a ruby frozen test (no extractor) is refused, fail closed
    W.writerCommit('t/spec_test.rb', RB(1), 'accept-T-3');
    const fzRb = W.cli('rig', ['fanout', 'acceptance', 'freeze', 'T-3', '--run', 'rig', '--files', 't/spec_test.rb', '--run-cmd', 'ruby t/spec_test.rb', '--from', 'accept-T-3', '--accept-unclassified', 'rig: no ruby adapter (#539)'], W.wr);
    W.writerCommit('t/spec_test.rb', RB(1) + '# setup tweak\n', 'accept-T-3');
    const rb = W.amend([], 'T-3', 't/spec_test.rb', 'accept-T-3');
    arm('A7 must-FAIL unknown shape (a .rb frozen test: no extractor) fails CLOSED: exit 2, needs the decision amend', fzRb.code === 0 && rb.code === 2 && /unknown-shape/.test(rb.stderr) && W.tk('T-3').acceptance.amendments.length === 0, `${J(fzRb)} | ${J(rb)}`);
    // an assertion-NAMED helper definition / override is pinned in full (re-review MAJOR): gutting it must not pass
    W.writerCommit('t/helper.test.js', HJS, 'accept-T-4');
    W.writerCommit('t/h_test.py', HPY, 'accept-T-5');
    const fz4 = W.cli('rig', ['fanout', 'acceptance', 'freeze', 'T-4', '--run', 'rig', '--files', 't/helper.test.js', '--run-cmd', 'node --test t/helper.test.js', '--from', 'accept-T-4'], W.wr);
    const fz5 = W.cli('rig', ['fanout', 'acceptance', 'freeze', 'T-5', '--run', 'rig', '--files', 't/h_test.py', '--run-cmd', 'python -I -m unittest t/h_test.py', '--from', 'accept-T-5', '--accept-unclassified', 'rig: no unittest adapter (#539)'], W.wr);
    const refusedOther = (label, ticket, file, branch, text) => {
      W.writerCommit(file, text, branch);
      const r = W.amend([], ticket, file, branch);
      arm(label, r.code === 2 && /not a harness-only change \((?:modified|added|removed)\)/.test(r.stderr) && W.tk(ticket).acceptance.amendments.length === 0, J(r));
    };
    arm('HJS setup: the helper-bearing JS and Python tickets freeze', fz4.code === 0 && fz5.code === 0, `${J(fz4)} | ${J(fz5)}`);
    refusedOther('H1 must-FAIL the JS assertion helper `expectOk` body gutted (`{ }`): exit 2', 'T-4', 't/helper.test.js', 'accept-T-4', HJS.replace("{ return check(r, 1); }", '{ }'));
    refusedOther('H2 must-FAIL the arrow helper `const expectAlso = …` gutted (`(r) => {}`): exit 2', 'T-4', 't/helper.test.js', 'accept-T-4', HJS.replace('const expectAlso = (r) => check(r, 1);', 'const expectAlso = (r) => {};'));
    refusedOther('H3 must-FAIL a Python `def assertEqual(self, a, b): pass` override added: exit 2', 'T-5', 't/h_test.py', 'accept-T-5', HPY.replace('    def test_h', '    def assertEqual(self, a, b):\n        pass\n\n    def test_h'));
    refusedOther('H4 must-FAIL `unittest.TestCase.assertEqual = lambda *a: None`: exit 2', 'T-5', 't/h_test.py', 'accept-T-5', HPY + '\nunittest.TestCase.assertEqual = lambda *a: None\n');
    refusedOther('H5 must-FAIL `@unittest.mock.patch.object(unittest.TestCase, \'assertEqual\')` on the test: exit 2', 'T-5', 't/h_test.py', 'accept-T-5', HPY.replace('    def test_h', "    @unittest.mock.patch.object(unittest.TestCase, 'assertEqual')\n    def test_h"));
    W.writerCommit('t/helper.test.js', HJS.replace("function expectOk", "function boot() { return 1; }\nconst expectedStatus = 201;\nfunction expectOk"), 'accept-T-4');
    const h6 = W.amend([], 'T-4', 't/helper.test.js', 'accept-T-4');
    arm('H6 must-PASS a NEW helper with another name (and an `expected…` local) is still a setup-only change: exit 0, recorded', h6.code === 0 && W.tk('T-4').acceptance.amendments.length === 1, J(h6));
    W.writerCommit('t/helper.test.js', HJS.replace("function expectOk", "const expectedStatus = 201;\nfunction boot() { return 1; }\nfunction expectOk"), 'accept-T-4');
    const h7 = W.amend([], 'T-4', 't/helper.test.js', 'accept-T-4');
    arm('H7 must-PASS a reorder-only change says so (not "0 added, 0 removed") and records reorderOnly', h7.code === 0 && /SAME SET/.test(h7.stdout) && W.tk('T-4').acceptance.amendments.at(-1).lines?.reorderOnly === true, J(h7));
    // the unlexable new bytes
    W.writerCommit('t/spec.test.js', V1.replace("'v1'", "'v1"));
    const unl = W.amend();
    arm('A7b must-FAIL unlexable new bytes (unterminated string) fail CLOSED: exit 2 unknown-shape', unl.code === 2 && /unknown-shape/.test(unl.stderr) && W.tk('T-1').acceptance.amendments.length === 0, J(unl));

    // ── the accepted amend (setup-only): recorded, published to acceptance/rig, the implementer + verifier told
    W.writerCommit('t/spec.test.js', V1);
    const a1 = W.amend();
    const acc1 = W.tk('T-1').acceptance;
    const am = acc1.amendments[0];
    const posts = W.hostEvents().filter((e) => e.kind === 'post' && /HARNESS-ONLY/.test(e.body));
    arm('A1 must-PASS a setup-only change: exit 0; recorded {kind:harness-only, assertionsHash, reason, filesBefore=V0}; hash + files follow; published to acceptance/rig',
      a1.code === 0 && acc1.amendments.length === 1 && am.kind === 'harness-only' && /^[0-9a-f]{64}$/.test(am.assertionsHash) && am.reason === 'composition: boot the shared db first' && am.filesBefore['t/spec.test.js'] === sha(V0)
      && am.lines && am.lines.added >= 1 && /WHAT YOU ATTEST/.test(a1.stdout) && /\+ t\/spec\.test\.js: const warm = true;/.test(a1.stdout)
      && am.hashBefore === H0 && am.hashAfter === acc1.hash && acc1.hash !== H0 && acc1.files['t/spec.test.js'] === sha(V1) && acc1.source.branch === 'acceptance/rig' && W.originFile('acceptance/rig', 't/spec.test.js') === V1, `${J(a1)} ${JSON.stringify(acc1).slice(0, 400)}`);
    arm('A1b must-PASS the host posts a bus status to the implementer AND the verifier (no copy needed, re-gate named)',
      posts.length === 2 && posts.map((p) => p.to).sort().join() === 'impl-1,verif-1' && posts.every((p) => /NOTHING to copy/.test(p.body) && /t\/spec\.test\.js/.test(p.body) && /composition: boot the shared db first/.test(p.body)), JSON.stringify(W.hostEvents().slice(-3)).slice(0, 500));

    // ── gate pickup
    const g1 = W.gate(c0);
    const bytes = fs.readFileSync(path.join(W.cand, 't/spec.test.js'), 'utf8');
    const dirty = sh('git', ['status', '--porcelain', '--untracked-files=no'], { cwd: W.cand }).stdout.trim();
    arm('G1 must-PASS a candidate still holding the PREVIOUS (V0) bytes passes with NO copy: file status previous, amendedFrom named, receipt for the CURRENT hash',
      g1.code === 0 && g1.json?.acceptance?.ok === true && g1.json.acceptance.files?.[0]?.status === 'previous' && g1.json.acceptance.amendedFrom?.files?.[0] === 't/spec.test.js' && g1.json.acceptance.receipt?.hash === acc1.hash && g1.json.acceptance.receipt?.head === c0.head, J(g1));
    arm('G1b must-PASS the AMENDED bytes are the ones that ran (marker v1, not the candidate\'s v0)', W.marks().join() === 'v1', `marks=${W.marks()}`);
    arm('G1c must-PASS the candidate checkout is restored afterwards (its own V0 bytes, clean tree)', bytes === V0 && dirty === '', `restored=${bytes === V0} dirty=${JSON.stringify(dirty)}`);
    W.clearMarks();
    const cur = W.candidate('c-v1', V1);
    const g2 = W.gate(cur);
    arm('G2 must-PASS a candidate holding the CURRENT bytes: status same, no amendedFrom (unchanged path), ran v1', g2.code === 0 && g2.json?.acceptance?.files?.[0]?.status === 'same' && !('amendedFrom' in (g2.json.acceptance ?? {})) && W.marks().join() === 'v1', J(g2));
    W.clearMarks();
    const evil = W.candidate('c-evil', V0.replace('const HARNESS', 'const EXTRA = 1;\nconst HARNESS'));
    const g3 = W.gate(evil);
    arm('G3 must-FAIL a candidate with ARBITRARY edited bytes (none of the recorded versions): exit 2 frozen-test-changed, nothing ran', g3.code === 2 && g3.json?.reason === 'frozen-test-changed' && g3.json.acceptance?.files?.[0]?.status === 'changed' && W.marks().length === 0, J(g3));
    const evil2 = W.candidate('c-weak', V0.replace('assert.equal(f(), 1)', 'assert.ok(true)'));
    const g3b = W.gate(evil2);
    arm('G3b must-FAIL a candidate holding a WEAKENED old-looking test (assertion edited): exit 2 frozen-test-changed', g3b.code === 2 && g3b.json?.reason === 'frozen-test-changed' && W.marks().length === 0, J(g3b));
    // the recorded source no longer holds the amended bytes (a hand-edited state points at the V0 commit): the overlay is refused, never "the candidate's bytes will do"
    const st0 = fs.readFileSync(W.statePath, 'utf8');
    const v0commit = W.gc(['rev-list', '--max-parents=0', 'origin/acceptance/rig']).split('\n')[0] || '';
    const tampered = JSON.parse(st0); tampered.tickets['T-1'].acceptance.source.head = v0commit;
    fs.writeFileSync(W.statePath, JSON.stringify(tampered));
    W.gate(c0); // (the checkout is at c0 again below)
    W.clearMarks();
    const g4 = W.gate(c0);
    arm('G4 must-FAIL the shared source does not hold the recorded amended bytes (hash mismatch): exit 2 acceptance-unproven, nothing ran', g4.code === 2 && g4.json?.reason === 'acceptance-unproven' && W.marks().length === 0, J(g4));
    tampered.tickets['T-1'].acceptance.source.head = 'd'.repeat(40);
    fs.writeFileSync(W.statePath, JSON.stringify(tampered));
    const g5 = W.gate(c0);
    arm('G5 must-FAIL the amended source cannot be fetched at all: exit 2 acceptance-unproven, never a pass on the candidate\'s old bytes', g5.code === 2 && g5.json?.reason === 'acceptance-unproven' && W.marks().length === 0, J(g5));
    fs.writeFileSync(W.statePath, st0);

    // ── deliver
    W.setCi(dOld.head);
    const stale = W.deliver(dOld, W.receiptFile('old', R0d));
    arm('D2 must-FAIL the receipt gated BEFORE the amend, for THIS head (hash of V0) is acceptance-stale, no merge', pre2.code === 0 && R0d?.head === dOld.head && stale.code === 2 && stale.json?.reason === 'acceptance-stale' && W.gh().log.filter((l) => l.startsWith('pr merge')).length === 0, J(stale));
    const gd = W.gate(dOld);
    const fresh = W.deliver(dOld, W.receiptFile('fresh', gd.json?.acceptance?.receipt));
    arm('D1 must-PASS a PR head still holding the previous bytes + a receipt gated after the amend ⇒ merged, acceptanceChecked, no copy', gd.code === 0 && fresh.code === 0 && fresh.json?.verdict === 'merged' && fresh.json?.acceptanceChecked === true, `${J(gd)} | ${J(fresh)}`);
    const dEvil = W.candidate('d-evil', V0.replace('const HARNESS', 'const EXTRA = 1;\nconst HARNESS')); W.setCi(dEvil.head);
    const forged = W.deliver(dEvil, W.receiptFile('forged', { ...(gd.json?.acceptance?.receipt ?? {}), head: dEvil.head, tree: undefined }));
    arm('D3 must-FAIL arbitrary bytes at the PR head behind a forged-valid receipt: exit 2 frozen-test-changed (the independent gh byte re-read), no merge', forged.code === 2 && forged.json?.reason === 'frozen-test-changed', J(forged));

    // ── the chain: a second harness amend keeps V0 and V1 candidates alive; a decision amend cuts the chain
    // publish-then-state-write: a state write that fails AFTER the push must not wedge the shared path (the pushed bytes are rolled back)
    const tipV1 = W.originFile('acceptance/rig', 't/spec.test.js'), hashV1 = W.tk('T-1').acceptance.hash;
    W.writerCommit('t/spec.test.js', V2.replace('const cool = false;', 'const cool = true;'));
    const stDir = path.dirname(W.statePath);
    fs.chmodSync(stDir, 0o555);
    const failed = W.amend();
    fs.chmodSync(stDir, 0o755);
    arm('R1 must-FAIL a state write that fails after the push: exit ≠ 0, nothing recorded, the shared branch holds the RECORDED bytes again', failed.code !== 0 && W.tk('T-1').acceptance.hash === hashV1 && W.originFile('acceptance/rig', 't/spec.test.js') === tipV1, J(failed));
    W.writerCommit('t/spec.test.js', V2);
    const a2 = W.amend();
    arm('R2 must-PASS the retry with DIFFERENT bytes after that failure is not wedged (no "already on the branch with other bytes")', a2.code === 0 && W.originFile('acceptance/rig', 't/spec.test.js') === V2, J(a2));
    W.clearMarks();
    const g6 = W.gate(c0);
    arm('C1 must-PASS two harness-only amends: the V0 candidate still passes (chain v0→v1→v2), the V2 bytes ran', a2.code === 0 && g6.code === 0 && g6.json?.acceptance?.files?.[0]?.status === 'previous' && W.marks().join() === 'v2', `${J(a2)} | ${J(g6)}`);
    const g6b = W.gate(cur);
    arm('C1b must-PASS the V1 candidate passes as well', g6b.code === 0 && g6b.json?.acceptance?.files?.[0]?.status === 'previous', J(g6b));
    W.writerCommit('t/spec.test.js', V2.replace('assert.equal(f(), 1);', 'assert.equal(f(), 1);\n  assert.ok(f);'));
    const dec = W.cli('rig', ['fanout', 'acceptance', 'amend', 'T-1', '--run', 'rig', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'accept-T-1'], W.wr);
    const g7 = W.gate(c0), g7b = W.gate(cur);
    arm('C2 must-FAIL after a DECISION amend (the assertions changed) the chain is cut: V0 and V1 candidates ⇒ frozen-test-changed (they must re-copy)', dec.code === 0 && g7.code === 2 && g7.json?.reason === 'frozen-test-changed' && g7b.code === 2 && g7b.json?.reason === 'frozen-test-changed', `${J(dec)} | ${J(g7)} | ${J(g7b)}`);

  } finally { W.cleanup(); }
  return res;
}

async function run(title, cliPath, sharedDir) {
  const res = scenarios(cliPath, sharedDir);
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// Each mutant breaks ONE new clause (in the BUILT bundle, or in a scratch copy of src/shared for the host half); the anchor must occur exactly once. `extra` = a second edit of the same mutant.
// NOT mutated here (equivalent in verdict): `unreadAssertion`, the last-resort backstop — every assertion-shaped call inside a statement is READ as an assertion first (A:), so no input reaches it; pinned by the unit test only.
const BUNDLE_MUTANTS = [
  { name: 'comparator ignores the arguments (only the call name is compared)', find: 'const same = x.length === y.length && x.every((s, k) => s === y[k]);', put: () => 'const same = x.length === y.length && x.every((s, k) => s.split("(")[0] === y[k].split("(")[0]);' },
  { name: 'comparator ignores the ORDER of the statements', find: 'const same = x.length === y.length && x.every((s, k) => s === y[k]);', put: () => 'const same = x.length === y.length && [...x].sort().join("\\0") === [...y].sort().join("\\0");' },
  { name: 'comparator ignores test declarations (a .skip / renamed test passes)', find: 'out.push(`D:${normalise(src, cls, i, end)}`);', put: () => 'void 0;' },
  { name: 'unknown shape is NOT fail-closed (an unknown file is read as JS)', find: 'const family = familyOf(path2);', put: () => 'const family = familyOf(path2) ?? "js";' },
  { name: 'a changed file set is accepted (both guards off)', find: 'if (po.join("\\0") !== pn.join("\\0"))', put: () => 'if (false)', extra: [{ find: 'if (Object.keys(a.files).sort().join("\\0") !== Object.keys(acc.files).sort().join("\\0"))', put: () => 'if (false)' }] },
  { name: 'the amend is not recorded (files / hash stay the old ones)', find: '    files: a.files,\n    hash: hashAfter,\n    source: a.source,\n    amendments: [...acc.amendments, { kind: "harness-only"', put: () => '    files: acc.files,\n    hash: acc.hash,\n    source: acc.source,\n    amendments: [...acc.amendments, { kind: "harness-only"' },
  { name: 'the amended bytes are not published to the shared branch', find: 'const source = forced ? publishFrozen(deps.runner, next, {', put: () => 'const source = false ? publishFrozen(deps.runner, next, {' },
  { name: 'publish refuses to replace the ticket\'s own recorded bytes', find: 'if (there && there !== blob && o.replace?.[p] !== void 0 &&', put: () => 'if (false &&' },
  { name: 'runner / assert imports and bindings are not pinned (import / const / assignment pins all off)', find: 'function pinnedBinding(raw) {', put: () => 'function pinnedBinding(raw) {\n  return false;', extra: [{ find: '(?:(?:globalThis|global|window|self)\\\\.)?(?:${RUNNER_NAMES})', put: () => '(?!)' }] },
  { name: 'the declaration callback\'s parameters are not pinned', find: 'out.push(`D:cb:${m ? m[0].trim() : t}`);', put: () => 'void m;' },
  { name: 'return / throw / break / continue in a test body are not pinned', find: 'if (c2.inTest) {', put: () => 'if (false) {' },
  { name: 'the same-line control prefix (0 && , if (false)) is dropped', find: '  let pre = normalise(src, cls, from, i);', put: () => '  let pre = ""; void from;' },
  { name: 'the enclosing non-test blocks (function unused() {, try {) are dropped', find: 'return { chain: heads.slice(last + 1).join(" > "), inTest:', put: () => 'return { chain: "", inTest:' },
  { name: 'statements that CALL an assertion-shaped name (supertest .expect, try-wrapped) are not read', find: 'if (stmtStart(src, cls, i)) {', put: () => 'if (false) {' },
  { name: '`<!--` is not a comment (an HTML-commented assertion stays a statement)', find: 'if (c2 === "<" && src.startsWith("<!--", i)) {', put: () => 'if (false) {' },
  { name: 'process.on(…) is not a neutraliser', find: '"process\\\\.on\\\\s*\\\\("', put: () => '"(?!)"' },
  { name: 'no rollback when the state write fails after the push', find: 'if (forced && source.head !== acc.source.head) {', put: () => 'if (false) {' },
  { name: 'the changed-line count is not recorded', find: 'lines: { added: diff.added, removed: diff.removed,', put: () => 'lines: void 0 && { added: diff.added, removed: diff.removed,' },
  { name: 'an assertion-NAMED JS function definition is not pinned (gutted helper passes)', find: '|| DEF_NAME_RE.test(fn[1]) : true)', put: () => ': true)', },
  { name: 'an assertion-NAMED const/let/var definition is not pinned', find: 'RUNNER_NAME_RE.test(names) || DEF_TOKEN_RE.test(names) ||', put: () => 'RUNNER_NAME_RE.test(names) ||' },
  { name: 'a Python assertion-NAMED def block is not pinned', find: 'if (defName) {', put: () => 'if (false) {' },
  { name: 'Python assertion patching (`X.assertY = …` / mock.patch of assert*) is not pinned', find: 'if (patching) {', put: () => 'if (false) {' },
  { name: 'a reorder-only change is not reported (reads "0 added, 0 removed")', find: 'reorderOnly: differs && added === 0 && removed === 0', put: () => 'reorderOnly: false' },
  { name: 'a non-coordinator may amend harness-only (CLI-level coordinator check off)', find: 'if (caller !== r.run) throw new Refusal(`${ticket}: only the run\'s coordinator', put: () => 'if (false) throw new Refusal(`${ticket}: only the run\'s coordinator' },
  { name: 'declaration options + callback parameters after the title are not compared (skip option accepted)', find: 'if (src[end] === ",") for (const x of declExtras(src, cls, end)) out.push(x);', put: () => 'void 0;' },
  { name: '--reason is validated only AFTER the bytes are published', find: 'if (reason.length > 300 || /[\\r\\n\\0]/.test(reason)) throw new Refusal("--reason must be one short line', put: () => 'if (false) throw new Refusal("--reason must be one short line' },
  { name: 'the --decision / --spec-sentence / --run-cmd flags are accepted with --harness-only', find: 'if (p.vals[f] !== void 0) throw new Refusal(`${f} cannot go with --harness-only', put: () => 'if (false) throw new Refusal(`${f} cannot go with --harness-only' },
  { name: 'gate: a candidate holding the previous recorded bytes is refused (stale version wrongly refused)', find: 'sha === headSha && acceptable[p]?.has(sha) ? "previous" : "changed"', put: () => '"changed"' },
  { name: 'gate: ANY bytes agreeing with the candidate\'s HEAD blob are accepted as a previous version (arbitrary edit wrongly accepted)', find: 'sha === headSha && acceptable[p]?.has(sha) ? "previous" : "changed"', put: () => 'sha === headSha ? "previous" : "changed"' },
  { name: 'gate: the candidate\'s OWN bytes are run (the amended bytes are not laid over them)', find: '          io.writeFile(path.join(root, f), b);\n        }\n        const r = io.run(', put: () => '        }\n        const r = io.run(' },
  { name: 'gate: the candidate checkout is not restored after the run', find: 'for (const [f, b] of kept) io.writeFile(path.join(root, f), b);', put: () => 'void kept;' },
  { name: 'gate: the amended bytes are not hash-proven against the recorded set', find: 'sha256Hex(Buffer.from(b.stdout, "utf8")) !== acc.files[f.path]', put: () => 'false' },
  { name: 'gate: an unobtainable / unproven amended source does not stop the run', find: 'if (prev.length && facts.overlayError)', put: () => 'if (false)' },
  { name: 'chain: a decision amend does not cut the accepted versions', find: 'if (m.kind !== "harness-only") break;', put: () => 'if (m.kind !== "harness-only") continue;' },
  { name: 'deliver re-read: the previous recorded version is refused as an edit', find: 'got !== null && (got === want || acceptable[p]?.has(got)) ? "same" : "changed"', put: () => 'got !== null && got === want ? "same" : "changed"' },
  { name: 'deliver re-read: ANY bytes are accepted at the PR head', find: 'got !== null && (got === want || acceptable[p]?.has(got)) ? "same" : "changed"', put: () => '"same"' },
  { name: 'deliver: a receipt for another (older) frozen set is accepted', find: 'receipt.hash !== acc.hash', put: () => 'false' },
];
const HOST_MUTANTS = [
  { name: 'host: the harness-only amend posts no status to the implementer / verifier', file: 'fanout-acceptance-host.ts', find: 'const to = frozenRecipients(t, writer).filter((id) => !retro || retro.includes(id));', put: () => "const to = input.op === 'amended' ? [] : frozenRecipients(t, writer).filter((id) => !retro || retro.includes(id));" },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('harness-only')) { console.error('dist-electron/cli.js has no `amend --harness-only` — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = await run('baseline (built bundle + src/shared)', CLI, SHARED);
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-harness-mut-'));
const only = process.env.MUT_ONLY?.split(',');
for (const [i, m] of BUNDLE_MUTANTS.entries()) {
  if (only && !only.includes(`b${i}`)) continue;
  let src = orig;
  for (const step of [m, ...(m.extra ?? [])]) {
    const n = src.split(step.find).length - 1;
    if (n !== 1) { console.error(`MUTANT b${i} "${m.name}": anchor found ${n}× (needs exactly 1) — the bundle shape changed, fix the rig`); process.exit(1); }
    src = src.replace(step.find, () => step.put(step.find));
  }
  const file = path.join(scratch, `mutant-b${i}.js`);
  fs.writeFileSync(file, src);
  const bad = await run(`MUTANT b${i}: ${m.name}`, file, SHARED);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
for (const [i, m] of HOST_MUTANTS.entries()) {
  if (only && !only.includes(`h${i}`)) continue;
  const dst = path.join(scratch, `shared-h${i}`);
  fs.cpSync(SHARED, dst, { recursive: true, filter: (s) => !/\.test\.ts$/.test(s) });
  const f = path.join(dst, m.file);
  const text = fs.readFileSync(f, 'utf8');
  const n = text.split(m.find).length - 1;
  if (n !== 1) { console.error(`MUTANT h${i} "${m.name}": anchor found ${n}× in ${m.file} (needs exactly 1)`); process.exit(1); }
  fs.writeFileSync(f, text.replace(m.find, () => m.put()));
  const bad = await run(`MUTANT h${i}: ${m.name}`, CLI, dst);
  console.log(bad > 0 ? `   → KILLED (${bad} arm(s) red)` : '   → SURVIVED (no arm noticed it)');
  if (bad === 0) survived++;
}
fs.rmSync(scratch, { recursive: true, force: true });
if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
console.log(`\n${BUNDLE_MUTANTS.length + HOST_MUTANTS.length - survived}/${BUNDLE_MUTANTS.length + HOST_MUTANTS.length} mutants killed; real bundle byte-identical`);
process.exit(survived ? 1 : 0);
