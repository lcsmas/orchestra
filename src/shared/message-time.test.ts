import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  computeTurnDivider,
  formatClock,
  formatDayLabel,
  formatGap,
  DIVIDER_GAP_MIN_MS,
} from './message-time.ts';

// All fixtures built via local-time constructors so the assertions hold in any
// timezone (the formatters read local time).
const at = (y: number, mo: number, d: number, h: number, mi: number) =>
  new Date(y, mo - 1, d, h, mi).getTime();

const NOW = at(2026, 8, 17, 18, 0); // Mon 17 Aug 2026, 18:00 local

test('formatClock pads hours and minutes', () => {
  assert.equal(formatClock(at(2026, 8, 17, 9, 5)), '09:05');
  assert.equal(formatClock(at(2026, 8, 17, 14, 32)), '14:32');
});

test('formatDayLabel: today / yesterday / same-year date / other-year date', () => {
  assert.equal(formatDayLabel(at(2026, 8, 17, 1, 0), NOW), 'Today');
  assert.equal(formatDayLabel(at(2026, 8, 16, 23, 59), NOW), 'Yesterday');
  const sameYear = formatDayLabel(at(2026, 8, 12, 10, 0), NOW);
  assert.match(sameYear, /Wed/);
  assert.match(sameYear, /12/);
  assert.doesNotMatch(sameYear, /2026/);
  assert.match(formatDayLabel(at(2025, 12, 31, 10, 0), NOW), /2025/);
});

test('formatGap: minutes, hours+minutes, whole hours, days, sub-minute empty', () => {
  assert.equal(formatGap(30_000), '');
  assert.equal(formatGap(3 * 60_000), '+3m');
  assert.equal(formatGap(125 * 60_000), '+2h 5m');
  assert.equal(formatGap(120 * 60_000), '+2h');
  assert.equal(formatGap(49 * 3_600_000), '+2d');
});

test('computeTurnDivider: first turn carries the day, no gap', () => {
  const d = computeTurnDivider(at(2026, 8, 17, 14, 32), undefined, NOW);
  assert.equal(d.time, '14:32');
  assert.equal(d.day, 'Today');
  assert.equal(d.gap, undefined);
  assert.match(d.title, /14:32/);
});

test('computeTurnDivider: same-day small gap shows neither day nor gap', () => {
  const prev = at(2026, 8, 17, 14, 30);
  const d = computeTurnDivider(at(2026, 8, 17, 14, 35), prev, NOW);
  assert.equal(d.day, undefined);
  assert.equal(d.gap, undefined);
});

test('computeTurnDivider: gap at/above threshold is shown', () => {
  const prev = at(2026, 8, 17, 12, 0);
  const d = computeTurnDivider(prev + DIVIDER_GAP_MIN_MS, prev, NOW);
  assert.equal(d.gap, '+10m');
});

test('computeTurnDivider: crossing midnight re-shows the day even with a small gap', () => {
  const prev = at(2026, 8, 16, 23, 58);
  const d = computeTurnDivider(at(2026, 8, 17, 0, 3), prev, NOW);
  assert.equal(d.day, 'Today');
  assert.equal(d.gap, undefined); // 5 min — below threshold
});
