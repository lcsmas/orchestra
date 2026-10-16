// #383 — rename authority human > parent > child (ledger #387 D5, frozen v1). Table-driven: EVERY caller × EVERY pin
// state of the target, each cell naming the clause it pins so a mutant of that clause turns exactly those cells red
// (scripts/rename-authority-mutants.mjs). Pure: `decideRename` + `pinFields` only — the route/CLI/wiring arms live in
// src/main/rename-authority-wiring.test.ts and src/cli/rename-from.test.ts.
import { describe, it } from 'node:test';
import assert from 'node:assert/strict';
import {
  NAMED_BY_HUMAN_REFUSAL,
  decideRename,
  namedByParentRefusal,
  adoptedBranchPin,
  nudgeActive,
  pinAdvancesGate,
  pinFields,
  type NamingFields,
  type RenameCaller,
  type RenameDecision,
} from './naming-policy.ts';

const CHILD = 'child-1';
const PARENT = 'parent-1';
const SPAWNER = 'spawner-3'; // the namer of a --detached child (no parentId)
const OTHER = 'other-9';

type Target = NamingFields & { id: string; branch: string };
const target = (o: Partial<NamingFields> = {}): Target => Object.freeze({ id: CHILD, branch: 'impl-x-1', ...o });

// The pin states of the target (the four of the ticket + the variants D5 leaves implicit).
const STATES = {
  U: { parentId: PARENT }, // unnamed legacy agent: has a parent, nobody named it, no human pin
  'U-human-created': {}, // human-created workspace: no parent, no namer, no pin
  P: { parentId: PARENT, namedByParent: PARENT }, // named by its parent at spawn
  'P-detached': { namedByParent: SPAWNER }, // --detached child: the namer is the only parent-like id (D1)
  H: { parentId: PARENT, namedByParent: PARENT, branchManuallySet: true }, // parent-named, then the human renamed it
  'H-human-created': { branchManuallySet: true }, // human-created, human-renamed: today's behaviour
  'H-legacy-child': { parentId: PARENT, branchManuallySet: true }, // legacy agent the human renamed (D6: parent refused, the rest as today)
} satisfies Record<string, Partial<NamingFields>>;
type State = keyof typeof STATES;

const CALLERS = {
  human: { kind: 'human' },
  self: { kind: 'agent', id: CHILD },
  parent: { kind: 'agent', id: PARENT },
  spawner: { kind: 'agent', id: SPAWNER },
  other: { kind: 'agent', id: OTHER },
  unknown: { kind: 'agent' }, // an old CLI sends no `from`
  'empty-id': { kind: 'agent', id: '' },
} satisfies Record<string, RenameCaller>;
type Who = keyof typeof CALLERS;

// Expected outcomes.
const HUMAN: RenameDecision = { allow: true, pin: { manual: true, bumpAutoCount: false } };
const COUNTED: RenameDecision = { allow: true, pin: { manual: false, bumpAutoCount: true } }; // today, nudge active
const TODAY_QUIET: RenameDecision = { allow: true, pin: { manual: false, bumpAutoCount: false } }; // today, nudge off
const pinP = (by: string): RenameDecision => ({ allow: true, pin: { manual: false, bumpAutoCount: false, namedByParent: by } });
const REFUSE_P = (name?: string): RenameDecision => ({ allow: false, error: namedByParentRefusal(name) });
const REFUSE_H: RenameDecision = { allow: false, error: NAMED_BY_HUMAN_REFUSAL };

// [state, who] → expected. EVERY cell of the 7×7 grid is listed (checked complete below).
const GRID: Record<State, Record<Who, [clause: string, expected: RenameDecision]>> = {
  U: {
    human: ['human always allowed, pins manual', HUMAN],
    self: ['U + self: as today (counted while the nudge is active)', COUNTED],
    parent: ['U + parent: allowed and PINS P (namedByParent = caller), not counted', pinP(PARENT)],
    spawner: ['U + non-parent agent id: as today', COUNTED],
    other: ['U + other: as today', COUNTED],
    unknown: ['U + unknown caller (no from): as today', COUNTED],
    'empty-id': ['U + empty from: unknown, as today', COUNTED],
  },
  'U-human-created': {
    human: ['human always allowed, pins manual', HUMAN],
    self: ['human-created + self: keeps today\'s self-naming (counted)', COUNTED],
    parent: ['human-created + an id: as today (no parent exists to be special)', COUNTED],
    spawner: ['human-created + an id: as today', COUNTED],
    other: ['human-created + other: as today', COUNTED],
    unknown: ['human-created + unknown: as today', COUNTED],
    'empty-id': ['human-created + empty from: as today', COUNTED],
  },
  P: {
    human: ['human beats a parent-named workspace', HUMAN],
    self: ['P + self: REFUSED, ask your parent', REFUSE_P('par')],
    parent: ['P + parent: allowed, stays P, no counter bump', pinP(PARENT)],
    spawner: ['P + a non-parent agent: REFUSED', REFUSE_P('par')],
    other: ['P + other: REFUSED', REFUSE_P('par')],
    unknown: ['P + unknown (old CLI, no from): REFUSED', REFUSE_P('par')],
    'empty-id': ['P + empty from: REFUSED (never a parent)', REFUSE_P('par')],
  },
  'P-detached': {
    human: ['human beats a parent-named workspace', HUMAN],
    self: ['P-detached + self: REFUSED', REFUSE_P('par')],
    parent: ['P-detached + an id that is neither parentId nor namer: REFUSED', REFUSE_P('par')],
    spawner: ['P-detached + the NAMER (no parentId): allowed, stays P (D1)', pinP(SPAWNER)],
    other: ['P-detached + other: REFUSED', REFUSE_P('par')],
    unknown: ['P-detached + unknown: REFUSED (undefined !== the namer)', REFUSE_P('par')],
    'empty-id': ['P-detached + empty from: REFUSED', REFUSE_P('par')],
  },
  H: {
    human: ['human may rename a human-pinned workspace', HUMAN],
    self: ['H + self: REFUSED, named by the human', REFUSE_H],
    parent: ['H + parent: REFUSED — a human rename pins for everyone, parent included', REFUSE_H],
    spawner: ['H + a non-parent agent: REFUSED', REFUSE_H],
    other: ['H + other: REFUSED', REFUSE_H],
    unknown: ['H + unknown: REFUSED', REFUSE_H],
    'empty-id': ['H + empty from: REFUSED', REFUSE_H],
  },
  'H-human-created': {
    human: ['human may rename again', HUMAN],
    self: ['H on a human-created workspace + self: allowed as today (not counted: the nudge is off)', TODAY_QUIET],
    parent: ['H human-created + an id: as today', TODAY_QUIET],
    spawner: ['H human-created + an id: as today', TODAY_QUIET],
    other: ['H human-created + other: as today', TODAY_QUIET],
    unknown: ['H human-created + unknown: as today', TODAY_QUIET],
    'empty-id': ['H human-created + empty from: as today', TODAY_QUIET],
  },
  'H-legacy-child': {
    human: ['human may rename again', HUMAN],
    self: ['H without namedByParent + self: as today (only P-history or the parent is refused)', TODAY_QUIET],
    parent: ['H without namedByParent + the target\'s PARENT: REFUSED (D6 — a human rename pins for everyone, parent included)', REFUSE_H],
    spawner: ['H without namedByParent + an id: as today', TODAY_QUIET],
    other: ['H without namedByParent + other: as today', TODAY_QUIET],
    unknown: ['H without namedByParent + unknown: as today', TODAY_QUIET],
    'empty-id': ['H without namedByParent + empty from: as today', TODAY_QUIET],
  },
};

describe('decideRename — every caller × every pin state', () => {
  it('the grid is complete: 7 states × 7 callers', () => {
    assert.deepEqual(Object.keys(GRID).sort(), Object.keys(STATES).sort());
    for (const s of Object.keys(STATES) as State[]) assert.deepEqual(Object.keys(GRID[s]).sort(), Object.keys(CALLERS).sort(), s);
  });
  for (const s of Object.keys(STATES) as State[]) {
    for (const w of Object.keys(CALLERS) as Who[]) {
      const [clause, expected] = GRID[s][w];
      it(`[${s} × ${w}] ${clause}`, () => {
        // The refusal text carries the namer's name: feed 'par' wherever a P refusal is expected.
        const got = decideRename(target(STATES[s]), CALLERS[w], { parentName: 'par' });
        assert.deepEqual(got, expected);
      });
    }
  }
});

describe('decideRename — the refusal text (what the child reads)', () => {
  it('P refusal names the parent and tells the child to ask them to run `orchestra rename`', () => {
    const d = decideRename(target(STATES.P), CALLERS.self, { parentName: 'ops-nommage-parent-380' });
    assert.ok(!d.allow);
    if (d.allow) return;
    assert.match(d.error, /named by your parent \(ops-nommage-parent-380\)/);
    assert.match(d.error, /ask them to run `orchestra rename`/);
  });
  it('P refusal without a resolvable parent name drops the parenthesis, keeps the instruction', () => {
    const d = decideRename(target(STATES.P), CALLERS.self);
    assert.ok(!d.allow);
    if (d.allow) return;
    assert.match(d.error, /^named by your parent — ask them to run `orchestra rename`$/);
  });
  it('H refusal says "named by the human" — and does not send the child to its parent', () => {
    const d = decideRename(target(STATES.H), CALLERS.self);
    assert.ok(!d.allow);
    if (d.allow) return;
    assert.match(d.error, /^named by the human/);
    assert.doesNotMatch(d.error, /ask them/);
  });
  it('H wins over P when both are set: the parent gets the human text, not "ask them"', () => {
    const d = decideRename(target(STATES.H), CALLERS.parent, { parentName: 'par' });
    assert.ok(!d.allow);
    if (d.allow) return;
    assert.equal(d.error, NAMED_BY_HUMAN_REFUSAL);
  });
  it('an allowed decision carries no error and a refused one carries no pin', () => {
    const ok = decideRename(target(STATES.P), CALLERS.parent);
    assert.ok(ok.allow);
    assert.equal('error' in ok, false);
    const no = decideRename(target(STATES.P), CALLERS.self);
    assert.ok(!no.allow);
    assert.equal('pin' in no, false);
  });
});

describe('decideRename — authority clauses in isolation', () => {
  it('an absent caller id is never a parent, even when the target has no parentId (undefined === undefined)', () => {
    // U-human-created has no parentId and no namer: if `undefined === undefined` counted, this would pin P with an undefined namer.
    const d = decideRename(target({}), { kind: 'agent' });
    assert.deepEqual(d, COUNTED);
    // And on a detached P (parentId undefined) the unknown caller must not slip through as "the parent".
    assert.equal(decideRename(target({ namedByParent: SPAWNER }), { kind: 'agent' }).allow, false);
  });
  it('parent by parentId: caller === target.parentId', () => {
    const d = decideRename(target({ parentId: PARENT }), { kind: 'agent', id: PARENT });
    assert.deepEqual(d, pinP(PARENT));
  });
  it('parent by namer: caller === target.namedByParent even with a different parentId (re-attached child)', () => {
    const d = decideRename(target({ parentId: 'new-parent', namedByParent: SPAWNER }), { kind: 'agent', id: SPAWNER });
    assert.deepEqual(d, pinP(SPAWNER));
  });
  it('a re-attached child: the NEW parent may rename, the pin keeps the original namer (stays P)', () => {
    const d = decideRename(target({ parentId: 'new-parent', namedByParent: SPAWNER }), { kind: 'agent', id: 'new-parent' });
    assert.deepEqual(d, pinP(SPAWNER));
  });
  it('the target\'s own id is not parent authority: self on U is a plain counted rename', () => {
    assert.deepEqual(decideRename(target({ parentId: PARENT }), { kind: 'agent', id: CHILD }), COUNTED);
  });
  it('U + other agent is not special even when the target has a parent (only the parent is)', () => {
    assert.deepEqual(decideRename(target({ parentId: PARENT }), { kind: 'agent', id: OTHER }), COUNTED);
  });
  it('U with the budget spent: a non-parent rename lands, not counted (on-demand, as today)', () => {
    assert.deepEqual(decideRename(target({ parentId: PARENT, autoRenameCount: 2 }), CALLERS.self), TODAY_QUIET);
  });
  it('U mid-budget: a PARENT rename is not counted as the child\'s own auto-rename (the bug of #380)', () => {
    const d = decideRename(target({ parentId: PARENT, autoRenameCount: 1 }), CALLERS.parent);
    assert.ok(d.allow);
    if (d.allow) assert.equal(d.pin.bumpAutoCount, false);
  });
  it('U + parent pins P with the CALLER id (a migration impersonating the parent writes the parent)', () => {
    const d = decideRename(target({ parentId: PARENT }), CALLERS.parent);
    assert.ok(d.allow);
    if (d.allow) assert.equal(d.pin.namedByParent, PARENT);
  });
  it('P + parent re-asserts the existing namer, never a new id', () => {
    const d = decideRename(target({ parentId: 'p2', namedByParent: PARENT }), { kind: 'agent', id: 'p2' });
    assert.ok(d.allow);
    if (d.allow) assert.equal(d.pin.namedByParent, PARENT);
  });
  it('the human pin never carries namedByParent (a human rename KEEPS the namer, it does not rewrite it)', () => {
    for (const s of Object.keys(STATES) as State[]) {
      const d = decideRename(target(STATES[s]), CALLERS.human);
      assert.ok(d.allow);
      if (d.allow) assert.equal('namedByParent' in d.pin, false, s);
    }
  });
  it('the agent arm reads nudgeActive for the counted bit on every non-special cell', () => {
    for (const fields of [{}, { autoRenameCount: 1 }, { autoRenameCount: 2 }, { branchManuallySet: true }] as Partial<NamingFields>[]) {
      const d = decideRename(target(fields), CALLERS.other);
      assert.ok(d.allow);
      if (d.allow) assert.equal(d.pin.bumpAutoCount, nudgeActive(target(fields)));
    }
  });
  it('the policy is pure: the (frozen) target is never written', () => {
    for (const s of Object.keys(STATES) as State[]) for (const w of Object.keys(CALLERS) as Who[]) decideRename(target(STATES[s]), CALLERS[w]);
  });
});

// The whole story of the ticket, driven through decide → pinFields the way renameWorkspaceBranch applies a pin.
describe('lifecycle — decide → apply, the acceptance criteria end to end', () => {
  type Rec = NamingFields & { id: string; branch: string };
  const apply = (rec: Rec, caller: RenameCaller, branch: string, ctx = { parentName: 'ops-x' }): { rec: Rec; ok: boolean; error?: string } => {
    const d = decideRename(rec, caller, ctx);
    if (!d.allow) return { rec, ok: false, error: d.error };
    return { rec: { ...rec, branch, ...pinFields(rec, d.pin) }, ok: true };
  };

  it('AC1-3: spawned (P) → child self-rename refused, branch unchanged → parent rename lands → child cannot overwrite → human rename lands → both refused', () => {
    let rec: Rec = { id: CHILD, branch: 'impl-first-381', parentId: PARENT, namedByParent: PARENT, branchManuallySet: false };

    const selfTry = apply(rec, CALLERS.self, 'my-own-name');
    assert.equal(selfTry.ok, false);
    assert.match(selfTry.error ?? '', /named by your parent \(ops-x\) — ask them to run `orchestra rename`/);
    assert.equal(selfTry.rec.branch, 'impl-first-381', 'branch unchanged');
    assert.deepEqual(selfTry.rec, rec, 'nothing written');

    const parentTry = apply(rec, CALLERS.parent, 'impl-better-381');
    assert.equal(parentTry.ok, true);
    rec = parentTry.rec;
    assert.equal(rec.branch, 'impl-better-381');
    assert.equal(rec.autoRenameCount, undefined, 'a parent rename is never counted against the child');
    assert.equal(rec.namedByParent, PARENT);

    const overwrite = apply(rec, CALLERS.self, 'child-wins');
    assert.equal(overwrite.ok, false, 'the child cannot overwrite the parent\'s name');
    assert.equal(overwrite.rec.branch, 'impl-better-381');

    const humanTry = apply(rec, CALLERS.human, 'impl-human-381');
    assert.equal(humanTry.ok, true);
    rec = humanTry.rec;
    assert.equal(rec.branchManuallySet, true);
    assert.equal(rec.namedByParent, PARENT, 'the human rename keeps the namer');

    const parentAfter = apply(rec, CALLERS.parent, 'parent-again');
    const childAfter = apply(rec, CALLERS.self, 'child-again');
    assert.equal(parentAfter.ok, false);
    assert.equal(childAfter.ok, false);
    assert.match(parentAfter.error ?? '', /^named by the human/);
    assert.match(childAfter.error ?? '', /^named by the human/);
    assert.equal(childAfter.rec.branch, 'impl-human-381');
  });

  it('AC4: a human-created workspace keeps today\'s self-naming — two counted renames, then on-demand, always allowed', () => {
    let rec: Rec = { id: CHILD, branch: 'witty-falcon' };
    const counted: boolean[] = [];
    for (const name of ['first', 'second', 'third']) {
      const r = apply(rec, CALLERS.self, name);
      assert.equal(r.ok, true, name);
      counted.push(r.rec.autoRenameCount !== rec.autoRenameCount);
      rec = r.rec;
    }
    assert.deepEqual(counted, [true, true, false]);
    assert.equal(rec.branch, 'third');
    assert.equal(rec.namedByParent, undefined, 'a self-rename never pins P');
    assert.equal(nudgeActive(rec), false);
  });

  it('D2/#385: a legacy agent (U) renamed by its parent becomes P — it can then no longer rename itself', () => {
    let rec: Rec = { id: CHILD, branch: 'q9-research-h1', parentId: PARENT, autoRenameCount: 2 };
    assert.equal(apply(rec, CALLERS.self, 'whatever').ok, true, 'before: a legacy agent renames freely');
    const migrated = apply(rec, CALLERS.parent, 'review-session-survives-cap-kills');
    assert.equal(migrated.ok, true);
    rec = migrated.rec;
    assert.equal(rec.namedByParent, PARENT);
    assert.equal(apply(rec, CALLERS.self, 'whatever').ok, false, 'after: refused');
  });

  it('D6: a human rename of a legacy agent (U) pins H without inventing a namer; the PARENT is then refused (the migration cannot undo a human name), the agent itself is not', () => {
    let rec: Rec = { id: CHILD, branch: 'old', parentId: PARENT };
    rec = apply(rec, CALLERS.human, 'human-name').rec;
    assert.equal(rec.branchManuallySet, true);
    assert.equal(rec.namedByParent, undefined);
    const p = apply(rec, CALLERS.parent, 'parent-name');
    assert.equal(p.ok, false);
    assert.match(p.error ?? '', /^named by the human/);
    assert.equal(p.rec.branch, 'human-name');
    assert.equal(apply(rec, CALLERS.self, 'agent-name').ok, true, 'self on a legacy H stays allowed as today');
  });
});

describe('pinAdvancesGate — a same-name rename still persists a parent\'s pin (#383)', () => {
  it('same-name parent rename of an unnamed child: the first pin changes the record', () => {
    assert.equal(pinAdvancesGate(target({ parentId: PARENT }), { manual: false, bumpAutoCount: false, namedByParent: PARENT }), true);
  });
  it('same-name parent rename of an already parent-named child: nothing to persist', () => {
    assert.equal(pinAdvancesGate(target(STATES.P), { manual: false, bumpAutoCount: false, namedByParent: PARENT }), false);
  });
  it('a pin carrying a DIFFERENT namer changes the record', () => {
    assert.equal(pinAdvancesGate(target(STATES.P), { manual: false, bumpAutoCount: false, namedByParent: 'p2' }), true);
  });
  it('an agent on-demand rename (no pin at all) persists nothing', () => {
    assert.equal(pinAdvancesGate(target({}), { manual: false, bumpAutoCount: false }), false);
  });
});

describe('adoptedBranchPin — what an out-of-band `git branch -m` pins (a child must not mint a human pin)', () => {
  const rows: Array<[string, Partial<NamingFields>, { manual: boolean; bumpAutoCount: boolean }]> = [
    ['P (parent-named, not human-pinned): the name is adopted but NOT pinned — the parent can still rename it', STATES.P, { manual: false, bumpAutoCount: false }],
    ['P-detached: same', STATES['P-detached'], { manual: false, bumpAutoCount: false }],
    ['U legacy child: today\'s human pin', STATES.U, { manual: true, bumpAutoCount: false }],
    ['U human-created: today\'s human pin (a human\'s terminal rename)', STATES['U-human-created'], { manual: true, bumpAutoCount: false }],
    ['H already human-pinned and parent-named: stays pinned', STATES.H, { manual: true, bumpAutoCount: false }],
    ['H human-created: stays pinned', STATES['H-human-created'], { manual: true, bumpAutoCount: false }],
  ];
  for (const [clause, fields, pin] of rows) it(clause, () => assert.deepEqual(adoptedBranchPin(target(fields)), pin));
  it('the adopted pin never touches the counter or the namer', () => {
    for (const s of Object.keys(STATES) as State[]) assert.equal('namedByParent' in adoptedBranchPin(target(STATES[s])), false, s);
  });
  it('end to end: a refused child that `git branch -m`s itself leaves the parent in charge (P kept, no human pin)', () => {
    let rec: NamingFields & { id: string; branch: string } = { id: CHILD, branch: 'impl-x-1', parentId: PARENT, namedByParent: PARENT };
    assert.equal(decideRename(rec, CALLERS.self, { parentName: 'ops' }).allow, false);
    rec = { ...rec, branch: 'child-picked', ...pinFields(rec, adoptedBranchPin(rec)) };
    assert.equal(rec.branchManuallySet, undefined, 'no human pin minted');
    assert.deepEqual(decideRename(rec, CALLERS.parent), pinP(PARENT), 'the parent can still rename it');
    assert.equal(decideRename(rec, CALLERS.self, { parentName: 'ops' }).allow, false, 'and the child is still refused');
  });
});
