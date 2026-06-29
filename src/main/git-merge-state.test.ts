import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { reflogEntryAuthored, getBranchMergeState } from './git.ts';

// reflogEntryAuthored is the pure crux of merged/released detection: given one
// `%H %gs` reflog line it decides whether the branch authored a commit there.
// The bug it fixes: a branch merely *rebased* onto an advanced base (having
// authored nothing) left a `rebase (finish): … onto <sha>` entry whose own sha
// IS that onto target, which used to read as authorship → false MERGED/released
// pills. These cases are taken verbatim from real git reflog output.
test('reflogEntryAuthored: real commit-producing actions count', () => {
  const sha = 'cbe6eae873c264de5a2d502975ea27c416623b50';
  assert.equal(reflogEntryAuthored(sha, 'commit: feat-work'), true);
  assert.equal(reflogEntryAuthored(sha, 'commit (initial): first'), true);
  assert.equal(reflogEntryAuthored(sha, 'commit (amend): reworded'), true);
  assert.equal(reflogEntryAuthored(sha, 'cherry-pick: lifted a fix'), true);
  assert.equal(reflogEntryAuthored(sha, 'am: applied a patch'), true);
});

test('reflogEntryAuthored: branch/reset/checkout bookkeeping does NOT count', () => {
  const sha = '67ad9d841a4556e88b53bd1b0f61dd40fc285598';
  assert.equal(reflogEntryAuthored(sha, 'branch: Created from HEAD'), false);
  assert.equal(reflogEntryAuthored(sha, 'Branch: renamed refs/heads/a to refs/heads/b'), false);
  assert.equal(reflogEntryAuthored(sha, 'reset: moving to HEAD~1'), false);
  assert.equal(reflogEntryAuthored(sha, 'checkout: moving from a to b'), false);
});

test('reflogEntryAuthored: empty branch rebased onto base — boundary lands on its own target → not authored', () => {
  // The reported bug: `rebase (finish)` whose sha equals the `onto` target.
  const base = '4bd04c9cfd9dd88086922a15e01e255d68110463';
  assert.equal(
    reflogEntryAuthored(base, `rebase (finish): refs/heads/feat onto ${base}`),
    false,
  );
  // The `rebase (start): checkout <onto>` boundary lands on the target too.
  assert.equal(reflogEntryAuthored(base, `rebase (start): checkout ${base}`), false);
});

test('reflogEntryAuthored: real rebase that replayed work — tip moved PAST the onto target → authored', () => {
  const newTip = '1f8b31fa9e66ce1e8a20ab0fbeba8850b9e536db';
  const onto = 'd7908a729c1664c3625eee414a44eae7fc365f3f';
  assert.equal(
    reflogEntryAuthored(newTip, `rebase (finish): refs/heads/feat2 onto ${onto}`),
    true,
  );
  // A pick entry (no onto/checkout target) is always replayed work.
  assert.equal(reflogEntryAuthored(newTip, 'rebase (pick): feat-work'), true);
});

test('reflogEntryAuthored: merge/pull fast-forwards are never an authorship signal', () => {
  const sha = '4bd04c9cfd9dd88086922a15e01e255d68110463';
  assert.equal(reflogEntryAuthored(sha, 'merge main: Fast-forward'), false);
  assert.equal(reflogEntryAuthored(sha, 'pull: Fast-forward'), false);
});

// ---- End-to-end against real git repos (network-free) ----

function git(cwd: string, ...args: string[]): string {
  return execFileSync('git', args, {
    cwd,
    encoding: 'utf8',
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: 't',
      GIT_AUTHOR_EMAIL: 't@t',
      GIT_COMMITTER_NAME: 't',
      GIT_COMMITTER_EMAIL: 't@t',
    },
  }).trim();
}

function mkRepo(): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-mergestate-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base1');
  return dir;
}

test('getBranchMergeState: empty branch rebased onto an advanced base is NOT merged', async () => {
  const dir = mkRepo();
  try {
    // Branch off, author nothing, advance base, then rebase the empty branch.
    git(dir, 'checkout', '-q', '-b', 'feat');
    git(dir, 'checkout', '-q', 'main');
    fs.writeFileSync(path.join(dir, 'b.txt'), 'b\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'base2');
    git(dir, 'checkout', '-q', 'feat');
    git(dir, 'rebase', '-q', 'main');

    const state = await getBranchMergeState(dir, 'feat', 'main');
    assert.equal(state.merged, false, 'an empty rebased branch must not read as merged');
    assert.equal(state.diverged, false, 'it has no commits ahead of base');
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('getBranchMergeState: a branch that authored work then fast-forward-merged reads as merged', async () => {
  const dir = mkRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    fs.writeFileSync(path.join(dir, 'c.txt'), 'c\n');
    git(dir, 'add', '.');
    git(dir, 'commit', '-qm', 'feat-work');
    // Fast-forward main up to feat's tip — the classic merge the empty-branch
    // case must stay distinguishable from.
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--ff-only', 'feat');

    const state = await getBranchMergeState(dir, 'feat', 'main');
    assert.equal(state.merged, true, 'a branch whose authored commit landed on base is merged');
    assert.equal(state.diverged, false);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
