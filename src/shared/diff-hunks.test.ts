import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseUnifiedDiff,
  buildPatch,
  hunkStats,
  fileStats,
  fileCheckState,
  allHunkIds,
  countSelected,
  reversePatchFiles,
  type HunkSelection,
} from './diff-hunks.ts';

/** Multi-hunk modification — the workhorse fixture. Three hunks with DIFFERENT
 *  net line deltas (+1, -1, +2) so a subset rebuild that forgets to shift the
 *  new-side offsets produces visibly wrong numbers. */
const MULTI_HUNK = `diff --git a/src/app.ts b/src/app.ts
index 1111111..2222222 100644
--- a/src/app.ts
+++ b/src/app.ts
@@ -10,6 +10,7 @@ function alpha() {
 const a = 1;
 const b = 2;
 const c = 3;
+const added = 4;
 const d = 5;
 const e = 6;
 const f = 7;
@@ -40,7 +41,6 @@ function beta() {
 x();
 y();
-z();
 w();
 v();
 u();
 t();
@@ -80,4 +80,6 @@ function gamma() {
 p();
+q1();
+q2();
 r();
 s();
`;

const selection = (entries: Record<string, string[]>): HunkSelection => {
  const m: HunkSelection = new Map();
  for (const [k, v] of Object.entries(entries)) m.set(k, new Set(v));
  return m;
};

test('parseUnifiedDiff: splits hunks and assigns both-side line numbers', () => {
  const files = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(files.length, 1);
  const f = files[0];
  assert.equal(f.path, 'src/app.ts');
  assert.equal(f.oldPath, 'src/app.ts');
  assert.equal(f.status, 'modified');
  assert.equal(f.hunks.length, 3);

  const [h1, h2, h3] = f.hunks;
  assert.deepEqual(
    [h1.oldStart, h1.oldCount, h1.newStart, h1.newCount],
    [10, 6, 10, 7],
  );
  assert.equal(h1.heading, 'function alpha() {');

  // First hunk: 3 context, then the addition at NEW line 13 with no old line.
  const added = h1.lines.find((l) => l.kind === 'add');
  assert.ok(added);
  assert.equal(added.text, 'const added = 4;');
  assert.equal(added.newLine, 13);
  assert.equal(added.oldLine, null);

  // Old-side numbering must NOT advance across an addition.
  const afterAdd = h1.lines[h1.lines.indexOf(added) + 1];
  assert.equal(afterAdd.kind, 'context');
  assert.equal(afterAdd.oldLine, 13);
  assert.equal(afterAdd.newLine, 14);

  // Deletion in hunk 2 carries an old line and no new line.
  const del = h2.lines.find((l) => l.kind === 'del');
  assert.ok(del);
  assert.equal(del.text, 'z();');
  assert.equal(del.oldLine, 42);
  assert.equal(del.newLine, null);

  assert.deepEqual(hunkStats(h1), { additions: 1, deletions: 0 });
  assert.deepEqual(hunkStats(h2), { additions: 0, deletions: 1 });
  assert.deepEqual(hunkStats(h3), { additions: 2, deletions: 0 });
  assert.deepEqual(fileStats(f), { additions: 3, deletions: 1 });
});

test('buildPatch: full selection round-trips to the original hunk headers', () => {
  const files = parseUnifiedDiff(MULTI_HUNK);
  const f = files[0];
  const patch = buildPatch(files, selection({ 'src/app.ts': [...allHunkIds(f)] }));
  assert.match(patch, /^@@ -10,6 \+10,7 @@ function alpha\(\) \{$/m);
  assert.match(patch, /^@@ -40,7 \+41,6 @@ function beta\(\) \{$/m);
  assert.match(patch, /^@@ -80,4 \+80,6 @@ function gamma\(\) \{$/m);
  // Header metadata is preserved so git can locate/associate the file.
  assert.match(patch, /^diff --git a\/src\/app\.ts b\/src\/app\.ts$/m);
  assert.match(patch, /^--- a\/src\/app\.ts$/m);
  assert.ok(patch.endsWith('\n'));
});

test('buildPatch: SKIPPING an earlier hunk shifts later new-side starts back', () => {
  // This is THE selective-staging invariant. Hunk 1 is +1 line. If we stage only
  // hunks 2 and 3, the index blob does not contain hunk 1's added line, so both
  // later hunks must move UP by 1 on the new side (41→40, 80→79). Old-side
  // offsets are unchanged — the pre-image is HEAD's blob either way.
  const files = parseUnifiedDiff(MULTI_HUNK);
  const f = files[0];
  const ids = f.hunks.map((h) => h.id);
  const patch = buildPatch(files, selection({ 'src/app.ts': [ids[1], ids[2]] }));

  assert.doesNotMatch(patch, /const added = 4;/);
  assert.match(patch, /^@@ -40,7 \+40,6 @@/m, 'hunk 2 new-start shifts 41 → 40');
  assert.match(patch, /^@@ -80,4 \+79,6 @@/m, 'hunk 3 new-start shifts 80 → 79');
});

test('buildPatch: shift accumulates across several skipped hunks', () => {
  // Skip hunks 1 (+1) and 2 (-1): net delta 0, so hunk 3 must stay at 80.
  const files = parseUnifiedDiff(MULTI_HUNK);
  const ids = files[0].hunks.map((h) => h.id);
  const only3 = buildPatch(files, selection({ 'src/app.ts': [ids[2]] }));
  assert.match(only3, /^@@ -80,4 \+80,6 @@/m, '+1 then -1 cancel out');

  // Skip only hunk 2 (-1): hunk 3 shifts DOWN by 1 (80 → 81).
  const skip2 = buildPatch(files, selection({ 'src/app.ts': [ids[0], ids[2]] }));
  assert.match(skip2, /^@@ -10,6 \+10,7 @@/m, 'first selected hunk never shifts');
  assert.match(skip2, /^@@ -80,4 \+81,6 @@/m, 'skipping a deletion shifts later hunks down');
});

test('buildPatch: empty / absent selection yields no patch', () => {
  const files = parseUnifiedDiff(MULTI_HUNK);
  assert.equal(buildPatch(files, selection({})), '');
  assert.equal(buildPatch(files, selection({ 'src/app.ts': [] })), '');
  assert.equal(buildPatch(files, selection({ 'other/file.ts': ['0,0 0,0'] })), '');
  // An id that doesn't match any hunk must not emit a header-only patch —
  // `git apply` errors on a file stanza with no hunks.
  assert.equal(buildPatch(files, selection({ 'src/app.ts': ['bogus'] })), '');
});

test('parse+build: multiple files, selecting hunks in only one of them', () => {
  const two = `${MULTI_HUNK}diff --git a/README.md b/README.md
index 3333333..4444444 100644
--- a/README.md
+++ b/README.md
@@ -1,3 +1,4 @@
 # Title
+A new line.

 Body.
`;
  const files = parseUnifiedDiff(two);
  assert.equal(files.length, 2);
  assert.deepEqual(
    files.map((f) => f.path),
    ['src/app.ts', 'README.md'],
  );
  const readmeIds = [...allHunkIds(files[1])];
  const patch = buildPatch(files, selection({ 'README.md': readmeIds }));
  assert.match(patch, /^diff --git a\/README\.md b\/README\.md$/m);
  assert.doesNotMatch(patch, /src\/app\.ts/, 'unselected file is omitted entirely');
});

test('added file (untracked-then-staged shape): whole content is one hunk', () => {
  const addedFile = `diff --git a/src/new.ts b/src/new.ts
new file mode 100644
index 0000000..5555555
--- /dev/null
+++ b/src/new.ts
@@ -0,0 +1,3 @@
+export const a = 1;
+export const b = 2;
+export const c = 3;
`;
  const files = parseUnifiedDiff(addedFile);
  assert.equal(files[0].status, 'added');
  const h = files[0].hunks[0];
  assert.deepEqual([h.oldStart, h.oldCount, h.newStart, h.newCount], [0, 0, 1, 3]);
  assert.equal(h.lines.length, 3);
  assert.ok(h.lines.every((l) => l.kind === 'add' && l.oldLine === null));

  // Rebuild must preserve the `-0,0` zero-length old side and `/dev/null`.
  const patch = buildPatch(files, selection({ 'src/new.ts': [h.id] }));
  assert.match(patch, /^@@ -0,0 \+1,3 @@$/m);
  assert.match(patch, /^--- \/dev\/null$/m);
  assert.match(patch, /^new file mode 100644$/m);
});

test('deleted file: every line is a deletion and the new side is zero-length', () => {
  const deleted = `diff --git a/gone.txt b/gone.txt
deleted file mode 100644
index 6666666..0000000
--- a/gone.txt
+++ /dev/null
@@ -1,2 +0,0 @@
-line one
-line two
`;
  const files = parseUnifiedDiff(deleted);
  assert.equal(files[0].status, 'deleted');
  const h = files[0].hunks[0];
  assert.deepEqual([h.oldStart, h.oldCount, h.newStart, h.newCount], [1, 2, 0, 0]);
  const patch = buildPatch(files, selection({ 'gone.txt': [h.id] }));
  assert.match(patch, /^@@ -1,2 \+0,0 @@$/m);
  assert.match(patch, /^\+\+\+ \/dev\/null$/m);
});

test('rename with edits: paths differ and rename metadata survives rebuild', () => {
  const renamed = `diff --git a/src/old-name.ts b/src/new-name.ts
similarity index 88%
rename from src/old-name.ts
rename to src/new-name.ts
index 7777777..8888888 100644
--- a/src/old-name.ts
+++ b/src/new-name.ts
@@ -1,4 +1,4 @@
 import x from 'x';
-const v = 1;
+const v = 2;
 export default v;
`;
  const files = parseUnifiedDiff(renamed);
  const f = files[0];
  assert.equal(f.status, 'renamed');
  assert.equal(f.oldPath, 'src/old-name.ts');
  assert.equal(f.path, 'src/new-name.ts');
  // Selection is keyed on the POST-image path (what the UI shows).
  const patch = buildPatch(files, selection({ 'src/new-name.ts': [f.hunks[0].id] }));
  assert.match(patch, /^rename from src\/old-name\.ts$/m);
  assert.match(patch, /^rename to src\/new-name\.ts$/m);
  assert.match(patch, /^similarity index 88%$/m);
});

test('pure rename with no hunks contributes nothing to a patch', () => {
  const pure = `diff --git a/a.txt b/b.txt
similarity index 100%
rename from a.txt
rename to b.txt
`;
  const files = parseUnifiedDiff(pure);
  assert.equal(files[0].status, 'renamed');
  assert.equal(files[0].hunks.length, 0);
  assert.equal(fileCheckState(files[0], selection({ 'b.txt': [] })), 'none');
  assert.equal(buildPatch(files, selection({ 'b.txt': ['anything'] })), '');
});

test('binary file is flagged and yields no hunks', () => {
  const bin = `diff --git a/logo.png b/logo.png
index 9999999..aaaaaaa 100644
Binary files a/logo.png and b/logo.png differ
`;
  const files = parseUnifiedDiff(bin);
  assert.equal(files[0].binary, true);
  assert.equal(files[0].hunks.length, 0);
});

test('no-newline-at-EOF marker is preserved through a rebuild', () => {
  const noEol = `diff --git a/eof.txt b/eof.txt
index bbbbbbb..ccccccc 100644
--- a/eof.txt
+++ b/eof.txt
@@ -1,2 +1,2 @@
 keep
-old last
+new last
\\ No newline at end of file
`;
  const files = parseUnifiedDiff(noEol);
  const h = files[0].hunks[0];
  assert.equal(h.noNewlineAtEof, true);
  // Dropping this marker corrupts the resulting blob (git appends a newline).
  const patch = buildPatch(files, selection({ 'eof.txt': [h.id] }));
  assert.match(patch, /\\ No newline at end of file/);
});

test('paths with spaces and quoted/escaped paths parse to the real filename', () => {
  const spaced = `diff --git a/my dir/my file.txt b/my dir/my file.txt
index ddddddd..eeeeeee 100644
--- a/my dir/my file.txt
+++ b/my dir/my file.txt
@@ -1 +1 @@
-a
+b
`;
  assert.equal(parseUnifiedDiff(spaced)[0].path, 'my dir/my file.txt');

  // Octal-escaped UTF-8 (café.ts) — leaving it quoted would break path matching.
  const quoted = `diff --git "a/src/caf\\303\\251.ts" "b/src/caf\\303\\251.ts"
index fff1111..fff2222 100644
--- "a/src/caf\\303\\251.ts"
+++ "b/src/caf\\303\\251.ts"
@@ -1 +1 @@
-x
+y
`;
  assert.equal(parseUnifiedDiff(quoted)[0].path, 'src/café.ts');
});

test('single-line hunk headers (no count) default to 1', () => {
  const oneLine = `diff --git a/x.txt b/x.txt
index 1234567..7654321 100644
--- a/x.txt
+++ b/x.txt
@@ -5 +5 @@
-before
+after
`;
  const h = parseUnifiedDiff(oneLine)[0].hunks[0];
  assert.deepEqual([h.oldStart, h.oldCount, h.newStart, h.newCount], [5, 1, 5, 1]);
  // Round-trip must re-emit the short form, matching git's own output.
  const patch = buildPatch(parseUnifiedDiff(oneLine), selection({ 'x.txt': [h.id] }));
  assert.match(patch, /^@@ -5 \+5 @@$/m);
});

test('hunk ids are unique within a file and stable across re-parses', () => {
  const a = parseUnifiedDiff(MULTI_HUNK)[0];
  const b = parseUnifiedDiff(MULTI_HUNK)[0];
  assert.deepEqual(
    a.hunks.map((h) => h.id),
    b.hunks.map((h) => h.id),
  );
  assert.equal(new Set(a.hunks.map((h) => h.id)).size, 3);
});

test('fileCheckState / countSelected drive the tri-state checkbox', () => {
  const f = parseUnifiedDiff(MULTI_HUNK)[0];
  const ids = f.hunks.map((h) => h.id);
  assert.equal(fileCheckState(f, selection({})), 'none');
  assert.equal(fileCheckState(f, selection({ 'src/app.ts': [] })), 'none');
  assert.equal(fileCheckState(f, selection({ 'src/app.ts': [ids[0]] })), 'some');
  assert.equal(fileCheckState(f, selection({ 'src/app.ts': ids })), 'all');
  assert.equal(countSelected(selection({ 'src/app.ts': ids, 'b.txt': ['z'] })), 4);
  assert.equal(countSelected(selection({})), 0);
});

test('reversePatchFiles swaps sides so the same subset can be unstaged', () => {
  const files = parseUnifiedDiff(MULTI_HUNK);
  const rev = reversePatchFiles(files);
  const h1 = rev[0].hunks[0];
  assert.deepEqual([h1.oldStart, h1.oldCount, h1.newStart, h1.newCount], [10, 7, 10, 6]);
  // The addition becomes a deletion.
  const wasAdd = h1.lines.find((l) => l.text === 'const added = 4;');
  assert.ok(wasAdd);
  assert.equal(wasAdd.kind, 'del');
  assert.deepEqual(hunkStats(h1), { additions: 0, deletions: 1 });
});

test('empty and malformed input degrade to empty rather than throwing', () => {
  assert.deepEqual(parseUnifiedDiff(''), []);
  assert.deepEqual(parseUnifiedDiff('not a diff at all\njust text\n'), []);
  // A file stanza whose @@ line is malformed keeps the file but drops the hunk,
  // so the pane renders "not selectable" instead of crashing.
  const broken = `diff --git a/x b/x
--- a/x
+++ b/x
@@ garbage @@
 context
`;
  const files = parseUnifiedDiff(broken);
  assert.equal(files.length, 1);
  assert.equal(files[0].hunks.length, 0);
});
