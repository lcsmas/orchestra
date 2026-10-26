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
  const call = /decideSpawnProfile\(\{([\s\S]*?)\n    \}\);/.exec(dispatch)?.[1] ?? '';
  assert.ok(call, 'decideSpawnProfile call found');
  assert.match(call, /requested: input\.profile,/);
  assert.match(call, /detached: input\.detached === true,/, 'a parentless (--detached) worker is never handed a profile');
  assert.match(call, /caller: input\.from \? store\.getWorkspace\(input\.from\) : undefined,/, 'what the caller holds is read from ITS record, never from the request');
  assert.match(call, /callerVouched: !!input\.from && !!input\.key && sessionKeys\(\)\.verify\(input\.from, input\.key\) === 'ok',/, 'ADR 0008: only the live session of `from`');
  assert.match(call, /profiles: store\.getBrowserProfiles\(\),/);
  assert.match(call, /deleting: deletingProfiles\(\),/, 'a profile whose delete is running is never handed on (the delete scanned its carriers already)');
  assert.match(ws, /import \{ deletingProfiles \} from '\.\/spawn-profile-gate\.ts';/);
  assert.match(ws, /import \{ decideSpawnProfile, type SpawnProfileDecision \} from '\.\.\/shared\/spawn-profile\.ts';/, 'the pure function, not a copy');
});

test('the decision is a THUNK handed to createWorkspace (only when --profile was given) and returns the id only when honoured', () => {
  assert.match(dispatch, /input\.profile !== undefined \? decideProfile : undefined\);/, 'no --profile ⇒ no thunk ⇒ creation is untouched');
  assert.match(dispatch, /return profileDecision\.kind === 'honoured' \? profileDecision\.profileId : undefined;/);
  assert.equal(dispatch.split('decideSpawnProfile(').length - 1, 1, 'one decision site — not also made up front (a stale t0 decision is the TOCTOU)');
});

test('M1 TOCTOU: createWorkspace asks the thunk AFTER the worktree exists and with NO await before the first upsert', () => {
  const ask = create.indexOf('const inheritedProfile = profileAtCreation?.();');
  const wt = create.indexOf('await createWorktree(');
  const hooks = create.indexOf('await installOrchestraHooks(');
  const upsert = create.indexOf('await store.upsertWorkspace(ws);');
  assert.ok(wt !== -1 && hooks !== -1 && upsert !== -1 && ask !== -1, 'controls: all four landmarks found');
  assert.ok(ask > wt && ask > hooks, 'after the slow part (worktree add + hooks)');
  const between = create.slice(ask, upsert).replace(/\/\/.*$/gm, '').replace(/\/\*[\s\S]*?\*\//g, ''); // comments may say "await"
  assert.ok(between.includes('store.allocatePort') === false && between.includes('const ws: Workspace = {'), 'control: the slice is the record build');
  assert.ok(!/\bawait\b/.test(between), 'no await between the profile read and the record upsert');
  assert.match(create, /\.\.\.\(inheritedProfile \? \{ browserProfileId: inheritedProfile \} : \{\}\),/);
});

test('createWorkspace writes browserProfileId from the spawn decision ONLY, as part of the initial record', () => {
  assert.equal(create.split('browserProfileId').length - 1, 1, 'one mention: the record key — nothing else in createWorkspace writes a profile');
  assert.match(create, /\.\.\.\(inheritedProfile \? \{ browserProfileId: inheritedProfile \} : \{\}\),\n  \};\n  await store\.upsertWorkspace\(ws\);/, 'inside the record literal persisted by the first upsert');
  assert.doesNotMatch(types.slice(types.indexOf('export interface CreateWorkspaceInput'), types.indexOf('\n}\n', types.indexOf('export interface CreateWorkspaceInput'))), /browserProfile/, 'CreateWorkspaceInput crosses the renderer IPC: it carries no profile');
});

test('the spawn path never touches the human-only attach service or IPC', () => {
  for (const [n, src] of Object.entries({ dispatch, create })) {
    assert.doesNotMatch(src, /browserProfileAttach|attachProfile|browser-profiles|setWorkspaceProfile/, n);
  }
  assert.doesNotMatch(read('src/cli/index.ts'), /browserProfileAttach|browser-profiles/);
});

/** A profile or a session key in any form — `profile`, `key:`, shorthand `key,`, or a spread of a whole body (`...msg`) that could carry them. */
const NO_PROFILE_OR_KEY = /\bprofile\b|\bkey\b|\.\.\.(?:msg|p|input|body|payload)\b/;

test('CONTROL: the scan that keeps profile + key off the other spawn paths can match each form', () => {
  for (const form of ['profile: x', 'key: k', 'key,', '...msg', '...p,']) assert.match(form, NO_PROFILE_OR_KEY, form);
  assert.doesNotMatch("name: typeof p.name === 'string' ? p.name : undefined,", NO_PROFILE_OR_KEY);
});

test('only the hooks /spawn route sends profile + key; the sandbox wire and the human paths (Linear, accès mobile) send neither', () => {
  const route = hooks.slice(hooks.indexOf("route === '/spawn'"), hooks.indexOf("route === '/peers'"));
  assert.match(route, /profile: typeof msg\.profile === 'string' \? msg\.profile : undefined,/);
  assert.match(route, /key: typeof msg\.key === 'string' \? msg\.key : undefined,/);
  const rpc = sandbox.slice(sandbox.indexOf("case 'spawn':"), sandbox.indexOf("case 'peers':"));
  assert.match(rpc, /dispatchAgentSpawnRequest\(/, 'control: the right slice');
  assert.doesNotMatch(rpc, NO_PROFILE_OR_KEY);
  const linearCall = linear.slice(linear.indexOf('await dispatchSpawnRequest({'));
  assert.doesNotMatch(linearCall.slice(0, linearCall.indexOf('});')), NO_PROFILE_OR_KEY);
  const mobileCall = mobile.slice(mobile.indexOf('dispatchSpawnRequest({'), mobile.indexOf('}),', mobile.indexOf('dispatchSpawnRequest({')));
  assert.match(mobileCall, /defaultKind: 'workspace'/, 'control: the right slice');
  assert.doesNotMatch(mobileCall, NO_PROFILE_OR_KEY);
});

test('the reply carries the decision: a profile report on success AND on a kept (failed-start) child', () => {
  assert.match(dispatch, /profileDecision\.kind === 'none' \? \{\} : \{ profile: \{ applied: profileDecision\.kind === 'honoured', message: profileDecision\.message \} \}/);
  assert.equal(dispatch.split('...profileReport()').length - 1, 2, 'ok result + keptFailure (which both failed-start returns go through — #375 pins those return lines verbatim)');
  assert.match(dispatch, /startError: cause,[\s\S]*?\.\.\.profileReport\(\),/, 'the kept child\'s reply carries the report');
});

test('whoami shows the HELD profile only to the VOUCHED live session of that workspace (M2) — never `null` for an unvouched caller', () => {
  const who = bodyOf(ws, 'export function dispatchWhoamiRequest(');
  assert.match(who, /const vouched = !!input\.key && sessionKeys\(\)\.verify\(id, input\.key\) === 'ok';/);
  assert.match(who, /const profiles = vouched \? store\.getBrowserProfiles\(\) : \[\];/, 'an unvouched caller never even reads the profile list');
  assert.match(who, /const heldId = effectiveProfileId\(ws\.browserProfileId, profiles\);/, 'a dangling id reads null');
  assert.match(who, /\.\.\.\(vouched \? \{ browserProfile: held \? \{ id: held\.id, name: held\.name \} : null \} : \{\}\),/, 'omitted (not null) when unvouched');
  const route = hooks.slice(hooks.indexOf("route === '/whoami'"), hooks.indexOf("route === '/migrateAccount'"));
  assert.match(route, /dispatchWhoamiRequest\(\{ id: msg\.id, key: typeof msg\.key === 'string' \? msg\.key : undefined \}\)/);
});

test('the profile DELETE seam: the service raises `deleting` in the same synchronous turn as its carrier scan, the host registers the probe once, the gate is Electron-free', () => {
  const svc = read('src/main/browser-profiles.ts');
  assert.match(svc, /deleting: \(\) => \[\.\.\.deleting\],/, 'the service exposes the running deletes');
  assert.match(svc, /remove: \(id\) =>\n      serial\(\(\) => whileDeleting\(id, async \(\) => \{/, 'the whole remove runs inside the flag');
  const w = /const whileDeleting = async <T>\(id: unknown, fn: \(\) => Promise<T>\): Promise<T> => \{([\s\S]*?)\n  \};/.exec(svc)?.[1] ?? '';
  assert.ok(w, 'control: found whileDeleting');
  assert.match(w, /deleting\.add\(profileId\);\n    try \{\n      return await fn\(\);\n    \} finally \{\n      deleting\.delete\(profileId\);/, 'raised before fn, cleared in finally (ok, refused or thrown)');
  assert.ok(!/\bawait\b/.test(w.slice(0, w.indexOf('try {'))), 'no await between raising the flag and the delete body');
  const host = read('src/main/browser-profiles-host.ts');
  assert.equal(host.split('setDeletingProfilesProbe(').length - 1, 1);
  assert.match(host, /setDeletingProfilesProbe\(\(\) => service\.deleting\(\)\);/);
  const gate = read('src/main/spawn-profile-gate.ts');
  assert.doesNotMatch(gate, /from 'electron'|from '\.\/(store|platform|workspaces|browser-panel)/, 'the gate stays Electron-free (workspaces.ts must not import the host)');
});
