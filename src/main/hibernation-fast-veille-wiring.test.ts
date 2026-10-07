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

test('every guard SAMPLE while held triggers a sweep (a member idle after the edge sleeps within one sample); subscribe FIRST, then reconcile (FI-2 item 5)', () => {
  const sub = startFn.indexOf('subscribeMemoryGuardSamples(');
  const reconcile = startFn.indexOf('isAdmissionHolding(getMemoryGuardSnapshot())');
  assert.ok(sub > 0 && reconcile > sub, 'subscribe, then the boot reconcile');
  assert.match(startFn, /subscribeMemoryGuardSamples\(\(snap\) => \{\s*if \(isAdmissionHolding\(snap\)\) sweepNow\(\);\s*\}\);/);
  assert.doesNotMatch(startFn, /subscribeMemoryGuard\(|admission_held|admission_reopened|pause_due|pause_liftable/, 'a LEVEL trigger, not an edge one (an edge reaches only members idle at the edge)');
  assert.doesNotMatch(startFn, /setInterval\([^)]*\)[\s\S]*setInterval\(/, 'no second timer: the guard sampler is the cadence');
});

test('the periodic tick and the held-sample trigger are the SAME un-queued sweep (overlap is safe: sdkStop sets `stopping` synchronously); the stop path unsubscribes', () => {
  assert.match(src, /const sweepNow = \(\): void => void sweepHibernation\(\)\.catch\(\(e\) => hlog\.swallow\('sweep', e\)\);/);
  assert.match(startFn, /timer = setInterval\(sweepNow, sweepMs\);/);
  assert.match(startFn, /isAdmissionHolding\(getMemoryGuardSnapshot\(\)\)\) sweepNow\(\);/);
  assert.doesNotMatch(src, /coalescedRunner|requestSweep/, 'no queue / single-flight (a queued re-run would DELAY a held trigger behind a slow pass)');
  assert.match(stopFn, /unsubscribeGuard\?\.\(\);\s*unsubscribeGuard = null;/);
  assert.ok(startFn.indexOf('HIBERNATION_DISABLED') < startFn.indexOf('subscribeMemoryGuardSamples('), 'the disabled kill switch returns BEFORE any subscription');
});

// Overlap safety (seat-1 MINOR on #288): two passes never double-stop a member ONLY because a stopping session reads as not live and sdkStop marks it
// before its first await. agent-sdk.ts cannot be imported under `node --test`, so both clauses are pinned on source; scripts/e2e-fast-veille.mjs `overlap_probe`
// drives the real thing.
const agent = fs.readFileSync(path.join(here, 'agent-sdk.ts'), 'utf8');
test('overlap safety: sdkHasSession excludes a stopping session', () => {
  const from = agent.indexOf('export function sdkHasSession(wsId: string): boolean {');
  assert.ok(from > 0, 'control: found');
  const body = agent.slice(from, agent.indexOf('\n}\n', from));
  assert.match(body, /return !!s && !s\.stopping;/);
});

test('overlap safety: nothing yields between sdkStop\'s start and its `stopping` mark, outside the no-session keeper branch', () => {
  const from = agent.indexOf('export async function sdkStop(wsId: string, opts?: { hibernate?: boolean }): Promise<void> {');
  assert.ok(from > 0, 'control: found');
  const head = agent.slice(from, agent.indexOf('session.stopping = true;', from));
  const branch = head.indexOf('if (!session) {');
  assert.ok(branch > 0 && /await killKeeper\(wsId\)/.test(head), 'control: the slice spans the no-session branch, which DOES await');
  assert.doesNotMatch(head.slice(0, branch), /\bawait\b/, 'nothing awaits before the no-session check (a same-tick second pass would still see the session live)');
  const afterBranch = head.slice(head.indexOf('\n  }\n', branch) + 5);
  assert.doesNotMatch(afterBranch, /\bawait\b/, 'nothing awaits between the no-session branch and the mark');
});

test('overlap safety: nothing yields between the sweep\'s live check and the stop call it makes, nor inside sdkStopIfLive before `impl.stop`', () => {
  const live = sweepFn.indexOf('const hasLiveSdk = sdkSessionLive(ws.id);');
  const stop = sweepFn.indexOf('await sdkStopIfLive(');
  assert.ok(live > 0 && stop > live, 'control: both found, in order');
  assert.doesNotMatch(sweepFn.slice(live, stop), /\bawait\b/, 'a second pass started in the same tick must not interleave between the check and the stop');
  const delivery = fs.readFileSync(path.join(here, 'sdk-delivery.ts'), 'utf8');
  const sf = delivery.indexOf('export async function sdkStopIfLive(');
  const call = delivery.indexOf('await impl.stop(wsId, opts);', sf);
  assert.ok(sf > 0 && call > sf, 'control: found');
  assert.doesNotMatch(delivery.slice(sf, call), /\bawait\b/, 'sdkStopIfLive reaches sdkStop synchronously');
});
