import { test } from 'node:test';
import assert from 'node:assert/strict';
import { CAP_STATE_TTL_MS, createCapStateCache, type CapStateValue } from './cap-state-cache.ts';

const U = 'orchestra-ws-aa-1aaaaa.scope';
const cap = (state: CapStateValue['state'], unit = U): CapStateValue => ({ unit, state, hardBytes: 6 * 1024 ** 3 });

function rig(answers: Record<string, { cap?: CapStateValue } | null | 'throw'> = {}) {
  let t = 1_000_000;
  const probes: string[] = [];
  const logs: string[] = [];
  const cache = createCapStateCache({
    probe: async (id) => {
      probes.push(id);
      const a = answers[id];
      if (a === 'throw') throw new Error('socket');
      return a === undefined ? null : a;
    },
    now: () => t,
    log: { warn: (id, m) => logs.push(`${id}: ${m}`) },
    describe: (c) => `described ${c.state}`,
  });
  return { cache, probes, logs, advance: (ms: number) => (t += ms) };
}

test('C1 remember / of: the latest value wins; unknown is null (never « active »)', () => {
  const { cache } = rig();
  assert.equal(cache.of('w1'), null);
  cache.remember('w1', cap('active'));
  assert.equal(cache.of('w1')?.state, 'active');
  cache.remember('w1', cap('unprotected'));
  assert.equal(cache.of('w1')?.state, 'unprotected');
});

test('C2 a CHANGE of state inside one scope is logged once with the workspace and the words; the first value and a repeat are silent; a new scope (restart) is not a « change »', () => {
  const { cache, logs } = rig();
  cache.remember('w1', cap('active'));
  cache.remember('w1', cap('active'));
  assert.equal(logs.length, 0);
  cache.remember('w1', cap('unprotected'));
  assert.deepEqual(logs, ['w1: cap state changed active → unprotected — described unprotected']);
  cache.remember('w1', cap('active', 'orchestra-ws-aa-1bbbbb.scope'));
  assert.equal(logs.length, 1, 'another unit is another session');
});

test('C3 refresh PROBES a keeper nobody told us about (review M3: attach is lazy, an unattached keeper never pushes) and remembers the answer', async () => {
  const { cache, probes } = rig({ w1: { cap: cap('unprotected') } });
  cache.refresh(['w1']);
  await cache.idle();
  assert.deepEqual(probes, ['w1']);
  assert.equal(cache.of('w1')?.state, 'unprotected');
});

test('C4 a fresh entry is NOT probed again; a stale one (older than the TTL) is — so a flip while nobody was attached is found within the TTL', async () => {
  const { cache, probes, advance } = rig({ w1: { cap: cap('active') } });
  cache.remember('w1', cap('active'));
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.length, 0, 'told just now: no probe');
  advance(CAP_STATE_TTL_MS - 1);
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.length, 0, 'one ms under the TTL');
  advance(2);
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.length, 1, 'past the TTL: asked again');
});

test('C5 a keeper launched WITHOUT a cap answers with no `cap`: remembered as « none » so a 2 s poll does not probe it every time; of() stays null', async () => {
  const { cache, probes, advance } = rig({ w1: {} });
  cache.refresh(['w1']);
  await cache.idle();
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.length, 1);
  assert.equal(cache.of('w1'), null);
  advance(CAP_STATE_TTL_MS + 1);
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.length, 2, 'asked again after the TTL (a later start may have a cap)');
});

test('C6 no answer / a throwing probe keeps what we knew and never throws; one probe in flight per workspace', async () => {
  const { cache, probes, advance } = rig({ w1: null, w2: 'throw' });
  cache.remember('w1', cap('active'));
  advance(CAP_STATE_TTL_MS + 1);
  cache.refresh(['w1', 'w2', 'w2']);
  cache.refresh(['w2']);
  await cache.idle();
  assert.equal(cache.of('w1')?.state, 'active', 'a keeper that does not answer keeps its last known state');
  assert.equal(cache.of('w2'), null);
  assert.deepEqual(probes.sort(), ['w1', 'w2'], 'w2 asked ONCE although refresh named it three times');
  cache.refresh(['w1']);
  await cache.idle();
  assert.equal(probes.filter((p) => p === 'w1').length, 2, 'an entry whose probe got no answer is still stale: asked again at the next look');
});
