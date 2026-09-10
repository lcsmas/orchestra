import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

// Guards the child-spawn model default: a spawn with no explicit `--model`
// must pin the child to DEFAULT_CHILD_MODEL (Opus 4.8, on the user's
// instruction 2026-09-10) rather than letting it inherit the login default.
//
// HONEST LIMITATION — READ BEFORE TRUSTING THIS FILE. `workspaces.ts` imports
// `./store`, `./platform` and the SDK delivery chain, so it cannot be imported
// under `node --test` without an Electron host (same constraint documented in
// create-workspace-guard.test.ts). So the default's PRESENCE is asserted
// against source text, NOT by calling `dispatchSpawnRequest` and observing the
// resulting workspace record. That is a weaker claim and is stated as such:
// this would not catch a default that is present but overridden downstream.
// What it does catch is the realistic regression — the default being deleted,
// reverted to a bare `|| undefined`, or the model id being changed to a form
// the runtime rejects.

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '../..');
const workspacesSrc = fs.readFileSync(path.join(repoRoot, 'src/main/workspaces.ts'), 'utf8');

// POSITIVE CONTROL FIRST — prove the file was actually read and contains the
// function under test, so every assertion below cannot pass against an empty
// or wrong file.
test('CONTROL: workspaces.ts is readable and defines dispatchSpawnRequest', () => {
  assert.ok(workspacesSrc.length > 10_000, `source suspiciously short: ${workspacesSrc.length}`);
  assert.match(workspacesSrc, /export async function dispatchSpawnRequest\(/);
  assert.doesNotMatch(workspacesSrc, /zzzNoSuchPatternZzz/);
});

test('DEFAULT_CHILD_MODEL is the FULL wire id, not the rejected short alias', () => {
  const m = /export const DEFAULT_CHILD_MODEL = '([^']+)'/.exec(workspacesSrc);
  assert.ok(m, 'DEFAULT_CHILD_MODEL is no longer exported');
  // Measured 2026-09-10 (claude 2.1.267): `--model opus-4-8` is rejected with
  // `unrecognized_model`; only the full id is served. A short alias here would
  // fail at every child's own launch, which the charset guard cannot catch.
  assert.equal(m[1], 'claude-opus-4-8');
  assert.match(m[1], /^claude-/, 'must be a full wire id, never a short alias');
});

test('a spawn with no explicit model falls back to DEFAULT_CHILD_MODEL', () => {
  const start = workspacesSrc.indexOf('export async function dispatchSpawnRequest(');
  assert.ok(start > 0, 'dispatchSpawnRequest not found');
  const body = workspacesSrc.slice(start);
  // The load-bearing line: `|| DEFAULT_CHILD_MODEL`, NOT `|| undefined`.
  assert.match(
    body,
    /const model = input\.model\?\.trim\(\) \|\| DEFAULT_CHILD_MODEL;/,
    'the spawn model default was removed or reverted to the login default',
  );
});

test('the model default is applied BEFORE the charset guard rejects', () => {
  // Order matters: a default assigned after the guard would skip validation,
  // and a default assigned after the record is built would never persist.
  const start = workspacesSrc.indexOf('export async function dispatchSpawnRequest(');
  const body = workspacesSrc.slice(start);
  const defaultAt = body.indexOf('|| DEFAULT_CHILD_MODEL');
  const guardAt = body.indexOf('invalid model:');
  assert.ok(defaultAt > 0, 'default not found');
  assert.ok(guardAt > 0, 'charset guard not found');
  assert.ok(defaultAt < guardAt, 'the default must precede the charset guard');
});

test('DEFAULT_CHILD_MODEL passes the spawn charset guard it is subject to', () => {
  // The guard is the only validation a model id gets. If the default itself
  // failed it, EVERY unqualified spawn would be refused outright — so assert
  // the two agree rather than assuming.
  const m = /export const DEFAULT_CHILD_MODEL = '([^']+)'/.exec(workspacesSrc);
  assert.ok(m);
  assert.match(m[1], /^[A-Za-z0-9._:/-]{1,64}$/);
  // Negative control: the guard must be capable of REJECTING something, or the
  // assertion above is vacuous.
  assert.doesNotMatch('bad model!', /^[A-Za-z0-9._:/-]{1,64}$/);
});

test('the orchestrator brief and spawn skill doc name the same default', () => {
  // Three prose sites tell agents what to spawn on. A brief still saying
  // "--model opus" would COUNTERMAND the default on every orchestrated spawn,
  // which is a silent regression no type or unit check can see.
  assert.match(workspacesSrc, /Spawn every child on Opus 4\.8/);
  assert.doesNotMatch(
    workspacesSrc,
    /Spawn every child on Opus 5/,
    'the orchestrator brief still instructs children onto Opus 5',
  );
  assert.match(workspacesSrc, /Omitting it pins the child to Opus\n  4\.8/);
});
