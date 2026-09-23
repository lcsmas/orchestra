import test from 'node:test';
import assert from 'node:assert/strict';
import { formatStallElapsed, bootStallCopy, BOOT_HEAL_AFTER_MS } from './boot-stall.ts';

test('formatStallElapsed: seconds under a minute, then "min ss"', () => {
  assert.equal(formatStallElapsed(45_400), '45 s');
  assert.equal(formatStallElapsed(72_000), '1 min 12');
  assert.equal(formatStallElapsed(600_000), '10 min 00');
  assert.equal(formatStallElapsed(-5), '0 s');
});

test('bootStallCopy: names the elapsed time and the auto-heal until it is due', () => {
  const c = bootStallCopy(1_000, 1_000 + 72_000);
  assert.equal(c.title, 'La CLI ne répond pas depuis 1 min 12');
  assert.match(c.detail, /Relance automatique vers 3 min 00/);
  const late = bootStallCopy(0, BOOT_HEAL_AFTER_MS + 1_000);
  assert.match(late.detail, /en cours ou a échoué/);
});
