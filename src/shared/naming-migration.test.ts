// Planner of the parent-given-names migration (#385). External behaviour only: the plan for a given store.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  activeVagueMemberIds,
  planMigration,
  renderPlan,
  type MigrationInputs,
  type MigrationWorkspace,
  type PlanRow,
  type TableRow,
} from './naming-migration.ts';

const id = (n: string): string => `${n.padEnd(8, '0')}-0000-4000-8000-000000000000`;
const LEAD = id('1ead');
const OPS_RUNNING = id('0b5a');
const OPS_CLOSED = id('0b5c'); // archived OPS: its vague is over
const ws = (n: string, extra: Partial<MigrationWorkspace> = {}): MigrationWorkspace => ({ id: id(n), branch: `old-${n}`, ...extra });

/** A fixture store: a LEAD, a RUNNING vague (OPS + 2 workers), a CLOSED vague (archived OPS + 1 live worker) and every edge. */
function fixtureStore(): MigrationWorkspace[] {
  return [
    ws('1ead', { id: LEAD, branch: 'lead-main', kind: 'orchestrator' }),
    ws('0b5a', { id: OPS_RUNNING, branch: 'wave-g-ops', parentId: LEAD, canOrchestrate: true }),
    ws('w1', { parentId: OPS_RUNNING }), // member of the RUNNING vague
    ws('w2', { parentId: OPS_RUNNING }),
    ws('0b5c', { id: OPS_CLOSED, branch: 'wave-c-ops', parentId: LEAD, canOrchestrate: true, archived: true }),
    ws('w3', { parentId: OPS_CLOSED }), // member of the CLOSED vague
    ws('w4', { parentId: LEAD }), // a worker spawned straight under the LEAD: a mission member, not a vague one
    ws('w5', { parentId: LEAD }), // branch pushed to origin
    ws('h1'), // human-created: no spawner recorded
    ws('h2', { parentId: LEAD, branchManuallySet: true }), // a human typed its name
    ws('d1'), // no parent recorded at all, but the table lists it
    ws('d2', { parentId: id('dead') }), // parent deleted
    ws('a1', { parentId: LEAD, archived: true }),
    ws('n1', { parentId: LEAD }), // spawned, not in the table
    ws('p1', { namedByParent: LEAD }), // detached, already parent-named once
    ws('b1', { parentId: OPS_CLOSED, namedByParent: LEAD }), // both recorded: the spawner is asserted first
  ];
}
const NEW: Record<string, string> = {
  w1: 'impl-politique-nommage-381',
  w2: 'verif-politique-nommage-381',
  w3: 'review-fusion-comptes-240',
  w4: 'explo-rebuild-cli-timeout',
  w5: 'impl-garde-memoire-320',
  h2: 'impl-veille-reliquats-326',
  d1: 'impl-sans-parent-1',
  d2: 'impl-parent-supprime-2',
  a1: 'impl-archive-3',
  p1: 'impl-detache-nomme-4',
  b1: 'impl-les-deux-5',
};
const rowsFor = (keys: string[] = Object.keys(NEW)): TableRow[] => keys.map((k) => ({ id: id(k), old: `old-${k}`, new: NEW[k] }));

function inputs(over: Partial<MigrationInputs> = {}): MigrationInputs {
  const workspaces = over.workspaces ?? fixtureStore();
  return {
    workspaces,
    remoteBranches: new Set(['old-w5', 'master']),
    localBranches: new Set(['master']),
    activeVagueMembers: activeVagueMemberIds(workspaces),
    table: rowsFor(),
    ...over,
  };
}
const actionOf = (rows: PlanRow[], n: string): string => rows.find((r) => r.id === id(n))!.action;
const renamedIds = (p: ReturnType<typeof planMigration>): string[] => p.renames.map((r) => r.id).sort();

test('the full plan on the fixture store: one action per workspace, each with its reason', () => {
  const plan = planMigration(inputs({ table: rowsFor(Object.keys(NEW).filter((k) => k !== 'h2')) }));
  const got = Object.fromEntries(plan.rows.map((r) => [r.id.slice(0, 4), r.action]));
  assert.deepEqual(got, {
    '1ead': 'untouched-human',
    '0b5a': 'untouched-not-in-table',
    w100: 'skip-vague',
    w200: 'skip-vague',
    '0b5c': 'untouched-not-in-table',
    w300: 'rename',
    w400: 'rename',
    w500: 'skip-remote',
    h100: 'untouched-human',
    h200: 'untouched-not-in-table',
    d100: 'untouched-no-parent',
    d200: 'rename',
    a100: 'untouched-archived',
    n100: 'untouched-not-in-table',
    p100: 'rename',
    b100: 'rename',
  });
  assert.deepEqual(plan.rejected, []);
});

test('rename: applied AS the spawner (parentId first, else the namer), with the validated name', () => {
  const plan = planMigration(inputs());
  const by = Object.fromEntries(plan.renames.map((r) => [r.id, r]));
  assert.deepEqual(by[id('w3')], { id: id('w3'), from: 'old-w3', to: 'review-fusion-comptes-240', asParent: OPS_CLOSED, expectNamer: OPS_CLOSED });
  assert.equal(by[id('w4')].asParent, LEAD);
  assert.equal(by[id('p1')].asParent, LEAD, 'a detached child has no parentId: the namer is the identity');
  assert.equal(by[id('p1')].to, 'impl-detache-nomme-4');
  assert.equal(by[id('b1')].asParent, OPS_CLOSED, 'both recorded: parentId wins over namedByParent');
  assert.equal(by[id('b1')].expectNamer, LEAD, 'decideRename KEEPS the existing namer: the store must end with it, not with the parent we acted as');
});

test('skip (branch on origin): a pushed branch is listed and not renamed; a branch NOT on origin is', () => {
  const plan = planMigration(inputs());
  assert.equal(actionOf(plan.rows, 'w5'), 'skip-remote');
  assert.match(plan.rows.find((r) => r.id === id('w5'))!.reason, /old-w5.*origin/);
  assert.ok(!plan.renames.some((r) => r.id === id('w5')));
  const none = planMigration(inputs({ remoteBranches: new Set() }));
  assert.equal(actionOf(none.rows, 'w5'), 'rename', 'without the remote branch the same row plans a rename');
});

test('skip (active vague): the members of a running vague wait; a closed vague and a mission worker do not', () => {
  const plan = planMigration(inputs());
  assert.equal(actionOf(plan.rows, 'w1'), 'skip-vague');
  assert.equal(actionOf(plan.rows, 'w2'), 'skip-vague');
  assert.equal(actionOf(plan.rows, 'w3'), 'rename'); // its OPS is archived
  assert.equal(actionOf(plan.rows, 'w4'), 'rename'); // under the LEAD: a mission, not a vague
});

test('a workspace both on origin AND in a running vague is reported as skip (branch on origin): the permanent reason wins', () => {
  const plan = planMigration(inputs({ remoteBranches: new Set(['old-w1']) }));
  assert.equal(actionOf(plan.rows, 'w1'), 'skip-remote');
  const closed = planMigration(inputs({ remoteBranches: new Set(['old-w1']), activeVagueMembers: new Set() }));
  assert.equal(actionOf(closed.rows, 'w1'), 'skip-remote', 'closing the vague does not free a pushed branch');
});

test('plan after the vague closes: the operator declares it over and exactly that vague\'s members become renames', () => {
  const store = fixtureStore();
  const before = planMigration(inputs({ workspaces: store }));
  // The app has no close event, and archiving an OPS archives its whole subtree (then no rename is possible): the operator DECLARES the vague over while its members are still live.
  const declared = activeVagueMemberIds(store, new Set([OPS_RUNNING]));
  assert.equal(declared.size, 0);
  const after = planMigration(inputs({ workspaces: store, activeVagueMembers: declared }));
  const newly = renamedIds(after).filter((x) => !renamedIds(before).includes(x));
  assert.deepEqual(newly, [id('w1'), id('w2')].sort());
  assert.deepEqual(renamedIds(before).filter((x) => !renamedIds(after).includes(x)), [], 'nothing else changes');
  // declaring something that is not a running vague (a LEAD, a worker, an unknown id) changes nothing
  assert.deepEqual([...activeVagueMemberIds(store, new Set([LEAD, id('w1'), id('ffff')]))].sort(), [...activeVagueMemberIds(store)].sort());
});

test('after a CASCADE archive (what the app does to an archived OPS) the members are untouched (archived): rename BEFORE archiving', () => {
  const store = fixtureStore().map((w) => (w.id === OPS_RUNNING || w.parentId === OPS_RUNNING ? { ...w, archived: true } : w));
  const plan = planMigration(inputs({ workspaces: store }));
  assert.equal(actionOf(plan.rows, 'w1'), 'untouched-archived');
  assert.equal(actionOf(plan.rows, 'w2'), 'untouched-archived');
  assert.ok(!renamedIds(plan).includes(id('w1')));
});

test('untouched (human-created): no recorded spawner and no row; a row for it is listed as no-parent, never renamed', () => {
  const plan = planMigration(inputs());
  assert.equal(actionOf(plan.rows, 'h1'), 'untouched-human');
  assert.equal(actionOf(plan.rows, 'd1'), 'untouched-no-parent');
  assert.ok(!plan.renames.some((r) => r.id === id('h1') || r.id === id('d1')));
});

test('untouched (no parent to name it): no parentId and no namedByParent recorded', () => {
  const plan = planMigration(inputs());
  assert.equal(actionOf(plan.rows, 'd1'), 'untouched-no-parent');
  assert.match(plan.rows.find((r) => r.id === id('d1'))!.reason, /no parentId\/namedByParent/);
});

test('a parent that has left the store still names its child (the app compares ids only): renamed AS the recorded id', () => {
  const plan = planMigration(inputs());
  assert.equal(actionOf(plan.rows, 'd2'), 'rename');
  const step = plan.renames.find((r) => r.id === id('d2'))!;
  assert.equal(step.asParent, id('dead'));
  assert.match(plan.rows.find((r) => r.id === id('d2'))!.reason, /no longer in the store/);
  // an existing id is preferred when both are recorded and only one resolves
  const store = fixtureStore().map((w) => (w.id === id('d2') ? { ...w, namedByParent: LEAD } : w));
  assert.equal(planMigration(inputs({ workspaces: store })).renames.find((r) => r.id === id('d2'))!.asParent, LEAD);
});

test('already carrying the name: done only when ALSO parent-named; otherwise a pin-only rename to the same name', () => {
  const same = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: NEW.w3 } : w));
  const plan = planMigration(inputs({ workspaces: same }));
  const step = plan.renames.find((r) => r.id === id('w3'))!;
  assert.deepEqual([step.from, step.to, step.asParent], [NEW.w3, NEW.w3, OPS_CLOSED]);
  assert.match(plan.rows.find((r) => r.id === id('w3'))!.reason, /pin only/);
  const pinned = same.map((w) => (w.id === id('w3') ? { ...w, namedByParent: OPS_CLOSED } : w));
  assert.equal(actionOf(planMigration(inputs({ workspaces: pinned })).rows, 'w3'), 'done');
});

test('an ARCHIVED workspace\'s row can never block a run (only well-formedness is checked) nor steal a live row\'s name', () => {
  const store = fixtureStore().map((w) => (w.id === id('a1') ? { ...w, branchManuallySet: true } : w));
  const rowsA = [
    { id: id('a1'), old: 'stale-name', new: 'impl-meme-nom-7' }, // pinned + stale + same target as a live row
    { id: id('w3'), new: 'impl-meme-nom-7' },
  ];
  const plan = planMigration(inputs({ workspaces: store, table: rowsA }));
  assert.deepEqual(plan.rejected, []);
  assert.equal(actionOf(plan.rows, 'a1'), 'untouched-archived');
  assert.equal(actionOf(plan.rows, 'w3'), 'rename');
  const bad = planMigration(inputs({ workspaces: store, table: [{ id: id('a1'), new: 'not-a-role' }] }));
  assert.equal(bad.rejected[0].code, 'invalid-name', 'a malformed name is still a table error');
});

test('untouched (archived): the app refuses to rename an archived workspace', () => {
  assert.equal(actionOf(planMigration(inputs()).rows, 'a1'), 'untouched-archived');
});

test('rejected rows: an unknown workspace id', () => {
  const plan = planMigration(inputs({ table: [...rowsFor(['w3']), { id: id('ffff'), new: 'impl-fantome-9' }] }));
  assert.equal(plan.rejected.length, 1);
  assert.equal(plan.rejected[0].code, 'unknown-workspace');
  assert.equal(plan.rejected[0].index, 1);
  assert.deepEqual(renamedIds(plan), [id('w3')], 'the valid row is still planned (the SCRIPT refuses to apply on any rejection)');
});

test('rejected rows: a human-pinned target is refused BY THE APP\'S OWN decideRename (a human rename wins for good)', () => {
  const plan = planMigration(inputs());
  const r = plan.rejected.find((x) => x.id === id('h2'))!;
  assert.equal(r.code, 'refused-by-policy');
  assert.match(r.detail, /named by the human/);
  assert.equal(actionOf(plan.rows, 'h2'), 'row-rejected');
  assert.ok(!plan.renames.some((x) => x.id === id('h2')));
  // a human-pinned workspace with NO recorded spawner is a table error too (the question is asked of a hypothetical parent), not a quiet untouched row
  const lone = fixtureStore().map((w) => (w.id === id('d1') ? { ...w, branchManuallySet: true } : w));
  const p2 = planMigration(inputs({ workspaces: lone }));
  assert.equal(p2.rejected.find((x) => x.id === id('d1'))?.code, 'refused-by-policy');
  assert.equal(actionOf(p2.rows, 'd1'), 'row-rejected');
});

test('a migrated workspace that a human pins LATER (even to the same name) is still `done`: the re-run must not refuse forever', () => {
  const applied = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: NEW.w3, namedByParent: OPS_CLOSED, formerBranch: 'old-w3', branchManuallySet: true } : w));
  const plan = planMigration(inputs({ workspaces: applied, table: rowsFor(['w3']) }));
  assert.deepEqual(plan.rejected, []);
  assert.equal(actionOf(plan.rows, 'w3'), 'done');
  // but a pinned workspace that does NOT carry the target name is still refused
  const pinnedOther = applied.map((w) => (w.id === id('w3') ? { ...w, branch: 'impl-humain-1' } : w));
  assert.equal(planMigration(inputs({ workspaces: pinnedOther, table: rowsFor(['w3']) })).rejected[0]?.code, 'refused-by-policy');
});

test('rejected rows: an invalid name (no rôle prefix, empty, sanitised to nothing)', () => {
  for (const bad of ['politique-nommage-381', 'impl', 'impl-', '', '!!!', 'chef-politique-1']) {
    const plan = planMigration(inputs({ table: [{ id: id('w3'), new: bad }] }));
    assert.equal(plan.rejected[0]?.code, 'invalid-name', `"${bad}" must be rejected`);
    assert.equal(plan.renames.length, 0);
  }
  const ok = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl politique nommage 381' }] }));
  assert.equal(ok.rejected.length, 0);
  assert.equal(ok.renames[0].to, 'impl-politique-nommage-381', 'the planner uses the SANITISED name checkSpawnName returns');
});

test('rejected rows: collisions — duplicate target, duplicate row, an existing branch (local, remote, another workspace)', () => {
  const dupTarget = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl-x-1' }, { id: id('w4'), new: 'impl-x-1' }] }));
  assert.deepEqual(dupTarget.rejected.map((x) => x.code), ['duplicate-target', 'duplicate-target']);
  assert.equal(dupTarget.renames.length, 0, 'both are rejected: neither silently wins');

  const dupRow = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl-x-1' }, { id: id('w3'), new: 'impl-x-2' }] }));
  assert.deepEqual(dupRow.rejected.map((x) => x.code), ['duplicate-row', 'duplicate-row']);

  const local = planMigration(inputs({ localBranches: new Set(['impl-x-1']), table: [{ id: id('w3'), new: 'impl-x-1' }] }));
  assert.equal(local.rejected[0].code, 'name-taken');
  const remote = planMigration(inputs({ remoteBranches: new Set(['impl-x-1']), table: [{ id: id('w3'), new: 'impl-x-1' }] }));
  assert.equal(remote.rejected[0].code, 'name-taken');
  const named = fixtureStore().map((w) => (w.id === id('w4') ? { ...w, branch: 'impl-existing-4' } : w.id === id('a1') ? { ...w, branch: 'impl-old-a1' } : w));
  const other = planMigration(inputs({ workspaces: named, table: [{ id: id('w3'), new: 'impl-existing-4' }] }));
  assert.equal(other.rejected[0].code, 'name-taken', "another live workspace's current name");
  // a rename chain / swap cannot be applied in order: rejected, the human re-orders over two runs
  const swap = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl-a-1' }, { id: id('w4'), new: 'impl-b-1' }] }));
  assert.equal(swap.rejected.length, 0);
  const archivedBranch = planMigration(inputs({ workspaces: named, table: [{ id: id('w3'), new: 'impl-old-a1' }] }));
  assert.equal(archivedBranch.rejected.length, 0, 'an ARCHIVED workspace does not hold its old name');
});

test("rejected rows: a stale 'old' only once the workspace was PARENT-named differently; a legacy child that renamed ITSELF still applies", () => {
  const parentNamed = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: 'impl-par-le-parent-1', namedByParent: OPS_CLOSED } : w));
  const stale = planMigration(inputs({ workspaces: parentNamed, table: [{ id: id('w3'), old: 'old-w3', new: 'impl-x-1' }] }));
  assert.equal(stale.rejected[0].code, 'stale-old');
  // the legacy child renamed itself (nudge) between the validation and the run — e.g. it WON a race against a previous run: the id is the identity, the row applies
  const drifted = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: 'child-chose-this' } : w));
  const plan = planMigration(inputs({ workspaces: drifted, table: [{ id: id('w3'), old: 'old-w3', new: 'impl-x-1' }] }));
  assert.deepEqual(plan.rejected, []);
  assert.deepEqual(plan.renames.map((r) => [r.from, r.to]), [['child-chose-this', 'impl-x-1']]);
  assert.match(plan.rows.find((r) => r.id === id('w3'))!.reason, /renamed itself since the table \(was "old-w3"\)/);
  const noOld = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl-x-1' }] }));
  assert.equal(noOld.rejected.length, 0, "'old' is optional");
});

test('re-plan after the app SUFFIXED our name: our own earlier rename (formerBranch == old) is not a stale row; the target then decides', () => {
  const suffixed = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: `${NEW.w3}-2`, namedByParent: OPS_CLOSED, formerBranch: 'old-w3' } : w));
  // the target is taken by the branch that made the app suffix: a name-taken row, not stale-old
  const taken = planMigration(inputs({ workspaces: suffixed, localBranches: new Set([NEW.w3]), table: [{ id: id('w3'), old: 'old-w3', new: NEW.w3 }] }));
  assert.equal(taken.rejected[0]?.code, 'name-taken');
  // the other branch is gone: the re-run lands it
  const freed = planMigration(inputs({ workspaces: suffixed, table: [{ id: id('w3'), old: 'old-w3', new: NEW.w3 }] }));
  assert.deepEqual(freed.rejected, []);
  assert.deepEqual(freed.renames.map((r) => [r.from, r.to]), [[`${NEW.w3}-2`, NEW.w3]]);
  // parent-named by someone ELSE since (no formerBranch == old): still stale
  const other = suffixed.map((w) => (w.id === id('w3') ? { ...w, formerBranch: 'something-else' } : w));
  assert.equal(planMigration(inputs({ workspaces: other, table: [{ id: id('w3'), old: 'old-w3', new: NEW.w3 }] })).rejected[0]?.code, 'stale-old');
});

test('re-plan after a failed run: lost pin -> a pin-only rename; the child won with its own name -> a rename; a git-lock error (nothing changed) -> the rename again', () => {
  const store = fixtureStore().map((w) =>
    w.id === id('w3') ? { ...w, branch: NEW.w3 } // our name landed, the pin was lost
      : w.id === id('w4') ? { ...w, branch: 'child-chose-this' } // the child's own rename won
        : w);
  const plan = planMigration(inputs({ workspaces: store, table: rowsFor(['w3', 'w4']) }));
  assert.deepEqual(plan.rejected, []);
  const by = Object.fromEntries(plan.renames.map((r) => [r.id, r]));
  assert.equal(by[id('w3')].from, by[id('w3')].to, 'pin only');
  assert.deepEqual([by[id('w4')].from, by[id('w4')].to], ['child-chose-this', NEW.w4]);
  assert.equal(planMigration(inputs({ table: rowsFor(['w3', 'w4']) })).renames.length, 2, 'untouched old names plan the rename again');
});

test('rejected rows: git refs are files — a target that is a path-prefix of an existing branch is taken', () => {
  const a = planMigration(inputs({ localBranches: new Set(['impl-fix/sub']), table: [{ id: id('w3'), new: 'impl-fix' }] }));
  assert.equal(a.rejected[0].code, 'name-taken');
  const b = planMigration(inputs({ table: [{ id: id('w3'), new: 'impl-fix/sub' }] }));
  assert.equal(b.rejected[0].code, 'invalid-name', 'a target is flat: checkSpawnName refuses "/" before any clash is possible');
  const c = planMigration(inputs({ localBranches: new Set(['impl-fixer']), table: [{ id: id('w3'), new: 'impl-fix' }] }));
  assert.equal(c.rejected.length, 0, 'a common string prefix without the slash is not a ref conflict');
  // the workspace's OWN current branch never conflicts with its own rename (impl-fix/sub -> impl-fix frees the directory)
  const own = fixtureStore().map((w) => (w.id === id('w3') ? { ...w, branch: 'impl-fix/sub' } : w));
  const d = planMigration(inputs({ workspaces: own, localBranches: new Set(['impl-fix/sub']), table: [{ id: id('w3'), new: 'impl-fix' }] }));
  assert.equal(d.rejected.length, 0);
  assert.equal(d.renames[0]?.to, 'impl-fix');
});

test('rejected rows: a name git refuses is rejected at plan time by the naming policy (checkSpawnName), not mid-apply', () => {
  for (const bad of ['impl-fix..auth-9', 'impl-fix.lock', 'impl-fix-9.']) {
    const plan = planMigration(inputs({ table: [{ id: id('w3'), new: bad }] }));
    assert.equal(plan.rejected[0]?.code, 'invalid-name', bad);
    assert.equal(plan.renames.length, 0);
  }
});

test('idempotent: after a full apply the plan is empty; a second apply plans nothing either', () => {
  const store = fixtureStore();
  const validRows = rowsFor(Object.keys(NEW).filter((k) => k !== 'h2')); // h2's row is rejected by design
  const first = planMigration(inputs({ workspaces: store, table: validRows }));
  assert.ok(first.renames.length > 0);
  // What the app does for each applied step (#383/#384): the branch changes, the namer is pinned, the old name is kept.
  const applied = store.map((w) => {
    const step = first.renames.find((r) => r.id === w.id);
    return step ? { ...w, branch: step.to, namedByParent: step.asParent, formerBranch: step.from } : w;
  });
  const second = planMigration(inputs({ workspaces: applied, table: validRows }));
  assert.deepEqual(second.renames, []);
  for (const step of first.renames) assert.equal(second.rows.find((r) => r.id === step.id)!.action, 'done');
  assert.equal(second.rejected.length, 0, 'applied rows are not rejected as stale or as name-taken');
});

test('idempotent, vague close: re-running after the close plans exactly the deferred members, then nothing', () => {
  let store = fixtureStore();
  const apply = (p: ReturnType<typeof planMigration>): MigrationWorkspace[] =>
    store.map((w) => {
      const s = p.renames.find((r) => r.id === w.id);
      return s ? { ...w, branch: s.to, namedByParent: s.asParent, formerBranch: s.from } : w;
    });
  store = apply(planMigration(inputs({ workspaces: store })));
  const closeRun = planMigration(inputs({ workspaces: store, activeVagueMembers: activeVagueMemberIds(store, new Set([OPS_RUNNING])) }));
  assert.deepEqual(renamedIds(closeRun), [id('w1'), id('w2')].sort());
  store = apply(closeRun);
  assert.deepEqual(planMigration(inputs({ workspaces: store, activeVagueMembers: activeVagueMemberIds(store, new Set([OPS_RUNNING])) })).renames, []);
});

test('activeVagueMemberIds: a vague is a LIVE orchestrator with a parent and a live member below it', () => {
  const base = fixtureStore();
  assert.deepEqual([...activeVagueMemberIds(base)].sort(), [OPS_RUNNING, id('w1'), id('w2')].sort());
  // a mission (top-level orchestrator) is not a vague
  assert.ok(!activeVagueMemberIds(base).has(LEAD));
  // no live member left below the OPS → the vague is over
  const emptied = base.map((w) => (w.parentId === OPS_RUNNING ? { ...w, archived: true } : w));
  assert.equal(activeVagueMemberIds(emptied).size, 0);
  // a sandbox-hosted member is not a live LOCAL member
  const sandboxed = base.map((w) => (w.parentId === OPS_RUNNING ? { ...w, host: { kind: 'sandbox', endpoint: 'x' } as const } : w));
  assert.equal(activeVagueMemberIds(sandboxed).size, 0);
  // a plain (non-orchestrator) workspace with a parent and a live child is not a vague anchor
  const plain = [
    ...base,
    ws('pp', { parentId: LEAD }),
    ws('pc', { parentId: id('pp') }),
  ];
  assert.deepEqual([...activeVagueMemberIds(plain)].sort(), [...activeVagueMemberIds(base)].sort());
  // a dangling parent / a cycle must not hang or throw
  // an OPS whose parent has left the store is still a vague (the app keeps the run a vague): held is the safe side
  const orphanOps = [ws('o1', { parentId: id('gone'), canOrchestrate: true }), ws('o2', { parentId: id('o1') })];
  assert.deepEqual([...activeVagueMemberIds(orphanOps)].sort(), [id('o1'), id('o2')].sort());
  const cyc = [ws('c1', { parentId: id('c2'), canOrchestrate: true }), ws('c2', { parentId: id('c1'), canOrchestrate: true })];
  assert.doesNotThrow(() => activeVagueMemberIds(cyc));
});

test('renderPlan: a line per actionable workspace, the rejected rows, and the totals', () => {
  const text = renderPlan(planMigration(inputs())).join('\n');
  assert.match(text, /PLAN  w3000000  rename\s+old-w3 -> review-fusion-comptes-240/);
  assert.match(text, /skip \(branch on origin\)/);
  assert.match(text, /skip \(active vague\)/);
  assert.match(text, /untouched \(no parent to name it\)/);
  assert.match(text, /REJECTED  row \d+  h2000000  refused-by-policy/);
  assert.match(text, /TOTAL  16 workspace\(s\): 5 rename/);
  assert.doesNotMatch(text, /untouched \(human-created\)/, 'quiet classes are counted in TOTAL, not listed');
  const verbose = renderPlan(planMigration(inputs()), { verbose: true }).join('\n');
  assert.match(verbose, /untouched \(human-created\)/);
  assert.match(verbose, /untouched \(not in table\)/);
});

test('renderPlan allowGone: a row of a vanished workspace is reported as GONE and is not counted as rejected', () => {
  const plan = planMigration(inputs({ table: [...rowsFor(['w3']), { id: id('ffff'), new: 'impl-fantome-9' }] }));
  const strict = renderPlan(plan).join('\n');
  assert.match(strict, /REJECTED  row 2  ffff0000  unknown-workspace/);
  assert.match(strict, /1 rejected row\(s\)/);
  const lax = renderPlan(plan, { allowGone: true }).join('\n');
  assert.match(lax, /GONE  row 2  ffff0000/);
  assert.doesNotMatch(lax, /REJECTED/);
  assert.match(lax, /0 rejected row\(s\) · 1 gone/);
});

test('wiring: the planner validates names with the policy module (no second copy of the rôle rule)', () => {
  const src = fs.readFileSync(path.join(path.dirname(fileURLToPath(import.meta.url)), 'naming-migration.ts'), 'utf8');
  assert.match(src, /import \{ checkSpawnName, decideRename \} from '\.\/naming-policy\.ts'/);
  assert.doesNotMatch(src, /\.branchManuallySet|\.autoRenameCount/, 'the human pin is never read here: the verdict is decideRename\'s');
  assert.doesNotMatch(src, /ROLES|\bops\b.*\bimpl\b.*\bverif\b/, 'the rôle list lives in naming-policy.ts only');
});
