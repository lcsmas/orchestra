/** Regression tests for the Unstage gating defect.
 *
 * THE BUG: the Unstage button was gated on `selectedCount === 0 || busy` —
 * byte-identical to Stage — so selecting an UNSTAGED hunk enabled Unstage,
 * which reverse-applied a patch git had nothing to reverse and surfaced a raw
 * "patch does not apply". Harmless to the index, trivially user-reachable.
 *
 * The root cause was missing DATA, not a missing condition: the uncommitted
 * scope renders `git diff HEAD`, which merges index and working tree into one
 * patch, so the renderer had no way to know which hunks were staged. These
 * tests cover the function that recovers that signal by intersecting the
 * combined diff with `git diff --cached`.
 *
 * Fixtures are REAL git output (see diff-staged-apply.test.ts for the live-git
 * half); the strings below were captured from the repro in a scratch repo with
 * one staged and one unstaged hunk in the same file.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiff,
  stagedHunkIds,
  stagedSelection,
  countSelected,
  type HunkSelection,
} from './diff-hunks.ts';

/** `git diff HEAD` with hunk 1 staged and hunk 2 unstaged — what the pane shows. */
const COMBINED = `diff --git a/app.txt b/app.txt
index 1111111..2222222 100644
--- a/app.txt
+++ b/app.txt
@@ -2,7 +2,7 @@ line 1
 line 2
 line 3
 line 4
-line 5
+line 5 STAGED-EDIT
 line 6
 line 7
 line 8
@@ -12,7 +12,7 @@ line 11
 line 12
 line 13
 line 14
-line 15
+line 15 UNSTAGED-EDIT
 line 16
 line 17
 line 18
`;

/** `git diff --cached` for the same state — ONLY the staged hunk. */
const STAGED = `diff --git a/app.txt b/app.txt
index 1111111..3333333 100644
--- a/app.txt
+++ b/app.txt
@@ -2,7 +2,7 @@ line 1
 line 2
 line 3
 line 4
-line 5
+line 5 STAGED-EDIT
 line 6
 line 7
 line 8
`;

const sel = (entries: Record<string, string[]>): HunkSelection =>
  new Map(Object.entries(entries).map(([k, v]) => [k, new Set(v)]));

test('stagedHunkIds marks only the hunk present in the staged diff', () => {
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(STAGED));
  const ids = combined[0].hunks.map((h) => h.id);
  assert.equal(ids.length, 2);
  const marked = staged.get('app.txt');
  assert.ok(marked, 'app.txt has staged hunks');
  assert.ok(marked.has(ids[0]), 'the staged hunk is marked');
  assert.ok(!marked.has(ids[1]), 'the unstaged hunk is NOT marked');
  assert.equal(countSelected(staged), 1);
});

test('THE DEFECT: selecting only an unstaged hunk yields an EMPTY staged selection', () => {
  // This is the exact repro. Before the fix, Unstage was enabled here and sent
  // a reverse patch git rejected. The button now gates on this being empty.
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(STAGED));
  const unstagedHunkId = combined[0].hunks[1].id;

  const selection = sel({ 'app.txt': [unstagedHunkId] });
  assert.equal(countSelected(selection), 1, 'the user HAS selected something');
  assert.equal(
    countSelected(stagedSelection(selection, staged)),
    0,
    'but nothing selected is staged, so Unstage must be disabled',
  );
});

test('selecting the staged hunk yields a non-empty staged selection', () => {
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(STAGED));
  const stagedHunkId = combined[0].hunks[0].id;
  const got = stagedSelection(sel({ 'app.txt': [stagedHunkId] }), staged);
  assert.equal(countSelected(got), 1);
  assert.ok(got.get('app.txt')?.has(stagedHunkId));
});

test('a mixed selection unstages ONLY the staged part', () => {
  // Selecting both hunks must not send the unstaged one to git apply --reverse.
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(STAGED));
  const ids = combined[0].hunks.map((h) => h.id);
  const got = stagedSelection(sel({ 'app.txt': ids }), staged);
  assert.equal(countSelected(got), 1, 'only the staged hunk survives the intersection');
  assert.ok(got.get('app.txt')?.has(ids[0]));
  assert.ok(!got.get('app.txt')?.has(ids[1]));
});

test('nothing staged at all → every selection intersects to empty', () => {
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff('')); // clean index
  assert.equal(staged.size, 0);
  const ids = combined[0].hunks.map((h) => h.id);
  assert.equal(countSelected(stagedSelection(sel({ 'app.txt': ids }), staged)), 0);
});

test('matching is offset-independent — the same change staged at a different line', () => {
  // The two diffs are computed against different post-images, so a staged hunk
  // legitimately carries different @@ offsets than its counterpart in the
  // combined diff. Header-based matching would MISS it and wrongly disable
  // Unstage on genuinely staged content; content matching must not.
  const shifted = STAGED.replace('@@ -2,7 +2,7 @@ line 1', '@@ -2,7 +9,7 @@ line 1');
  assert.notEqual(shifted, STAGED, 'fixture actually mutated');
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(shifted));
  assert.equal(
    countSelected(staged),
    1,
    'the staged hunk is still recognised despite a different new-side offset',
  );
  assert.ok(staged.get('app.txt')?.has(combined[0].hunks[0].id));
});

test('a same-content hunk in a DIFFERENT file is not cross-matched', () => {
  const otherFile = STAGED.replace(/app\.txt/g, 'other.txt');
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(otherFile));
  assert.equal(countSelected(staged), 0, 'path must participate in the match');
});

test('an empty selection stays empty (button disabled either way)', () => {
  const combined = parseUnifiedDiff(COMBINED);
  const staged = stagedHunkIds(combined, parseUnifiedDiff(STAGED));
  assert.equal(countSelected(stagedSelection(new Map(), staged)), 0);
  assert.equal(countSelected(stagedSelection(sel({ 'app.txt': [] }), staged)), 0);
});
