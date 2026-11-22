// #510 — frozen acceptance tests: freeze / amend / show, the gate clause, deliver's receipt + gh byte re-read, `state set` cannot write it.
// REAL git on a scratch repo (writer branch + candidate checkout), the production state reader and the production dep wiring (realGateDeps / realDeps);
// only `gh` is faked (reads the real bytes out of the scratch repo, so a drifted head is genuinely drifted). Mutants: scripts/e2e-fanout-acceptance-mutants.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { ACCEPTANCE_USAGE, checkAcceptanceInCheckout, runAcceptance } from './fanout-acceptance.ts';
import { deliver, realDeps, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, parseGateArgs, realGateDeps, type GateOpts } from './fanout-gate.ts';
import { decisionNamesSentence } from '../shared/fanout-acceptance.ts';
import { acceptanceHash, applyTicketPatch, parseRunArgv, newState, parseState, readState, sha256Hex, stateFile, writeStateAtomic } from '../shared/fanout-state.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
// the test body leaves a marker beside the scratch root so an arm can tell "the frozen test really executed" from "the command exited 0"
const SPEC = "const test = require('node:test');\nconst assert = require('node:assert');\nconst { f } = require('../src/impl.js');\ntest('f returns what the spec says', () => { require('node:fs').writeFileSync(require('node:path').join(__dirname, '..', '..', 'test-ran.marker'), 'x'); assert.equal(f(), 1); });\n";
const DECISION = 'https://github.com/o/r/issues/511#issuecomment-900';
const SENTENCE = 'the carrier argument is optional in the spec';

const git = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

interface Rig {
  root: string; home: string; writer: string; cand: string; env: NodeJS.ProcessEnv;
  g: (...a: string[]) => string; w: (...a: string[]) => string;
  commitCand: (msg: string) => string;
  deps: (comments?: Record<string, string>) => FanoutDeps;
  freeze: (extra?: string[]) => { code: number; stdout: string; stderr: string };
  state: () => ReturnType<typeof readState>;
  marker: string;
}

/** writer repo (branch writer-510 with the frozen test) + a candidate clone that copied it unchanged + a state with ticket T510. */
function rig(t: { after: (fn: () => void) => void }, o: { freeze?: boolean } = {}): Rig {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'accept-510-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const home = path.join(root, 'home');
  const writer = path.join(root, 'writer');
  const cand = path.join(root, 'cand');
  fs.mkdirSync(writer);
  const w = git(writer);
  w('init', '-q', '-b', 'master');
  fs.mkdirSync(path.join(writer, 'src'));
  fs.writeFileSync(path.join(writer, 'src/impl.js'), 'exports.f = () => 0;\n');
  w('add', '.'); w('commit', '-q', '-m', 'root');
  w('checkout', '-q', '-b', 'writer-510');
  fs.mkdirSync(path.join(writer, 't'));
  fs.writeFileSync(path.join(writer, 't/spec.test.js'), SPEC);
  w('add', '.'); w('commit', '-q', '-m', 'writer: acceptance tests');
  w('checkout', '-q', 'master');
  execFileSync('git', ['clone', '-q', writer, cand], { env: GIT_ENV });
  const g = git(cand);
  g('checkout', '-q', '-b', 'impl-510', 'origin/master');
  g('fetch', '-q', 'origin', 'writer-510');
  g('checkout', 'FETCH_HEAD', '--', 't/spec.test.js'); // the documented implementer step: copy unchanged
  fs.writeFileSync(path.join(cand, 'src/impl.js'), 'exports.f = () => 1;\n');
  g('add', '.'); g('commit', '-q', '-m', 'impl: tests copied unchanged + code');
  const env = { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' };
  const marker = path.join(root, 'test-ran.marker'); // written by the frozen test body itself
  writeStateAtomic(stateFile(home, 'r1'), applyTicketPatch(newState('r1', { now: NOW }), 'T510', { branch: 'impl-510' }, NOW));
  const ghFake = (comments: Record<string, string>): Runner => (cmd, args, cwd) => {
    if (cmd === 'git') return defaultRunner(cmd, args, cwd);
    const m = /^repos\/o\/r\/issues\/comments\/(\d+)$/i.exec(args[1] ?? '');
    if (args[0] === 'api' && m && comments[String(Number(m[1]))] !== undefined) return { code: 0, stdout: JSON.stringify({ body: comments[String(Number(m[1]))] }), stderr: '' };
    return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  };
  const deps = (comments: Record<string, string> = { 900: `Decision: ${SENTENCE}.` }): FanoutDeps => ({ env, cwd: writer, runner: ghFake(comments), now: () => NOW, readStdin: () => '' });
  const cmd = 'node --test t/spec.test.js';
  const freeze = (extra: string[] = []) => runAcceptance(['freeze', 'T510', '--files', 't/spec.test.js', '--run-cmd', cmd, '--from', 'writer-510', ...extra], deps());
  if (o.freeze !== false) assert.equal(freeze().code, 0);
  const rg: Rig = {
    root, home, writer, cand, env, g, w, deps, freeze, marker,
    commitCand: (msg) => { g('add', '-A'); g('commit', '-q', '-m', msg); return g('rev-parse', 'HEAD'); },
    state: () => readState(stateFile(home, 'r1')),
  };
  return rg;
}

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });

// ── gate ──────────────────────────────────────────────────────────────────────────────────────────────────

const gateGh = async (args: string[]): Promise<GhResult> => {
  if (args[0] === 'api') return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; // the target has no workflows
  if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
  return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
/** The PRODUCTION gate wiring (stack + acceptance readers on the state file), only gh faked. */
async function gate(r: Rig, o: { head: string; cwd?: string | null; ticket?: string; run?: string | null }) {
  Object.assign(process.env, r.env);
  const opts: GateOpts = { branch: 'impl-510', into: 'master', head: o.head, requireChecks: [], ticket: o.ticket ?? 'T510', run: o.run === null ? undefined : 'r1', cwd: o.cwd === null ? undefined : (o.cwd ?? r.cand), settleMs: 0 };
  const logs: string[] = [];
  const res = await gatePr(opts, { ...realGateDeps(), gh: gateGh, log: (s) => logs.push(s), sleep: async () => {} });
  return { ...res, logs };
}

test('gate must-PASS: frozen tests untouched + green ⇒ exit 0, acceptance.ok, receipt {head,hash,ok:true,tree,ticket}, the command ran', async (t) => {
  const r = rig(t);
  const head = r.g('rev-parse', 'HEAD');
  const { exit, result } = await gate(r, { head });
  assert.equal(exit, 0);
  assert.equal(result.verdict, 'gate');
  assert.equal(result.acceptance?.ok, true);
  assert.deepEqual(result.acceptance?.files, [{ path: 't/spec.test.js', status: 'same' }]);
  assert.equal(result.acceptance?.ran?.exit, 0);
  assert.deepEqual(result.acceptance?.receipt, { head, hash: r.state()!.tickets.T510.acceptance!.hash, ok: true, tree: r.g('rev-parse', 'HEAD^{tree}'), ticket: 'T510' }); // #512: the receipt names the content + the ticket
  assert.ok(fs.existsSync(r.marker), 'the frozen command really ran in the checkout');
  assert.ok(fs.existsSync(path.join(r.root, 'test-ran.marker')), 'and the frozen test body itself executed (not just exit 0)');
});

test('gate must-PASS (no clause): a ticket WITHOUT acceptance ⇒ output and exit unchanged (no acceptance key, --cwd not needed)', async (t) => {
  const r = rig(t, { freeze: false });
  const { exit, result } = await gate(r, { head: r.g('rev-parse', 'HEAD'), cwd: null });
  assert.equal(exit, 0);
  assert.equal(result.verdict, 'gate');
  assert.equal('acceptance' in result, false);
});

test('gate must-FAIL: an EDITED frozen test ⇒ exit 2 frozen-test-changed, and the command is NOT run', async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)')); // weakened to pass
  const head = r.commitCand('weaken the frozen test');
  const { exit, result } = await gate(r, { head });
  assert.equal(exit, 2);
  assert.equal(result.verdict, 'refused');
  assert.equal(result.reason, 'frozen-test-changed');
  assert.deepEqual(result.acceptance?.files, [{ path: 't/spec.test.js', status: 'changed' }]);
  assert.equal(result.acceptance?.receipt.ok, false);
  assert.equal(fs.existsSync(r.marker) || fs.existsSync(path.join(r.root, 'test-ran.marker')), false, 'a changed test is never executed');
});

for (const [name, mutate] of [
  ['DELETED', (r: Rig) => fs.rmSync(path.join(r.cand, 't/spec.test.js'))],
  ['RENAMED', (r: Rig) => fs.renameSync(path.join(r.cand, 't/spec.test.js'), path.join(r.cand, 't/spec2.test.js'))],
] as const) {
  test(`gate must-FAIL: a ${name} frozen test ⇒ exit 2 frozen-test-changed (status missing)`, async (t) => {
    const r = rig(t);
    mutate(r);
    const { exit, result } = await gate(r, { head: r.commitCand('remove the frozen test') });
    assert.equal(exit, 2);
    assert.equal(result.reason, 'frozen-test-changed');
    assert.deepEqual(result.acceptance?.files, [{ path: 't/spec.test.js', status: 'missing' }]);
  });
}

test('gate must-FAIL: a frozen file present but UNTRACKED (copied, never committed) is missing at the head ⇒ frozen-test-changed', async (t) => {
  const r = rig(t);
  r.g('rm', '-q', '--cached', 't/spec.test.js');
  r.g('commit', '-q', '-m', 'untrack it'); // file stays on disk, byte-identical, but is not in HEAD
  const { exit, result } = await gate(r, { head: r.g('rev-parse', 'HEAD') });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-changed');
  assert.equal(result.acceptance?.files[0].status, 'missing');
});

test('gate must-FAIL: a RED frozen test (candidate code wrong) ⇒ exit 2 frozen-test-failed, receipt ok:false, ran.exit ≠ 0', async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.cand, 'src/impl.js'), 'exports.f = () => 2;\n');
  const { exit, result } = await gate(r, { head: r.commitCand('wrong code') });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-failed');
  assert.notEqual(result.acceptance?.ran?.exit, 0);
  assert.equal(result.acceptance?.receipt.ok, false);
  assert.ok(fs.existsSync(path.join(r.root, 'test-ran.marker')), 'the red test did execute');
});

test('gate must-FAIL: no --cwd on a ticket with frozen tests ⇒ exit 2 acceptance-unproven (nothing ran)', async (t) => {
  const r = rig(t);
  const { exit, result } = await gate(r, { head: r.g('rev-parse', 'HEAD'), cwd: null });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-unproven');
  assert.equal(fs.existsSync(r.marker), false);
});

test('gate must-FAIL: --cwd not at --head (stale checkout) ⇒ exit 2 acceptance-stale-checkout', async (t) => {
  const r = rig(t);
  const old = r.g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.cand, 'src/impl.js'), 'exports.f = () => 1; // later\n');
  r.commitCand('a later commit');
  const { exit, result } = await gate(r, { head: old }); // the verifier says "gate THIS head" but the checkout holds a newer one
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-stale-checkout');
  assert.equal(fs.existsSync(r.marker), false);
});

test('gate must-FAIL: uncommitted change to a tracked file in --cwd ⇒ acceptance-stale-checkout (the run would not be of --head)', async (t) => {
  const r = rig(t);
  const head = r.g('rev-parse', 'HEAD');
  fs.writeFileSync(path.join(r.cand, 'src/impl.js'), 'exports.f = () => 1; // dirty\n');
  const { exit, result } = await gate(r, { head });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-stale-checkout');
});

test('gate must-FAIL: --cwd that is not a git checkout root ⇒ acceptance-unproven', async (t) => {
  const r = rig(t);
  const { exit, result } = await gate(r, { head: r.g('rev-parse', 'HEAD'), cwd: path.join(r.cand, 't') });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-unproven');
});

test('gate: --cwd without --ticket is a usage error', () => {
  const p = parseGateArgs(['--branch', 'b', '--into', 'master', '--head', 'a'.repeat(40), '--cwd', '/x']);
  assert.equal(p.ok, false);
});

// ── deliver ───────────────────────────────────────────────────────────────────────────────────────────────

/** A one-PR fake GitHub whose `contents` reads the REAL bytes at a ref out of the scratch candidate repo. */
function deliverRig(r: Rig, prHead: string, o: { contents500?: boolean; commits404?: boolean } = {}) {
  const calls: string[][] = [];
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    calls.push(args);
    const [a, b] = args;
    if (a === 'api') {
      if (/\/commits\/[0-9a-f]{40}$/.test(args[args.length - 1])) return o.commits404 ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : ok('{}');
      const m = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(args[args.length - 1]);
      if (m) {
        if (o.contents500) return { code: 1, stdout: '', stderr: 'HTTP 500' };
        try { return ok(execFileSync('git', ['show', `${m[2]}:${decodeURIComponent(m[1])}`], { cwd: r.cand, env: GIT_ENV, encoding: 'utf8' })); } catch { return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; }
      }
      return { code: 1, stdout: '', stderr: 'HTTP 404' };
    }
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: prHead }]));
    if (a === 'pr' && b === 'create') return ok('https://github.com/o/r/pull/7\n');
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: prHead, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const logs: string[] = [];
  const deps: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: (s) => logs.push(s) }; // production readers (upstreams + acceptance) and readFile
  const merges = () => calls.filter((c) => c[0] === 'pr' && c[1] === 'merge');
  const creates = () => calls.filter((c) => c[0] === 'pr' && c[1] === 'create');
  return { deps, calls, merges, creates, logs };
}
const dopts = (head: string, o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch: 'impl-510', into: 'master', ticket: 'T510', verifiedHead: head, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], run: 'r1', ...o,
});
const writeReceipt = (r: Rig, receipt: unknown): string => { const f = path.join(r.root, 'receipt.json'); fs.writeFileSync(f, JSON.stringify(receipt)); return f; };
const hashOf = (r: Rig): string => r.state()!.tickets.T510.acceptance!.hash;

test('deliver must-PASS: gate receipt for this head + this hash, bytes identical at the head ⇒ merged, acceptanceChecked', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: true }) }), x.deps);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.verdict, 'merged');
  assert.equal(result.acceptanceChecked, true);
  assert.equal(x.merges().length, 1);
});

test('deliver must-PASS: the whole gate JSON line is accepted as the receipt file (its acceptance.receipt)', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const g = await gate(r, { head });
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, g.result) }), x.deps);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.acceptanceChecked, true);
});

test('deliver must-PASS (no clause): a ticket without acceptance merges as before; --acceptance is then refused as a belief mismatch', async (t) => {
  const r = rig(t, { freeze: false });
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const a = deliverRig(r, head);
  const refused = await deliver(dopts(head), a.deps); // #515 M3: no spec, nothing frozen, no waiver ⇒ acceptance-pending (nothing merged) …
  assert.equal(refused.exit, 2);
  assert.equal(refused.result.reason, 'acceptance-pending');
  assert.equal(a.merges().length, 0);
  const ok1 = await deliver(dopts(head, { noAcceptanceGate: true }), a.deps); // … with the explicit escape it merges as before
  assert.equal(ok1.exit, 0);
  assert.equal(ok1.result.acceptanceChecked, undefined);
  assert.equal(ok1.result.acceptanceGate, 'bypassed');
  const b = deliverRig(r, head);
  const bad = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: 'a'.repeat(64), ok: true }) }), b.deps);
  assert.equal(bad.exit, 1);
  assert.equal(bad.result.reason, 'bad-state');
  assert.equal(b.merges().length, 0);
});

test('deliver must-FAIL: NO receipt for a ticket with frozen tests ⇒ exit 2 acceptance-unproven, no PR opened, no merge', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-unproven');
  assert.equal(x.creates().length + x.merges().length, 0);
});

test('deliver must-FAIL: STALE receipt (another head) ⇒ exit 2 acceptance-stale', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head: 'd'.repeat(40), hash: hashOf(r), ok: true }) }), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-stale');
  assert.equal(x.merges().length, 0);
});

test('deliver must-FAIL: receipt for a DIFFERENT frozen set (amended since the gate) ⇒ exit 2 acceptance-stale', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: 'e'.repeat(64), ok: true }) }), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.reason, 'acceptance-stale');
});

test('deliver must-FAIL: receipt ok:false ⇒ exit 2 frozen-test-failed', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: false }) }), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-failed');
});

test('deliver must-FAIL: byte drift AT THE HEAD behind a forged-valid receipt ⇒ exit 2 frozen-test-changed (the independent gh re-read)', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), `${SPEC}// drift\n`);
  const head = r.commitCand('a one-line drift in the frozen test');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: true }) }), x.deps); // receipt says all fine
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-changed');
  assert.match(result.detail ?? '', /t\/spec\.test\.js \(changed\)/);
  assert.equal(x.creates().length + x.merges().length, 0);
});

test('deliver must-FAIL: a frozen file DELETED at the head behind a valid receipt ⇒ frozen-test-changed (missing)', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  r.g('rm', '-q', 't/spec.test.js');
  const head = r.commitCand('delete');
  const x = deliverRig(r, head);
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: true }) }), x.deps);
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-changed');
  assert.match(result.detail ?? '', /\(missing\)/);
});

test('deliver fails closed: --acceptance with an unreadable state / unknown ticket ⇒ exit 1 bad-state; gh unreadable ⇒ exit 1 gh-failed', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const receipt = writeReceipt(r, { head, hash: hashOf(r), ok: true });
  const unknown = await deliver(dopts(head, { ticket: 'NOPE', acceptance: receipt }), deliverRig(r, head).deps);
  assert.equal(unknown.exit, 1);
  assert.equal(unknown.result.reason, 'bad-state');
  const noRun = await deliver(dopts(head, { run: 'no-such-run', acceptance: receipt }), deliverRig(r, head).deps);
  assert.equal(noRun.exit, 1);
  assert.equal(noRun.result.reason, 'bad-state');
  fs.writeFileSync(stateFile(r.home, 'r1'), '{ not json');
  const broken = await deliver(dopts(head, { acceptance: receipt }), deliverRig(r, head).deps);
  assert.equal(broken.exit, 1);
  assert.equal(broken.result.reason, 'bad-state');
});

test('deliver fails closed: the contents read itself failing (gh 500) is could-not-check, never "unchanged"', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head, { contents500: true });
  const { exit, result } = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: true }) }), x.deps);
  assert.equal(exit, 1);
  assert.equal(result.reason, 'gh-failed');
  assert.equal(x.merges().length, 0);
});

test('deliver: an unreadable / malformed receipt file ⇒ exit 2 acceptance-unproven', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const missing = await deliver(dopts(head, { acceptance: path.join(r.root, 'nope.json') }), deliverRig(r, head).deps);
  assert.equal(missing.exit, 2);
  assert.equal(missing.result.reason, 'acceptance-unproven');
  const f = path.join(r.root, 'junk.json');
  fs.writeFileSync(f, '{"head":"x"}');
  const junk = await deliver(dopts(head, { acceptance: f }), deliverRig(r, head).deps);
  assert.equal(junk.exit, 2);
  assert.equal(junk.result.reason, 'acceptance-unproven');
});

// ── freeze / amend / show ─────────────────────────────────────────────────────────────────────────────────

test('freeze must-PASS: records {files→sha256, hash, run, source, frozenAt, amendments:[]}; the hash is sha256 of the sorted "path\\0sha\\n" lines', (t) => {
  const r = rig(t);
  const a = r.state()!.tickets.T510.acceptance!;
  assert.deepEqual(a.files, { 't/spec.test.js': sha256Hex(SPEC) });
  assert.equal(a.hash, sha256Hex(`t/spec.test.js\0${sha256Hex(SPEC)}\nrun\0${a.run}\n`));
  assert.equal(a.hash, acceptanceHash(a.files, a.run));
  assert.equal(a.source.branch, 'writer-510');
  assert.equal(a.source.head, r.w('rev-parse', 'writer-510'));
  assert.equal(a.frozenAt, NOW);
  assert.deepEqual(a.amendments, []);
  assert.match(a.run, /node --test t\/spec\.test\.js/);
  assert.equal(r.state()!.tickets.T510.branch, 'impl-510', 'the rest of the ticket is untouched');
});

test('freeze must-FAIL: already frozen ⇒ refused (use amend); empty files; unsafe / absolute / .. paths; a file not in the ref; an unknown ref', (t) => {
  const r = rig(t);
  const again = r.freeze();
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already frozen.*amend/);
  const fresh = (files: string, from = 'writer-510') => runAcceptance(['freeze', 'T2', '--files', files, '--run-cmd', 'node --test t/spec.test.js', '--from', from], r.deps());
  assert.equal(fresh('').code, 1);
  for (const bad of ['../t/spec.test.js', '/etc/passwd', 't/../spec', '-x', 't//a', 'a\\b']) assert.equal(fresh(bad).code, 1, bad);
  assert.equal(fresh('t/nope.test.js').code, 1);
  assert.equal(fresh('t/spec.test.js', 'no-such-ref').code, 1);
  assert.equal(fresh('src/impl.js', '--evil').code, 1);
  assert.equal(r.state()!.tickets.T2, undefined, 'a refused freeze writes nothing');
});

test('freeze: --from <dir> reads a committed checkout; uncommitted changes there are refused', (t) => {
  const r = rig(t, { freeze: false });
  const d = r.deps();
  const go = () => runAcceptance(['freeze', 'T510', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js', '--from', r.cand], d);
  fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), `${SPEC}// edited, uncommitted\n`);
  assert.equal(go().code, 1);
  r.g('checkout', '--', 't/spec.test.js');
  assert.equal(go().code, 0);
  assert.equal(r.state()!.tickets.T510.acceptance!.source.branch, 'impl-510');
});

test('amend must-FAIL: no --decision / no --spec-sentence ⇒ exit 2; a decision LACKING the sentence ⇒ exit 2; a short sentence ⇒ exit 2; nothing written', (t) => {
  const r = rig(t);
  const before = JSON.stringify(r.state());
  const amend = (extra: string[], comments?: Record<string, string>) => runAcceptance(['amend', 'T510', '--files', 't/spec.test.js,src/impl.js', '--from', 'impl-510', ...extra], r.deps(comments));
  assert.equal(amend(['--spec-sentence', SENTENCE]).code, 2);
  assert.equal(amend(['--decision', DECISION]).code, 2);
  const lacking = amend(['--decision', DECISION, '--spec-sentence', SENTENCE], { 900: 'We decided something unrelated.' });
  assert.equal(lacking.code, 2);
  assert.match(lacking.stderr, /does not contain the spec sentence/);
  const short = amend(['--decision', DECISION, '--spec-sentence', 'too short'], { 900: 'too short and more' });
  assert.equal(short.code, 2);
  assert.match(short.stderr, /min 12/);
  assert.equal(JSON.stringify(r.state()), before, 'a refused amend leaves the state byte-identical');
});

test('amend must-FAIL: a decision gh cannot read / a non-ledger URL ⇒ exit 1 (could not check), nothing written', (t) => {
  const r = rig(t);
  const before = JSON.stringify(r.state());
  const base = ['amend', 'T510', '--files', 't/spec.test.js,src/impl.js', '--from', 'impl-510', '--spec-sentence', SENTENCE];
  assert.equal(runAcceptance([...base, '--decision', DECISION], r.deps({})).code, 1);
  assert.equal(runAcceptance([...base, '--decision', 'https://example.com/x#issuecomment-1'], r.deps()).code, 1);
  assert.equal(JSON.stringify(r.state()), before);
});

test('amend must-PASS: a decision quoting the sentence (whitespace-normalised) ⇒ files + hash updated, amendment appended, source follows --from', (t) => {
  const r = rig(t);
  const old = r.state()!.tickets.T510.acceptance!;
  fs.appendFileSync(path.join(r.cand, 't/spec.test.js'), '// the spec says carrier is optional\n');
  r.commitCand('the coordinator-approved test change');
  const res = runAcceptance(['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', r.cand], r.deps({ 900: `Ruling, per the spec:\n  the   carrier argument\nis optional in the spec.\n` }));
  assert.equal(res.code, 0, res.stderr);
  const a = r.state()!.tickets.T510.acceptance!;
  assert.notEqual(a.hash, old.hash);
  assert.equal(a.hash, acceptanceHash(a.files, a.run));
  assert.equal(a.amendments.length, 1);
  assert.deepEqual({ ...a.amendments[0], at: 'x' }, { at: 'x', decision: DECISION, specSentence: SENTENCE, bodySha256: sha256Hex(`Ruling, per the spec:\n  the   carrier argument\nis optional in the spec.\n`), hashBefore: old.hash, hashAfter: a.hash });
  assert.equal(a.source.head, r.g('rev-parse', 'impl-510'));
  assert.equal(a.source.branch, 'impl-510');
  assert.equal(a.frozenAt, old.frozenAt, 'frozenAt stays the original freeze');
});

test('amend must-FAIL: a no-op amend (same bytes) ⇒ exit 2; amend of an unfrozen ticket ⇒ exit 1', (t) => {
  const r = rig(t);
  const same = runAcceptance(['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'writer-510'], r.deps());
  assert.equal(same.code, 2);
  assert.match(same.stderr, /changes nothing/);
  runFanout(['state', 'set', 'T9', '--status', 'todo'], r.deps());
  const none = runAcceptance(['amend', 'T9', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'writer-510'], r.deps());
  assert.equal(none.code, 1);
});

test('show: read-only; human + --json; a ticket without acceptance says so; unknown ticket ⇒ exit 1', (t) => {
  const r = rig(t);
  runFanout(['state', 'set', 'T9', '--status', 'todo'], r.deps());
  const before = JSON.stringify(r.state());
  const h = runAcceptance(['show', 'T510'], r.deps());
  assert.equal(h.code, 0);
  assert.match(h.stdout, /T510: frozen hash=/);
  assert.match(h.stdout, /t\/spec\.test\.js/);
  assert.deepEqual(JSON.parse(runAcceptance(['show', 'T510', '--json'], r.deps()).stdout), r.state()!.tickets.T510.acceptance);
  assert.match(runAcceptance(['show', 'T9'], r.deps()).stdout, /no frozen acceptance tests/);
  assert.equal(runAcceptance(['show', 'NOPE'], r.deps()).code, 1);
  assert.equal(JSON.stringify(r.state()), before);
});

test('state set must-FAIL: --json cannot write (or clear) acceptance; a hand-edited hash makes the state unreadable', (t) => {
  const r = rig(t);
  const before = JSON.stringify(r.state());
  const forged = { acceptance: { files: { 't/x.test.js': 'a'.repeat(64) }, hash: acceptanceHash({ 't/x.test.js': 'a'.repeat(64) }, 'node --test t/x.test.js'), run: 'node --test t/x.test.js', source: { branch: null, head: 'abc1234' }, frozenAt: NOW, amendments: [] } };
  const w = runFanout(['state', 'set', 'T510', '--json', JSON.stringify(forged)], r.deps());
  assert.equal(w.code, 1);
  assert.match(w.stderr, /unknown field "acceptance"/);
  assert.equal(runFanout(['state', 'set', 'T510', '--json', '{"acceptance":null}'], r.deps()).code, 1, 'clearing is refused too');
  assert.equal(JSON.stringify(r.state()), before);
  const raw = JSON.parse(fs.readFileSync(stateFile(r.home, 'r1'), 'utf8'));
  raw.tickets.T510.acceptance.files['t/spec.test.js'] = 'f'.repeat(64); // edit a frozen hash by hand, leave `hash` alone
  assert.throws(() => parseState(raw), /acceptance\.hash does not match/);
});

test('state: an older state file without `acceptance` still parses (null), and unrelated state set keeps a frozen set', (t) => {
  const r = rig(t);
  const raw = JSON.parse(fs.readFileSync(stateFile(r.home, 'r1'), 'utf8'));
  delete raw.tickets.T510.acceptance;
  assert.equal(parseState(raw).tickets.T510.acceptance, null);
  const set = runFanout(['state', 'set', 'T510', '--status', 'started'], r.deps());
  assert.equal(set.code, 0);
  assert.ok(r.state()!.tickets.T510.acceptance, 'state set keeps the frozen set');
});

test('help: the usage names every verb and the gate / deliver flags', () => {
  for (const s of ['acceptance freeze', 'acceptance amend', 'acceptance show', '--spec-sentence', '--decision']) assert.ok(ACCEPTANCE_USAGE.includes(s), s);
});

// ── review round (pre-review of the nomination) ───────────────────────────────────────────────────────────

test('gate must-FAIL: a skip-worktree file hides the head\'s DIFFERENT blob from `git status` — the gate also hashes the blob at HEAD ⇒ frozen-test-changed', async (t) => {
  const r = rig(t);
  fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), SPEC.replace('assert.equal(f(), 1)', 'assert.ok(true)'));
  const head = r.commitCand('weaken it');
  fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), SPEC); // the worktree shows the frozen bytes again …
  r.g('update-index', '--skip-worktree', 't/spec.test.js'); // … and git status is silent about it
  assert.equal(r.g('status', '--porcelain', '--untracked-files=no'), '');
  const { exit, result } = await gate(r, { head });
  assert.equal(exit, 2);
  assert.equal(result.reason, 'frozen-test-changed');
});

test('amend must-FAIL: a decision comment of ANOTHER repo than the vague\'s ⇒ exit 2; a `> `-quoted sentence still matches', (t) => {
  const r = rig(t);
  const s = r.state()!;
  writeStateAtomic(stateFile(r.home, 'r1'), { ...s, repo: 'o/r' });
  const before = JSON.stringify(r.state());
  const args = ['amend', 'T510', '--spec-sentence', SENTENCE, '--files', 't/spec.test.js,src/impl.js', '--from', r.cand];
  const other = runAcceptance([...args, '--decision', 'https://github.com/evil/elsewhere/issues/1#issuecomment-900'], r.deps());
  assert.equal(other.code, 2);
  assert.match(other.stderr, /not of this vague's repo o\/r/);
  assert.equal(JSON.stringify(r.state()), before);
  assert.equal(decisionNamesSentence('Ruling:\n> the carrier argument\n> is optional in the spec\n', SENTENCE).ok, true);
  assert.equal(decisionNamesSentence('We agreed the carrier is mandatory.', SENTENCE).ok, false);
});

test('freeze: a ticket the state does not name is created WITH a visible note (a typo shows up); a deliver on an unpushed head is could-not-check, not "test missing"', async (t) => {
  const r = rig(t);
  const f = runAcceptance(['freeze', 'T-typo', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js', '--from', 'writer-510'], r.deps());
  assert.equal(f.code, 0);
  assert.match(f.stdout, /ticket T-typo was not in the state.*created/);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const x = deliverRig(r, head, { commits404: true });
  const d = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: hashOf(r), ok: true }) }), x.deps);
  assert.equal(d.exit, 1);
  assert.equal(d.result.reason, 'gh-failed');
  assert.match(d.result.detail ?? '', /pushed/);
});

// ── fix round 1 (review c/7077873477) ─────────────────────────────────────────────────────────────────────

test('freeze/amend must-FAIL: a --run-cmd naming NONE of the frozen files (npm run x indirection) is refused; a direct runner call passes', (t) => {
  const r = rig(t, { freeze: false });
  const f = (cmd: string) => runAcceptance(['freeze', 'T510', '--files', 't/spec.test.js', '--run-cmd', cmd, '--from', 'writer-510'], r.deps());
  const bad = f('npm run accept');
  assert.equal(bad.code, 1);
  assert.match(bad.stderr, /not a direct runner call/);
  assert.equal(r.state()!.tickets.T510.acceptance, null, 'nothing written');
  assert.equal(f('node --test t/spec.test.js').code, 0);
  assert.equal(f('node --test t/spec.test.js --test-reporter=tap').code, 2, 'already frozen (a second freeze is the other refusal)');
  const amend = (extra: string[]) => runAcceptance(['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'writer-510', ...extra], r.deps());
  const before = JSON.stringify(r.state());
  assert.equal(amend(['--run-cmd', 'npm run accept']).code, 1);
  assert.equal(JSON.stringify(r.state()), before);
});

test('amend --run-cmd: replaces the command under the same decision rules (a command-only change is NOT a no-op; recorded as runAfter)', (t) => {
  const r = rig(t);
  const base = ['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'writer-510'];
  const old = r.state()!.tickets.T510.acceptance!;
  assert.equal(runAcceptance(base, r.deps()).code, 2, 'same files + same command = nothing to amend');
  assert.equal(runAcceptance([...base, '--run-cmd', 'node --test t/spec.test.js --test-reporter=tap'], r.deps({ 900: 'nothing relevant' })).code, 2, 'no decision quoting the sentence');
  const ok2 = runAcceptance([...base, '--run-cmd', 'node --test t/spec.test.js --test-reporter=tap'], r.deps());
  assert.equal(ok2.code, 0, ok2.stderr);
  const a = r.state()!.tickets.T510.acceptance!;
  assert.equal(a.run, 'node --test t/spec.test.js --test-reporter=tap');
  assert.notEqual(a.hash, old.hash, 'the command is part of the hash');
  assert.equal(a.amendments[0].runAfter, a.run);
});

test('amend must-FAIL: ONE decision authorises ONE amendment (a second amend with the same URL is refused, state unchanged); bodySha256 is recorded', (t) => {
  const r = rig(t);
  const body = `Decision: ${SENTENCE}.`;
  const go = (text: string) => { fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), `${SPEC}// ${text}\n`); r.commitCand(text); return runAcceptance(['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', r.cand], r.deps()); };
  assert.equal(go('first').code, 0);
  assert.equal(r.state()!.tickets.T510.acceptance!.amendments[0].bodySha256, sha256Hex(body));
  const before = JSON.stringify(r.state());
  const again = go('second');
  assert.equal(again.code, 2);
  assert.match(again.stderr, /already authorised an amendment/);
  assert.equal(JSON.stringify(r.state()), before);
});

test('gate: explicit --run with an unknown ticket / absent state ⇒ exit 1 bad-state (nothing skipped); WITHOUT --run an unknown ticket prints acceptance:{consulted:false} + logs, exit 0', async (t) => {
  const r = rig(t);
  const head = r.g('rev-parse', 'HEAD');
  const strict = await gate(r, { head, ticket: 'TT-typo' });
  assert.equal(strict.exit, 1);
  assert.equal(strict.result.reason, 'bad-state');
  const noRun = await gate(r, { head, ticket: 'TT-typo', run: null });
  assert.equal(noRun.exit, 0);
  assert.deepEqual(noRun.result.acceptance, { consulted: false });
  assert.ok(noRun.logs.some((l) => /NOT checked/.test(l)));
  const known = await gate(r, { head, ticket: 'T510', run: null });
  assert.equal((known.result.acceptance as { ok?: boolean }).ok, true, 'the own-run default still finds a known ticket');
});

// ── fix round 2 (delta review c/7077974470) ───────────────────────────────────────────────────────────────

const FILES = ['test/acc.test.js'];
const SPELLINGS_REFUSED = [
  'npm run accept test/acc.test.js', "sh -c 'npm run accept' test/acc.test.js", 'npm run accept # test/acc.test.js', 'make accept ACC=test/acc.test.js',
  'ACC=test/acc.test.js npm run accept', 'true test/acc.test.js', 'node scripts/run.js mytest/acc.test.js.bak', 'node --test test/acc.test.js; true', 'node --test test/acc.test.js && true',
  'node --test test/acc.test.js | cat', 'node --test $(echo test/acc.test.js)', 'node --test `echo test/acc.test.js`', 'node --test "test/acc.test.js"', "node --test 'test/acc.test.js'",
  'node --test test/*.test.js', 'node -e require("./x") test/acc.test.js', 'node --require=./evil.js test/acc.test.js', 'node -r ./evil.js test/acc.test.js', 'node --import=./evil.mjs test/acc.test.js',
  'node --test-reporter tap test/acc.test.js', 'node test/acc.test.js extra.js', 'env node --test test/acc.test.js', 'bash test/acc.test.js', 'npx some-pkg test/acc.test.js', 'npm exec node test/acc.test.js',
  'pnpm test test/acc.test.js', 'pnpm exec bash test/acc.test.js', 'node --test', 'node --test ../acc.test.js', 'vitest --config=./vitest.evil.ts test/acc.test.js', 'jest --setupFiles=./x.js test/acc.test.js',
  'node --test test/acc.test.js\nnode x', 'node\t--test test/acc.test.js', 'node --test test/acc.test.js > /dev/null', 'node --test test/acc.test.js &', 'FOO=1 node --test test/acc.test.js',
];
const SPELLINGS_OK = ['node --test test/acc.test.js', 'node --test --test-reporter=tap test/acc.test.js', 'vitest run --reporter=dot test/acc.test.js', 'python3 -I -m pytest -q test/acc.test.js', 'python -I -m unittest -v test/acc.test.js', 'tsx test/acc.test.js'];

test('run-cmd must-FAIL: every reviewer spelling of an indirection (and more) is refused as a non-direct runner call; direct calls pass', () => {
  for (const c of SPELLINGS_REFUSED) assert.throws(() => parseRunArgv(c, FILES), /not a direct runner call/, c);
  for (const c of SPELLINGS_OK) assert.deepEqual(parseRunArgv(c, FILES), c.split(' '), c);
  assert.throws(() => parseRunArgv('node --test test/acc.test.js', ['other.test.js']), /not a frozen file/);
});

test('run-cmd: freeze and amend refuse each reviewer spelling through the CLI (nothing written), the state loader refuses a hand-edited one', (t) => {
  const r = rig(t, { freeze: false });
  const f = (cmd: string) => runAcceptance(['freeze', 'T510', '--files', 't/spec.test.js', '--run-cmd', cmd, '--from', 'writer-510'], r.deps());
  for (const c of ['npm run accept t/spec.test.js', "sh -c 'npm run accept' t/spec.test.js", 'npm run accept # t/spec.test.js', 'make accept ACC=t/spec.test.js', 'ACC=t/spec.test.js npm run accept', 'true t/spec.test.js', 'node scripts/run.js xt/spec.test.js.bak']) {
    const x = f(c);
    assert.equal(x.code, 1, c);
    assert.match(x.stderr, /not a direct runner call/, c);
  }
  assert.equal(r.state()!.tickets.T510.acceptance, null);
  assert.equal(f('node --test t/spec.test.js').code, 0);
  const raw = JSON.parse(fs.readFileSync(stateFile(r.home, 'r1'), 'utf8'));
  raw.tickets.T510.acceptance.run = 'sh -c true t/spec.test.js';
  raw.tickets.T510.acceptance.hash = acceptanceHash(raw.tickets.T510.acceptance.files, raw.tickets.T510.acceptance.run); // a CONSISTENT hash: only the argv rule can refuse it
  assert.throws(() => parseState(raw), /not a direct runner call/);
});

test('gate: the frozen command is executed as an ARGV, never through a shell', () => {
  const calls: string[][] = [];
  const bytes = Buffer.from(SPEC);
  const acc = { files: { 't/spec.test.js': sha256Hex(bytes) }, hash: '', run: 'node --test t/spec.test.js', source: { branch: null, head: 'abc1234' }, frozenAt: NOW, amendments: [] };
  acc.hash = acceptanceHash(acc.files, acc.run);
  const HEAD = 'a'.repeat(40);
  const io = {
    git: (args: string[]) => ({ code: 0, stdout: args[0] === 'rev-parse' ? (args.includes('--show-toplevel') ? os.tmpdir() : HEAD) : args[0] === 'ls-tree' ? `100644 blob ${'b'.repeat(40)}\tt/spec.test.js\0` : args[0] === 'show' ? SPEC : '' }),
    readFile: () => bytes,
    run: (argv: string[]) => { calls.push(argv); return { exit: 0, tail: '' }; },
  };
  const out = checkAcceptanceInCheckout(acc, { cwd: os.tmpdir(), head: HEAD }, io);
  assert.equal(out.ok, true, JSON.stringify(out));
  assert.deepEqual(calls, [['node', '--test', 't/spec.test.js']]);
});

test('amend must-FAIL: one decision comment authorises ONE amendment however its URL is spelled (issues/pull, case, number)', (t) => {
  const r = rig(t);
  const go = (url: string, text: string) => { fs.writeFileSync(path.join(r.cand, 't/spec.test.js'), `${SPEC}// ${text}\n`); r.commitCand(text); return runAcceptance(['amend', 'T510', '--decision', url, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', r.cand], r.deps()); };
  assert.equal(go('https://github.com/o/r/issues/511#issuecomment-900', 'one').code, 0);
  const before = JSON.stringify(r.state());
  for (const [i, u] of ['https://github.com/o/r/pull/9#issuecomment-900', 'https://github.com/O/R/issues/2#issuecomment-900', 'https://github.com/o/r/issues/1#issuecomment-0900', 'https://github.com/o/r/issues/1#issuecomment-00900'].entries()) {
    const x = go(u, `again ${i}`);
    assert.equal(x.code, 2, u);
    assert.match(x.stderr, /already authorised/);
  }
  assert.equal(JSON.stringify(r.state()), before);
});

test('gate without --run: a verifier (own ws id, no state) reads the INHERITED run for the acceptance clause and runs it', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const saved = { ws: process.env.ORCHESTRA_WS_ID, run: process.env.ORCHESTRA_RUN_ID };
  process.env.ORCHESTRA_WS_ID = 'verifier-ws';
  process.env.ORCHESTRA_RUN_ID = 'r1';
  try {
    const head = r.g('rev-parse', 'HEAD');
    const ok = await gate(r, { head, run: null });
    assert.equal(ok.exit, 0);
    assert.equal((ok.result.acceptance as { ok?: boolean }).ok, true, 'the clause ran through the inherited run');
    fs.writeFileSync(path.join(r.cand, 'src/impl.js'), 'exports.f = () => 2;\n');
    const red = await gate(r, { head: r.commitCand('red'), run: null });
    assert.equal(red.exit, 2);
    assert.equal(red.result.reason, 'frozen-test-failed');
  } finally {
    process.env.ORCHESTRA_WS_ID = saved.ws;
    if (saved.run === undefined) delete process.env.ORCHESTRA_RUN_ID; else process.env.ORCHESTRA_RUN_ID = saved.run;
  }
});

test('receipt binds the command: a receipt gated under the OLD command is stale after amend --run-cmd (hash includes run)', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head = r.g('rev-parse', 'HEAD');
  const oldHash = hashOf(r);
  const am = runAcceptance(['amend', 'T510', '--decision', DECISION, '--spec-sentence', SENTENCE, '--files', 't/spec.test.js', '--from', 'writer-510', '--run-cmd', 'node --test --test-reporter=tap t/spec.test.js'], r.deps());
  assert.equal(am.code, 0, am.stderr);
  const x = deliverRig(r, head);
  const d = await deliver(dopts(head, { acceptance: writeReceipt(r, { head, hash: oldHash, ok: true }) }), x.deps);
  assert.equal(d.exit, 2);
  assert.equal(d.result.reason, 'acceptance-stale');
});
