import { test } from 'node:test';
import assert from 'node:assert/strict';
import { clearScopedMember, memberHasScope, stopMemberScopeFor, stopMemberScopeIfAny, trackedKeeperUnit, type HostDeps } from './scope-stop-host-core.ts';
import type { ScopeStopReport } from './scope-stop.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';

// #327: the host entries' ordering / locking / deadline rules, on injected collaborators (no keeper, no cgroup). The call sites that use them are pinned in scope-stop-wiring.test.ts; the real thing runs in scripts/e2e-memory-cap.mjs.
const report = (over: Partial<ScopeStopReport> = {}): ScopeStopReport => ({ wsId: 'w', reason: 'r', scopes: ['u'], stopped: ['u'], kept: [], killed: 1, survivors: 0, ...over });
const wait = (ms: number) => new Promise((r) => setTimeout(r, ms));

function host(over: { scoped?: boolean; lockDelayMs?: number; stop?: () => Promise<ScopeStopReport | null>; killIf?: () => Promise<void> } = {}) {
  const events: string[] = [];
  const warns: string[] = [];
  let inLock = false;
  const d: HostDeps = {
    hasScope: () => over.scoped !== false,
    lock: async (_ws, op) => {
      events.push('lock-wait');
      if (over.lockDelayMs) await wait(over.lockDelayMs);
      inLock = true;
      events.push('lock-in');
      try {
        return await op();
      } finally {
        inLock = false;
        events.push('lock-out');
      }
    },
    stop: async (ws, reason) => {
      events.push(`stop${inLock ? '(locked)' : '(UNLOCKED)'} ${reason}`);
      return over.stop ? over.stop() : report();
    },
    killKeeperIfHeld: async (ws, pid, reason) => {
      events.push(`killKeeperIfHeld${inLock ? '(locked)' : '(UNLOCKED)'} ${pid} ${reason}`);
      if (over.killIf) await over.killIf();
    },
    log: { warn: (m) => warns.push(m) },
  };
  return { d, events, warns, inLock: () => inLock };
}

test('stopMemberScopeIfAny: a member WITHOUT a scope ⇒ null, and NOTHING runs — not the extra step, not the lock, not the stop', async () => {
  const h = host({ scoped: false });
  let extra = 0;
  assert.equal(await stopMemberScopeIfAny('w', 'workspace-archived', async () => { extra += 1; }, 1000, h.d), null);
  assert.equal(extra, 0);
  assert.deepEqual(h.events, []);
  assert.deepEqual(h.warns, []);
});

test('stopMemberScopeIfAny: a member WITH a scope — the extra step runs FIRST, then the stop, under the lock; a throwing or hanging extra never blocks the stop', async () => {
  const h = host();
  const order: string[] = [];
  const r = await stopMemberScopeIfAny('w', 'workspace-archived', async () => { order.push('extra'); }, 1000, { ...h.d, stop: async (ws, reason) => { order.push('stop'); return h.d.stop(ws, reason); } });
  assert.deepEqual(order, ['extra', 'stop']);
  assert.ok(h.events.includes('stop(locked) workspace-archived'), h.events.join(' | '));
  assert.equal(r?.stopped[0], 'u');
  const thrower = host();
  const r2 = await stopMemberScopeIfAny('w', 'workspace-archived', async () => { throw new Error('boom'); }, 1000, thrower.d);
  assert.ok(r2, 'the stop still ran');
  assert.ok(thrower.warns.some((m) => /pre-stop step failed/.test(m)), thrower.warns.join(' | '));
  const hanger = host();
  const t0 = Date.now();
  const r3 = await stopMemberScopeIfAny('w', 'workspace-archived', () => new Promise<void>(() => {}), 60, hanger.d);
  assert.ok(r3 && Date.now() - t0 < 1500, 'a hanging extra is bounded, then the stop runs');
  assert.ok(hanger.warns.some((m) => /pre-stop step is still running/.test(m)));
});

test('stopMemberScopeFor: bounded for the caller (the stop is not cancelled), a throwing stop is a null + a warning, never a throw', async () => {
  const slow = host({ stop: () => new Promise((r) => setTimeout(() => r(report()), 400)) });
  const t0 = Date.now();
  assert.equal(await stopMemberScopeFor('w', 'delete', 50, slow.d), null);
  assert.ok(Date.now() - t0 < 300, 'did not wait for the slow stop');
  assert.ok(slow.warns.some((m) => /still running after/.test(m)));
  const bad = host({ stop: async () => { throw new Error('systemd gone'); } });
  assert.equal(await stopMemberScopeFor('w', 'delete', 1000, bad.d), null);
  assert.ok(bad.warns.some((m) => /failed/.test(m)));
});

test('clearScopedMember: the announce runs INSIDE the lock, FIRST; then the keeper read before is killed (under the lock); then the scope stop — a launch cannot interleave', async () => {
  const h = host();
  const r = await clearScopedMember('w', 4242, async () => { h.events.push(`announce${h.inLock() ? '(locked)' : '(UNLOCKED)'}`); }, 1000, h.d);
  assert.deepEqual(h.events, ['lock-wait', 'lock-in', 'announce(locked)', 'killKeeperIfHeld(locked) 4242 clear', 'stop(locked) clear', 'lock-out']);
  assert.equal(r?.killed, 1);
});

test('clearScopedMember: a FAILED announce is surfaced (the clear failed, as without a scope) and no teardown is done on top of it', async () => {
  const h = host();
  await assert.rejects(clearScopedMember('w', 4242, async () => { throw new Error('store write failed'); }, 1000, h.d), /store write failed/);
  assert.ok(!h.events.some((e) => /^(stop|killKeeperIfHeld)/.test(e)), h.events.join(' | '));
});

test('clearScopedMember: a keeper kill that fails still lets the scope stop run (warned)', async () => {
  const h = host({ killIf: async () => { throw new Error('kill failed'); } });
  const r = await clearScopedMember('w', 7, async () => {}, 1000, h.d);
  assert.ok(r);
  assert.ok(h.events.some((e) => /^stop\(locked\)/.test(e)));
  assert.ok(h.warns.some((m) => /keeper kill failed/.test(m)));
});

test('clearScopedMember (review MAJOR): the lock wait is NOT under the deadline — the announce is awaited however long the lock is held, so /clear never returns before it ran; the deadline bounds only the teardown AFTER it', async () => {
  const waited = host({ lockDelayMs: 200 });
  let announced = false;
  const t0 = Date.now();
  await clearScopedMember('w', 1, async () => { announced = true; }, 40, waited.d);
  assert.equal(announced, true, 'the announce ran before clearScopedMember returned, although the lock wait (200 ms) exceeded the deadline (40 ms)');
  assert.ok(Date.now() - t0 >= 190);
  const slowTeardown = host({ stop: () => new Promise((r) => setTimeout(() => r(report()), 500)) });
  const t1 = Date.now();
  const r = await clearScopedMember('w', 1, async () => {}, 60, slowTeardown.d);
  assert.equal(r, null);
  assert.ok(Date.now() - t1 < 400, 'the teardown is bounded');
  assert.ok(slowTeardown.warns.some((m) => /teardown is still running/.test(m)));
});

test('trackedKeeperUnit: the unit is the basename of the keeper pid\'s OWN cgroup; no keeper ⇒ null; a vanished /proc entry ⇒ null; an unreadable or garbled cgroup ⇒ unknown (fail closed)', () => {
  const env = (read: (p: string) => string): ScopeEnv => ({ readFile: read, procRoot: '/proc' }) as never;
  assert.equal(trackedKeeperUnit('w', env(() => ''), () => null), null);
  assert.equal(trackedKeeperUnit('w', env((p) => { assert.equal(p, '/proc/99/cgroup'); return '0::/user.slice/user-1000.slice/user@1000.service/app.slice/orchestra-ws-w-abc.scope\n'; }), () => 99), 'orchestra-ws-w-abc.scope');
  for (const code of ['ENOENT', 'ESRCH']) assert.equal(trackedKeeperUnit('w', env(() => { throw Object.assign(new Error('x'), { code }); }), () => 99), null, code);
  assert.equal(trackedKeeperUnit('w', env(() => { throw Object.assign(new Error('x'), { code: 'EACCES' }); }), () => 99), 'unknown');
  assert.equal(trackedKeeperUnit('w', env(() => 'garbled\n'), () => 99), 'unknown');
});

test('memberHasScope: an unreadable scope lookup reads as NO scope and is SAID (the explicit stops then behave as before)', () => {
  const warns: string[] = [];
  const env = { readdir: () => { throw Object.assign(new Error('too many open files'), { code: 'EMFILE' }); }, readFile: () => '', exists: () => false, procRoot: '/proc' } as never;
  assert.equal(memberHasScope('w', env, { warn: (m) => warns.push(m) }), false);
  assert.equal(warns.length, 1);
  assert.match(warns[0], /scope lookup failed — treated as no scope/);
});

test('memberHasScope: a member with no scope reads as NO scope, silently (the common case: memory_cap OFF) — a read-only look at the real app slice for an id nobody has', () => {
  const warns: string[] = [];
  assert.equal(memberHasScope('no-such-workspace-327-zzz', realScopeEnv(), { warn: (m) => warns.push(m) }), false);
  assert.deepEqual(warns, [], 'nothing to say about a member that simply has no scope');
});
