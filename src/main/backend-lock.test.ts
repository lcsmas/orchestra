import { test, beforeEach } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import {
  acquireBackendLock,
  releaseBackendLock,
  currentBackendLockHolder,
} from './backend-lock.ts';

// The lock file lives under orchestraHome(), which honors ORCHESTRA_HOME —
// point it at a fresh temp dir per test so nothing touches the real home.
beforeEach(() => {
  process.env.ORCHESTRA_HOME = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-lock-'));
});

function lockFile(): string {
  return path.join(process.env.ORCHESTRA_HOME!, 'backend.lock');
}

test('acquire → hold → release round-trip', () => {
  const res = acquireBackendLock('daemon');
  assert.deepEqual(res, { ok: true });
  const holder = currentBackendLockHolder();
  assert.equal(holder?.pid, process.pid);
  assert.equal(holder?.kind, 'daemon');
  const mode = fs.statSync(lockFile()).mode & 0o777;
  assert.equal(mode, 0o600);
  releaseBackendLock();
  assert.equal(fs.existsSync(lockFile()), false);
  assert.equal(currentBackendLockHolder(), null);
});

test('a live foreign holder blocks acquisition', () => {
  // pid 1 is always alive (kill(1, 0) yields EPERM for us — still "alive").
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, kind: 'electron', startedAt: 123 }));
  const res = acquireBackendLock('daemon');
  assert.equal(res.ok, false);
  if (!res.ok) {
    assert.equal(res.holder.pid, 1);
    assert.equal(res.holder.kind, 'electron');
  }
  // Refusing must not have clobbered the holder's file.
  assert.equal(JSON.parse(fs.readFileSync(lockFile(), 'utf8')).pid, 1);
});

test('a stale (dead-pid) lock is reclaimed', () => {
  // A real pid that is certainly dead: a child that already exited.
  const dead = spawnSync('true').pid!;
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: dead, kind: 'daemon', startedAt: 1 }));
  const res = acquireBackendLock('electron');
  assert.deepEqual(res, { ok: true });
  assert.equal(currentBackendLockHolder()?.pid, process.pid);
  releaseBackendLock();
});

test('a corrupt lock file is treated as unheld', () => {
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), 'not json at all');
  assert.deepEqual(acquireBackendLock('daemon'), { ok: true });
  releaseBackendLock();
});

test('release never clobbers a lock owned by another pid', () => {
  fs.mkdirSync(path.dirname(lockFile()), { recursive: true });
  fs.writeFileSync(lockFile(), JSON.stringify({ pid: 1, kind: 'daemon', startedAt: 1 }));
  releaseBackendLock();
  assert.equal(fs.existsSync(lockFile()), true, 'foreign lock survives our release');
});

test('re-acquire by the same pid succeeds (idempotent restart within a process)', () => {
  assert.deepEqual(acquireBackendLock('daemon'), { ok: true });
  assert.deepEqual(acquireBackendLock('daemon'), { ok: true });
  releaseBackendLock();
});
