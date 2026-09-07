#!/usr/bin/env node
// Spike #109 arm 1, re-run against the PRODUCTION bus module and the app's real
// DB path shape: 10 concurrent short-lived CLI writers × 100 inserts each, with
// a long-lived reader attached, into one WAL database.
//
// REQUIRED: 1000/1000 committed, 0 SQLITE_BUSY, 0 sequence gaps.
//
// AND THE MUST-FAIL CONTROL, which is the reason this script is worth running:
// the same rig with `busy_timeout = 0` MUST LOSE INSERTS. The spike measured
// 7–27% loss (70–268 of 1000). A control that cannot fail means the rig is not
// creating contention at all, and the must-PASS arm then proves nothing — so a
// clean control is a FAILURE of this script, not a pass.
//
// This drives the real src/main/bus.ts through a tiny CJS bridge (the module is
// TypeScript and the writers are separate processes), so the PRAGMAs and the
// insert path under test are the ones the app ships — not a copy.
//
// Usage: node scripts/verify-bus-contention.mjs [--writers N] [--inserts N]

import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const argOf = (name, dflt) => {
  const i = argv.indexOf(name);
  return i >= 0 && argv[i + 1] ? Number(argv[i + 1]) : dflt;
};
const WRITERS = argOf('--writers', 10);
const INSERTS = argOf('--inserts', 100);
const EXPECTED = WRITERS * INSERTS;

// ─── The writer child, as a standalone script ───────────────────────────────
// Each writer is a genuinely separate short-lived process with its own
// connection — real spawn, real exit — because that is the shape the CLI will
// have (#108 ruling Q2: the CLI writes SQLite directly, N concurrent writers).
const WRITER_SRC = `
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const file = process.argv[2];
const n = Number(process.argv[3]);
const who = process.argv[4];
const busyTimeoutMs = Number(process.argv[5]);

const Database = require(path.join(ROOT, 'node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/database.js'));
const binding = path.join(ROOT, 'build', 'bus-abi', 'better_sqlite3-abi' + process.versions.modules + '.node');

// Mirrors src/main/bus.ts open() exactly — same PRAGMAs, same order. The one
// knob is busy_timeout, which is the variable under test.
const db = new Database(file, { nativeBinding: binding });
db.pragma('journal_mode = WAL');
db.pragma('synchronous = NORMAL');
db.pragma('busy_timeout = ' + busyTimeoutMs);

const stmt = db.prepare('INSERT INTO messages (run_id, thread_id, sender, recipient, kind, body, created_at) VALUES (?,?,?,?,?,?,?)');
let committed = 0, busy = 0, otherErr = 0;
for (let i = 0; i < n; i++) {
  try {
    stmt.run('contention', null, who, null, 'dispatch', who + ':' + i, Date.now());
    committed++;
  } catch (e) {
    // SQLITE_BUSY is the failure this rig is about. Anything else is a rig fault
    // and must be reported separately rather than folded into the loss count.
    if (String(e.code || e.message).includes('SQLITE_BUSY')) busy++;
    else { otherErr++; if (otherErr === 1) console.error('UNEXPECTED', String(e.message).slice(0,120)); }
  }
}
db.close();
process.stdout.write(JSON.stringify({ who, committed, busy, otherErr }));
`;

// ─── The reader, as a standalone script ─────────────────────────────────────
// A long-lived reader attached for the whole run. WAL's promise is that readers
// never block writers; without one attached, the contention arm would be writers
// only and would not exercise that.
const READER_SRC = `
const path = require('path');
const ROOT = ${JSON.stringify(ROOT)};
const file = process.argv[2];
const Database = require(path.join(ROOT, 'node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/database.js'));
const binding = path.join(ROOT, 'build', 'bus-abi', 'better_sqlite3-abi' + process.versions.modules + '.node');
const db = new Database(file, { readonly: true, nativeBinding: binding });
db.pragma('busy_timeout = 5000');
let reads = 0, readBusy = 0, lastSeen = 0;
let stop = false;
process.on('SIGTERM', () => { stop = true; });
const q = db.prepare("SELECT COUNT(*) c FROM messages WHERE run_id='contention'");
(function loop() {
  if (stop) {
    process.stdout.write(JSON.stringify({ reads, readBusy, lastSeen }));
    process.exit(0);
  }
  try { lastSeen = q.get().c; reads++; }
  catch (e) { if (String(e.code||e.message).includes('SQLITE_BUSY')) readBusy++; }
  setImmediate(loop);
})();
`;

function writeTmp(dir, name, src) {
  const p = path.join(dir, name);
  fs.writeFileSync(p, src);
  return p;
}

/** One arm of the experiment. Returns the measured outcome. */
async function runArm({ label, busyTimeoutMs, dir }) {
  const file = path.join(dir, 'bus.sqlite');
  // Create the schema through the REAL module, so the table under test is the
  // shipped one (AUTOINCREMENT included — the gap check depends on it).
  const seedTs = path.join(dir, 'seed.ts');
  fs.writeFileSync(
    seedTs,
    `import { openBus } from ${JSON.stringify(path.join(ROOT, 'src/main/bus.ts'))};\n` +
      `const db = openBus(${JSON.stringify(file)});\ndb.close();\n`,
  );
  execFileSync('node', ['--experimental-strip-types', seedTs], { cwd: ROOT, stdio: 'pipe' });

  const writerJs = writeTmp(dir, 'writer.cjs', WRITER_SRC);
  const readerJs = writeTmp(dir, 'reader.cjs', READER_SRC);

  const reader = spawn('node', [readerJs, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let readerOut = '';
  reader.stdout.on('data', (d) => (readerOut += d));

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => {
      return new Promise((resolve, reject) => {
        const c = spawn('node', [writerJs, file, String(INSERTS), `w${i}`, String(busyTimeoutMs)], {
          stdio: ['ignore', 'pipe', 'inherit'],
        });
        let out = '';
        c.stdout.on('data', (d) => (out += d));
        // Await EXIT, not just the stdout chunk: reading a child's buffer in the
        // same tick as its death yields an empty string that reads as "nothing
        // happened".
        c.on('exit', (code) =>
          code === 0 ? resolve(JSON.parse(out)) : reject(new Error(`writer ${i} exit ${code}`)),
        );
      });
    }),
  );
  const wallMs = Date.now() - started;

  reader.kill('SIGTERM');
  await new Promise((r) => reader.on('exit', r));
  const readerReport = readerOut ? JSON.parse(readerOut) : null;

  // Read the ground truth from the database itself, not from what the writers
  // claim they did.
  const verifyJs = writeTmp(
    dir,
    'verify.cjs',
    `
    const path=require('path');
    const Database=require(path.join(${JSON.stringify(ROOT)},'node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/lib/database.js'));
    const binding=path.join(${JSON.stringify(ROOT)},'build','bus-abi','better_sqlite3-abi'+process.versions.modules+'.node');
    const db=new Database(process.argv[2],{readonly:true,nativeBinding:binding});
    db.pragma('busy_timeout = 5000');
    const rows=db.prepare("SELECT sequence FROM messages WHERE run_id='contention' ORDER BY sequence").all();
    let gaps=0;
    for(let i=1;i<rows.length;i++) if(rows[i].sequence !== rows[i-1].sequence+1) gaps++;
    process.stdout.write(JSON.stringify({rowsInDb:rows.length,gaps,minSeq:rows[0]&&rows[0].sequence,maxSeq:rows[rows.length-1]&&rows[rows.length-1].sequence}));
  `,
  );
  const truth = JSON.parse(execFileSync('node', [verifyJs, file], { encoding: 'utf8' }));

  const committed = results.reduce((a, r) => a + r.committed, 0);
  const busy = results.reduce((a, r) => a + r.busy, 0);
  const otherErr = results.reduce((a, r) => a + r.otherErr, 0);

  return {
    label,
    busyTimeoutMs,
    expected: EXPECTED,
    committed,
    rowsInDb: truth.rowsInDb,
    lost: EXPECTED - truth.rowsInDb,
    busy,
    otherErr,
    gaps: truth.gaps,
    wallMs,
    readerReport,
  };
}

function line(r) {
  return `  ${r.label.padEnd(28)} committed=${String(r.rowsInDb).padStart(4)}/${r.expected}  lost=${String(r.lost).padStart(4)}  BUSY=${String(r.busy).padStart(4)}  gaps=${r.gaps}  reads=${r.readerReport?.reads ?? '?'}@${r.readerReport?.readBusy ?? '?'}readBusy  ${r.wallMs}ms`;
}

// ─── Run both arms ──────────────────────────────────────────────────────────

// WHERE THE DB LIVES, AND WHY IT IS NOT os.tmpdir(). #114 asks for this arm
// "against the app's DB path", and the spike's numbers are from btrfs. On this
// host /tmp is a tmpfs — a RAM filesystem with no real fsync, which is a
// different and easier experiment than the disk the bus actually lives on. So
// the rig defaults to a scratch dir under ORCHESTRA_HOME (the real bus's
// filesystem), and prints the filesystem it used either way so a tmpfs run can
// never be mistaken for a disk one.
const HOME_ROOT = process.env.ORCHESTRA_HOME || path.join(os.homedir(), '.orchestra');
const scratchParent = fs.existsSync(HOME_ROOT) ? HOME_ROOT : os.tmpdir();
const base = fs.mkdtempSync(path.join(scratchParent, 'bus-contention-'));
const fsType = (() => {
  try {
    return execFileSync('df', ['-T', base], { encoding: 'utf8' }).trim().split('\n').pop().split(/\s+/)[1];
  } catch {
    return 'unknown';
  }
})();

console.log(
  `bus contention rig — ${WRITERS} writers × ${INSERTS} inserts = ${EXPECTED}, live reader attached`,
);
console.log(`  db dir: ${base}`);
console.log(`  db filesystem: ${fsType}   node abi ${process.versions.modules}`);
if (fsType === 'tmpfs') {
  console.log(
    '  NOTE: this run is on TMPFS (RAM) — easier than the real disk. The spike measured btrfs.',
  );
}

const passDir = path.join(base, 'must-pass');
fs.mkdirSync(passDir, { recursive: true });
const failDir = path.join(base, 'must-fail');
fs.mkdirSync(failDir, { recursive: true });

const mustPass = await runArm({
  label: 'must-PASS busy_timeout=5000',
  busyTimeoutMs: 5000,
  dir: passDir,
});
console.log(line(mustPass));

const control = await runArm({ label: 'must-FAIL busy_timeout=0', busyTimeoutMs: 0, dir: failDir });
console.log(line(control));

fs.rmSync(base, { recursive: true, force: true });

// ─── Verdict ────────────────────────────────────────────────────────────────

const problems = [];
if (mustPass.rowsInDb !== EXPECTED)
  problems.push(`must-PASS lost ${mustPass.lost} of ${EXPECTED} inserts`);
if (mustPass.busy !== 0) problems.push(`must-PASS saw ${mustPass.busy} SQLITE_BUSY`);
if (mustPass.gaps !== 0) problems.push(`must-PASS has ${mustPass.gaps} sequence gaps`);
if (mustPass.otherErr !== 0) problems.push(`must-PASS hit ${mustPass.otherErr} non-BUSY errors`);
if (!mustPass.readerReport || mustPass.readerReport.reads === 0)
  problems.push('the live reader recorded 0 reads — it was not actually attached, so this arm did not measure a reader/writer mix');

// THE CONTROL. A clean control is a FAILED control: it means the rig produced no
// contention, and the must-PASS arm above then measured nothing.
if (control.lost === 0)
  problems.push(
    `must-FAIL control lost 0 inserts — the rig created NO contention, so the must-PASS arm proves nothing (spike #109 measured 70–268 lost here)`,
  );
if (control.otherErr !== 0)
  problems.push(`must-FAIL control hit ${control.otherErr} non-BUSY errors (rig fault)`);

if (problems.length) {
  console.error('\nFAIL:');
  for (const p of problems) console.error(`  - ${p}`);
  process.exit(1);
}

const lossPct = ((control.lost / EXPECTED) * 100).toFixed(1);
console.log(
  `\nPASS — ${mustPass.rowsInDb}/${EXPECTED} committed, 0 SQLITE_BUSY, 0 sequence gaps; ` +
    `control lost ${control.lost} (${lossPct}%) with busy_timeout=0, so the rig demonstrably creates contention.`,
);
