// #587 PR B — `createWorktree(…, { reuse: true })`: a respawn is put ON the ticket's existing branch (real git, scratch repos). The default call is unchanged (control).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createWorktree } from './git.ts';

const git = (cwd: string, ...a: string[]): string => execFileSync('git', a, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
function scratch(t: { after: (fn: () => void) => void }): { root: string; repo: string; origin: string } {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'git-reuse-'));
  t.after(() => fs.rmSync(root, { recursive: true, force: true }));
  const origin = path.join(root, 'origin.git');
  const repo = path.join(root, 'repo');
  git(root, 'init', '-q', '--bare', '-b', 'master', origin);
  git(root, 'init', '-q', '-b', 'master', repo);
  for (const [k, v] of [['user.email', 't@t'], ['user.name', 't']]) git(repo, 'config', k, v);
  fs.writeFileSync(path.join(repo, 'a'), '1');
  git(repo, 'add', '.'); git(repo, 'commit', '-q', '-m', 'init');
  git(repo, 'remote', 'add', 'origin', origin);
  git(repo, 'push', '-q', 'origin', 'master');
  return { root, repo, origin };
}
const commitOn = (wt: string, f: string): string => { fs.writeFileSync(path.join(wt, f), f); git(wt, 'add', '.'); git(wt, 'commit', '-q', '-m', f); return git(wt, 'rev-parse', 'HEAD'); };

test('reuse: the branch still checked out by the dead agent\'s (archived) worktree is reused by name, at its tip; without `reuse` git refuses (control: the default call is unchanged)', async (t) => {
  const { root, repo } = scratch(t);
  const dead = path.join(root, 'dead');
  await createWorktree(repo, 'impl-A', 'master', dead);
  const tip = commitOn(dead, 'work');
  const fresh = path.join(root, 'fresh');
  await assert.rejects(() => createWorktree(repo, 'impl-A', 'master', fresh), /already (checked out|used by worktree)/, 'control: no reuse, no second worktree on the branch');
  await createWorktree(repo, 'impl-A', 'master', fresh, { reuse: true });
  assert.equal(git(fresh, 'rev-parse', '--abbrev-ref', 'HEAD'), 'impl-A', 'same branch NAME');
  assert.equal(git(fresh, 'rev-parse', 'HEAD'), tip, 'at the dead agent\'s tip');
});

test('reuse: a branch that exists only on origin is created from it; a deleted one is created from the base', async (t) => {
  const { root, repo } = scratch(t);
  const wt = path.join(root, 'w1');
  await createWorktree(repo, 'impl-B', 'master', wt);
  const tip = commitOn(wt, 'b');
  git(repo, 'push', '-q', 'origin', 'impl-B');
  fs.rmSync(wt, { recursive: true, force: true });
  git(repo, 'worktree', 'prune');
  git(repo, 'branch', '-D', 'impl-B');
  git(repo, 'fetch', '-q', 'origin');
  const w2 = path.join(root, 'w2');
  await createWorktree(repo, 'impl-B', 'master', w2, { reuse: true });
  assert.equal(git(w2, 'rev-parse', 'HEAD'), tip, 'from origin/impl-B');
  const w3 = path.join(root, 'w3');
  await createWorktree(repo, 'impl-C', 'master', w3, { reuse: true });
  assert.equal(git(w3, 'rev-parse', 'HEAD'), git(repo, 'rev-parse', 'master'), 'a branch that exists nowhere starts from the base');
  assert.equal(git(w3, 'rev-parse', '--abbrev-ref', 'HEAD'), 'impl-C');
});

test('reuse: a worktree directory that is gone but still listed by git (a stale entry) is pruned, the branch reused at its tip', async (t) => {
  const { root, repo } = scratch(t);
  const wt = path.join(root, 'w1');
  await createWorktree(repo, 'impl-D', 'master', wt);
  const tip = commitOn(wt, 'd');
  fs.rmSync(wt, { recursive: true, force: true }); // dir gone, `git worktree list` still holds it
  const w2 = path.join(root, 'w2');
  await createWorktree(repo, 'impl-D', 'master', w2, { reuse: true });
  assert.equal(git(w2, 'rev-parse', 'HEAD'), tip);
});
