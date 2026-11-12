// #432: the run-position module's contract + the grep gate (scripts/check-run-position-single-reader.mjs)
// on the real tree AND on throwaway copies that reintroduce a second reader in each shape (a gate that cannot
// fail proves nothing).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
// @ts-expect-error — plain .mjs script, no types
import { verdict, selfTest } from '../../scripts/check-run-position-single-reader.mjs';
import { coordinates, isCoordinatorKind, runIdOf, parentRunOf, isPlainOwnAnchor, COORDINATOR_HOOK_GATE, type RunNode } from './run-position.ts';

const root = path.resolve(import.meta.dirname, '../..');

// ─── the contract (today's semantics behind the frozen names) ───
const tree = (nodes: RunNode[]) => {
  const m = new Map(nodes.map((n) => [n.id, n]));
  return (id: string) => m.get(id);
};
const lead: RunNode = { id: 'lead', kind: 'orchestrator' };
const ops: RunNode = { id: 'ops', parentId: 'lead', kind: 'worktree', canOrchestrate: true };
const worker: RunNode = { id: 'w', parentId: 'ops', kind: 'worktree' };
const loner: RunNode = { id: 'solo', kind: 'worktree' };
const kid: RunNode = { id: 'kid', parentId: 'solo', kind: 'worktree' };
const lk = tree([lead, ops, worker, loner, kid]);

test('coordinates: the orchestrator kind OR the capability flag, never a plain worktree/scratch', () => {
  assert.equal(coordinates(lead), true);
  assert.equal(coordinates(ops), true);
  assert.equal(coordinates(worker), false);
  assert.equal(coordinates({ id: 's', kind: 'scratch' }), false);
  assert.equal(isCoordinatorKind(lead), true);
  assert.equal(isCoordinatorKind(ops), false, 'the KIND route only: a promoted worktree carries the flag, not the kind');
});

test('runIdOf: self if coordinating, else the nearest coordinating ancestor, else own id', () => {
  assert.equal(runIdOf(lead, lk), 'lead');
  assert.equal(runIdOf(ops, lk), 'ops');
  assert.equal(runIdOf(worker, lk), 'ops');
  assert.equal(runIdOf(kid, lk), 'kid', 'no coordinator above → its own run');
  assert.equal(runIdOf({ id: 'x', parentId: 'gone', kind: 'worktree' }, lk), 'x', 'a broken link never throws');
  const cyc = tree([{ id: 'a', parentId: 'b' }, { id: 'b', parentId: 'a' }]);
  assert.equal(runIdOf({ id: 'a', parentId: 'b' }, cyc), 'a', 'a cycle is bounded');
});

test('parentRunOf: first coordinating/anchoring ancestor, else the implicit direct parent, else null', () => {
  assert.deepEqual(parentRunOf(ops, lk), { id: 'lead', implicit: false });
  assert.deepEqual(parentRunOf(lead, lk), { id: null, implicit: false });
  assert.deepEqual(parentRunOf({ id: 'k2', parentId: 'solo', kind: 'worktree', canOrchestrate: true }, lk), { id: 'solo', implicit: true });
  assert.deepEqual(parentRunOf({ id: 'k2', parentId: 'solo', kind: 'worktree' }, lk, (id) => id === 'solo'), { id: 'solo', implicit: false });
  assert.equal(isPlainOwnAnchor(loner, lk), true);
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

test('a non-run read carrying the marker is allowed; a comment naming the flag is not a read', () => {
  const v = withTree(append('main/activity.ts', "\nconst f = (w: any) => w.kind === 'orchestrator'; // run-position: non-run — test\n// w.canOrchestrate\n"));
  assert.equal(v.clean, true);
});

test('positive control bites: a module that stopped reading the flag (blind pattern) is DIRTY, not vacuously clean', () => {
  const v = withTree((dir) => {
    const f = path.join(dir, 'src/shared/run-position.ts');
    fs.writeFileSync(f, fs.readFileSync(f, 'utf8').replace('ws.canOrchestrate === true', 'ws.flagX === true'));
  });
  assert.equal(v.clean, false);
  assert.match(v.problems.join(), /positive control/);
});
