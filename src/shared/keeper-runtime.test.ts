import { test } from 'node:test';
import assert from 'node:assert/strict';
import { gatherRuntimeInputs, parseRuntimeManifest, pickKeeperRuntime, runtimeDirName, type RuntimeManifest } from './keeper-runtime.ts';

const H = 'a'.repeat(64);
const MANIFEST: RuntimeManifest = { version: '22.23.4', arch: 'arm64', tarballSha256: H, nodeSha256: 'b'.repeat(64), nodeBytes: 122293360 };

// ── pickKeeperRuntime: bundled runtime > PATH node (AppImage) > the app's own binary ─────────────────────────────────────────

test('bundled runtime wins over a PATH node under an AppImage', () => {
  const p = pickKeeperRuntime({ bundledNode: '/h/bin/node-22/node', appImage: true, pathNode: '/usr/bin/node', execPath: '/mnt/app/orchestra' });
  assert.deepEqual(p, { kind: 'bundled', cmd: '/h/bin/node-22/node', electronRunAsNode: false });
});

test('bundled runtime wins outside an AppImage too (an unpacked linux build)', () => {
  const p = pickKeeperRuntime({ bundledNode: '/h/bin/node-22/node', appImage: false, pathNode: null, execPath: '/opt/orchestra/orchestra' });
  assert.equal(p.kind, 'bundled');
  assert.equal(p.cmd, '/h/bin/node-22/node');
  assert.equal(p.electronRunAsNode, false);
});

test('no bundled runtime + AppImage + PATH node → the PATH node (today\'s behaviour)', () => {
  const p = pickKeeperRuntime({ bundledNode: null, appImage: true, pathNode: '/usr/bin/node', execPath: '/mnt/app/orchestra' });
  assert.deepEqual(p, { kind: 'path', cmd: '/usr/bin/node', electronRunAsNode: false });
});

test('no bundled runtime + AppImage + no PATH node → the app binary, with the fragile-mount warning', () => {
  const p = pickKeeperRuntime({ bundledNode: null, appImage: true, pathNode: null, execPath: '/mnt/app/orchestra' });
  assert.equal(p.kind, 'app');
  assert.equal(p.cmd, '/mnt/app/orchestra');
  assert.equal(p.electronRunAsNode, true);
  assert.match(p.warn ?? '', /rides the mount/);
});

test('no bundled runtime + not an AppImage → the app binary even when a PATH node exists (stable on disk; no warning)', () => {
  const p = pickKeeperRuntime({ bundledNode: null, appImage: false, pathNode: '/usr/bin/node', execPath: '/opt/orchestra/orchestra' });
  assert.deepEqual(p, { kind: 'app', cmd: '/opt/orchestra/orchestra', electronRunAsNode: true });
});

// ── manifest + versioned dir ────────────────────────────────────────────────────────────────────────────────────────────────

test('parseRuntimeManifest accepts the build\'s manifest', () => {
  const r = parseRuntimeManifest(JSON.stringify(MANIFEST));
  assert.deepEqual(r, { ok: true, manifest: MANIFEST });
});

test('parseRuntimeManifest refuses each malformed field with its name', () => {
  const bad: Array<[Partial<Record<keyof RuntimeManifest, unknown>>, RegExp]> = [
    [{ version: '22.23' }, /version/],
    [{ arch: 'ia32' }, /arch/],
    [{ tarballSha256: 'zz' }, /tarballSha256/],
    [{ nodeSha256: 'A'.repeat(64) }, /nodeSha256/], // uppercase is not what the build writes
    [{ nodeBytes: 0 }, /nodeBytes/],
    [{ nodeBytes: 1.5 }, /nodeBytes/],
  ];
  for (const [patch, re] of bad) {
    const r = parseRuntimeManifest(JSON.stringify({ ...MANIFEST, ...patch }));
    assert.equal(r.ok, false);
    if (!r.ok) assert.match(r.reason, re);
  }
  assert.equal(parseRuntimeManifest('not json').ok, false);
  assert.equal(parseRuntimeManifest('null').ok, false);
});

test('runtimeDirName is versioned and changes with the binary hash (a new pin never reuses a running keeper\'s dir)', () => {
  assert.equal(runtimeDirName(MANIFEST), 'node-22.23.4-bbbbbbbbbbbb');
  assert.notEqual(runtimeDirName(MANIFEST), runtimeDirName({ ...MANIFEST, version: '22.24.0' }));
  assert.notEqual(runtimeDirName(MANIFEST), runtimeDirName({ ...MANIFEST, nodeSha256: 'c'.repeat(64) }));
});

// ── gatherRuntimeInputs: the glue between the host facts and the pick (pre-review #390 m3) ───────────────────────────────────────

test('gatherRuntimeInputs under an AppImage looks the PATH node up and the pick uses it when nothing is bundled (today\'s behaviour)', () => {
  const asked: string[] = [];
  const i = gatherRuntimeInputs({ bundledNode: null, appImagePath: '/x/Orchestra.AppImage', findOnPath: (n) => (asked.push(n), '/usr/bin/node'), execPath: '/mnt/app/orchestra' });
  assert.deepEqual(asked, ['node']);
  assert.deepEqual(i, { bundledNode: null, appImage: true, pathNode: '/usr/bin/node', execPath: '/mnt/app/orchestra' });
  assert.equal(pickKeeperRuntime(i).kind, 'path');
});

test('gatherRuntimeInputs outside an AppImage never consults PATH (the app binary is already stable on disk)', () => {
  let asked = 0;
  const i = gatherRuntimeInputs({ bundledNode: null, appImagePath: '', findOnPath: () => (asked++, '/usr/bin/node'), execPath: '/opt/orchestra/orchestra' });
  assert.equal(asked, 0);
  assert.deepEqual(i, { bundledNode: null, appImage: false, pathNode: null, execPath: '/opt/orchestra/orchestra' });
  assert.equal(pickKeeperRuntime(i).kind, 'app');
});

test('gatherRuntimeInputs passes the bundled runtime through unchanged', () => {
  const i = gatherRuntimeInputs({ bundledNode: '/h/bin/node-22/node', appImagePath: '/x/A.AppImage', findOnPath: () => '/usr/bin/node', execPath: '/e' });
  assert.equal(i.bundledNode, '/h/bin/node-22/node');
  assert.equal(pickKeeperRuntime(i).kind, 'bundled');
});
