import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createBudgetAlarmEngine } from './session-budget-alarms.ts';
import { SESSION_BUDGET_ALARM_PREFIX } from '../shared/session-budget-alarms.ts';
import type { ResourceLogLine } from '../shared/resource-monitor.ts';

// #214 field alarms. The driven arms live in scripts/e2e-field-budget-alarms.mjs — REAL sampleTick + REAL engine
// over a faked /proc and real debug-log files; `resource-monitor.ts` can't be imported bare under the strip-types
// runner (`./platform` is a directory), so this wraps the rig in a child process (like keeper-lifecycle.test.ts).

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const RIG = path.join(REPO, 'scripts', 'e2e-field-budget-alarms.mjs');
const REGISTER = path.join(REPO, 'scripts', '.r2-register.mjs');

// Literal, so an arm that silently stops running fails here instead of shrinking the gate.
const ARMS = [
  'tree_procs_once', 'tree_memory_not_judged', 'tree_slope_once', 'tree_running_silent', 'tree_background_silent', 'tree_background_unknown_silent', 'tree_unknown_n_unjudged',
  'mcp_count_settles', 'tree_normal_silent', 'tree_rearm_per_breach', 'tree_orphan_not_judged', 'default_background_signal',
  'log_burst_once', 'log_normal_silent', 'log_partial_then_complete', 'log_old_ignored', 'wiring',
];

test('rig: every arm of the field-alarm driven proof passes through the real sampleTick + engine', async () => {
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', REGISTER, RIG],
      { cwd: REPO, timeout: 120_000, maxBuffer: 8 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, so, se) => resolve({ stdout: so, stderr: se, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });
  assert.equal(code, 0, `rig failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /FIELD-BUDGET-ALARMS: PASS/);
  const armsLine = stdout.split('\n').find((l) => l.startsWith('arms: ')) ?? '';
  assert.deepEqual(armsLine.replace(/^arms: /, '').split(' ').sort(), ARMS.map((a) => `${a}=ok`).sort());
  assert.doesNotMatch(stdout, /✗/);
});

const line: ResourceLogLine = { t: new Date(0).toISOString(), at: 0, totals: { cpuCores: 1, memTotalBytes: 1, memUsedBytes: null }, electron: [], sessions: [] };

test('engine: a missing sessions dir is not an alarm and never throws', () => {
  const out: string[] = [];
  const e = createBudgetAlarmEngine({ now: () => Date.now(), sessionsDir: () => path.join(os.tmpdir(), 'no-such-dir-fba'), label: () => null, backgroundWork: () => false, warn: (m) => out.push(m) });
  e.tick(line);
  assert.deepEqual(out, []);
});

test('engine: a throwing collaborator is reported on the ENGINE prefix (not an alarm) and the tick survives', () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'fba-unit-'));
  try {
    const name = `ws-x__${new Date(Date.now() - 1000).toISOString().replace(/[:.]/g, '-')}.log`;
    fs.writeFileSync(path.join(dir, name), '2026-09-30T03:00:00.000Z [DEBUG] [API REQUEST] /v1/messages/count_tokens x-client-request-id=a source=count_tokens\n');
    const out: string[] = [];
    const e = createBudgetAlarmEngine({ now: () => Date.now(), sessionsDir: () => dir, label: () => { throw new Error('store gone'); }, backgroundWork: () => false, warn: (m) => out.push(m) });
    assert.doesNotThrow(() => e.tick(line));
    assert.equal(out.length, 1);
    assert.match(out[0], /^session-budget-alarms \(engine\): internal error scanning session debug logs — store gone/);
    assert.ok(!out[0].startsWith(SESSION_BUDGET_ALARM_PREFIX), 'an internal error must not read as a budget alarm');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('engine.reset() forgets tracked logs and tree history (a stopped monitor restarts clean)', () => {
  const dir = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'fba-unit-'));
  try {
    const name = `ws-y__${new Date(Date.now() - 1000).toISOString().replace(/[:.]/g, '-')}.log`;
    fs.writeFileSync(path.join(dir, name), '2026-09-30T03:00:00.000Z [DEBUG] [API REQUEST] /v1/messages/count_tokens x-client-request-id=b source=count_tokens\n');
    const out: string[] = [];
    const e = createBudgetAlarmEngine({ now: () => Date.now(), sessionsDir: () => dir, label: () => null, backgroundWork: () => false, warn: (m) => out.push(m) });
    e.tick(line);
    e.tick(line);
    assert.equal(out.length, 1);
    assert.deepEqual(e.trackedLogs(), [name]);
    e.reset();
    assert.deepEqual(e.trackedLogs(), []);
    e.tick(line);
    assert.equal(out.length, 2, 'after reset the still-young log is judged afresh');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
