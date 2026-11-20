// #480: every child-creating path reaches the ONE resolver. Source-read pins (the real dispatch runs in scripts/e2e-spawn-account-inherit.mjs).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const src = (p: string): string => fs.readFileSync(path.join(root, p), 'utf8');

test('createWorkspace decides the pin through resolveChildAccount, before the worktree exists', () => {
  const s = src('src/main/workspaces.ts');
  const fn = s.slice(s.indexOf('export async function createWorkspace('), s.indexOf('export function createScratchWorkspace'));
  assert.match(fn, /resolveChildAccount\(\{[\s\S]*explicit: input\.account[\s\S]*callerAccountId:[\s\S]*input\.accountFrom[\s\S]*repoAccountId: repo\?\.accountId/);
  assert.ok(fn.indexOf('resolveChildAccount(') < fn.indexOf('await createWorktree('), 'the resolver (and its refusal) runs before git is touched');
  assert.doesNotMatch(fn, /store\.repos\.find\([^)]*\)\??\.accountId/, 'no second, repo-only pin read');
});

test('the spawn route forwards the caller + --account; hooks /spawn forwards msg.account; the fork inherits its source', () => {
  assert.match(src('src/main/workspaces.ts'), /accountFrom: input\.from/);
  assert.match(src('src/main/workspaces.ts'), /account: input\.account/);
  assert.match(src('src/main/hooks-server.ts'), /account: typeof msg\.account === 'string' \? msg\.account : undefined/);
  assert.match(src('src/main/agent-sdk.ts'), /accountFrom: ws\.id/);
  assert.match(src('src/cli/index.ts'), /body\.account = account/);
});

test('a first turn that fails on the login appends the fix hint (loginFailureHint, host side)', () => {
  assert.match(src('src/main/workspaces.ts'), /loginFailureHint\(\{ reason: turn\.reason, workspaceId: id, accountId: ws\.accountId/);
});

test('grep gate: one resolver, one call site (clean on the tree; its self-test has a failing arm)', async () => {
  // @ts-expect-error — plain .mjs script, no types
  const gate = await import('../../scripts/check-spawn-account-single-resolver.mjs');
  assert.deepEqual(gate.check(root), []);
  const st = gate.selfTest();
  assert.equal(st.ok, true);
  assert.ok(st.secondCaller > 0 && st.repoPin > 0, 'the gate can say DIRTY');
});
