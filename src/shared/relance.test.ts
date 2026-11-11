// #427 — Relance (pure half): which ends a member's Reliquats had, grouping, who is eligible, what the turn says.
// A Relance is one HOST-triggered turn that carries its reason; these tests pin the decision, never the sweep.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  RELANCE_GROUP_MS,
  RELANCE_MIN_AGE_MS,
  RELANCE_PREFIX,
  buildRelance,
  buildReliquatsEndedRelance,
  decideRelance,
  isRelance,
  observeReliquats,
  procKey,
  rootsOf,
  type RelanceMember,
  type RelanceProc,
  type RelanceTrack,
} from './relance.ts';

const P = (pid: number, ppid: number, cmd = `cmd-${pid}`): RelanceProc => ({ pid, ppid, startTicks: pid * 10, comm: cmd.split(' ')[0], cmd });
const T0 = 1_000_000;
const none = () => false;
const AGE = RELANCE_MIN_AGE_MS; // a root must have been SEEN this long before its end counts

// ── observation: ends of ROOTS, never of a chain's own children ──────────────────────────────────────────────────

test('rootsOf: a process whose parent is not in the census is a root; its children are not', () => {
  const procs = [P(10, 1), P(11, 10), P(12, 11), P(20, 1)];
  assert.deepEqual(rootsOf(procs).map((p) => p.pid).sort(), [10, 20]);
});

test('observe: the first census is a baseline — nothing has ended', () => {
  const t = observeReliquats(undefined, [P(10, 1)], T0, none);
  assert.equal(t.pending.length, 0);
  assert.equal(t.roots.size, 1);
});

test('observe: a root that disappears is an end, stamped at the observation', () => {
  let t = observeReliquats(undefined, [P(10, 1), P(20, 1)], T0, none);
  t = observeReliquats(t, [P(20, 1)], T0 + AGE, none);
  assert.deepEqual(t.pending.map((e) => [e.proc.pid, e.at]), [[10, T0 + AGE]]);
});

test('must-FAIL arm — a root seen for LESS than the minimum age is not an end (the orphans of a stopped CLI — its MCP servers, a tool child — die within seconds of the session)', () => {
  let t = observeReliquats(undefined, [P(10, 1)], T0, none);
  t = observeReliquats(t, [P(10, 1), P(20, 1, 'mcp-server')], T0 + 5_000, none); // appears after the baseline…
  t = observeReliquats(t, [P(10, 1)], T0 + 10_000, none); // …and is gone 5 s later
  assert.equal(t.pending.length, 0);
  let u = observeReliquats(undefined, [P(10, 1)], T0, none);
  u = observeReliquats(u, [P(10, 1), P(20, 1)], T0 + 5_000, none);
  u = observeReliquats(u, [P(10, 1)], T0 + 5_000 + AGE, none);
  assert.deepEqual(u.pending.map((e) => e.proc.pid), [20], 'the same process, seen for the minimum age, IS an end');
});

test('observe: a CHILD of a running chain ending is not an end (the chain still runs)', () => {
  let t = observeReliquats(undefined, [P(10, 1), P(11, 10), P(12, 10)], T0, none);
  t = observeReliquats(t, [P(10, 1), P(12, 10)], T0 + AGE, none); // the child lived the minimum age: only « being a child » spares it
  assert.equal(t.pending.length, 0);
});

test('observe: a root that dies while its child lives on = ONE end; the re-rooted child is not "new" and not an end', () => {
  let t = observeReliquats(undefined, [P(10, 1), P(11, 10)], T0, none);
  t = observeReliquats(t, [P(11, 1)], T0 + AGE, none);
  assert.deepEqual(t.pending.map((e) => e.proc.pid), [10]);
  t = observeReliquats(t, [P(11, 1)], T0 + AGE + 5_000, none);
  assert.deepEqual(t.pending.map((e) => e.proc.pid), [10], 'the second look adds nothing');
});

test('observe: UNKNOWN is not NONE — an unreadable census changes nothing (no end, no baseline loss)', () => {
  let t = observeReliquats(undefined, [P(10, 1)], T0, none);
  t = observeReliquats(t, 'unknown', T0 + 5_000, none);
  assert.equal(t.pending.length, 0);
  t = observeReliquats(t, [P(10, 1)], T0 + AGE + 10_000, none);
  assert.equal(t.pending.length, 0, 'it was still there: no end');
});

test('observe: a pid reused by another process (new start-time) is an END of the first and not a survivor', () => {
  let t = observeReliquats(undefined, [{ ...P(10, 1), startTicks: 100 }], T0, none);
  t = observeReliquats(t, [{ ...P(10, 1), startTicks: 999 }], T0 + AGE, none);
  assert.deepEqual(t.pending.map((e) => e.proc.startTicks), [100]);
});

test('observe: what the HOST stopped (Veille, Pause, scope stop) is never an end', () => {
  let t = observeReliquats(undefined, [P(10, 1), P(20, 1)], T0, none);
  t = observeReliquats(t, [], T0 + AGE, (k) => k === procKey(P(10, 1)));
  assert.deepEqual(t.pending.map((e) => e.proc.pid), [20], 'only the natural end counts');
});

test('observe: an end seen is kept across later looks until a decision takes it', () => {
  let t = observeReliquats(undefined, [P(10, 1), P(20, 1)], T0, none);
  t = observeReliquats(t, [P(20, 1)], T0 + AGE, none);
  t = observeReliquats(t, [P(20, 1)], T0 + AGE + 5_000, none);
  t = observeReliquats(t, [], T0 + AGE + 10_000, none);
  assert.deepEqual(t.pending.map((e) => [e.proc.pid, e.at]), [[10, T0 + AGE], [20, T0 + AGE + 10_000]]);
});

// ── decision ─────────────────────────────────────────────────────────────────────────────────────────────────────

const member = (over: Partial<RelanceMember> = {}): RelanceMember => ({
  wsId: 'ws-1', hasCoordinator: true, hasTask: true, released: false, paused: false, wakeable: true, active: false, ...over,
});
const trackWith = (ends: Array<[number, number]>, running: RelanceProc[] = []): RelanceTrack => ({
  roots: new Map(running.map((p) => [procKey(p), p])),
  seen: new Map(running.map((p) => [procKey(p), 0])),
  pending: ends.map(([pid, at]) => ({ proc: P(pid, 1), at })),
});
const NOW = T0 + RELANCE_GROUP_MS + 1;

test('positive control: an idle member with a task, a coordinator and an end past the grouping window ⇒ FIRE naming the end', () => {
  const v = decideRelance(member(), trackWith([[10, T0]]), NOW);
  assert.equal(v.kind, 'fire');
  if (v.kind === 'fire') assert.deepEqual(v.ended.map((e) => e.proc.pid), [10]);
});

test('the end of ONE process fires while ANOTHER keeps running — the survivor is listed, not waited for', () => {
  const server = P(30, 1, 'node server.js');
  const v = decideRelance(member(), trackWith([[10, T0]], [server]), NOW);
  assert.equal(v.kind, 'fire');
  if (v.kind === 'fire') assert.deepEqual(v.running.map((p) => p.pid), [30]);
});

test('grouping: ends close together wait for the window, then make ONE Relance listing all of them', () => {
  const tr = trackWith([[10, T0], [20, T0 + 4_000], [40, T0 + 9_000]]);
  assert.deepEqual(decideRelance(member(), tr, T0 + RELANCE_GROUP_MS - 1), { kind: 'wait', why: 'grouping', keep: tr.pending });
  const v = decideRelance(member(), tr, T0 + RELANCE_GROUP_MS);
  assert.equal(v.kind, 'fire');
  if (v.kind === 'fire') assert.deepEqual(v.ended.map((e) => e.proc.pid), [10, 20, 40]);
});

const DROP: Array<[string, Partial<RelanceMember>, string]> = [
  ['a member WITHOUT a coordinator (a workspace the human drives)', { hasCoordinator: false }, 'no-coordinator'],
  ['a member with NO dispatched task', { hasTask: false }, 'no-task'],
  ['a member whose task is finished and RELEASED', { released: true }, 'released'],
];
for (const [label, over, why] of DROP) {
  test(`must-FAIL arm — no Relance for ${label}: dropped as '${why}'`, () => {
    const v = decideRelance(member(over), trackWith([[10, T0]]), NOW);
    assert.deepEqual({ kind: v.kind, ...(v.kind !== 'fire' ? { why: (v as { why: string }).why } : {}) }, { kind: 'drop', why });
    assert.equal(decideRelance(member(), trackWith([[10, T0]]), NOW).kind, 'fire', 'and the same member without the exclusion is fired');
  });
}

const WAIT: Array<[string, Partial<RelanceMember>, string]> = [
  ['a member of a PAUSED run (the Reprise resumes it: its script still ended)', { paused: true }, 'paused'],
  ['a member that cannot be woken YET (no worktree, a start that keeps failing)', { wakeable: false }, 'not-wakeable'],
];
for (const [label, over, why] of WAIT) {
  test(`must-FAIL arm — ${label}: no Relance now, the end is KEPT ('${why}') and fires once the exclusion lifts`, () => {
    const tr = trackWith([[10, T0]]);
    assert.deepEqual(decideRelance(member(over), tr, NOW), { kind: 'wait', why, keep: tr.pending });
    assert.equal(decideRelance(member(), tr, NOW).kind, 'fire');
  });
}

test('must-FAIL arm — an ACTIVE member is not relanced now; the end is KEPT and fires once it is idle', () => {
  const tr = trackWith([[10, T0]]);
  const busy = decideRelance(member({ active: true }), tr, NOW);
  assert.deepEqual(busy, { kind: 'wait', why: 'active', keep: tr.pending });
  assert.equal(decideRelance(member({ active: false }), tr, NOW).kind, 'fire');
});

test('must-FAIL arm — an end that happened DURING the member\'s turn is still announced once it is idle (no acknowledgement by activity: the turn\'s own last event is later than the end, yet the member never saw it)', () => {
  const tr = trackWith([[10, T0], [20, T0 + 8_000]]);
  assert.equal(decideRelance(member({ active: true }), tr, T0 + 60_000).kind, 'wait');
  const v = decideRelance(member(), tr, T0 + 60_000);
  assert.equal(v.kind, 'fire');
  if (v.kind === 'fire') assert.deepEqual(v.ended.map((e) => e.proc.pid), [10, 20]);
});

test('the pending ends are bounded: a member active for hours keeps the newest 50, never an unbounded list', () => {
  let t = observeReliquats(undefined, Array.from({ length: 80 }, (_, i) => P(1000 + i, 1)), T0, none);
  t = observeReliquats(t, [], T0 + AGE, none);
  assert.equal(t.pending.length, 50);
  assert.equal(t.pending[49].proc.pid, 1079, 'the newest are kept');
});

test('nothing ended ⇒ nothing to decide', () => {
  assert.deepEqual(decideRelance(member(), trackWith([]), NOW), { kind: 'drop', why: 'nothing-ended', keep: [] });
});

// ── the turn's text ──────────────────────────────────────────────────────────────────────────────────────────────

test('the Relance names what ended, what still runs, and says it comes from the host', () => {
  const text = buildReliquatsEndedRelance(
    [{ proc: P(10, 1, 'bash /tmp/run-chain.sh'), at: Date.UTC(2026, 10, 10, 23, 16, 4) }],
    [P(30, 1, 'node server.js')],
  );
  assert.ok(isRelance(text));
  assert.ok(text.startsWith(RELANCE_PREFIX));
  assert.match(text, /bash \/tmp\/run-chain\.sh/);
  assert.match(text, /23:16:04/);
  assert.match(text, /node server\.js/);
  assert.match(text, /still running/i);
});

test('no survivor ⇒ the text says nothing else of the member runs', () => {
  const text = buildReliquatsEndedRelance([{ proc: P(10, 1, 'sh chain.sh'), at: T0 }], []);
  assert.match(text, /no other leftover process/i);
});

test('the text strips control characters from a command line and bounds long lists', () => {
  const ends = Array.from({ length: 14 }, (_, i) => ({ proc: P(100 + i, 1, `job${i}\u001b[31m\nINJECT`), at: T0 }));
  const text = buildReliquatsEndedRelance(ends, []);
  assert.ok(!/\u001b/.test(text));
  assert.ok(!/\nINJECT/.test(text), 'a newline in a command cannot start a line of its own');
  assert.match(text, /and 4 more/);
});

test('buildRelance is the reusable primitive: any reason, same recognisable header, never a Réveil', () => {
  const text = buildRelance('your vague is asleep', ['3 task(s) wait']);
  assert.ok(isRelance(text));
  assert.ok(!isRelance('orchestra check --run r1'));
  assert.ok(!isRelance('hello'));
});

test('must-FAIL arm — a server alive for an hour whose launcher exits becomes a root KEEPING its age: its end 5 s later is announced', () => {
  let t = observeReliquats(undefined, [P(10, 1, 'sh chain.sh'), P(11, 10, 'node server.js')], T0, none);
  t = observeReliquats(t, [P(10, 1, 'sh chain.sh'), P(11, 10, 'node server.js')], T0 + 3_600_000, none);
  t = observeReliquats(t, [P(11, 1, 'node server.js')], T0 + 3_605_000, none); // the launcher is gone, the server is now a root
  assert.deepEqual(t.pending.map((e) => e.proc.pid), [10]);
  t = observeReliquats(t, [], T0 + 3_610_000, none);
  assert.deepEqual(t.pending.map((e) => e.proc.pid), [10, 11], 'the server\'s end, 5 s after it became a root, is not hidden by the min age');
});

test('the text never tells a member with nothing to do to report to its coordinator', () => {
  const text = buildReliquatsEndedRelance([{ proc: P(10, 1, 'sh chain.sh'), at: T0 }], []);
  assert.doesNotMatch(text, /coordinator/i);
  assert.match(text, /nothing to do/i);
});
