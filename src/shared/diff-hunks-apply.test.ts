/** Ground-truth tests: rebuilt patches are fed to REAL `git apply --cached` in a
 *  throwaway repo, rather than only being compared against my own parser.
 *
 *  The unit tests in diff-hunks.test.ts are self-referential — my parser feeding
 *  my builder — so they cannot catch a patch that is internally consistent but
 *  that git rejects (or, worse, applies to the wrong place). These can.
 *
 *  Two facts measured against real git while writing this, both encoded below:
 *    - hunk LINE COUNTS are strictly validated (`error: corrupt patch`, rc 128)
 *    - new-side START OFFSETS are ignored by `git apply` (it matches on old-side
 *      context), so the offset shift is honesty, not an apply requirement
 *
 *  Skipped automatically if `git` isn't on PATH, so the suite stays runnable in
 *  a bare environment. */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import { mkdtempSync, writeFileSync, rmSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { parseUnifiedDiff, buildPatch, allHunkIds } from './diff-hunks.ts';

function hasGit(): boolean {
  try {
    execFileSync('git', ['--version'], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
}

const GIT_AVAILABLE = hasGit();

/** Run git in `cwd`, returning stdout. Throws with git's stderr on failure. */
function git(cwd: string, args: string[]): string {
  return execFileSync('git', args, { cwd, encoding: 'utf8' });
}

/** Fresh repo with one commit; returns its path. Caller removes it. */
function makeRepo(files: Record<string, string>): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'orchestra-diff-'));
  git(dir, ['init', '-q', '.']);
  git(dir, ['config', 'user.email', 'test@example.com']);
  git(dir, ['config', 'user.name', 'Test']);
  git(dir, ['config', 'commit.gpgsign', 'false']);
  for (const [name, body] of Object.entries(files)) {
    writeFileSync(path.join(dir, name), body);
  }
  git(dir, ['add', '-A']);
  git(dir, ['commit', '-qm', 'base']);
  return dir;
}

/** Apply a patch to the index, returning git's exit code (0 = accepted). */
function applyCached(dir: string, patch: string): number {
  const p = path.join(dir, '.orchestra-test.patch');
  writeFileSync(p, patch);
  try {
    git(dir, ['apply', '--cached', p]);
    return 0;
  } catch (e) {
    return (e as { status?: number }).status ?? 1;
  }
}

const numbered = (n: number) =>
  Array.from({ length: n }, (_, i) => `line ${i + 1}`).join('\n') + '\n';

test(
  'real git accepts a subset patch and stages exactly the selected hunks',
  { skip: !GIT_AVAILABLE && 'git not on PATH' },
  () => {
    const dir = makeRepo({ 'app.txt': numbered(30) });
    try {
      // Three well-separated edits: +1 near the top, -1 in the middle, +2 lower.
      const lines = numbered(30).split('\n').slice(0, 30);
      const edited: string[] = [];
      lines.forEach((l, idx) => {
        const n = idx + 1;
        if (n === 15) return; // deletion
        edited.push(l);
        if (n === 5) edited.push('INSERTED-A');
        if (n === 25) edited.push('INSERTED-B1', 'INSERTED-B2');
      });
      writeFileSync(path.join(dir, 'app.txt'), edited.join('\n') + '\n');

      const raw = git(dir, ['diff', 'HEAD']);
      const files = parseUnifiedDiff(raw);
      assert.equal(files.length, 1);
      const ids = files[0].hunks.map((h) => h.id);
      assert.equal(ids.length, 3, 'git produced three separate hunks');

      // Stage hunks 2 and 3 only — hunk 1's addition must NOT reach the index.
      const patch = buildPatch(files, new Map([['app.txt', new Set([ids[1], ids[2]])]]));
      assert.equal(applyCached(dir, patch), 0, 'git apply --cached accepted the rebuilt patch');

      const staged = git(dir, ['diff', '--cached', '--numstat']).trim();
      assert.equal(staged, '2\t1\tapp.txt', 'exactly 2 additions and 1 deletion staged');

      const stagedBody = git(dir, ['show', ':app.txt']);
      assert.ok(!stagedBody.includes('INSERTED-A'), 'skipped hunk stayed out of the index');
      assert.ok(stagedBody.includes('INSERTED-B1'), 'selected hunk reached the index');
      assert.ok(!stagedBody.includes('line 15'), 'selected deletion reached the index');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'real git preserves a rename, a no-newline-at-EOF, and an added file',
  { skip: !GIT_AVAILABLE && 'git not on PATH' },
  () => {
    const dir = makeRepo({
      'old-name.txt': 'alpha\nbeta\ngamma\n',
      'eof.txt': 'one\ntwo\n',
    });
    try {
      // Reproduce the state the pane actually sees: an UNSTAGED rename. A plain
      // `mv` + intent-to-add gives git both sides to run rename detection on
      // (`R old-name.txt -> new-name.txt` in the worktree column), and the
      // resulting patch is one git can still apply to the index.
      //
      // Deliberately NOT `git mv`: that stages the rename immediately, so by the
      // time the rebuilt patch is applied the index already holds new-name.txt
      // and git fails with "old-name.txt: does not exist in index" — a fixture
      // artifact that says nothing about the patch, which is byte-identical.
      rmSync(path.join(dir, 'old-name.txt'));
      writeFileSync(path.join(dir, 'new-name.txt'), 'alpha\nBETA\ngamma\n');
      git(dir, ['add', '-N', 'new-name.txt']);
      writeFileSync(path.join(dir, 'eof.txt'), 'one\nTWO-nonl'); // no trailing \n
      writeFileSync(path.join(dir, 'untracked.txt'), 'n1\nn2\n');
      git(dir, ['add', '-N', 'untracked.txt']); // intent-to-add → shows in diff

      const raw = git(dir, ['diff', 'HEAD']);
      const files = parseUnifiedDiff(raw);
      const byPath = new Map(files.map((f) => [f.path, f]));

      const eof = byPath.get('eof.txt');
      assert.ok(eof, 'eof.txt present in the diff');
      assert.ok(
        eof.hunks.some((h) => h.noNewlineAtEof),
        'the \\ No newline marker was parsed',
      );

      const added = byPath.get('untracked.txt');
      assert.ok(added);
      assert.equal(added.status, 'added');

      // Apply every file's full selection; each must be accepted by real git.
      for (const f of files) {
        const patch = buildPatch(files, new Map([[f.path, allHunkIds(f)]]));
        if (patch === '') continue; // pure rename with no hunks
        assert.equal(applyCached(dir, patch), 0, `git accepted the patch for ${f.path}`);
      }

      const status = git(dir, ['status', '--porcelain']);
      // The no-newline file must not gain a trailing newline in the index.
      const stagedEof = git(dir, ['show', ':eof.txt']);
      assert.ok(stagedEof.endsWith('TWO-nonl'), 'no spurious trailing newline was added');
      assert.ok(status.includes('untracked.txt'), 'the added file is staged');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);

test(
  'a patch whose hunk counts disagree with its body is rejected by git',
  { skip: !GIT_AVAILABLE && 'git not on PATH' },
  () => {
    // Proves this harness can FAIL — without it, "git accepted my patch" would
    // be indistinguishable from "git accepts anything".
    const dir = makeRepo({ 'app.txt': numbered(10) });
    try {
      writeFileSync(path.join(dir, 'app.txt'), numbered(10).replace('line 5\n', 'line 5\nNEW\n'));
      const raw = git(dir, ['diff', 'HEAD']);
      const good = buildPatch(
        parseUnifiedDiff(raw),
        new Map([['app.txt', allHunkIds(parseUnifiedDiff(raw)[0])]]),
      );
      assert.equal(applyCached(dir, good), 0, 'the honest patch applies');
      git(dir, ['reset', '-q']);

      // Corrupt only the new-side COUNT — git validates this strictly.
      const corrupt = good.replace(/@@ -(\d+),(\d+) \+(\d+),(\d+) @@/, '@@ -$1,$2 +$3,99 @@');
      assert.notEqual(corrupt, good, 'the fixture was actually mutated');
      assert.notEqual(applyCached(dir, corrupt), 0, 'git rejects a wrong line count');
    } finally {
      rmSync(dir, { recursive: true, force: true });
    }
  },
);
