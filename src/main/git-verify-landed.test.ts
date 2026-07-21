import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { listUnmergedCommits } from './git.ts';

// listUnmergedCommits backs `orchestra verify-landed`, the coordinator
// close-out check. The failure mode it exists to catch: a child agent reports
// "merged", then keeps committing (review feedback lands late), and the late
// commits strand with no loud failure anywhere. So the tests cover the landed
// case, the never-merged case, and — the originating bug — the merged-then-
// committed-again case, plus the ref-validation errors that keep a deleted or
// renamed branch from reading as a false "0 unmerged".

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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orch-verifylanded-'));
  git(dir, 'init', '-q', '-b', 'main');
  fs.writeFileSync(path.join(dir, 'a.txt'), 'a\n');
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', 'base1');
  return dir;
}

function commit(dir: string, file: string, message: string): void {
  fs.writeFileSync(path.join(dir, file), `${message}\n`);
  git(dir, 'add', '.');
  git(dir, 'commit', '-qm', message);
}

test('listUnmergedCommits: a fully merged branch reports 0 unmerged', async () => {
  const dir = mkRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'b.txt', 'feat-work');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge feat');

    assert.deepEqual(await listUnmergedCommits(dir, 'main', 'feat'), []);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listUnmergedCommits: an unmerged branch lists its commits newest first', async () => {
  const dir = mkRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'b.txt', 'first');
    commit(dir, 'c.txt', 'second');

    const out = await listUnmergedCommits(dir, 'main', 'feat');
    assert.equal(out.length, 2);
    assert.match(out[0], /^[0-9a-f]{7,} second$/);
    assert.match(out[1], /^[0-9a-f]{7,} first$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listUnmergedCommits: a commit made AFTER the merge surfaces as unmerged (the decay case)', async () => {
  const dir = mkRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    commit(dir, 'b.txt', 'feat-work');
    git(dir, 'checkout', '-q', 'main');
    git(dir, 'merge', '-q', '--no-ff', 'feat', '-m', 'merge feat');
    // The child "reported done" here — then review feedback produced one more
    // commit that nobody re-merged. An ancestry check on the OLD tip passes;
    // only checking the current tip catches it.
    git(dir, 'checkout', '-q', 'feat');
    commit(dir, 'd.txt', 'late-review-fix');

    const out = await listUnmergedCommits(dir, 'main', 'feat');
    assert.equal(out.length, 1, 'the post-merge commit must surface');
    assert.match(out[0], /late-review-fix$/);
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listUnmergedCommits: missing target ref fails loudly, not as 0 unmerged', async () => {
  const dir = mkRepo();
  try {
    git(dir, 'checkout', '-q', '-b', 'feat');
    await assert.rejects(
      listUnmergedCommits(dir, 'no-such-branch', 'feat'),
      /target ref not found in repo: no-such-branch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});

test('listUnmergedCommits: missing branch fails loudly, not as 0 unmerged', async () => {
  const dir = mkRepo();
  try {
    await assert.rejects(
      listUnmergedCommits(dir, 'main', 'deleted-branch'),
      /branch not found in repo: deleted-branch/,
    );
  } finally {
    fs.rmSync(dir, { recursive: true, force: true });
  }
});
