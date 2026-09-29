import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { isWorkspaceRemoved, noteWorkspacesRemoved } from './removed-workspaces.ts';

// #205 renderer half: the `workspace:update` handler UPSERTS unknown ids, so a stale update that
// follows `workspace:removed` would paint a ghost row until reload. store.ts needs `window.orchestra`
// at module scope, so the real store runs in scripts/verify-removed-ghost.mjs (esbuild + stub bridge).

test('a noted id is reported removed; an unnoted id is not', () => {
  assert.equal(isWorkspaceRemoved('ghost-1'), false, 'control: unknown id is live');
  noteWorkspacesRemoved(['ghost-1', 'ghost-2']);
  assert.equal(isWorkspaceRemoved('ghost-1'), true);
  assert.equal(isWorkspaceRemoved('ghost-2'), true);
  assert.equal(isWorkspaceRemoved('live-1'), false, 'a different id is unaffected');
});

test('wiring: the update handler drops removed ids; both removal handlers record them', () => {
  const src = fs
    .readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'store.ts'), 'utf8')
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/^\s*\/\/.*$/gm, '');
  const block = (start: string): string => {
    const i = src.indexOf(start);
    assert.ok(i >= 0, `control: ${start} present`);
    return src.slice(i, i + 400);
  };
  assert.match(block('window.orchestra.onWorkspaceUpdate('), /if \(isWorkspaceRemoved\(w\.id\)\) return;/);
  assert.match(block('window.orchestra.onWorkspaceRemoved('), /noteWorkspacesRemoved\(\[id\]\)/);
  assert.match(block('window.orchestra.onWorkspacesRemoved('), /noteWorkspacesRemoved\(ids\)/);
});

test('★ the REAL renderer store: a stale workspace:update after workspace(s):removed does not re-add the row', () => {
  const repo = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
  const out = execFileSync(process.execPath, [path.join(repo, 'scripts', 'verify-removed-ghost.mjs')], {
    encoding: 'utf8', timeout: 120_000, cwd: repo, stdio: ['ignore', 'pipe', 'ignore'],
  });
  const line = out.trim().split('\n').filter(Boolean).pop();
  assert.ok(line, 'the probe produced no output — it did not run');
  const r = JSON.parse(line) as { wired: boolean; before: string[]; afterRemoved: string[]; afterStale: string[]; cName: string; ok: boolean };
  assert.equal(r.wired, true, 'control: the three push handlers registered');
  assert.deepEqual(r.before, ['A', 'B', 'C'], 'control: updates insert unknown ids');
  assert.deepEqual(r.afterRemoved, ['C'], 'control: single + bulk removal dropped A and B');
  assert.deepEqual(r.afterStale, ['C', 'D'], 'stale A/B updates dropped; a live id and a new id still land');
  assert.equal(r.cName, 'live-update');
  assert.equal(r.ok, true);
});
