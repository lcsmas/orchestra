import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { FLEET_ROLES, ROLE_PREFIX, SCRIBE_MODEL, parseRoleConfig, resolveSpawnRoleDefaults, roleOfName, roleSpec, type FleetRole } from './fleet-roles.ts';
import { ROLES, checkSpawnName } from './naming-policy.ts';

const SRC = path.join(import.meta.dirname, 'fleet-roles.ts');

test('table complete: every role has a spec, a prefix the naming policy accepts, and denies AskUserQuestion (D6)', () => {
  assert.deepEqual(Object.values(ROLE_PREFIX).sort(), [...ROLES].sort(), 'ROLE_PREFIX = the naming policy ROLES');
  assert.equal(FLEET_ROLES.length, 6);
  for (const role of FLEET_ROLES) {
    const spec = roleSpec(role);
    assert.equal(spec.role, role);
    assert.ok(spec.tools.denyTools.includes('AskUserQuestion'), role);
    assert.ok(['none', 'own-worktree', 'scratch'].includes(spec.tools.edit), role);
    for (const src of spec.tools.bashDeny) assert.doesNotThrow(() => new RegExp(src), `${role}: bashDeny is a valid regex source`);
    assert.equal(roleOfName(`${ROLE_PREFIX[role]}-some-work-12`), role);
    assert.equal(checkSpawnName(`${ROLE_PREFIX[role]}-some-work-12`).ok, true, `naming policy accepts ${role}`);
  }
});

test('strong roles pin nothing; scribe pins haiku + low', () => {
  for (const r of ['coordinator', 'implementer', 'verifier', 'reviewer', 'explorer'] as FleetRole[]) {
    assert.deepEqual([roleSpec(r).model, roleSpec(r).effort], [undefined, undefined], r);
  }
  assert.deepEqual([roleSpec('scribe').model, roleSpec('scribe').effort], [SCRIBE_MODEL, 'low']);
  assert.equal(SCRIBE_MODEL, 'claude-haiku-5-5');
});

test('roleOfName: prefix only, role-less names and look-alikes are null', () => {
  assert.equal(roleOfName('scribe-ledger-471'), 'scribe');
  for (const n of ['scribe', 'implement-x', 'x-impl-y', 'IMPL-x', '', undefined, null]) assert.equal(roleOfName(n as string), null, String(n));
});

test('parseRoleConfig: valid override applies; unknown role / unknown key / bad value / bad JSON throw a NAMED error', () => {
  const cfg = parseRoleConfig('{"scribe":{"model":"claude-haiku-4-5","effort":"medium"},"verifier":{"effort":"high"},"implementer":{"model":"default"}}');
  assert.deepEqual([roleSpec('scribe', cfg).model, roleSpec('scribe', cfg).effort], ['claude-haiku-4-5', 'medium']);
  assert.equal(roleSpec('verifier', cfg).effort, 'high');
  assert.equal(roleSpec('scribe', parseRoleConfig({ scribe: { model: null } })).model, undefined, 'null clears the pin');
  assert.throws(() => parseRoleConfig({ janitor: { model: 'x' } }), /unknown role "janitor"/);
  assert.throws(() => parseRoleConfig({ scribe: { modle: 'x' } }), /unknown key "modle" in role "scribe"/);
  assert.throws(() => parseRoleConfig({ scribe: { effort: 'turbo' } }), /invalid effort "turbo"/);
  assert.throws(() => parseRoleConfig({ scribe: { model: 'a b' } }), /invalid model/);
  assert.throws(() => parseRoleConfig('{nope'), /not valid JSON/);
  assert.throws(() => parseRoleConfig([]), /expected an object/);
  assert.throws(() => parseRoleConfig({ scribe: 'haiku' }), /must be an object/);
});

test('spawn defaults: no flag → the role pin; explicit flag wins per field; role-less name untouched', () => {
  assert.deepEqual(resolveSpawnRoleDefaults('scribe-ledger', {}), { model: SCRIBE_MODEL, effort: 'low' });
  assert.deepEqual(resolveSpawnRoleDefaults('scribe-ledger', { model: 'claude-opus-4-8' }), { model: 'claude-opus-4-8', effort: 'low' }, 'explicit model wins, effort still the role\'s');
  assert.deepEqual(resolveSpawnRoleDefaults('scribe-ledger', { model: 'claude-opus-4-8', effort: 'max' }), { model: 'claude-opus-4-8', effort: 'max' });
  assert.deepEqual(resolveSpawnRoleDefaults('impl-thing', {}), {}, 'strong role: Settings default');
  assert.deepEqual(resolveSpawnRoleDefaults('thing', {}), {});
  const cfg = parseRoleConfig({ implementer: { model: 'claude-sonnet-5-5', effort: 'high' } });
  assert.deepEqual(resolveSpawnRoleDefaults('impl-thing', {}, cfg), { model: 'claude-sonnet-5-5', effort: 'high' }, 'override file reaches the spawn');
  assert.deepEqual(resolveSpawnRoleDefaults('impl-thing', { model: 'm' }, cfg), { model: 'm', effort: 'high' });
});

// MUST-FAIL arms: mutate a COPY of the module and prove the assertions above can see it.
async function mutant(edit: (s: string) => string): Promise<typeof import('./fleet-roles.ts')> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-roles-mut-'));
  const src = fs.readFileSync(SRC, 'utf8');
  const out = edit(src);
  assert.notEqual(out, src, 'the mutant string was found in the live source (not a no-op)');
  const f = path.join(dir, 'fleet-roles.ts');
  fs.writeFileSync(f, out);
  return import(pathToFileURL(f).href);
}

test('MUST-FAIL: a role dropped from the table is seen (roleSpec throws)', async () => {
  const m = await mutant((s) => s.replace(/^  scribe: \{ role: 'scribe'.*\n/m, ''));
  assert.throws(() => m.roleSpec('scribe'), /no table entry/);
  assert.ok(m.roleSpec('implementer'), 'control: the other roles still resolve');
});

test('MUST-FAIL: an unknown key accepted by the parser is seen', async () => {
  const m = await mutant((s) => s.replace("throw new Error(`fleet-roles config: unknown key", 'void (`fleet-roles config: unknown key'));
  assert.doesNotThrow(() => m.parseRoleConfig({ scribe: { modle: 'x' } }), 'the mutant accepts it…');
  assert.throws(() => parseRoleConfig({ scribe: { modle: 'x' } }), /unknown key/, '…the live module does not');
});

test('MUST-FAIL: an explicit flag that loses to the role pin is seen', async () => {
  const m = await mutant((s) => s.replace('const model = explicit.model?.trim() ? explicit.model : spec?.model;', 'const model = spec?.model ?? explicit.model;'));
  assert.equal(m.resolveSpawnRoleDefaults('scribe-x', { model: 'claude-opus-4-8' }).model, SCRIBE_MODEL, 'the mutant lets the role override the flag');
  assert.equal(resolveSpawnRoleDefaults('scribe-x', { model: 'claude-opus-4-8' }).model, 'claude-opus-4-8');
});
