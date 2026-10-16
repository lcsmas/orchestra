import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpawnName, NAME_CONVENTION, ROLES } from './naming-policy.ts';

// #382 — the spawn-name check: required, sanitised, rôle-prefixed, with an object after the rôle, and a
// refusal that restates the convention. One must-PASS and one must-FAIL arm per clause (mutated once each,
// see the ledger #387 G3).

const refused = (raw: string | undefined | null): string => {
  const r = checkSpawnName(raw);
  assert.equal(r.ok, false, `expected a refusal for ${JSON.stringify(raw)}`);
  return r.ok ? '' : r.error;
};

test('required — must-PASS: a named spawn is accepted as given', () => {
  assert.deepEqual(checkSpawnName('impl-politique-nommage-381'), { ok: true, name: 'impl-politique-nommage-381' });
});

test('required — must-FAIL: missing / empty / whitespace-only names are refused and mention --name', () => {
  for (const raw of [undefined, null, '', '   ', '\t\n']) {
    assert.match(refused(raw), /--name/, JSON.stringify(raw));
  }
});

test('rôle prefix — must-PASS: every rôle of the fixed list is accepted', () => {
  assert.deepEqual([...ROLES], ['ops', 'impl', 'verif', 'review', 'explo']);
  for (const role of ROLES) {
    assert.deepEqual(checkSpawnName(`${role}-nommage-parent`), { ok: true, name: `${role}-nommage-parent` });
  }
});

test('rôle prefix — must-FAIL: an unknown rôle is refused', () => {
  for (const raw of [
    'fix-checkout-typo', // a plain branch name
    'implement-nommage', // starts with `impl` but is not `impl-`
    'verify-nommage', // starts with `verif` but is not `verif-`
    'reviewer-nommage',
    'Impl-nommage', // the rôle is lowercase
    'impl_nommage', // the separator is `-`
    'impl', // the rôle alone, no separator
    'my-impl-x', // the rôle must be the FIRST word
    'lead-nommage',
    'worker-nommage',
  ]) {
    assert.match(refused(raw), /does not start with a rôle/, raw);
  }
});

test('object — must-PASS: anything alphanumeric after the rôle is enough (the object is not validated)', () => {
  for (const raw of ['impl-x', 'ops-1', 'review-a.b', 'explo-x/y']) assert.equal(checkSpawnName(raw).ok, true, raw);
});

test('object — must-FAIL: a rôle with no object after it is refused', () => {
  for (const raw of ['impl-', 'ops--', 'verif-.', 'review-/', 'explo-- ', 'impl-___']) {
    assert.match(refused(raw), /names the rôle but not the work/, raw);
  }
});

test('sanitisation — must-PASS: the returned name is the branch-sanitised one', () => {
  assert.deepEqual(checkSpawnName('  impl-hello   world  '), { ok: true, name: 'impl-hello-world' });
  assert.deepEqual(checkSpawnName('impl-no$pe!c#hars'), { ok: true, name: 'impl-nopechars' });
  const long = checkSpawnName(`impl-${'a'.repeat(200)}`);
  assert.equal(long.ok && long.name.length, 80);
});

test('sanitisation — must-FAIL: a name with nothing usable left is refused; sanitising cannot conjure a rôle', () => {
  assert.match(refused('éé!?'), /no usable character/);
  assert.match(refused('é-impl-x'), /does not start with a rôle/); // `é` is stripped, `-impl-x` is left: no rôle
  assert.match(refused('$impl-'), /names the rôle but not the work/); // sanitised to `impl-`
});

test('every refusal restates the convention verbatim', () => {
  for (const raw of [undefined, '', 'éé', 'fix-x', 'impl-']) assert.ok(refused(raw).includes(NAME_CONVENTION), String(raw));
  assert.match(NAME_CONVENTION, /rôle/);
  assert.match(NAME_CONVENTION, /\[-<ticket>\]/);
  for (const role of ROLES) assert.ok(NAME_CONVENTION.includes(role), role);
});
