// #331 — the browser-Reliquat pass INSIDE the real 60 s resource-monitor tick (`sampleTick`): one bus status per owning member per pass, nothing without the `browser` dep
// (a rig calling sampleTick() with the defaults never touches a browser), a failing pass or notification never breaks the tick. The monitor cannot be imported bare under the
// strip-types runner, so scripts/browser-reliquats/monitor-drive.mjs runs the REAL `sampleTick` in one child with the repo's resolve hook and this test asserts every check it names.
// Mutants: scripts/pause-trap/mutants-browser-reliquats.mjs.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const EXPECTED = [
  'tick_stops_the_pipe_orphans', 'one_status_per_member_not_per_browser', 'status_names_the_count_and_the_profile_prefix', 'counter_counts_every_stop', 'no_empty_status_on_a_quiet_pass',
  'without_the_browser_dep_nothing_is_touched', 'a_throwing_pass_still_produces_the_line', 'a_throwing_notification_does_not_undo_the_stop',
];

test('the real sampleTick runs the browser bridge: one status per member, nothing without the dep, failures never break the tick', async () => {
  const out = await new Promise<string>((resolve, reject) => {
    execFile(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'browser-reliquats', 'monitor-drive.mjs')], { cwd: REPO, timeout: 120_000, maxBuffer: 8 * 1024 * 1024 }, (err, stdout, stderr) => (err ? reject(new Error(`${err.message}\n${stderr}`)) : resolve(stdout)));
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"checks"'));
  assert.ok(line, `no result line: ${out.slice(-300)}`);
  const checks = JSON.parse(line).checks as Array<{ name: string; ok: boolean; detail: string }>;
  assert.deepEqual(checks.map((c) => c.name), EXPECTED, 'every check ran (a driver that stopped early would not be green)');
  for (const c of checks) assert.equal(c.ok, true, `${c.name}: ${c.detail}`);
});
