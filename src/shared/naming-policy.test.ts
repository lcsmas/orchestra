// #381 — the naming policy pins TODAY's rule (no behaviour change): the rename nudge is active until a human pins
// the name or the agent used its two progressive auto-renames; a human rename pins, an agent rename bumps the counter.
// Table-driven; every row names its clause so a mutant of that clause turns exactly that row red.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  MAX_AUTO_RENAMES,
  decideRename,
  initialNaming,
  nudgeActive,
  pinAdvancesGate,
  pinFields,
  sanitizeBranchName,
  type NamingFields,
} from './naming-policy.ts';

const ws = (o: Partial<NamingFields> = {}): NamingFields & { id: string; branch: string } => ({
  id: 'ws-1',
  branch: 'witty-falcon',
  ...o,
});

describe('MAX_AUTO_RENAMES', () => {
  it('is two progressive renames (provisional, then refined)', () => {
    assert.equal(MAX_AUTO_RENAMES, 2);
  });
});

describe('nudgeActive — counter × human pin', () => {
  // [clause, fields, expected]
  const rows: Array<[string, Partial<NamingFields>, boolean]> = [
    ['counter absent (pre-upgrade record) = 0 ⇒ active', {}, true],
    ['counter 0 ⇒ active', { autoRenameCount: 0 }, true],
    ['counter 1 ⇒ active (refine stage)', { autoRenameCount: 1 }, true],
    ['counter 2 ⇒ retired', { autoRenameCount: 2 }, false],
    ['counter above the budget ⇒ retired', { autoRenameCount: 5 }, false],
    ['human pin, counter 0 ⇒ off', { branchManuallySet: true, autoRenameCount: 0 }, false],
    ['human pin, counter absent ⇒ off', { branchManuallySet: true }, false],
    ['human pin, counter 1 ⇒ off', { branchManuallySet: true, autoRenameCount: 1 }, false],
    ['human pin explicitly false, counter 1 ⇒ active', { branchManuallySet: false, autoRenameCount: 1 }, true],
  ];
  for (const [clause, fields, expected] of rows) {
    it(clause, () => assert.equal(nudgeActive(ws(fields)), expected));
  }
});

describe('initialNaming', () => {
  it('a workspace nobody named yet: only the unset human pin', () => {
    assert.deepEqual(initialNaming(), { branchManuallySet: false });
    assert.deepEqual(initialNaming({}), { branchManuallySet: false });
  });
  it('no namedByParent key at all (byte-identical record) unless an agent named it', () => {
    assert.equal('namedByParent' in initialNaming(), false);
    assert.equal('namedByParent' in initialNaming({ namedBy: undefined }), false);
    assert.equal('namedByParent' in initialNaming({ namedBy: '' }), false);
  });
  it('named at spawn by an agent (#382): carries the namer id, human pin still unset', () => {
    assert.deepEqual(initialNaming({ namedBy: 'parent-7' }), { branchManuallySet: false, namedByParent: 'parent-7' });
  });
  it('a fresh workspace starts with the nudge active', () => {
    assert.equal(nudgeActive({ ...initialNaming() }), true);
  });
});

describe('decideRename — today\'s rule on an unnamed workspace (no parent/namer in play)', () => {
  // [clause, target fields, caller, expected pin]
  const rows: Array<[string, Partial<NamingFields>, Parameters<typeof decideRename>[1], { manual: boolean; bumpAutoCount: boolean }]> = [
    ['human rename pins, no counter bump', {}, { kind: 'human' }, { manual: true, bumpAutoCount: false }],
    ['human rename mid-budget still pins and does not count', { autoRenameCount: 1 }, { kind: 'human' }, { manual: true, bumpAutoCount: false }],
    ['human rename of an already-pinned name', { branchManuallySet: true }, { kind: 'human' }, { manual: true, bumpAutoCount: false }],
    ['agent rename, counter 0 ⇒ counted, no pin', { autoRenameCount: 0 }, { kind: 'agent' }, { manual: false, bumpAutoCount: true }],
    ['agent rename, counter absent ⇒ counted', {}, { kind: 'agent' }, { manual: false, bumpAutoCount: true }],
    ['agent rename, counter 1 ⇒ counted (the refine)', { autoRenameCount: 1 }, { kind: 'agent' }, { manual: false, bumpAutoCount: true }],
    ['agent rename, counter 2 ⇒ on-demand, not counted', { autoRenameCount: 2 }, { kind: 'agent' }, { manual: false, bumpAutoCount: false }],
    ['agent rename after a human pin ⇒ lands, not counted, never pins', { branchManuallySet: true, autoRenameCount: 0 }, { kind: 'agent' }, { manual: false, bumpAutoCount: false }],
    ['agent with an id behaves like an anonymous agent (today)', { autoRenameCount: 1 }, { kind: 'agent', id: 'someone' }, { manual: false, bumpAutoCount: true }],
    ['agent with an id, budget spent', { autoRenameCount: 2 }, { kind: 'agent', id: 'someone' }, { manual: false, bumpAutoCount: false }],
  ];
  for (const [clause, fields, caller, pin] of rows) {
    it(clause, () => assert.deepEqual(decideRename(ws(fields), caller), { allow: true, pin }));
  }

  // The target's own parent renaming it is special since #383 — see rename-authority.test.ts (the full caller × pin-state grid).

  it('the agent arm reads nudgeActive: a decision never counts a rename the nudge would not', () => {
    for (const fields of [{}, { autoRenameCount: 1 }, { autoRenameCount: 2 }, { branchManuallySet: true }] as Partial<NamingFields>[]) {
      const d = decideRename(ws(fields), { kind: 'agent' });
      assert.ok(d.allow);
      if (d.allow) assert.equal(d.pin.bumpAutoCount, nudgeActive(ws(fields)));
    }
  });
});

describe('pinFields — what an allowed rename writes', () => {
  it('human pin: branchManuallySet true, no counter touch', () => {
    assert.deepEqual(pinFields(ws({ autoRenameCount: 1 }), { manual: true, bumpAutoCount: false }), { branchManuallySet: true });
  });
  it('counted agent rename: counter + 1 from absent', () => {
    assert.deepEqual(pinFields(ws(), { manual: false, bumpAutoCount: true }), { branchManuallySet: undefined, autoRenameCount: 1 });
  });
  it('counted agent rename: counter + 1 from 1', () => {
    assert.deepEqual(pinFields(ws({ autoRenameCount: 1 }), { manual: false, bumpAutoCount: true }), { branchManuallySet: undefined, autoRenameCount: 2 });
  });
  it('on-demand agent rename: touches no counter', () => {
    const f = pinFields(ws({ autoRenameCount: 2 }), { manual: false, bumpAutoCount: false });
    assert.equal('autoRenameCount' in f, false);
  });
  it('an agent rename never clears an existing human pin', () => {
    assert.equal(pinFields(ws({ branchManuallySet: true }), { manual: false, bumpAutoCount: false }).branchManuallySet, true);
  });
  it('namedByParent is written only when the pin carries one (#383)', () => {
    assert.equal('namedByParent' in pinFields(ws(), { manual: false, bumpAutoCount: false }), false);
    assert.equal(pinFields(ws(), { manual: false, bumpAutoCount: false, namedByParent: 'p1' }).namedByParent, 'p1');
  });
  it('a decision fed through pinFields: the end-to-end budget — three agent renames count two, then stop', () => {
    let f: NamingFields = {};
    const counted: boolean[] = [];
    for (let i = 0; i < 3; i++) {
      const d = decideRename({ id: 'x', branch: 'b', ...f }, { kind: 'agent' });
      assert.ok(d.allow);
      if (!d.allow) return;
      counted.push(d.pin.bumpAutoCount);
      f = { ...f, ...pinFields(f, d.pin) };
    }
    assert.deepEqual(counted, [true, true, false]);
    assert.equal(f.autoRenameCount, 2);
    assert.equal(nudgeActive(f), false);
  });
  it('a human rename retires the nudge for good, whatever the counter', () => {
    const d = decideRename(ws({ autoRenameCount: 0 }), { kind: 'human' });
    assert.ok(d.allow);
    if (!d.allow) return;
    assert.equal(nudgeActive({ autoRenameCount: 0, ...pinFields({ autoRenameCount: 0 }, d.pin) }), false);
  });
});

describe('pinAdvancesGate — does a same-name rename still have to persist its pin?', () => {
  const rows: Array<[string, Partial<NamingFields>, { manual: boolean; bumpAutoCount: boolean }, boolean]> = [
    ['first human pin ⇒ persist', {}, { manual: true, bumpAutoCount: false }, true],
    ['human pin on an already-pinned name ⇒ nothing to persist', { branchManuallySet: true }, { manual: true, bumpAutoCount: false }, false],
    ['counted agent rename ⇒ persist (the counter moves)', { autoRenameCount: 0 }, { manual: false, bumpAutoCount: true }, true],
    ['counted agent rename on a pinned name ⇒ persist (the counter still moves)', { branchManuallySet: true }, { manual: false, bumpAutoCount: true }, true],
    ['on-demand agent rename ⇒ nothing to persist', { autoRenameCount: 2 }, { manual: false, bumpAutoCount: false }, false],
  ];
  for (const [clause, fields, pin, expected] of rows) {
    it(clause, () => assert.equal(pinAdvancesGate(ws(fields), pin), expected));
  }
});

describe('sanitizeBranchName (moved verbatim from workspaces.ts)', () => {
  const rows: Array<[string, string, string]> = [
    ['trims and dashes whitespace runs', '  fix  the   bug ', 'fix-the-bug'],
    ['drops characters outside the allow-list', 'feat/x!@#$%^&*()y', 'feat/xy'],
    ['keeps dot, underscore, slash, dash', 'a.b_c/d-e', 'a.b_c/d-e'],
    ['caps at 80 chars', 'x'.repeat(100), 'x'.repeat(80)],
    ['keeps upper-case letters', 'Fix-ABC', 'Fix-ABC'],
    ['keeps digits', 'v2-0-9', 'v2-0-9'],
    ['empty stays empty', '   ', ''],
    ['accents are dropped, not transliterated', 'éa', 'a'],
  ];
  for (const [clause, input, out] of rows) {
    it(clause, () => assert.equal(sanitizeBranchName(input), out));
  }
});
