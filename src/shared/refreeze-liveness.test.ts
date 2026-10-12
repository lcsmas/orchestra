// #156 REVIEW-156 gate 4 — the WIRING test for the live-child predicate (#233: SDK sessions are the only surface).
//
// The must-FAIL arms in bus-runs.test.ts pass `hasLiveChild` as a LITERAL to the pure `refreezeMissionRun`, and
// run-refreeze-args.test.ts stubs the whole /runRefreeze route — so NOTHING there drives the real probe. This file
// drives the REAL predicate (`anyChildLive`, the exact function workspaces.ts calls at dispatchRunRefreezeRequest).

import test from 'node:test';
import assert from 'node:assert/strict';
import { anyChildLive } from './refreeze-liveness.ts';

const probe = (live: Set<string>) => (id: string) => live.has(id);

test('T156.wiring — a live SDK child makes hasLiveChild TRUE', () => {
  assert.equal(anyChildLive(['sdk-child'], probe(new Set(['sdk-child']))), true, 'a live SDK child must count as live-mid-turn');
});

test('T156.wiring — all children idle → FALSE (refreeze allowed); no children → FALSE', () => {
  assert.equal(anyChildLive(['a', 'b', 'c'], probe(new Set<string>())), false, 'no child live ⇒ refreeze may proceed');
  assert.equal(anyChildLive([], probe(new Set(['x']))), false, 'a mission with no children yet is trivially idle');
});

test('T156.wiring — TRUE if ANY one of several children is live (the predicate does not short-circuit past it)', () => {
  assert.equal(anyChildLive(['x0', 'x1', 'x2', 'x3'], probe(new Set(['x2']))), true);
  assert.equal(anyChildLive(['x0', 'x1', 'x3'], probe(new Set(['x2']))), false, 'a live NON-child does not count');
});
