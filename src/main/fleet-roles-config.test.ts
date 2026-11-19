import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { loadRoleConfig } from './fleet-roles-config.ts';
import { ROLE_CONFIG_FILE, roleSpec } from '../shared/fleet-roles.ts';

const home = () => fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-roles-home-'));

test('#465 override file: absent = no override; valid applies; unknown key / role stops with a named error carrying the path', () => {
  const h = home();
  assert.deepEqual(loadRoleConfig(h), {});
  fs.writeFileSync(path.join(h, ROLE_CONFIG_FILE), '{"scribe":{"effort":"medium"}}');
  assert.equal(roleSpec('scribe', loadRoleConfig(h)).effort, 'medium');
  fs.writeFileSync(path.join(h, ROLE_CONFIG_FILE), '{"scribe":{"modle":"x"}}');
  assert.throws(() => loadRoleConfig(h), (e: Error) => e.message.includes(path.join(h, ROLE_CONFIG_FILE)) && /unknown key "modle"/.test(e.message));
  fs.writeFileSync(path.join(h, ROLE_CONFIG_FILE), '{"janitor":{}}');
  assert.throws(() => loadRoleConfig(h), /unknown role "janitor"/);
});

test('#465 wiring: the agent spawn route applies the role defaults and refuses on a bad override file', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'workspaces.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function dispatchAgentSpawnRequest('));
  assert.match(body, /resolveSpawnRoleDefaults\(checked\.name, \{ model: rest\.model, effort: rest\.effort \}, loadRoleConfig\(\)\)/);
  assert.match(body, /refusing to spawn: \$\{e instanceof Error/);
  assert.match(body, /dispatchSpawnRequest\(\{ \.\.\.rest, \.\.\.roleDefaults,/);
});
