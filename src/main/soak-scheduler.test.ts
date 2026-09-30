// Runs the driven rig for the soak scheduler (scripts/verify-soak-scheduler.mjs): the REAL scheduler module over a FAKE campaign script.
// It needs only node — no bwrap, no `claude`, no sessions — so it belongs in the default suite. The rig's last line is its verdict.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');

test('the soak scheduler rig passes: real repo resolution, identity probe, spawn, allowlisted env, state, logs, yield', () => {
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=ExperimentalWarning', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', './scripts/.r2-register.mjs', 'scripts/verify-soak-scheduler.mjs'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  const out = `${r.stdout}\n${r.stderr}`;
  const failed = out.split('\n').filter((l) => l.includes('✗'));
  assert.deepEqual(failed, [], `rig failures:\n${failed.join('\n')}`);
  assert.match(out, /^SOAK-SCHEDULER-RIG: PASS$/m, out.slice(-1500));
  assert.equal(r.status, 0);
  assert.ok((out.match(/✓/g) ?? []).length >= 20, 'the rig ran its checks (positive control: a rig that printed no ✓ proved nothing)');
});
