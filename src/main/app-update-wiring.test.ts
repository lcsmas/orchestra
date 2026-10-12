import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';

const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8');

test('« Nouvelle version installée » wiring: channels in lockstep, started + stopped with the app, mounted on every screen', () => {
  const host = read('src/main/app-update-host.ts'), preload = read('src/preload/index.ts'), index = read('src/main/index.ts'), app = read('src/renderer/App.tsx');
  assert.match(host, /APP_UPDATE_PULL_CHANNEL = 'appUpdate:state'/);
  assert.match(host, /APP_UPDATE_PUSH_CHANNEL = 'appUpdate:update'/);
  assert.match(host, /APP_UPDATE_RELAUNCH_CHANNEL = 'appUpdate:relaunch'/);
  assert.match(preload, /appUpdateState: \(\) => ipcRenderer\.invoke\('appUpdate:state'\)/);
  assert.match(preload, /ipcRenderer\.on\('appUpdate:update', listener\)/);
  assert.match(preload, /relaunchInstalled: \(\) => ipcRenderer\.invoke\('appUpdate:relaunch'\)/);
  assert.match(read('src/main/api-handlers.ts'), /\| 'appUpdateState'\s*\| 'relaunchInstalled'/, 'not in the generic served table');
  assert.match(index, /^registerAppUpdateIpc\(\);/m);
  assert.match(index, /^\s+startAppUpdate\(\);/m);
  assert.match(index, /^\s+stopAppUpdate\(\);/m);
  assert.match(app, /\{loaded && !active && <AppUpdateBanner \/>\}/);
  assert.match(app, /<MemoryBanner \/>\s*<AppUpdateBanner \/>/);
  // the relaunch execs the INSTALLED file after this process is gone — never app.relaunch() (it would re-exec the old mounted binary)
  assert.match(host, /spawn\('\/bin\/sh', relaunchArgv\(process\.pid, INSTALLED_APP\)/);
  assert.doesNotMatch(host, /^(?!\s*\/\/)[^\n]*\bapp\.relaunch\(/m, 'no code line calls app.relaunch()');
  assert.match(read('src/main/acces-mobile-routes.ts'), /appUpdate: \{ version: update\.version \}/, 'the phone is told');
});
