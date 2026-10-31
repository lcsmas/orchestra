import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DEFAULT_DENSITY, densityVars, normalizeDensity, parseDensity } from './sidebar-density.ts';

test('nothing stored, garbage, or a non-object all give the default', () => {
  assert.deepEqual(parseDensity(null), DEFAULT_DENSITY);
  assert.deepEqual(parseDensity('{not json'), DEFAULT_DENSITY);
  assert.deepEqual(parseDensity('42'), DEFAULT_DENSITY);
});

test('values are clamped to the slider ranges and snapped to their steps', () => {
  assert.deepEqual(normalizeDensity({ font: 3, rowH: 99, gap: -2 }), { font: 10, rowH: 36, gap: 0 });
  assert.deepEqual(normalizeDensity({ font: 11.3, rowH: 26.6, gap: 2.4 }), { font: 11.5, rowH: 27, gap: 2 });
});

test('a missing or non-numeric field falls back for that field only', () => {
  assert.deepEqual(normalizeDensity({ font: 11, rowH: 'x' }), { font: 11, rowH: DEFAULT_DENSITY.rowH, gap: DEFAULT_DENSITY.gap });
});

test('densityVars: the row height never undercuts the text line (+2px border)', () => {
  assert.equal(densityVars({ font: 14, rowH: 20, gap: 0 })['--sb-row-h'], '23px');
  assert.equal(densityVars({ font: 11, rowH: 26, gap: 2 })['--sb-row-h'], '26px');
  assert.equal(densityVars({ font: 11, rowH: 26, gap: 2 })['--sb-font'], '11px');
});
