import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { createRuntimeTrust, installBundledRuntime as installReal, TRANSIENT_PREFIX, type InstallOptions } from './keeper-runtime-install.ts';
import { runtimeDirName, type RuntimeManifest } from '../shared/keeper-runtime.ts';

/** The stand-ins below are shell scripts, not a node that answers `-p 1`: unit tests inject "it runs" unless the test is ABOUT the probe. */
const installBundledRuntime = (o: InstallOptions) => installReal({ probe: () => null, ...o });

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
  let copiedAgain = false;
  const b = installBundledRuntime({ resourcesDir: resources, binDir, beforeSwap: () => { copiedAgain = true; } }); // beforeSwap fires only after a (wasted) 120 MB copy+hash
  assert.ok(b.ok && b.path === a.path && b.copied === false);
  assert.equal(fs.statSync(a.path).ino, ino);
  assert.equal(copiedAgain, false, 'an already-installed runtime is not copied a second time (the guard before the swap would hide that from the result)');
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

test('a partial dir of the exact name (wrong size) is healed by an atomic FILE replace — a new inode, the dir is never moved aside', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const destDir = path.join(binDir, runtimeDirName(m));
  fs.mkdirSync(destDir, { recursive: true });
  fs.writeFileSync(path.join(destDir, 'node'), '#!/bin/sh\n'); // a torn copy
  fs.writeFileSync(path.join(destDir, 'stray'), 'x');
  const tornIno = fs.statSync(path.join(destDir, 'node')).ino;
  const renames: string[] = [];
  const real = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => { renames.push(String(from)); return real(from, to); }) as typeof fs.renameSync;
  let r;
  try {
    r = installBundledRuntime({ resourcesDir: resources, binDir });
  } finally {
    fs.renameSync = real;
  }
  assert.ok(r.ok && r.copied);
  assert.equal(fs.readFileSync(path.join(destDir, 'node'), 'utf8'), '#!/bin/sh\necho v1\n');
  assert.notEqual(fs.statSync(path.join(destDir, 'node')).ino, tornIno, 'replaced by rename (new inode), not written into');
  assert.ok(!renames.includes(destDir), 'the dir itself was never renamed aside');
  assert.deepEqual(fs.readdirSync(binDir), [runtimeDirName(m)], 'no tmp/aside dir left behind');
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

// ── -fu F1: concurrent installs must not replace each other ─────────────────────────────────────────────────────────────────

test('F1: an instance that lost the race to a GOOD runtime leaves the winner\'s dir alone (no aside-rename, same inode)', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const dest = path.join(binDir, runtimeDirName(m), 'node');
  let winnerIno = 0;
  const loser = installBundledRuntime({
    resourcesDir: resources,
    binDir,
    beforeSwap: () => {
      const w = installBundledRuntime({ resourcesDir: resources, binDir }); // the other instance finishes its install while ours is mid-copy
      assert.ok(w.ok && w.copied);
      winnerIno = fs.statSync(dest).ino;
    },
  });
  assert.ok(loser.ok, 'the loser still reports a working runtime');
  if (loser.ok) assert.equal(loser.copied, false, 'it did NOT replace anything');
  assert.equal(fs.statSync(dest).ino, winnerIno, 'the winner\'s binary was never renamed aside / replaced');
  assert.deepEqual(fs.readdirSync(binDir), [runtimeDirName(m)], 'no aside/tmp dir left behind');
});

// ── -fu F2: trust ends at install → content is verified once per run, and the runtime must RUN ──────────────────────────────

test('F2: a same-size corrupted/planted binary under the versioned name is HEALED at the first install of a run, not trusted', () => {
  const body = '#!/bin/sh\necho v1\n';
  const m = bundle(body);
  const first = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(first.ok);
  if (!first.ok) return;
  fs.writeFileSync(first.path, body.replace('v1', 'v2'), { mode: 0o755 }); // same size, other bytes
  const healed = installBundledRuntime({ resourcesDir: resources, binDir, trust: createRuntimeTrust() });
  assert.ok(healed.ok && healed.copied === true, 'the corrupted copy was replaced');
  assert.equal(fs.readFileSync(first.path, 'utf8'), body);
  assert.deepEqual(fs.readdirSync(binDir), [runtimeDirName(m)]);
});

test('F2: with a trust the content hash + probe are paid ONCE per run (the second call is a stat); without one every call verifies', () => {
  bundle('#!/bin/sh\necho v1\n');
  const trust = createRuntimeTrust();
  let probes = 0;
  const probe = () => (probes++, null);
  const a = installReal({ resourcesDir: resources, binDir, trust, probe });
  const b = installReal({ resourcesDir: resources, binDir, trust, probe });
  assert.ok(a.ok && b.ok && b.copied === false);
  assert.equal(probes, 1, 'one probe for two calls');
  const c = installReal({ resourcesDir: resources, binDir, probe }); // no trust → verifies every call
  assert.ok(c.ok);
  assert.equal(probes, 2);
});

test('F2: a runtime that passes X_OK and the hash but cannot RUN is refused (and remembered), never picked — the launcher then falls through', () => {
  const m = bundle('#!/nonexistent/interpreter\n'); // exec bit set, hash matches its manifest, exec() fails ENOENT
  const trust = createRuntimeTrust();
  let probes = 0;
  const r1 = installReal({ resourcesDir: resources, binDir, trust, probe: (f) => (probes++, `exec failed: ${f}`) });
  assert.equal(r1.ok, false);
  if (!r1.ok && !r1.absent) assert.match(r1.reason, /does not run/);
  const dest = path.join(binDir, runtimeDirName(m), 'node');
  const ino = fs.statSync(dest).ino;
  const r2 = installReal({ resourcesDir: resources, binDir, trust, probe: (f) => (probes++, `exec failed: ${f}`) });
  assert.equal(r2.ok, false);
  assert.equal(probes, 1, 'the verdict is remembered for this run');
  assert.equal(fs.statSync(dest).ino, ino, 'a refused runtime is not recopied at every launch');
});

test('F2: the DEFAULT probe really executes the runtime (`-p 1`): an unexecutable interpreter and a wrong answer are refused, a node-like answer passes', () => {
  bundle('#!/nonexistent/interpreter\n');
  const bad = installReal({ resourcesDir: resources, binDir });
  assert.equal(bad.ok, false);
  if (!bad.ok && !bad.absent) assert.match(bad.reason, /does not run/);
  bundle('#!/bin/sh\necho 2\n');
  const wrong = installReal({ resourcesDir: resources, binDir: path.join(root, 'bin2') });
  assert.equal(wrong.ok, false);
  if (!wrong.ok && !wrong.absent) assert.match(wrong.reason, /expected "1"/);
  bundle('#!/bin/sh\necho 1\n');
  const good = installReal({ resourcesDir: resources, binDir: path.join(root, 'bin3') });
  assert.ok(good.ok);
});

// ── -fu pre-review: heal race, transient probe failures, hash-once-per-run ─────────────────────────────────────────────────

test('M1: healing a corrupt dir never makes the runtime absent, whoever else installs meanwhile (observed after EVERY rename of the heal)', () => {
  const body = '#!/bin/sh\necho v1\n';
  const m = bundle(body);
  const first = installBundledRuntime({ resourcesDir: resources, binDir });
  assert.ok(first.ok);
  if (!first.ok) return;
  fs.writeFileSync(first.path, body.replace('v1', 'v2'), { mode: 0o755 }); // same size, corrupt
  const destDir = path.join(binDir, runtimeDirName(m));
  let existed = false, vanished = false, movedDir = false;
  const real = fs.renameSync;
  fs.renameSync = ((from: fs.PathLike, to: fs.PathLike) => {
    if (String(from) === destDir) movedDir = true;
    const out = real(from, to);
    if (fs.existsSync(first.path)) existed = true; else if (existed) vanished = true;
    return out;
  }) as typeof fs.renameSync;
  try {
    // a second healer runs its WHOLE install between our verified copy and our swap, then we heal too
    const r = installBundledRuntime({ resourcesDir: resources, binDir, beforeSwap: () => { const other = installBundledRuntime({ resourcesDir: resources, binDir }); assert.ok(other.ok); } });
    assert.ok(r.ok);
  } finally {
    fs.renameSync = real;
  }
  assert.equal(vanished, false, 'the runtime was missing at some point of the heal');
  assert.equal(movedDir, false, 'the (possibly good) dir was renamed aside');
  assert.equal(fs.readFileSync(first.path, 'utf8'), body);
});

test('m2: a TRANSIENT probe failure (timeout / signal / memory pressure) is reported but not remembered — the next launch asks again; a deterministic one is remembered', () => {
  bundle('#!/bin/sh\necho v1\n');
  const trust = createRuntimeTrust();
  let n = 0;
  const flaky = () => (n++ === 0 ? `${TRANSIENT_PREFIX}ETIMEDOUT` : null);
  const r1 = installReal({ resourcesDir: resources, binDir, trust, probe: flaky });
  assert.equal(r1.ok, false);
  const r2 = installReal({ resourcesDir: resources, binDir, trust, probe: flaky });
  assert.ok(r2.ok, 'the second launch re-probed and the runtime is used');
  assert.equal(n, 2);
});

test('m3: with a trust an already-vouched runtime is NOT re-hashed (even a refused one) — pinned by counting opens of the binary', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const dest = path.join(binDir, runtimeDirName(m), 'node');
  const trust = createRuntimeTrust();
  const refuse = () => 'exec failed';
  assert.equal(installReal({ resourcesDir: resources, binDir, trust, probe: refuse }).ok, false); // copy + hash + probe → remembered
  let opens = 0;
  const real = fs.openSync;
  fs.openSync = ((p: fs.PathLike, ...rest: unknown[]) => { if (String(p) === dest) opens++; return (real as (...a: unknown[]) => number)(p, ...rest); }) as typeof fs.openSync;
  try {
    for (let i = 0; i < 3; i++) assert.equal(installReal({ resourcesDir: resources, binDir, trust, probe: refuse }).ok, false);
  } finally {
    fs.openSync = real;
  }
  assert.equal(opens, 0, 'three more launches read the 120 MB binary zero times');
});

test('m3b: when the runtime is replaced (bin/ wiped and re-copied) the trust is dropped and the fresh copy is probed again', () => {
  const m = bundle('#!/bin/sh\necho v1\n');
  const trust = createRuntimeTrust();
  let probes = 0;
  const probe = () => (probes++, null);
  assert.ok(installReal({ resourcesDir: resources, binDir, trust, probe }).ok);
  fs.rmSync(path.join(binDir, runtimeDirName(m)), { recursive: true, force: true });
  assert.ok(installReal({ resourcesDir: resources, binDir, trust, probe }).ok);
  assert.equal(probes, 2, 'the re-copied runtime was probed again');
});

test('m2b: the DEFAULT probe classifies — killed by a signal = transient (not remembered), a loader-style `exit 127` = deterministic (remembered)', () => {
  bundle('#!/bin/sh\nkill -KILL $$\n');
  const trustA = createRuntimeTrust();
  const killed = installReal({ resourcesDir: resources, binDir: path.join(root, 'binA'), trust: trustA });
  assert.equal(killed.ok, false);
  if (!killed.ok && !killed.absent) assert.match(killed.reason, /transient: /);
  assert.equal(trustA.checked.size, 0, 'a transient failure is not remembered');
  bundle('#!/bin/sh\necho "error while loading shared libraries: libstdc++.so.6" >&2\nexit 127\n');
  const trustB = createRuntimeTrust();
  const loader = installReal({ resourcesDir: resources, binDir: path.join(root, 'binB'), trust: trustB });
  assert.equal(loader.ok, false);
  if (!loader.ok && !loader.absent) { assert.match(loader.reason, /libstdc\+\+/); assert.doesNotMatch(loader.reason, /transient: /); }
  assert.equal(trustB.checked.size, 1, 'a deterministic refusal is remembered');
});
