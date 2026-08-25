import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  matchesDropTarget,
  dropTargetClass,
  nextDropTarget,
  type DropTarget,
} from './dnd-drop-target.ts';

// These tests bind to the REAL implementation the four Sidebar DnD sites call.
// That is the whole point of the module existing: the previous regression gate
// for #38 reconstructed the buggy expression INLINE AS LITERALS, which made it
// a constant — it emitted the identical pass on the fixed build, the unfixed
// build, and a build with Sidebar.tsx deleted. Reverting only the render-site
// guard left that gate fully green (measured by the #38 reviewer). Importing
// the function under test is what makes these assertions falsifiable.

const NO_DRAG: DropTarget<string> = null;
const OVER_A: DropTarget<string> = { key: '/repo/a', pos: 'before' };

// ─── matchesDropTarget ───────────────────────────────────────────────────────

// THE #38 REGRESSION, at the decision point itself. `undefined` is the value a
// malformed store record yields for `repoPath`, and it is the ONE value an
// optional-chain guard (`target?.key === key`) compares equal to when the
// target is null. If this returns true, the caller's ternary takes the arm that
// dereferences null and throws
// `TypeError: Cannot read properties of null (reading 'pos')`.
test('#38 matchesDropTarget: a null target NEVER matches an undefined key', () => {
  assert.equal(matchesDropTarget(NO_DRAG, undefined), false);
});

test('#38 matchesDropTarget: a null target never matches any key', () => {
  assert.equal(matchesDropTarget(NO_DRAG, '/repo/a'), false);
  assert.equal(matchesDropTarget(NO_DRAG, ''), false);
});

// An `undefined` key must not match even when a drag IS in progress. Without
// this the function would be crash-free but would report a spurious HIT, which
// is the same wrong answer the crash was hiding — a malformed row would light
// up as the drop target.
test('#38 matchesDropTarget: an undefined key never matches a LIVE target', () => {
  assert.equal(matchesDropTarget(OVER_A, undefined), false);
});

// THE CASE THAT ACTUALLY EXERCISES THE `key === undefined` CLAUSE.
//
// Written after a mutant survived: deleting `if (key === undefined) return
// false` left every other test in this file green, because with a well-formed
// target `target.key` is a real string and `'/repo/a' === undefined` is already
// false — the clause was never reached. The clause is only load-bearing when
// the TARGET'S OWN key is `undefined`, which `nextDropTarget(prev, undefined,
// pos)` produces when a drag passes over a malformed row.
//
// Without the guard this returns TRUE, and the caller's ternary then treats a
// row with no identity as the drop target: `dropTargetClass` emits a
// `repo-drop-*` class for it and `commitRepoDrop` would look up `indexOf(undefined)`.
// That is a spurious match, not a crash — the quiet half of the #38 bug class.
test('#38 matchesDropTarget: an undefined-keyed TARGET does not match an undefined key', () => {
  const malformed = { key: undefined, pos: 'before' } as unknown as DropTarget<string>;
  assert.equal(
    matchesDropTarget(malformed, undefined),
    false,
    'undefined === undefined matched — the key-undefined guard is gone',
  );
});

test('#38 dropTargetClass: an undefined-keyed target emits no class', () => {
  const malformed = { key: undefined, pos: 'before' } as unknown as DropTarget<string>;
  assert.equal(dropTargetClass(malformed, undefined, 'repo-drop'), '');
});

test('matchesDropTarget: matches the key it is over', () => {
  assert.equal(matchesDropTarget(OVER_A, '/repo/a'), true);
});

test('matchesDropTarget: does not match a different key', () => {
  assert.equal(matchesDropTarget(OVER_A, '/repo/b'), false);
});

// The empty string is a REAL key in this codebase — `groupRootsByRepo` files
// repo-less records under `''` — so it must behave like any other key rather
// than being swallowed by a falsy check.
test("matchesDropTarget: '' is a real key, not a falsy sentinel", () => {
  assert.equal(matchesDropTarget({ key: '', pos: 'after' }, ''), true);
  assert.equal(matchesDropTarget({ key: '', pos: 'after' }, '/repo/a'), false);
  assert.equal(matchesDropTarget(OVER_A, ''), false);
});

// ─── dropTargetClass ─────────────────────────────────────────────────────────

// The exact shape that crashed, now exercised through the real function.
test('#38 dropTargetClass: returns empty string for a null target + undefined key', () => {
  assert.doesNotThrow(() => dropTargetClass(NO_DRAG, undefined, 'repo-drop'));
  assert.equal(dropTargetClass(NO_DRAG, undefined, 'repo-drop'), '');
});

test('#38 dropTargetClass: never throws across the whole null/undefined matrix', () => {
  for (const target of [null, OVER_A] as DropTarget<string>[]) {
    for (const key of [undefined, '', '/repo/a', '/repo/b']) {
      assert.doesNotThrow(
        () => dropTargetClass(target, key, 'repo-drop'),
        `threw for target=${JSON.stringify(target)} key=${JSON.stringify(key)}`,
      );
    }
  }
});

test('dropTargetClass: emits the positional modifier when it matches', () => {
  assert.equal(dropTargetClass(OVER_A, '/repo/a', 'repo-drop'), ' repo-drop-before');
  assert.equal(dropTargetClass({ key: 'w1', pos: 'after' }, 'w1', 'drop'), ' drop-after');
});

test('dropTargetClass: emits nothing for a non-matching key', () => {
  assert.equal(dropTargetClass(OVER_A, '/repo/b', 'repo-drop'), '');
});

// ─── nextDropTarget ──────────────────────────────────────────────────────────

// The two `onDragOver` updaters. These were the sites left UNGUARDED by the
// first attempt at this fix, and the reviewer measured both throwing the exact
// #38 string with `prev = null, key = undefined`.
test('#38 nextDropTarget: null prev + undefined key does not throw', () => {
  assert.doesNotThrow(() =>
    nextDropTarget(null as DropTarget<string>, undefined as unknown as string, 'before'),
  );
});

test('nextDropTarget: from no drag, produces a fresh target', () => {
  assert.deepEqual(nextDropTarget(NO_DRAG, '/repo/a', 'before'), {
    key: '/repo/a',
    pos: 'before',
  });
});

// Identity preservation is the performance contract: `dragover` fires
// continuously, and returning a new object each time would re-render the whole
// sidebar on every pointer move. Assert REFERENCE equality, not deep equality —
// deep equality would pass even if the optimisation were lost.
test('nextDropTarget: returns the SAME object when nothing changed', () => {
  const prev: DropTarget<string> = { key: '/repo/a', pos: 'before' };
  assert.equal(nextDropTarget(prev, '/repo/a', 'before'), prev);
});

test('nextDropTarget: returns a NEW object when the position flips', () => {
  const prev: DropTarget<string> = { key: '/repo/a', pos: 'before' };
  const next = nextDropTarget(prev, '/repo/a', 'after');
  assert.notEqual(next, prev);
  assert.deepEqual(next, { key: '/repo/a', pos: 'after' });
});

test('nextDropTarget: returns a NEW object when the key changes', () => {
  const prev: DropTarget<string> = { key: '/repo/a', pos: 'before' };
  const next = nextDropTarget(prev, '/repo/b', 'before');
  assert.notEqual(next, prev);
  assert.deepEqual(next, { key: '/repo/b', pos: 'before' });
});
