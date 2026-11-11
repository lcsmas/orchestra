// #428 — the roster facts behind the asleep-vague clauses, driven through the REAL mapping (vague-roster.ts) with injected deps: which runs are vagues, who is a member / the coordinator, and the
// facts « active / waiting / held start / paused / run held / unfinished ». (vague-endormie-host.ts only wires the store / bus / pause gate in; the sweep and the decision are tested elsewhere.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { vagueFacts, vagueFactsOf, type VagueRosterDeps } from './vague-roster.ts';
import { stepVague } from '../shared/vague-endormie.ts';
import type { Workspace } from '../shared/types.ts';

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, name: id, status: 'idle', ...over }) as Workspace;
const task = { lastTask: 'do it' };
type Keys = Array<{ reader: string; runId: string }>;
function deps(list: Workspace[], over: Partial<VagueRosterDeps> = {}): VagueRosterDeps & { releasedAsked: Keys[]; waitingAsked: Keys[] } {
  const releasedAsked: Keys[] = [];
  const waitingAsked: Keys[] = [];
  return {
    releasedAsked,
    waitingAsked,
    workspaces: () => list,
    getWorkspace: (id) => list.find((w) => w.id === id),
    // an orchestrator is its own run; a member's run is its parent's (one level is enough here)
    runIdOf: (w) => (w.id.startsWith('ops') ? w.id : (w.parentId ?? w.id)),
    released: (r) => { releasedAsked.push([...r]); return new Set<string>(); },
    busWaiting: (r) => { waitingAsked.push([...r]); return new Set<string>(); },
    paused: () => false,
    heldStart: () => false,
    heldRuns: () => new Set<string>(),
    lastActivityAt: (w) => (w.createdAt ?? 0),
    ...over,
  };
}
const ops = ws('ops');
const factsOf = (d: VagueRosterDeps, id = 'ops') => vagueFacts(d).find((f) => f.runId === id);

test('positive control: a run with a live coordinator and a dispatched member is a vague; the member is unfinished and idle', () => {
  const f = factsOf(deps([ops, ws('m1', { parentId: 'ops', ...task })]))!;
  assert.equal(f.coordinator.wsId, 'ops');
  assert.deepEqual(f.members.map((m) => [m.wsId, m.unfinished, m.active, m.waiting, m.heldStart, m.task]), [['m1', true, false, false, false, 'do it']]);
  assert.deepEqual([f.paused, f.runHeld], [false, false]);
});

test('not a vague: a coordinator whose members have no task; a workspace that is its own run; an archived or missing coordinator', () => {
  assert.deepEqual(vagueFacts(deps([ops, ws('m1', { parentId: 'ops' })])), [], 'a hand-made workspace under a coordinator has no dispatched task');
  assert.deepEqual(vagueFacts(deps([ws('solo', task)])), []);
  assert.deepEqual(vagueFacts(deps([ws('ops', { archived: true }), ws('m1', { parentId: 'ops', ...task })])), []);
  assert.deepEqual(vagueFacts(deps([ws('m1', { parentId: 'ops-missing', ...task })])), []);
});

test('a hand-made workspace under the coordinator (no dispatched task) is a participant but NEVER an unfinished task — a vague whose only tasked member is released has nothing left', () => {
  const d = deps([ops, ws('m1', { parentId: 'ops', ...task }), ws('m2', { parentId: 'ops' })], { released: () => new Set(['m1']) });
  const f = factsOf(d)!;
  assert.deepEqual(f.members.map((m) => [m.wsId, m.unfinished]), [['m1', false], ['m2', false]]);
});

test('an ARCHIVED member is gone: it is neither a participant nor an unfinished task', () => {
  const f = factsOf(deps([ops, ws('m1', { parentId: 'ops', ...task }), ws('m2', { parentId: 'ops', ...task, archived: true })]))!;
  assert.deepEqual(f.members.map((m) => m.wsId), ['m1']);
});

test('released: the bus read is asked for each task member with ITS run; a released member is not unfinished (an empty read would nudge a finished vague)', () => {
  const d = deps([ops, ws('m1', { parentId: 'ops', ...task }), ws('m2', { parentId: 'ops', ...task })], {
    released: (r) => { d.releasedAsked.push([...r]); return new Set(['m2']); },
  });
  const f = factsOf(d)!;
  assert.deepEqual(f.members.map((m) => [m.wsId, m.unfinished]), [['m1', true], ['m2', false]]);
  assert.deepEqual(d.releasedAsked[0], [{ reader: 'm1', runId: 'ops' }, { reader: 'm2', runId: 'ops' }]);
});

test('waiting: the app-level needs-input status OR the bus opener of an unanswered ask / gate — for a member AND for the coordinator', () => {
  const d = deps([ws('ops', { status: 'waiting' }), ws('m1', { parentId: 'ops', ...task, status: 'waiting' }), ws('m2', { parentId: 'ops', ...task }), ws('m3', { parentId: 'ops', ...task })], {
    busWaiting: (r) => { d.waitingAsked.push([...r]); return new Set(['m2']); },
  });
  const f = factsOf(d)!;
  assert.deepEqual(f.members.map((m) => m.waiting), [true, true, false]);
  assert.equal(f.coordinator.waiting, true);
  assert.deepEqual(d.waitingAsked[0].map((k) => k.reader), ['ops', 'm1', 'm2', 'm3'], 'the coordinator is asked about too');
  assert.ok(d.waitingAsked[0].every((k) => k.runId === 'ops'));
});

test('active: a running turn or a queued prompt; heldStart from Admission; the coordinator\'s too', () => {
  const d = deps([ws('ops', { status: 'running' }), ws('m1', { parentId: 'ops', ...task, status: 'running' }), ws('m2', { parentId: 'ops', ...task, sdkPendingPrompts: [{} as never] }), ws('m3', { parentId: 'ops', ...task })], { heldStart: (w) => w.id === 'm3' });
  const f = factsOf(d)!;
  assert.deepEqual(f.members.map((m) => [m.active, m.heldStart]), [[true, false], [true, false], [false, true]]);
  assert.equal(f.coordinator.active, true);
});

test('paused: ANY participant of the run paused (the coordinator or a member); runHeld from the run row', () => {
  const list = [ops, ws('m1', { parentId: 'ops', ...task })];
  assert.equal(factsOf(deps(list, { paused: (w) => w.id === 'm1' }))!.paused, true);
  assert.equal(factsOf(deps(list, { paused: (w) => w.id === 'ops' }))!.paused, true);
  assert.equal(factsOf(deps(list))!.paused, false);
  assert.equal(factsOf(deps(list, { heldRuns: () => new Set(['ops']) }))!.runHeld, true);
  assert.equal(factsOf(deps(list, { heldRuns: () => new Set(['other']) }))!.runHeld, false);
});

test('the activity clock is the one the host reads (`lastActivityAt`), per participant', () => {
  const f = factsOf(deps([ws('ops', { createdAt: 5 }), ws('m1', { parentId: 'ops', ...task, createdAt: 9 })]))!;
  assert.deepEqual([f.coordinator.lastActivityAt, f.members[0].lastActivityAt], [5, 9]);
});

test('an unreadable bus THROWS (the sweep judges nobody): a guess would hide a stalled vague or nudge a finished one', () => {
  const list = [ops, ws('m1', { parentId: 'ops', ...task })];
  assert.throws(() => vagueFacts(deps(list, { released: () => { throw new Error('bus down'); } })), /bus down/);
  assert.throws(() => vagueFacts(deps(list, { busWaiting: () => { throw new Error('bus down'); } })), /bus down/);
  assert.throws(() => vagueFacts(deps(list, { heldRuns: () => { throw new Error('bus down'); } })), /bus down/);
});

test('vagueFactsOf reads ONE vague fresh (and none for an unknown run)', () => {
  const d = deps([ops, ws('m1', { parentId: 'ops', ...task }), ws('ops2'), ws('n1', { parentId: 'ops2', ...task })]);
  assert.equal(vagueFactsOf(d, 'ops2')?.members[0].wsId, 'n1');
  assert.equal(vagueFactsOf(d, 'nope'), undefined);
});

test('through the decision: the roster\'s facts for the night of 2026-11-10 (members idle, task unfinished) go asleep; flip ONE fact and they do not', () => {
  const T = 1_000_000;
  const mk = (over: Partial<Workspace>, dep: Partial<VagueRosterDeps> = {}) => factsOf(deps([ws('ops', { createdAt: T }), ws('m1', { parentId: 'ops', ...task, createdAt: T, ...over })], dep))!;
  const kind = (f: ReturnType<typeof mk>) => stepVague(undefined, f, () => new Map(), T + 11 * 60_000).verdict.kind;
  assert.equal(kind(mk({})), 'asleep');
  assert.equal(kind(mk({ status: 'running' })), 'awake');
  assert.equal(kind(mk({ status: 'waiting' })), 'awake');
  assert.equal(kind(mk({}, { busWaiting: () => new Set(['m1']) })), 'awake');
  assert.equal(kind(mk({}, { released: () => new Set(['m1']) })), 'awake');
  assert.equal(kind(mk({}, { paused: () => true })), 'awake');
  assert.equal(kind(mk({}, { heldRuns: () => new Set(['ops']) })), 'awake');
  assert.equal(kind(mk({}, { heldStart: () => true })), 'awake');
});
