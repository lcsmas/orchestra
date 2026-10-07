import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clock, gaugeModel, guardChip, parseGbInput, planThresholdCommit } from './memory-guard-view.ts';
import { DEFAULT_MEMORY_GUARD_SETTINGS, GIB, type MemoryGuardSnapshot } from './memory-guard.ts';

const D = DEFAULT_MEMORY_GUARD_SETTINGS;
function snap(over: Partial<MemoryGuardSnapshot> = {}): MemoryGuardSnapshot {
  return {
    measured: true, availBytes: 11.4 * GIB, readAt: 1, admission: 'open', admissionEnabled: true, pause: 'none', episode: 0,
    heldSince: null, pauseSince: null, admissionBytes: 6 * GIB, criticalBytes: 3 * GIB, releaseMarginBytes: GIB, sampleIntervalMs: 60_000, ...over,
  };
}
const T0 = new Date(2026, 9, 7, 14, 2).getTime();
const T1 = new Date(2026, 9, 7, 14, 5).getTime();

// positive control: the open chip is what an idle host shows — every non-open assertion below is vacuous otherwise
test('chip: open → ok "Admission open"', () => {
  assert.deepEqual(guardChip(snap()), { tone: 'ok', text: 'Admission open' });
});
test('chip: HELD → warn with since + memory; memory Pause → crit and wins over HELD', () => {
  assert.deepEqual(guardChip(snap({ admission: 'held', heldSince: T0, availBytes: 5.1 * GIB })), { tone: 'warn', text: 'HELD since 14:02 — 5.1 GB' });
  assert.deepEqual(guardChip(snap({ admission: 'held', pause: 'held', heldSince: T0, pauseSince: T1, availBytes: 2.4 * GIB })), { tone: 'crit', text: 'MEMORY PAUSE since 14:05 — 2.4 GB' });
});
test('chip: toggle OFF says nothing is held; unmeasured says so', () => {
  assert.match(guardChip(snap({ admission: 'held', heldSince: T0, admissionEnabled: false })).text, /^Below threshold \(toggle OFF\) since 14:02/);
  assert.deepEqual(guardChip(snap({ measured: false, availBytes: null })), { tone: 'unknown', text: 'Unmeasured' });
});
test('clock is local HH:MM, zero-padded', () => {
  assert.equal(clock(new Date(2026, 0, 1, 3, 4).getTime()), '03:04');
});

test('gauge: ticks sit at critical / admission / reopen of the scale; fill tone follows the thresholds', () => {
  const g = gaugeModel(11.4 * GIB, 32 * GIB, D);
  assert.equal(g.maxBytes, 32 * GIB);
  assert.equal(g.critical, 3 / 32);
  assert.equal(g.admission, 6 / 32);
  assert.equal(g.reopen, 7 / 32);
  assert.equal(g.fill, 11.4 / 32);
  assert.equal(g.tone, 'ok');
  assert.equal(gaugeModel(5.9 * GIB, 32 * GIB, D).tone, 'warn');
  assert.equal(gaugeModel(6 * GIB, 32 * GIB, D).tone, 'ok', 'exactly at the threshold is not below it');
  assert.equal(gaugeModel(2.9 * GIB, 32 * GIB, D).tone, 'crit');
  assert.equal(gaugeModel(3 * GIB, 32 * GIB, D).tone, 'warn');
});
test('gauge: unknown total falls back to 16 GB; a reading above the scale widens it; an unreadable reading is an empty ok bar', () => {
  assert.equal(gaugeModel(8 * GIB, null, D).maxBytes, 16 * GIB);
  assert.equal(gaugeModel(40 * GIB, 16 * GIB, D).fill, 1);
  assert.equal(gaugeModel(40 * GIB, 16 * GIB, D).maxBytes, 40 * GIB);
  assert.deepEqual([gaugeModel(null, 16 * GIB, D).fill, gaugeModel(null, 16 * GIB, D).tone], [0, 'ok']);
  const big = gaugeModel(1 * GIB, 4 * GIB, { ...D, admissionGb: 20, criticalGb: 5 });
  assert.ok(big.reopen <= 1 && big.maxBytes >= 21 * 1.25 * GIB, 'a threshold above the machine still fits the scale');
});

test('parseGbInput: decimals, comma decimals, blanks, junk', () => {
  assert.equal(parseGbInput('6'), 6);
  assert.equal(parseGbInput(' 6.5 '), 6.5);
  assert.equal(parseGbInput('6,5'), 6.5);
  assert.equal(parseGbInput(''), null);
  assert.equal(parseGbInput('  '), null);
  assert.equal(parseGbInput('abc'), null);
  assert.equal(parseGbInput('Infinity'), null);
});

test('commit: a valid changed pair → patch with BOTH fields; the same pair → unchanged', () => {
  assert.deepEqual(planThresholdCommit('8', '3', D), { kind: 'patch', patch: { admissionGb: 8, criticalGb: 3 } });
  assert.deepEqual(planThresholdCommit('6', '3', D), { kind: 'unchanged' });
  assert.deepEqual(planThresholdCommit('6.0', '3,0', D), { kind: 'unchanged' });
});
test('commit: invalid pairs are refused with a sentence, never a patch', () => {
  const inverted = planThresholdCommit('6', '7', D);
  assert.equal(inverted.kind, 'invalid');
  assert.match(inverted.kind === 'invalid' ? inverted.error : '', /^The critical threshold \(7 GB\) must be below the Admission threshold \(6 GB\)\.$/);
  assert.equal(planThresholdCommit('6', '', D).kind, 'invalid');
  assert.equal(planThresholdCommit('x', '3', D).kind, 'invalid');
  assert.equal(planThresholdCommit('6', '0.1', D).kind, 'invalid');
  assert.equal(planThresholdCommit('999', '3', D).kind, 'invalid');
});
test('commit: raising critical above the OLD Admission is valid as a pair (the reason both fields travel together)', () => {
  assert.deepEqual(planThresholdCommit('12', '8', D), { kind: 'patch', patch: { admissionGb: 12, criticalGb: 8 } });
});
