// Boot wiring of the soak scheduler (C5 #212): the driven rig proves the scheduler works; THESE pins prove it is actually started at boot, stopped at
// quit, and fed the OS idle time — a deleted call site would leave a correct scheduler that never runs (the rig cannot see that).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const SRC = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const read = (f: string) => fs.readFileSync(path.join(SRC, f), 'utf8');

test('index.ts starts the soak scheduler at boot (after the store loaded, beside the self-tune scheduler) and stops it at quit', () => {
  const idx = read('main/index.ts');
  assert.match(idx, /import \{ startSoakScheduler, stopSoakScheduler \} from '\.\/soak-scheduler';/);
  const start = idx.indexOf('startSoakScheduler();');
  const selfTune = idx.indexOf('startSelfTuneScheduler();');
  assert.ok(start > selfTune && selfTune > 0, 'started right after startSelfTuneScheduler(), inside createMainWindow (post store.load)');
  assert.equal(idx.split('startSoakScheduler();').length - 1, 1, 'started exactly once');
  const shutdown = idx.slice(idx.indexOf('function shutdownSubsystems'));
  assert.match(shutdown.slice(0, shutdown.indexOf('\n}\n')), /stopSoakScheduler\(\);/, 'stopped in shutdownSubsystems');
});

test('the OS idle time reaches the scheduler: platform seam member, Electron impl via powerMonitor, and the wrapper forwards it', () => {
  assert.match(read('main/platform/index.ts'), /getSystemIdleSeconds\?\(\): number \| null;/);
  assert.match(read('main/platform/index.ts'), /getSystemIdleSeconds: \(\) => current\(\)\.getSystemIdleSeconds\?\.\(\) \?\? null,/);
  const el = read('main/platform/electron.ts');
  assert.match(el, /powerMonitor\.getSystemIdleTime\(\)/);
  assert.match(el, /powerMonitor \} from 'electron'/);
  assert.match(read('main/soak-scheduler.ts'), /systemIdleSec: platform\.getSystemIdleSeconds\?\.\(\) \?\? null,/);
});

test('the scheduled campaign is the one command, with the caps and the parent-death watch, under the allowlisted env', () => {
  const sch = read('main/soak-scheduler.ts');
  assert.match(sch, /'--parent-pid', String\(process\.pid\)/);
  assert.match(sch, /env: campaignEnv\(\)/, 'the spawn takes the allowlisted env, never process.env');
  assert.equal(/env:\s*process\.env|\.\.\.process\.env/.test(sch), false, 'no spawn inherits the app env (zero tokens)');
  assert.match(sch, /buildCampaignEnv\(process\.env, os\.homedir\(\), \[dirOf\('claude'\), dirOf\('pnpm'\)\]\)/);
});
