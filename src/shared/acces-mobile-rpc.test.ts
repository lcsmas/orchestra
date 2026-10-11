// Accès mobile private channel (#338 review M1): both ends over an in-memory duplex pair.
import test from 'node:test';
import assert from 'node:assert/strict';
import { PassThrough } from 'node:stream';
import { createRpcClient, serveRpc, type RpcHandlers, type RpcWire } from './acces-mobile-rpc.ts';

function pair(): { a: RpcWire & { destroy(): void }; b: RpcWire & { destroy(): void } } {
  const ab = new PassThrough();
  const ba = new PassThrough();
  const end = (s: PassThrough) => ({
    write: (c: string) => s.write(c),
    on: (e: string, cb: (...x: never[]) => void) => (e === 'data' ? (s === ab ? ba : ab).on('data', cb) : (s === ab ? ba : ab).on(e, cb)),
    destroy: () => {
      ab.end();
      ba.end();
    },
  });
  return { a: end(ab) as never, b: end(ba) as never };
}
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

test('a call reaches main with its route + body and resolves with main\'s result', async () => {
  const { a, b } = pair();
  const seen: unknown[] = [];
  serveRpc(b, { call: async (route, body) => (seen.push([route, body]), { ok: true, echo: body.x }), stream: () => null });
  const client = createRpcClient(a);
  assert.deepEqual(await client.call('/mobile/x', { x: 7 }), { ok: true, echo: 7 });
  assert.deepEqual(seen, [['/mobile/x', { x: 7 }]]);
});

test('concurrent calls are matched by id, never crossed', async () => {
  const { a, b } = pair();
  serveRpc(b, { call: async (_r, body) => (await sleep(Number(body.wait)), { v: body.v }), stream: () => null });
  const client = createRpcClient(a);
  const [slow, fast] = await Promise.all([client.call('/r', { v: 'slow', wait: 40 }), client.call('/r', { v: 'fast', wait: 1 })]);
  assert.deepEqual([slow, fast], [{ v: 'slow' }, { v: 'fast' }]);
});

test('a handler that throws answers {ok:false}, never kills the channel', async () => {
  const { a, b } = pair();
  serveRpc(b, { call: async (r) => { if (r === '/boom') throw new Error('kaboom'); return { ok: true }; }, stream: () => null });
  const client = createRpcClient(a);
  assert.deepEqual(await client.call('/boom', {}), { ok: false, error: 'kaboom' });
  assert.deepEqual(await client.call('/fine', {}), { ok: true }, 'still alive');
});

test('timeout rejects; a closed channel rejects pending calls and ends open streams', async () => {
  const { a, b } = pair();
  serveRpc(b, { call: () => new Promise(() => {}), stream: () => () => {} });
  const client = createRpcClient(a);
  await assert.rejects(client.call('/hang', {}, 30), /timeout/);
  let ended = 0;
  client.stream('/mobile/stream', () => {}, () => ended++);
  const pending = client.call('/hang', {}, 5000);
  a.destroy();
  await assert.rejects(pending, /closed/);
  await sleep(10);
  assert.equal(ended, 1);
  await assert.rejects(client.call('/x', {}), /closed/, 'no call on a dead channel');
});

test('streams: items flow, cancel unsubscribes in main, an unknown stream ends at once', async () => {
  const { a, b } = pair();
  let push!: (m: unknown) => void;
  let unsubscribed = 0;
  const handlers: RpcHandlers = {
    call: async () => ({}),
    stream: (route, p) => {
      if (route !== '/mobile/stream') return null;
      push = p;
      return () => unsubscribed++;
    },
  };
  serveRpc(b, handlers);
  const client = createRpcClient(a);
  const got: unknown[] = [];
  const cancel = client.stream('/mobile/stream', (m) => got.push(m), () => {});
  await sleep(10);
  push({ t: 'conv', id: 'w', v: 1 });
  push({ t: 'ping' });
  await sleep(10);
  assert.deepEqual(got, [{ t: 'conv', id: 'w', v: 1 }, { t: 'ping' }]);
  cancel();
  await sleep(10);
  assert.equal(unsubscribed, 1);
  let endedUnknown = 0;
  client.stream('/nope', () => {}, () => endedUnknown++);
  await sleep(10);
  assert.equal(endedUnknown, 1);
});

test('main disposes every stream when the server process goes away', async () => {
  const { a, b } = pair();
  let unsubscribed = 0;
  serveRpc(b, { call: async () => ({}), stream: () => () => unsubscribed++ });
  const client = createRpcClient(a);
  client.stream('/mobile/stream', () => {}, () => {});
  client.stream('/mobile/stream', () => {}, () => {});
  await sleep(10);
  b.destroy();
  await sleep(10);
  assert.equal(unsubscribed, 2);
});

test('torn and foreign lines are dropped; the channel keeps working', async () => {
  const { a, b } = pair();
  serveRpc(b, { call: async () => ({ ok: 1 }), stream: () => null });
  a.write('not json\n{"id":"x"}\n{"no":1}\n');
  const client = createRpcClient(a);
  assert.deepEqual(await client.call('/r', {}), { ok: 1 });
});
