// #676 — an open point is run STATE: `fanout open-point` records it, `gate` / `deliver` / the loop's approvals refuse BOTH tickets until it settles (the `about` ticket's reviewer approves a NEW head with the point
// in "addressed", or a decision), the briefs carry the one line, the report lists each point and how it settled; `fanout record` fetches an unfetched head before it reads demonstrations. Production verbs throughout.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { defaultRunner, ensureHeadFetched, fileOnHead, type FanoutDeps, type Runner } from './fanout-state.ts';
import { runOpenPoint } from './fanout-open-point.ts';
import { runRecord } from './fanout-record.ts';
import { followUpFromState } from './fanout-followup.ts';
import { gatePr } from './fanout-gate.ts';
import { deliver, type DeliverDeps, type DeliverOpts } from './fanout-deliver.ts';
import type { IdentityResolution } from '../shared/session-identity.ts';
import { applyTicketPatch, followUpRefusal, newState, readState, setPlan, stateFile, writeStateAtomic, type FanoutState } from '../shared/fanout-state.ts';
import { openFollowUp, openPointRefusal, renderPointsForReviewer } from '../shared/fanout-open-point.ts';
import { renderBriefOf } from '../shared/fanout-review.ts';
import { renderImplementerBrief, LOOP_BRIEF } from '../shared/fanout-implementer-brief.ts';
import { OPEN_POINT_LINE } from '../shared/fanout-brief-common.ts';
import { buildReport, renderReport } from '../shared/fanout-report.ts';

const NOW = '2026-11-27T10:00:00.000Z';
const HA = 'a'.repeat(40), HA2 = 'c'.repeat(40), HB = 'b'.repeat(40);
const offline: Runner = () => ({ code: 1, stdout: '', stderr: 'offline' });
const HOST: IdentityResolution = { source: 'host', runId: 'r1', generation: null };
const mkHome = (t: { after: (fn: () => void) => void }): string => {
  const d = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'fanout-open-point-'));
  t.after(() => fs.rmSync(d, { recursive: true, force: true }));
  return d;
};
const depsOf = (home: string, who: string, stdin = '', identity: IdentityResolution | null = HOST): FanoutDeps => ({ env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: who }, cwd: home, runner: offline, now: () => NOW, readStdin: () => stdin, identity });
const brief = (head: string, reviewer: string) => ({ n: 1, kind: 'spawn' as const, head, base: null, hash: '1'.repeat(64), text: 'brief', reviewer, at: NOW });

/** run r1, seatRecords=on, minorPolicy=spec. A1 = the ticket the point is ABOUT (impl-a, reviewer rev-a, head HA), B1 = the ticket that raises it (impl-b, rev-b, head HB), C1 = a bystander. */
function seed(home: string, policy: 'spec' | 'demonstrated' | 'legacy' = 'spec'): void {
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on', minorPolicy: policy } as never });
  s = setPlan(s, ['A1', 'B1', 'C1'], 'declare', NOW);
  for (const id of ['A1', 'B1', 'C1']) s = applyTicketPatch(s, id, { dependsOn: [] }, NOW);
  s = applyTicketPatch(s, 'A1', { status: 'nominated', branch: 'a1', head: HA, implementer: 'impl-a', pr: 11 }, NOW);
  s = applyTicketPatch(s, 'B1', { status: 'nominated', branch: 'b1', head: HB, implementer: 'impl-b', pr: 12 }, NOW);
  s = applyTicketPatch(s, 'C1', { status: 'started', branch: 'c1', implementer: 'impl-c' }, NOW);
  const seat = (id: string, rv: string, head: string) => { s = { ...s, tickets: { ...s.tickets, [id]: { ...s.tickets[id], review: { reviewer: { id: rv, name: `review-${id}`, at: NOW }, head, base: null, briefs: [brief(head, rv)] } } } }; };
  seat('A1', 'rev-a', HA); seat('B1', 'rev-b', HB);
  writeStateAtomic(stateFile(home, 'r1'), s);
}
const load = (home: string): FanoutState => readState(stateFile(home, 'r1'))!;
const save = (home: string, f: (s: FanoutState) => FanoutState): void => writeStateAtomic(stateFile(home, 'r1'), f(load(home)));
const op = (home: string, who: string, ticket = 'B1', about = 'A1', text = 'A1 must also dispatch the event on a manual mark', identity: IdentityResolution | null = HOST) =>
  runOpenPoint([ticket, '--run', 'r1', '--about', about, '--text', text], depsOf(home, who, '', identity));
const decide = (home: string, who: string, n: string, reason: string) => runOpenPoint(['--run', 'r1', '--decide', `${n}=${reason}`], depsOf(home, who));
const rec = (home: string, who: string, ticket: string, head: string, verdict: string, json: unknown) =>
  runRecord([ticket, '--run', 'r1', '--head', head, '--verdict', verdict, '--json', '-'], depsOf(home, who, JSON.stringify(json)));
const env = (home: string): NodeJS.ProcessEnv => ({ ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'r1' });

// ── 1. the verb ─────────────────────────────────────────────────────────────────────────────────────────────────
test('open-point must-PASS: the raising ticket\'s implementer (and its reviewer) record it in the state — numbered, with the head of the ticket it is about; the same point twice keeps its number', (t) => {
  const home = mkHome(t); seed(home);
  const r = op(home, 'impl-b');
  assert.equal(r.code, 0, r.stderr);
  assert.match(r.stdout, /B1: open point 1 recorded about A1/);
  assert.deepEqual(load(home).openPoints, [{ id: 1, from: 'B1', about: 'A1', text: 'A1 must also dispatch the event on a manual mark', at: NOW, status: 'open', aboutHead: HA, aboutTree: null }]);
  const again = op(home, 'impl-b');
  assert.match(again.stdout, /open point 1 already recorded/);
  assert.equal(load(home).openPoints!.length, 1);
  const byReviewer = op(home, 'rev-b', 'B1', 'A1', 'a second point from the reviewer of B1');
  assert.equal(byReviewer.code, 0, byReviewer.stderr);
  assert.equal(load(home).openPoints![1].id, 2);
});

test('open-point must-FAIL: coordinator / another ticket\'s agent / unvouched session record nothing; self, unknown ticket, blank text, a merged ticket are refused by name', (t) => {
  const home = mkHome(t); seed(home);
  const before = fs.readFileSync(stateFile(home, 'r1'), 'utf8');
  for (const who of ['r1', 'impl-a', 'rev-a', 'impl-c']) { const r = op(home, who); assert.equal(r.code, 2, who); assert.match(r.stderr, /^\[open-point-caller\]/, who); }
  const unvouched = op(home, 'impl-b', 'B1', 'A1', 'x', { source: 'env', why: 'no key' } as never);
  assert.equal(unvouched.code, 2); assert.match(unvouched.stderr, /^\[open-point-caller\]/);
  assert.match(op(home, 'impl-b', 'B1', 'B1').stderr, /^\[open-point-self\]/);
  assert.match(op(home, 'impl-b', 'B1', 'ZZ').stderr, /^\[open-point-unknown-ticket\]/);
  assert.match(op(home, 'impl-b', 'ZZ', 'A1').stderr, /^\[open-point-unknown-ticket\]/);
  assert.match(op(home, 'impl-b', 'B1', 'A1', '   ').stderr, /^\[open-point-bad\]/);
  assert.equal(fs.readFileSync(stateFile(home, 'r1'), 'utf8'), before, 'a refusal writes nothing');
  save(home, (s) => applyTicketPatch(s, 'B1', { status: 'merged' }, NOW));
  assert.match(op(home, 'impl-b').stderr, /^\[open-point-closed\]/);
});

// ── 2. gate and deliver refuse BOTH tickets ─────────────────────────────────────────────────────────────────────
const gh: DeliverDeps['gh'] = async (args) => (args[0] === 'api' ? { code: 1, stdout: '', stderr: 'gh: Not Found (HTTP 404)' } : args[0] === 'pr' && args[1] === 'list' ? { code: 0, stdout: '[]', stderr: '' } : { code: 1, stdout: '', stderr: `unexpected gh ${args.join(' ')}` });
const gateOf = (home: string, ticket: string, head: string) => gatePr({ branch: 'x', into: 'master', head, requireChecks: [], ticket, run: 'r1', settleMs: 0 }, { gh, log: () => {}, sleep: async () => {}, followUp: (o) => followUpFromState(o, env(home)) });

test('gate and deliver refuse BOTH tickets [open-point-unsettled] while a point is open; a third ticket is free; a decision frees both (and is the coordinator\'s)', async (t) => {
  const home = mkHome(t); seed(home);
  assert.equal((await gateOf(home, 'A1', HA)).exit, 0); assert.equal((await gateOf(home, 'B1', HB)).exit, 0); // nothing open: as before
  assert.equal(op(home, 'impl-b').code, 0);
  for (const [id, head] of [['A1', HA], ['B1', HB]] as const) {
    const g = await gateOf(home, id, head);
    assert.deepEqual([g.exit, g.result.verdict, g.result.reason], [2, 'refused', 'open-point-unsettled'], id);
    assert.match(String(g.result.detail), /#1 B1 → A1/);
  }
  assert.equal((await gateOf(home, 'C1', 'd'.repeat(40))).exit, 0, 'a bystander is not blocked');
  const calls: string[][] = [];
  const dd = (): DeliverDeps => ({ gh: async (a) => { calls.push(a); return { code: 1, stdout: '', stderr: 'boom' }; }, sleep: async () => {}, now: () => 0, readFile: () => '', log: () => {}, followUp: (o) => followUpFromState(o, env(home)) });
  const dopts = (ticket: string, head: string): DeliverOpts => ({ branch: 'x', into: 'master', ticket, run: 'r1', verifiedHead: head, noReviewGate: true, strategy: 'merge', timeoutMs: 1000, intervalMs: 10, noChecksGraceMs: 0, requireChecks: [] });
  for (const [id, head] of [['A1', HA], ['B1', HB]] as const) assert.deepEqual([(await deliver(dopts(id, head), dd())).result.reason], ['open-point-unsettled'], `deliver ${id}`);
  assert.equal(calls.filter((c) => c[0] !== 'api').length, 0, 'refused before any PR / CI gh call');
  // a decision is the coordinator's, with a reason
  for (const who of ['impl-a', 'impl-b', 'rev-a']) { const r = decide(home, who, '1', 'because'); assert.equal(r.code, 2, who); assert.match(r.stderr, /^\[decide-caller\]/); }
  assert.match(decide(home, 'r1', '1', '  ').stderr, /^\[open-point-reason-blank\]/);
  assert.match(decide(home, 'r1', '9', 'x').stderr, /^\[open-point-unknown\]/);
  assert.equal(decide(home, 'r1', '1', 'the loop\'s fixed rule: A1 stays as recorded').code, 0);
  assert.equal(load(home).openPoints![0].settled!.how, 'decided');
  for (const [id, head] of [['A1', HA], ['B1', HB]] as const) assert.equal((await gateOf(home, id, head)).exit, 0, `${id} free after the decision`);
  assert.match(decide(home, 'r1', '1', 'again').stderr, /^\[open-point-unknown\]/, 'settled once');
});

// ── 3. settled by the reviewer of the about ticket, on a NEW head ──────────────────────────────────────────────
test('addressed: only the reviewer of the `about` ticket, only approve, only a NEW head — then BOTH tickets are free', async (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(op(home, 'impl-b').code, 0);
  // the head the point was raised on cannot address it
  const same = rec(home, 'rev-a', 'A1', HA, 'approve', { addressed: [1] });
  assert.equal(same.code, 2); assert.match(same.stderr, /^\[addressed-same-head\]/);
  // the reviewer of ANOTHER ticket cannot (it is refused as a non-reviewer of A1; on its own ticket the point is not about it)
  save(home, (s) => ({ ...s, tickets: { ...s.tickets, A1: { ...s.tickets.A1, head: HA2, review: { ...s.tickets.A1.review!, head: HA2, briefs: [...s.tickets.A1.review!.briefs, { ...brief(HA2, 'rev-a'), n: 2, kind: 'wake' as const }] } } } }));
  const wrong = rec(home, 'rev-b', 'B1', HB, 'approve', { addressed: [1] });
  assert.equal(wrong.code, 2); assert.match(wrong.stderr, /^\[addressed-wrong-ticket\]/);
  const changes = rec(home, 'rev-a', 'A1', HA2, 'changes-requested', { findings: { F1: { severity: 'MAJOR', evidence: 'argued', text: 'x' } }, addressed: [1] });
  assert.equal(changes.code, 2); assert.match(changes.stderr, /^\[addressed-not-approved\]/);
  assert.match(rec(home, 'rev-a', 'A1', HA2, 'approve', { addressed: [7] }).stderr, /^\[addressed-unknown\]/);
  assert.equal(load(home).openPoints![0].status, 'open', 'every refusal left the point open');
  assert.equal((await gateOf(home, 'A1', HA2)).result.reason, 'open-point-unsettled');
  const ok = rec(home, 'rev-a', 'A1', HA2, 'approve', { addressed: [1] });
  assert.equal(ok.code, 0, ok.stderr);
  const p = load(home).openPoints![0];
  assert.deepEqual([p.status, p.settled!.how, p.settled!.ticket, p.settled!.head, p.settled!.by], ['settled', 'addressed', 'A1', HA2, 'rev-a']);
  for (const [id, head] of [['A1', HA2], ['B1', HB]] as const) assert.equal((await gateOf(home, id, head)).exit, 0, `${id} free`);
});

test('an approve that does not list the point leaves it open (an unaddressed point is not settled by approval alone)', async (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(op(home, 'impl-b').code, 0);
  save(home, (s) => ({ ...s, tickets: { ...s.tickets, A1: { ...s.tickets.A1, head: HA2, review: { ...s.tickets.A1.review!, head: HA2, briefs: [...s.tickets.A1.review!.briefs, { ...brief(HA2, 'rev-a'), n: 2, kind: 'wake' as const }] } } } }));
  assert.equal(rec(home, 'rev-a', 'A1', HA2, 'approve', {}).code, 0);
  assert.equal(load(home).openPoints![0].status, 'open');
  assert.equal((await gateOf(home, 'A1', HA2)).result.reason, 'open-point-unsettled');
});

// ── 4. about is already merged: the follow-up ───────────────────────────────────────────────────────────────────
test('about already merged: openFollowUp makes ticket <about>-op<n> (followUpOf set, fixes op-n, in the plan); it is allowed by the follow-up rule under minorPolicy=spec, carries the block, and ITS reviewer settles the point', async (t) => {
  const home = mkHome(t); seed(home);
  save(home, (s) => applyTicketPatch(s, 'A1', { status: 'merged' }, NOW));
  assert.equal(op(home, 'impl-b').code, 0, 'a point about a MERGED ticket is accepted');
  save(home, (s) => openFollowUp(s, 1, NOW));
  const s = load(home);
  const f = s.tickets['A1-op1'];
  assert.deepEqual([f.followUpOf, f.fixes, f.status, f.dependsOn, f.depsDeclared, s.plan!.tickets.includes('A1-op1'), s.openPoints![0].followUp], ['A1', ['op-1'], 'todo', [], true, true, 'A1-op1']);
  assert.match(f.specText!, /open point 1, raised by B1[\s\S]*A1 must also dispatch the event/);
  assert.equal(followUpRefusal(s, 'A1-op1', HA2, 'x'), null, 'the follow-up rule accepts an op-<n> as the finding it fixes');
  assert.equal(openFollowUp(s, 1, NOW), s, 'idempotent');
  assert.deepEqual([openPointRefusal(s, 'A1-op1')?.reason, openPointRefusal(s, 'B1')?.reason, openPointRefusal(s, 'A1')], ['open-point-unsettled', 'open-point-unsettled', null]);
  // the follow-up gets a reviewer on its head: it approves with the point addressed
  save(home, (x) => {
    let y = applyTicketPatch(x, 'A1-op1', { status: 'nominated', branch: 'a1-op1', head: HA2, implementer: 'impl-f', pr: 13 }, NOW);
    y = { ...y, tickets: { ...y.tickets, 'A1-op1': { ...y.tickets['A1-op1'], review: { reviewer: { id: 'rev-f', name: 'review-f', at: NOW }, head: HA2, base: null, briefs: [brief(HA2, 'rev-f')] } } } };
    return y;
  });
  assert.match(renderBriefOf(load(home), 'A1-op1', { kind: 'spawn', head: HA2, base: null }).text, /point 1, from B1: A1 must also dispatch the event/);
  const ok = rec(home, 'rev-f', 'A1-op1', HA2, 'approve', { addressed: [1] });
  assert.equal(ok.code, 0, ok.stderr);
  assert.equal(load(home).openPoints![0].settled!.ticket, 'A1-op1');
  assert.equal((await gateOf(home, 'B1', HB)).exit, 0);
});

// ── 5. the briefs and the report ───────────────────────────────────────────────────────────────────────────────
test('briefs: the implementer\'s loop section and the reviewer\'s rules carry the ONE open-point line; the reviewer sees the points it can address only when there are some', (t) => {
  const home = mkHome(t); seed(home);
  assert.ok(OPEN_POINT_LINE.split('\n').length === 1 && OPEN_POINT_LINE.includes('orchestra fanout open-point <your ticket> --about <that ticket> --text'));
  assert.ok(LOOP_BRIEF.includes(OPEN_POINT_LINE));
  assert.ok(renderImplementerBrief({ state: load(home), ticket: 'B1', loop: true }).includes(OPEN_POINT_LINE));
  const none = renderBriefOf(load(home), 'A1', { kind: 'spawn', head: HA, base: null }).text;
  assert.ok(none.includes(OPEN_POINT_LINE));
  assert.doesNotMatch(none, /Open points about this ticket/);
  assert.equal(op(home, 'impl-b').code, 0);
  const text = renderBriefOf(load(home), 'A1', { kind: 'wake', head: HA2, base: null }).text;
  assert.match(text, /## Open points about this ticket[\s\S]*- point 1, from B1: A1 must also dispatch the event on a manual mark[\s\S]*"addressed":\[n,…\]/);
  assert.equal(renderPointsForReviewer(load(home), 'B1'), '', 'the raising ticket\'s reviewer has nothing to address');
});

test('the report lists every open point and how it settled — addressed (ticket, head), decided (who, why), still open', (t) => {
  const home = mkHome(t); seed(home);
  assert.doesNotMatch(renderReport(buildReport(load(home))), /open points \(/); // no list when none were raised; #682: the count line (0) is still a fact
  assert.match(renderReport(buildReport(load(home))), /^open points raised: 0 /m);
  assert.equal(op(home, 'impl-b').code, 0);
  assert.equal(op(home, 'impl-b', 'B1', 'A1', 'second point').code, 0);
  assert.equal(op(home, 'impl-b', 'B1', 'C1', 'third point').code, 0);
  assert.equal(decide(home, 'r1', '2', 'fixed rule of the loop: no new head after 2 orders').code, 0);
  save(home, (s) => ({ ...s, openPoints: s.openPoints!.map((p) => (p.id === 1 ? { ...p, status: 'settled' as const, settled: { how: 'addressed' as const, at: NOW, by: 'rev-a', ticket: 'A1', head: HA2 } } : p)) }));
  const text = renderReport(buildReport(load(home)));
  assert.match(text, /open points \(3\)/);
  assert.match(text, /#1 B1 → A1: A1 must also dispatch the event on a manual mark — addressed on A1 at c{12}/);
  assert.match(text, /#2 B1 → A1: second point — decided by r1: fixed rule of the loop: no new head after 2 orders/);
  assert.match(text, /#3 B1 → C1: third point — STILL OPEN/);
  assert.equal(buildReport(load(home)).openPoints!.length, 3);
});

test('state: openPoints round-trips through the strict parser; a hand-edited point with a bad shape is refused (not silently dropped)', (t) => {
  const home = mkHome(t); seed(home);
  assert.equal(op(home, 'impl-b').code, 0);
  const file = stateFile(home, 'r1');
  const raw = JSON.parse(fs.readFileSync(file, 'utf8'));
  for (const bad of [{ ...raw.openPoints[0], from: 'A1' }, { ...raw.openPoints[0], id: 3 }, { ...raw.openPoints[0], status: 'settled' }, { ...raw.openPoints[0], extra: 1 }]) {
    fs.writeFileSync(file, JSON.stringify({ ...raw, openPoints: [bad] }));
    assert.throws(() => readState(file), /openPoints\[0\]/);
  }
});

// ── 6. cause 4: the head is fetched before the demonstration is read ──────────────────────────────────────────
const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_AUTHOR_NAME: 't', GIT_AUTHOR_EMAIL: 't@t', GIT_COMMITTER_NAME: 't', GIT_COMMITTER_EMAIL: 't@t' } }).trim();

test('record fetches the ticket branch BEFORE the demonstration check: a head that is not fetched yet no longer refuses "<file> does not exist on head" — and still refuses a file that is not there', (t) => {
  const root = mkHome(t);
  const origin = path.join(root, 'origin'), clone = path.join(root, 'clone');
  fs.mkdirSync(origin); git(origin, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(origin, 'README.md'), 'x'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'base');
  git(root, 'clone', '-q', origin, clone);
  // the ticket's branch appears on origin AFTER the clone: its head is not in the clone
  git(origin, 'checkout', '-q', '-b', 'feat'); fs.mkdirSync(path.join(origin, 'src')); fs.writeFileSync(path.join(origin, 'src', 'app.ts'), 'export const x = 1;\n'); git(origin, 'add', '.'); git(origin, 'commit', '-qm', 'feat');
  const head = git(origin, 'rev-parse', 'HEAD');
  const have = (): boolean => { try { git(clone, 'rev-parse', '--verify', '-q', `${head}^{commit}`); return true; } catch { return false; } };
  assert.equal(have(), false, 'precondition: the head is not in the clone');
  assert.notEqual(fileOnHead(defaultRunner, head, 'src/app.ts', clone, null), true, 'precondition: unread / refused before the fetch');
  // through the real verb: state with ticket T1 (branch feat, reviewer rev-1 briefed on `head`) + a demonstrated finding citing src/app.ts
  const home = path.join(root, 'home'); fs.mkdirSync(home);
  let s = newState('r1', { now: NOW, switches: { seatRecords: 'on', minorPolicy: 'demonstrated' } as never });
  s = setPlan(s, ['T1'], 'declare', NOW);
  s = applyTicketPatch(s, 'T1', { dependsOn: [], status: 'nominated', branch: 'feat', head, implementer: 'impl-1', pr: 5 }, NOW);
  s = { ...s, tickets: { ...s.tickets, T1: { ...s.tickets.T1, review: { reviewer: { id: 'rev-1', name: 'review-T1', at: NOW }, head, base: null, briefs: [brief(head, 'rev-1')] } } } };
  writeStateAtomic(stateFile(home, 'r1'), s);
  const demo = (file: string) => ({ findings: { F1: { severity: 'MINOR', evidence: 'argued', text: 'x', demonstration: { input: 'GET /orders?limit=0 as an authenticated user', observed: `${file}:1 returns every order instead of an empty page`, expected: 'the ticket says limit=0 must return an empty page' } } } });
  const run = (json: unknown, verdict: string) => runRecord(['T1', '--run', 'r1', '--head', head, '--verdict', verdict, '--json', '-'], { env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: 'rev-1' }, cwd: clone, runner: defaultRunner, now: () => NOW, readStdin: () => JSON.stringify(json), identity: HOST });
  const missing = run(demo('src/nowhere.ts'), 'approve');
  assert.equal(have(), true, `the record fetched the branch (${missing.code} ${missing.stderr})`);
  assert.equal(missing.code, 0, missing.stderr);
  assert.match(readState(stateFile(home, 'r1'))!.tickets.T1.findings.F1.demonstration!.refusal ?? '', /src\/nowhere\.ts does not exist on head/, 'a file that is really absent is still refused');
  // fresh state, same unfetched situation again, for the accepted arm
  fs.rmSync(path.join(clone, '.git', 'refs', 'remotes', 'origin', 'feat'), { force: true });
  fs.rmSync(path.join(clone, '.git', 'FETCH_HEAD'), { force: true });
  git(clone, 'reflog', 'expire', '--expire=now', '--all'); git(clone, 'gc', '-q', '--prune=now');
  assert.equal(have(), false, 'precondition of the accepted arm: the head is gone from the clone again');
  writeStateAtomic(stateFile(home, 'r1'), s);
  const ok = run(demo('src/app.ts'), 'changes-requested');
  assert.equal(ok.code, 0, ok.stderr);
  const d = readState(stateFile(home, 'r1'))!.tickets.T1.findings.F1.demonstration!;
  assert.equal(d.refusal, undefined, `the demonstration is accepted: ${d.refusal}`);
  assert.deepEqual([d.file, d.head], ['src/app.ts', head]);
  assert.equal(ensureHeadFetched(defaultRunner, head, 'feat', clone), true);
  assert.equal(ensureHeadFetched(defaultRunner, 'e'.repeat(40), 'no-such-branch', clone), false, 'a head origin cannot give stays unreadable (the forge arm decides, as before)');
});
