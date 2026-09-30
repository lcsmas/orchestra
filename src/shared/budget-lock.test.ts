// Advisory locks for the session-budget machinery (#211): live vs stale vs recycled owner, exclusivity, release safety.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { liveOwner, lockPath, ownerIsLive, procStartTicks, readLock, realLockDeps, tryAcquire, type LockDeps } from './budget-lock.ts';

function home(): string {
  const base = path.join(os.homedir(), '.cache', 'budget-lock-test');
  fs.mkdirSync(base, { recursive: true });
  return fs.mkdtempSync(path.join(base, 'h-'));
}
const deps = (o: Partial<LockDeps> = {}): LockDeps => ({ ...realLockDeps, ...o });

test('acquire is exclusive; a second taker sees the live owner; release frees it', () => {
  const h = home();
  const a = tryAcquire(h, 'suite', 'a');
  assert.ok(a.ok);
  const b = tryAcquire(h, 'suite', 'b');
  assert.equal(b.ok, false);
  assert.equal(!b.ok && b.heldBy?.pid, process.pid);
  assert.equal(liveOwner(h, 'suite')?.kind, 'a');
  a.ok && a.release();
  assert.equal(liveOwner(h, 'suite'), null);
  assert.ok(tryAcquire(h, 'suite', 'c').ok, 'free again');
  fs.rmSync(h, { recursive: true, force: true });
});

test('the two lock names are independent', () => {
  const h = home();
  assert.ok(tryAcquire(h, 'campaign', 'soak').ok);
  assert.ok(tryAcquire(h, 'suite', 'rerun').ok);
  assert.notEqual(lockPath(h, 'suite'), lockPath(h, 'campaign'));
  fs.rmSync(h, { recursive: true, force: true });
});

test('a dead owner is stale and is replaced', () => {
  const h = home();
  const p = lockPath(h, 'suite');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, JSON.stringify({ pid: 2 ** 22 + 12345, startTicks: 1, kind: 'ghost', startedAt: 1 }));
  assert.equal(liveOwner(h, 'suite'), null, 'dead pid is not a live owner');
  const got = tryAcquire(h, 'suite', 'me');
  assert.ok(got.ok);
  assert.equal(readLock(p)?.kind, 'me');
  fs.rmSync(h, { recursive: true, force: true });
});

test('a RECYCLED pid (alive, different start time) is stale; an unreadable start time fails closed (live)', () => {
  const h = home();
  const p = lockPath(h, 'campaign');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  const ticks = procStartTicks(process.pid);
  assert.ok(typeof ticks === 'number', 'this host exposes /proc start times');
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startTicks: (ticks as number) + 999, kind: 'old-campaign', startedAt: 1 }));
  assert.equal(liveOwner(h, 'campaign'), null, 'same pid, other process');
  fs.writeFileSync(p, JSON.stringify({ pid: process.pid, startTicks: ticks, kind: 'real', startedAt: 1 }));
  assert.equal(liveOwner(h, 'campaign')?.kind, 'real', 'same pid, same process');
  const unreadable = deps({ startTicks: () => null });
  assert.equal(ownerIsLive({ pid: process.pid, startTicks: 5, kind: 'k', startedAt: 1 }, unreadable), true, 'cannot prove recycle ⇒ treat as live');
  fs.rmSync(h, { recursive: true, force: true });
});

test('a corrupt lock file is replaced, not a permanent block', () => {
  const h = home();
  const p = lockPath(h, 'suite');
  fs.mkdirSync(path.dirname(p), { recursive: true });
  fs.writeFileSync(p, '{not json');
  assert.equal(liveOwner(h, 'suite'), null);
  assert.ok(tryAcquire(h, 'suite', 'x').ok);
  fs.rmSync(h, { recursive: true, force: true });
});

test('release removes only THIS owner\'s file (never a successor\'s)', () => {
  const h = home();
  const a = tryAcquire(h, 'suite', 'first', deps({ now: () => 1000 }));
  assert.ok(a.ok);
  // the first owner's file is replaced by a successor (e.g. after being judged stale)
  fs.writeFileSync(lockPath(h, 'suite'), JSON.stringify({ pid: process.pid, startTicks: procStartTicks(process.pid), kind: 'successor', startedAt: 2000 }));
  a.ok && a.release();
  assert.equal(readLock(lockPath(h, 'suite'))?.kind, 'successor');
  fs.rmSync(h, { recursive: true, force: true });
});

test('a lock held by ANOTHER live process blocks (real child)', async () => {
  const h = home();
  const child = spawn('sleep', ['30'], { stdio: 'ignore' });
  try {
    assert.ok(child.pid);
    fs.mkdirSync(path.dirname(lockPath(h, 'campaign')), { recursive: true });
    fs.writeFileSync(lockPath(h, 'campaign'), JSON.stringify({ pid: child.pid, startTicks: procStartTicks(child.pid as number), kind: 'soak', startedAt: 1 }));
    assert.equal(liveOwner(h, 'campaign')?.pid, child.pid);
    const t = tryAcquire(h, 'campaign', 'second');
    assert.equal(t.ok, false);
    child.kill('SIGKILL');
    await new Promise((r) => child.once('exit', r));
    assert.equal(liveOwner(h, 'campaign'), null, 'owner exited ⇒ stale');
  } finally {
    child.kill('SIGKILL');
    fs.rmSync(h, { recursive: true, force: true });
  }
});
