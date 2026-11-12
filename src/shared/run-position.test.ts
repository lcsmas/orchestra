// #432: the run-position module's contract + the grep gate (scripts/check-run-position-single-reader.mjs)
// on the real tree AND on throwaway copies that reintroduce a second reader in each shape (a gate that cannot
// fail proves nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs script, no types
import { verdict, selfTest, PARENT_PICK_FILES } from '../../scripts/check-run-position-single-reader.mjs';
import { coordinates, coordinatorOf, coordinatorRoleOf, isCoordinatorKind, memberRunOf, runIdOf, parentRunOf, isPlainOwnAnchor, COORDINATOR_HOOK_GATE, type RunNode } from './run-position.ts';

const root = path.resolve(import.meta.dirname, '../..');

// ─── the contract (#434: a plain parent OWNS a run; membership = the DIRECT parent) ───
const tree = (nodes: RunNode[]) => {
  const m = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => m.get(id);
};
const lead: RunNode = { id: 'lead', kind: 'orchestrator' };
const ops: RunNode = { id: 'ops', parentId: 'lead', kind: 'worktree', ownsRun: true };
const worker: RunNode = { id: 'w', parentId: 'ops', kind: 'worktree' };
const loner: RunNode = { id: 'solo', kind: 'worktree' }; // top-level plain: owns its mission
const kid: RunNode = { id: 'kid', parentId: 'solo', kind: 'worktree' };
const lk = tree([lead, ops, worker, loner, kid]);

test('coordinates: owns a run = the orchestrator kind, ownsRun, or top-level; a plain member never', () => {
  assert.equal(coordinates(lead), true);
  assert.equal(coordinates(ops), true, 'ownsRun');
  assert.equal(coordinates(loner), true, 'a top-level workspace owns its mission from birth');
  assert.equal(coordinates(worker), false);
  assert.equal(coordinates({ id: 's', kind: 'scratch', parentId: 'p' }), false);
  assert.equal(coordinates({ id: 'f', kind: 'worktree', parentId: 'p', canOrchestrate: true } as RunNode), false, 'the capability flag no longer decides');
  assert.equal(isCoordinatorKind(lead), true);
  assert.equal(isCoordinatorKind(ops), false, 'the KIND route only');
  assert.equal(coordinatorRoleOf(lead), 'pure');
  assert.equal(coordinatorRoleOf(ops), 'dual');
});

test('runIdOf: its own run when it owns one, else its DIRECT parent\'s (never the first orchestrator ancestor)', () => {
  assert.equal(runIdOf(lead, lk), 'lead');
  assert.equal(runIdOf(ops, lk), 'ops');
  assert.equal(runIdOf(worker, lk), 'ops');
  assert.equal(runIdOf(kid, lk), 'solo', 'a child of a plain parent is a member of the parent\'s run');
  const grand: RunNode = { id: 'g', parentId: 'w', kind: 'worktree' };
  assert.equal(runIdOf(grand, tree([lead, ops, worker, grand])), 'w', 'direct parent, not the OPS two levels up');
  assert.equal(runIdOf({ id: 'x', parentId: 'gone', kind: 'worktree' }, lk), 'x', 'a broken link never throws');
  const cyc = tree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]);
  assert.equal(runIdOf({ id: 'a', parentId: 'b' }, cyc), 'b', 'a cycle is one step, never a loop');
});

test('coordinatorOf / memberRunOf: who coordinates ws = its resolved direct parent; none for top-level or a dangling link', () => {
  assert.equal(coordinatorOf(worker, lk)?.id, 'ops');
  assert.equal(coordinatorOf(ops, lk)?.id, 'lead', 'an OPS is a MEMBER of its parent\'s run');
  assert.equal(coordinatorOf(kid, lk)?.id, 'solo');
  assert.equal(coordinatorOf(lead, lk), undefined);
  assert.equal(coordinatorOf({ id: 'x', parentId: 'gone' }, lk), undefined);
  assert.equal(coordinatorOf({ id: 'me', parentId: 'me' }, tree([{ id: 'me', parentId: 'me' }])), undefined, 'never its own coordinator');
  assert.equal(memberRunOf(ops, lk), 'lead');
  assert.equal(memberRunOf(lead, lk), null);
});

test('parentRunOf: the run ws is a member of = its direct parent; implicit only when that parent owns no row yet', () => {
  assert.deepEqual(parentRunOf(ops, lk), { id: 'lead', implicit: false });
  assert.deepEqual(parentRunOf(lead, lk), { id: null, implicit: false });
  assert.deepEqual(parentRunOf({ id: 'k2', parentId: 'solo', kind: 'worktree', ownsRun: true }, lk), { id: 'solo', implicit: false }, 'a top-level parent owns a mission');
  assert.deepEqual(parentRunOf({ id: 'k2', parentId: 'kid', kind: 'worktree', ownsRun: true }, lk), { id: 'kid', implicit: true }, 'a legacy plain parent with no row');
  assert.deepEqual(parentRunOf({ id: 'k2', parentId: 'kid', kind: 'worktree' }, lk, (id) => id === 'kid'), { id: 'kid', implicit: false });
  assert.equal(isPlainOwnAnchor({ id: 'x', parentId: 'gone', kind: 'worktree' }, lk), true, 'only a dangling-parent plain workspace');
  assert.equal(isPlainOwnAnchor(loner, lk), false);
  assert.equal(isPlainOwnAnchor(lead, lk), false);
});

test('the hook gate text is the exact shell the standing reminder and the edit guard run', () => {
  assert.equal(
    COORDINATOR_HOOK_GATE,
    'sentinel="${ORCHESTRA_WORKTREE:-.}/.orchestra/.orchestrator"\n[ "${ORCHESTRA_KIND:-}" = "orchestrator" ] || [ -f "$sentinel" ] || exit 0',
  );
});

// ─── the grep gate ───
function withTree(edit: (dir: string) => void): { clean: boolean; problems: string[]; outside: Array<{ file: string }> } {
  const tmp = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'run-position-test-'));
  try {
    fs.cpSync(path.join(root, 'src'), path.join(tmp, 'src'), { recursive: true });
    edit(tmp);
    return verdict(tmp);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}
const append = (rel: string, text: string) => (dir: string) => fs.appendFileSync(path.join(dir, 'src', rel), text);

test('the real tree is CLEAN and the scan sees the module\'s own reads (positive control)', () => {
  const v = verdict(root);
  assert.deepEqual(v.problems, []);
  assert.ok(v.inModule.length >= 2 && v.outside.length === 0);
});

test('the script self-test passes', () => {
  assert.equal(selfTest(root).ok, true, selfTest(root).why);
});

test('MUTANT: a flag read outside the module is DIRTY', () => {
  const v = withTree(append('main/activity.ts', '\nconst a = (w: any) => w.canOrchestrate === true;\n'));
  assert.equal(v.clean, false);
  assert.ok(v.outside.some((h) => h.file === 'src/main/activity.ts'));
});

test('MUTANT: a kind read outside the module is DIRTY (the pre-#432 shape of attach/ordering code)', () => {
  assert.equal(withTree(append('main/activity.ts', "\nconst b = (w: any) => w.kind === 'orchestrator';\n")).clean, false);
  assert.equal(withTree(append('renderer/store.ts', "\nconst c = (w: any) => w.kind !== 'orchestrator';\n")).clean, false);
});

test('MUTANT: a re-introduced canOrchestrate() helper call is DIRTY', () => {
  assert.equal(withTree(append('main/activity.ts', '\nconst d = (w: any) => canOrchestrate(w);\n')).clean, false);
});

test('MUTANT: a hook gate on ORCHESTRA_KIND re-inlined in a shell script is DIRTY', () => {
  assert.equal(withTree(append('main/activity.ts', '\nconst e = `[ "\\${ORCHESTRA_KIND:-}" = "orchestrator" ] || exit 0`;\n')).clean, false);
});

test('MUTANT: reversed / switch / destructured / bracket shapes are DIRTY', () => {
  for (const code of [
    "const g = (w: any) => 'orchestrator' === w.kind;",
    "const h = (w: any) => { switch (w.kind) { case 'orchestrator': return 1; } };",
    'const i = (w: any) => { const { canOrchestrate } = w; return canOrchestrate; };',
    "const j = (w: any) => w['canOrchestrate'];",
  ]) assert.equal(withTree(append('main/activity.ts', `\n${code}\n`)).clean, false, code);
});

test('MUTANT (#434): an `ownsRun` read outside the module is DIRTY', () => {
  assert.equal(withTree(append('main/activity.ts', '\nconst o = (w: any) => w.ownsRun === true;\n')).clean, false);
});

test('MUTANT (#434, the #432 review blind spots): a multi-line destructure and an alias of `.kind` are DIRTY', () => {
  assert.equal(withTree(append('main/activity.ts', '\nconst p = (w: any) => {\n  const {\n    kind,\n    ownsRun,\n  } = w;\n  return ownsRun || kind;\n};\n')).clean, false, 'multi-line destructure');
  assert.equal(withTree(append('main/activity.ts', "\nconst q = (w: any) => { const kk = w.kind; return kk === 'orchestrator'; };\n")).clean, false, 'alias of .kind');
  assert.equal(withTree(append('main/activity.ts', "\nconst r = (w: any) => ['orchestrator'].includes(w.kind);\n")).clean, false, 'array literal');
});

test('MUTANT (#434): a coordinator pick from `.parentId` in a routed file (liveness roster, watchdog, vague roster, admission-wake, naming-migration…) is DIRTY', () => {
  for (const f of PARENT_PICK_FILES as string[]) {
    assert.equal(withTree(append(f.replace(/^src\//, ''), '\nconst pp = (w: any) => w.parentId;\n')).clean, false, f);
  }
});

test('a marker exempts ITS line only, never the next one', () => {
  const v = withTree(append('main/activity.ts', "\nconst k = (w: any) => w.kind === 'orchestrator'; // run-position: non-run — t\nconst l = (w: any) => w.kind === 'orchestrator';\n"));
  assert.equal(v.clean, false);
});

test('a non-run read carrying the marker is allowed; a comment naming the flag is not a read', () => {
  const v = withTree(append('main/activity.ts', "\nconst f = (w: any) => w.kind === 'orchestrator'; // run-position: non-run — test\n// w.canOrchestrate\n"));
  assert.equal(v.clean, true);
});

test('positive control bites: a module that stopped reading the flag (blind pattern) is DIRTY, not vacuously clean', () => {
  const v = withTree((dir) => {
    const f = path.join(dir, 'src/shared/run-position.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('ws.ownsRun === true', 'ws.flagX === true'));
  });
  assert.equal(v.clean, false);
  assert.match(v.problems.join(), /positive control/);
});
