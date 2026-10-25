// #401 — SOURCE-LEVEL guard for the spawn-profile seam in modules `node --test` cannot import (workspaces.ts, hooks-server.ts, … load Electron).
// The pure rule is driven for real in shared/spawn-profile.test.ts and the built CLI in cli/spawn-profile.test.ts; the BUILT APP drive is
// scripts/e2e-spawn-profile.mjs. This file pins WHERE the rule is consulted and the paths that must NOT carry a profile (ADR 0010: only the
// human attaches; an agent's spawn can hand on a profile its spawner holds, written on the NEW record only). Each clause has a mutant in
// scripts/spawn-profile-mutants.mjs.
import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const read = (p: string) => fs.readFileSync(path.join(repoRoot, p), 'utf8');
const ws = read('src/main/workspaces.ts');
const hooks = read('src/main/hooks-server.ts');
const sandbox = read('src/main/transport/sandbox-manager.ts');
const linear = read('src/main/linear-tickets.ts');
const mobile = read('src/main/acces-mobile-routes.ts');
const types = read('src/shared/types.ts');

function bodyOf(src: string, decl: string): string {
  const i = src.indexOf(decl);
  assert.notEqual(i, -1, `declaration not found: ${decl}`);
  const j = src.indexOf('\n}\n', i);
  assert.notEqual(j, -1, `end of ${decl} not found`);
  return src.slice(i, j);
}
const dispatch = bodyOf(ws, 'export async function dispatchSpawnRequest(');
const create = bodyOf(ws, 'export async function createWorkspace(');

test('CONTROL: the extractor finds the real bodies', () => {
  assert.match(dispatch, /createWorkspace\(/);
  assert.match(create, /store\.upsertWorkspace\(ws\)/);
});

test('dispatchSpawnRequest decides from the LIVE records: caller = store.getWorkspace(from), profiles = store.getBrowserProfiles(), caller vouched by the session key', () => {
  const call = /decideSpawnProfile\(\{([\s\S]*?)\n  \}\);/.exec(dispatch)?.[1] ?? '';
  assert.ok(call, 'decideSpawnProfile call found');
  assert.match(call, /requested: input\.profile,/);
  assert.match(call, /caller: input\.from \? store\.getWorkspace\(input\.from\) : undefined,/, 'what the caller holds is read from ITS record, never from the request');
  assert.match(call, /callerVouched: !!input\.from && !!input\.key && sessionKeys\(\)\.verify\(input\.from, input\.key\) === 'ok',/, 'ADR 0008: only the live session of `from`');
  assert.match(call, /profiles: store\.getBrowserProfiles\(\),/);
  assert.match(ws, /import \{ decideSpawnProfile \} from '\.\.\/shared\/spawn-profile\.ts';/, 'the pure function, not a copy');
});

test('the decision PRECEDES createWorkspace, and only an honoured one reaches the new record', () => {
  const decide = dispatch.indexOf('decideSpawnProfile(');
  const make = dispatch.indexOf('await createWorkspace(');
  assert.ok(decide !== -1 && make !== -1 && decide < make);
  assert.match(dispatch, /profileDecision\.kind === 'honoured' \? \{ browserProfileId: profileDecision\.profileId \} : undefined\);/);
});

test('createWorkspace writes browserProfileId from the spawn decision ONLY, as part of the initial record', () => {
  assert.equal(create.split('browserProfileId').length - 1, 4, 'param type + condition + key + value — no other mention');
  assert.match(create, /\.\.\.\(inherited\?\.browserProfileId \? \{ browserProfileId: inherited\.browserProfileId \} : \{\}\),\n  \};\n  await store\.upsertWorkspace\(ws\);/, 'inside the record literal persisted by the first upsert');
  assert.doesNotMatch(types.slice(types.indexOf('export interface CreateWorkspaceInput'), types.indexOf('\n}\n', types.indexOf('export interface CreateWorkspaceInput'))), /browserProfile/, 'CreateWorkspaceInput crosses the renderer IPC: it carries no profile');
});

test('the spawn path never touches the human-only attach service or IPC', () => {
  for (const [n, src] of Object.entries({ dispatch, create })) {
    assert.doesNotMatch(src, /browserProfileAttach|attachProfile|browser-profiles|setWorkspaceProfile/, n);
  }
  assert.doesNotMatch(read('src/cli/index.ts'), /browserProfileAttach|browser-profiles/);
});

test('only the hooks /spawn route sends profile + key; the sandbox wire and the human paths (Linear, accès mobile) send neither', () => {
  const route = hooks.slice(hooks.indexOf("route === '/spawn'"), hooks.indexOf("route === '/peers'"));
  assert.match(route, /profile: typeof msg\.profile === 'string' \? msg\.profile : undefined,/);
  assert.match(route, /key: typeof msg\.key === 'string' \? msg\.key : undefined,/);
  const rpc = sandbox.slice(sandbox.indexOf("case 'spawn':"), sandbox.indexOf("case 'peers':"));
  assert.match(rpc, /dispatchAgentSpawnRequest\(/, 'control: the right slice');
  assert.doesNotMatch(rpc, /profile|key:/);
  const linearCall = linear.slice(linear.indexOf('await dispatchSpawnRequest({'));
  assert.doesNotMatch(linearCall.slice(0, linearCall.indexOf('});')), /profile|key:/);
  const mobileCall = mobile.slice(mobile.indexOf('dispatchSpawnRequest({'), mobile.indexOf('}),', mobile.indexOf('dispatchSpawnRequest({')));
  assert.match(mobileCall, /defaultKind: 'workspace'/, 'control: the right slice');
  assert.doesNotMatch(mobileCall, /profile|key:/);
});

test('the reply carries the decision: a profile report on success AND on a kept (failed-start) child', () => {
  assert.match(dispatch, /profileDecision\.kind === 'none' \? \{\} : \{ profile: \{ applied: profileDecision\.kind === 'honoured', message: profileDecision\.message \} \}/);
  assert.equal(dispatch.split('...profileReport').length - 1, 3, 'ok result + start failure + thrown start');
});

test('whoami exposes the HELD profile through effectiveProfileId (a dangling id reads null)', () => {
  const who = bodyOf(ws, 'export function dispatchWhoamiRequest(');
  assert.match(who, /const heldId = effectiveProfileId\(ws\.browserProfileId, profiles\);/);
  assert.match(who, /browserProfile: held \? \{ id: held\.id, name: held\.name \} : null,/);
});
