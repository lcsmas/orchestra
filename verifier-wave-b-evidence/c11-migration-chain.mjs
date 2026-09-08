#!/usr/bin/env node
/**
 * C11 rig — the migration chain applies cleanly from EVERY intermediate version.
 *
 * Method: build a DB as it genuinely existed at version N by applying ONLY
 * migrations 1..N (extracted from the tree under test), stamping user_version=N,
 * then running the real migrate() and asserting the FULL expected table set is
 * present AND queryable. Compared against the fresh-file arm, which is the
 * vacuous one on its own.
 *
 * Usage: node c11-migration-chain.mjs <repoRoot>
 * RC 0 = PASS, 1 = FAIL, 20 = rig could not run (never read as a pass).
 */
import { mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import path from 'node:path';

const repo = path.resolve(process.argv[2] || process.cwd());
const busPathTs = path.join(repo, 'src/main/bus.ts');

let mod, Database;
try {
  mod = await import(busPathTs);
  Database = (await import(path.join(repo, 'node_modules/better-sqlite3/lib/index.js'))).default;
} catch (e) {
  console.error('RIG_CANNOT_RUN import failed:', e.message);
  process.exit(20);
}
const { SCHEMA_VERSION, migrate } = mod;
if (typeof migrate !== 'function' || typeof SCHEMA_VERSION !== 'number') {
  console.error('RIG_CANNOT_RUN: bus.ts does not export migrate/SCHEMA_VERSION');
  process.exit(20);
}

// Extract each migration's SQL. CRITICAL: for versions ALREADY SHIPPED we must
// use the SHIPPED SQL (from the baseline ref), not the candidate's copy of it.
// A candidate that FOLDS its new table into an existing migration would other-
// wise be invisible: the rig would build the "v1" DB with the folded table
// already in it and see nothing missing -- measured, this rig returned PASS on
// exactly that defect before the fix (self-test arm B, 2026-09-07).
// BASELINE_REF is the sha whose migrations are already on users' disks.
const { execFileSync } = await import('node:child_process');
const BASELINE_REF = process.env.C11_BASELINE_REF || 'b88c846';
const src = await import('node:fs').then(fs => fs.readFileSync(busPathTs, 'utf8'));
let shippedSrc = '';
try {
  shippedSrc = execFileSync('git', ['show', `${BASELINE_REF}:src/main/bus.ts`], { cwd: repo, encoding: 'utf8' });
} catch (e) {
  console.error(`RIG_CANNOT_RUN: cannot read baseline ${BASELINE_REF}: ${e.message}`);
  process.exit(20);
}
const migStart = src.indexOf('const MIGRATIONS');
if (migStart < 0) { console.error('RIG_CANNOT_RUN: MIGRATIONS map not found'); process.exit(20); }
function parseMigrations(text, label) {
  const at = text.indexOf('const MIGRATIONS');
  if (at < 0) return null;
  const body = text.slice(at);
  const out = new Map();
  const rx = /(\d+)\s*:\s*`([\s\S]*?)`\s*,?\s*(?=\n\s*(?:\d+\s*:|\}))/g;
  let mm;
  while ((mm = rx.exec(body)) !== null) out.set(Number(mm[1]), mm[2]);
  console.log(`  ${label}: migrations [${[...out.keys()].sort((a,b)=>a-b).join(', ')}]`);
  return out;
}
const candidateMigs = parseMigrations(src, 'candidate');
const shippedMigs = parseMigrations(shippedSrc, `shipped@${BASELINE_REF}`);
if (!candidateMigs || !shippedMigs) { console.error('RIG_CANNOT_RUN: MIGRATIONS map not found'); process.exit(20); }
// Build intermediate DBs from SHIPPED SQL where it exists; fall back to the
// candidate's only for versions the baseline never had.
const perVersion = new Map(candidateMigs);
for (const [v, sql] of shippedMigs) perVersion.set(v, sql);

// Collision guard (OPS-B ruling): a candidate that REWRITES a shipped migration
// is a FAIL, not a renumber -- users already ran the old bytes.
for (const [v, sql] of shippedMigs) {
  if (candidateMigs.has(v) && candidateMigs.get(v) !== sql) {
    console.log(`FAIL  migration v${v} DIFFERS from shipped @${BASELINE_REF} — a shipped migration was edited; users who already ran v${v} will NEVER get the change`);
    process.exitCode = 1;
    globalThis.__c11_collision = true;
  }
}

const found = [...perVersion.keys()].sort((a, b) => a - b);
console.log(`SCHEMA_VERSION under test = ${SCHEMA_VERSION}`);
console.log(`effective migration set: [${found.join(', ')}]`);
if (found.length !== SCHEMA_VERSION) {
  console.error(`RIG_CANNOT_RUN: extracted ${found.length} migrations but SCHEMA_VERSION=${SCHEMA_VERSION} — parser drifted from the source shape`);
  process.exit(20);
}

let failures = globalThis.__c11_collision ? 1 : 0;
const log = (ok, msg) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${msg}`); if (!ok) failures++; };
const newDb = (tag) => {
  const dir = mkdtempSync(join(tmpdir(), `vb-c11-${tag}-`));
  const db = new Database(join(dir, 'bus.db'));
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  return { db, dir };
};
const tablesOf = (db) => db.prepare(
  "SELECT name FROM sqlite_master WHERE type='table' AND name NOT LIKE 'sqlite_%' ORDER BY name"
).all().map(r => r.name);

// ── Reference: the fresh-file arm (vacuous alone; it defines `expected`) ──
const { db: fdb, dir: fdir } = newDb('fresh');
migrate(fdb);
const expected = tablesOf(fdb);
const freshVersion = fdb.pragma('user_version', { simple: true });
fdb.close(); rmSync(fdir, { recursive: true, force: true });
console.log(`FRESH arm: user_version=${freshVersion}, ${expected.length} tables: ${expected.join(', ')}`);
log(expected.length > 0, 'fresh-file arm creates at least one table (positive control: the rig can see tables)');
log(freshVersion === SCHEMA_VERSION, `fresh-file arm reaches SCHEMA_VERSION (${freshVersion})`);

// ── THE GATE: start from every intermediate version 0..SCHEMA_VERSION-1 ──
for (let start = 0; start < SCHEMA_VERSION; start++) {
  const { db, dir } = newDb(`v${start}`);
  try {
    for (let v = 1; v <= start; v++) {
      db.exec(`BEGIN IMMEDIATE; ${perVersion.get(v)}; PRAGMA user_version = ${v}; COMMIT;`);
    }
    const stamped = db.pragma('user_version', { simple: true });
    if (stamped !== start) { log(false, `from v${start}: setup stamped v${stamped} — rig fault, arm VOID`); throw new Error('setup'); }
    const before = tablesOf(db);

    const after = migrate(db);
    const tables = tablesOf(db);
    const missing = expected.filter(t => !tables.includes(t));

    log(after === SCHEMA_VERSION, `from v${start} (had ${before.length} tables): migrate() -> v${after}`);
    log(missing.length === 0,
      `from v${start}: all ${expected.length} expected tables present${missing.length ? ' — MISSING: ' + missing.join(', ') : ''}`);
    for (const t of expected.filter(t => tables.includes(t))) {
      try { db.prepare(`SELECT * FROM "${t}" LIMIT 1`).all(); }
      catch (e) { log(false, `from v${start}: table ${t} present but NOT QUERYABLE: ${e.message}`); }
    }
  } catch (e) {
    if (e.message !== 'setup') log(false, `from v${start}: threw: ${e.message}`);
  }
  db.close(); rmSync(dir, { recursive: true, force: true });
}

console.log(failures === 0 ? 'C11 RESULT: PASS' : `C11 RESULT: FAIL (${failures} assertion(s))`);
process.exit(failures === 0 ? 0 : 1);
