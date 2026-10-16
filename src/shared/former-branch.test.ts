import test from 'node:test';
import assert from 'node:assert/strict';
import { exLabel, formerBranchPatch, peersExColumn, withExLabel } from './former-branch.ts';

// #384 — the "ex-<previous>" rule, as a table over (parent-named before / after) × (name change / no-op) × (prior former).

test('exLabel: "ex-<previous>" for a renamed workspace, "" for one never renamed (absent / blank / null)', () => {
  assert.equal(exLabel('kill-notice-impl-h1-322'), 'ex-kill-notice-impl-h1-322');
  assert.equal(exLabel(undefined), '');
  assert.equal(exLabel(null), '');
  assert.equal(exLabel(''), '');
  assert.equal(exLabel('   '), '');
});

test('withExLabel: the base tooltip is returned UNCHANGED when never renamed; the "(locked)" / "double-click" text survives', () => {
  assert.equal(withExLabel('b — double-click to rename', undefined), 'b — double-click to rename');
  assert.equal(withExLabel('b (locked)', ''), 'b (locked)');
  assert.equal(withExLabel('b — double-click to rename', 'old'), 'b — double-click to rename · ex-old');
  assert.equal(withExLabel('b (locked)', 'old'), 'b (locked) · ex-old');
});

test('formerBranchPatch: the rename-records-former table', () => {
  const cases: Array<{
    why: string;
    ws: { namedByParent?: string };
    before: string;
    after: string;
    namedAfter?: string;
    want: { formerBranch?: string };
  }> = [
    { why: 'first rename of a parent-named workspace records the previous name', ws: { namedByParent: 'P' }, before: 'old', after: 'new', want: { formerBranch: 'old' } },
    { why: 'a parent rename that PINS it (unnamed before, named after) records it too', ws: {}, before: 'lucky-willow', after: 'impl-x-1', namedAfter: 'P', want: { formerBranch: 'lucky-willow' } },
    { why: 'a human-created workspace\'s provisional self-rename records NOTHING (D3)', ws: {}, before: 'lucky-willow', after: 'fix-checkout-typo', want: {} },
    { why: 'a same-name no-op does not record, even when parent-named', ws: { namedByParent: 'P' }, before: 'same', after: 'same', want: {} },
    { why: 'a same-name no-op that would pin does not record either', ws: {}, before: 'same', after: 'same', namedAfter: 'P', want: {} },
    { why: 'an empty previous name records nothing', ws: { namedByParent: 'P' }, before: '', after: 'new', want: {} },
  ];
  for (const c of cases) {
    assert.deepEqual(formerBranchPatch(c.ws, c.before, c.after, c.namedAfter), c.want, c.why);
  }
});

test('formerBranchPatch: a later rename REPLACES the field with the latest previous name (A→B→C ⇒ B, not A)', () => {
  let ws: { namedByParent: string; branch: string; formerBranch?: string } = { namedByParent: 'P', branch: 'a' };
  for (const next of ['b', 'c']) {
    ws = { ...ws, branch: next, ...formerBranchPatch(ws, ws.branch, next) };
  }
  assert.equal(ws.formerBranch, 'b');
  // …and a rename BACK is still an actual change: C→B records C.
  ws = { ...ws, branch: 'b', ...formerBranchPatch(ws, ws.branch, 'b') };
  assert.equal(ws.formerBranch, 'c');
});

test('formerBranchPatch never emits `formerBranch: undefined` (workspace:update is a merge; an explicit undefined would clear it)', () => {
  for (const patch of [formerBranchPatch({}, 'a', 'b'), formerBranchPatch({ namedByParent: 'P' }, 'a', 'a')]) {
    assert.equal('formerBranch' in patch, false);
  }
});

test('peersExColumn: null (no column) unless some peer was renamed; blank cell for a never-renamed one', () => {
  assert.equal(peersExColumn([]), null);
  assert.equal(peersExColumn([{}, { formerBranch: undefined }, { formerBranch: '' }]), null);
  assert.deepEqual(peersExColumn([{}, { formerBranch: 'old' }, {}]), ['', 'ex-old', '']);
});
