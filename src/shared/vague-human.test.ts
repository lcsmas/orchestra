// #429 — the human step, pure half: when the human is told (one must-FAIL arm per clause), the two delays as settings, the mark's shape and words.
import test from 'node:test';
import assert from 'node:assert/strict';
import {
  DEFAULT_VAGUE_DELAYS,
  VAGUE_DELAY_MAX,
  VAGUE_HUMAN_MS,
  delaysToMs,
  foldHintTitle,
  foldedMarks,
  relancerLabel,
  humanStepDue,
  isDimmedMember,
  localHHMM,
  markOfCoordinator,
  markSubLine,
  newerVagueMarks,
  normalizeVagueDelays,
  notificationOf,
  pendingWords,
  vagueDelaysError,
  vagueDimClass,
  type VagueMark,
  type VagueMarks,
} from './vague-human.ts';

const MIN = 60_000;
const T0 = Date.UTC(2026, 10, 10, 23, 19);

test('the spec delays: asleep after 10 min, tell the human 15 min after the Relance', () => {
  assert.deepEqual(DEFAULT_VAGUE_DELAYS, { asleepMin: 10, humanMin: 15 });
  assert.equal(VAGUE_HUMAN_MS, 15 * MIN);
  assert.deepEqual(delaysToMs({ asleepMin: 2, humanMin: 3 }), { quietMs: 2 * MIN, humanMs: 3 * MIN });
});

test('humanStepDue — told 15 min after the Relance, not a minute before (must-FAIL arm: 14m59s)', () => {
  const ep = { declaredAt: T0, nudgedAt: T0 + MIN };
  assert.equal(humanStepDue(ep, 'done', T0 + MIN + 15 * MIN - 1, 15 * MIN), false, '1 ms early');
  assert.equal(humanStepDue(ep, 'done', T0 + MIN + 15 * MIN, 15 * MIN), true, 'exactly at the delay');
  assert.equal(humanStepDue(ep, 'done', T0 + MIN + 16 * MIN, 15 * MIN), true);
});

test('humanStepDue — the delay runs from the RELANCE, not the declaration (must-FAIL arm: a clock from the declaration would be due here)', () => {
  const ep = { declaredAt: T0, nudgedAt: T0 + 10 * MIN };
  assert.equal(humanStepDue(ep, 'done', T0 + 15 * MIN, 15 * MIN), false, 'declared 15 min ago, Relanced 5 min ago');
  assert.equal(humanStepDue(ep, 'done', T0 + 25 * MIN, 15 * MIN), true);
});

test('humanStepDue — a coordinator with NO PARENT: the step starts at the declaration (nothing was sent, nothing to wait for)', () => {
  assert.equal(humanStepDue({ declaredAt: T0 }, 'no-parent', T0, 15 * MIN), true);
  assert.equal(humanStepDue({ declaredAt: T0 }, 'no-parent', T0 + 1, 15 * MIN), true);
  // control: the same instant for a parented coordinator whose Relance is owed is NOT due
  assert.equal(humanStepDue({ declaredAt: T0 }, 'owed', T0, 15 * MIN), false);
});

test('humanStepDue — a Relance that cannot go out (owed / not wakeable) leaves the vague asleep: the delay runs from the declaration', () => {
  for (const nudge of ['owed', 'not-wakeable'] as const) {
    assert.equal(humanStepDue({ declaredAt: T0 }, nudge, T0 + 15 * MIN - 1, 15 * MIN), false, `${nudge} 1 ms early`);
    assert.equal(humanStepDue({ declaredAt: T0 }, nudge, T0 + 15 * MIN, 15 * MIN), true, `${nudge} at the delay`);
  }
});

test('humanStepDue — once told, always due: lengthening the delay later does not take the mark down', () => {
  assert.equal(humanStepDue({ declaredAt: T0, nudgedAt: T0, humanAt: T0 + 15 * MIN }, 'done', T0 + 16 * MIN, 24 * 60 * MIN), true);
  // control: without humanAt the same longer delay is NOT due
  assert.equal(humanStepDue({ declaredAt: T0, nudgedAt: T0 }, 'done', T0 + 16 * MIN, 24 * 60 * MIN), false);
});

test('humanStepDue — the delay is read as given (a setting): 1 min vs 60 min', () => {
  const ep = { declaredAt: T0, nudgedAt: T0 };
  assert.equal(humanStepDue(ep, 'done', T0 + 2 * MIN, 1 * MIN), true);
  assert.equal(humanStepDue(ep, 'done', T0 + 2 * MIN, 60 * MIN), false);
});

test('normalizeVagueDelays — a malformed store reads as the defaults, field by field', () => {
  assert.deepEqual(normalizeVagueDelays(undefined), DEFAULT_VAGUE_DELAYS);
  assert.deepEqual(normalizeVagueDelays('nope'), DEFAULT_VAGUE_DELAYS);
  assert.deepEqual(normalizeVagueDelays({ asleepMin: 3, humanMin: 7 }), { asleepMin: 3, humanMin: 7 });
  assert.deepEqual(normalizeVagueDelays({ asleepMin: 3 }), { asleepMin: 3, humanMin: 15 });
  assert.deepEqual(normalizeVagueDelays({ asleepMin: 0, humanMin: -4 }), DEFAULT_VAGUE_DELAYS);
  assert.deepEqual(normalizeVagueDelays({ asleepMin: 1.5, humanMin: '20' }), DEFAULT_VAGUE_DELAYS);
  assert.deepEqual(normalizeVagueDelays({ asleepMin: VAGUE_DELAY_MAX + 1, humanMin: VAGUE_DELAY_MAX }), { asleepMin: 10, humanMin: VAGUE_DELAY_MAX });
});

test('vagueDelaysError — the write path refuses what the reader would silently replace', () => {
  assert.equal(vagueDelaysError({ asleepMin: 10, humanMin: 15 }), null);
  assert.equal(vagueDelaysError({ asleepMin: 1, humanMin: VAGUE_DELAY_MAX }), null);
  assert.match(vagueDelaysError({ asleepMin: 0, humanMin: 15 }) ?? '', /endormie/);
  assert.match(vagueDelaysError({ asleepMin: 10, humanMin: 0 }) ?? '', /prévenir/);
  assert.notEqual(vagueDelaysError({ asleepMin: 2.5, humanMin: 15 }), null);
  assert.notEqual(vagueDelaysError({ asleepMin: 10, humanMin: VAGUE_DELAY_MAX + 1 }), null);
  assert.notEqual(vagueDelaysError(null), null);
});

const mark = (over: Partial<VagueMark> = {}): VagueMark => ({ runId: 'ops', coordinatorId: 'ops', coordinator: 'ops-bloc-html', since: T0, pending: 1, memberIds: ['i1', 'i2'], canRelance: true, relancing: false, ...over });

test('the mark is on the coordinator row, the members are dimmed, nobody else is', () => {
  const m: VagueMarks = { rev: 1, marks: [mark()] };
  assert.equal(markOfCoordinator(m, 'ops')?.pending, 1);
  assert.equal(markOfCoordinator(m, 'i1'), undefined, 'a member carries no mark');
  assert.equal(markOfCoordinator(m, 'lead'), undefined);
  assert.equal(markOfCoordinator(null, 'ops'), undefined);
  assert.equal(vagueDimClass(m, 'i1'), ' vague-dim');
  assert.equal(vagueDimClass(m, 'i2'), ' vague-dim');
  assert.equal(vagueDimClass(m, 'ops'), '', 'the coordinator row stays at full strength (it carries the mark)');
  assert.equal(vagueDimClass(m, 'lead'), '', 'an unrelated row is untouched');
  assert.equal(isDimmedMember({ rev: 2, marks: [] }, 'i1'), false, 'no mark → nothing dimmed (the resumed state)');
  assert.equal(vagueDimClass(null, 'i1'), '');
});

test('the later of two readings wins; a stale pull never rolls a push back', () => {
  const a: VagueMarks = { rev: 4, marks: [mark()] };
  const b: VagueMarks = { rev: 5, marks: [] };
  assert.equal(newerVagueMarks(a, b), b);
  assert.equal(newerVagueMarks(b, a), b, 'older reading ignored');
  assert.equal(newerVagueMarks(null, a), a);
});

test('words: « depuis HH:MM · N tâche(s) en attente » in the reader\'s time zone', () => {
  assert.equal(pendingWords(1), '1 tâche en attente');
  assert.equal(pendingWords(3), '3 tâches en attente');
  const was = process.env.TZ;
  process.env.TZ = 'Asia/Kolkata'; // +05:30: neither UTC nor (necessarily) the host's zone — the time shown is the reader's, whatever the machine
  try {
    const at = Date.UTC(2026, 10, 10, 1, 35); // 07:05 in Kolkata
    assert.equal(localHHMM(at), '07:05');
    assert.equal(markSubLine({ since: at, pending: 2 }), 'depuis 07:05 · 2 tâches en attente');
    const n = notificationOf('ops-bloc-html-414', at, 1);
    assert.equal(n.title, 'Vague endormie');
    assert.match(n.body, /ops-bloc-html-414 dort depuis 07:05 — 1 tâche en attente/);
  } finally {
    if (was === undefined) delete process.env.TZ;
    else process.env.TZ = was;
  }
});

test('folded ANCESTOR: the hint is for the marked coordinators among the HIDDEN rows only; nothing when the tree is open', () => {
  const m: VagueMarks = { rev: 1, marks: [mark(), mark({ runId: 'b', coordinatorId: 'ops-b', coordinator: 'ops-solo' })] };
  assert.deepEqual(foldedMarks(m, ['ops', 'i1']).map((x) => x.coordinatorId), ['ops']);
  assert.deepEqual(foldedMarks(m, ['ops', 'ops-b']).map((x) => x.coordinatorId), ['ops', 'ops-b']);
  assert.deepEqual(foldedMarks(m, []), [], 'unfolded: no hint');
  assert.deepEqual(foldedMarks(m, ['i1', 'i2']), [], 'members hidden but no coordinator among them: no hint');
  assert.deepEqual(foldedMarks(null, ['ops']), []);
  assert.deepEqual(foldedMarks({ rev: 2, marks: [] }, ['ops']), [], 'resumed: the hint goes with the mark');
  const t = foldHintTitle(foldedMarks(m, ['ops', 'ops-b']));
  assert.match(t, /Vague endormie repliée : ops-bloc-html \(depuis \d\d:\d\d\), ops-solo/);
});

test('the Relancer\'s accessible name names the coordinator it nudges', () => {
  assert.equal(relancerLabel({ coordinator: 'ops-bloc-html' }), 'Relancer ops-bloc-html');
});
