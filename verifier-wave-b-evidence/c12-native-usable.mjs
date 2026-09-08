#!/usr/bin/env node
/**
 * C12 — a native dependency is proven USABLE BY CONSTRUCTION under the runtime
 * being gated. Never `pnpm install` RC, never `ls node_modules/...`, never
 * `require()` (the native load is DEFERRED: require succeeds under the WRONG ABI).
 *
 * Resolves through the app's OWN loadDatabaseCtor() so the gate exercises the
 * same resolution path production uses (per-ABI build, packaged unpack, or the
 * package's own binding fallback at bus-binding.ts:145).
 *
 * Usage: node --experimental-strip-types c12-native-usable.mjs <repoRoot>
 * RC 0 = usable · 1 = NOT usable · 20 = rig could not run (never a pass).
 */
import path from 'node:path';
import { existsSync, mkdtempSync, rmSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = path.resolve(process.argv[2] || process.cwd());
const runtime = process.versions.electron ? `electron ${process.versions.electron}` : `node ${process.version}`;
console.log(`RUNTIME: ${runtime}  |  process.versions.modules (ABI) = ${process.versions.modules}`);

let loadDatabaseCtor;
try {
  ({ loadDatabaseCtor } = await import(path.join(repo, 'src/main/bus-binding.ts')));
} catch (e) {
  console.error(`RIG_CANNOT_RUN: cannot import bus-binding.ts: ${e.message}`);
  process.exit(20);
}
if (typeof loadDatabaseCtor !== 'function') {
  console.error('RIG_CANNOT_RUN: loadDatabaseCtor is not exported');
  process.exit(20);
}

// Report WHICH binding the resolver chose -- the informative part. A green that
// cannot say what it loaded is not reportable.
const abiDir = path.join(repo, 'build/bus-abi');
console.log(`build/bus-abi/ present: ${existsSync(abiDir)}  (absent is FINE — bus-binding.ts:145 falls back to the package binding)`);
const pkgBinding = path.join(repo, 'node_modules/better-sqlite3/build/Release/better_sqlite3.node');
console.log(`package binding present: ${existsSync(pkgBinding)} -> ${pkgBinding}`);

let Ctor;
try {
  Ctor = loadDatabaseCtor();
} catch (e) {
  console.log(`FAIL  loadDatabaseCtor() threw: ${e.message}`);
  process.exit(1);
}

// THE GATE: construct against a REAL FILE (not :memory:, which can mask a
// broken pager path), write, read back, and reopen the same file.
const dir = mkdtempSync(join(tmpdir(), 'vb-c12-'));
const file = join(dir, 'probe.db');
let rc = 0;
try {
  const db = new Ctor(file);
  db.pragma('journal_mode = WAL');
  db.pragma('busy_timeout = 5000');
  db.exec('CREATE TABLE probe (id INTEGER PRIMARY KEY, note TEXT)');
  db.prepare('INSERT INTO probe (note) VALUES (?)').run('c12');
  const row = db.prepare('SELECT id, note FROM probe').get();
  if (!row || row.note !== 'c12') { console.log(`FAIL  read-back wrong: ${JSON.stringify(row)}`); rc = 1; }
  else console.log(`ok    construct + write + read-back: {id:${row.id}, note:'${row.note}'}`);
  const ver = db.prepare('select sqlite_version() v').get().v;
  console.log(`ok    sqlite_version() = ${ver} (the native library actually executed)`);
  db.close();
  // Reopen: proves the file the native layer wrote is readable by a fresh handle.
  const db2 = new Ctor(file);
  const again = db2.prepare('SELECT note FROM probe').get();
  if (!again || again.note !== 'c12') { console.log('FAIL  reopen lost the row'); rc = 1; }
  else console.log('ok    reopen reads the persisted row');
  db2.close();
} catch (e) {
  console.log(`FAIL  native construct/query threw: ${e.message}`);
  rc = 1;
} finally {
  rmSync(dir, { recursive: true, force: true });
}
console.log(rc === 0 ? 'C12 RESULT: PASS (native dependency USABLE under this runtime)' : 'C12 RESULT: FAIL');
process.exit(rc);
