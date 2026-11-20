import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { COORDINATOR_HANDOFF_BOUND_TURNS, FLEET_ROLES, ROLE_PREFIX, SCRIBE_MODEL, parseRoleConfig, resolveSpawnRoleDefaults, roleOfName, roleSpec, type FleetRole } from './fleet-roles.ts';
import { ROLES, checkSpawnName } from './naming-policy.ts';
import { HANDOFF_MIN_BOUND_TURNS, HandoffTurnCounter, resolveHandoffBound } from './handoff.ts';

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

test('parseRoleConfig: a duplicate key (role or field) is refused, a repeated key in DIFFERENT objects is not', () => {
  assert.throws(() => parseRoleConfig('{"scribe":{"model":"x"},"scribe":{"effort":"low"}}'), /duplicate key "scribe"/);
  assert.throws(() => parseRoleConfig('{"scribe":{"effort":"low","effort":"high"}}'), /duplicate key "effort"/);
  assert.doesNotThrow(() => parseRoleConfig('{"scribe":{"effort":"low"},"verifier":{"effort":"high"}}'));
  assert.throws(() => parseRoleConfig('{"scribe":{"model":"a,\\"scribe\\":b"}}'), /invalid model/, 'a key-looking string inside a value is a value (invalid model), not a duplicate key');
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

test('#478 handoffBoundTurns: built-in ON for the coordinator only; every other role off; the default is a usable bound', () => {
  assert.equal(roleSpec('coordinator').handoffBoundTurns, COORDINATOR_HANDOFF_BOUND_TURNS);
  assert.ok(COORDINATOR_HANDOFF_BOUND_TURNS >= HANDOFF_MIN_BOUND_TURNS);
  for (const r of FLEET_ROLES.filter((x) => x !== 'coordinator')) assert.equal(roleSpec(r).handoffBoundTurns, 0, r);
});

test('#478 the number the skill, `orchestra help handoff` and the docs print IS the built-in coordinator bound', async () => {
  const { VERIFIED_FANOUT_SKILL } = await import('./verified-fanout-skill.ts');
  const { COMMANDS } = await import('../cli/help.ts');
  const n = String(COORDINATOR_HANDOFF_BOUND_TURNS);
  assert.match(VERIFIED_FANOUT_SKILL, new RegExp(`nudges the coordinator at ${n} turns`));
  assert.match(COMMANDS.find((c) => c.name === 'handoff')?.detail ?? '', new RegExp(`coordinator \\(ops-\\) ${n} turns`));
  assert.match(fs.readFileSync(path.join(import.meta.dirname, '..', '..', 'docs', 'codebase-map', 'session-keeper.md'), 'utf8'), new RegExp(`COORDINATOR_HANDOFF_BOUND_TURNS\` = ${n} for the coordinator`));
});

test('#478 parseRoleConfig handoffBoundTurns: integer >= min, or 0 / null / "default" = off; everything else is a NAMED refusal', () => {
  assert.equal(roleSpec('coordinator', parseRoleConfig({ coordinator: { handoffBoundTurns: 50 } })).handoffBoundTurns, 50);
  assert.equal(roleSpec('implementer', parseRoleConfig({ implementer: { handoffBoundTurns: 40 } })).handoffBoundTurns, 40, 'another role can be turned ON');
  assert.equal(roleSpec('coordinator', parseRoleConfig({ coordinator: { handoffBoundTurns: HANDOFF_MIN_BOUND_TURNS } })).handoffBoundTurns, HANDOFF_MIN_BOUND_TURNS);
  for (const off of [0, null, 'default']) assert.equal(roleSpec('coordinator', parseRoleConfig({ coordinator: { handoffBoundTurns: off } })).handoffBoundTurns, 0, `${String(off)} = off, even for the coordinator`);
  assert.equal(roleSpec('coordinator', parseRoleConfig({ coordinator: { effort: 'high' } })).handoffBoundTurns, COORDINATOR_HANDOFF_BOUND_TURNS, 'an override that does not name the field keeps the default');
  for (const bad of [1, 3, -4, 2.5, '30', true, NaN]) {
    assert.throws(() => parseRoleConfig({ coordinator: { handoffBoundTurns: bad } }), /invalid handoffBoundTurns/, String(bad));
  }
  assert.throws(() => parseRoleConfig({ coordinator: { handoffBound: 30 } }), /unknown key "handoffBound" in role "coordinator"/);
  assert.throws(() => parseRoleConfig('{"coordinator":{"handoffBoundTurns":30,"handoffBoundTurns":40}}'), /duplicate key "handoffBoundTurns"/);
});

test('#478 end to end (pure): spawn name -> role -> bound -> nudge at the turn the bound says; env beats the file beats the default', () => {
  const nudgeTurn = (name: string, env: Record<string, string>, file?: unknown, turns = 80): number | null => {
    const role = roleOfName(name);
    const roleBound = role ? roleSpec(role, file === undefined ? undefined : parseRoleConfig(file)).handoffBoundTurns : 0;
    const { bound } = resolveHandoffBound(env, roleBound);
    const c = new HandoffTurnCounter();
    for (let i = 1; i <= turns; i++) if (c.noteTurnEnd('w', 's', bound).nudge) return i;
    return null;
  };
  assert.equal(nudgeTurn('ops-vague-1', {}), COORDINATOR_HANDOFF_BOUND_TURNS, 'coordinator: default ON');
  for (const n of ['impl-x', 'verif-x', 'review-x', 'explo-x', 'scribe-x', 'plain-name']) assert.equal(nudgeTurn(n, {}), null, `${n}: off`);
  assert.equal(nudgeTurn('ops-x', {}, { coordinator: { handoffBoundTurns: 12 } }), 12, 'the file beats the default');
  assert.equal(nudgeTurn('ops-x', { ORCHESTRA_HANDOFF_BOUND_TURNS: '9' }, { coordinator: { handoffBoundTurns: 12 } }), 9, 'env beats the file');
  assert.equal(nudgeTurn('ops-x', { ORCHESTRA_HANDOFF_BOUND_TURNS: '0' }), null, 'env 0 forces the coordinator off');
  assert.equal(nudgeTurn('ops-x', {}, { coordinator: { handoffBoundTurns: 0 } }), null, 'the file can turn the coordinator off');
  assert.equal(nudgeTurn('impl-x', {}, { implementer: { handoffBoundTurns: 10 } }), 10, 'the file can turn another role on');
});

// MUST-FAIL arms: mutate a COPY of the module and prove the assertions above can see it.
async function mutant(edit: (s: string) => string): Promise<typeof import('./fleet-roles.ts')> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'fleet-roles-mut-'));
  const src = fs.readFileSync(SRC, 'utf8');
  const edited = edit(src);
  const out = edited.replace(/from '\.\/([a-z-]+\.ts)'/g, (_m, f) => `from '${pathToFileURL(path.join(path.dirname(SRC), f)).href}'`); // the copy lives in a scratch dir: absolutise its imports
  assert.notEqual(edited, src, 'the mutant string was found in the live source (not a no-op)');
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

test('MUST-FAIL: a duplicate-key check removed is seen', async () => {
  const m = await mutant((s) => s.replace('const dup = findDuplicateKey(raw);', 'const dup = undefined as string | undefined;'));
  assert.doesNotThrow(() => m.parseRoleConfig('{"scribe":{"effort":"low"},"scribe":{"effort":"high"}}'), 'the mutant lets the first copy vanish');
  assert.throws(() => parseRoleConfig('{"scribe":{"effort":"low"},"scribe":{"effort":"high"}}'), /duplicate key/);
});

test('MUST-FAIL (#478): a coordinator default of 0 / a non-coordinator default of 30 / a parse that drops the field are each seen', async () => {
  const off = await mutant((s) => s.replace('handoffBoundTurns: COORDINATOR_HANDOFF_BOUND_TURNS }', 'handoffBoundTurns: 0 }'));
  assert.equal(off.roleSpec('coordinator').handoffBoundTurns, 0, 'the mutant turns the coordinator default off…');
  assert.equal(roleSpec('coordinator').handoffBoundTurns, COORDINATOR_HANDOFF_BOUND_TURNS, '…the live table does not');
  const all = await mutant((s) => s.replace(/(implementer: \{[^\n]*)handoffBoundTurns: 0 \}/, '$1handoffBoundTurns: 30 }'));
  assert.equal(all.roleSpec('implementer').handoffBoundTurns, 30, 'the mutant turns an implementer ON');
  assert.equal(roleSpec('implementer').handoffBoundTurns, 0);
  const ignore = await mutant((s) => s.replace("handoffBoundTurns: o && 'handoffBoundTurns' in o ? (o.handoffBoundTurns ?? 0) : base.handoffBoundTurns", 'handoffBoundTurns: base.handoffBoundTurns'));
  assert.equal(ignore.roleSpec('coordinator', parseRoleConfig({ coordinator: { handoffBoundTurns: 50 } })).handoffBoundTurns, COORDINATOR_HANDOFF_BOUND_TURNS, 'the mutant ignores the file');
  assert.equal(roleSpec('coordinator', parseRoleConfig({ coordinator: { handoffBoundTurns: 50 } })).handoffBoundTurns, 50);
  const lax = await mutant((s) => s.replace('v >= HANDOFF_MIN_BOUND_TURNS)', 'v >= 1)'));
  assert.doesNotThrow(() => lax.parseRoleConfig({ coordinator: { handoffBoundTurns: 2 } }), 'the mutant accepts a bound under the minimum');
  assert.throws(() => parseRoleConfig({ coordinator: { handoffBoundTurns: 2 } }), /invalid handoffBoundTurns/);
});
