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

test('the sweep asks the hold question PER MEMBER, at the verdict, through the guard facade snapshot — never its own meter read (FI-2)', () => {
  assert.match(sweepFn, /const guardSnap = getMemoryGuardSnapshot\(\);\s*const admissionHeld = isAdmissionHolding\(guardSnap\);/);
  assert.equal((sweepFn.match(/getMemoryGuardSnapshot\(\)/g) ?? []).length, 1);
  const loop = sweepFn.indexOf('for (const ws of store.workspaces)');
  const read = sweepFn.indexOf('getMemoryGuardSnapshot()');
  assert.ok(loop > 0 && read > loop && read < sweepFn.indexOf('shouldHibernate(ws, signals)'), 'read INSIDE the loop, before the verdict: a hold that ended mid-pass stops acting on the members after it');
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
  assert.match(startFn, /e\.transition\.kind === 'admission_held' && isAdmissionHolding\(e\.snapshot\)\) sweepNow\(\);/);
  assert.doesNotMatch(startFn, /admission_reopened|pause_due|pause_liftable/, 'only the held edge sweeps');
});

test('the periodic tick and the held edge are the SAME un-queued sweep (overlap is safe: sdkStop sets `stopping` synchronously); the stop path unsubscribes', () => {
  assert.match(src, /const sweepNow = \(\): void => void sweepHibernation\(\)\.catch\(\(e\) => hlog\.swallow\('sweep', e\)\);/);
  assert.match(startFn, /timer = setInterval\(sweepNow, sweepMs\);/);
  assert.match(startFn, /isAdmissionHolding\(e\.snapshot\)\) sweepNow\(\);/);
  assert.match(startFn, /isAdmissionHolding\(getMemoryGuardSnapshot\(\)\)\) sweepNow\(\);/);
  assert.doesNotMatch(src, /coalescedRunner|requestSweep/, 'no queue / single-flight (a queued re-run would DELAY a held edge behind a slow pass)');
  assert.match(stopFn, /unsubscribeGuard\?\.\(\);\s*unsubscribeGuard = null;/);
  assert.ok(startFn.indexOf('HIBERNATION_DISABLED') < startFn.indexOf('subscribeMemoryGuard('), 'the disabled kill switch returns BEFORE any subscription');
});
