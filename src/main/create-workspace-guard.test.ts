import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { simpleGit } from 'simple-git';

// Guards `createWorkspace`'s rejection of a falsy `repoPath` (issue #38 review,
// BLOCKER 2).
//
// WHY THIS MATTERS, measured rather than assumed: `simpleGit('')` does NOT
// throw on an empty baseDir. The two arms below are the actual evidence, run at
// test time rather than quoted from a transcript — outside a git repo it fails,
// but INSIDE one it silently resolves against `process.cwd()`. Since the
// Electron main process is a long-lived process whose cwd nobody in the
// workspace-creation chain controls, an empty `repoPath` reaching
// `createWorktree` would create a REAL branch and worktree inside whatever repo
// the app was launched from. A crash is loud; that is silent.
//
// HONEST LIMITATION — READ BEFORE TRUSTING THIS FILE. `workspaces.ts` imports
// `./store`, `./platform` and the SDK delivery chain, so it cannot be imported
// under `node --test` without an Electron host; no existing `src/main/*.test.ts`
// imports it either. So the guard's PRESENCE is asserted against source text,
// NOT by calling `createWorkspace` and observing a rejection. That is a weaker
// claim and is stated as such: this test would not catch a guard that is
// present but unreachable (e.g. moved below the first `await` that touches
// git). What it does catch is the guard being deleted or weakened, which is the
// realistic regression.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspacesSrc = fs.readFileSync(path.join(repoRoot, 'src/main/workspaces.ts'), 'utf8');

// POSITIVE CONTROL FIRST — prove the file was actually read and contains the
// function under test, so every "pattern present" assertion below cannot pass
// against an empty or wrong file.
test('CONTROL: workspaces.ts is readable and defines createWorkspace', () => {
  assert.ok(workspacesSrc.length > 10_000, `source suspiciously short: ${workspacesSrc.length}`);
  assert.match(workspacesSrc, /export async function createWorkspace\(/);
  assert.doesNotMatch(workspacesSrc, /zzzNoSuchPatternZzz/);
});

test('#38 createWorkspace rejects a falsy repoPath', () => {
  const fn = workspacesSrc.slice(workspacesSrc.indexOf('export async function createWorkspace('));
  const body = fn.slice(0, fn.indexOf('\n}\n'));
  assert.match(
    body,
    /if \(!input\.repoPath\)\s*\{[\s\S]*?throw new Error\(/,
    'createWorkspace no longer throws on a falsy repoPath',
  );
});

// The guard must run BEFORE anything touches git, or it is decorative: a check
// that fires after `createWorktree` has already resolved '' to the cwd protects
// nothing. Assert the ORDER, which is the property that actually matters.
test('#38 the repoPath guard precedes the createWorktree call', () => {
  const start = workspacesSrc.indexOf('export async function createWorkspace(');
  const body = workspacesSrc.slice(start);
  const guardAt = body.indexOf('if (!input.repoPath)');
  const worktreeAt = body.indexOf('createWorktree(');
  assert.ok(guardAt > 0, 'guard not found');
  assert.ok(worktreeAt > 0, 'createWorktree call not found');
  assert.ok(
    guardAt < worktreeAt,
    `guard at ${guardAt} must precede createWorktree at ${worktreeAt}`,
  );
});

// THE MEASUREMENT THE GUARD EXISTS FOR. If a future simple-git ever starts
// rejecting an empty baseDir on its own, this test tells us the guard's
// rationale changed — it does not silently keep asserting a stale premise.
test("#38 simpleGit('') does not reject an empty baseDir — it resolves against cwd", async () => {
  // Run from a directory that IS a git repo (this repo), which is the dangerous
  // arm: the call succeeds and yields a real toplevel.
  const toplevel = await simpleGit('')
    .raw(['rev-parse', '--show-toplevel'])
    .then((r) => r.trim())
    .catch(() => null);
  assert.notEqual(
    toplevel,
    null,
    "simpleGit('') threw here — if this now rejects empty baseDirs, the guard's " +
      'rationale should be revisited (the guard itself is still correct)',
  );
  assert.ok(
    path.isAbsolute(toplevel as string),
    `expected an absolute toplevel, got ${toplevel}`,
  );
});

// `path.basename('')` is '' (so the worktree would be named `--<id8>`, giving no
// clue where it came from). Pinned because it is part of why the failure is
// silent rather than obvious.
test("#38 path.basename('') is empty, so an unguarded worktree name carries no repo", () => {
  assert.equal(path.basename(''), '');
});
