// #572 — `minorPolicy=demonstrated`: a finding of ANY severity with an accepted demonstration {input, observed, expected} blocks `gate` + `deliver` like a MAJOR until settled or decided.
// Every arm drives the production path: `state set --finding-json|--settle|--decide|show`, `closeout`, the gate + deliver follow-up reader, the skill render. Mutants of every clause: scripts/e2e-fanout-switches.mjs (#572 arms).
// must-PASS: accepted MINOR blocks, passes after settle / decision; a MINOR with no demonstration, BLOCKING/MAJOR without one: as today; default / refuse / spec renders byte-identical.
// must-FAIL: blank / under-floor / test file / absent file / identical fields → not accepted (plain MINOR, reason recorded); switch changed after the first spawn → refused.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileOnHead, runFanout, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runCloseout } from './fanout-closeout.ts';
import { deliver, realDeps, type DeliverDeps, type DeliverOpts, type GhResult } from './fanout-deliver.ts';
import { gatePr, realGateDeps, type GateOpts } from './fanout-gate.ts';
import { DEFAULT_SWITCHES, SWITCH_VALUES, V378_DEFAULT_SWITCHES, applyTicketPatch, blockingMinors, mergeBlockRefusal, newState, parseState, readState, stateFile, switchesOf, type Switches } from '../shared/fanout-state.ts';
import { DEMONSTRATION_LIMIT, citationsOf, classifyDemonstration, classifyPath } from '../shared/fanout-demonstration.ts';
import { renderSwitchBlocks } from '../shared/fanout-switch-render.ts';
import { renderVerifiedFanoutSkill } from '../shared/verified-fanout-skill.ts';
import { VERIFIED_FANOUT_V2_REFERENCES } from '../shared/verified-fanout-files.ts';
import { FANOUT_USAGE } from './fanout-state.ts';

const NOW = '2026-11-24T10:00:00.000Z';
const A = 'a'.repeat(40);
const B = 'b'.repeat(40);
const sha = (s: string): string => createHash('sha256').update(s).digest('hex');
const norm = (s: string): string => s.replace(/\s+/g, ' ');

/** The git the CLI sees: every head is a local commit; `cat-file -e <head>:<path>` answers from FILES (product, a test, a doc). */
const FILES = new Set(['src/orders/service.ts', 'src/orders/service.test.ts', 'docs/orders.md', 'src/orders/list.ts']);
const gitFake: Runner = (cmd, args) => {
  if (cmd === 'git' && args[0] === 'rev-parse') return { code: 0, stdout: `${'e'.repeat(40)}\n`, stderr: '' };
  if (cmd === 'git' && args[0] === 'ls-tree') { const p = args[args.length - 1]; const row = (mode: string, type: string): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout: `${mode} ${type} ${'f'.repeat(40)}\t${p}\0`, stderr: '' }); return FILES.has(p) ? row('100644', 'blob') : p === 'src/dir.d' ? row('040000', 'tree') : p === 'src/link.ts' ? row('120000', 'blob') : { code: 0, stdout: '', stderr: '' }; }
  return { code: 1, stdout: '', stderr: 'offline' };
};
function mkHome(t: { after: (fn: () => void) => void }): string {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-demo-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
}
const deps = (home: string, runner: Runner = gitFake): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' }, cwd: home, runner, now: () => NOW, readStdin: () => '' });
const init = (d: FanoutDeps, sw?: string) => runFanout(['state', 'init', '--run', 'r1', ...(sw ? ['--switch', sw] : [])], d);
const set = (d: FanoutDeps, ...a: string[]) => runFanout(['state', 'set', '--run', 'r1', ...a], d);
const show = (d: FanoutDeps) => runFanout(['state', 'show', '--run', 'r1'], d).stdout;
const stateOf = (home: string) => readState(stateFile(home, 'r1'))!;
function withEnv<T>(home: string, fn: () => T): T {
  const prev = { h: process.env.ORCHESTRA_HOME, w: process.env.ORCHESTRA_WS_ID };
  process.env.ORCHESTRA_HOME = home; process.env.ORCHESTRA_WS_ID = 'r1';
  const restore = (): void => { for (const [k, v] of [['ORCHESTRA_HOME', prev.h], ['ORCHESTRA_WS_ID', prev.w]] as const) { if (v === undefined) delete process.env[k]; else process.env[k] = v; } };
  try { const r = fn(); if (r instanceof Promise) return r.finally(restore) as T; restore(); return r; } catch (e) { restore(); throw e; }
}

const DEMO = { input: 'GET /orders?limit=0 as an authenticated user', observed: 'src/orders/service.ts:42 returns every order instead of an empty page', expected: 'the ticket says limit=0 must return an empty page' };
const finding = (severity: string, demonstration: Partial<typeof DEMO> | null = {}): string => JSON.stringify({ F1: { severity, ...(demonstration ? { demonstration: { ...DEMO, ...demonstration } } : {}) } });
/** A run on `minorPolicy=demonstrated` (+ `extra`), T1 nominated on head A. */
function run(t: { after: (fn: () => void) => void }, extra = ''): { home: string; d: FanoutDeps } {
  const home = mkHome(t);
  const d = deps(home);
  assert.equal(init(d, `minorPolicy=demonstrated${extra}`).code, 0);
  assert.equal(set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A).code, 0);
  return { home, d };
}

// ── deliver / gate rigs ──────────────────────────────────────────────────────────────────────────────────
function rig(head = A) {
  let merged = false;
  const gh = async (args: string[]): Promise<GhResult> => {
    const [a, b] = args;
    const ok = (s: string): GhResult => ({ code: 0, stdout: s, stderr: '' });
    if (a === 'api') return { code: 1, stdout: '', stderr: 'HTTP 404' };
    if (a === 'pr' && b === 'list') return ok(JSON.stringify([{ number: 7, url: 'https://github.com/o/r/pull/7', state: merged ? 'MERGED' : 'OPEN', headRefOid: head }]));
    if (a === 'pr' && b === 'view') {
      if (args.includes('state,mergeCommit')) return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', mergeCommit: { oid: 'c'.repeat(40) } }));
      return ok(JSON.stringify({ state: merged ? 'MERGED' : 'OPEN', baseRefName: 'master', headRefOid: head, mergeable: 'MERGEABLE', statusCheckRollup: [{ __typename: 'CheckRun', name: 'ci', status: 'COMPLETED', conclusion: 'SUCCESS', detailsUrl: 'https://github.com/o/r/actions/runs/900/job/901' }] }));
    }
    if (a === 'run' && b === 'view') return ok(JSON.stringify({ jobs: [{ databaseId: 901, steps: [{ name: 'Set up job', conclusion: 'success' }, { name: 'Run tests', conclusion: 'success' }] }] }));
    if (a === 'pr' && b === 'merge') { merged = true; return ok(''); }
    return { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` };
  };
  const dd: DeliverDeps = { ...realDeps(), gh, sleep: async () => {}, now: () => 0, log: () => {} };
  return { dd, merged: () => merged };
}
const dopts = (o: Partial<DeliverOpts> = {}): DeliverOpts => ({ branch: 't1', into: 'master', ticket: 'T1', verifiedHead: A, noReviewGate: true, strategy: 'merge', timeoutMs: 600_000, intervalMs: 10_000, noChecksGraceMs: 0, requireChecks: [], run: 'r1', ...o });
const verdictFile = (dir: string): string => { const f = path.join(dir, 'verdict.json'); fs.writeFileSync(f, JSON.stringify({ round: 1, blocking: 0, major: 0, minor: 2, head: A })); return f; };
const gateGh = async (args: string[]): Promise<GhResult> => (args[0] === 'pr' && args[1] === 'list' ? { code: 0, stdout: '[]', stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 404' });
async function gate(home: string, head: string) {
  const opts: GateOpts = { branch: 't1', into: 'master', head, requireChecks: [], ticket: 'T1', run: 'r1', settleMs: 0 };
  return withEnv(home, () => gatePr(opts, { ...realGateDeps(), gh: gateGh, log: () => {}, now: () => Date.parse(NOW), sleep: async () => {} }));
}
async function tryDeliver(home: string, o: Partial<DeliverOpts> = {}) {
  const r = rig(o.verifiedHead ?? A);
  const out = await withEnv(home, () => deliver(dopts(o), r.dd));
  return { out, merged: r.merged() };
}

// ── the switch ───────────────────────────────────────────────────────────────────────────────────────────
test('the value exists; the defaults of both profiles are untouched (legacy / spec); a bogus value is refused', (t) => {
  assert.deepEqual([...SWITCH_VALUES.minorPolicy], ['legacy', 'refuse', 'spec', 'demonstrated']);
  assert.equal(DEFAULT_SWITCHES.minorPolicy, 'legacy');
  assert.equal(V378_DEFAULT_SWITCHES.minorPolicy, 'spec');
  assert.equal(switchesOf(newState('r1', { now: NOW })).minorPolicy, 'legacy');
  const d = deps(mkHome(t));
  assert.equal(init(d, 'minorPolicy=demonstrated').code, 0);
  assert.match(show(d), /minorPolicy=demonstrated \(explicit\)/);
  assert.equal(runFanout(['state', 'set', '--run', 'r1', '--switch', 'minorPolicy=demo'], d).code, 1);
});

test('must-FAIL: the switch changed after the first spawn is refused — both ways, with the reason; a run that never set it keeps legacy', (t) => {
  const { d, home } = run(t);
  for (const v of ['legacy', 'spec', 'demonstrated']) {
    const r = runFanout(['state', 'set', '--run', 'r1', '--switch', `minorPolicy=${v}`], d);
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /cannot change|already spawned|frozen/i, v);
  }
  assert.equal(switchesOf(stateOf(home)).minorPolicy, 'demonstrated');
  const plain = mkHome(t); const pd = deps(plain); init(pd); set(pd, 'T1', '--status', 'started', '--branch', 't1');
  assert.equal(runFanout(['state', 'set', '--run', 'r1', '--switch', 'minorPolicy=demonstrated'], pd).code, 1, 'legacy → demonstrated after the spawn');
  assert.equal(switchesOf(stateOf(plain)).minorPolicy, 'legacy');
});

// ── must-PASS: block, settle, decide ─────────────────────────────────────────────────────────────────────
test('must-PASS: an accepted MINOR blocks deliver AND gate (finding-unsettled), nothing merged; a later head + --settle lets it through', async (t) => {
  const { d, home } = run(t);
  const rec = set(d, 'T1', '--finding-json', finding('MINOR'));
  assert.equal(rec.code, 0, rec.stderr);
  assert.match(rec.stdout, /F1:MINOR\(demonstrated,unsettled\)/);
  const f = stateOf(home).tickets.T1.findings.F1;
  assert.deepEqual([f.demonstration?.file, f.demonstration?.head, f.demonstration?.refusal], ['src/orders/service.ts', A, undefined]);
  assert.deepEqual(blockingMinors(stateOf(home), 'T1'), ['F1']);
  const blocked = await tryDeliver(home);
  assert.equal(blocked.out.exit, 2, JSON.stringify(blocked.out.result));
  assert.equal(blocked.out.result.reason, 'finding-unsettled');
  assert.match(String(blocked.out.result.detail), /F1 \(MINOR: “GET \/orders\?limit=0/);
  assert.match(String(blocked.out.result.detail), /--settle F1=fixed:<head>.*--decide/s);
  assert.match(String(blocked.out.result.detail), /well formed.*not that it is true/);
  assert.equal(blocked.merged, false);
  const g = await gate(home, A);
  assert.equal(g.exit, 2, JSON.stringify(g.result));
  assert.equal(g.result.reason, 'finding-unsettled');
  // a later head whose review no longer carries it: the coordinator settles it on that head
  assert.equal(set(d, 'T1', '--head', B, '--settle', `F1=fixed:${B}`).code, 0);
  const done = await tryDeliver(home, { verifiedHead: B });
  assert.equal(done.out.exit, 0, JSON.stringify(done.out.result));
  assert.equal(done.merged, true);
  assert.equal((await gate(home, B)).exit, 0);
});

test('must-PASS: the same finding with a coordinator --decide passes (the reason is recorded); a blank reason is refused', async (t) => {
  const { d, home } = run(t);
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR')).code, 0);
  assert.equal(set(d, 'T1', '--decide', 'F1=').code, 1);
  assert.equal((await tryDeliver(home)).merged, false);
  assert.equal(set(d, 'T1', '--decide', 'F1=accepted: the page size 0 is out of the ticket').code, 0);
  assert.equal(stateOf(home).tickets.T1.findings.F1.decision?.text, 'accepted: the page size 0 is out of the ticket');
  const ok = await tryDeliver(home);
  assert.equal(ok.out.exit, 0, JSON.stringify(ok.out.result));
  assert.equal(ok.merged, true);
});

test('must-PASS: a MINOR with NO demonstration does not block (legacy); BLOCKING / MAJOR without one are as today — the review verdict carries them, the state does not block', async (t) => {
  const { d, home } = run(t);
  for (const sev of ['MINOR', 'MAJOR', 'BLOCKING']) assert.equal(set(d, 'T1', '--finding', `P-${sev}=${sev}`).code, 0);
  assert.deepEqual(blockingMinors(stateOf(home), 'T1'), []);
  assert.equal(mergeBlockRefusal(stateOf(home), 'T1'), null);
  const ok = await tryDeliver(home);
  assert.equal(ok.out.exit, 0, JSON.stringify(ok.out.result));
  assert.equal(ok.merged, true);
  // …and the verdict file still refuses an open MAJOR exactly as before (verifier=off: the verdict is the gate)
  const off = run(t, ',verifier=off');
  const r = rig();
  const refused = await withEnv(off.home, () => deliver(dopts({ noReviewGate: false, reviewVerdict: (() => { const f = path.join(off.home, 'v.json'); fs.writeFileSync(f, JSON.stringify({ round: 1, blocking: 0, major: 1, minor: 0, head: A })); return f; })() }), r.dd));
  assert.equal(refused.result.reason, 'review-blocking');
});

test('ANY severity: a BLOCKING / MAJOR with an accepted demonstration blocks the same way, until settled', async (t) => {
  for (const sev of ['MAJOR', 'BLOCKING']) {
    const { d, home } = run(t);
    assert.equal(set(d, 'T1', '--finding-json', finding(sev)).code, 0);
    assert.deepEqual(blockingMinors(stateOf(home), 'T1'), ['F1'], sev);
    assert.equal((await tryDeliver(home)).out.result.reason, 'finding-unsettled', sev);
    assert.equal(set(d, 'T1', '--settle', `F1=fixed:${B}`).code, 0);
    assert.equal((await tryDeliver(home)).merged, true, sev);
  }
});

test('works with verifier=off: the reviewer verdict + green CI deliver, and the demonstrated finding still blocks until settled', async (t) => {
  const { d, home } = run(t, ',verifier=off');
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR')).code, 0);
  const blocked = await tryDeliver(home, { noReviewGate: false, reviewVerdict: verdictFile(home) });
  assert.equal(blocked.out.exit, 2);
  assert.equal(blocked.out.result.reason, 'finding-unsettled');
  assert.equal(blocked.merged, false);
  assert.equal(set(d, 'T1', '--settle', `F1=fixed:${B}`).code, 0);
  const ok = await tryDeliver(home, { noReviewGate: false, reviewVerdict: verdictFile(home) });
  assert.equal(ok.out.exit, 0, JSON.stringify(ok.out.result));
  assert.equal(ok.merged, true);
});

// ── must-FAIL: a rejected demonstration is recorded with its reason and the finding stays a plain MINOR ─────
test('must-FAIL: blank / under the floor / test file / doc / absent file / identical fields → NOT accepted: the finding stays a plain MINOR, the refusal reason is recorded, nothing blocks', async (t) => {
  const cases: Array<[string, Partial<typeof DEMO>, RegExp]> = [
    ['blank input', { input: '   ' }, /^input is blank/],
    ['blank observed', { observed: '' }, /^observed is blank or missing/],
    ['blank expected', { expected: ' \n ' }, /^expected is blank/],
    ['input under the floor', { input: 'GET /orders now' }, /^input has 3 word\(s\), the floor is 5/],
    ['observed under the floor', { observed: 'src/orders/service.ts:42 is wrong' }, /^observed has 2 word\(s\) besides its file:line/],
    ['expected under the floor', { expected: 'an empty page' }, /^expected has 3 word\(s\)/],
    ['observed on a test file', { observed: 'src/orders/service.test.ts:7 returns every order instead of an empty page' }, /cites only src\/orders\/service\.test\.ts \(test\)/],
    ['observed on a doc', { observed: 'docs/orders.md:3 returns every order instead of an empty page' }, /cites only docs\/orders\.md \(docs\)/],
    ['observed on a file absent from the head', { observed: 'src/orders/missing.ts:42 returns every order instead of an empty page' }, /^src\/orders\/missing\.ts does not exist on head aaaaaaaa/],
    ['observed with no file:line', { observed: 'the service returns every order instead of an empty page' }, /^observed names no file:line/],
    ['three identical fields', { input: DEMO.observed, expected: DEMO.observed }, /are the same text/],
    ['two identical fields', { expected: DEMO.input }, /^input and expected are the same text/],
  ];
  for (const [name, patch, why] of cases) {
    const { d, home } = run(t);
    const r = set(d, 'T1', '--finding-json', finding('MINOR', patch));
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    assert.match(r.stdout, /F1:MINOR\(demonstration-refused\)/, name);
    const f = stateOf(home).tickets.T1.findings.F1;
    assert.equal(f.severity, 'MINOR', name);
    assert.match(f.demonstration?.refusal ?? '', why, name);
    assert.equal(f.demonstration?.file, undefined, name);
    assert.deepEqual(blockingMinors(stateOf(home), 'T1'), [], name);
    const ok = await tryDeliver(home);
    assert.equal(ok.merged, true, `${name}: a plain MINOR does not block — ${JSON.stringify(ok.out.result)}`);
    assert.match(show(d), /demonstration REFUSED \(stays a plain MINOR\)/, name);
  }
});

test('must-FAIL: a head that cannot be read here, or a ticket with no head, refuses the demonstration saying so (never accepts blind)', (t) => {
  const home = mkHome(t);
  const offline = deps(home, (c, a) => (a[0] === 'rev-parse' ? { code: 1, stdout: '', stderr: 'bad object' } : { code: 1, stdout: '', stderr: 'gh: HTTP 502' }));
  init(offline, 'minorPolicy=demonstrated');
  set(offline, 'T1', '--status', 'started', '--branch', 't1', '--head', A);
  set(offline, 'T1', '--finding-json', finding('MINOR'));
  assert.match(stateOf(home).tickets.T1.findings.F1.demonstration?.refusal ?? '', /cannot read src\/orders\/service\.ts on head aaaaaaaa \(not fetched\?\)/);
  const noHead = mkHome(t); const nd = deps(noHead); init(nd, 'minorPolicy=demonstrated'); set(nd, 'T1', '--status', 'todo');
  set(nd, 'T1', '--finding-json', finding('MINOR'));
  assert.match(readState(stateFile(noHead, 'r1'))!.tickets.T1.findings.F1.demonstration?.refusal ?? '', /no recorded head/);
});

test('fileOnHead: a held commit answers by cat-file; a commit not held asks GitHub (404 = absent, anything else = unreadable)', () => {
  const calls: string[] = [];
  const held: Runner = (c, a) => { calls.push(`${c} ${a[0]}`); const p = a[a.length - 1]; const row = (mode: string, type: string): { code: number; stdout: string; stderr: string } => ({ code: 0, stdout: `${mode} ${type} ${'f'.repeat(40)}\t${p}\0`, stderr: '' }); return a[0] === 'ls-tree' ? (p === 'src/x.ts' ? row('100755', 'blob') : p === 'src/dir.d' ? row('040000', 'tree') : p === 'src/link.ts' ? row('120000', 'blob') : { code: 0, stdout: '', stderr: '' }) : { code: 0, stdout: '', stderr: '' }; };
  assert.equal(fileOnHead(held, A, 'src/x.ts', '/', null), true);
  assert.equal(fileOnHead(held, A, 'src/y.ts', '/', null), false);
  assert.equal(fileOnHead(held, A, 'src/dir.d', '/', null), false, 'a directory is not a file');
  assert.equal(fileOnHead(held, A, 'src/link.ts', '/', null), false, 'a symlink is not the product file (review M3: the git arm refuses it like the gh arm)');
  assert.equal(fileOnHead((c, a) => ({ code: 0, stdout: `100644 blob ${'f'.repeat(40)}\tsrc/other.ts\0`, stderr: '' }), A, 'src/x.ts', '/', null), false, 'ls-tree answered for another path');
  const gone: Runner = (c, a) => (c === 'git' ? { code: 1, stdout: '', stderr: '' } : { code: a.includes('--silent') ? 1 : 0, stdout: '', stderr: 'gh: Not Found (HTTP 404)' });
  assert.equal(fileOnHead(gone, A, 'src/x.ts', '/', 'o/r'), false);
  const flaky: Runner = (c) => (c === 'git' ? { code: 1, stdout: '', stderr: '' } : { code: 1, stdout: '', stderr: 'HTTP 502' });
  assert.equal(fileOnHead(flaky, A, 'src/x.ts', '/', 'o/r'), null);
  const found: Runner = (c) => (c === 'git' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: 'file\n', stderr: '' });
  assert.equal(fileOnHead(found, A, 'src/x.ts', '/', 'o/r'), true);
  assert.equal(fileOnHead((c) => (c === 'git' ? { code: 1, stdout: '', stderr: '' } : { code: 0, stdout: 'dir\n', stderr: '' }), A, 'src/x.d', '/', 'o/r'), false, 'gh: a directory answers type dir');
  assert.equal(fileOnHead(found, 'not-a-sha', 'src/x.ts', '/', 'o/r'), null);
  assert.equal(fileOnHead(found, A, '-rf', '/', 'o/r'), null, 'a path that looks like a flag is never passed to git');
});

// ── the record: recorded once, verdict is code's, only under the switch ──────────────────────────────────
test('the verdict is code\'s: file / head / refusal typed in the patch are dropped; an accepted demonstration is never rewritten; a refused one may be replaced; a closed finding takes none', (t) => {
  const { d, home } = run(t);
  const forged = JSON.stringify({ F1: { severity: 'MINOR', demonstration: { ...DEMO, observed: 'docs/orders.md:3 returns every order instead of an empty page', file: 'src/orders/service.ts', head: A } } });
  assert.equal(set(d, 'T1', '--finding-json', forged).code, 0);
  assert.match(stateOf(home).tickets.T1.findings.F1.demonstration?.refusal ?? '', /orders\.md \(docs\)/, 'a typed file/head does not accept it');
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR')).code, 0, 'replaced by a good one');
  assert.deepEqual(blockingMinors(stateOf(home), 'T1'), ['F1']);
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR')).code, 0, 'the same texts again: idempotent');
  const other = set(d, 'T1', '--finding-json', finding('MINOR', { input: 'GET /orders?limit=-1 as an anonymous user' }));
  assert.equal(other.code, 1);
  assert.match(other.stderr, /already records an accepted demonstration/);
  assert.equal(set(d, 'T1', '--finding-json', finding('MAJOR')).code, 1, 'a recorded severity is not re-graded');
  assert.equal(set(d, 'T1', '--decide', 'F1=out of scope').code, 0);
  const closed = set(d, 'T1', '--finding-json', JSON.stringify({ F2: { severity: 'MINOR' } }));
  assert.equal(closed.code, 0);
  assert.equal(set(d, 'T1', '--decide', 'F2=n/a').code, 0);
  const late = set(d, 'T1', '--finding-json', finding('MINOR').replace('F1', 'F2'));
  assert.equal(late.code, 1);
  assert.match(late.stderr, /already decided: it takes no new demonstration/);
});

test('only under the switch: a demonstration under legacy / refuse / spec is REFUSED with the reason (never silently inert)', (t) => {
  for (const v of ['legacy', 'refuse', 'spec']) {
    const home = mkHome(t); const d = deps(home); init(d, `minorPolicy=${v}`);
    set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A);
    const r = set(d, 'T1', '--finding-json', finding('MINOR'));
    assert.equal(r.code, 1, v);
    assert.match(r.stderr, /only under minorPolicy=demonstrated/, v);
    assert.deepEqual(stateOf(home).tickets.T1.findings, {}, `${v}: nothing recorded`);
  }
});

test('a hand-edited state cannot smuggle a demonstration in: a blank text / test file / no file+head / a refusal reads NOT accepted — nothing blocks', (t) => {
  const { d, home } = run(t);
  set(d, 'T1', '--finding-json', finding('MINOR'));
  const raw = JSON.parse(fs.readFileSync(stateFile(home, 'r1'), 'utf8')) as { tickets: { T1: { findings: { F1: { demonstration: Record<string, string | undefined> } } } } };
  const edit = (f: (x: Record<string, string | undefined>) => void): string[] => { const c = JSON.parse(JSON.stringify(raw)) as typeof raw; f(c.tickets.T1.findings.F1.demonstration); return blockingMinors(parseState(c), 'T1'); };
  assert.deepEqual(edit(() => {}), ['F1'], 'control: unedited blocks');
  assert.deepEqual(edit((x) => { x.input = ' '; }), []);
  assert.deepEqual(edit((x) => { x.expected = 'too short'; }), []);
  assert.deepEqual(edit((x) => { x.expected = x.input; }), []);
  assert.deepEqual(edit((x) => { delete x.file; }), []);
  assert.deepEqual(edit((x) => { delete x.head; }), []);
  assert.deepEqual(edit((x) => { x.file = 'src/orders/service.test.ts'; x.observed = 'src/orders/service.test.ts:7 returns every order instead of an empty page'; }), []);
  assert.deepEqual(edit((x) => { x.refusal = 'x'; }), []);
});

test('a demonstrated finding may be named in --fixes (a follow-up on the merged ticket), as under legacy; a merged ticket no longer blocks', (t) => {
  let st = newState('r1', { switches: { minorPolicy: 'demonstrated' }, now: NOW });
  st = applyTicketPatch(st, 'T1', { status: 'started', branch: 't1', head: A }, NOW);
  st = applyTicketPatch(st, 'T1', { findings: { F1: { severity: 'MINOR', demonstration: DEMO } } }, NOW, { fileOnHead: () => true });
  assert.deepEqual(blockingMinors(st, 'T1'), ['F1']);
  st = applyTicketPatch(st, 'T1', { status: 'merged', head: A }, NOW); // merged with the finding still open (a finding raised after the merge goes through a follow-up)
  assert.doesNotThrow(() => applyTicketPatch(st, 'F-1', { followUpOf: 'T1', fixes: ['F1'] }, NOW));
  assert.deepEqual(blockingMinors(st, 'T1'), [], 'a merged ticket blocks nothing');
  assert.equal(mergeBlockRefusal(st, 'T1'), null);
  // legacy-like: a further candidate on a merged ticket is not forced into a follow-up registration (the #514 rule is not in force)
  assert.doesNotThrow(() => applyTicketPatch(st, 'T1', { status: 'nominated', head: B }, NOW));
});

// ── state show / closeout ────────────────────────────────────────────────────────────────────────────────
test('`state show` prints, per ticket, the open demonstrated findings (and drops them once settled); other policies print no such section', (t) => {
  const { d } = run(t);
  assert.match(show(d), /demonstrated findings \(#572\): none open/);
  set(d, 'T1', '--finding-json', finding('MINOR'));
  const s = show(d);
  assert.match(s, /demonstrated findings \(#572\) — open ones block gate \+ deliver:\n  T1\/F1  MINOR  OPEN  src\/orders\/service\.ts @aaaaaaaa  input: GET \/orders\?limit=0/);
  set(d, 'T1', '--settle', `F1=fixed:${B}`);
  assert.match(show(d), /none open/);
  // an open finding on a MERGED ticket blocks nothing: it is not listed as an open blocker
  const m = run(t); set(m.d, 'T1', '--finding-json', finding('MINOR')); set(m.d, 'T1', '--status', 'merged');
  assert.match(show(m.d), /none open/);
  const home2 = mkHome(t); const d2 = deps(home2); init(d2, 'minorPolicy=spec');
  assert.doesNotMatch(show(d2), /demonstrated findings/);
});

test('closeout lists EVERY demonstrated finding and how it ended: fixed on head X / decision recorded / still open — and the refused ones; every other run prints no such section', (t) => {
  const { d, home } = run(t);
  set(d, 'T1', '--finding-json', JSON.stringify({ F1: { severity: 'MINOR', demonstration: DEMO }, F2: { severity: 'MAJOR', demonstration: { ...DEMO, input: 'GET /orders?limit=-1 as an anonymous user' } }, F3: { severity: 'MINOR', demonstration: { ...DEMO, input: 'POST /orders with an empty basket as a guest' } }, F4: { severity: 'MINOR', demonstration: { ...DEMO, expected: 'short one' } } }));
  set(d, 'T1', '--settle', `F1=fixed:${B}`);
  set(d, 'T1', '--decide', 'F2=out of scope for this ticket');
  const out = runCloseout(['--run', 'r1'], d).stdout;
  assert.match(out, /demonstrated findings \(#572\): 3 — 2 ended, 1 still open; 1 demonstration\(s\) refused/);
  assert.match(out, /T1\/F1  MINOR  src\/orders\/service\.ts @aaaaaaaa  — fixed on head b{40}/);
  assert.match(out, /T1\/F2  MAJOR .* — decision recorded: out of scope for this ticket/);
  assert.match(out, /T1\/F3  MINOR .* — STILL OPEN/);
  assert.match(out, /T1\/F4  demonstration refused: expected has 2 word\(s\)/);
  const json = JSON.parse(runCloseout(['--run', 'r1', '--json'], d).stdout) as { demonstrated: { findings: Array<{ finding: string; end: string }> } };
  assert.deepEqual(json.demonstrated.findings.map((f) => [f.finding, f.end]), [['F1', 'fixed'], ['F2', 'decided'], ['F3', 'open']]);
  void home;
  const plain = mkHome(t); const pd = deps(plain); init(pd); set(pd, 'T1', '--finding', 'X=MINOR');
  assert.doesNotMatch(runCloseout(['--run', 'r1'], pd).stdout, /demonstrated/);
  assert.equal('demonstrated' in (JSON.parse(runCloseout(['--run', 'r1', '--json'], pd).stdout) as object), false);
});

// ── the render ───────────────────────────────────────────────────────────────────────────────────────────
/** What master rendered (sha256, computed from the master tree BEFORE #572 with scripts-style gen; re-pinned by #568 for its one verifier-on CI sentence, the verifier=off row is unchanged: SKILL.md + verifier-and-review.md + an aggregate over every file): these stay byte-identical. */
const MASTER: Record<string, { skill: string; review: string; all: string }> = {
  default: { skill: 'a9073a594a19c8018dfcd34ebf4abbfc2e7c3eca5e28b9899bf398186480950a', review: 'f9269a516161d349d43f3800530b13bd75b7de9b2103d4e8b3e7d23dc480b36e', all: '34e1d3efb5a1d8cd32ba952c38022f6de05b6472197ce6de2965a87ab120da53' },
  refuse: { skill: '72c2e3a9fc1c78c5ad2d39250830e12a88657aac583dbf50fed4812805c3d7d2', review: 'f9269a516161d349d43f3800530b13bd75b7de9b2103d4e8b3e7d23dc480b36e', all: '81c3963a2329fb03040bdd2d2d66c40bb6e1f707564ccbcc25b5f9081b4a1451' },
  spec: { skill: '628de901ab799af63ae87ea68fc9daa55909bfeae72adb02c97b7cc622651437', review: '18dd586e12315f5c4922467e21097e2973c05b6dcb128bb6269cc93ffb60a41e', all: 'adedf61b24268a18486288afe92b7ad9556de930fb58cf13761c92d5d7efe0c0' },
  'spec+acceptance': { skill: 'f3fd918b3db0af2a0b92f64ca1af84e3a12eb7f5c37340045c0e196ec291078a', review: '18dd586e12315f5c4922467e21097e2973c05b6dcb128bb6269cc93ffb60a41e', all: '90c4484bc8dc385851326a8549c6fc5ecd49f36e0800f353e90b93eac9ce30b2' },
  'off-verifier-spec': { skill: '007e917a550fe6b9f75eae5834e90037a2dde27306766e2ed8ac258aaec97563', review: '401fe5cf96fde7ed8f45a0276eaa6f9d6e10387e86e70af4dc8ce9e75d96ad6f', all: 'c5ecff9037bc7f3f5147de55b2c77277220ca4ca268ce5ee630c8e94c0628915' },
};
const CFG: Record<string, Partial<Switches>> = { default: {}, refuse: { minorPolicy: 'refuse' }, spec: { minorPolicy: 'spec' }, 'spec+acceptance': { minorPolicy: 'spec', acceptance: 'on' }, 'off-verifier-spec': { minorPolicy: 'spec', verifier: 'off' } };
const refsOf = (c: Partial<Switches>): Record<string, string> => Object.fromEntries([['SKILL.md', sha(renderVerifiedFanoutSkill(c))], ...VERIFIED_FANOUT_V2_REFERENCES.map((f) => [f.path, sha(renderSwitchBlocks(f.content, c))] as const)]);
const REVIEWER_SENTENCE = 'for each finding about product behaviour give `input` (the concrete situation), `observed` (what the code does, with a product `file:line`) and `expected` (what the ticket asks, or why the result is wrong for the user), or say plainly that you cannot; never invent an input you did not trace';
const review = (c: Partial<Switches>): string => renderSwitchBlocks(VERIFIED_FANOUT_V2_REFERENCES.find((f) => f.path === 'references/verifier-and-review.md')!.content, c);

test('must-PASS: the default, refuse and spec renders (SKILL.md and every reference) are BYTE-IDENTICAL to master — sha256 pins, incl. verifier=off and acceptance=on', () => {
  for (const [name, want] of Object.entries(MASTER)) {
    const got = refsOf(CFG[name]);
    assert.equal(got['SKILL.md'], want.skill, `${name}: SKILL.md`);
    assert.equal(got['references/verifier-and-review.md'], want.review, `${name}: verifier-and-review.md`);
    assert.equal(sha(Object.entries(got).map(([p, s]) => `${p}\0${s}\n`).join('')), want.all, `${name}: every file`);
  }
});

test('demonstrated render: the reviewer sentence and the settle text appear ONLY under that value; no directive is left; verifier=off names no verifier role', () => {
  const sentence = (text: string): boolean => norm(text).includes(REVIEWER_SENTENCE);
  for (const v of ['legacy', 'refuse', 'spec'] as const) {
    for (const extra of [{}, { acceptance: 'on' as const }, { verifier: 'off' as const }]) {
      const c = { minorPolicy: v, ...extra };
      assert.doesNotMatch(renderVerifiedFanoutSkill(c), /Reviewer brief \(#572\)/, `${v}: SKILL.md`);
      assert.equal(sentence(review(c)), false, `${v}: reference`);
      assert.doesNotMatch(renderVerifiedFanoutSkill(c) + review(c), /demonstrat/i, `${v}: no word of it`);
    }
  }
  for (const extra of [{}, { acceptance: 'on' as const }, { verifier: 'off' as const }, { acceptance: 'on' as const, verifier: 'off' as const }]) {
    const c = { minorPolicy: 'demonstrated' as const, ...extra };
    const skill = renderVerifiedFanoutSkill(c);
    assert.equal(sentence(review(c)), true, `reference ${JSON.stringify(extra)}`);
    assert.doesNotMatch(skill + review(c), /<!--\/?sw/);
    assert.match(skill, /no unsettled demonstrated finding merges on its\ncurrent gate/);
    assert.match(skill, /Only an accepted demonstration refuses a finding \(`finding-unsettled`\)/);
    assert.match(skill, /only a BLOCKING\/MAJOR or demonstrated finding in its own diff reopens it/);
    assert.match(skill, /`follow-up` or `noted` \(MINOR\/NIT only\)/, 'the merge-eligible dispositions are the legacy ones');
    assert.match(skill, /\*\*Reviewer brief \(#572\):\*\* per product finding demand `input` \/ `observed` \(`file:line`\) \/ `expected`, or `cannot`/);
    assert.match(review(c), /--settle <id>=fixed:<head>.*--decide <id>=<text>/s);
    assert.match(norm(review(c)), /Limit: code checks the demonstration is well formed, not that it is true — a wrong one costs one fix round or one coordinator decision\./);
    assert.doesNotMatch(skill + review(c), /unsettled spec-sentence MINOR|A MINOR refuses only when it quotes a spec sentence|A MINOR that breaks a sentence/, 'no #552 text leaks into the demonstrated render');
    if (extra.verifier === 'off') assert.doesNotMatch((skill + review(c)).replace(/verifier-and-review/g, ''), /verif(?:ier|-)/i);
  }
  assert.ok(renderVerifiedFanoutSkill({ minorPolicy: 'demonstrated' }) !== renderVerifiedFanoutSkill({}));
});

test('the always-read SKILL.md stays under 4,000 words under demonstrated (+ acceptance on, the strictest reading); the reference names the floor the code uses; the usage text states the limit', () => {
  const words = (s: string): number => s.split(/\s+/).filter(Boolean).length;
  assert.ok(words(renderVerifiedFanoutSkill({ minorPolicy: 'demonstrated', acceptance: 'on' })) < 4000);
  assert.match(review({ minorPolicy: 'demonstrated' }), /at least 5 words each/);
  assert.match(FANOUT_USAGE, /A finding with a demonstration \(#572, minorPolicy demonstrated\)/);
  assert.ok(FANOUT_USAGE.includes(DEMONSTRATION_LIMIT), 'the limit — well formed, not true — is in `orchestra fanout --help`');
  assert.match(FANOUT_USAGE, /not that it is true/);
});

test('pre-review MAJOR: a refusal naming MANY cited paths is bounded, so the finding is still recorded as a plain finding (never an error about a field the reviewer did not type)', (t) => {
  const many = Array.from({ length: 12 }, (_, i) => `packages/orchestra-backend-service/src/shared/handler-${i}.ts:4`).join(' and ');
  for (const [name, runner] of [['absent', gitFake], ['unreadable', ((c: string) => ({ code: 1, stdout: '', stderr: c })) as Runner]] as const) {
    const home = mkHome(t); const d = deps(home, runner); init(d, 'minorPolicy=demonstrated'); set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A);
    const r = set(d, 'T1', '--finding-json', finding('MINOR', { observed: `${many} return every order instead of an empty page` }));
    assert.equal(r.code, 0, `${name}: ${r.stderr}`);
    const f = stateOf(home).tickets.T1.findings.F1;
    assert.equal(f.severity, 'MINOR');
    assert.ok((f.demonstration?.refusal ?? '').length <= 400 && /\(\+9 more\)/.test(f.demonstration?.refusal ?? ''), `${name}: ${f.demonstration?.refusal}`);
  }
  const tests = Array.from({ length: 12 }, (_, i) => `packages/orchestra-backend-service/src/shared/handler-${i}.test.ts:4`).join(' and ');
  const home = mkHome(t); const d = deps(home); init(d, 'minorPolicy=demonstrated'); set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A);
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR', { observed: `${tests} return every order instead of an empty page` })).code, 0);
  assert.match(stateOf(home).tickets.T1.findings.F1.demonstration?.refusal ?? '', /cites only .*\(test\).*\(\+9 more\)/);
});

test('a directory is not a file: observed on a path that is a tree on the head is refused', (t) => {
  const { d, home } = run(t);
  set(d, 'T1', '--finding-json', finding('MINOR', { observed: 'src/dir.d:3 returns every order instead of an empty page' }));
  assert.match(stateOf(home).tickets.T1.findings.F1.demonstration?.refusal ?? '', /src\/dir\.d does not exist on head/);
});

test('review M1: the existence checks run BEFORE the state lock is taken (a slow gh inside the lock lets a second writer break it and lose its write)', (t) => {
  const home = mkHome(t);
  const lock = `${stateFile(home, 'r1')}.lock`;
  let during = 0, calls = 0;
  const spy: Runner = (c, a) => { calls++; if (fs.existsSync(lock)) during++; return gitFake(c, a); };
  const d = deps(home, spy);
  init(d, 'minorPolicy=demonstrated'); set(d, 'T1', '--status', 'nominated', '--branch', 't1', '--head', A);
  calls = 0; during = 0;
  assert.equal(set(d, 'T1', '--finding-json', finding('MINOR')).code, 0);
  assert.ok(calls > 0, 'the checks did run');
  assert.equal(during, 0, 'none of them ran while the lock file existed');
  assert.deepEqual(blockingMinors(stateOf(home), 'T1'), ['F1']);
  // the head given in the SAME patch is the one the file is read on
  const home2 = mkHome(t); const d2 = deps(home2); init(d2, 'minorPolicy=demonstrated');
  assert.equal(set(d2, 'T1', '--status', 'nominated', '--branch', 't1', '--head', B, '--finding-json', finding('MINOR')).code, 0);
  assert.equal(readState(stateFile(home2, 'r1'))!.tickets.T1.findings.F1.demonstration?.head, B);
});

test('review M2: non-ASCII, [id] / (group) segments and spaces — the cited path is never truncated to its tail and looked up at the repo root', () => {
  assert.deepEqual(citationsOf('src/app/[id]/page.tsx:1'), [{ path: 'src/app/[id]/page.tsx', line: 1 }]);
  assert.deepEqual(citationsOf('src/app/(shop)/[...slug]/page.tsx:9-12'), [{ path: 'src/app/(shop)/[...slug]/page.tsx', line: 9 }]);
  assert.deepEqual(citationsOf('src/Straße.ts:1 and lib/café/données.py:7'), [{ path: 'src/Straße.ts', line: 1 }, { path: 'lib/café/données.py', line: 7 }]);
  assert.deepEqual(citationsOf('(src/a.ts:3), then [lib/b.ts:4]'), [{ path: 'src/a.ts', line: 3 }, { path: 'lib/b.ts', line: 4 }]);
  assert.deepEqual(citationsOf('src/my a.ts:1'), [], 'a path with a space is not citable: `a.ts` at the root is NOT the cited file');
  assert.deepEqual(citationsOf('src/x.ts:4 package.json:3, and README.md:1'), [{ path: 'src/x.ts', line: 4 }, { path: 'package.json', line: 3 }, { path: 'README.md', line: 1 }], 'a root citation after a citation or punctuation is a citation');
  assert.match(cls({ observed: 'src/my a.ts:1 returns every order instead of an empty page' }, { head: HEAD, fileOnHead: onHead('a.ts', 'src/my a.ts') }).refusal ?? '', /^observed names no file:line/);
  assert.equal(cls({ observed: 'src/app/[id]/page.tsx:1 returns every order instead of an empty page' }, { head: HEAD, fileOnHead: onHead('src/app/[id]/page.tsx') }).file, 'src/app/[id]/page.tsx');
  const t0 = Date.now(); citationsOf(`${'a/'.repeat(1000)}b.ts:x ${'(['.repeat(500)}`); citationsOf('a'.repeat(2000) + '.'.repeat(500)); assert.ok(Date.now() - t0 < 500, 'no catastrophic backtracking');
});

test('review M3 + verifier pins: more test code / rigs are not product; a single very long path and a 2001-char text are bounded or refused loudly; an unknown key is refused', () => {
  for (const p of ['src/shared/electron-guest-window.testlib.ts', 'sandbox/app-e2e.mjs', 'src/foo.mock.ts', 'x.fixture.ts', 'scripts/pause-canary/run.mjs', 'scripts/foo-rig.mjs']) assert.equal(classifyPath(p), 'test', p);
  const long = `${'d'.repeat(60)}/`.repeat(8) + 'x.ts';
  const d = classifyDemonstration({ ...DEMO_UNIT, observed: `${long}:3 returns every order instead of an empty page` }, { head: HEAD, fileOnHead: () => false });
  assert.ok((d.refusal ?? '').length <= 400 && /…$/.test(d.refusal ?? ''), `${d.refusal?.length}`);
  assert.throws(() => applyTicketPatch(newState('r1', { switches: { minorPolicy: 'demonstrated' }, now: '2026-11-24T10:00:00.000Z' }), 'T1', { findings: { F1: { severity: 'MINOR', demonstration: { ...DEMO_UNIT, input: 'x'.repeat(2001) } } } }, '2026-11-24T10:00:00.000Z'), /at most 2000 characters/);
  assert.throws(() => applyTicketPatch(newState('r1', { switches: { minorPolicy: 'demonstrated' }, now: '2026-11-24T10:00:00.000Z' }), 'T1', { findings: { F1: { severity: 'MINOR', demonstration: { ...DEMO_UNIT, input: 'a b c d e\u0001 f' } } } }, '2026-11-24T10:00:00.000Z'), /printable/);
  assert.throws(() => applyTicketPatch(newState('r1', { switches: { minorPolicy: 'demonstrated' }, now: '2026-11-24T10:00:00.000Z' }), 'T1', { findings: { F1: { severity: 'MINOR', demonstration: { ...DEMO_UNIT, extra: 'x' } } } }, '2026-11-24T10:00:00.000Z'), /unknown/i);
});
const DEMO_UNIT = { input: 'GET /orders?limit=0 as an authenticated user', observed: 'src/orders/service.ts:42 returns every order instead of an empty page', expected: 'the ticket says limit=0 must return an empty page' };
const HEAD = A;
const onHead = (...files: string[]) => (_h: string, p: string): boolean => files.includes(p);
const cls = (d: Partial<typeof DEMO_UNIT>, ctx: Parameters<typeof classifyDemonstration>[1]) => classifyDemonstration({ ...DEMO_UNIT, ...d }, ctx);
