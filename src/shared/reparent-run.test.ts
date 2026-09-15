// #142 — the pure re-parent-run decision, tested with explicit must-PASS and
// must-FAIL arms (each names the mutant that reddens it). The effectful
// orchestration (`reconcileRunAfterReparent`, workspaces.ts) cannot load under
// `node --test` (Electron/store seam), so the honest end-to-end arm lives in the
// rig + VERIFY-G's packaged drive; this file pins the DECISION so a change to it
// is caught here, and a source-binding test (reparent-run-binding.test.ts) proves
// the handlers actually call the reconcile.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  decideReparentAction,
  staleRunMarkerBody,
  staleRunRefusalMessage,
  type ReparentCandidate,
} from './reparent-run.ts';

const LIVE = (over: Partial<ReparentCandidate> = {}): ReparentCandidate => ({
  oldAnchorId: 'run-old',
  newAnchorId: 'run-new',
  live: true,
  ...over,
});

// ── G3/G5 core: anchor CHANGED is the necessary condition ────────────────────

test('anchor UNCHANGED → noop, even with a live session (no gratuitous restart)', () => {
  // must-FAIL for a mutant that drops the oldAnchor===newAnchor short-circuit and
  // restarts unconditionally: it would return 'restart' here and interrupt a
  // conversation whose run did not move.
  const a = decideReparentAction(LIVE({ oldAnchorId: 'r', newAnchorId: 'r' }), false);
  assert.deepEqual(a, { kind: 'noop' });
  // …and the no-restart variant is still a noop (nothing to mark stale).
  assert.deepEqual(
    decideReparentAction(LIVE({ oldAnchorId: 'r', newAnchorId: 'r' }), true),
    { kind: 'noop' },
  );
});

test('anchor changed + COLD workspace → notice-only (no restart / no stale marker)', () => {
  // must-FAIL for a mutant that ignores `live` and always restarts: it would try
  // to restart a workspace with no live session (a needless relaunch), or mark a
  // cold workspace stale (a false block on a session that will re-read the env at
  // its next launch anyway).
  assert.deepEqual(decideReparentAction(LIVE({ live: false }), false), { kind: 'notice-only' });
  // noRestart must NOT downgrade a cold workspace to mark-stale — there is no live
  // session holding the old run, so there is nothing to block.
  assert.deepEqual(decideReparentAction(LIVE({ live: false }), true), { kind: 'notice-only' });
});

test('anchor changed + LIVE + restart allowed → restart (G3/G5 default path)', () => {
  // must-FAIL for a mutant that swaps the noRestart branches: it would mark stale
  // when a restart was allowed, leaving a live session on the old run.
  assert.deepEqual(decideReparentAction(LIVE(), false), { kind: 'restart' });
});

test('anchor changed + LIVE + --no-restart → mark-stale (G4 refusal path)', () => {
  // must-FAIL for a mutant that ignores noRestart and always restarts: G4 requires
  // the session to be LEFT on the old run and marked stale, not silently moved.
  assert.deepEqual(decideReparentAction(LIVE(), true), { kind: 'mark-stale' });
});

// ── The marker + refusal wording (G4) ────────────────────────────────────────

test('the stale marker names the NEW run and prescribes restart', () => {
  const body = staleRunMarkerBody('run-new-42');
  assert.match(body, /^stale run:/, 'first line must be the stale-run headline');
  assert.match(body, /new run: run-new-42/, 'must name the run the send WOULD land in');
  assert.match(body, /orchestra restart/, 'must prescribe the conversation-preserving fix');
});

test('the CLI refusal echoes the marker first line + names the fix', () => {
  // The refusal the human sees and the file the guard reads are the SAME string
  // (carry-forward 2: the marker assertion is as specific as the claim).
  const firstLine = staleRunMarkerBody('run-x').split('\n', 1)[0];
  const msg = staleRunRefusalMessage(firstLine);
  assert.match(msg, /^refused:/);
  assert.ok(msg.includes(firstLine.trim()), 'refusal must quote the marker headline');
  assert.match(msg, /orchestra restart/, 'refusal must name the unblock command');
});

test('a marker that MENTIONS "run" without the stale headline still round-trips its first line', () => {
  // carry-forward 2 disproof arm: the refusal is keyed on the first line VERBATIM,
  // not a substring search for "run", so a body whose first line is not the
  // headline cannot silently produce an empty/mismatched refusal.
  const msg = staleRunRefusalMessage('not-the-headline but mentions run');
  assert.ok(msg.includes('not-the-headline but mentions run'));
  assert.doesNotMatch(msg, /^refused:\s*$/m, 'must never emit an empty refusal reason');
});
