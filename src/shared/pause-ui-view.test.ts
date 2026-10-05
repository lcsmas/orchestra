import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agoText, countdown, groupByMemberRun, killedText, PAUSE_STATE_WORD, releasableIds, runHeadline, stateTone, treeText, wasDoingText } from './pause-ui-view.ts';
import type { PauseUiBilanLine, PauseUiMember, PauseUiRun } from './pause-ui.ts';

const mem = (wsId: string, role: 'coordinator' | 'worker', ui: PauseUiMember['ui'], memberRun: string | null, extra: Partial<PauseUiMember> = {}): PauseUiMember => ({
  wsId, label: wsId, role, memberRun, ui, confirmVia: null, confirmedAt: null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null, bilan: null, ...extra,
});
const run = (over: Partial<PauseUiRun>): PauseUiRun => ({
  carrierRunId: 'L', carrierLabel: 'fleet-lead', title: null, phase: 'paused', mode: 'hard', pausedAt: 1_000_000, pausedBy: 'L', pausedByLabel: 'fleet-lead', deadlineAt: null, escalatedAt: null, trapAt: null, resumeStartedAt: null, auto: false,
  progress: { kind: 'en-pause', done: 7, total: 7, missing: [] }, blocked: [], members: [], ...over,
});
const bilan = (over: Partial<PauseUiBilanLine>): PauseUiBilanLine => ({ snapshotRef: 'refs/orchestra/pause/L/w/1', branch: 'b', head: 'h', dirty: true, changed: { modified: 3, added: 1, deleted: 0 }, snapshotIncomplete: null, wasDoing: { turnRunning: true, inFlight: ['npx tsc --noEmit'], bgTasks: [], lastTask: null }, interrupt: 'interrupted', exempt: false, killed: [], killedCount: 2, notes: [], error: null, ...over });

test('words and tones: the mockups\' vocabulary, blue for held (blocked included), green for back', () => {
  assert.deepEqual(PAUSE_STATE_WORD, { pausing: 'finit…', paused: 'en pause', blocked: 'bloqué', released: 'libéré', resumed: 'repris' });
  assert.deepEqual(['pausing', 'paused', 'blocked', 'released', 'resumed'].map((s) => stateTone(s as never)), ['pausing', 'paused', 'paused', 'resumed', 'resumed']);
});

test('countdown / ago: m:ss clamped at 0:00; "<1 min" under a minute', () => {
  assert.equal(countdown(110_000, 0), '1:50');
  assert.equal(countdown(5_000, 9_000), '0:00');
  assert.equal(countdown(61_000, 0), '1:01');
  assert.equal(agoText(0, 30_000), 'il y a <1 min');
  assert.equal(agoText(0, 8 * 60_000 + 20_000), 'il y a 8 min');
});

test('runHeadline: douce waiting names the deadline; dure; escalated; resuming counts released/blocked; closed Reprise counts missing accusés', () => {
  const douce = runHeadline(run({ phase: 'pausing', mode: 'soft', deadlineAt: 1_000_000 + 180_000, progress: { kind: 'en-pause', done: 5, total: 7, missing: ['a', 'b'] } }), 1_070_000);
  assert.deepEqual([douce.tone, douce.title, douce.count], ['pausing', 'Pause douce en cours', '5/7 en pause']);
  assert.match(douce.sub, /posée par fleet-lead il y a 1 min · Pause dure dans 1:50 pour les retardataires/);
  assert.equal(Math.round(douce.fraction * 100), 71);
  const dure = runHeadline(run({}), 1_000_000 + 8 * 60_000);
  assert.deepEqual([dure.tone, dure.title, dure.fraction], ['paused', 'Pause dure', 1]);
  assert.equal(runHeadline(run({ mode: 'soft', escalatedAt: 5 }), 2_000_000).title, 'Pause douce → dure (escaladée)');
  const rs = runHeadline(run({ phase: 'resuming', progress: { kind: 'repris', done: 3, total: 7, missing: [] }, blocked: ['x', 'y', 'z'], members: [mem('a', 'coordinator', 'resumed', 'L', { releasedAt: 1 }), mem('b', 'worker', 'blocked', 'L')] }), 2_000_000);
  assert.deepEqual([rs.tone, rs.title, rs.count], ['resumed', 'Reprise en cours', '3/7 repris']);
  assert.match(rs.sub, /1\/7 libérés · 3 bloqués/);
  const tracked = runHeadline(run({ phase: 'active', progress: { kind: 'repris', done: 0, total: 7, missing: ['a', 'b'] } }), 3_000_000);
  assert.match(tracked.sub, /2 accusés manquants/);
  assert.match(runHeadline(run({ auto: true, pausedByLabel: null }), 1_000_000).sub, /posée par l'hôte \(limite d'usage\)/);
});

test('Bilan texts: tree / tools / what it was doing — never a guess for a missing Bilan', () => {
  assert.equal(treeText(null), 'pas encore de Bilan');
  assert.equal(treeText(bilan({ dirty: false })), 'arbre propre');
  assert.equal(treeText(bilan({})), '3 modifiés · 1 ajouté');
  assert.equal(treeText(bilan({ changed: { modified: 1, added: 0, deleted: 2 } })), '1 modifié · 2 supprimés');
  assert.equal(treeText(bilan({ snapshotIncomplete: 'timeout' })), 'snapshot incomplet (trop volumineux)');
  assert.equal(killedText(null), '');
  assert.equal(killedText(bilan({ killedCount: 0 })), 'aucun outil tué');
  assert.equal(killedText(bilan({ killedCount: 1 })), '1 outil tué');
  assert.equal(killedText(bilan({})), '2 outils tués');
  assert.equal(killedText(bilan({ exempt: true })), 'pauseur exempté');
  assert.equal(wasDoingText(null), '—');
  assert.equal(wasDoingText(bilan({})), 'npx tsc --noEmit');
  assert.equal(wasDoingText(bilan({ wasDoing: { turnRunning: false, inFlight: [], bgTasks: [], lastTask: null } })), 'au repos');
  assert.equal(wasDoingText(bilan({ wasDoing: { turnRunning: true, inFlight: [], bgTasks: ['drill ×3'], lastTask: null } })), 'drill ×3');
});

test('groupByMemberRun keeps first-seen run order, coordinators first inside a group; releasableIds = the BLOCKED members, explicit ids', () => {
  const ms = [mem('w1', 'worker', 'blocked', 'O'), mem('L', 'coordinator', 'resumed', 'L'), mem('O', 'coordinator', 'resumed', 'O'), mem('d', 'worker', 'blocked', 'L'), mem('w2', 'worker', 'released', 'O')];
  const g = groupByMemberRun(ms);
  assert.deepEqual(g.map((x) => [x.runId, x.members.map((m) => m.wsId)]), [['O', ['O', 'w1', 'w2']], ['L', ['L', 'd']]]);
  assert.deepEqual(releasableIds(run({ members: ms })), ['w1', 'd']);
});
