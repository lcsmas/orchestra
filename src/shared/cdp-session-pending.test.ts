import { test } from 'node:test';
import assert from 'node:assert/strict';
import { SessionPending } from './cdp-session-pending.ts';

const deferred = <T>() => {
  let resolve!: (v: T) => void;
  let reject!: (e: unknown) => void;
  const promise = new Promise<T>((res, rej) => { resolve = res; reject = rej; });
  return { promise, resolve, reject };
};
const gone = () => new Error('gone');

test('abort settles every command in flight on THAT session with the abort error, and only that session', async () => {
  const sp = new SessionPending();
  const a1 = deferred<string>(), a2 = deferred<string>(), b = deferred<string>();
  const p1 = sp.track('A', () => a1.promise, gone), p2 = sp.track('A', () => a2.promise, gone), pb = sp.track('B', () => b.promise, gone);
  assert.equal(sp.size('A'), 2);
  assert.equal(sp.size(), 3);
  assert.equal(sp.abort('A'), 2);
  await assert.rejects(p1, /gone/);
  await assert.rejects(p2, /gone/);
  assert.equal(sp.size('A'), 0);
  assert.equal(sp.size('B'), 1, 'a sibling session is untouched');
  b.resolve('ok');
  assert.equal(await pb, 'ok');
  assert.equal(sp.size(), 0);
});

test('a command that settles first is tracked no more: abort afterwards finds nothing and the result stands', async () => {
  const sp = new SessionPending();
  const d = deferred<number>();
  const p = sp.track('A', () => d.promise, gone);
  d.resolve(7);
  assert.equal(await p, 7);
  assert.equal(sp.size('A'), 0);
  assert.equal(sp.abort('A'), 0);
  const f = deferred<number>();
  const q = sp.track('A2', () => f.promise, gone);
  f.reject(new Error('boom'));
  await assert.rejects(q, /boom/);
  assert.equal(sp.size(), 0);
});

test('the outcome of an aborted command, arriving late, is dropped: the settled error stands and nothing is left tracked', async () => {
  const sp = new SessionPending();
  const old = deferred<string>();
  const p1 = sp.track('S', () => old.promise, () => new Error('first'));
  assert.equal(sp.abort('S'), 1);
  await assert.rejects(p1, /first/);
  old.resolve('late');
  await Promise.resolve();
  assert.equal(sp.size(), 0);
  assert.equal(sp.abort('S'), 0, 'the late outcome re-armed nothing');
  await assert.rejects(sp.track('S', () => Promise.resolve('x'), () => new Error('retired')), /retired/);
});

test('a send that throws synchronously rejects the command and leaves nothing tracked', async () => {
  const sp = new SessionPending();
  await assert.rejects(sp.track('A', () => { throw new Error('sync'); }, gone), /sync/);
  assert.equal(sp.size(), 0);
  assert.equal(sp.abort('A'), 0);
});

test('abort of a session with nothing in flight is a no-op', () => {
  const sp = new SessionPending();
  assert.equal(sp.abort('nope'), 0);
  assert.equal(sp.size('nope'), 0);
});

test('every aborted command gets its OWN error from onAbort', async () => {
  const sp = new SessionPending();
  let n = 0;
  const d = deferred<void>();
  const p1 = sp.track('A', () => d.promise, () => new Error(`e${++n}`)), p2 = sp.track('A', () => d.promise, () => new Error(`e${++n}`));
  sp.abort('A');
  const r = await Promise.allSettled([p1, p2]);
  assert.deepEqual(r.map((x) => (x.status === 'rejected' ? String(x.reason.message) : 'ok')).sort(), ['e1', 'e2']);
});

test('a session whose detach was announced refuses later commands at once and never calls send', async () => {
  const sp = new SessionPending();
  sp.abort('S'); // nothing in flight: the announcement alone retires it
  let sent = 0;
  await assert.rejects(sp.track('S', () => { sent++; return Promise.resolve(1); }, gone), /gone/);
  assert.equal(sent, 0, 'never forwarded');
  assert.equal(sp.size('S'), 0);
  assert.equal(await sp.track('OTHER', () => Promise.resolve(2), gone), 2, 'other sessions are untouched');
});

test('the retired set is bounded: the oldest id goes first', async () => {
  const sp = new SessionPending(2);
  sp.abort('A'); sp.abort('B'); sp.abort('C');
  await assert.rejects(sp.track('C', () => Promise.resolve(0), gone), /gone/);
  await assert.rejects(sp.track('B', () => Promise.resolve(0), gone), /gone/);
  assert.equal(await sp.track('A', () => Promise.resolve('forwarded'), gone), 'forwarded', 'A fell out of the 2-id window');
});
