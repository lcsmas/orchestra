// #419 — the ref-counted row pins the windowed transcript honours (a bloc with an open overlay / source view / focus handoff keeps its row rendered).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { pinRowFor, rowPinCount } from './bloc-row-pins.ts';

test('a row pin is ref-counted per row id and released exactly once', () => {
  const a = pinRowFor('row-a'), b = pinRowFor('row-b');
  assert.equal(rowPinCount('row-a'), 0);
  const r1 = a(), r2 = a(), r3 = b();
  assert.equal(rowPinCount('row-a'), 2); assert.equal(rowPinCount('row-b'), 1);
  r1(); r1(); // a second release of the same pin is a no-op
  assert.equal(rowPinCount('row-a'), 1);
  r2(); r3();
  assert.equal(rowPinCount('row-a'), 0); assert.equal(rowPinCount('row-b'), 0);
});

test('transfer without a gap: acquiring the new pin before releasing the old one never reads 0', () => {
  const a = pinRowFor('row-t'); const old = a(); const seen: number[] = [rowPinCount('row-t')];
  const fresh = a(); seen.push(rowPinCount('row-t')); old(); seen.push(rowPinCount('row-t')); fresh(); seen.push(rowPinCount('row-t'));
  assert.deepEqual(seen, [1, 2, 1, 0]);
});
