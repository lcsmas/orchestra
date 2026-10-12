import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// workspaces.ts / api-handlers.ts can't be imported under `node --test`
// (Electron host), so the WIRING to the pure resolver is asserted on source
// text; the rules themselves are tested in src/shared/effort-defaults.test.ts.
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(root, p), 'utf8');
const workspaces = read('src/main/workspaces.ts');
const handlers = read('src/main/api-handlers.ts');

test('CONTROL: sources are the real files', () => {
  assert.match(workspaces, /export async function createWorkspace\(/);
  assert.match(handlers, /setModelDefaults: async/);
});

test('createWorkspace freezes an explicit spawn --effort, else the default of its kind, onto sdkEffort', () => {
  assert.match(
    workspaces,
    /const newEffort = input\.effort \?\? effortForNewWorkspace\(store\.getEffortDefaults\(\), defaultKind\)/,
  );
  assert.match(workspaces, /\.\.\.\(newEffort \? \{ sdkEffort: newEffort \} : \{\}\)/);
});

test('the SDK session start passes the workspace effort (the agent-PTY launcher that also did is gone, #233)', () => {
  assert.match(read('src/main/agent-sdk.ts'), /\.\.\.\(ws\.sdkEffort \? \{ effort: ws\.sdkEffort \} : \{\}\)/);
  assert.doesNotMatch(workspaces, /claudeArgs/, 'no launcher builds a `claude` argv in workspaces.ts any more');
});

test('the setter normalizes the MERGED value, so a one-kind patch keeps the other kind', () => {
  assert.match(
    handlers,
    /normalizeEffortDefaults\(\{ \.\.\.store\.getEffortDefaults\(\), \.\.\.next \}\)/,
  );
});

test('orchestra spawn --effort reaches createWorkspace (route → dispatch → input)', () => {
  assert.match(read('src/main/hooks-server.ts'), /effort: typeof msg\.effort === 'string' \? msg\.effort : undefined/);
  assert.match(workspaces, /const effort = input\.effort\?\.trim\(\) \? parseEffortArg\(input\.effort\) : undefined;/);
  assert.match(workspaces, /\.\.\.\(effort \? \{ effort \} : \{\}\),/);
});
