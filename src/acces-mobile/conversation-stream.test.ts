import test from 'node:test';
import assert from 'node:assert/strict';
import vm from 'node:vm';
import { CONVERSATION_JS } from './conversation.ts';

/** Run the REAL phone stream code with a scripted clock + network: `chunks(n)` says whether the n-th read delivers bytes (a ping)
 *  when the clock passes it, or stays silent (a half-open connection). */
function runStream(opts: { pingEveryMs: number | null }) {
  let now = 0;
  const intervals: Array<{ fn: () => void; ms: number; next: number; id: number }> = [];
  const timeouts: Array<{ fn: () => void; at: number; id: number }> = [];
  let ids = 0;
  const fetches: string[] = [];
  const emitted: unknown[] = [];
  const pendingReads: Array<{ resolve: (v: unknown) => void }> = [];
  const sandbox: Record<string, unknown> = {
    window: {} as Record<string, unknown>,
    document: { addEventListener() {}, getElementById: () => null, hidden: false },
    localStorage: { getItem: () => 'tok', setItem() {} },
    AbortController,
    TextDecoder,
    Date: { now: () => now },
    setInterval: (fn: () => void, ms: number) => (intervals.push({ fn, ms, next: now + ms, id: ++ids }), ids),
    clearInterval: (id: number) => { const i = intervals.findIndex((x) => x.id === id); if (i >= 0) intervals.splice(i, 1); },
    setTimeout: (fn: () => void, ms: number) => (timeouts.push({ fn, at: now + ms, id: ++ids }), ids),
    clearTimeout: () => {},
    fetch: (url: string, init: { signal: AbortSignal }) => {
      fetches.push(url);
      return Promise.resolve({
        ok: true,
        status: 200,
        body: {
          getReader: () => ({
            read: () => new Promise((resolve, reject) => {
              init.signal.addEventListener('abort', () => reject(new Error('AbortError')));
              pendingReads.push({ resolve });
            }),
          }),
        },
      });
    },
  };
  sandbox.window = sandbox.window as object;
  vm.runInNewContext(CONVERSATION_JS, sandbox);
  const conv = (sandbox.window as { OrchestraConversation: { connect(): void; onStream(fn: (m: unknown) => void): void } }).OrchestraConversation;
  conv.onStream((m) => emitted.push(m));
  const flush = () => new Promise((r) => setImmediate(r));
  /** Advance the clock in 1 s steps, firing due timers and (if pinging) delivering a ping to the pending read. */
  const advance = async (ms: number) => {
    const end = now + ms;
    let lastPing = now;
    while (now < end) {
      now += 1000;
      if (opts.pingEveryMs && now - lastPing >= opts.pingEveryMs && pendingReads.length) {
        lastPing = now;
        pendingReads.splice(0).forEach((r) => r.resolve({ done: false, value: new TextEncoder().encode(': ping\n\n') }));
      }
      for (const t of intervals.slice()) if (now >= t.next) { t.next = now + t.ms; t.fn(); }
      for (const t of timeouts.splice(0).filter((x) => { if (now >= x.at) return true; timeouts.push(x); return false; })) t.fn();
      await flush(); await flush();
    }
  };
  conv.connect();
  return { fetches, emitted, advance, flush };
}

test('a stream that goes silent (half-open: no ping for 60 s) is dropped and reopened — the page never sits « en ligne » on a dead feed', async () => {
  const r = runStream({ pingEveryMs: null });
  await r.flush();
  assert.equal(r.fetches.length, 1);
  await r.advance(50_000);
  assert.equal(r.fetches.length, 1, 'not before 60 s of silence');
  await r.advance(20_000);
  assert.ok(r.emitted.some((m) => (m as { t?: string }).t === 'down'), 'told: down');
  assert.equal(r.fetches.length, 2, 'reconnected');
});

test('control: a stream that pings every 25 s is never dropped', async () => {
  const r = runStream({ pingEveryMs: 25_000 });
  await r.flush();
  await r.advance(180_000);
  assert.equal(r.fetches.length, 1);
  assert.ok(!r.emitted.some((m) => (m as { t?: string }).t === 'down'));
});
