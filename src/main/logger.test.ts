import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initPlatform, type OrchestraPlatform } from './platform/index.ts';
import { initLogger, getLogFile, log } from './logger.ts';

// Regression: the primary sink used to hardcode ~/.orchestra/logs even when
// ORCHESTRA_HOME overrode the home, so an isolated dev instance wrote the real
// home's log file. The primary sink (and thus getLogFile) must follow
// ORCHESTRA_HOME.
//
// logger.ts only reaches the seam for getLogsDir(); the rest of the interface
// is stubbed so this stays an Electron-free unit test.
function stubPlatform(logsDir: string): OrchestraPlatform {
  return new Proxy({} as OrchestraPlatform, {
    get(_t, prop) {
      if (prop === 'getLogsDir') return () => logsDir;
      if (prop === 'kind') return 'electron';
      return () => undefined;
    },
  });
}

test('primary log sink honors ORCHESTRA_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logger-test-'));
  process.env.ORCHESTRA_HOME = home;
  initPlatform(stubPlatform(path.join(home, 'logs')));
  initLogger();

  const primary = getLogFile();
  assert.equal(primary, path.join(home, 'logs', 'orchestra.log'));
  assert.ok(
    !primary.startsWith(path.join(os.homedir(), '.orchestra')),
    'isolated instance must not touch the real home log',
  );

  log.info('logger-test-marker');
  assert.ok(fs.readFileSync(primary, 'utf8').includes('logger-test-marker'));

  fs.rmSync(home, { recursive: true, force: true });
});
