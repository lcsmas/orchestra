import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #293 (pre-review #2) — the container pass's budget in the REAL resource-monitor `sampleTick`. The driven proof is scripts/e2e-container-budget.mjs; the monitor can't be imported bare under the
// strip-types runner (`./platform` is a directory), so it runs in a child process (like rss-page-size.test.ts).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ARMS = ['overrun_does_not_delay_the_tick', 'failure_does_not_break_the_tick', 'in_time_pass_is_awaited', 'no_hook_no_docker'];

test('B1 the container pass is bounded in the real sampleTick: an overrun costs the tick its budget (one warn, the line carries the LAST view), a failure never breaks it, an in-time pass is awaited, no hook = no containers', async () => {
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-container-budget.mjs')],
      { cwd: REPO, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, so, se) => resolve({ stdout: so, stderr: se, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });
  assert.equal(code, 0, `rig failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /CONTAINER-BUDGET: PASS/);
  const armsLine = stdout.split('\n').find((l) => l.startsWith('arms: ')) ?? '';
  assert.deepEqual(armsLine.replace(/^arms: /, '').split(' ').sort(), ARMS.map((a) => `${a}=ok`).sort());
  assert.doesNotMatch(stdout, /✗/);
});
