import { test } from 'node:test';
import assert from 'node:assert/strict';
import { agentsUnder, agoText, bilanAttention, memberAttention, newerOverview, noBilanState, controlOf, countdown, coveringRun, groupByMemberRun, killedText, pauseDimClass, pauseStateOf, PAUSE_STATE_WORD, releasableIds, releaseLabel, releaseScope, rowNoteText, sizeText, runHeadline, runOfControl, stateTone, treeText, wasDoingText } from './pause-ui-view.ts';
import type { PauseUiBilanLine, PauseUiControl, PauseUiMember, PauseUiOverview, PauseUiRun } from './pause-ui.ts';

const mem = (wsId: string, role: 'coordinator' | 'worker', ui: PauseUiMember['ui'], memberRun: string | null, extra: Partial<PauseUiMember> = {}): PauseUiMember => ({
  wsId, label: wsId, role, memberRun, ui, confirmVia: null, confirmedAt: null, releasedAt: null, releasedBy: null, repriseConfirmedAt: null, bilan: null, ...extra,
});
const run = (over: Partial<PauseUiRun>): PauseUiRun => ({
  carrierRunId: 'L', carrierLabel: 'fleet-lead', title: null, phase: 'paused', mode: 'hard', pausedAt: 1_000_000, pausedBy: 'L', pausedByLabel: 'fleet-lead', deadlineAt: null, escalatedAt: null, trapAt: null, resumeStartedAt: null, auto: false,
  progress: { kind: 'en-pause', done: 7, total: 7, missing: [] }, blocked: [], members: [], ...over,
});
const bilan = (over: Partial<PauseUiBilanLine>): PauseUiBilanLine => ({ snapshotRef: 'refs/orchestra/pause/L/w/1', branch: 'b', head: 'h', dirty: true, changed: { modified: 3, added: 1, deleted: 0 }, snapshotIncomplete: null, wasDoing: { turnRunning: true, inFlight: ['npx tsc --noEmit'], bgTasks: [], lastTask: null }, interrupt: 'interrupted', exempt: false, killed: [], killedCount: 2, trap: 'done', skipped: null, survivors: [], refused: [], warnings: [], notCaptured: [], notCapturedCount: 0, snapshotNotes: [], submodules: [], notes: [], error: null, ...over });

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
  const nogit = bilanAttention(bilan({ snapshotRef: null, error: 'snapshot: git rev-parse failed: fatal: not a git repository (or any parent up to mount point /)' }));
  assert.deepEqual(nogit.map((r) => r.tone), ['info'], 'a workspace without a git worktree (an orchestrator, a scratch session) is EXPECTED: info, not a red error on every pause');
  assert.deepEqual(bilanAttention(bilan({ snapshotRef: null, error: 'snapshot: git add timed out' })).map((r) => r.tone), ['error'], 'any other snapshot error stays an error');
  assert.deepEqual(bilanAttention(bilan({ snapshotRef: 'refs/orchestra/pause/L/w/1', error: 'fatal: not a git repository' })).map((r) => r.tone), ['error'], 'but a member that HAS a ref and still reports it is odd: error');
});

test('pauseDimClass: held (pausing / paused / blocked) dims the name; released / resumed does not', () => {
  const o = (ui: PauseUiOverview['byWorkspace'][string]['ui']): PauseUiOverview => ({ available: true, error: null, at: 0, runs: [], controls: {}, byWorkspace: { w: { wsId: 'w', carrierRunId: 'L', phase: 'resuming', ui, role: 'worker', via: null } } });
  assert.deepEqual(['pausing', 'paused', 'blocked', 'released', 'resumed'].map((u) => pauseDimClass(o(u as never), 'w')), [' pause-dim', ' pause-dim', ' pause-dim', '', '']);
  assert.equal(pauseDimClass(o('paused'), 'zz'), '');
  assert.equal(pauseDimClass(null, 'w'), '');
});

test('bilanAttention: what the snapshot did NOT capture is SHOWN (too large, submodule failed) — the worktree is the only copy of it', () => {
  const rows = bilanAttention(bilan({
    notCaptured: [{ path: 'data/huge.bin', bytes: 3 * 1024 * 1048576, files: null, reason: 'file-cap' }, { path: 'out/model.ckpt', bytes: 800 * 1048576, files: 4, reason: 'total-cap' }],
    notCapturedCount: 9,
    submodules: [{ path: 'vendor/lib', ref: null, dirty: true, error: 'git add failed' }, { path: 'vendor/ok', ref: 'refs/orchestra/pause/x', dirty: true, error: null }],
    snapshotNotes: ['big.bin was captured (git < 2.25 cannot exclude it)'],
  }));
  assert.deepEqual(rows.map((r) => r.tone), ['warn', 'warn', 'info', 'info']);
  assert.equal(rows[0].text, 'NON capturé dans le snapshot (trop volumineux, 9) : data/huge.bin (3,0 Go), out/model.ckpt (800 Mo, 4 fichiers, plafond total), +7 autres — son worktree en est la seule copie');
  assert.equal(rows[1].text, 'submodule vendor/lib : snapshot échoué (git add failed) — absent de toute ref');
  assert.match(rows[2].text, /submodule vendor\/ok : modifié, ref refs\/orchestra\/pause\/x/);
  assert.match(rows[3].text, /capturé malgré le plafond : big\.bin/);
});

test('sizeText: French decimals, Mo under 1 Go', () => {
  assert.deepEqual([4.2 * 1048576, 800 * 1048576, 3 * 1024 * 1048576, 10.4 * 1048576, 0.04 * 1048576].map(sizeText), ['4,2 Mo', '800 Mo', '3,0 Go', '10 Mo', '0,0 Mo']);
});

test('an EMPTY roster reads "en attente de l\'hôte" with an empty bar (never "0/0 en pause" beside a full one); Reprise too; a closed Reprise keeps its numbers', () => {
  const fresh = run({ progress: { kind: 'en-pause', done: 0, total: 0, missing: [] }, members: [] });
  const h = runHeadline(fresh, 2_000_000);
  assert.deepEqual([h.count, h.fraction], ["en attente de l'hôte", 0]);
  assert.equal(rowNoteText(fresh, 2_000_000).text, "Pause dure · en attente de l'hôte");
  assert.equal(rowNoteText(fresh, 2_000_000).fraction, 0);
  assert.equal(rowNoteText(run({ phase: 'pausing', mode: 'soft', deadlineAt: 5, progress: { kind: 'en-pause', done: 0, total: 0, missing: [] } }), 2_000_000).text, "Pause douce · en attente de l'hôte");
  assert.equal(rowNoteText(run({ phase: 'resuming', progress: { kind: 'repris', done: 0, total: 0, missing: [] } }), 2_000_000).text, "Reprise · en attente de l'hôte");
  assert.equal(runHeadline(run({ phase: 'active', progress: { kind: 'repris', done: 0, total: 0, missing: [] } }), 2_000_000).count, '0/0 repris');
});

test('releaseScope: « tout libérer » = the blocked members of the carrier\'s OWN run; a blocked worker of a run BELOW is left to its coordinator', () => {
  const ms = [mem('L', 'coordinator', 'resumed', 'L'), mem('O', 'coordinator', 'resumed', 'O'), mem('d', 'worker', 'blocked', 'L'), mem('w1', 'worker', 'blocked', 'O'), mem('w2', 'worker', 'blocked', 'O'), mem('s1', 'worker', 'released', 'S'), mem('x', 'worker', 'blocked', null)];
  assert.deepEqual(releaseScope(run({ members: ms })), { own: ['d', 'x'], below: ['w1', 'w2'] });
  assert.deepEqual(releaseScope(run({ members: [] })), { own: [], below: [] });
});

test('releaseLabel: honest about its scope — never counts the workers « tout libérer » will NOT release', () => {
  assert.equal(releaseLabel({ own: ['a'], below: [] }), 'Libérer 1 bloqué');
  assert.equal(releaseLabel({ own: ['a', 'b'], below: [] }), 'Libérer 2 bloqués');
  assert.equal(releaseLabel({ own: ['a'], below: ['x', 'y'] }), 'Libérer 1 bloqué (+2 plus bas, à part)');
  assert.equal(releaseLabel({ own: [], below: ['x'] }), 'Libérer… (1 plus bas, à part)');
});

test('noBilanState / memberAttention: a member with no Bilan row is PENDING while the trap is owed, ABSENT (and said so) once it is done or the Reprise started', () => {
  assert.equal(noBilanState({ phase: 'pausing', trapAt: null }), 'pending');
  assert.equal(noBilanState({ phase: 'paused', trapAt: null }), 'pending', 'a dure whose trap is still taking members');
  assert.equal(noBilanState({ phase: 'paused', trapAt: 5 }), 'absent', 'the trap is done: no Bilan is coming');
  assert.equal(noBilanState({ phase: 'pausing', trapAt: 5 }), 'absent');
  assert.equal(noBilanState({ phase: 'resuming', trapAt: null }), 'absent', 'a Reprise: nothing more will be recorded');
  assert.equal(noBilanState({ phase: 'active', trapAt: null }), 'absent');
  assert.deepEqual(memberAttention(null, { phase: 'paused', trapAt: null }), []);
  const gone = memberAttention(null, { phase: 'resuming', trapAt: 5 });
  assert.equal(gone.length, 1);
  assert.equal(gone[0].tone, 'warn');
  assert.match(gone[0].text, /aucun Bilan.*seule copie/);
  assert.deepEqual(memberAttention(bilan({ error: 'boom', snapshotRef: null }), { phase: 'paused', trapAt: 5 }), bilanAttention(bilan({ error: 'boom', snapshotRef: null })), 'a member WITH a Bilan: its own attention, unchanged');
});

test('newerOverview: an OLDER host-stamped overview never replaces a newer one (a write reply racing a fresher push); unstamped ones always win', () => {
  const o = (rev: number | undefined, at = 0): PauseUiOverview => ({ available: true, error: null, at, ...(rev === undefined ? {} : { rev }), runs: [], controls: {}, byWorkspace: {} });
  const cur = o(5);
  assert.equal(newerOverview(cur, o(4)), cur, 'older → dropped');
  assert.equal(newerOverview(cur, o(5, 1)).at, 1, 'same rev → taken');
  assert.equal(newerOverview(cur, o(6)).rev, 6);
  assert.equal(newerOverview(null, o(1)).rev, 1, 'nothing held → taken');
  assert.equal(newerOverview(cur, o(undefined)).rev, undefined, 'unstamped (pure layer / fixtures) → taken');
  assert.equal(newerOverview(o(undefined), o(1)).rev, 1);
});
