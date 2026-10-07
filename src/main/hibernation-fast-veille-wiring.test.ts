import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// hibernation.ts cannot be imported under `node --test` (store / pty / Electron host), so the WIRING of fast Veille (#288) is asserted on source
// text. The behaviour behind it is driven for real — real sweeper, fake MemAvailable source, stub CLI — by scripts/e2e-fast-veille.{mjs,sh}.
const here = path.dirname(fileURLToPath(import.meta.url));
const src = fs.readFileSync(path.join(here, 'hibernation.ts'), 'utf8');
const sweepFn = (() => {
  const from = src.indexOf('export async function sweepHibernation()');
  return src.slice(from, src.indexOf('\n}\n', from));
})();
const startFn = (() => {
  const from = src.indexOf('export function startHibernationSweeper()');
  return src.slice(from, src.indexOf('\n}\n', from));
})();
const stopFn = (() => {
  const from = src.indexOf('export function stopHibernationSweeper()');
  return src.slice(from, src.indexOf('\n}\n', from));
})();

test('CONTROL: the slices are the real functions', () => {
  assert.match(sweepFn, /shouldHibernate\(ws, signals\)/);
  assert.match(startFn, /setInterval\(/);
  assert.match(stopFn, /clearInterval\(timer\)/);
});

test('the sweep asks the hold question ONCE per pass, through the guard facade snapshot — never its own meter read (FI-2)', () => {
  assert.match(sweepFn, /const guardSnap = getMemoryGuardSnapshot\(\);\s*const admissionHeld = isAdmissionHolding\(guardSnap\);/);
  assert.equal((sweepFn.match(/getMemoryGuardSnapshot\(\)/g) ?? []).length, 1, 'one reading per pass, before the loop');
  assert.ok(sweepFn.indexOf('getMemoryGuardSnapshot()') < sweepFn.indexOf('for (const ws of store.workspaces)'));
  assert.doesNotMatch(src, /sampleMemoryGuardNow|\/proc\/meminfo|readMemAvailableBytes/, 'the sweep reads the cached snapshot: no sampling, no /proc read');
  assert.match(sweepFn, /admissionHeld,\s*\n\s*\};/, 'passed to the pure rule as a signal');
});

test('the Veille log tail comes from the shared formatter, fed the SAME snapshot as the verdict (tested in shared/hibernation.test.ts)', () => {
  assert.match(sweepFn, /fastVeilleLogSuffix\(admissionHeld, guardSnap, early, thresholdMs\)/);
  assert.match(sweepFn, /const early = admissionHeld && !shouldHibernate\(ws, \{ \.\.\.signals, admissionHeld: false \}\);/);
});

test('the Admission-held edge triggers one sweep; subscribe FIRST, then reconcile from the current state (FI-2 item 5)', () => {
  const sub = startFn.indexOf('subscribeMemoryGuard(');
  const reconcile = startFn.indexOf('isAdmissionHolding(getMemoryGuardSnapshot())');
  assert.ok(sub > 0 && reconcile > sub, 'subscribe, then the boot reconcile');
  assert.match(startFn, /e\.transition\.kind === 'admission_held' && isAdmissionHolding\(e\.snapshot\)\) requestSweep\(\);/);
  assert.doesNotMatch(startFn, /admission_reopened|pause_due|pause_liftable/, 'only the held edge sweeps');
});

test('the timer and the trigger share ONE single-flight (two passes never stop the same session); the stop path unsubscribes', () => {
  assert.match(src, /const sweeper = coalescedRunner\(sweepHibernation, /);
  assert.match(src, /const requestSweep = \(\): void => sweeper\.request\(\);/);
  assert.match(startFn, /timer = setInterval\(requestSweep, sweepMs\);/);
  assert.doesNotMatch(startFn, /void sweepHibernation\(\)/, 'no direct, un-coalesced sweep from the timer');
  assert.match(stopFn, /unsubscribeGuard\?\.\(\);\s*unsubscribeGuard = null;/);
  assert.ok(startFn.indexOf('HIBERNATION_DISABLED') < startFn.indexOf('subscribeMemoryGuard('), 'the disabled kill switch returns BEFORE any subscription');
});
