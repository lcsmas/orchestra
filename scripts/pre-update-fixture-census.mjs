// #442 prep — READ-ONLY census of "which workspace has a run" over an ORCHESTRA_HOME
// (store.json + bus.sqlite). Shared by the fixture builder (self-check) and the packaged-app rig
// (before/after arms). Opens the bus readonly + query_only; never writes, never checkpoints.
//
//   ownRun   a `runs` row with id == ws.id (the run the ws coordinates)
//   inRun    ownRun, or an ancestor (parentId chain) has ownRun
//   runless  neither — the gap #431 closes. Criterion for "every workspace has a run" is the
//            ticket's (#433/#434): this reports BOTH counts so the proof can pick, not invent.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';

/** better-sqlite3 bound to THIS runtime's ABI: node_modules may hold the Electron build (after a package build), so prefer build/bus-abi/…-abi<N>.node (build:bus-abi). */
export function loadSqlite() {
  const require = createRequire(import.meta.url);
  const Base = require('better-sqlite3');
  const f = path.join(path.dirname(new URL(import.meta.url).pathname), '..', 'build', 'bus-abi', `better_sqlite3-abi${process.versions.modules}.node`);
  if (!fs.existsSync(f)) return Base;
  return class Db extends Base { constructor(file, opts = {}) { super(file, { ...opts, nativeBinding: f }); } };
}

export function censusHome(home, { betterSqlite }) {
  const store = JSON.parse(fs.readFileSync(path.join(home, 'userData', 'orchestra', 'store.json'), 'utf8'));
  const Database = betterSqlite;
  const db = new Database(path.join(home, 'bus.sqlite'), { readonly: true, fileMustExist: true });
  db.pragma('query_only = 1');
  try {
    const runs = db.prepare('SELECT r.id, r.kind, r.coordinator, r.parent_run_id AS parent, r.closed_at AS closedAt, f.flags FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id').all();
    const runById = new Map(runs.map((r) => [r.id, r]));
    const byId = new Map(store.workspaces.map((w) => [w.id, w]));
    const own = (id) => runById.has(id);
    const inRun = (w) => {
      for (let cur = w, n = 0; cur && n < 64; cur = byId.get(cur.parentId), n++) if (own(cur.id)) return true;
      return false;
    };
    const rows = store.workspaces.map((w) => ({ id: w.id, name: w.name, parentId: w.parentId ?? null, ownRun: own(w.id), inRun: inRun(w) }));
    const deliveryOff = runs.filter((r) => { try { return JSON.parse(r.flags ?? '{}').delivery !== true; } catch { return true; } }).map((r) => r.id);
    // Unread = mail with no delivery lot covering it for its recipient (delivery-OFF runs never take lots).
    const unread = db.prepare(
      `SELECT m.run_id AS run, m.recipient AS recipient, COUNT(*) AS n FROM messages m
        WHERE m.recipient IS NOT NULL AND NOT EXISTS (SELECT 1 FROM deliveries d WHERE d.run_id = m.run_id AND d.reader = m.recipient AND d.to_seq >= m.sequence AND d.acked_at IS NOT NULL)
        GROUP BY m.run_id, m.recipient`).all();
    return {
      workspaces: rows.length,
      runs: runs.length,
      runlessOwn: rows.filter((r) => !r.ownRun).map((r) => r.name),
      runlessIn: rows.filter((r) => !r.inRun).map((r) => r.name),
      deliveryOffRuns: deliveryOff,
      unreadByRun: unread,
      runRows: runs.map((r) => ({ id: r.id, kind: r.kind, parent: r.parent, closedAt: r.closedAt, flags: r.flags })),
    };
  } finally {
    db.close();
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const home = process.argv[2];
  if (!home) { console.error('usage: pre-update-fixture-census.mjs <ORCHESTRA_HOME>'); process.exit(2); }
  const require = createRequire(import.meta.url);
  console.log(JSON.stringify(censusHome(home, { betterSqlite: loadSqlite() }), null, 2));
}
