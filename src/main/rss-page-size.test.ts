import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFile } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// #214 finding — the monitor's RSS was pages × 4096 on a 16 KB-page host (4× low). The driven proof is
// scripts/e2e-rss-page-size.mjs (REAL procTable + sampleTick over the REAL /proc, compared with VmRSS); the modules
// can't be imported bare under the strip-types runner (`./platform` is a directory), so it runs in a child process.
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const ARMS = ['self_vs_vmrss', 'tree_line', 'resources_page_sampler', 'call_sites_pin'];

test('rig: the monitor\'s RSS equals the kernel\'s VmRSS through the real procTable and sampleTick', async () => {
  const { stdout, stderr, code } = await new Promise<{ stdout: string; stderr: string; code: number }>((resolve) => {
    execFile(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'e2e-rss-page-size.mjs')],
      { cwd: REPO, timeout: 120_000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH, HOME: process.env.HOME } },
      (err, so, se) => resolve({ stdout: so, stderr: se, code: err ? ((err as { code?: number }).code ?? 1) : 0 }));
  });
  assert.equal(code, 0, `rig failed:\n${stdout}\n${stderr}`);
  assert.match(stdout, /RSS-PAGE-SIZE: PASS/);
  const armsLine = stdout.split('\n').find((l) => l.startsWith('arms: ')) ?? '';
  assert.deepEqual(armsLine.replace(/^arms: /, '').split(' ').sort(), ARMS.map((a) => `${a}=ok`).sort());
  assert.doesNotMatch(stdout, /✗/);
});
