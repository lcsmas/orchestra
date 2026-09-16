// #149 STEP 1 diagnosis — measured inotify probe on THIS (btrfs) machine.
//
// Question: does an insert from a SEPARATE CLI process produce an inotify event
// on bus.sqlite-wal while an app-like process holds the DB open (WAL mode)?
// Two arms measured side by side, in strict phase order:
//   A) fs.watch(bus.sqlite-wal)                    — the SHIPPED inode watch (bus-wake.ts:615)
//   B) fs.watch(dir) filtered by basename '-wal'   — the proposed fix
//
// Phases:
//   P1  steady state (no checkpoint)                       — does the inode watch fire at all?
//   P2  after wal_checkpoint(TRUNCATE) (in place)          — does TRUNCATE change the inode / detach?
//   P3  after a REAL inode recycle (-wal deleted+recreated)— does the inode watch die?
//
// The recycle in P3 is the honest reproduction of "SQLite recycles the WAL": a
// clean close of the last WAL-mode connection unlinks -wal, and the next write
// recreates it at a NEW inode. An inode-pinned watch cannot follow that; a
// directory watch does.
//
// Rig hygiene (contract rule 5/7): own ORCHESTRA_HOME under a btrfs dir, never
// the live ~/.orchestra/bus.sqlite. The DB MUST live on btrfs — the bug is
// filesystem/kernel-specific (the ticket names btrfs).

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const repoRoot = path.resolve(__dirname, '..');

const { loadDatabaseCtor } = await import(path.join(repoRoot, 'src/main/bus-binding.ts'));
const Database = loadDatabaseCtor();
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

const home = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-diag149-'));
const busFile = path.join(home, 'bus.sqlite');
const walFile = `${busFile}-wal`;
const walBase = path.basename(walFile);

const walFs = (() => {
  try { return execSync(`findmnt -no FSTYPE -T ${JSON.stringify(home)}`).toString().trim(); }
  catch { return '?'; }
})();

console.log(`# diag-149 WAL watch probe`);
console.log(`home = ${home}`);
console.log(`filesystem = ${walFs}   (ticket names btrfs)`);
console.log(`node ABI = ${process.versions.modules}`);
console.log(`kernel = ${os.release()}`);

function openApp() {
  const db = new Database(busFile);
  db.pragma('journal_mode = WAL');
  db.pragma('synchronous = NORMAL');
  db.pragma('busy_timeout = 5000');
  return db;
}

let app = openApp();
app.exec(`CREATE TABLE IF NOT EXISTS messages (id INTEGER PRIMARY KEY, body TEXT)`);
app.prepare(`INSERT INTO messages (body) VALUES (?)`).run('seed');
if (!fs.existsSync(walFile)) { console.log('FATAL: -wal absent after seed'); process.exit(2); }

const counts = { inode: 0, dir: 0 };
let inodeAlive = true;

let inodeWatcher = fs.watch(walFile, () => { counts.inode++; });
inodeWatcher.on('error', () => { inodeAlive = false; });
const dirWatcher = fs.watch(home, (_ev, filename) => { if (filename === walBase) counts.dir++; });

// Cross-process CLI writer (separate process = production shape).
const childScriptPath = path.join(home, 'cli-insert.mjs');
fs.writeFileSync(childScriptPath, [
  `import { loadDatabaseCtor } from ${JSON.stringify(path.join(repoRoot, 'src/main/bus-binding.ts'))};`,
  `const Database = loadDatabaseCtor();`,
  `const db = new Database(${JSON.stringify(busFile)});`,
  `db.pragma('busy_timeout = 5000');`,
  `db.prepare('INSERT INTO messages (body) VALUES (?)').run('cli-' + process.argv[2]);`,
  `db.close();`,
].join('\n'));
function cliInsert(n) {
  execSync(`node --no-warnings --experimental-strip-types ${JSON.stringify(childScriptPath)} ${JSON.stringify(String(n))}`,
    { cwd: repoRoot, stdio: ['ignore', 'ignore', 'inherit'] });
}
async function batch(label, n) {
  const b = { inode: counts.inode, dir: counts.dir };
  for (let i = 0; i < n; i++) { cliInsert(`${label}-${i}`); await sleep(60); }
  await sleep(300);
  return { inode: counts.inode - b.inode, dir: counts.dir - b.dir };
}

const N = 10;

// ── P1 — steady state ──────────────────────────────────────────────────────
const p1 = await batch('p1', N);
console.log(`\n## P1 — steady state, ${N} cross-process inserts`);
console.log(`  inode-watch = ${p1.inode}/${N}   dir-watch = ${p1.dir}/${N}   inodeAlive=${inodeAlive}`);

// ── P2 — wal_checkpoint(TRUNCATE), in place ────────────────────────────────
const inoBefore = fs.statSync(walFile).ino;
const ckpt = app.pragma('wal_checkpoint(TRUNCATE)');
const inoAfter = fs.existsSync(walFile) ? fs.statSync(walFile).ino : null;
console.log(`\n## P2 — wal_checkpoint(TRUNCATE) => ${JSON.stringify(ckpt)}`);
console.log(`  -wal inode  ${inoBefore} -> ${inoAfter}   changed=${inoBefore !== inoAfter}`);
const p2 = await batch('p2', N);
console.log(`  after TRUNCATE, ${N} inserts: inode-watch = ${p2.inode}/${N}   dir-watch = ${p2.dir}/${N}   inodeAlive=${inodeAlive}`);

// ── P3 — REAL inode recycle: last-connection close unlinks -wal, reopen+write
//         recreates it at a new inode ────────────────────────────────────────
const inoPre = fs.existsSync(walFile) ? fs.statSync(walFile).ino : null;
app.pragma('wal_checkpoint(TRUNCATE)');
app.close();
await sleep(200);
const walGone = !fs.existsSync(walFile);
app = openApp();
app.prepare(`INSERT INTO messages (body) VALUES (?)`).run('recreate-seed');
await sleep(200);
const inoPost = fs.existsSync(walFile) ? fs.statSync(walFile).ino : null;
console.log(`\n## P3 — REAL inode recycle (-wal unlinked on last-conn close, recreated on next write)`);
console.log(`  -wal unlinked on app.close() = ${walGone}`);
console.log(`  -wal inode  ${inoPre} -> ${inoPost}   recycled=${inoPre !== inoPost}`);
const p3 = await batch('p3', N);
console.log(`  after recycle, ${N} inserts: inode-watch = ${p3.inode}/${N}   dir-watch = ${p3.dir}/${N}   inodeAlive=${inodeAlive}`);

// ── VERDICT ────────────────────────────────────────────────────────────────
console.log(`\n## VERDICT`);
console.log(`  P1 inode-watch fires in steady state:        ${p1.inode > 0}  (${p1.inode}/${N})`);
console.log(`  TRUNCATE recycles the WAL inode:             ${inoBefore !== inoAfter}`);
console.log(`  inode-watch DETACHED by real recycle:       ${p3.inode === 0 && p3.dir > 0}  (inode ${p3.inode}/${N}, dir ${p3.dir}/${N})`);
console.log(`  detach is SILENT (no 'error' event fired):  ${inodeAlive === true}`);
console.log(`  dir-watch survives every phase:             ${p1.dir > 0 && p2.dir > 0 && p3.dir > 0}`);

inodeWatcher.close();
dirWatcher.close();
app.close();
fs.rmSync(home, { recursive: true, force: true });
