import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsUnder, agoText, bilanAttention, controlOf, countdown, coveringRun, groupByMemberRun, killedText, pauseDimClass, pauseStateOf, PAUSE_STATE_WORD, releasableIds, rowNoteText, runHeadline, runOfControl, stateTone, treeText, wasDoingText } from './pause-ui-view.ts';
import type { PauseUiBilanLine, PauseUiControl, PauseUiMember, PauseUiOverview, PauseUiRun } from './pause-ui.ts';

const mem = (wsId: string, role: 'coordinator' | 'worker', ui: PauseUiMember['ui'], memberRun: string | null, extra: Partial<PauseUiMember> = {}): PauseUiMember => ({
  wsId, label: wsId, role, memberRun, ui, confirmVia: null, confirmedAt: null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null, bilan: null, ...extra,
});
const run = (over: Partial<PauseUiRun>): PauseUiRun => ({
  carrierRunId: 'L', carrierLabel: 'fleet-lead', title: null, phase: 'paused', mode: 'hard', pausedAt: 1_000_000, pausedBy: 'L', pausedByLabel: 'fleet-lead', deadlineAt: null, escalatedAt: null, trapAt: null, resumeStartedAt: null, auto: false,
  progress: { kind: 'en-pause', done: 7, total: 7, missing: [] }, blocked: [], members: [], ...over,
});
const bilan = (over: Partial<PauseUiBilanLine>): PauseUiBilanLine => ({ snapshotRef: 'refs/orchestra/pause/L/w/1', branch: 'b', head: 'h', dirty: true, changed: { modified: 3, added: 1, deleted: 0 }, snapshotIncomplete: null, wasDoing: { turnRunning: true, inFlight: ['npx tsc --noEmit'], bgTasks: [], lastTask: null }, interrupt: 'interrupted', exempt: false, killed: [], killedCount: 2, trap: 'done', skipped: null, survivors: [], refused: [], warnings: [], notes: [], error: null, ...over });

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
  assert.equal(runHeadline(run({ progress: { kind: 'en-pause', done: 3, total: 7, missing: [] } }), 2_000_000).fraction.toFixed(2), '0.43', 'a hard pause whose trap is still taking members: the bar says 3/7, not full');
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
  assert.equal(killedText(bilan({ trap: 'pending', killedCount: 0 })), 'trap en cours', 'killed_json NULL is NOT "aucun outil tué"');
  assert.equal(killedText(bilan({ trap: 'skipped', killedCount: 0 })), 'non applicable');
  assert.equal(killedText(bilan({ survivors: [{ cmd: 'sleep 600', pid: 2, reason: 'alive' }] })), '2 outils tués · ⚠ 1 encore vivant');
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

test('selectors: a row\'s state, its control, the run it anchors, the run that covers it — null while the overview is not loaded', () => {
  const ctl = (wsId: string, runId: string, coveredBy: PauseUiControl['coveredBy'] = null): PauseUiControl => ({ wsId, runId, anchored: true, switchOn: true, phase: 'active', coveredBy, can: { pauseSoft: { ok: true }, pauseHard: { ok: true }, resume: { ok: true }, release: { ok: true } } });
  const o: PauseUiOverview = { available: true, error: null, at: 0, runs: [run({ carrierRunId: 'L' })], controls: { L: ctl('L', 'L'), O: ctl('O', 'O', { runId: 'L', label: 'fleet-lead' }) }, byWorkspace: { w1: { wsId: 'w1', carrierRunId: 'L', phase: 'paused', ui: 'paused', role: 'worker', via: 'trap' } } };
  assert.equal(pauseStateOf(o, 'w1')?.ui, 'paused');
  assert.equal(pauseStateOf(o, 'zzz'), null);
  assert.equal(controlOf(o, 'L')?.runId, 'L');
  assert.equal(controlOf(o, 'w1'), null, 'a worker row has no control');
  assert.equal(runOfControl(o, controlOf(o, 'L'))?.carrierRunId, 'L');
  assert.equal(runOfControl(o, controlOf(o, 'O')), null, 'O anchors a run that holds no pause of its own');
  assert.equal(coveringRun(o, controlOf(o, 'O'))?.carrierRunId, 'L');
  assert.equal(coveringRun(o, controlOf(o, 'L')), null);
  for (const f of [pauseStateOf(null, 'w1'), controlOf(undefined, 'L'), runOfControl(null, null), coveringRun(null, null)]) assert.equal(f, null);
});

test('rowNoteText: the three note lines of the mockup (douce countdown / dure since / Reprise blocked)', () => {
  const douce = rowNoteText(run({ phase: 'pausing', mode: 'soft', deadlineAt: 1_000_000 + 180_000, progress: { kind: 'en-pause', done: 5, total: 7, missing: ['a', 'b'] } }), 1_070_000);
  assert.deepEqual([douce.tone, douce.text], ['pausing', 'Pause douce · 5/7 · dure dans 1:50']);
  const dure = rowNoteText(run({}), 1_000_000 + 8 * 60_000);
  assert.deepEqual([dure.tone, dure.text, dure.fraction], ['paused', 'En pause · 7/7 · depuis 8 min', 1]);
  assert.equal(rowNoteText(run({ mode: 'soft', escalatedAt: 1 }), 1_000_000 + 60_000).text, 'En pause (douce → dure) · 7/7 · depuis 1 min');
  const rs = rowNoteText(run({ phase: 'resuming', progress: { kind: 'repris', done: 3, total: 7, missing: [] }, blocked: ['a', 'b', 'c'] }), 2_000_000);
  assert.deepEqual([rs.tone, rs.text], ['resumed', 'Reprise · 3/7 repris · 3 bloqués']);
  assert.equal(rowNoteText(run({ phase: 'resuming', progress: { kind: 'repris', done: 6, total: 7, missing: [] }, blocked: ['a'] }), 2_000_000).text, 'Reprise · 6/7 repris · 1 bloqué');
});

test('agentsUnder: the row itself + every live descendant, archived ones left out, a cycle ends', () => {
  const ws = [{ id: 'L' }, { id: 'O', parentId: 'L' }, { id: 'a', parentId: 'O' }, { id: 'b', parentId: 'O' }, { id: 'x', parentId: 'O', archived: true }, { id: 'z' }, { id: 'c1', parentId: 'c2' }, { id: 'c2', parentId: 'c1' }];
  assert.equal(agentsUnder('L', ws), 4);
  assert.equal(agentsUnder('O', ws), 3);
  assert.equal(agentsUnder('a', ws), 1);
  assert.equal(agentsUnder('c1', ws), 2);
});

test('bilanAttention: an error, a survivor, an incomplete trap / snapshot, an unconfirmed interrupt are SHOWN (worst first) — a clean Bilan says nothing', () => {
  assert.deepEqual(bilanAttention(null), []);
  assert.deepEqual(bilanAttention(bilan({})), []);
  const rows = bilanAttention(bilan({ error: 'kill: 2 tool process(es) still alive after the trap', survivors: [{ cmd: 'sleep 600', pid: 7, reason: 'same identity' }], refused: [{ cmd: 'x', pid: 9, reason: 'unreadable' }], trap: 'pending', snapshotIncomplete: 'timeout', warnings: ['a.bin'], interrupt: 'unresponsive', notes: ['n1', 'n2', 'n3', 'n4'] }));
  assert.deepEqual(rows.map((r) => r.tone), ['error', 'error', 'warn', 'warn', 'warn', 'warn', 'warn', 'info', 'info', 'info']);
  assert.match(rows[0].text, /^erreur : kill: 2 tool process/);
  assert.match(rows[1].text, /encore vivant après la pause : sleep 600 \(pid 7\)/);
  assert.equal(rows.filter((r) => r.tone === 'info').map((r) => r.text).join(), 'n2,n3,n4', 'the last 3 notes');
  assert.match(bilanAttention(bilan({ trap: 'skipped', skipped: 'sandbox member' }))[0].text, /non applicable : sandbox member/);
});

test('pauseDimClass: held (pausing / paused / blocked) dims the name; released / resumed does not', () => {
  const o = (ui: PauseUiOverview['byWorkspace'][string]['ui']): PauseUiOverview => ({ available: true, error: null, at: 0, runs: [], controls: {}, byWorkspace: { w: { wsId: 'w', carrierRunId: 'L', phase: 'resuming', ui, role: 'worker', via: null } } });
  assert.deepEqual(['pausing', 'paused', 'blocked', 'released', 'resumed'].map((u) => pauseDimClass(o(u as never), 'w')), [' pause-dim', ' pause-dim', ' pause-dim', '', '']);
  assert.equal(pauseDimClass(o('paused'), 'zz'), '');
  assert.equal(pauseDimClass(null, 'w'), '');
});
