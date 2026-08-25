import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  resolveDirectChildTargets,
  normalizeExplicitTargets,
  type BroadcastCandidate,
} from './broadcast-targets.ts';

// ISSUE #86 — which ids a broadcast actually addresses.
//
// These are the SERVER-side rules. The CLI-side report shape is gated by
// `src/cli/broadcast-message.test.ts` against the built bundle; this file pins
// the resolution those reports are built from, which lives on the shared side
// precisely so it is reachable without Electron.

const WS = (id: string, parentId: string | null, archived = false): BroadcastCandidate => ({
  id,
  parentId,
  archived,
});

test('--children resolves DIRECT children only, never the subtree', () => {
  // parent -> kid1, kid2 ; kid1 -> grandkid. A subtree walk would return 3.
  const all = [
    WS('parent', null),
    WS('kid1', 'parent'),
    WS('kid2', 'parent'),
    WS('grandkid', 'kid1'),
    WS('stranger', 'someone-else'),
  ];
  const got = resolveDirectChildTargets(all, 'parent');
  assert.deepEqual(got, ['kid1', 'kid2']);
  assert.ok(!got.includes('grandkid'), 'a subtree broadcast is a foot-gun; direct-only is the contract');
  assert.ok(!got.includes('stranger'), "another parent's child must never be addressed");
  assert.ok(!got.includes('parent'), 'nobody is their own parent — self can never appear');
});

test('--children excludes archived children', () => {
  // An archived workspace has no agent to receive anything, so including it
  // would manufacture a guaranteed per-target failure and turn every broadcast
  // from a parent with old children into a non-zero exit.
  const all = [WS('kid1', 'parent'), WS('kid2', 'parent', true), WS('kid3', 'parent')];
  assert.deepEqual(resolveDirectChildTargets(all, 'parent'), ['kid1', 'kid3']);
});

test('--children of a parent with no children is EMPTY, so the caller can name it', () => {
  // The empty set must be distinguishable, because the dispatcher turns it into
  // a NAMED refusal rather than a silent success. A halt that reached nobody
  // reporting exit 0 is the failure this ticket exists to eliminate.
  assert.deepEqual(resolveDirectChildTargets([WS('a', null), WS('b', 'other')], 'a'), []);
});

test('a top-level workspace (parentId null/undefined) is not swept up by any parent', () => {
  // Guards the `x?.a === y` shape that has bitten this repo before: if the
  // filter compared undefined to undefined it would match EVERY top-level
  // workspace, and a broadcast would hit the entire fleet.
  const all: BroadcastCandidate[] = [
    { id: 'top1' },
    { id: 'top2', parentId: null },
    WS('kid', 'parent'),
  ];
  assert.deepEqual(resolveDirectChildTargets(all, 'parent'), ['kid']);
  // The dangerous case stated directly: resolving children of an UNDEFINED
  // parent must not return the top-level rows.
  assert.deepEqual(
    resolveDirectChildTargets(all, undefined as unknown as string),
    [],
    'undefined must never match undefined here — that would address the whole fleet',
  );
});

test('--to collapses duplicates, preserving first-seen order', () => {
  // Not cosmetic: each delivery becomes a SEPARATE turn for the target agent,
  // so a duplicate id sends the same halt twice.
  assert.deepEqual(normalizeExplicitTargets(['a', 'b', 'a', 'c', 'b']), ['a', 'b', 'c']);
});

test('--to drops blanks and whitespace-only entries (a trailing comma is a typo)', () => {
  assert.deepEqual(normalizeExplicitTargets(['a', '', '  ', 'b', '\t']), ['a', 'b']);
  assert.deepEqual(normalizeExplicitTargets([' a ', 'a']), ['a'], 'trimming happens before dedup');
});

test('--to with nothing usable is EMPTY, so the caller refuses instead of broadcasting', () => {
  assert.deepEqual(normalizeExplicitTargets(['', '   ']), []);
  assert.deepEqual(normalizeExplicitTargets([]), []);
});

// ---------------------------------------------------------------------------
// ROUTE DISCRIMINATION. `/message` grew two new shapes on the SAME route, so
// the one change in #86 that could break EXISTING callers is mis-routing a
// legacy single-target request. These pin that it cannot happen.
// ---------------------------------------------------------------------------
import { classifyMessageRoute } from './broadcast-targets.ts';

test('a legacy single-target body still routes to the SINGLE path', () => {
  // The whole backward-compatibility promise in one assertion: every already
  // installed CLI and hook sends exactly this shape and must keep receiving the
  // original {ok, delivery, branch} reply.
  assert.deepEqual(classifyMessageRoute({ to: 'ws-1', text: 'hi' }), {
    kind: 'single',
    to: 'ws-1',
  });
});

test('an array `to` routes to BROADCAST, children false', () => {
  assert.deepEqual(classifyMessageRoute({ to: ['a', 'b'], text: 'hi' }), {
    kind: 'broadcast',
    to: ['a', 'b'],
    children: false,
  });
});

test('children:true routes to BROADCAST with no explicit list', () => {
  assert.deepEqual(classifyMessageRoute({ children: true, text: 'hi' }), {
    kind: 'broadcast',
    children: true,
  });
});

test('a string `to` WINS over a stray children flag', () => {
  // Belt and braces: if both arrive, the legacy contract must not be re-routed
  // into a shape the caller cannot parse.
  assert.deepEqual(classifyMessageRoute({ to: 'ws-1', children: true, text: 'hi' }), {
    kind: 'single',
    to: 'ws-1',
  });
});

// F4 (found in review, 2026-08-25). These used to be FILTERED OUT, so a caller
// asking for 3 targets was told "Delivered to 2 target(s)." at RC=0 and never
// learned which one vanished — a silent miss on the one route whose report shape
// exists precisely so nobody is silently missed.
test('a non-string entry in a `to` array is REFUSED, not silently dropped', () => {
  assert.equal(classifyMessageRoute({ to: ['a', 42, 'b'], text: 'hi' }).kind, 'invalid');
  assert.equal(classifyMessageRoute({ to: ['a', null], text: 'hi' }).kind, 'invalid');
  assert.equal(classifyMessageRoute({ to: [{}, 'a'], text: 'hi' }).kind, 'invalid');
  // CONTROL: an all-string array must still be accepted, or "refuse bad input"
  // would be a fix that deletes the feature.
  assert.deepEqual(classifyMessageRoute({ to: ['a', 'b'], text: 'hi' }), {
    kind: 'broadcast',
    to: ['a', 'b'],
    children: false,
  });
});

test('a missing or non-string text is INVALID whatever the target shape', () => {
  // Guards against a broadcast being dispatched with `undefined` interpolated
  // into every target's message body.
  for (const body of [
    { to: 'ws-1' },
    { to: ['a'] },
    { children: true },
    { to: 'ws-1', text: 42 },
  ]) {
    assert.equal(classifyMessageRoute(body).kind, 'invalid', JSON.stringify(body));
  }
});

test('no target of any kind is INVALID', () => {
  assert.equal(classifyMessageRoute({ text: 'hi' }).kind, 'invalid');
  assert.equal(classifyMessageRoute({ text: 'hi', children: false }).kind, 'invalid');
});

// ---------------------------------------------------------------------------
// F3 (found in review, 2026-08-25) — DISPATCH MUST BE CONCURRENT.
//
// Each delivery awaits a bounded turn-start (DELIVERY_START_TIMEOUT_MS = 10s)
// and can then await a wake. Dispatching sequentially makes those bounds ADD
// UP: the 7-target wave-6 halt that motivated #86 would not even ATTEMPT target
// #7 until T+60s. The first cut of this ticket was sequential on the reasoning
// that it is "at worst identical to today's baseline of N sequential sends" —
// true, and beside the point, since the ticket exists BECAUSE N sequential
// sends were "slow exactly when speed matters".
//
// These assert on OVERLAP and on ORDER, which is the only way to tell the two
// implementations apart: a sequential version returns the same rows, in the
// same order, with the same contents. Only the timing differs.
// ---------------------------------------------------------------------------
import { deliverToTargets } from './broadcast-targets.ts';

test('deliveries run CONCURRENTLY, not one after another', async () => {
  let inFlight = 0;
  let maxInFlight = 0;
  const deliver = async (): Promise<{ ok: boolean }> => {
    inFlight++;
    maxInFlight = Math.max(maxInFlight, inFlight);
    await new Promise((r) => setTimeout(r, 20));
    inFlight--;
    return { ok: true };
  };
  await deliverToTargets(['a', 'b', 'c', 'd'], deliver);
  // A sequential loop can never exceed 1 concurrent delivery. This is THE
  // assertion that fails on the pre-review implementation.
  assert.equal(maxInFlight, 4, `expected all 4 in flight at once, peak was ${maxInFlight}`);
});

test('ONE SLOW TARGET DOES NOT DELAY THE OTHERS (the emergency-halt property)', async () => {
  // The aggravating case is the one you broadcast ABOUT: a hung agent is exactly
  // what consumes the full timeout, so under sequential dispatch the targets
  // most likely to stall everyone are the ones the halt is aimed at.
  const finishedAt: Record<string, number> = {};
  const t0 = Date.now();
  await deliverToTargets(['slow', 'fast1', 'fast2'], async (id) => {
    await new Promise((r) => setTimeout(r, id === 'slow' ? 120 : 5));
    finishedAt[id] = Date.now() - t0;
    return { ok: true };
  });
  // Sequentially, 'slow' is first, so both fast targets would finish AFTER
  // ~120ms. Concurrently they finish while it is still hanging.
  assert.ok(
    finishedAt.fast1 < 100 && finishedAt.fast2 < 100,
    `fast targets waited on the slow one: ${JSON.stringify(finishedAt)}`,
  );
});

test('the report is in the CALLER’S order, never completion order', async () => {
  // Deliberately finish in reverse. A report whose row order shifted with timing
  // would be unreadable next to the command that produced it, and would make the
  // output non-deterministic run to run.
  const delays: Record<string, number> = { a: 60, b: 30, c: 5 };
  const got = await deliverToTargets(['a', 'b', 'c'], async (id) => {
    await new Promise((r) => setTimeout(r, delays[id]));
    return { ok: true, delivery: 'live' };
  });
  assert.deepEqual(
    got.map((r) => r.id),
    ['a', 'b', 'c'],
    'rows must follow the order the caller asked for',
  );
});

test('a THROWN delivery becomes that target’s failure row, not a lost broadcast', async () => {
  // `allSettled`, not `all`: one thrown target must not discard the outcomes of
  // the others, or the sender never learns who DID receive the halt.
  const seen: string[] = [];
  const got = await deliverToTargets(
    ['ok1', 'boom', 'ok2'],
    async (id) => {
      if (id === 'boom') throw new Error('kaboom');
      return { ok: true, delivery: 'live' };
    },
    (id) => seen.push(id),
  );
  assert.equal(got.length, 3, 'every target must still have a row');
  assert.deepEqual(got.map((r) => r.ok), [true, false, true]);
  assert.match(got[1].error ?? '', /kaboom/, 'the failure reason must reach the report');
  assert.deepEqual(seen, ['boom'], 'the error hook fires for exactly the thrown target');
});
