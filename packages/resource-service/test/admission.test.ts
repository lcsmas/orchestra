// The pure admission decision (memory, disk, both) and the wait loop, driven with injected readings and a fake clock.
import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { decide, formatSize, parseMemAvailable, shortPhrase, waitForAdmission, type Reading, type Thresholds, type WaitOptions } from '../src/admission.ts';

const G = 1024 ** 3;
const T: Thresholds = { minMem: 6 * G, minDisk: 10 * G };

describe('decide', () => {
  it('admits when memory and disk are both above their thresholds', () => {
    assert.deepEqual(decide({ memFree: 8 * G, diskFree: 50 * G }, T), { admit: true, short: [] });
  });
  it('memory short, disk fine: waits for memory only', () => {
    const d = decide({ memFree: 3.2 * G, diskFree: 50 * G }, T);
    assert.equal(d.admit, false);
    assert.deepEqual(d.short, [{ resource: 'memory', free: 3.2 * G, min: 6 * G, src: undefined }]);
  });
  it('disk short, memory fine: waits for disk only', () => {
    const d = decide({ memFree: 8 * G, diskFree: 4 * G }, T);
    assert.equal(d.admit, false);
    assert.deepEqual(d.short, [{ resource: 'disk', free: 4 * G, min: 10 * G, src: undefined }]);
  });
  it('both short: waits for both, memory first', () => {
    const d = decide({ memFree: 1 * G, diskFree: 1 * G }, T);
    assert.equal(d.admit, false);
    assert.deepEqual(d.short.map((s) => s.resource), ['memory', 'disk']);
  });
  it('a free value EQUAL to its threshold is admitted, one byte under is not', () => {
    assert.equal(decide({ memFree: 6 * G, diskFree: 10 * G }, T).admit, true);
    assert.deepEqual(decide({ memFree: 6 * G - 1, diskFree: 10 * G }, T).short.map((s) => s.resource), ['memory']);
    assert.deepEqual(decide({ memFree: 6 * G, diskFree: 10 * G - 1 }, T).short.map((s) => s.resource), ['disk']);
  });
});

describe('measurements and phrasing', () => {
  it('parseMemAvailable reads MemAvailable (not MemFree) in bytes', () => {
    const text = 'MemTotal:       32000000 kB\nMemFree:          100000 kB\nMemAvailable:   16159024 kB\nBuffers:            1 kB\n';
    assert.equal(parseMemAvailable(text), 16159024 * 1024);
  });
  it('parseMemAvailable throws when the meter is absent (never read as zero or infinity)', () => {
    assert.throws(() => parseMemAvailable('MemTotal: 1 kB\nMemFree: 1 kB\n'), /MemAvailable not found/);
  });
  it('the waiting phrase names the resource, the free value and the threshold', () => {
    assert.equal(shortPhrase(decide({ memFree: 3.2 * G, diskFree: 50 * G }, T).short), 'free memory: 3.2G < 6G');
    assert.equal(shortPhrase(decide({ memFree: 3.2 * G, diskFree: 4 * G }, T).short), 'free memory: 3.2G < 6G; free disk: 4G < 10G');
    assert.equal(shortPhrase(decide({ memFree: 3 * G, diskFree: 50 * G }, { ...T, minMem: 100 * G, memSrc: 'admit.conf' }).short), 'free memory: 3G < 100G (admit.conf)');
    assert.equal(shortPhrase(decide({ memFree: 8 * G, diskFree: 3 * G }, { ...T, minDisk: 100 * G, diskSrc: 'admit.conf' }).short), 'free disk: 3G < 100G (admit.conf)');
    assert.equal(shortPhrase(decide({ memFree: 3 * G, diskFree: 3 * G }, { minMem: 100 * G, minDisk: 100 * G, diskSrc: 'admit.conf' }).short), 'free memory: 3G < 100G; free disk: 3G < 100G (admit.conf)', 'the marker belongs to the resource the file set');
    assert.equal(formatSize(512 * 1024 ** 2), '512M');
    assert.equal(formatSize(6 * G - 1), '5.9G', 'just under a threshold never prints as equal to it');
  });
});

/** A fake world: the clock only moves when the loop sleeps, and a loop that never ends is a RED test, not a hang. */
function world(over: { timeoutMs?: number; reading?: (t: number) => Reading; thresholds?: (t: number) => Thresholds } = {}) {
  let t = 1_000_000;
  let sleeps = 0;
  const said: string[] = [];
  const reads: number[] = [];
  const opts: WaitOptions = {
    read: () => {
      reads.push(t);
      return (over.reading ?? (() => ({ memFree: 8 * G, diskFree: 50 * G })))(t);
    },
    thresholds: () => (over.thresholds ?? (() => T))(t),
    now: () => t,
    sleep: async (ms) => {
      if (++sleeps > 500) throw new Error('runaway wait loop');
      t += ms;
    },
    pollMs: 2000,
    reportMs: 30_000,
    say: (l) => said.push(l),
    ...(over.timeoutMs !== undefined ? { timeoutMs: over.timeoutMs } : {}),
  };
  return { opts, said, reads, sleeps: () => sleeps, start: 1_000_000 };
}

describe('waitForAdmission', () => {
  it('returns at once, without sleeping or printing, when both are above their thresholds', async () => {
    const w = world();
    const r = await waitForAdmission(w.opts);
    assert.equal(r.admitted, true);
    assert.equal(r.waitedMs, 0);
    assert.equal(w.sleeps(), 0);
    assert.deepEqual(w.said, []);
  });

  it('with memory short it waits, says what for with since/elapsed, and returns when the free value rises', async () => {
    const w = world({ reading: (t) => ({ memFree: t - 1_000_000 >= 10_000 ? 7 * G : 3.2 * G, diskFree: 50 * G }) });
    const r = await waitForAdmission(w.opts);
    assert.equal(r.admitted, true);
    assert.equal(r.waitedMs, 10_000, 'released at the first poll after memory recovered');
    assert.ok(w.sleeps() >= 5);
    assert.match(w.said[0], /^waiting for free memory: 3\.2G < 6G \(since 1970-01-01T00:16:40\.000Z, 0s elapsed\)$/);
  });

  it('with disk short it waits for disk, not memory', async () => {
    const w = world({ reading: (t) => ({ memFree: 8 * G, diskFree: t - 1_000_000 >= 4000 ? 12 * G : 4 * G }) });
    const r = await waitForAdmission(w.opts);
    assert.equal(r.admitted, true);
    assert.match(w.said[0], /^waiting for free disk: 4G < 10G /);
    assert.doesNotMatch(w.said[0], /memory/);
  });

  it('returns when the threshold is lowered while waiting (thresholds are re-read every poll)', async () => {
    const w = world({ reading: () => ({ memFree: 3 * G, diskFree: 50 * G }), thresholds: (t) => (t - 1_000_000 >= 6000 ? { minMem: 2 * G, minDisk: 10 * G } : T) });
    const r = await waitForAdmission(w.opts);
    assert.equal(r.admitted, true);
    assert.equal(r.waitedMs, 6000);
    assert.equal(r.thresholds.minMem, 2 * G);
  });

  it('repeats the reason every reportMs, not every poll; a change in what is short is said at once', async () => {
    const w = world({ reading: (t) => ({ memFree: 1 * G, diskFree: t - 1_000_000 >= 50_000 ? 50 * G : 1 * G }), timeoutMs: 60_000 });
    await waitForAdmission(w.opts);
    const elapsed = w.said.map((l) => /(\d+[hms][\d ms]*) elapsed/.exec(l)?.[1]);
    assert.deepEqual(elapsed, ['0s', '30s', '50s'], 'first, +30 s, then at 50 s when disk stopped being short');
    assert.match(w.said[0], /memory.*disk/);
    assert.doesNotMatch(w.said[2], /disk/);
  });

  it('a threshold changed while waiting is said at once, not at the next report', async () => {
    const w = world({ reading: () => ({ memFree: 1 * G, diskFree: 50 * G }), thresholds: (t) => (t - 1_000_000 >= 4000 ? { ...T, minMem: 3 * G } : T), timeoutMs: 8000 });
    await waitForAdmission(w.opts);
    assert.deepEqual(w.said.map((l) => /< (\d+G)/.exec(l)?.[1]), ['6G', '3G']);
  });

  it('a timeout of 0 looks once and never waits; a positive timeout gives up at that time and reports what was short', async () => {
    const w0 = world({ reading: () => ({ memFree: 1 * G, diskFree: 50 * G }), timeoutMs: 0 });
    const r0 = await waitForAdmission(w0.opts);
    assert.equal(r0.admitted, false);
    assert.equal(w0.sleeps(), 0);
    assert.equal(w0.reads.length, 1);

    const w = world({ reading: () => ({ memFree: 1 * G, diskFree: 50 * G }), timeoutMs: 7000 });
    const r = await waitForAdmission(w.opts);
    assert.equal(r.admitted, false);
    assert.equal(r.waitedMs, 7000, 'the last sleep is clipped to the time left');
    assert.deepEqual(r.last.short.map((s) => s.resource), ['memory']);
  });
});
