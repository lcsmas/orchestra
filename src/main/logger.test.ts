import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initPlatform } from './platform/index.ts';
import { createHeadlessPlatform } from './platform/headless.ts';
import { initLogger, getLogFile, log } from './logger.ts';

// Regression (gtk4-port-plan.md §11 M2 cleanup backlog): the primary sink used
// to hardcode ~/.orchestra/logs even when ORCHESTRA_HOME overrode the home, so
// an isolated daemon or dev instance wrote the real home's log file — and
// app:info.logPath reported that out-of-home path. The primary sink (and thus
// getLogFile) must follow ORCHESTRA_HOME.
test('primary log sink honors ORCHESTRA_HOME', () => {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-logger-test-'));
  process.env.ORCHESTRA_HOME = home;
  initPlatform(createHeadlessPlatform());
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
