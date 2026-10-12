// #373: the phone list's tree — the pure module the page renders and nothing else (the page holds no tree logic).
import test from 'node:test';
import assert from 'node:assert/strict';
import { buildPhoneTree, type PhoneTreeNode, type TreeRow } from './acces-mobile-tree.ts';

const r = (id: string, over: Partial<TreeRow> = {}): TreeRow => ({ id, status: 'idle', unread: false, group: 'orchestra', ...over });
/** `id(kids…)` — the shape of a node, standing in for the rows below it. A stand-in is written `[id](…)`. */
const shape = (n: PhoneTreeNode): string => `${n.standIn ? `[${n.row.id}]` : n.row.id}${n.kids.length ? `(${n.kids.map(shape).join(' ')})` : ''}`;
const ids = (nodes: readonly PhoneTreeNode[]): string => nodes.map(shape).join(' ');
const flat = (n: PhoneTreeNode, out: string[] = []): string[] => { if (!n.standIn) out.push(n.row.id); n.kids.forEach((k) => flat(k, out)); return out; };
/** every row id the page can reach: En attente rows + the non-stand-in nodes of every group */
const reachable = (t: ReturnType<typeof buildPhoneTree>): string[] => [...t.waiting.map((w) => w.id), ...t.groups.flatMap((g) => g.roots.flatMap((n) => flat(n)))].sort();

test('three levels: a sub-coordinator has its own fold, depth grows one step per level, every row is there', () => {
  const t = buildPhoneTree([
    r('root', { group: 'Orchestrators' }),
    r('sub', { parentId: 'root' }),
    r('w1', { parentId: 'sub' }),
    r('w2', { parentId: 'sub' }),
    r('top-worker', { parentId: 'root' }),
    r('deep', { parentId: 'w2' }),
  ]);
  assert.equal(t.groups.length, 1);
  assert.equal(ids(t.groups[0].roots), 'root(sub(w1 w2(deep)) top-worker)');
  const root = t.groups[0].roots[0];
  assert.deepEqual([root.depth, root.kids[0].depth, root.kids[0].kids[1].depth, root.kids[0].kids[1].kids[0].depth], [0, 1, 2, 3]);
  assert.deepEqual(reachable(t), ['deep', 'root', 'sub', 'top-worker', 'w1', 'w2']);
});

test('counts: a fold counts its WHOLE subtree — agents, en cours, non lus — and nothing outside it', () => {
  const t = buildPhoneTree([
    r('root', { group: 'O' }),
    r('sub', { parentId: 'root', status: 'running' }),
    r('a', { parentId: 'sub', status: 'running' }),
    r('b', { parentId: 'sub', unread: true }),
    r('c', { parentId: 'b', status: 'running', unread: true }),
    r('z', { parentId: 'root', unread: true }),
  ]);
  const [root] = t.groups[0].roots;
  const sub = root.kids[0];
  assert.deepEqual([root.agents, root.running, root.unread], [5, 3, 3], 'root: sub a b c z · sub a c running · b c z unread');
  assert.deepEqual([sub.agents, sub.running, sub.unread], [3, 2, 2], 'sub: a b c · a c running · b c unread');
  assert.deepEqual([sub.kids[1].agents, sub.kids[1].running, sub.kids[1].unread], [1, 1, 1], 'b holds only c');
  assert.deepEqual([sub.kids[0].agents, sub.kids[0].running, sub.kids[0].unread], [0, 0, 0], 'a leaf counts nothing');
  assert.equal(t.groups[0].count, 6, 'the section counts every row it shows');
});

test('en attente at depth 2: lifted into En attente, never inside a fold; its descendants stay reachable under a stand-in at its place', () => {
  const t = buildPhoneTree([
    r('root', { group: 'O' }),
    r('sub', { parentId: 'root' }),
    r('ask', { parentId: 'sub', status: 'waiting' }),
    r('g1', { parentId: 'ask' }),
    r('g2', { parentId: 'ask', status: 'running' }),
    r('sib', { parentId: 'sub' }),
  ]);
  assert.deepEqual(t.waiting.map((w) => w.id), ['ask']);
  assert.equal(ids(t.groups[0].roots), 'root(sub([ask](g1 g2) sib))', 'the stand-in sits where ask was, with its own fold');
  const sub = t.groups[0].roots[0].kids[0];
  const standIn = sub.kids[0];
  assert.equal(standIn.standIn, true);
  assert.equal(standIn.depth, 2);
  assert.deepEqual([standIn.agents, standIn.running], [2, 1], 'the stand-in folds its descendants');
  assert.deepEqual([sub.agents, sub.running], [3, 1], 'sub: g1 g2 sib — ask itself is counted in En attente, not in a fold');
  assert.deepEqual(reachable(t), ['ask', 'g1', 'g2', 'root', 'sib', 'sub']);
});

test('a waiting row with nothing below it needs no stand-in: it is only in En attente; a waiting chain with no live row below it vanishes from the tree', () => {
  const t = buildPhoneTree([
    r('root', { group: 'O' }),
    r('w-leaf', { parentId: 'root', status: 'waiting' }),
    r('w-top', { parentId: 'root', status: 'waiting' }),
    r('w-mid', { parentId: 'w-top', status: 'waiting' }),
  ]);
  assert.deepEqual(t.waiting.map((w) => w.id), ['w-leaf', 'w-top', 'w-mid']);
  assert.equal(ids(t.groups[0].roots), 'root', 'no empty fold, no stand-in without anyone to hang under it');
  assert.equal(t.groups[0].roots[0].agents, 0);
});

test('a waiting ROOT with live descendants keeps a stand-in in its own repo section (the section exists for them)', () => {
  const t = buildPhoneTree([
    r('ask-root', { group: 'Orchestrators', status: 'waiting' }),
    r('kid', { group: 'orchestra', parentId: 'ask-root' }),
    r('plain', { group: 'orchestra' }),
  ]);
  assert.deepEqual(t.waiting.map((w) => w.id), ['ask-root']);
  assert.deepEqual(t.groups.map((g) => [g.group, ids(g.roots), g.count]), [['Orchestrators', '[ask-root](kid)', 1], ['orchestra', 'plain', 1]]);
});

test('a parent that is not in the rows is no parent: the row is a root (and so is one that names itself)', () => {
  const t = buildPhoneTree([r('orphan', { parentId: 'gone' }), r('me', { parentId: 'me' }), r('plain')]);
  assert.equal(ids(t.groups[0].roots), 'orphan me plain');
  assert.deepEqual(reachable(t), ['me', 'orphan', 'plain']);
});

test('cycle-safe: whatever the parent chain, every row appears exactly once', () => {
  const cases: Array<[string, TreeRow[], string]> = [
    ['2-cycle', [r('a', { parentId: 'b' }), r('b', { parentId: 'a' })], 'a(b)'],
    ['3-cycle', [r('a', { parentId: 'c' }), r('b', { parentId: 'a' }), r('c', { parentId: 'b' })], 'a(b(c))'],
    ['a tail hanging off a cycle', [r('a', { parentId: 'b' }), r('b', { parentId: 'a' }), r('t', { parentId: 'b' }), r('u', { parentId: 't' })], 'a(b(t(u)))'],
    ['a tail listed BEFORE its cycle stays hung under its parent, not a root', [r('d', { parentId: 'c' }), r('a', { parentId: 'c' }), r('b', { parentId: 'a' }), r('c', { parentId: 'b' })], 'c(d a(b))'],
    ['a tail listed after its cycle', [r('a', { parentId: 'c' }), r('b', { parentId: 'a' }), r('c', { parentId: 'b' }), r('d', { parentId: 'c' })], 'a(b(c(d)))'],
    ['two cycles + a clean tree', [r('a', { parentId: 'b' }), r('b', { parentId: 'a' }), r('x', { parentId: 'y' }), r('y', { parentId: 'x' }), r('p'), r('q', { parentId: 'p' })], 'a(b) x(y) p(q)'],
  ];
  for (const [what, rows, want] of cases) {
    const t = buildPhoneTree(rows);
    assert.equal(t.groups.map((g) => ids(g.roots)).join(' '), want, what);
    assert.deepEqual(reachable(t), rows.map((x) => x.id).sort(), `${what}: exactly once each`);
  }
});

test('cycle with en attente rows in it: still exactly once, the waiting ones in En attente', () => {
  const rows = [r('a', { parentId: 'b', status: 'waiting' }), r('b', { parentId: 'a' }), r('c', { parentId: 'b' })];
  const t = buildPhoneTree(rows);
  assert.deepEqual(reachable(t), ['a', 'b', 'c']);
  assert.deepEqual(t.waiting.map((w) => w.id), ['a']);
});

test('sections: repo groups in order of first appearance; a worker lives under its coordinator, in the coordinator\'s section', () => {
  const t = buildPhoneTree([
    r('p1', { group: 'perso' }),
    r('o1', { group: 'orchestra' }),
    r('coord', { group: 'Orchestrators' }),
    r('p2', { group: 'perso' }),
    r('w', { group: 'orchestra', parentId: 'coord' }),
  ]);
  assert.deepEqual(t.groups.map((g) => [g.group, ids(g.roots), g.count]), [['perso', 'p1 p2', 2], ['orchestra', 'o1', 1], ['Orchestrators', 'coord(w)', 2]]);
});

test('input order is kept among siblings, at every level (the page sorted the rows already)', () => {
  const t = buildPhoneTree([r('r'), r('k3', { parentId: 'r' }), r('k1', { parentId: 'r' }), r('k2', { parentId: 'r' }), r('g2', { parentId: 'k1' }), r('g1', { parentId: 'k1' })]);
  assert.equal(ids(t.groups[0].roots), 'r(k3 k1(g2 g1) k2)');
});

test('a deep chain does not overflow the stack (no recursion on the depth)', () => {
  const N = 20000;
  const rows = Array.from({ length: N }, (_, i) => r(`n${i}`, i ? { parentId: `n${i - 1}` } : {}));
  const t = buildPhoneTree(rows);
  assert.equal(t.groups[0].roots[0].agents, N - 1);
  let d = 0, n: PhoneTreeNode | undefined = t.groups[0].roots[0];
  while (n.kids[0]) { n = n.kids[0]; d++; }
  assert.equal(d, N - 1);
});

test('property: random forests with dangling parents, cycles, duplicates and waiting rows — exactly once, counts equal a brute-force recount', () => {
  let seed = 20261012;
  const rnd = (n: number) => { seed = (seed * 1664525 + 1013904223) % 4294967296; return seed % n; };
  for (let round = 0; round < 300; round++) {
    const n = 1 + rnd(14);
    const rows = Array.from({ length: n }, (_, i) =>
      r(`n${rnd(10) === 0 && i ? rnd(i) : i}`, {
        parentId: rnd(5) === 0 ? undefined : `n${rnd(n + 2)}`,
        status: ['idle', 'running', 'waiting', 'idle'][rnd(4)],
        unread: rnd(3) === 0,
        group: ['a', 'b', 'O'][rnd(3)],
      }));
    const t = buildPhoneTree(rows);
    const all = [...t.waiting.map((w) => w), ...t.groups.flatMap((g) => g.roots.flatMap(function nodes(x): TreeRow[] { return [...(x.standIn ? [] : [x.row]), ...x.kids.flatMap(nodes)]; }))];
    assert.equal(all.length, rows.length, `round ${round}: every row exactly once (${rows.map((x) => `${x.id}<${x.parentId}${x.status === 'waiting' ? '!' : ''}`).join(' ')})`);
    assert.equal(new Set(all).size, rows.length, `round ${round}: no row twice`);
    const check = (x: PhoneTreeNode): { agents: number; running: number; unread: number } => {
      const sum = { agents: 0, running: 0, unread: 0 };
      for (const k of x.kids) { const c = check(k); sum.agents += (k.standIn ? 0 : 1) + c.agents; sum.running += (!k.standIn && k.row.status === 'running' ? 1 : 0) + c.running; sum.unread += (!k.standIn && k.row.unread ? 1 : 0) + c.unread; assert.equal(k.depth, x.depth + 1); if (k.standIn) assert.ok(k.kids.length > 0 && k.row.status === 'waiting', 'a stand-in is a waiting row with something below it'); }
      assert.deepEqual([x.agents, x.running, x.unread], [sum.agents, sum.running, sum.unread], `round ${round}: counts of ${x.row.id}`);
      return sum;
    };
    t.groups.forEach((g) => g.roots.forEach(check));
  }
});

test('the toString-injected copy (what the phone page runs) agrees with the module', () => {
  const injected = new Function(`return (${buildPhoneTree.toString()})`)() as typeof buildPhoneTree;
  const rows = [r('root', { group: 'O' }), r('sub', { parentId: 'root' }), r('ask', { parentId: 'sub', status: 'waiting' }), r('g', { parentId: 'ask' }), r('a', { parentId: 'b' }), r('b', { parentId: 'a' })];
  assert.deepEqual(JSON.parse(JSON.stringify(injected(rows))), JSON.parse(JSON.stringify(buildPhoneTree(rows))));
});
