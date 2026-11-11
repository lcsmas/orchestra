// #427 — the roster facts behind the exclusions of the Relance, driven through the REAL mapping (relance-roster.ts) with injected deps: « released », « a workspace without a coordinator »,
// the kill switch. (relance-host.ts only wires the store / bus / pause gate in; the sweep and the decision are tested elsewhere.)
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { relanceEnabled, relanceMember, relanceMembers, type RelanceRosterDeps } from './relance-roster.ts';
import type { Workspace } from '../shared/types.ts';

const ws = (id: string, over: Partial<Workspace> = {}): Workspace => ({ id, name: id, status: 'idle', ...over }) as Workspace;
function deps(list: Workspace[], over: Partial<RelanceRosterDeps> = {}): RelanceRosterDeps & { asked: Array<Array<{ reader: string; runId: string }>> } {
  const asked: Array<Array<{ reader: string; runId: string }>> = [];
  return {
    asked,
    workspaces: () => list,
    getWorkspace: (id) => list.find((w) => w.id === id),
    released: (readers) => { asked.push([...readers]); return new Set<string>(); },
    runIdOf: (w) => `run-of-${w.id}`,
    paused: () => false,
    wakeable: () => true,
    warn: () => {},
    ...over,
  };
}
const lead = ws('lead');
const task = { lastTask: 'do it' };

test('positive control: a member with a live coordinator, a task, not released, not paused, wakeable, idle', () => {
  const d = deps([lead, ws('m1', { parentId: 'lead', ...task })]);
  assert.deepEqual(relanceMembers(d).find((m) => m.wsId === 'm1'), { wsId: 'm1', hasCoordinator: true, hasTask: true, released: false, paused: false, wakeable: true, active: false });
});

test('released: the bus read is asked for the member with ITS run, and its answer is the member\'s `released` (an empty / unasked read would relance finished members)', () => {
  const d = deps([lead, ws('m1', { parentId: 'lead', ...task }), ws('m2', { parentId: 'lead', ...task })], {
    released: (readers) => { d.asked.push([...readers]); return new Set(['m2']); },
  });
  const m = relanceMembers(d);
  assert.equal(m.find((x) => x.wsId === 'm1')?.released, false);
  assert.equal(m.find((x) => x.wsId === 'm2')?.released, true);
  assert.deepEqual(d.asked[0], [{ reader: 'm1', runId: 'run-of-m1' }, { reader: 'm2', runId: 'run-of-m2' }]);
});

test('released is read fresh for ONE member too (the check right before a delivery)', () => {
  const d = deps([lead, ws('m2', { parentId: 'lead', ...task })], { released: () => new Set(['m2']) });
  assert.equal(relanceMember(d, 'm2')?.released, true);
  assert.equal(relanceMember(d, 'nobody'), undefined);
});

test('an unreadable bus reads « nobody released » (a stalled member is never silenced) and warns', () => {
  let warned = 0;
  const d = deps([lead, ws('m1', { parentId: 'lead', ...task })], { released: () => { throw new Error('bus down'); }, warn: () => { warned++; } });
  assert.equal(relanceMembers(d).find((x) => x.wsId === 'm1')?.released, false);
  assert.equal(warned, 1);
});

test('hasCoordinator: a parent that is ARCHIVED or MISSING is nobody; no parentId is nobody; only a live parent counts', () => {
  const d = deps([lead, ws('gone', { archived: true }), ws('a', { parentId: 'lead', ...task }), ws('b', { parentId: 'gone', ...task }), ws('c', { parentId: 'missing', ...task }), ws('d', task)]);
  const by = Object.fromEntries(relanceMembers(d).map((m) => [m.wsId, m.hasCoordinator]));
  assert.deepEqual([by.a, by.b, by.c, by.d], [true, false, false, false]);
});

test('hasTask follows `lastTask`; paused / wakeable come from their gates; active = running, waiting for an answer, or a prompt queued', () => {
  const d = deps(
    [lead, ws('idle', { parentId: 'lead' }), ws('run', { parentId: 'lead', ...task, status: 'running' }), ws('wait', { parentId: 'lead', ...task, status: 'waiting' }), ws('q', { parentId: 'lead', ...task, sdkPendingPrompts: [{} as never] })],
    { paused: (w) => w.id === 'run', wakeable: (w) => w.id !== 'q' },
  );
  const by = Object.fromEntries(relanceMembers(d).map((m) => [m.wsId, m]));
  assert.equal(by.idle.hasTask, false);
  assert.deepEqual([by.run.active, by.wait.active, by.q.active, by.idle.active], [true, true, true, false]);
  assert.deepEqual([by.run.paused, by.idle.paused], [true, false]);
  assert.deepEqual([by.q.wakeable, by.idle.wakeable], [false, true]);
});

test('kill switch: ORCHESTRA_RELANCE=0 disables; unset or any other value leaves it on', () => {
  assert.equal(relanceEnabled({ ORCHESTRA_RELANCE: '0' }), false);
  assert.equal(relanceEnabled({}), true);
  assert.equal(relanceEnabled({ ORCHESTRA_RELANCE: '1' }), true);
});
