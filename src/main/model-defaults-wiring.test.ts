import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// workspaces.ts / agent-sdk.ts can't be imported under `node --test` (Electron
// host), so the WIRING to the pure resolvers is asserted on source text. The
// resolution rules themselves are tested behaviourally in
// src/shared/model-defaults.test.ts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const workspaces = read('src/main/workspaces.ts');
const sdk = read('src/main/agent-sdk.ts');

test('CONTROL: sources are the real files', () => {
  assert.match(workspaces, /export async function createWorkspace\(/);
  assert.match(sdk, /export function sdkDefaultModel\(/);
});

test('no hardcoded default model remains', () => {
  for (const src of [workspaces, sdk]) {
    assert.doesNotMatch(src, /DEFAULT_CHILD_MODEL/);
    assert.doesNotMatch(src, /Spawn every child on Opus/);
  }
});

test('createWorkspace freezes the default of its kind onto the record', () => {
  assert.match(
    workspaces,
    /model: modelForNewWorkspace\(input\.model, store\.getModelDefaults\(\), defaultKind\)/,
  );
});

test('both launch paths go through resolveLaunchModel', () => {
  assert.match(workspaces, /resolveLaunchModel\(ws\.model, store\.getModelDefaults\(\)\)/);
  assert.match(sdk, /model: resolveLaunchModel\(ws\.model, store\.getModelDefaults\(\)\)/);
  assert.doesNotMatch(workspaces, /if \(ws\.model\) claudeArgs\.push/);
});

test('every dispatchSpawnRequest caller names its default kind', () => {
  // `defaultKind` is a required field, so tsc enforces presence; this pins
  // WHICH kind: agent spawns → spawned, the UI ticket click → workspace.
  assert.match(read('src/main/hooks-server.ts'), /defaultKind: 'spawned'/);
  assert.match(read('src/main/transport/sandbox-manager.ts'), /defaultKind: 'spawned'/);
  assert.match(read('src/main/linear-tickets.ts'), /defaultKind: from \? 'spawned' : 'workspace'/);
});
