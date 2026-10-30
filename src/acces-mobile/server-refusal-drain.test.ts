// #408 — the 413 must be READABLE by a sender that is still pushing: the server answers, then reads-and-discards (bounded), never closes under the sender.
// Raw sockets through the REAL server (node http's client hides the race behind its own buffering). Ledger: scripts/acces-mobile-413-rig.sh (≥ 500 runs under load).

import test, { mock } from 'node:test';
import assert from 'node:assert/strict';
import net from 'node:net';
import type { AddressInfo } from 'node:net';
import { createAccesMobileServer, type AccesMobileServerOptions } from './server.ts';
import { MOBILE_SEND_MAX_BODY } from '../shared/acces-mobile-conversation.ts';
import { REFUSED_LINGER_MAX_MS } from '../shared/acces-mobile-refusal-drain.ts';

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
function sender(port: number, contentLength: number, limit = Infinity): Sender {
  const s = net.connect(port, '127.0.0.1');
  const t0 = Date.now();
  let got = '', sent = 0, closedAt = 0, error = '', stopped = false;
  const chunk = Buffer.alloc(65536, 0x41);
  s.on('data', (d) => (got += d.toString('latin1')));
  s.on('error', (e: NodeJS.ErrnoException) => (error = e.code ?? String(e)));
  s.on('close', () => (closedAt = Date.now() - t0 || 1));
  s.on('connect', async () => {
    s.write(`POST ${PATH} HTTP/1.1\r\nHost: x\r\nTailscale-User-Login: ${LOGIN}\r\nAuthorization: Bearer ${TOKEN}\r\nContent-Type: application/json\r\nContent-Length: ${contentLength}\r\n\r\n`);
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
  const r = await rig({ refusedLingerMaxMs: 3000 });
  const c = sender(r.port, 50 * MOBILE_SEND_MAX_BODY);
  try {
    await until(() => c.status() === 413, 'the 413 is readable');
    assert.match(c.got(), /\r\nConnection: close\r\n/i, 'the client is told not to reuse the socket');
    assert.match(c.got(), /\r\nContent-Length: 0\r\n/i, 'the answer is complete without ending the response');
    await sleepMs(400); // an early close (the unfixed server ends the response ⇒ node destroys the socket) lands well inside this window
    assert.equal(c.closedAt(), 0, 'the server did not hang up on a sender that is still within the bounds');
    assert.equal(c.error(), '', 'and the sender never saw a reset');
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
