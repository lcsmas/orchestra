// #128 — the PURE fencing decision, tested directly (ledger #131).
//
// bus-fencing.ts holds ONE predicate — decideFence — that turns (presented
// generation, current generation, switch state) into 'pass' | 'count' | 'reject'.
// It is pure (no SQLite, no Electron), so its edge cases are pinned where they
// live and a change to it reddens a test named for it.
//
// Each arm names the property it certifies. The must-FAIL discriminators (the
// mutation each would catch) are stated so a green here is not decoration.

import test from 'node:test';
import assert from 'node:assert/strict';
import { decideFence, isCoordinatorHandle, type FenceInput } from './bus-fencing.ts';

// `writerIsCoordinator` defaults TRUE: the pre-#222 arms below are all about the coordinator.
const at = (
  presented: number | null | undefined,
  current: number,
  fencingOn: boolean,
  writerIsCoordinator = true,
): FenceInput => ({ presented, current, fencingOn, writerIsCoordinator });

// ─── the coexistence axis: no generation presented → never fenced ────────────

test('a caller that presents NO generation is never fenced, in EITHER switch state', () => {
  // The v1 unfenced channel (every existing caller) must keep working — that is
  // coexistence. Disproof: a build that fences the null path would break every
  // `orchestra send` that does not pass --generation.
  assert.equal(decideFence(at(null, 5, true)), 'pass', 'null + switch ON');
  assert.equal(decideFence(at(null, 5, false)), 'pass', 'null + switch OFF');
  assert.equal(decideFence(at(undefined, 5, true)), 'pass', 'undefined + switch ON');
  assert.equal(decideFence(at(undefined, 5, false)), 'pass');
});

// ─── the staleness axis ───────────────────────────────────────────────────────

test('a generation AT OR ABOVE current always passes (equal = the live coordinator)', () => {
  // Equal is the live coordinator itself; above is impossible without a bump it
  // performed. Disproof: a `>` mutant would fence the live coordinator's own
  // writes (presented === current), i.e. everyone.
  assert.equal(decideFence(at(3, 3, true)), 'pass', 'equal, switch ON');
  assert.equal(decideFence(at(3, 3, false)), 'pass', 'equal, switch OFF');
  assert.equal(decideFence(at(4, 3, true)), 'pass', 'above, switch ON');
  assert.equal(decideFence(at(4, 3, false)), 'pass');
});

test('a STALE generation is REJECTED when the switch is ON (FIRED)', () => {
  // Disproof: a mutant that always returns 'pass'/'count' would let a superseded
  // coordinator keep writing with fencing ON — the exact split #128 prevents.
  assert.equal(decideFence(at(2, 3, true)), 'reject', 'below, switch ON → reject');
  assert.equal(decideFence(at(0, 1, true)), 'reject', 'the first bump (0 → 1) fences a gen-0 writer');
});

test('a STALE generation is COUNTED, not rejected, when the switch is OFF (coexistence)', () => {
  // The whole point of shadow mode: the OFF state is OBSERVABLE (a count) yet the
  // old channel stays authoritative (no rejection). Disproof: a mutant ignoring
  // `fencingOn` would either reject while OFF (breaks coexistence) or return
  // 'pass' while OFF (the count never records — the switch-off state is invisible).
  assert.equal(decideFence(at(2, 3, false)), 'count', 'below, switch OFF → count');
  assert.equal(decideFence(at(0, 1, false)), 'count');
});

// ─── the boundary the migration backfills ────────────────────────────────────

test('an un-bumped run (current 0) fences nobody — a gen-0 caller is not < 0', () => {
  // Every pre-#128 run reads generation 0 (the migration DEFAULT). A caller at 0
  // is equal, not below, so it passes; a caller below 0 cannot exist. Disproof: a
  // `<=` mutant would fence the very first coordinator of a fresh run.
  assert.equal(decideFence(at(0, 0, true)), 'pass', 'gen-0 caller on an un-bumped run');
  assert.equal(decideFence(at(0, 0, false)), 'pass');
});

// ─── #222: the writer axis — only the COORDINATOR is ever fenced ─────────────

test('#222 — a NON-coordinator writer is never fenced, stale or not, in EITHER switch state', () => {
  // A member's env generation is stale after every coordinator restart. Disproof:
  // a build that ignores `writerIsCoordinator` rejects (ON) / counts (OFF) here —
  // the field lock-out (reviewer-t11's ack + send refused, rc=1).
  assert.equal(decideFence(at(1, 2, true, false)), 'pass', 'stale member, switch ON');
  assert.equal(decideFence(at(0, 5, true, false)), 'pass', 'far-stale member, switch ON');
  assert.equal(decideFence(at(1, 2, false, false)), 'pass', 'stale member, switch OFF (no shadow event either)');
  // Control (must-FAIL twin): the SAME numbers from the coordinator are fenced.
  assert.equal(decideFence(at(1, 2, true, true)), 'reject');
  assert.equal(decideFence(at(1, 2, false, true)), 'count');
});

test('#222 F1 — isCoordinatorHandle is case-folded + trimmed; a null coordinator (no run row) matches nobody', () => {
  // Disproof: an exact `===` lets `--as <UPPERCASE coordinator id>` (a zombie) escape the fence.
  assert.equal(isCoordinatorHandle('ab-12', 'ab-12'), true);
  assert.equal(isCoordinatorHandle('ab-12', 'AB-12'), true, 'UPPERCASE handle is still the coordinator');
  assert.equal(isCoordinatorHandle('ab-12', '  ab-12 '), true, 'trimmed');
  assert.equal(isCoordinatorHandle('ab-12', 'ab-13'), false, 'a different handle is a member');
  assert.equal(isCoordinatorHandle('ab-12', ''), false);
  assert.equal(isCoordinatorHandle(null, 'ab-12'), false, 'unknown run: no coordinator');
});
