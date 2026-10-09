import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// index.ts / hooks-server.ts / api-handlers.ts cannot be imported under `node --test` (Electron host, ./platform dir import), so the
// WIRING of the memory guard (#285) is asserted on source text. The behaviour behind each seam is driven for real by
// src/main/memory-guard*.test.ts and scripts/e2e-memory-guard.mjs (real sampler → real /busStatus → real built CLI).
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const index = read('src/main/index.ts');
const hooks = read('src/main/hooks-server.ts');
const handlers = read('src/main/api-handlers.ts');
const preload = read('src/preload/index.ts');
const cli = read('src/cli/index.ts');

test('CONTROL: the sources are the real files', () => {
  assert.match(index, /startResourceMonitor\(\);/);
  assert.match(hooks, /route === '\/busStatus'/);
  assert.match(handlers, /setModelDefaults: 'settings:setModelDefaults'/);
});

test('index.ts reads the thresholds from the store (hot), starts the guard right after the hooks server, and stops it at shutdown', () => {
  const hooksUp = index.indexOf('await startHooksServer();');
  const reader = index.indexOf('setMemoryGuardSettingsReader(() => store.getMemoryGuardSettings())');
  const start = index.indexOf('startMemoryGuard();');
  assert.ok(hooksUp > 0 && reader > hooksUp && start > reader, 'hooks server, then the reader, then the start');
  assert.ok(start < index.indexOf('startEventsSpool();'), 'before the rest of the boot chain, so a later throw cannot keep it from starting');
  const body = index.slice(index.indexOf('function shutdownSubsystems(): void {'));
  const shutdown = body.slice(0, body.indexOf('\n}\n'));
  assert.match(shutdown, /stopMemoryGuard\(\);/, 'stopped INSIDE shutdownSubsystems');
});

test('/busStatus returns the guard snapshot and the CLI prints it through the shared formatter', () => {
  assert.match(hooks, /memoryGuard: getMemoryGuardSnapshot\(\)/);
  assert.match(cli, /formatMemoryGuardLine\(res\.memoryGuard as MemoryGuardSnapshot,/);
});

test('the settings handlers go through the validated hot write; channel names match the preload (lockstep)', () => {
  assert.match(handlers, /memoryGuard: async \(\) => memoryGuardView\(store\.getMemoryGuardSettings\(\)\)/);
  assert.match(handlers, /setMemoryGuard: async \(next\) => setMemoryGuardSettings\(next, store\)/);
  for (const [member, channel] of [['memoryGuard', 'settings:memoryGuard'], ['setMemoryGuard', 'settings:setMemoryGuard']]) {
    assert.match(handlers, new RegExp(`${member}: '${channel}'`));
    assert.match(preload, new RegExp(`${member}: \\(.*\\) => ipcRenderer\\.invoke\\('${channel}'`));
  }
});

test('the resource monitor logs "used" through the shared parser the guard tests pin (readMemUsedBytes is un-importable under node --test)', () => {
  const rm = read('src/main/resource-monitor.ts');
  const body = rm.slice(rm.indexOf('export function readMemUsedBytes()'));
  const fn = body.slice(0, body.indexOf('\n}\n'));
  assert.match(fn, /return parseMemUsedBytes\(text\);/);
  assert.doesNotMatch(fn, /MemAvailable|MemTotal/, 'no second hand-rolled parse of /proc/meminfo left behind');
  assert.match(rm, /import \{ parseMemUsedBytes \} from '..\/shared\/memory-guard';/);
});

test('only the guard\'s known consumers import it (#286 Admission joined: admission.ts holds spawn/restart; no wake / Veille / pause consumer yet)', () => {
  const importers = fs
    .readdirSync(path.join(root, 'src/main'))
    .filter((f) => f.endsWith('.ts') && !f.endsWith('.test.ts'))
    .filter((f) => /from '\.\/memory-guard(\.ts)?'/.test(read(`src/main/${f}`)))
    .sort();
  // The only readers: index.ts (lifecycle), hooks-server.ts (bus-status). Not workspaces / agent-sdk / bus-wake / restart (hibernation.ts joined with #288).
  // Tripwire BY DESIGN: #286 (Admission), #288 (fast Veille), #289 (alert), #290 (memory Pause) each add their importer HERE.
  assert.deepEqual(importers, ['admission.ts', 'docker-hold-host.ts', 'hibernation.ts', 'hooks-server.ts', 'index.ts', 'memory-alert-host.ts', 'memory-banner-host.ts', 'memory-guard-settings.ts', 'pause-auto-host.ts', 'pause-memory-host.ts']); // #290 (memory Pause) added its importers: the host + the usage-limit host's `memoryPauseHeld`; #288 (fast Veille): hibernation.ts; #289 (alert + banner): the two read-only hosts; #321 (Docker relay hold): docker-hold-host.ts publishes the EFFECTIVE hold for the keepers' relays
});
