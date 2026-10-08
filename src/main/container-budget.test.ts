import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #293 — the REAL resource-monitor driven by scripts/e2e-container-budget.mjs (the monitor can't be imported bare under the strip-types runner: `./platform` is a directory), in ONE child process
// shared by both tests (like rss-page-size.test.ts): B1 = the container pass's budget in `sampleTick` (pre-review #2), B2 = `memberPinnedApis` over the real keepers dir (review m3b).
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');

let ran: Promise<{ stdout: string; stderr: string; code: number }> | null = null;
const rig = (): Promise<{ stdout: string; stderr: string; code: number }> =>
  (ran ??= new Promise((resolve) => {
    execFile(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-container-budget.mjs')],
      { cwd: REPO, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, so, se) => resolve({ stdout: so, stderr: se, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  }));
const armsOf = (stdout: string): string[] => (stdout.split('\n').find((l) => l.startsWith('arms: ')) ?? '').replace(/^arms: /, '').split(' ').filter(Boolean);

test('B1 the container pass is bounded in the real sampleTick: an overrun costs the tick its budget (one warn, the line carries the LAST view), a failure never breaks it, an in-time pass is awaited, no hook = no containers', async () => {
  const { stdout, stderr, code } = await rig();
  assert.equal(code, 0, `rig failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /CONTAINER-BUDGET: PASS/);
  const arms = armsOf(stdout);
  for (const a of ['overrun_does_not_delay_the_tick', 'failure_does_not_break_the_tick', 'in_time_pass_is_awaited', 'no_hook_no_docker']) assert.ok(arms.includes(`${a}=ok`), `arm ${a}: ${arms.join(' ')}`);
  assert.doesNotMatch(stdout, /✗/);
});

test('B2 memberPinnedApis (review m3b) over the REAL keepers dir: live members with an absolute non-relay upstream sidecar are pinned (memoised per socket); no sidecar / relative / relay / dead keeper are skipped; the pinned daemon reaches the accounting when the app\'s own is down', async () => {
  const { stdout, stderr, code } = await rig();
  assert.equal(code, 0, `rig failed:\n${stdout}\n${stderr}`);
  const arms = armsOf(stdout);
  for (const a of ['member_pinned_apis', 'member_pinned_reaches_accounting']) assert.ok(arms.includes(`${a}=ok`), `arm ${a}: ${arms.join(' ')}`);
  assert.doesNotMatch(stdout, /✗/);
});
