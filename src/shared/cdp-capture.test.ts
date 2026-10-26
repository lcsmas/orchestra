import { test } from 'node:test';
import assert from 'node:assert/strict';
import { captureWithFallback, type CaptureTimers, CAPTURE_PROBE_DELAYS_MS } from './cdp-capture.ts';

/** Manual clock: timers fire when the test advances time. */
function clock() {
  let now = 0;
  let seq = 0;
  const pending = new Map<number, { at: number; fn: () => void }>();
  const timers: CaptureTimers = {
    set: (fn, ms) => { const id = ++seq; pending.set(id, { at: now + ms, fn }); return id; },
    clear: (h) => { pending.delete(h as number); },
  };
  const advance = async (ms: number) => {
    const target = now + ms;
    for (;;) {
      const next = [...pending.entries()].filter(([, t]) => t.at <= target).sort((a, b) => a[1].at - b[1].at)[0];
      if (!next) break;
      pending.delete(next[0]);
      now = next[1].at;
      next[1].fn();
      await new Promise((r) => setImmediate(r));
    }
    now = target;
    await new Promise((r) => setImmediate(r));
  };
  return { timers, advance, pendingCount: () => pending.size };
}

const never = () => new Promise<never>(() => {});

test('primary answers → via debugger; invalidate called once; no timer is left behind', async () => {
  const c = clock();
  let invalidated = 0;
  const r = await captureWithFallback({
    primary: async () => 'PNG',
    probe: async () => {},
    invalidate: () => { invalidated++; },
    fallback: async () => 'FB',
    timers: c.timers,
  });
  assert.deepEqual(r, { via: 'debugger', data: 'PNG' });
  assert.equal(invalidated, 1);
  assert.equal(c.pendingCount(), 0);
});

test('a hung primary gets frame probes at the scheduled delays, then the fallback past the deadline', async () => {
  const c = clock();
  let probes = 0;
  const p = captureWithFallback({
    primary: never,
    probe: async () => { probes++; },
    invalidate: () => {},
    fallback: async () => 'FB',
    timers: c.timers,
    deadlineMs: 5000,
  });
  await c.advance(251);
  assert.equal(probes, 1);
  await c.advance(5000);
  assert.equal(probes, CAPTURE_PROBE_DELAYS_MS.length);
  assert.deepEqual(await p, { via: 'fallback', data: 'FB' });
  assert.equal(c.pendingCount(), 0);
});

test('a primary that answers late (after a probe) still wins over the fallback', async () => {
  const c = clock();
  let release!: (s: string) => void;
  const p = captureWithFallback({
    primary: () => new Promise<string>((res) => { release = res; }),
    probe: async () => {},
    invalidate: () => {},
    fallback: async () => 'FB',
    timers: c.timers,
  });
  await c.advance(800);
  release('LATE');
  assert.deepEqual(await p, { via: 'debugger', data: 'LATE' });
});

test('no fallback available (clip / captureBeyondViewport) → a NAMED deadline error, never a wrong image', async () => {
  const c = clock();
  const p = captureWithFallback({ primary: never, probe: async () => {}, invalidate: () => {}, fallback: null, timers: c.timers });
  const assertion = assert.rejects(p, /no frame within 5000 ms/);
  await c.advance(5001);
  await assertion;
});

test('a hung fallback is bounded by its own timeout and the error names both causes', async () => {
  const c = clock();
  const p = captureWithFallback({ primary: never, probe: async () => {}, invalidate: () => {}, fallback: never, timers: c.timers });
  const assertion = assert.rejects(p, /no frame within 5000 ms; fallback failed: capturePage\(\) gave no image within 1000 ms/);
  await c.advance(5001);
  await c.advance(1001);
  await assertion;
});

test('a FAILING primary falls back at once when it can, and rejects with its own error when it cannot', async () => {
  const c = clock();
  const ok = await captureWithFallback({
    primary: async () => { throw new Error('boom'); },
    probe: async () => {}, invalidate: () => {}, fallback: async () => 'FB', timers: c.timers,
  });
  assert.deepEqual(ok, { via: 'fallback', data: 'FB' });
  await assert.rejects(
    captureWithFallback({ primary: async () => { throw new Error('boom'); }, probe: async () => {}, invalidate: () => {}, fallback: null, timers: c.timers }),
    /boom/,
  );
  assert.equal(c.pendingCount(), 0);
});
