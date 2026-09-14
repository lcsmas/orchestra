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
import { decideFence, type FenceInput } from './bus-fencing.ts';

const at = (
  presented: number | null | undefined,
  current: number,
  fencingOn: boolean,
): FenceInput => ({ presented, current, fencingOn });

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
