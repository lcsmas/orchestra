import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { GUI_LAUNCH_SHIM_NAMES, guiLaunchShimBody } from './gui-launch-shim.ts';

// Real shim bodies run by /bin/sh in front of a fake binary that reports the env it got.
function rig() {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-shim-'));
  const shimDir = path.join(root, 'shim'), realDir = path.join(root, 'real');
  fs.mkdirSync(shimDir); fs.mkdirSync(realDir);
  for (const name of GUI_LAUNCH_SHIM_NAMES) {
    fs.writeFileSync(path.join(shimDir, name), guiLaunchShimBody(name, shimDir, 'test'), { mode: 0o755 });
    fs.writeFileSync(path.join(realDir, name), `#!/bin/sh\necho "real=${name} TMPDIR=\${TMPDIR:-<unset>} CHROME_DESKTOP=\${CHROME_DESKTOP:-<unset>} args=$*"\n`, { mode: 0o755 });
  }
  const run = (name: string, ...args: string[]) => {
    const r = spawnSync(path.join(shimDir, name), args, { encoding: 'utf8', timeout: 5000, killSignal: 'SIGKILL', env: { PATH: `${shimDir}:${realDir}:/usr/bin:/bin`, TMPDIR: '/var/tmp/ws-123', CHROME_DESKTOP: 'orchestra.desktop' } });
    return (r.stdout + r.stderr).trim();
  };
  return { root, run };
}

test('a desktop launch on the real profile drops the workspace TMPDIR and CHROME_DESKTOP', () => {
  const { root, run } = rig();
  try {
    for (const name of GUI_LAUNCH_SHIM_NAMES) {
      assert.equal(run(name, 'https://example.com'), `real=${name} TMPDIR=<unset> CHROME_DESKTOP=<unset> args=https://example.com`);
    }
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('a scratch or headless Chromium keeps the agent env untouched', () => {
  const { root, run } = rig();
  try {
    for (const args of [['--user-data-dir=/x', 'u'], ['--user-data-dir', '/x'], ['--headless=new', 'u'], ['--headless']]) {
      assert.match(run('chromium-browser', ...args), /^real=chromium-browser TMPDIR=\/var\/tmp\/ws-123 CHROME_DESKTOP=orchestra\.desktop /, args.join(' '));
    }
    // xdg-open has no scratch form: always a desktop launch
    assert.match(run('xdg-open', '--headless'), /TMPDIR=<unset>/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('the shim never resolves to itself: with no real binary it fails loudly instead of looping', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'gui-shim-'));
  try {
    fs.writeFileSync(path.join(root, 'chromium'), guiLaunchShimBody('chromium', root, 'test'), { mode: 0o755 });
    const r = spawnSync(path.join(root, 'chromium'), [], { encoding: 'utf8', timeout: 5000, env: { PATH: `${root}:${root}` } });
    assert.equal(r.status, 127);
    assert.match(r.stderr, /chromium: not found outside/);
  } finally { fs.rmSync(root, { recursive: true, force: true }); }
});

test('wiring: the shims are installed in the agent bin dir before the window, next to the orchestra shim', () => {
  const read = (p: string) => fs.readFileSync(path.join(import.meta.dirname, '../..', p), 'utf8');
  assert.match(read('src/main/index.ts'), /installAgentCliShim\(\);\n\s+installAgentGuiLaunchShims\(\);/);
  assert.match(read('src/main/cli-shim.ts'), /for \(const name of GUI_LAUNCH_SHIM_NAMES\) fs\.writeFileSync\(path\.join\(dir, name\), guiLaunchShimBody\(name, dir, SHIM_MARKER\)/);
});
