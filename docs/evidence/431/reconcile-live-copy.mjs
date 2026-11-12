// #431 NOT VERIFIED #1 — drive the REAL app-start reconcile (src/main/bus-run-close.ts) over COPIES of the live bus + store.
// usage: node --experimental-strip-types reconcile-live-copy.mjs <scratchDir>   (scratchDir holds bus.sqlite [online backup], store.json, peers.txt)
// Never opens anything outside <scratchDir>. PUBLIC repo: prints/writes ids (8 hex) / kinds / states / counts ONLY — never a workspace name.
import fs from 'node:fs';
import path from 'node:path';
import Database from 'better-sqlite3';
import { openBus } from '../../../src/main/bus.ts';
import { reconcileRunClosureFromStore } from '../../../src/main/bus-run-close.ts';
import { startRunsForParentless, startRunsForOwners } from '../../../src/main/bus-run-anchor.ts';
import { startRun, getRun, refreezeRun } from '../../../src/main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../../../src/shared/bus-switches.ts';

const S = path.resolve(process.argv[2]);
if (!S.includes('reconcile-431')) throw new Error('refusing: scratch dir must be a reconcile-431 scratch');
const store = JSON.parse(fs.readFileSync(path.join(S, 'store.json'), 'utf8'));
const WS = store.workspaces ?? [];
const stateOf = (id) => { const w = WS.find((x) => x.id === id); return !w ? 'absent' : w.archived ? 'archived' : 'live'; };
const peers = fs.readFileSync(path.join(S, 'peers.txt'), 'utf8').split('\n').filter(Boolean).map((l) => l.split(/\s+/)[0]);

function table(file) {
  const d = new Database(file, { readonly: true });
  const rows = d.prepare('SELECT id, kind, coordinator, parent_run_id, closed_at FROM runs ORDER BY created_at').all();
  d.close();
  return rows;
}
function fresh(tag) { const f = path.join(S, `work-${tag}.sqlite`); fs.copyFileSync(path.join(S, 'bus.sqlite'), f); return f; }
function reconcile(file, ws, count) {
  const db = openBus(file); // real open + migrate, on the COPY
  try { return reconcileRunClosureFromStore(db, (id) => ws.find((w) => w.id === id), count); } finally { db.close(); }
}
const out = { store: { workspaces: WS.length, archived: WS.filter((w) => w.archived).length } };

// ── A. full store (what the app start sees) ──
const fA = fresh('A');
const before = table(fA);
const rA = reconcile(fA, WS, WS.length);
const after = table(fA);
const row = (r) => ({ run: r.id.slice(0, 8), kind: r.kind, coord: r.coordinator.slice(0, 8), state: stateOf(r.coordinator), open: r.closed_at === null });
out.A = { skipped: rA.skipped, closed: rA.closed.map((i) => i.slice(0, 8)), reopened: rA.reopened,
  openBefore: before.filter((r) => r.closed_at === null).length, openAfter: after.filter((r) => r.closed_at === null).length, total: after.length,
  rows: after.map((r) => ({ ...row(r), wasOpen: before.find((b) => b.id === r.id).closed_at === null })) };

// ── B. cross-check against `orchestra peers` ──
const byId = new Map(after.map((r) => [r.id, r]));
const ownedBy = (id) => after.filter((r) => r.coordinator === id);
out.B = peers.map((id) => {
  const w = WS.find((x) => x.id === id);
  const owned = ownedBy(id);
  const parentRuns = w?.parentId ? ownedBy(w.parentId) : [];
  const v = [];
  if (!w) v.push('peer not in store');
  for (const r of owned) if (r.closed_at !== null) v.push(`own run ${r.id.slice(0, 8)} CLOSED`);
  if (w?.parentId && parentRuns.length === 0) v.push(`parent ${w.parentId.slice(0, 8)} owns no run row`);
  for (const r of parentRuns) if (r.closed_at !== null) v.push(`parent run ${r.id.slice(0, 8)} CLOSED`);
  return { id: id.slice(0, 8), ownsRunRows: owned.length, ownOpen: owned.every((r) => r.closed_at === null), parent: w?.parentId ? w.parentId.slice(0, 8) : null, parentRunOpen: w?.parentId ? parentRuns.length > 0 && parentRuns.every((r) => r.closed_at === null) : null, violations: v };
});
for (const must of ['c76c3fc2-1a17-464d-a962-179ef9213472', '577f3bb3-0efd-4ea8-85f1-a29149daa381']) out.B.push({ mustBeOpen: must.slice(0, 8), present: byId.has(must), open: byId.get(must)?.closed_at === null });

// ── C. partial store: keep k workspaces (first k in file order; and LEAD+OPS+first other), on a copy of the copy ──
out.C = [];
for (const [label, keep] of [
  ['k=0 (floor)', []],
  ['k=1 first-in-file', WS.slice(0, 1)],
  ['k=3 first-in-file', WS.slice(0, 3)],
  ['k=3 LEAD+OPS+1', ['c76c3fc2-1a17-464d-a962-179ef9213472', '577f3bb3-0efd-4ea8-85f1-a29149daa381'].map((i) => WS.find((w) => w.id === i)).concat(WS.find((w) => !['c76c3fc2-1a17-464d-a962-179ef9213472', '577f3bb3-0efd-4ea8-85f1-a29149daa381'].includes(w.id) && !w.archived))],
  ['k=3 last-in-file', WS.slice(-3)],
]) {
  const f = fresh('C'); const b = table(f);
  const liveCoordsBefore = b.filter((r) => r.closed_at === null && stateOf(r.coordinator) === 'live').length;
  const r = reconcile(f, keep, keep.length);
  const a = table(f);
  const closedLive = r.closed.filter((id) => stateOf(a.find((x) => x.id === id).coordinator) === 'live');
  // recovery: the next start with the FULL store
  const r2 = reconcile(f, WS, WS.length);
  const a2 = table(f);
  out.C.push({ label, skipped: r.skipped, closedTotal: r.closed.length, closedOfLiveCoordinators: closedLive.length, liveRunsOpenBefore: liveCoordsBefore,
    closedLiveRuns: closedLive.map((id) => id.slice(0, 8)),
    recovery: { reopened: r2.reopened.length, closed: r2.closed.length, openAfterRecovery: a2.filter((x) => x.closed_at === null).length, equalsFullStoreResult: JSON.stringify(a2.map((x) => [x.id, x.closed_at === null])) === JSON.stringify(after.map((x) => [x.id, x.closed_at === null])) } });
  if (label === 'k=3 first-in-file') fs.copyFileSync(f, path.join(S, 'truncated-closed.sqlite')); // for the CLI mail drive (state right after the truncated reconcile)
  if (label === 'k=3 first-in-file') { const g = fresh('Ctr'); reconcile(g, keep, keep.length); fs.renameSync(g, path.join(S, 'truncated-closed.sqlite')); }
  fs.rmSync(f);
}

// ── D. the REAL start order on a copy: #433 top-level sweep → #434 owner sweep → reconcile (index.ts:488-491), then the peers cross-check ──
{
  const f = fresh('D'); const b = table(f);
  // mirror of store.load()'s in-memory ownsRun migration (store.ts ~156-160) — the sweeps read `coordinates(ws)`
  const nodes = JSON.parse(JSON.stringify(WS));
  const parentsOfSomeone = new Set(nodes.map((w) => w.parentId).filter(Boolean)); const known = new Set(nodes.map((w) => w.id));
  for (const w of nodes) if (!w.ownsRun && (w.canOrchestrate === true || parentsOfSomeone.has(w.id) || (w.parentId && !known.has(w.parentId)))) w.ownsRun = true;
  const lookup = (id) => nodes.find((w) => w.id === id);
  const db = openBus(f);
  const deps = { getBus: () => db, startRun, getRun, refreezeRun, getLiveSwitches: () => DEFAULT_BUS_SWITCHES, warn: (m) => console.error('WARN', m) };
  const live = nodes.filter((w) => !w.archived && w.host?.kind !== 'sandbox');
  const s1 = startRunsForParentless(deps, live, lookup);
  const s2 = startRunsForOwners(deps, live, lookup);
  const rr = reconcileRunClosureFromStore(db, lookup, nodes.length);
  db.close();
  const a = table(f); const byId2 = new Map(a.map((r) => [r.id, r]));
  const stillMissing = []; const viol = [];
  const all = peers.concat(['verif-reconcile-self']);
  for (const id of peers) {
    const w = lookup(id); const own = a.filter((r) => r.coordinator === id);
    if (own.some((r) => r.closed_at !== null)) viol.push(`${id.slice(0,8)} own run closed`);
    const pr = w.parentId ? a.filter((r) => r.coordinator === w.parentId) : [];
    if (w.parentId && (pr.length === 0 || pr.some((r) => r.closed_at !== null))) viol.push(`${id.slice(0,8)} parent run missing/closed`);
    if (!w.parentId && own.length === 0) stillMissing.push(id.slice(0,8));
  }
  out.D = { sweepTopLevelStarted: s1.map((i) => i.slice(0,8)), sweepOwnersStarted: s2.map((i) => i.slice(0,8)), reconcile: { closed: rr.closed.length, reopened: rr.reopened.length, skipped: rr.skipped },
    runsBefore: b.length, runsAfter: a.length, openBefore: b.filter((r) => r.closed_at === null).length, openAfter: a.filter((r) => r.closed_at === null).length,
    newRowsOpen: a.filter((r) => !b.find((x) => x.id === r.id)).every((r) => r.closed_at === null), violations: viol, parentlessPeersWithNoRowAfter: stillMissing,
    mustBeOpen: ['c76c3fc2-1a17-464d-a962-179ef9213472', '577f3bb3-0efd-4ea8-85f1-a29149daa381'].map((i) => ({ id: i.slice(0,8), open: byId2.get(i)?.closed_at === null })) };
  fs.rmSync(f);
}
fs.writeFileSync(path.join(S, 'result.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify({ D: out.D }, null, 1));
