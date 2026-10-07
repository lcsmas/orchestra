import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #290 — structural pins of the Electron-bound seams of the memory Pause (they cannot be imported under node --test): a silent un-wiring is a feature that is dead while every logic test
// stays green. The behaviour behind each seam is driven for real by src/main/pause-memory.test.ts and the pause-trap rig arms `memory-pause*` (real keeper + real CLI + a fake memory source).

const HERE = path.dirname(fileURLToPath(import.meta.url));
/** Source with line-leading block comments and full-line `//` comments removed: a call that was merely COMMENTED OUT must not satisfy a pin. */
const read = (f: string): string => fs.readFileSync(path.join(HERE, f), 'utf8').replace(/^[ \t]*\/\*[\s\S]*?\*\//gm, '').replace(/^[ \t]*\/\/.*$/gm, '');

test('CONTROL: the sources are the real files', () => {
  assert.match(read('pause-memory-host.ts'), /export function startMemoryPause\(\): void \{/);
  assert.match(read('pause-memory.ts'), /export function applyMemoryPause\(/);
});

test('WIRING host (FI-2.5): SUBSCRIBE to the guard FIRST, then reconcile from the snapshot, then the level tick — never snapshot-then-subscribe (an edge in between is lost)', () => {
  const s = read('pause-memory-host.ts');
  const body = s.slice(s.indexOf('export function startMemoryPause(): void {'));
  const sub = body.indexOf('subscribeMemoryGuard(');
  const reconcile = body.indexOf('reconcileMemoryPauseNow();');
  const tick = body.indexOf('setInterval(');
  assert.ok(sub > 0 && reconcile > sub && tick > reconcile, 'subscribe, then reconcile, then the tick');
  assert.match(body, /unsubscribe = subscribeMemoryGuard\(\(e\) => void handleMemoryGuardEdge\(realDeps, ledger, e\)\);/, 'every edge goes through the Electron-free handler (pause_due / pause_liftable only — FI-2.4 — pinned by behaviour in pause-memory.test.ts)');
  assert.match(s, /applyMemoryPause\(realDeps, viewOfSnapshot\(getMemoryGuardSnapshot\(\)\), ledger, 'level'\)/);
  assert.match(s, /timer\.unref\?\.\(\);/, 'the tick never keeps the process alive');
});

test('WIRING host: the real store, bus, beginReprise and the clock; an unloaded store reads UNKNOWN (storeReady)', () => {
  const s = read('pause-memory-host.ts');
  assert.match(s, /getWorkspace: \(id\) => store\.getWorkspace\(id\),/);
  assert.match(s, /storeReady: \(\) => store\.loadedFromDisk,/);
  assert.match(s, /beginReprise,/);
});

test('WIRING index.ts: the memory Pause starts AFTER the guard AND after `buildPauseTrapDeps()` registered the live workspace tree (review m3: a boot-time reconcile before it lifts on the bus run tree alone), and stops BEFORE the guard at shutdown', () => {
  const s = read('index.ts');
  const guard = s.indexOf('startMemoryGuard();');
  const trapDeps = s.indexOf('buildPauseTrapDeps();');
  const trapStart = s.indexOf('startPauseTrap(pauseTrapDeps);');
  const pause = s.indexOf('startMemoryPause();');
  assert.ok(guard > 0 && trapDeps > guard && trapStart > trapDeps && pause > trapStart, 'order: guard, then trap deps (live tree registered), then the trap, then the memory Pause');
  assert.equal(s.split('startMemoryPause();').length - 1, 1, 'started exactly once');
  const shut = s.slice(s.indexOf('function shutdownSubsystems(): void {'));
  const body = shut.slice(0, shut.indexOf('\n}\n'));
  assert.ok(body.indexOf('stopMemoryPause();') > 0 && body.indexOf('stopMemoryPause();') < body.indexOf('stopMemoryGuard();'), 'stopped inside shutdownSubsystems, before the guard');
  assert.match(s, /import \{ startMemoryPause, stopMemoryPause \} from '\.\/pause-memory-host';/);
});

test('WIRING pause-memory.ts is Electron-free (importable under node --test like pause-auto.ts); only the host binding holds the real store / guard', () => {
  const core = read('pause-memory.ts');
  for (const bad of ['./store', './platform', 'electron', './memory-guard', './logger', './usage', './activity']) {
    assert.ok(!new RegExp(`from '${bad.replace(/[./]/g, '\\$&')}(\\.ts)?'`).test(core), `pause-memory.ts must not import ${bad}`);
  }
  const host = read('pause-memory-host.ts');
  for (const need of ["from './store.ts'", "from './bus.ts'", "from './memory-guard.ts'", "from './bus-pause.ts'"]) assert.ok(host.includes(need), need);
});

test('WIRING the guard acts ONLY through the existing pause machinery: the Pause is written with the motive, the trap/Bilan/containers/Reprise are the unchanged shared paths (FI-1.8)', () => {
  const core = read('pause-memory.ts');
  assert.match(core, /deps\.beginReprise\(db, run\.runId, 'host', \{ host: true, reason: 'memory' \}\)/, 'the automatic Reprise is #255\'s entry point, host caller');
  assert.match(core, /revertResumeToPaused\(db, runId, MEMORY_PAUSE_BY, now, \{ auto: \(epoch\) => encodeMemoryPause\(reason, epoch\) \}\)/, 'a re-pause of a RESUMING memory Pause writes the epoch-bound motive in the SAME statement');
  assert.match(core, /WHERE id = \? AND paused_at IS NULL/, 'a fresh Pause is written only over an unpaused run (never overwrites another pause)');
  assert.ok(!/pause-trap|pause-containers|restartOwedContainers|stopAttributedContainers/.test(core), 'no second container/trap implementation: the memory motive adds only the motive');
  assert.match(core, /if \(parseSwitches\(\(r\.flags_json as string \| null \| undefined\) \?\? null\)\.pause !== true\) continue;/, 'a frozen `pause` OFF run is never lifted either (a stale column is inert)');
});

test('WIRING the quota evaluator keeps ignoring a memory Pause: `parsePauseAuto` accepts only the usage-limit reason', () => {
  const s = read('../shared/pause-auto.ts');
  assert.match(s, /if \(o\.reason !== 'usage_limit'\) return null;/);
});

test('WIRING review #2: the usage-limit Reprise waits while the guard holds the memory Pause (evaluateOne asks `memoryPauseHeld`, the usage host binds it to the guard snapshot)', () => {
  assert.match(read('pause-auto.ts'), /function evaluateOne\(deps: PauseAutoDeps, db: BusDb, run: AutoPausedRun\): AutoEvalEntry \{\s*const now = deps\.now\(\);\s*if \(deps\.memoryPauseHeld\?\.\(\)\) return \{ runId: run\.runId, action: 'wait', why: 'memory-pause-held' \};/);
  assert.match(read('pause-auto-host.ts'), /memoryPauseHeld: \(\) => getMemoryGuardSnapshot\(\)\.pause === 'held',/);
});
