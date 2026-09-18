// #156 REVIEW-156 gate 4 (MED) — the WIRING test for the live-child predicate.
//
// The must-FAIL arms in bus-runs.test.ts pass `hasLiveChild` as a LITERAL to the
// pure `refreezeMissionRun`, and run-refreeze-args.test.ts stubs the whole
// /runRefreeze route — so NOTHING there drives the real `isRunning ||
// sdkSessionLive` disjunction, and REVIEW-156's HIGH bug (isRunning-only) would
// pass byte-identically through them. This file drives the REAL predicate
// (`anyChildLive`, the exact function workspaces.ts calls at
// dispatchRunRefreezeRequest) with a STRUCTURED (no-PTY) live child and pins the
// split the reviewer required: the STRUCTURED arm reddens the instant the
// `isSdkLive` disjunct is dropped, while the PTY arm stays green.

import test from 'node:test';
import assert from 'node:assert/strict';
import { anyChildLive } from './refreeze-liveness.ts';

// Probes modelling the two real launch surfaces. A STRUCTURED child is live on
// the SDK surface but ABSENT from the PTY `sessions` map — the DEFAULT spawn, and
// the #111 blind spot. A PTY child is the mirror.
function probes(ptyLive: Set<string>, sdkLive: Set<string>) {
  return {
    isPtyRunning: (id: string) => ptyLive.has(id),
    isSdkLive: (id: string) => sdkLive.has(id),
  };
}

test('T156.wiring — a STRUCTURED (no-PTY) live child makes hasLiveChild TRUE (the HIGH bug)', () => {
  const p = probes(new Set<string>(), new Set(['structured-child']));
  // isRunning('structured-child') is FALSE (no PTY) — the isRunning-only gate the
  // reviewer flagged would read hasLiveChild=false here and refreeze WRONGLY.
  assert.equal(p.isPtyRunning('structured-child'), false, 'precondition: PTY-dead');
  assert.equal(p.isSdkLive('structured-child'), true, 'precondition: SDK-live');

  const live = anyChildLive(['structured-child'], p.isPtyRunning, p.isSdkLive);
  assert.equal(live, true, 'a live STRUCTURED child must count as live-mid-turn');

  // MUTATION PROOF (drop the isSdkLive disjunct): the shipped disjunction is the
  // ONLY reason this returns true. A mutant that keeps only the PTY probe returns
  // false — reddening this arm.
  const mutantPtyOnly = ['structured-child'].some((id) => p.isPtyRunning(id));
  assert.equal(
    mutantPtyOnly,
    false,
    'CONTROL: the isRunning-only mutant reads the structured child as NOT live — the HIGH bug',
  );
});

test('T156.wiring — a PTY-only live child stays TRUE (the disjunct drop does NOT touch this arm)', () => {
  const p = probes(new Set(['pty-child']), new Set<string>());
  const live = anyChildLive(['pty-child'], p.isPtyRunning, p.isSdkLive);
  assert.equal(live, true, 'a live PTY child counts as live');
  // The PTY arm survives dropping the SDK disjunct — this is the "others green"
  // half of the split that proves the structured arm tests the SDK wiring, not a
  // neighbour.
  const mutantPtyOnly = ['pty-child'].some((id) => p.isPtyRunning(id));
  assert.equal(mutantPtyOnly, true, 'the PTY arm is GREEN under the isSdkLive-drop mutant');
});

test('T156.wiring — all children idle on BOTH surfaces → FALSE (refreeze allowed)', () => {
  const p = probes(new Set<string>(), new Set<string>());
  assert.equal(
    anyChildLive(['a', 'b', 'c'], p.isPtyRunning, p.isSdkLive),
    false,
    'no child live on either surface ⇒ not live ⇒ refreeze may proceed',
  );
  // And an empty child set (a mission with no children yet) is trivially idle.
  assert.equal(anyChildLive([], p.isPtyRunning, p.isSdkLive), false, 'no children ⇒ not live');
});

test('T156.wiring — TRUE if ANY one of several children is live (either surface)', () => {
  // Three idle, one structured-live buried in the middle: the predicate must not
  // short-circuit past it.
  const p = probes(new Set(['x2']), new Set(['x4']));
  assert.equal(
    anyChildLive(['x0', 'x1', 'x2', 'x3'], p.isPtyRunning, p.isSdkLive),
    true,
    'a single PTY-live child among idle ones is enough',
  );
  assert.equal(
    anyChildLive(['x0', 'x1', 'x3', 'x4'], p.isPtyRunning, p.isSdkLive),
    true,
    'a single SDK-live child among idle ones is enough',
  );
});
