// #540 — `fanout acceptance amend --harness-only`: the mechanical assertion check, the recorded amend, and the automatic pickup by gate + deliver.
// REAL git (writer repo + candidate clone), the production state reader + dep wiring; only `gh` is faked. Rig on the built CLI + mutants: scripts/e2e-fanout-harness-amend.mjs.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { defaultRunner, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runAcceptance } from './fanout-acceptance.ts';
import { deliver, realDeps, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, realGateDeps, type GateOpts } from './fanout-gate.ts';
import { acceptableBytes } from '../shared/fanout-acceptance.ts';
import { applyTicketPatch, newState, readState, sha256Hex, stateFile, writeStateAtomic } from '../shared/fanout-state.ts';

const NOW = '2026-11-22T10:00:00.000Z';
const GIT_ENV = { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
const git = (cwd: string) => (...a: string[]): string => execFileSync('git', a, { cwd, env: GIT_ENV, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();

/** The frozen test: the body appends its HARNESS tag to a marker beside the scratch root, so "which bytes ran" is observable. */
const spec = (tag: string, extraSetup = ''): string => `const test = require('node:test');
const assert = require('node:assert');
const fs = require('node:fs');
const path = require('node:path');
const { f } = require('../src/impl.js');
const HARNESS = '${tag}';
${extraSetup}
test('f returns what the spec says', () => {
  fs.appendFileSync(path.join(__dirname, '..', '..', 'marker.txt'), HARNESS + '\\n');
  assert.equal(f(), 1);
  assert.ok(typeof f === 'function');
});
`;
const V0 = spec('v0');
const V1 = spec('v1', 'const warm = true; // harness-only: new setup');
const V2 = spec('v2', 'const warm = true;\nconst cool = false;');

interface Rig {
  root: string; home: string; writer: string; cand: string; env: NodeJS.ProcessEnv; marker: string;
  g: (...a: string[]) => string; w: (...a: string[]) => string;
  deps: () => FanoutDeps;
  /** commit `text` as t/spec.test.js on the writer branch */
  writerCommit: (text: string) => void;
  amend: (extra?: string[]) => { code: number; stdout: string; stderr: string; hostCalls?: unknown[] };
  /** the candidate commits `text` as t/spec.test.js (+ its code) and returns the head */
  candHolds: (text: string) => string;
  acc: () => NonNullable<NonNullable<ReturnType<typeof readState>>['tickets'][string]['acceptance']>;
}

function rig(t: { after: (fn: () => void) => void }): Rig {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'harness-540-'));
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
  w('checkout', '-q', '-b', 'writer-540');
  fs.mkdirSync(path.join(writer, 't'));
  const writerCommit = (text: string): void => { fs.writeFileSync(path.join(writer, 't/spec.test.js'), text); w('add', '.'); w('commit', '-q', '-m', 'writer: tests'); };
  writerCommit(V0);
  execFileSync('git', ['clone', '-q', writer, cand], { env: GIT_ENV });
  const g = git(cand);
  g('checkout', '-q', '-b', 'impl-540', 'origin/master');
  fs.mkdirSync(path.join(cand, 't'));
  fs.writeFileSync(path.join(cand, 'src/impl.js'), 'exports.f = () => 1;\n');
  fs.writeFileSync(path.join(cand, 't/spec.test.js'), V0);
  g('add', '.'); g('commit', '-q', '-m', 'impl: tests copied + code');
  const env = { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' };
  writeStateAtomic(stateFile(home, 'r1'), applyTicketPatch(newState('r1', { now: NOW }), 'T540', { branch: 'impl-540' }, NOW));
  const runner: Runner = (cmd, args, cwd) => (cmd === 'git' ? defaultRunner(cmd, args, cwd) : { code: 1, stdout: '', stderr: 'gh: not used' });
  const deps = (): FanoutDeps => ({ env, cwd: writer, runner, now: () => NOW, readStdin: () => '' });
  const frozen = runAcceptance(['freeze', 'T540', '--files', 't/spec.test.js', '--run-cmd', 'node --test t/spec.test.js', '--from', 'writer-540'], deps());
  assert.equal(frozen.code, 0, frozen.stderr);
  const rg: Rig = {
    root, home, writer, cand, env, g, w, deps, writerCommit, marker: path.join(root, 'marker.txt'),
    amend: (extra = []) => runAcceptance(['amend', 'T540', '--harness-only', '--reason', 'composition needs the shared db booted first', '--files', 't/spec.test.js', '--from', 'writer-540', ...extra], deps()),
    candHolds: (text) => { fs.writeFileSync(path.join(cand, 't/spec.test.js'), text); g('add', '-A'); g('commit', '-q', '--allow-empty', '-m', 'cand'); return g('rev-parse', 'HEAD'); },
    acc: () => readState(stateFile(home, 'r1'))!.tickets.T540.acceptance!,
  };
  return rg;
}

const ok = (stdout: string): GhResult => ({ code: 0, stdout, stderr: '' });
const gateGh = async (args: string[]): Promise<GhResult> => {
  if (args[0] === 'api') return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' };
  if (args[0] === 'pr' && args[1] === 'list') return ok('[]');
  return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
};
async function gate(r: Rig, head: string) {
  Object.assign(process.env, r.env);
  r.g('checkout', '-q', '--detach', head);
  const opts: GateOpts = { branch: 'impl-540', into: 'master', head, requireChecks: [], ticket: 'T540', run: 'r1', cwd: r.cand, setupCmd: undefined } as GateOpts;
  return gatePr(opts, { ...realGateDeps(), gh: gateGh, log: () => {}, sleep: async () => {} });
}
const marks = (r: Rig): string[] => (fs.existsSync(r.marker) ? fs.readFileSync(r.marker, 'utf8').split('\n').filter(Boolean) : []);

function deliverRig(r: Rig, prHead: string) {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    if (a === 'api') {
      if (/\/commits\/[0-9a-f]{40}$/.test(args[args.length - 1])) return ok('{}');
      const m = /\/contents\/(.+)\?ref=([0-9a-f]{40})$/.exec(args[args.length - 1]);
      if (m) { try { return ok(execFileSync('git', ['show', `${m[2]}:${decodeURIComponent(m[1])}`], { cwd: r.cand, env: GIT_ENV, encoding: 'utf8' })); } catch { return { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' }; } }
      return { code: 1, stdout: '', stderr: 'HTTP 404' };
    }
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: prHead }]));
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: prHead, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const deps: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: () => {} };
  return { deps };
}
const dopts = (head: string, o: Partial<DeliverOpts> = {}): DeliverOpts => ({
  branch: 'impl-540', into: 'master', ticket: 'T540', verifiedHead: head, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 30_000, requireChecks: [], run: 'r1', ...o,
});
const receiptFile = (r: Rig, receipt: unknown): string => { const f = path.join(r.root, `receipt-${Math.random().toString(36).slice(2)}.json`); fs.writeFileSync(f, JSON.stringify(receipt)); return f; };

// ── the amend ─────────────────────────────────────────────────────────────────────────────────────────────

test('amend --harness-only must-PASS: a setup-only change is recorded {kind, assertionsHash, reason, filesBefore, hashBefore/After}, hash changes, source follows, host told', (t) => {
  const r = rig(t);
  const before = r.acc();
  r.writerCommit(V1);
  const res = r.amend();
  assert.equal(res.code, 0, res.stderr);
  const a = r.acc();
  assert.notEqual(a.hash, before.hash);
  assert.deepEqual(a.files, { 't/spec.test.js': sha256Hex(V1) });
  assert.equal(a.amendments.length, 1);
  const m = a.amendments[0];
  assert.equal(m.kind, 'harness-only');
  if (m.kind !== 'harness-only') return;
  assert.equal(m.reason, 'composition needs the shared db booted first');
  assert.match(m.assertionsHash, /^[0-9a-f]{64}$/);
  assert.deepEqual(m.filesBefore, before.files);
  assert.equal(m.hashBefore, before.hash);
  assert.equal(m.hashAfter, a.hash);
  assert.equal(a.source.head, r.w('rev-parse', 'writer-540'));
  assert.deepEqual(res.hostCalls, [{ route: '/fanoutAcceptance', body: { op: 'amended', run: 'r1', ticket: 'T540', from: 'r1' } }]);
  assert.match(res.stdout, /2 assertion statement\(s\) byte-identical/);
  assert.match(res.stdout, /WHAT YOU ATTEST.*\n[\s\S]*\+ t\/spec\.test\.js: const warm = true;/);
  assert.ok(m.lines && m.lines.added >= 1, 'the changed non-assertion lines are recorded');
  const acceptable = acceptableBytes(a);
  assert.deepEqual([...acceptable['t/spec.test.js']].sort(), [sha256Hex(V0), sha256Hex(V1)].sort());
  assert.ok(readState(stateFile(r.home, 'r1')), 'the state still parses (new amendment shape is a valid document)');
});

test('amend --harness-only must-FAIL: a changed / added / removed / reordered assertion is refused (exit 2), the state untouched', (t) => {
  const r = rig(t);
  const hash = r.acc().hash;
  for (const [what, text] of [
    ['modified', V0.replace('assert.equal(f(), 1)', 'assert.equal(f(), 2)')],
    ['added', V0.replace('assert.equal(f(), 1);', 'assert.equal(f(), 1);\n  assert.ok(true);')],
    ['modified', V0.replace('assert.equal(f(), 1)', 'assert.strictEqual(f(), 1)')],
    ['removed', V0.replace("  assert.ok(typeof f === 'function');\n", '')],
    ['reordered', V0.replace("  assert.equal(f(), 1);\n  assert.ok(typeof f === 'function');\n", "  assert.ok(typeof f === 'function');\n  assert.equal(f(), 1);\n")],
    ['modified', V0.replace("test('f returns what the spec says'", "test('f returns something else'")],
    ['modified', V0.replace("test('f returns what the spec says'", "test.skip('f returns what the spec says'")],
  ] as const) {
    r.writerCommit(text);
    const res = r.amend();
    assert.equal(res.code, 2, `${what}: ${res.stderr}`);
    assert.match(res.stderr, new RegExp(`not a harness-only change \\(${what}\\)`));
    assert.match(res.stderr, /decision amend/);
    assert.equal(r.acc().hash, hash);
    assert.equal(r.acc().amendments.length, 0);
  }
});

test('amend --harness-only must-FAIL: a decision / spec-sentence / run-cmd flag, no reason, a changed file set, and an unknown shape (unlexable bytes) are all refused', (t) => {
  const r = rig(t);
  // flags that belong to the other mode
  r.writerCommit(V1);
  for (const extra of [['--decision', 'https://github.com/o/r/issues/1#issuecomment-1'], ['--spec-sentence', 'the carrier argument is optional'], ['--run-cmd', 'node --test t/spec.test.js']]) {
    const res = r.amend(extra);
    assert.equal(res.code, 2, extra[0]);
    assert.match(res.stderr, /cannot go with --harness-only/);
  }
  assert.equal(runAcceptance(['amend', 'T540', '--harness-only', '--files', 't/spec.test.js', '--from', 'writer-540'], r.deps()).code, 2); // no --reason
  assert.equal(r.acc().amendments.length, 0);
  // a second file added to the set: the file set is frozen
  fs.writeFileSync(path.join(r.writer, 't/other.test.js'), V1); r.w('add', '.'); r.w('commit', '-q', '-m', 'other');
  const res = runAcceptance(['amend', 'T540', '--harness-only', '--reason', 'r', '--files', 't/spec.test.js,t/other.test.js', '--from', 'writer-540'], r.deps());
  assert.equal(res.code, 2);
  assert.match(res.stderr, /SAME file set/);
  // unknown shape: the new bytes make the file unlexable
  r.writerCommit(V1.replace("'v1'", "'v1"));
  const un = r.amend();
  assert.equal(un.code, 2);
  assert.match(un.stderr, /unknown-shape|could not tokenise/);
});

test('amend --harness-only must-FAIL: a no-op (same bytes) ⇒ exit 2; the full amend (decision) is unchanged for a ticket that also has harness amends', (t) => {
  const r = rig(t);
  assert.equal(r.amend().code, 2); // writer-540 still holds V0: nothing changed
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  assert.equal(r.amend().code, 2); // the same bytes again
});

// ── the pickup ────────────────────────────────────────────────────────────────────────────────────────────

test('gate must-PASS: a candidate still holding the PREVIOUS recorded bytes passes with NO copy — the amended bytes are the ones run, the candidate is restored', async (t) => {
  const r = rig(t);
  const head0 = r.candHolds(V0);
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  const { exit, result } = await gate(r, head0);
  assert.equal(exit, 0, JSON.stringify(result));
  assert.equal(result.acceptance && 'ok' in result.acceptance && result.acceptance.ok, true);
  const acc = result.acceptance as { files: Array<{ status: string }>; amendedFrom?: { files: string[] }; receipt: { hash: string; head: string } };
  assert.deepEqual(acc.files.map((f) => f.status), ['previous']);
  assert.deepEqual(acc.amendedFrom?.files, ['t/spec.test.js']);
  assert.deepEqual(marks(r), ['v1'], 'the AMENDED bytes ran, not the candidate\'s v0');
  assert.equal(acc.receipt.hash, r.acc().hash);
  assert.equal(fs.readFileSync(path.join(r.cand, 't/spec.test.js'), 'utf8'), V0, 'the candidate checkout got its own bytes back');
  assert.equal(r.g('status', '--porcelain', '--untracked-files=no'), '', 'and is clean');
});

test('gate: a candidate holding the CURRENT bytes is unchanged (same, nothing overlaid); one holding ARBITRARY edited bytes is frozen-test-changed and nothing runs', async (t) => {
  const r = rig(t);
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  const cur = r.candHolds(V1);
  const g1 = await gate(r, cur);
  assert.equal(g1.exit, 0);
  assert.deepEqual((g1.result.acceptance as { files: Array<{ status: string }> }).files.map((f) => f.status), ['same']);
  assert.equal('amendedFrom' in (g1.result.acceptance as object), false);
  assert.deepEqual(marks(r), ['v1']);
  fs.rmSync(r.marker);
  const bad = r.candHolds(V0.replace('const HARNESS', 'const EXTRA = 1;\nconst HARNESS')); // none of the recorded versions
  const g2 = await gate(r, bad);
  assert.equal(g2.exit, 2);
  assert.equal(g2.result.reason, 'frozen-test-changed');
  assert.deepEqual(marks(r), [], 'nothing ran');
  // …and a version from BEFORE the recorded chain's first version is likewise arbitrary
  const evil = r.candHolds(V0.replace('assert.equal(f(), 1)', 'assert.ok(true)'));
  assert.equal((await gate(r, evil)).result.reason, 'frozen-test-changed');
});

test('gate: the chain — v0, v1, v2 recorded by two harness amends: v0 and v1 candidates pass (v2 ran); after a DECISION amend the chain is cut (v0 / v1 ⇒ frozen-test-changed)', async (t) => {
  const r = rig(t);
  const h0 = r.candHolds(V0);
  r.writerCommit(V1); assert.equal(r.amend().code, 0);
  const h1 = r.candHolds(V1);
  r.writerCommit(V2); assert.equal(r.amend().code, 0);
  for (const h of [h0, h1]) {
    fs.rmSync(r.marker, { force: true });
    const g = await gate(r, h);
    assert.equal(g.exit, 0, JSON.stringify(g.result));
    assert.deepEqual(marks(r), ['v2']);
  }
  // a decision amend (the assertion changes): older candidates must re-copy
  const V3 = V2.replace('assert.equal(f(), 1)', 'assert.equal(f(), 1);\n  assert.ok(f)');
  r.writerCommit(V3);
  const dec = runAcceptance(['amend', 'T540', '--decision', 'https://github.com/o/r/issues/1#issuecomment-900', '--spec-sentence', 'f must be a function and return one', '--files', 't/spec.test.js', '--from', 'writer-540'], {
    ...r.deps(), runner: (cmd, args, cwd) => (cmd === 'git' ? defaultRunner(cmd, args, cwd) : { code: 0, stdout: JSON.stringify({ body: 'Decision: f must be a function and return one.' }), stderr: '' }),
  });
  assert.equal(dec.code, 0, dec.stderr);
  for (const h of [h0, h1]) assert.equal((await gate(r, h)).result.reason, 'frozen-test-changed');
});

test('gate: an unobtainable amended source (pruned / unreachable) fails closed acceptance-unproven, never a pass on the candidate\'s old bytes', async (t) => {
  const r = rig(t);
  const head0 = r.candHolds(V0);
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  r.w('checkout', '-q', 'master');
  r.w('branch', '-D', 'writer-540'); // the branch holding the amended bytes is gone from the shared location
  r.w('reflog', 'expire', '--expire=now', '--all');
  r.w('gc', '--prune=now', '-q');
  const g = await gate(r, head0);
  assert.equal(g.exit, 2);
  assert.equal(g.result.reason, 'acceptance-unproven');
  assert.deepEqual(marks(r), []);
});

test('deliver: a receipt gated AFTER the amend, a candidate PR head still holding the previous bytes ⇒ merged; the old receipt ⇒ acceptance-stale; arbitrary bytes ⇒ frozen-test-changed', async (t) => {
  const r = rig(t);
  Object.assign(process.env, r.env);
  const head0 = r.candHolds(V0);
  const oldReceipt = { head: head0, hash: r.acc().hash, ok: true }; // what a gate issued BEFORE the amend
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  const g = await gate(r, head0);
  assert.equal(g.exit, 0, JSON.stringify(g.result));
  const fresh = (g.result.acceptance as { receipt: unknown }).receipt;
  const x = deliverRig(r, head0);
  const stale = await deliver(dopts(head0, { acceptance: receiptFile(r, oldReceipt) }), x.deps);
  assert.equal(stale.exit, 2);
  assert.equal(stale.result.reason, 'acceptance-stale');
  const merged = await deliver(dopts(head0, { acceptance: receiptFile(r, fresh) }), x.deps);
  assert.equal(merged.exit, 0, JSON.stringify(merged.result));
  assert.equal(merged.result.verdict, 'merged');
  assert.equal(merged.result.acceptanceChecked, true);
  const bad = r.candHolds(V0.replace('const HARNESS', 'const EXTRA = 1;\nconst HARNESS'));
  const y = deliverRig(r, bad);
  const refused = await deliver(dopts(bad, { acceptance: receiptFile(r, { ...(fresh as object), head: bad }) }), y.deps);
  assert.equal(refused.exit, 2);
  assert.equal(refused.result.reason, 'frozen-test-changed');
});

test('state: the harness-only amendment shape round-trips through the parser; a hand-edited one (missing reason / bad filesBefore / unknown key) is refused', (t) => {
  const r = rig(t);
  r.writerCommit(V1);
  assert.equal(r.amend().code, 0);
  const file = stateFile(r.home, 'r1');
  const good = JSON.parse(fs.readFileSync(file, 'utf8'));
  assert.ok(readState(file));
  for (const mut of [(a: Record<string, unknown>) => { delete a.reason; }, (a: Record<string, unknown>) => { a.filesBefore = {}; }, (a: Record<string, unknown>) => { a.surprise = 1; }, (a: Record<string, unknown>) => { a.assertionsHash = 'xx'; }]) {
    const bad = JSON.parse(JSON.stringify(good));
    mut(bad.tickets.T540.acceptance.amendments[0]);
    fs.writeFileSync(file, JSON.stringify(bad));
    assert.throws(() => readState(file));
  }
});

// ── #542 seam: a ticket whose command names a runner config keeps it (and a hash that includes it) across a harness-only amend ──────────────────

test('amend --harness-only on a ticket with a recorded runner config keeps the config in the identity: the state still parses, the hash includes the config', async () => {
  const { freezeInto, amendHarnessInto } = await import('../shared/fanout-acceptance.ts');
  const { acceptanceHash, newState, parseState } = await import('../shared/fanout-state.ts');
  const config = { path: 'jest.config.js', sha256: sha256Hex('module.exports = {};\n') };
  const run = 'jest --config jest.config.js t/spec.test.js';
  const files0 = { 't/spec.test.js': sha256Hex(V0) };
  const source = { branch: 'writer-540', head: 'a'.repeat(40) };
  const s0 = freezeInto(applyTicketPatch(newState('r1', { now: NOW }), 'T540', {}, NOW), 'T540', { files: files0, run, config, source, now: NOW });
  const s1 = amendHarnessInto(s0, 'T540', { files: { 't/spec.test.js': sha256Hex(V1) }, reason: 'boot the db', assertionsHash: 'b'.repeat(64), source, now: NOW });
  const acc = s1.tickets.T540.acceptance!;
  assert.deepEqual(acc.config, config);
  assert.equal(acc.hash, acceptanceHash({ 't/spec.test.js': sha256Hex(V1) }, run, config));
  assert.doesNotThrow(() => parseState(JSON.parse(JSON.stringify(s1))));
});
