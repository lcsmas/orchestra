// Accès mobile #373: the phone list as a TREE. Pure — the page injects `buildPhoneTree.toString()` and renders what it returns,
// nothing else (no tree logic in the page). ONE self-contained function (no outer reference, no recursion on the depth), like
// `pairingTokenFrom`: the phone runs this exact source.

/** The fields of a projected phone row the tree reads (`MobileWorkspaceRow` satisfies it). */
export interface TreeRow {
  id: string;
  /** The row's parent = its nearest LISTED ancestor (resolved by `projectMobileWorkspaces`); unknown / itself / absent ⇒ a root. */
  parentId?: string;
  status: string;
  unread: boolean;
  /** The repo section a ROOT is filed under. */
  group: string;
}

export interface PhoneTreeNode<R extends TreeRow = TreeRow> {
  row: R;
  /** 0 for a root, +1 per level. A stand-in occupies its row's level. */
  depth: number;
  /** A row that is en attente but has live rows below it: it is listed in « En attente », and this node only holds their place
   *  (a header line + its fold) — it is not an agent of the fold it sits in. */
  standIn: boolean;
  kids: PhoneTreeNode<R>[];
  /** The WHOLE subtree under this node (any depth): the rows a fold shows, a stand-in not counted — an en attente agent counts in
   *  « En attente », never in a fold. */
  agents: number;
  running: number;
  unread: number;
}

export interface PhoneTreeGroup<R extends TreeRow = TreeRow> {
  group: string;
  /** Every row the section shows (roots + all their descendants, stand-ins excluded). */
  count: number;
  roots: PhoneTreeNode<R>[];
}

export interface PhoneTree<R extends TreeRow = TreeRow> {
  /** « En attente »: every waiting row, whatever its depth, in input order. */
  waiting: R[];
  /** Repo sections in order of first appearance; a root's section is its own `group`. */
  groups: PhoneTreeGroup<R>[];
}

/** Build the tree from the projected rows (already sorted for display; sibling order = input order).
 *  - parent = `parentId` when that row exists (and is not the row itself); otherwise the row is a root;
 *  - CYCLE-SAFE: every row appears exactly once, whatever the chains — a row no root reaches (it sits in / below a cycle) becomes a
 *    root itself, in input order, its own parent link dropped;
 *  - an en attente row is lifted out of the tree (it is in `waiting`); if live rows hang below it, a STAND-IN keeps their place;
 *  - no recursion on the depth: a 20 000-deep chain is fine. */
export function buildPhoneTree<R extends TreeRow>(rows: readonly R[]): PhoneTree<R> {
  var n = rows.length;
  var i: number, k: number, x: number, c: number;
  var first: Record<string, number> = Object.create(null);
  for (i = 0; i < n; i++) if (first[rows[i].id] === undefined) first[rows[i].id] = i;
  // children by parent link, in input order
  var kidsOf: number[][] = [];
  var parentOf: number[] = [];
  for (i = 0; i < n; i++) kidsOf.push([]);
  for (i = 0; i < n; i++) {
    var pid = rows[i].parentId;
    var p = pid === undefined ? undefined : first[pid];
    parentOf.push(p !== undefined && p !== i ? p : -1);
    if (p !== undefined && p !== i) kidsOf[p].push(i);
  }
  // pre-order walk from every natural root; then, for each row still unseen (it sits in or below a cycle), climb its parent links
  // to the first row met twice — a member of the cycle — and make THAT row a root: a tail hanging off a cycle stays hung under its parent
  var seen: boolean[] = [];
  var depth: number[] = [];
  var order: number[] = [];
  var roots: number[] = [];
  function walk(start: number): void {
    roots.push(start);
    depth[start] = 0;
    var stack = [start];
    while (stack.length) {
      var cur = stack.pop() as number;
      if (seen[cur]) continue;
      seen[cur] = true;
      order.push(cur);
      for (var j = kidsOf[cur].length - 1; j >= 0; j--) {
        var kid = kidsOf[cur][j];
        if (!seen[kid]) { depth[kid] = depth[cur] + 1; stack.push(kid); }
      }
    }
  }
  for (i = 0; i < n; i++) if (parentOf[i] < 0) walk(i);
  var climbed: number[] = [];
  for (i = 0; i < n; i++) {
    if (seen[i]) continue;
    x = i;
    while (climbed[x] !== i + 1) { climbed[x] = i + 1; x = parentOf[x]; } // every unseen row has an unseen parent: the climb ends on a cycle
    walk(x);
  }
  roots.sort(function (a, b) { return a - b; });
  // bottom-up (a node comes after its parent in `order`, so the reverse sees children first)
  var nodes: Array<PhoneTreeNode<R> | undefined> = [];
  for (k = order.length - 1; k >= 0; k--) {
    x = order[k];
    var agents = 0, running = 0, unread = 0;
    var kids: PhoneTreeNode<R>[] = [];
    for (var m = 0; m < kidsOf[x].length; m++) {
      c = kidsOf[x][m];
      // undefined for (a) en attente with nobody live below — only in « En attente » — and (b) the link a cycle broke: it leads to a
      // row that comes EARLIER in `order` (a walk's start), hence is built LATER here
      var child = nodes[c];
      if (!child) continue;
      kids.push(child);
      if (!child.standIn) { agents += 1; if (child.row.status === 'running') running += 1; if (child.row.unread) unread += 1; }
      agents += child.agents; running += child.running; unread += child.unread;
    }
    var waiting = rows[x].status === 'waiting';
    if (waiting && !kids.length) continue; // leaves nodes[x] undefined
    nodes[x] = { row: rows[x], depth: depth[x], standIn: waiting, kids: kids, agents: agents, running: running, unread: unread };
  }
  var out: PhoneTree<R> = { waiting: [], groups: [] };
  for (i = 0; i < n; i++) if (rows[i].status === 'waiting') out.waiting.push(rows[i]);
  var byGroup: Record<string, PhoneTreeGroup<R>> = Object.create(null);
  for (i = 0; i < roots.length; i++) {
    var node = nodes[roots[i]];
    if (!node) continue;
    var g = byGroup[node.row.group];
    if (!g) { g = byGroup[node.row.group] = { group: node.row.group, count: 0, roots: [] }; out.groups.push(g); }
    g.roots.push(node);
    g.count += (node.standIn ? 0 : 1) + node.agents;
  }
  return out;
}
