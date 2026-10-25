import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { installBundledRuntime } from './keeper-runtime-install.ts';
import { runtimeDirName, type RuntimeManifest } from '../shared/keeper-runtime.ts';

let root: string;
let resources: string;
let binDir: string;
beforeEach(() => {
  root = fs.mkdtempSync(path.join(os.tmpdir(), 'krt-'));
  resources = path.join(root, 'resources');
  binDir = path.join(root, 'home', 'bin');
});
afterEach(() => fs.rmSync(root, { recursive: true, force: true }));

const sha = (b: Buffer | string) => crypto.createHash('sha256').update(b).digest('hex');

/** A package's resources/pinned-node with a stand-in "node" (the installer copies + hashes bytes; it never executes them). */
function bundle(body: string, over: Partial<RuntimeManifest> = {}): RuntimeManifest {
  const dir = path.join(resources, 'pinned-node');
  fs.rmSync(dir, { recursive: true, force: true });
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), body, { mode: 0o755 });
  const manifest: RuntimeManifest = { version: '22.23.4', arch: process.arch as 'arm64' | 'x64', tarballSha256: 'a'.repeat(64), nodeSha256: sha(body), nodeBytes: Buffer.byteLength(body), ...over };
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifest));
  return manifest;
}

test('no resources dir / no pinned-node in the package → absent (a dev run is not an error)', () => {
  assert.deepEqual(installBundledRuntime({ resourcesDir: undefined, binDir }), { ok: false, absent: true });
  fs.mkdirSync(resources, { recursive: true });
  assert.deepEqual(installBundledRuntime({ resourcesDir: resources, binDir }), { ok: false, absent: true });
});

test('installs into a versioned dir under bin/, executable, byte-identical', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const r = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(r.ok);
  if (!r.ok) return;
  assert.equal(r.path, path.join(binDir, runtimeDirName(m), 'node'));
  assert.equal(r.copied, true);
  assert.equal(fs.readFileSync(r.path, 'utf8'), '#!/bin/sh\necho v1\n');
  assert.ok((fs.statSync(r.path).mode & 0o111) !== 0);
  assert.deepEqual(fs.readdirSync(binDir), [runtimeDirName(m)]); // no tmp leftovers
});

test('second install is a no-op: same inode, copied=false', () => {
  bundle('#!/bin/sh\necho v1\n');
  const a = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(a.ok);
  if (!a.ok) return;
  const ino = fs.statSync(a.path).ino;
  const b = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(b.ok && b.path === a.path && b.copied === false);
  assert.equal(fs.statSync(a.path).ino, ino);
});

test('a bundle whose binary does not hash to its manifest is refused and nothing is left behind', () => {
  const body = '#!/bin/sh\necho v1\n';
  const m = bundle(body);
  fs.writeFileSync(path.join(resources, 'pinned-node', 'node'), body.replace('v1', 'v2'), { mode: 0o755 }); // same size, other bytes
  const r = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.equal(r.ok, false);
  if (!r.ok && !r.absent) assert.match(r.reason, /does not hash to its manifest/);
  assert.ok(!fs.existsSync(path.join(binDir, runtimeDirName(m))));
  assert.deepEqual(fs.readdirSync(binDir), []);
});

test('a manifest for another arch, or an invalid manifest, is refused', () => {
  bundle('x', { arch: process.arch === 'arm64' ? 'x64' : 'arm64' });
  const wrongArch = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.equal(wrongArch.ok, false);
  if (!wrongArch.ok && !wrongArch.absent) assert.match(wrongArch.reason, /this process is/);
  fs.writeFileSync(path.join(resources, 'pinned-node', 'manifest.json'), '{"version":"x"}');
  const bad = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.equal(bad.ok, false);
  if (!bad.ok && !bad.absent) assert.match(bad.reason, /manifest is invalid/);
});

test('a partial dir of the exact name (wrong size) is replaced by rename, never written into', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const destDir = path.join(binDir, runtimeDirName(m));
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'node'), '#!/bin/sh\n'); // a torn copy
  fs.writeFileSync(path.join(destDir, 'stray'), 'x');
  const r = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(r.ok && r.copied);
  assert.equal(fs.readFileSync(path.join(destDir, 'node'), 'utf8'), '#!/bin/sh\necho v1\n');
  assert.ok(!fs.existsSync(path.join(destDir, 'stray')));
  assert.deepEqual(fs.readdirSync(binDir), [runtimeDirName(m)]);
});

test('an update that ships a new Node lands in a NEW dir and leaves the previous one untouched (running keepers keep their runtime)', () => {
  const m1 = bundle('#!/bin/sh\necho v1\n');
  const a = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(a.ok);
  if (!a.ok) return;
  const before = fs.statSync(a.path);
  const m2 = bundle('#!/bin/sh\necho v2 -- the update\n', { version: '22.24.0' });
  const b = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(b.ok && b.copied);
  if (!b.ok) return;
  assert.notEqual(b.path, a.path);
  assert.deepEqual(fs.readdirSync(binDir).sort(), [runtimeDirName(m1), runtimeDirName(m2)].sort());
  const after = fs.statSync(a.path);
  assert.equal(after.ino, before.ino);
  assert.equal(after.mtimeMs, before.mtimeMs);
  assert.equal(fs.readFileSync(a.path, 'utf8'), '#!/bin/sh\necho v1\n');
});

test('stale hidden tmp dirs of a dead install are swept; fresh ones and versioned dirs are not', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  fs.mkdirSync(binDir, { recursive: true });
  const stale = path.join(binDir, '.node-22.0.0-aaaaaaaaaaaa.tmp-1-ab');
  const fresh = path.join(binDir, '.node-22.0.0-bbbbbbbbbbbb.tmp-2-cd');
  const other = path.join(binDir, 'node-21.0.0-cccccccccccc'); // another version's runtime: never swept
  for (const d of [stale, fresh, other]) fs.mkdirSync(d);
  const old = new Date(Date.now() - 3600_000);
  fs.utimesSync(stale, old, old);
  fs.utimesSync(other, old, old);
  const r = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(r.ok);
  assert.ok(!fs.existsSync(stale));
  assert.ok(fs.existsSync(fresh));
  assert.ok(fs.existsSync(other));
  assert.ok(fs.existsSync(path.join(binDir, runtimeDirName(m), 'node')));
});

test('a runtime that cannot be executed HERE (noexec bin/) is refused — never returned as a path — and the refusal does not re-copy 120 MB on every launch', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const noexec = () => false; // what access(X_OK) says on a noexec mount (rig arm noexec_bin_refused drives the REAL mount)
  const first = installBundledRuntime({ resourcesDir: resources, binDir, canExec: noexec });
  assert.equal(first.ok, false);
  if (!first.ok && !first.absent) assert.match(first.reason, /not executable here/);
  const dest = path.join(binDir, runtimeDirName(m), 'node');
  assert.ok(fs.existsSync(dest), 'the (verified) copy stays: it is only unusable on THIS mount');
  const ino = fs.statSync(dest).ino;
  const again = installBundledRuntime({ resourcesDir: resources, binDir, canExec: noexec });
  assert.equal(again.ok, false);
  assert.equal(fs.statSync(dest).ino, ino, 'a refused runtime is not recopied at every launch');
  // …and once the mount allows it, the same dir is simply used (copied:false)
  const ok = installBundledRuntime({ resourcesDir: resources, binDir, canExec: () => true });
  assert.ok(ok.ok && ok.copied === false && ok.path === dest);
});
