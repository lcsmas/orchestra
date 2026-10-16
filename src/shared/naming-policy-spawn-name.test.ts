import { test } from 'node:test';
import assert from 'node:assert/strict';
import { checkSpawnName, NAME_CONVENTION, nudgeActive, ROLES } from './naming-policy.ts';

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
  for (const raw of ['impl-x', 'ops-1', 'review-a.b', 'explo-x.y']) assert.equal(checkSpawnName(raw).ok, true, raw);
});

test('object — must-FAIL: a rôle with no object after it is refused', () => {
  for (const raw of ['impl-', 'ops--', 'verif-.', 'review-/', 'explo-- ', 'impl-___']) {
    assert.match(refused(raw), /names the rôle but not the work/, raw);
  }
});

test('sanitisation — must-PASS: the returned name is the branch-sanitised one', () => {
  assert.deepEqual(checkSpawnName('  impl-hello   world  '), { ok: true, name: 'impl-hello-world' });
  assert.deepEqual(checkSpawnName('impl-no$pe!c#hars'), { ok: true, name: 'impl-nopechars' });
});

test('sanitisation — must-FAIL: a name with nothing usable left is refused; sanitising cannot conjure a rôle', () => {
  assert.match(refused('€€!?'), /no usable character/);
  assert.match(refused('é-impl-x'), /does not start with a rôle/); // `é` folds to `e`: `e-impl-x`, no rôle
  assert.match(refused('$impl-'), /names the rôle but not the work/); // sanitised to `impl-`
});

test('diacritics — must-PASS: accented words are FOLDED, never dropped, whatever the input normalisation (NFC or NFD)', () => {
  const nfc = 'impl-réglages-compte-390'.normalize('NFC'), nfd = 'impl-réglages-compte-390'.normalize('NFD');
  assert.notEqual(nfc, nfd); // control: the two inputs really are different strings
  for (const raw of [nfc, nfd]) assert.deepEqual(checkSpawnName(raw), { ok: true, name: 'impl-reglages-compte-390' });
  assert.deepEqual(checkSpawnName('explo-cœur-de-l’œuvre-Ça'), { ok: true, name: 'explo-coeur-de-loeuvre-Ca' });
  assert.deepEqual(checkSpawnName('verif-Straße-à-côté'), { ok: true, name: 'verif-Strasse-a-cote' });
});

test('diacritics — must-FAIL: folding does not conjure a rôle (an accented rôle word is still not a rôle)', () => {
  assert.match(refused('imp1-x'), /does not start with a rôle/);
  assert.equal(checkSpawnName('implé-x').ok, false); // folds to `imple-x`, not `impl-`
});

test('flat — must-PASS/must-FAIL: no folders in a spawn name (a `/` is refused, `-` and `.` are fine)', () => {
  assert.equal(checkSpawnName('impl-a.b-c').ok, true);
  for (const raw of ['impl-a/b', 'impl-a/', 'impl-a//b', 'impl-a/.b']) assert.match(refused(raw), /contains "\/"/, raw);
});

test('length — must-PASS/must-FAIL: 79 characters is the limit, a longer name is refused (never silently cut)', () => {
  const ok79 = `impl-${'a'.repeat(74)}`;
  assert.equal(ok79.length, 79);
  assert.deepEqual(checkSpawnName(ok79), { ok: true, name: ok79 });
  assert.match(refused(`impl-${'a'.repeat(75)}`), /too long/); // 80: could be a cut name
  assert.match(refused(`impl-politique-${'x'.repeat(150)}-381`), /too long/); // the ticket tail would be lost
});

test('git ref — must-PASS/must-FAIL: a name git would reject is refused here, with the convention, not by git at spawn time', () => {
  for (const raw of ['impl-a..b', 'impl-a.', 'impl-a.lock', 'impl-x...']) assert.match(refused(raw), /not a valid git branch name/, raw);
  for (const raw of ['impl-a.b', 'impl-a-lock', 'impl-.a', 'impl-a_b.c']) assert.equal(checkSpawnName(raw).ok, true, raw);
});

test('every refusal restates the convention verbatim', () => {
  for (const raw of [undefined, '', '€€', 'fix-x', 'impl-', 'impl-a/b', 'impl-a..b', `impl-${'a'.repeat(80)}`]) assert.ok(refused(raw).includes(NAME_CONVENTION), String(raw));
  assert.match(NAME_CONVENTION, /rôle/);
  assert.match(NAME_CONVENTION, /\[-<ticket>\]/);
  for (const role of ROLES) assert.ok(NAME_CONVENTION.includes(role), role);
});

// #382 — the nudge clause: a workspace named by its parent is never nudged to rename itself, whatever its counters say.

test('nudgeActive — must-FAIL: a child named by its parent (counter 0, no human pin) gets no rename nudge', () => {
  assert.equal(nudgeActive({ branchManuallySet: false, autoRenameCount: 0, namedByParent: 'parent-1' }), false);
  assert.equal(nudgeActive({ branchManuallySet: false, namedByParent: 'parent-1', parentId: 'parent-1' }), false);
  // a --detached child has no parentId: the namer id alone silences the nudge (D1, story 15)
  assert.equal(nudgeActive({ branchManuallySet: false, namedByParent: 'spawner-1' }), false);
});

test('nudgeActive — must-PASS: a human-created workspace is nudged exactly as before, until two renames or a human pin', () => {
  assert.equal(nudgeActive({ branchManuallySet: false }), true);
  assert.equal(nudgeActive({ branchManuallySet: false, autoRenameCount: 1 }), true);
  assert.equal(nudgeActive({ branchManuallySet: false, autoRenameCount: 2 }), false);
  assert.equal(nudgeActive({ branchManuallySet: true, autoRenameCount: 0 }), false);
});
