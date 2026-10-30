// #408 — the 413 must be READABLE by a sender that is still pushing: the server answers, then reads-and-discards (bounded), never closes under the sender.
// Raw sockets through the REAL server (node http's client hides the race behind its own buffering). Ledger: scripts/acces-mobile-413-rig.sh (≥ 500 runs under load).

import test, { mock } from 'node:test';
import v8 from 'node:v8';
import vm from 'node:vm';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, type AccesMobileServerOptions } from './server.ts';
import { MOBILE_SEND_MAX_BODY } from '../shared/acces-mobile-conversation.ts';
import { REFUSED_DRAIN_MAX_BYTES, REFUSED_LINGER_MAX_MS } from '../shared/acces-mobile-refusal-drain.ts';

const LOGIN = 'lucas.mas@mobile.club';
const TOKEN = 'tok_' + 'a'.repeat(40);
const PATH = '/api/answer?id=w1&request=r1'; // the plain 128 KB cap
const sleepMs = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function rig(extra: Partial<AccesMobileServerOptions> = {}) {
  const logs: string[] = [];
  const calls: string[] = [];
  const server = createAccesMobileServer({ allowedLogin: LOGIN, readToken: () => TOKEN, upstream: async (route) => (calls.push(route), { ok: true }), log: (l) => logs.push(l), ...extra });
  await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
  return {
    port: (server.address() as AddressInfo).port,
    logs,
    calls,
    close: () => {
      server.closeAllConnections();
      return new Promise<void>((r) => server.close(() => r()));
    },
  };
}

const headOf = (path: string, contentLength: number): string =>
  `POST ${path} HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${LOGIN}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n`;

interface Sender {
  got: () => string;
  status: () => number;
  sent: () => number;
  closedAt: () => number; // 0 = still open
  error: () => string;
  stop: () => void;
  t0: number;
}
/** A sender: the head promises `contentLength` bytes, then it writes 64 KB chunks (honouring backpressure) until `limit` bytes or stopped. It never stops because of a response. */
function sender(port: number, contentLength: number, limit = Infinity, path = PATH): Sender {
  const s = net.connect(port, '127.0.0.1');
  const t0 = Date.now();
  let got = '', sent = 0, closedAt = 0, error = '', stopped = false;
  const chunk = Buffer.alloc(65536, 0x41);
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('error', (e: NodeJS.ErrnoException) => (error = e.code ?? String(e)));
  s.on('close', () => (closedAt = Date.now() - t0 || 1));
  s.on('connect', async () => {
    s.write(headOf(path, contentLength));
    while (!stopped && !s.destroyed && sent < Math.min(limit, contentLength)) {
      const n = Math.min(chunk.length, Math.min(limit, contentLength) - sent);
      sent += n;
      if (!s.write(n === chunk.length ? chunk : chunk.subarray(0, n))) await new Promise<void>((r) => { const f = () => { s.off('drain', f); s.off('close', f); r(); }; s.once('drain', f); s.once('close', f); });
    }
  });
  return { got: () => got, status: () => Number(/^HTTP\/1\.[01] (\d{3})/.exec(got)?.[1] ?? 0), sent: () => sent, closedAt: () => closedAt, error: () => error, stop: () => { stopped = true; s.destroy(); }, t0 };
}
/** BOUNDED wait: a mutant must FAIL this suite fast, never hang it. */
async function until(fn: () => boolean, what: string, ms = 4000): Promise<void> {
  const t0 = Date.now();
  while (!fn()) {
    if (Date.now() - t0 > ms) throw new Error(`timed out: ${what}`);
    await sleepMs(5);
  }
}

test('#408: the 413 is complete on the wire (Connection: close, no body) while the sender is still pushing, and the connection is NOT closed under it', { timeout: 15_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 6000 });
  const c = sender(r.port, 500 * 1_048_576); // far beyond cap + the drain bound: still pushing when the server holds
  try {
    await until(() => c.status() === 413, 'the 413 is readable');
    assert.match(c.got(), /\r\nConnection: close\r\n/i, 'the client is told not to reuse the socket');
    assert.match(c.got(), /\r\nContent-Length: 0\r\n/i, 'the answer is complete without ending the response');
    await sleepMs(400); // an early close (the unfixed server ends the response ⇒ node destroys the socket) lands well inside this window
    assert.equal(c.closedAt(), 0, 'the server did not hang up on a sender that is still within the bounds');
    assert.equal(c.error(), '', 'and the sender never saw a reset');
    // the DEFAULT byte bound: a sender that never stops stalls once the server pauses (bound + kernel buffers), it does not keep flowing
    let last = -1;
    for (let stable = 0; stable < 3; ) {
      await sleepMs(100);
      stable = c.sent() === last ? stable + 1 : 0;
      last = c.sent();
    }
    assert.ok(c.sent() <= MOBILE_SEND_MAX_BODY + REFUSED_DRAIN_MAX_BYTES + 28 * 1_048_576, `the sender stalled at ${(c.sent() / 1_048_576).toFixed(1)} MiB — the default drain bound holds`);
    assert.equal(c.closedAt(), 0, 'and it is still held (not cut) while stalled');
    assert.equal(r.calls.length, 0, 'a refused body never reaches main');
    assert.equal(r.logs.filter((l) => l.includes('refused 413 too-large')).length, 1, 'one refusal line');
  } finally {
    c.stop();
    await r.close();
  }
});

test('#408 must-FAIL: a sender that never stops is held at most the deadline and read for at most the drain bound (+ kernel buffers) — not a resource hole', { timeout: 20_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 600, refusedDrainMaxBytes: 256 * 1024 });
  const c = sender(r.port, 500 * 1_048_576); // offers 500 MB, never stops by itself
  try {
    await until(() => c.status() === 413, 'the 413 is readable');
    await until(() => c.closedAt() > 0, 'the deadline cuts the connection', 6000);
    assert.ok(c.closedAt() >= 500, `held to the deadline, not cut when the drain bound was hit (closed after ${c.closedAt()} ms)`);
    assert.ok(c.closedAt() <= 600 + 4000, `cut near the 600 ms deadline, took ${c.closedAt()} ms`);
    // bytes the kernel accepted from the sender: cap + drain bound + client send buffer + server receive buffer (loopback autotuning stays well under 24 MB)
    assert.ok(c.sent() <= MOBILE_SEND_MAX_BODY + 256 * 1024 + 24 * 1_048_576, `the sender could push ${c.sent()} bytes — the drain is bounded`);
  } finally {
    c.stop();
    await r.close();
  }
});

test('#408: a sender that FINISHES its (over-cap) body inside the bounds is closed at once and cleanly — FIN, no reset, no wait for the deadline', { timeout: 15_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 8000 });
  const total = MOBILE_SEND_MAX_BODY + 200_000; // over the cap, under cap + drain bound
  const c = sender(r.port, total);
  try {
    await until(() => c.closedAt() > 0, 'a finished sender is closed (not held to the deadline)', 4000);
    assert.equal(c.status(), 413);
    assert.equal(c.error(), '', 'closed with a FIN, not an RST');
    assert.ok(c.closedAt() < 4000, `closed in ${c.closedAt()} ms, well before the 8 s deadline`);
    assert.equal(c.sent(), total, 'every byte was accepted — the sender was never cut');
  } finally {
    c.stop();
    await r.close();
  }
});

test('#408 control: a body at the cap is NOT a 413 and the connection is not held (relayed, 200, no linger)', { timeout: 15_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 8000 });
  const body = JSON.stringify({ answers: { q: ['x'] } });
  const s = net.connect(r.port, '127.0.0.1');
  let got = '';
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('error', () => {});
  try {
    await new Promise<void>((res) => s.once('connect', () => res()));
    s.write(`POST ${PATH} HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${LOGIN}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${body.length}\r\n\r\n${body}`);
    await until(() => /^HTTP\/1\.1 200/.test(got), 'a normal body is answered');
    assert.doesNotMatch(got, /Connection: close/i, 'keep-alive is untouched on the normal path');
    assert.deepEqual(r.calls, ['/mobile/answer']);
  } finally {
    s.destroy();
    await r.close();
  }
});

test('#408: the DEFAULT deadline (REFUSED_LINGER_MAX_MS, no option injected) is what cuts a held sender — mock timers, no 10 s wait', { timeout: 15_000 }, async () => {
  mock.timers.enable({ apis: ['setTimeout'] }); // the server's deadline timer is the only setTimeout in play (net/http use internal timers; this test polls with setImmediate)
  const tickUntil = async (fn: () => boolean, what: string): Promise<void> => {
    const t0 = Date.now();
    while (!fn()) {
      if (Date.now() - t0 > 4000) throw new Error(`timed out: ${what}`);
      await new Promise((res) => setImmediate(res));
    }
  };
  let c: Sender | undefined;
  const r = await rig(); // defaults for both bounds
  try {
    c = sender(r.port, 500 * 1_048_576);
    await tickUntil(() => c!.status() === 413, 'the 413 is readable');
    mock.timers.tick(REFUSED_LINGER_MAX_MS - 1);
    for (let i = 0; i < 200; i++) await new Promise((res) => setImmediate(res)); // let any (wrong) early cut land
    assert.equal(c.closedAt(), 0, 'one ms before the default deadline the sender is still held');
    mock.timers.tick(1);
    await tickUntil(() => c!.closedAt() > 0, 'the default deadline cuts the connection');
  } finally {
    mock.timers.reset();
    c?.stop();
    await r.close();
  }
});

/** Header map (lower-cased names) of the first response in `raw`. */
const headerMap = (raw: string): Map<string, string> => new Map(raw.split('\r\n\r\n')[0].split('\r\n').slice(1).map((l) => [l.slice(0, l.indexOf(':')).toLowerCase(), l.slice(l.indexOf(':') + 1).trim()]));

test('#408 F1: a request PIPELINED behind a refused body is never run (no upstream call, no stream) and the connection still closes cleanly', { timeout: 15_000 }, async () => {
  let streams = 0;
  let token = TOKEN; // flipped in `finally`: a leaked stream's re-check interval then closes it, so a RED run ends instead of hanging
  const r = await rig({ refusedLingerMaxMs: 3000, readToken: () => token, streamRecheckMs: 50, upstreamStream: () => (streams++, () => {}) });
  const total = MOBILE_SEND_MAX_BODY + 100_000;
  const auth = `Tailscale-User-Login: ${LOGIN}\r\nAuthorization: Bearer ${TOKEN}\r\n`;
  const small = JSON.stringify({ answers: { q: ['x'] } });
  const s = net.connect(r.port, '127.0.0.1');
  let got = '', err = '', closed = false;
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('error', (e: NodeJS.ErrnoException) => (err = e.code ?? String(e)));
  s.on('close', () => (closed = true));
  try {
    await new Promise<void>((res) => s.once('connect', () => res()));
    // ONE write: the over-cap request, then a stream request and an answer request pipelined right behind it
    s.write(headOf(PATH, total) + 'A'.repeat(total) + `GET /api/stream HTTP/1.1\r\nHost: x\r\n${auth}\r\n` + `POST ${PATH} HTTP/1.1\r\nHost: x\r\n${auth}Content-Type: application/json\r\nContent-Length: ${small.length}\r\n\r\n${small}`);
    await until(() => closed, 'the connection closes (the body finished: a clean close, not the deadline)', 2500);
    assert.match(got, /^HTTP\/1\.1 413/, 'the 413 was read');
    assert.equal((got.match(/^HTTP\/1\.1 /gm) ?? []).length, 1, 'and it is the only answer on the wire — nothing pipelined ran');
    assert.equal(err, '', 'no reset');
    assert.equal(streams, 0, 'no stream was started behind the refusal (it would be orphaned: the socket is about to close)');
    assert.deepEqual(r.calls, [], 'no pipelined write reached main');
  } finally {
    token = 'rotated-' + TOKEN;
    s.destroy();
    await r.close();
  }
});

test('#408 F2: a COMPLETE over-cap body (cap + 1 MiB + 300 KB, inside the kernel buffers) is closed at once with a FIN — not held to the deadline then reset', { timeout: 15_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 8000 });
  const total = MOBILE_SEND_MAX_BODY + 1_048_576 + 300_000;
  const c = sender(r.port, total);
  try {
    await until(() => c.closedAt() > 0, 'a complete body is closed, not held to the 8 s deadline', 4000);
    assert.equal(c.status(), 413);
    assert.equal(c.error(), '', 'closed with a FIN, not an RST');
    assert.equal(c.sent(), total, 'every byte was accepted');
    assert.ok(c.closedAt() < 4000);
  } finally {
    c.stop();
    await r.close();
  }
});

test('#408 F3: the 413 carries the same security headers as every other refusal', { timeout: 15_000 }, async () => {
  const r = await rig({ refusedLingerMaxMs: 3000 });
  const c = sender(r.port, 500 * 1_048_576);
  const s = net.connect(r.port, '127.0.0.1');
  let other = '';
  s.on('data', (d) => (other += d.toString('latin1')));
  s.on('error', () => {});
  try {
    await new Promise<void>((res) => s.once('connect', () => res()));
    s.write(`GET /api/workspaces HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${LOGIN}\r\n\r\n`); // no token ⇒ 401
    await until(() => other.includes('\r\n\r\n'), 'the 401 head');
    await until(() => c.status() === 413, 'the 413 is readable');
    const h401 = headerMap(other);
    const h413 = headerMap(c.got());
    assert.match(other, /^HTTP\/1\.1 401/);
    const wanted = [...h401.keys()].filter((k) => !['date', 'connection', 'keep-alive', 'content-length'].includes(k));
    assert.ok(wanted.length >= 5 && wanted.includes('content-security-policy') && wanted.includes('cache-control'), `the control refusal carries the security set (${wanted.join(', ')})`);
    for (const k of wanted) assert.equal(h413.get(k), h401.get(k), `413 header ${k}`);
  } finally {
    s.destroy();
    c.stop();
    await r.close();
  }
});

test('#408 F4: senders HELD after a 413 do not retain the body they were refused (the buffered chunks are released at the 413)', { timeout: 30_000 }, async () => {
  v8.setFlagsFromString('--expose_gc');
  const gc = vm.runInNewContext('gc') as () => void;
  const collect = (): number => { for (let i = 0; i < 4; i++) gc(); return process.memoryUsage().arrayBuffers; };
  const r = await rig({ refusedLingerMaxMs: 8000 });
  const senders: Sender[] = [];
  try {
    const before = collect();
    // /api/send takes the 20 MiB attachment cap: each sender buffers ~20 MiB before the 413, then is held (it offers far more than cap + the drain bound)
    for (let i = 0; i < 4; i++) senders.push(sender(r.port, 500 * 1_048_576, Infinity, '/api/send?id=w1'));
    await until(() => senders.every((c) => c.status() === 413), 'every sender is refused', 20_000);
    await sleepMs(300);
    const held = collect() - before;
    assert.ok(held < 40 * 1_048_576, `4 held senders retain ${(held / 1_048_576).toFixed(1)} MiB of array buffers (an unreleased body would be ~80 MiB)`);
  } finally {
    for (const c of senders) c.stop();
    await r.close();
  }
});
