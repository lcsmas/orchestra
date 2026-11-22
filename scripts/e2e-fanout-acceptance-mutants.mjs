#!/usr/bin/env node
// #510 rig — frozen acceptance tests through the BUILT CLI (dist-electron/cli.js) against a scratch BARE repo + a fake `gh` (a script on PATH that reads
// file bytes / branch tips from the bare repo, keeps PRs + CI + the ledger decision comment in a json file). Light: no Electron, no network, no tokens, scratch under $TMPDIR.
//   node scripts/e2e-fanout-acceptance-mutants.mjs            baseline: every arm must PASS (one must-PASS and one must-FAIL arm per clause)
//   node scripts/e2e-fanout-acceptance-mutants.mjs --mutants  each patched copy of the BUILT bundle must be KILLED (≥1 arm FAILs); the baseline is the control
// The role-guard clause (freeze|amend denied to every non-coordinator role) has its own mutant arm in src/shared/role-guard.test.ts.
import { spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
const tmpBase = process.env.TMPDIR || os.tmpdir();
const SPEC = [
  "const test = require('node:test');", "const assert = require('node:assert');", "const fs = require('node:fs');", "const path = require('node:path');", "const { f } = require('../src/impl.js');",
  "test('f is what the spec says', () => {",
  "  let comm = 'unknown'; // the command line of the process that started `node --test` (a shell, if the gate used one)",
  "  try { const st = fs.readFileSync('/proc/' + process.ppid + '/stat', 'utf8'); const gp = st.slice(st.lastIndexOf(')') + 2).split(' ')[1]; comm = fs.readFileSync('/proc/' + gp + '/comm', 'utf8').trim(); } catch (e) { /* not linux */ }",
  "  fs.writeFileSync(path.join(__dirname, '..', '..', 'test-ran.comm'), comm);",
  "  assert.equal(f(), 1);",
  "});", ''].join('\n');
const SENTENCE = 'the carrier argument is optional in the spec';
const DECISION = 'https://github.com/o/r/issues/511#issuecomment-900';

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

function sh(cmd, args, opts = {}) {
  const r = spawnSync(cmd, args, { encoding: 'utf8', ...opts });
  if (r.status !== 0 && !opts.allowFail) throw new Error(`${cmd} ${args.join(' ')} failed: ${r.stderr}`);
  return r;
}

/** One scratch world: bare origin, the coordinator's work clone, the candidate checkout, the fake gh, a state with T-1 frozen. */
function world(cliPath, o = {}) {
  const dir = fs.mkdtempSync(path.join(tmpBase, 'fanout-accept-rig-'));
  if (!path.resolve(dir).startsWith(path.resolve(tmpBase) + path.sep)) throw new Error(`refusing scratch outside ${tmpBase}`);
  const bare = path.join(dir, 'origin.git'), work = path.join(dir, 'work'), cand = path.join(dir, 'cand'), bin = path.join(dir, 'bin'), home = path.join(dir, 'home');
  for (const d of [bin, home]) fs.mkdirSync(d);
  fs.writeFileSync(path.join(bin, 'gh'), FAKE_GH, { mode: 0o755 });
  const state = path.join(dir, 'gh-state.json');
  fs.writeFileSync(state, JSON.stringify({ prs: [], ciGreen: [], log: [], comments: { 900: `Decision (ledger): ${SENTENCE}.` } }));
  const gitEnv = { GIT_AUTHOR_NAME: 'rig', GIT_AUTHOR_EMAIL: 'rig@x', GIT_COMMITTER_NAME: 'rig', GIT_COMMITTER_EMAIL: 'rig@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null', HOME: home, PATH: process.env.PATH };
  const gIn = (cwd) => (args) => sh('git', args, { cwd, env: gitEnv }).stdout.trim();
  const gw = gIn(work), gc = gIn(cand);
  sh('git', ['init', '-q', '--bare', '-b', 'master', bare], { env: gitEnv });
  sh('git', ['clone', '-q', bare, work], { env: gitEnv });
  gw(['checkout', '-q', '-b', 'master']);
  fs.mkdirSync(path.join(work, 'src')); fs.writeFileSync(path.join(work, 'src/impl.js'), 'exports.f = () => 0;\n');
  gw(['add', '.']); gw(['commit', '-q', '-m', 'base']); gw(['push', '-q', 'origin', 'master']);
  gw(['checkout', '-q', '-b', 'writer-510']);
  fs.mkdirSync(path.join(work, 't')); fs.writeFileSync(path.join(work, 't/spec.test.js'), SPEC);
  gw(['add', '.']); gw(['commit', '-q', '-m', 'writer: acceptance tests']); gw(['push', '-q', 'origin', 'writer-510']); gw(['checkout', '-q', 'master']);
  sh('git', ['clone', '-q', bare, cand], { env: gitEnv });
  gc(['checkout', '-q', '-b', 'good', 'origin/master']);
  gc(['checkout', 'origin/writer-510', '--', 't/spec.test.js']); // the documented implementer step
  fs.writeFileSync(path.join(cand, 'src/impl.js'), 'exports.f = () => 1;\n');
  gc(['add', '.']); gc(['commit', '-q', '-m', 'impl + tests copied unchanged']); gc(['push', '-q', 'origin', 'good']); gw(['fetch', '-q', 'origin']);
  const good = gc(['rev-parse', 'HEAD']);
  /** A branch off `good` with one more commit (the arm's change), pushed to origin; the checkout stays ON it. Returns {branch, head}. */
  const variant = (name, change) => {
    gc(['checkout', '-q', '-B', name, good]);
    change(cand, gc);
    gc(['add', '-A']); gc(['commit', '-q', '--allow-empty', '-m', name]); gc(['push', '-q', '-f', 'origin', name]);
    return { branch: name, head: gc(['rev-parse', 'HEAD']) };
  };
  const env = { PATH: `${bin}:/usr/bin:/bin`, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rig', FAKE_GH_STATE: state, FAKE_GH_BARE: bare, GIT_CONFIG_GLOBAL: '/dev/null' };
  const cli = (args, timeoutMs = 90_000, envExtra = {}) => {
    const r = spawnSync(process.execPath, [cliPath, 'fanout', ...args], { encoding: 'utf8', env: { ...env, ...envExtra }, timeout: timeoutMs, cwd: work });
    let json = null; try { json = JSON.parse(r.stdout.trim().split('\n').pop()); } catch { /* not a JSON verb */ }
    return { code: r.status, json, stdout: r.stdout, stderr: r.stderr };
  };
  const statePath = path.join(home, 'fanout', 'rig', 'state.json');
  const readState = () => JSON.parse(fs.readFileSync(statePath, 'utf8'));
  const ghState = () => JSON.parse(fs.readFileSync(state, 'utf8'));
  const patchGh = (fn) => { const s = ghState(); fn(s); fs.writeFileSync(state, JSON.stringify(s)); };
  cli(['state', 'init', '--run', 'rig', '--repo', 'o/r']);
  cli(['state', 'set', 'T-2', '--run', 'rig', '--status', 'todo']); // a ticket WITHOUT frozen tests
  const freeze = (extra = []) => cli(['acceptance', 'freeze', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js', '--from', 'origin/writer-510', ...extra]);
  if (o.freeze !== false) { const f = freeze(); if (f.code !== 0) throw new Error(`rig freeze failed: ${f.stdout}${f.stderr}`); }
  const gate = (v, ticket = 'T-1', extra = ['--cwd', cand]) => cli(['gate', '--branch', v.branch, '--into', 'master', '--head', v.head, '--ticket', ticket, '--run', 'rig', ...extra]);
  const deliver = (v, extra = []) => cli(['deliver', '--branch', v.branch, '--into', 'master', '--ticket', 'T-1', '--run', 'rig', '--no-review-gate', '--verified-head', v.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', ...extra]);
  const receiptFile = (name, r) => { const f = path.join(dir, `${name}.json`); fs.writeFileSync(f, JSON.stringify(r)); return f; };
  const count = (verb) => ghState().log.filter((l) => l.startsWith(verb)).length;
  return { dir, work, cand, variant, good, cli, gate, deliver, freeze, receiptFile, readState, statePath, patchGh, count, setCi: (h) => patchGh((s) => s.ciGreen.push(h)), cleanup: () => fs.rmSync(dir, { recursive: true, force: true }) };
}

/** Every arm; returns [{name, ok, detail}]. `cliPath` is the bundle under test (baseline or a mutant). */
function scenarios(cliPath) {
  const res = [];
  const arm = (name, ok, detail = '') => res.push({ name, ok: !!ok, detail });
  const J = (r) => `${r.code} ${r.stdout}${r.stderr}`.slice(0, 700);
  const frozenHash = (W) => W.readState().tickets['T-1'].acceptance.hash;

  const W = world(cliPath);
  try {
    // ── gate ─────────────────────────────────────────────────────────────────────────────────────────────
    const ok = W.variant('g-ok', () => {});
    const g1 = W.gate(ok);
    arm('G1 must-PASS untouched + green: exit 0, acceptance.ok, receipt {head,hash:frozen,ok:true}, files same, ran.exit 0',
      g1.code === 0 && g1.json?.verdict === 'gate' && g1.json.acceptance?.ok === true && g1.json.acceptance.receipt?.ok === true && g1.json.acceptance.receipt.head === ok.head && g1.json.acceptance.receipt.hash === frozenHash(W) && g1.json.acceptance.files?.[0]?.status === 'same' && g1.json.acceptance.ran?.exit === 0, J(g1));
    const comm = (() => { try { return fs.readFileSync(path.join(W.dir, 'test-ran.comm'), 'utf8'); } catch { return 'missing'; } })();
    arm('G1b must-PASS the frozen command runs as a DIRECT argv: the process that started `node --test` is not a shell', !['sh', 'dash', 'bash', 'zsh', 'missing', 'unknown'].includes(comm), `comm=${comm}`);
    const g2 = W.gate(ok, 'T-2', []);
    arm('G2 must-PASS a ticket WITHOUT frozen tests: exit 0, no `acceptance` key, --cwd not needed', g2.code === 0 && g2.json?.verdict === 'gate' && !('acceptance' in g2.json), J(g2));

    const edited = W.variant('g-edit', (c) => fs.writeFileSync(path.join(c, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)')));
    const g3 = W.gate(edited);
    arm('G3 must-FAIL an EDITED frozen test: exit 2, frozen-test-changed, file status changed, receipt.ok false', g3.code === 2 && g3.json?.verdict === 'refused' && g3.json.reason === 'frozen-test-changed' && g3.json.acceptance?.files?.[0]?.status === 'changed' && g3.json.acceptance.receipt?.ok === false, J(g3));
    const del = W.variant('g-del', (c) => fs.rmSync(path.join(c, 't/spec.test.js')));
    const g4 = W.gate(del);
    arm('G4 must-FAIL a DELETED frozen test: exit 2, frozen-test-changed, status missing', g4.code === 2 && g4.json?.reason === 'frozen-test-changed' && g4.json.acceptance?.files?.[0]?.status === 'missing', J(g4));
    const ren = W.variant('g-ren', (c) => fs.renameSync(path.join(c, 't/spec.test.js'), path.join(c, 't/renamed.test.js')));
    const g5 = W.gate(ren);
    arm('G5 must-FAIL a RENAMED frozen test: exit 2, frozen-test-changed', g5.code === 2 && g5.json?.reason === 'frozen-test-changed', J(g5));
    const red = W.variant('g-red', (c) => fs.writeFileSync(path.join(c, 'src/impl.js'), 'exports.f = () => 2;\n'));
    const g6 = W.gate(red);
    arm('G6 must-FAIL a RED frozen test: exit 2, frozen-test-failed, ran.exit ≠ 0, receipt.ok false', g6.code === 2 && g6.json?.reason === 'frozen-test-failed' && g6.json.acceptance?.ran?.exit !== 0 && g6.json.acceptance?.receipt?.ok === false, J(g6));
    const g7 = W.gate(ok, 'T-1', []);
    arm('G7 must-FAIL no --cwd on a ticket with frozen tests: exit 2, acceptance-unproven', g7.code === 2 && g7.json?.reason === 'acceptance-unproven', J(g7));
    W.variant('g-later', (c) => fs.writeFileSync(path.join(c, 'src/impl.js'), 'exports.f = () => 1; // later\n')); // the checkout now holds a NEWER head than `ok`
    const g8 = W.gate(ok);
    arm('G8 must-FAIL --cwd HEAD ≠ --head (stale checkout): exit 2, acceptance-stale-checkout', g8.code === 2 && g8.json?.reason === 'acceptance-stale-checkout', J(g8));
    fs.writeFileSync(path.join(W.cand, 'src/impl.js'), 'exports.f = () => 1; // dirty\n');
    const later = { branch: 'g-later', head: sh('git', ['rev-parse', 'HEAD'], { cwd: W.cand }).stdout.trim() };
    const g9 = W.gate(later);
    arm('G9 must-FAIL uncommitted change to a tracked file in --cwd: exit 2, acceptance-stale-checkout', g9.code === 2 && g9.json?.reason === 'acceptance-stale-checkout', J(g9));
    sh('git', ['checkout', '--', 'src/impl.js'], { cwd: W.cand });
    const sw = W.variant('g-skipwt', (c) => fs.writeFileSync(path.join(c, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)')));
    fs.writeFileSync(path.join(W.cand, 't/spec.test.js'), SPEC); // worktree shows the frozen bytes again …
    sh('git', ['update-index', '--skip-worktree', 't/spec.test.js'], { cwd: W.cand }); // … and `git status` is silent about it
    const g10 = W.gate(sw);
    sh('git', ['update-index', '--no-skip-worktree', 't/spec.test.js'], { cwd: W.cand });
    sh('git', ['checkout', '--', 't/spec.test.js'], { cwd: W.cand });
    arm('G10 must-FAIL a skip-worktree file hiding a DIFFERENT blob at HEAD behind the frozen worktree bytes: exit 2, frozen-test-changed', g10.code === 2 && g10.json?.reason === 'frozen-test-changed', J(g10));

    const g11 = W.gate(ok, 'T-typo');
    arm('G11 must-FAIL explicit --run with a ticket the state does not name: exit 1, bad-state (nothing silently skipped)', g11.code === 1 && g11.json?.reason === 'bad-state', J(g11));
    const g12 = W.cli(['gate', '--branch', ok.branch, '--into', 'master', '--head', ok.head, '--ticket', 'T-typo']);
    arm('G12 must-PASS without --run an unknown ticket prints acceptance:{consulted:false} (nothing checked, said so), exit 0', g12.code === 0 && g12.json?.acceptance?.consulted === false && /NOT checked/.test(g12.stderr), J(g12));

    sh('git', ['checkout', '-q', 'g-ok'], { cwd: W.cand });
    const g13 = W.cli(['gate', '--branch', ok.branch, '--into', 'master', '--head', ok.head, '--ticket', 'T-1', '--cwd', W.cand], 90_000, { ORCHESTRA_WS_ID: 'verifier-x', ORCHESTRA_RUN_ID: 'rig' });
    arm('G13 must-PASS a verifier (own ws id, no state of its own) WITHOUT --run: the clause runs through the INHERITED run (acceptance.ok, ran.exit 0)', g13.code === 0 && g13.json?.acceptance?.ok === true && g13.json.acceptance.ran?.exit === 0, J(g13));

    // ── deliver ──────────────────────────────────────────────────────────────────────────────────────────
    const dOk = W.variant('d-ok', () => {}); W.setCi(dOk.head);
    const d2 = W.deliver(dOk);
    arm('D1 must-FAIL no receipt on a ticket with frozen tests: exit 2, acceptance-unproven, no PR created, no merge', d2.code === 2 && d2.json?.reason === 'acceptance-unproven' && W.count('pr create') === 0 && W.count('pr merge') === 0, J(d2));
    const d3 = W.deliver(dOk, ['--acceptance', W.receiptFile('stale', { head: 'd'.repeat(40), hash: frozenHash(W), ok: true })]);
    arm('D2 must-FAIL a STALE receipt (another head): exit 2, acceptance-stale', d3.code === 2 && d3.json?.reason === 'acceptance-stale' && W.count('pr merge') === 0, J(d3));
    const d3b = W.deliver(dOk, ['--acceptance', W.receiptFile('otherset', { head: dOk.head, hash: 'e'.repeat(64), ok: true })]);
    arm('D3 must-FAIL a receipt for ANOTHER frozen set: exit 2, acceptance-stale', d3b.code === 2 && d3b.json?.reason === 'acceptance-stale', J(d3b));
    const d4 = W.deliver(dOk, ['--acceptance', W.receiptFile('notok', { head: dOk.head, hash: frozenHash(W), ok: false })]);
    arm('D4 must-FAIL a receipt with ok:false: exit 2, frozen-test-failed', d4.code === 2 && d4.json?.reason === 'frozen-test-failed' && W.count('pr merge') === 0, J(d4));
    const drift = W.variant('d-drift', (c) => fs.appendFileSync(path.join(c, 't/spec.test.js'), '// one-line drift\n')); W.setCi(drift.head);
    const d5 = W.deliver(drift, ['--acceptance', W.receiptFile('forged', { head: drift.head, hash: frozenHash(W), ok: true })]);
    arm('D5 must-FAIL byte drift AT THE HEAD behind a forged-valid receipt: exit 2, frozen-test-changed (the gh re-read), no PR, no merge', d5.code === 2 && d5.json?.reason === 'frozen-test-changed' && W.count('pr create') === 0 && W.count('pr merge') === 0, J(d5));
    const gone = W.variant('d-gone', (c) => fs.rmSync(path.join(c, 't/spec.test.js'))); W.setCi(gone.head);
    const d6 = W.deliver(gone, ['--acceptance', W.receiptFile('forged2', { head: gone.head, hash: frozenHash(W), ok: true })]);
    arm('D6 must-FAIL a frozen file DELETED at the head behind a valid receipt: exit 2, frozen-test-changed', d6.code === 2 && d6.json?.reason === 'frozen-test-changed', J(d6));
    sh('git', ['checkout', '-q', 'd-ok'], { cwd: W.cand }); // the gate runs in a checkout AT the head it speaks about
    const real = W.cli(['gate', '--branch', dOk.branch, '--into', 'master', '--head', dOk.head, '--ticket', 'T-1', '--run', 'rig', '--cwd', W.cand]);
    const d7 = W.deliver(dOk, ['--acceptance', W.receiptFile('real', real.json?.acceptance?.receipt ?? {})]);
    arm('D7 must-PASS the gate\'s own receipt for this head + this set, bytes identical at the head: exit 0, merged, acceptanceChecked, one merge', d7.code === 0 && d7.json?.verdict === 'merged' && d7.json.acceptanceChecked === true && W.count('pr merge') === 1, `${J(real)} ||| ${J(d7)}`);
    const t2 = { branch: 'd-ok', head: dOk.head };
    const d8 = W.cli(['deliver', '--branch', t2.branch, '--into', 'master', '--ticket', 'T-2', '--run', 'rig', '--no-review-gate', '--verified-head', t2.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1']);
    arm('D8 must-PASS a ticket WITHOUT frozen tests delivers unchanged (no acceptanceChecked)', d8.code === 0 && d8.json?.verdict === 'already-merged' && d8.json.acceptanceChecked === undefined, J(d8));
    const d10 = W.cli(['deliver', '--branch', dOk.branch, '--into', 'master', '--ticket', 'T-2', '--run', 'rig', '--no-review-gate', '--verified-head', dOk.head, '--no-checks-grace', '0', '--timeout', '3', '--interval', '1', '--acceptance', W.receiptFile('r10', { head: dOk.head, hash: 'a'.repeat(64), ok: true })]);
    arm('D10 must-FAIL --acceptance for a ticket that has NO frozen tests: exit 1, bad-state (a belief mismatch, not a free pass)', d10.code === 1 && d10.json?.reason === 'bad-state', J(d10));
    const am = W.cli(['acceptance', 'amend', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--from', 'origin/writer-510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--run-cmd', 'node --test --test-reporter=tap t/spec.test.js']);
    const d11 = W.deliver(dOk, ['--acceptance', W.receiptFile('oldcmd', real.json?.acceptance?.receipt ?? {})]);
    arm('D11 must-FAIL a receipt gated under the OLD command is stale after amend --run-cmd (the command is part of the hash): exit 2, acceptance-stale', am.code === 0 && d11.code === 2 && d11.json?.reason === 'acceptance-stale', `${J(am)} ||| ${J(d11)}`);
    fs.writeFileSync(W.statePath, '{ not json');
    const d9 = W.deliver(dOk, ['--acceptance', W.receiptFile('r9', { head: dOk.head, hash: 'a'.repeat(64), ok: true })]);
    arm('D9 must-FAIL --acceptance with an unreadable state: exit 1 (fails closed), reason bad-state', d9.code === 1 && d9.json?.reason === 'bad-state', J(d9));
  } finally { W.cleanup(); }

  // ── freeze / amend / state ─────────────────────────────────────────────────────────────────────────────
  const A = world(cliPath);
  try {
    const before = JSON.stringify(A.readState());
    const f2 = A.freeze();
    arm('F1 must-FAIL freezing a ticket twice: exit 2, "already frozen", state unchanged', f2.code === 2 && /already frozen/.test(f2.stderr) && JSON.stringify(A.readState()) === before, J(f2));
    const bad = A.cli(['acceptance', 'freeze', 'T-3', '--run', 'rig', '--files', '../x', '--run-cmd', 'true', '--from', 'origin/writer-510']);
    arm('F2 must-FAIL an unsafe path (..): exit 1, nothing written', bad.code === 1 && !A.readState().tickets['T-3'], J(bad));
    const npm = A.cli(['acceptance', 'freeze', 'T-3', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', 'npm run accept', '--from', 'origin/writer-510']);
    arm('F4 must-FAIL freeze with a --run-cmd naming none of the frozen files (npm run indirection): exit 1, nothing written', npm.code === 1 && /not a direct runner call/.test(npm.stderr) && !A.readState().tickets['T-3'], J(npm));
    const spell = ["sh -c 'npm run accept' t/spec.test.js", 'npm run accept # t/spec.test.js', 'make accept ACC=t/spec.test.js', 'ACC=t/spec.test.js npm run accept', 'true t/spec.test.js', 'node scripts/run.js xt/spec.test.js.bak', 'node --require=./evil.js t/spec.test.js', 'node --test t/spec.test.js; true', 'node --env-file-if-exists=.env t/spec.test.js', 'node --test --test-reporter=./rep.mjs t/spec.test.js', 'bun test --preload=./pre.ts t/spec.test.js', 'node --test-name-pattern t/spec.test.js', 'node --check t/spec.test.js', 'node --test', 'npx node --test t/spec.test.js', 'pnpm exec node --test t/spec.test.js', 'yarn exec node --test t/spec.test.js', 'python3 -m pytest t/spec.test.js', 'python3 -I test/spec.js'];
    const leaked = spell.filter((c) => { const x = A.cli(['acceptance', 'freeze', 'T-4', '--run', 'rig', '--files', 't/spec.test.js', '--run-cmd', c, '--from', 'origin/writer-510']); return x.code !== 1 || !/not a direct runner call/.test(x.stderr); });
    arm('F5 must-FAIL every indirection spelling (sh -c, # path, make ACC=, ENV=path npm run, true path, substring of a longer path, --require, `;`) is refused', leaked.length === 0 && !A.readState().tickets['T-4'], `accepted/odd: ${leaked.join(' | ')}`);
    const sentence = ['--spec-sentence', SENTENCE];
    const common = ['acceptance', 'amend', 'T-1', '--run', 'rig', '--files', 't/spec.test.js,src/impl.js', '--from', 'origin/good'];
    const a1 = A.cli([...common, ...sentence]);
    arm('A1 must-FAIL amend WITHOUT a decision: exit 2, state unchanged', a1.code === 2 && JSON.stringify(A.readState()) === before, J(a1));
    A.patchGh((s) => { s.comments[998] = SENTENCE; });
    const a0 = A.cli([...common, '--decision', 'https://github.com/evil/elsewhere/issues/511#issuecomment-998', ...sentence]);
    arm('A4 must-FAIL a decision comment of ANOTHER repo than the vague\'s (state repo o/r): exit 2, state unchanged', a0.code === 2 && /not of this vague's repo/.test(a0.stderr) && JSON.stringify(A.readState()) === before, J(a0));
    A.patchGh((s) => { s.comments[900] = 'We talked about something else entirely.'; });
    const a2 = A.cli([...common, '--decision', DECISION, ...sentence]);
    arm('A2 must-FAIL a decision that LACKS the spec sentence: exit 2, state unchanged', a2.code === 2 && /does not contain the spec sentence/.test(a2.stderr) && JSON.stringify(A.readState()) === before, J(a2));
    A.patchGh((s) => { s.comments[900] = `Ruling:\n  the carrier   argument is\n optional in the spec.`; });
    const hashBefore = frozenHash(A);
    const a3 = A.cli([...common, '--decision', DECISION, ...sentence]);
    const acc = A.readState().tickets['T-1'].acceptance;
    arm('A3 must-PASS a decision quoting the sentence (whitespace-normalised): exit 0, hash changed, one amendment {decision, specSentence, hashBefore, hashAfter}',
      a3.code === 0 && acc.hash !== hashBefore && acc.amendments.length === 1 && acc.amendments[0].decision === DECISION && acc.amendments[0].specSentence === SENTENCE && acc.amendments[0].hashBefore === hashBefore && acc.amendments[0].hashAfter === acc.hash && Object.keys(acc.files).length === 2, J(a3));
    arm('A3b the amendment records sha256 of the decision body read through gh', acc.amendments[0].bodySha256 === createHash('sha256').update(`Ruling:\n  the carrier   argument is\n optional in the spec.`).digest('hex'), JSON.stringify(acc.amendments[0]));
    const a6 = A.cli(['acceptance', 'amend', 'T-1', '--run', 'rig', '--files', 't/spec.test.js', '--from', 'origin/good', '--decision', 'https://github.com/O/R/pull/9#issuecomment-0900', ...sentence]);
    arm('A6 must-FAIL the SAME decision comment (spelled /O/R/pull/9#…-0900) authorising a second amendment: exit 2, "already authorised", state unchanged', a6.code === 2 && /already authorised/.test(a6.stderr) && A.readState().tickets['T-1'].acceptance.hash === acc.hash, J(a6));
    A.patchGh((s) => { s.comments[901] = `Second ruling: ${SENTENCE}.`; });
    const D2 = 'https://github.com/o/r/issues/511#issuecomment-901';
    const a5 = A.cli([...common, '--decision', D2, ...sentence, '--run-cmd', 'npm run accept']);
    arm('A5 must-FAIL amend --run-cmd naming none of the frozen files: exit 1, state unchanged', a5.code === 1 && /not a direct runner call/.test(a5.stderr) && A.readState().tickets['T-1'].acceptance.run === acc.run, J(a5));
    const a7 = A.cli([...common, '--decision', D2, ...sentence, '--run-cmd', 'node --test t/spec.test.js src/impl.js']);
    const acc2 = A.readState().tickets['T-1'].acceptance;
    arm('A7 must-PASS amend --run-cmd with the same files (command-only change): exit 0, hash CHANGED (it covers the command), run replaced, runAfter recorded', a7.code === 0 && acc2.hash !== acc.hash && acc2.run === 'node --test t/spec.test.js src/impl.js' && acc2.amendments[1].runAfter === acc2.run, J(a7));
    const snap = JSON.stringify(A.readState());
    const forged = { acceptance: acc };
    const s1 = A.cli(['state', 'set', 'T-2', '--run', 'rig', '--json', JSON.stringify(forged)]);
    arm('S1 must-FAIL `state set --json` writing acceptance: exit 1 "unknown field", state byte-identical', s1.code === 1 && /unknown field "acceptance"/.test(s1.stderr) && JSON.stringify(A.readState()) === snap, J(s1));
    const s2 = A.cli(['state', 'set', 'T-2', '--run', 'rig', '--status', 'started']);
    arm('S2 must-PASS an ordinary `state set` still works and keeps T-1\'s frozen set', s2.code === 0 && A.readState().tickets['T-1'].acceptance.hash === acc2.hash, J(s2));
    const snap2 = JSON.stringify(A.readState());
    const sh1 = A.cli(['acceptance', 'show', 'T-1', '--run', 'rig', '--json']);
    arm('H1 must-PASS `acceptance show --json` is read-only and prints the frozen set', sh1.code === 0 && JSON.parse(sh1.stdout).hash === acc2.hash && JSON.stringify(A.readState()) === snap2, J(sh1));
    const live = fs.readFileSync(A.statePath, 'utf8');
    const forgedState = JSON.parse(live);
    const evil = { '../evil.test.js': 'a'.repeat(64) };
    forgedState.tickets['T-1'].acceptance.files = evil;
    forgedState.tickets['T-1'].acceptance.hash = createHash('sha256').update(`../evil.test.js\0${'a'.repeat(64)}\n`).digest('hex'); // a CONSISTENT hash: only the path rule can refuse it
    fs.writeFileSync(A.statePath, JSON.stringify(forgedState));
    const s3 = A.cli(['acceptance', 'show', 'T-1', '--run', 'rig']);
    arm('F3 must-FAIL a state whose frozen path climbs out (../): unreadable (exit 1, "unsafe acceptance path")', s3.code === 1 && /unsafe acceptance path/.test(s3.stderr), J(s3));
    fs.writeFileSync(A.statePath, live);
    const help = A.cli(['--help']);
    arm('H2 must-PASS `fanout --help` documents freeze|amend|show', /acceptance freeze/.test(help.stdout + help.stderr), J(help));
  } finally { A.cleanup(); }

  return res;
}

function report(title, res) {
  console.log(`\n== ${title}`);
  for (const r of res) console.log(`${r.ok ? 'PASS' : 'FAIL'}  ${r.name}${r.ok ? '' : `\n      ${r.detail}`}`);
  const bad = res.filter((r) => !r.ok).length;
  console.log(`-- ${res.length - bad}/${res.length} PASS`);
  return bad;
}

// NOT mutated here (equivalent in verdict): the metacharacter refusal (a metacharacter always yields a non-frozen token / non-allowlisted flag, so the argument rules refuse it
// first) and `no shell` (without metacharacters a shell cannot change the argv; the argv-not-string contract is pinned by the unit arm 'executed as an ARGV' + a hand mutation).
// Each mutant breaks ONE clause in the BUILT bundle; the anchor must occur exactly once. `extra` = a second edit of the same mutant.
const mutants = [
  { name: 'gate: hashes nothing (every frozen file reads "same")', find: 'sha256Hex(bytes) === acc.files[p] && atHead ? "same" : "changed"', put: () => '"same"' },
  { name: 'gate: only the worktree bytes are hashed (the blob at HEAD is not compared)', find: 'sha256Hex(bytes) === acc.files[p] && atHead ? "same" : "changed"', put: () => 'sha256Hex(bytes) === acc.files[p] ? "same" : "changed"' },
  { name: 'amend: a decision from any repo accepted', find: 'if (st0.repo && decisionRepo.toLowerCase() !== st0.repo.toLowerCase())', put: () => 'if (false)' },
  { name: 'gate: the frozen command is never run (exit 0 assumed)', find: 'const r = io.run(parseRunArgv(acc.run, Object.keys(acc.files)), root);', put: () => 'const r = { exit: 0, tail: "" };' },
  { name: 'gate: --cwd falls back to the process cwd (not required)', find: 'const cwd = o.cwd ? path.resolve(o.cwd) : null;', put: () => 'const cwd = path.resolve(o.cwd ?? process.cwd());' },
  { name: 'gate: stale checkout accepted (cwd HEAD ≠ --head)', find: 'if (facts.cwdHead !== facts.head)', put: () => 'if (false)' },
  { name: 'gate: a dirty tracked tree accepted', find: 'if (facts.dirty.length)', put: () => 'if (false)' },
  { name: 'gate: the whole acceptance clause skipped', find: 'if (frozen) {', put: () => 'if (false) {' },
  { name: 'deliver: no receipt needed', find: 'if (!receipt) return { ok: false, reason: "acceptance-unproven"', put: () => 'if (!receipt) return { ok: true }; if (false) return { ok: false, reason: "acceptance-unproven"' },
  { name: 'deliver: a receipt for another head accepted', find: 'if (receipt.head !== verifiedHead && !(receipt.tree && ctx.headTree && receipt.tree === ctx.headTree)) {', put: () => 'if (false) {' },
  { name: 'deliver: a receipt for another frozen set accepted', find: 'receipt.hash !== acc.hash', put: () => 'false' },
  { name: 'deliver: receipt.ok ignored', find: 'if (!receipt.ok)', put: () => 'if (false)' },
  { name: 'deliver: the gh byte re-read ignored', find: 'const bad = files.filter((f) => f.status !== "same");', put: () => 'const bad = [];' },
  { name: 'deliver: --acceptance for a ticket without frozen tests is waved through', find: 'if (opts.acceptance !== void 0 && !got.acceptance) {', put: () => 'if (false) {' },
  { name: 'run: any first word allowed (true / npm run / sh -c …)', find: 'if (!runner) why(', put: () => 'if (false) why(', extra: [{ find: 'for (const t of inner.slice(runner.prefix.length)) {', put: () => 'for (const t of inner.slice(runner ? runner.prefix.length : 1)) {' }, { find: 'if (!runner.flags.some((re) => re.test(t))) why(', put: () => 'if (false) why(' }] },
  { name: 'run: any non-flag argument allowed (a script the candidate owns)', find: 'if (!paths.includes(t)) why(', put: () => 'if (false) why(' },
  { name: 'run: any flag allowed (--require, --env-file…, --test-reporter=./x, --check, --test-name-pattern)', find: 'if (!runner.flags.some((re) => re.test(t))) why(', put: () => 'if (false) why(' },
  { name: 'run: the command need not name a frozen file', find: 'if (named === 0) why(', put: () => 'if (false) why(' },
  { name: 'hash: the command is not part of the hash', find: '.join("") + `run\\0${run}', put: () => '.join("") + `${""}' },
  { name: 'amend: decision key keeps leading zeros (-0900 is another comment)', find: '${m[1].toLowerCase()}#${Number(m[2])}', put: () => '${m[1].toLowerCase()}#${m[2]}' },
  { name: 'amend: decision reuse keyed on the raw URL (another spelling of the same comment passes)', find: 'const key = (u) => {', put: () => 'const key = (u) => { return u; };\n  const unusedKey = (u) => {' },
  { name: 'run: a package launcher (npx / pnpm exec / yarn exec) is accepted', find: 'const inner = tokens;', put: () => 'const inner = tokens[0] === "npx" ? tokens.slice(1) : (tokens[0] === "pnpm" || tokens[0] === "yarn") && tokens[1] === "exec" ? tokens.slice(2) : tokens;' },
  { name: 'run: `python -m` without -I accepted', find: '{ prefix: ["python3", "-I", "-m", "pytest"]', put: () => '{ prefix: ["python3", "-m", "pytest"]' },
  { name: 'gate: no fallback to the inherited run for a verifier', find: '...opts.run ? [] : inherited ? [inherited] : []', put: () => '...[]' },
  { name: 'amend: the decision body hash is not recorded', find: 'bodySha256: sha256Hex(Buffer.from(body, "utf8"))', put: () => 'bodySha256: "0".repeat(64)' },
  { name: 'gate: an explicit --run with an unknown ticket skips the clause', find: 'lenient: !o.run', put: () => 'lenient: true' },
  { name: 'gate: an absent state/ticket is silent (no consulted:false)', find: 'accept = { consulted: false };', put: () => 'accept = void 0;' },
  { name: 'amend: no decision required', find: 'if (!decision) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'amend: the decision body is not checked for the sentence', find: 'if (!ok.ok) throw new Refusal(ok.why);', put: () => '' },
  { name: 'freeze: a second freeze is not refused as a policy refusal (the verb check)', find: 'if (had?.acceptance) throw new Refusal(', put: () => 'if (false) throw new Refusal(' },
  { name: 'freeze: ../ paths accepted', find: 'p.split("/").some((seg) => seg === ".." ||', put: () => 'p.split("/").some((seg) => false ||' },
  { name: 'state set: --json may write acceptance', find: 'refuseUnknown(patch, new Set(SETTABLE_KEYS), "patch");', put: () => 'refuseUnknown(patch, new Set([...SETTABLE_KEYS, "acceptance"]), "patch");', extra: [{ find: 'if ("mergedAccepted" in patch) next.mergedAccepted', put: (m) => `if ("acceptance" in patch) next.acceptance = patch.acceptance;\n  ${m}` }] },
];

if (!fs.existsSync(CLI)) { console.error(`${CLI} missing — run \`pnpm run build:cli\` first (a rig on a stale or absent bundle proves nothing)`); process.exit(1); }
const orig = fs.readFileSync(CLI, 'utf8');
if (!orig.includes('acceptanceFromState') && !orig.includes('frozen acceptance tests')) { console.error('dist-electron/cli.js has no `fanout acceptance` — it is stale: rebuild (pnpm run build:cli)'); process.exit(1); }

const baselineBad = report('baseline (built bundle)', scenarios(CLI));
if (!process.argv.includes('--mutants')) process.exit(baselineBad ? 1 : 0);
if (baselineBad) { console.error('baseline is not clean: the mutant verdicts below would be meaningless'); process.exit(1); }

let survived = 0;
const scratch = fs.mkdtempSync(path.join(tmpBase, 'fanout-accept-mut-'));
for (const [i, m] of mutants.entries()) {
  if (process.env.MUT_ONLY && !process.env.MUT_ONLY.split(',').includes(String(i))) continue; // iterate on a few: MUT_ONLY=16,17
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
if (fs.readFileSync(CLI, 'utf8') !== orig) { console.error('the real bundle changed during the run'); process.exit(1); }
console.log(`\n${mutants.length - survived}/${mutants.length} mutants killed; real bundle byte-identical`);
process.exit(survived ? 1 : 0);
