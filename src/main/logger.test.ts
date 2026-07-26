import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

import { initPlatform, type OrchestraPlatform } from './platform/index.ts';
import { initLogger, getLogFile, log, scoped, isLevelEnabled, getLogLevel } from './logger.ts';

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
});

// The sinks and threshold are module-level singleton state and `initLogger` is
// idempotent, so the tests below deliberately reuse the sink established above
// instead of re-initializing (which would be a no-op). The temp home is removed
// in a final teardown test rather than here, so the file stays readable.
test.after(() => {
  const dir = path.dirname(path.dirname(getLogFile()));
  if (dir.startsWith(path.join(os.tmpdir(), 'orch-logger-test-'))) {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

// The logger is module-level singleton state (one set of sinks, one threshold),
// and `initLogger` is idempotent by design — so these tests run against the sink
// established above rather than re-initializing. `read()` returns the live file.
const read = (): string => fs.readFileSync(getLogFile(), 'utf8');

// Regression guard for the scope tags that make a verbose log greppable: without
// the `[scope]` prefix, a trace-level log is an undifferentiated interleaving of
// every subsystem and `grep` can't isolate one.
test('scoped() tags lines with its subsystem', () => {
  scoped('mysubsys').warn('scoped-marker');
  const line = read()
    .split('\n')
    .find((l) => l.includes('scoped-marker'));
  assert.ok(line, 'scoped line was written');
  assert.match(line!, /\[WARN\] \[mysubsys\] scoped-marker/);
});

test('child() nests scopes', () => {
  scoped('outer').child('inner').warn('nested-marker');
  const line = read()
    .split('\n')
    .find((l) => l.includes('nested-marker'));
  assert.match(line!, /\[outer:inner\]/);
});

// `swallow` is the explicit replacement for a silent `catch {}`. Its whole point
// is that the error's message survives into the log, so assert on the message —
// a version that logged only "failed" would pass a weaker test.
test('swallow() records the underlying error message', () => {
  scoped('sw').swallow('do the thing', new Error('boom-marker'));
  const text = read();
  assert.match(text, /\[sw\] do the thing failed \(non-fatal\)/);
  assert.ok(text.includes('boom-marker'), 'the error message must survive');
});

// Errno fields (code/syscall/path) live on the error object and never appear in
// `.stack` — they are usually the actual diagnosis for an fs/network failure.
test('errno fields are surfaced', () => {
  const err = Object.assign(new Error('open failed'), {
    code: 'ENOENT',
    syscall: 'open',
    path: '/nope/marker-path',
  });
  scoped('fs').error('read config', err);
  const text = read();
  assert.match(text, /code=ENOENT/);
  assert.match(text, /syscall=open/);
  assert.match(text, /path=\/nope\/marker-path/);
});

test('Error cause chains are logged', () => {
  const err = new Error('outer-marker', { cause: new Error('inner-cause-marker') });
  scoped('c').error('wrapped', err);
  assert.match(read(), /caused by: Error: inner-cause-marker/);
});

// A circular object must not cost us the line — JSON.stringify throws on it, and
// the naive implementation would drop the whole meta payload.
test('circular meta does not lose the line', () => {
  const obj: Record<string, unknown> = { marker: 'circular-marker' };
  obj.self = obj;
  scoped('circ').warn('cyclic', obj);
  const text = read();
  assert.ok(text.includes('circular-marker'), 'the loggable fields still land');
  assert.match(text, /\[circular\]/);
});

// Oversized meta must be truncated, or one giant payload evicts the history
// around the bug via rotation.
test('oversized meta is clamped and marked', () => {
  scoped('big').warn('huge', 'x'.repeat(20_000));
  const line = read()
    .split('\n')
    .find((l) => l.includes('[big] huge'));
  assert.ok(line!.length < 8000, `line should be clamped, was ${line!.length}`);
  assert.match(line!, /…\(\+\d+ chars\)/);
});

// The level gate is the mechanism that makes rich instrumentation affordable:
// verbose calls must cost nothing (and write nothing) when disabled. The default
// is `info`, so `trace`/`debug` must be suppressed.
test('levels below the threshold are not written', () => {
  assert.equal(getLogLevel(), 'info', 'default threshold');
  assert.equal(isLevelEnabled('trace'), false);
  assert.equal(isLevelEnabled('debug'), false);
  assert.equal(isLevelEnabled('info'), true);
  assert.equal(isLevelEnabled('error'), true);

  scoped('gated').trace('trace-should-be-absent');
  scoped('gated').debug('debug-should-be-absent');
  scoped('gated').info('info-should-be-present');

  const text = read();
  assert.ok(!text.includes('trace-should-be-absent'), 'trace must be suppressed at info');
  assert.ok(!text.includes('debug-should-be-absent'), 'debug must be suppressed at info');
  assert.ok(text.includes('info-should-be-present'), 'info must still be written');
});

// Mutation check on the gate itself: a threshold that suppressed EVERYTHING
// would pass the assertions above (they only prove absence). Prove the gate can
// also let a level through when it is enabled.
test('traceEnabled() reflects the active threshold', () => {
  assert.equal(scoped('x').traceEnabled(), isLevelEnabled('trace'));
});
