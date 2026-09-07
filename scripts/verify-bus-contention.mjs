#!/usr/bin/env node
// Spike #109 arm 1, re-run against the PRODUCTION bus module and the app's real
// DB path shape: 10 concurrent short-lived CLI writers × 100 inserts each, with
// a long-lived reader attached, into one WAL database.
//
// REQUIRED: 1000/1000 committed, 0 SQLITE_BUSY, 0 missing message bodies.
//
// AND THE MUST-FAIL CONTROL, which is the reason this script is worth running:
// the same rig with `busy_timeout = 0` MUST LOSE INSERTS. The spike measured
// 7–27% loss (70–268 of 1000). A control that cannot fail means the rig is not
// creating contention at all, and the must-PASS arm then proves nothing — so a
// clean control is a FAILURE of this script, not a pass.
//
// THE WRITERS CALL THE SHIPPED open() AND send(), NOT A COPY OF THEM.
//
// This is the correction to a real defect in the first version of this rig: the
// writer child used to require better-sqlite3 directly and hand-write its own
// INSERT plus its own three pragmas, "mirroring" open(). That made the whole
// script green with open()'s busy_timeout line DELETED — measured — i.e. the rig
// certified the one condition the spike calls mandatory while never executing
// it. A rig that re-implements its subject measures the re-implementation.
//
// So each writer is a real short-lived process running a .ts entry that imports
// src/main/bus.ts and calls send() through a connection from open(). The only
// knob is busyTimeoutMs, which is the variable under test.
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
const WRITER_SRC = (root, file) => `
import { open, send } from ${JSON.stringify(path.join(root, 'src/main/bus.ts'))};

const n = Number(process.argv[2]);
const who = process.argv[3];
const busyTimeoutMs = Number(process.argv[4]);

// THE SHIPPED open(). If its busy_timeout line is deleted, this arm loses
// inserts and the script fails — which is the whole point of the rig.
const db = open(${JSON.stringify(file)}, { busyTimeoutMs });

let committed = 0, busy = 0, otherErr = 0;
for (let i = 0; i < n; i++) {
  try {
    // THE SHIPPED send(), not a hand-written INSERT.
    send(db, { runId: 'contention', sender: who, kind: 'dispatch', body: who + ':' + i });
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

  const writerJs = writeTmp(dir, 'writer.ts', WRITER_SRC(ROOT, file));
  const readerJs = writeTmp(dir, 'reader.cjs', READER_SRC);

  const reader = spawn('node', [readerJs, file], { stdio: ['ignore', 'pipe', 'inherit'] });
  let readerOut = '';
  reader.stdout.on('data', (d) => (readerOut += d));

  const started = Date.now();
  const results = await Promise.all(
    Array.from({ length: WRITERS }, (_, i) => {
      return new Promise((resolve, reject) => {
        const c = spawn('node', ['--experimental-strip-types', writerJs, String(INSERTS), `w${i}`, String(busyTimeoutMs)], {
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
    const rows=db.prepare("SELECT sequence, body FROM messages WHERE run_id='contention' ORDER BY sequence").all();
    // NO GAP CHECK HERE, DELIBERATELY. A "sequence gap" cannot detect a lost
    // insert: a row that never existed consumes no sequence, so AUTOINCREMENT
    // hands the next writer a contiguous number and gaps is structurally 0. The
    // spike's own control table proves it -- it lost 128-295 inserts at gaps: 0.
    // A metric pinned to 0 reads as evidence while asserting nothing, so it is
    // gone rather than softened.
    //
    // These two CAN fire, and they check different failures:
    //   strictlyIncreasing -- the ordering property AUTOINCREMENT actually buys.
    //   missingBodies      -- WHICH writes were lost, by set difference against
    //                         the exact bodies every writer was told to send.
    let strictlyIncreasing=true;
    for(let i=1;i<rows.length;i++) if(rows[i].sequence <= rows[i-1].sequence) strictlyIncreasing=false;
    const seen=new Set(rows.map(r=>r.body));
    const writers=Number(process.argv[3]), inserts=Number(process.argv[4]);
    const missing=[];
    for(let w=0;w<writers;w++) for(let i=0;i<inserts;i++){
      const b='w'+w+':'+i; if(!seen.has(b)) missing.push(b);
    }
    process.stdout.write(JSON.stringify({rowsInDb:rows.length,strictlyIncreasing,missingCount:missing.length,missingSample:missing.slice(0,3),minSeq:rows[0]&&rows[0].sequence,maxSeq:rows[rows.length-1]&&rows[rows.length-1].sequence}));
  `,
  );
  const truth = JSON.parse(
    execFileSync('node', [verifyJs, file, String(WRITERS), String(INSERTS)], { encoding: 'utf8' }),
  );

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
    strictlyIncreasing: truth.strictlyIncreasing,
    missingCount: truth.missingCount,
    missingSample: truth.missingSample,
    wallMs,
    readerReport,
  };
}

function line(r) {
  return `  ${r.label.padEnd(28)} committed=${String(r.rowsInDb).padStart(4)}/${r.expected}  lost=${String(r.lost).padStart(4)}  BUSY=${String(r.busy).padStart(4)}  missingBodies=${String(r.missingCount).padStart(4)}  incr=${r.strictlyIncreasing}  reads=${r.readerReport?.reads ?? '?'}@${r.readerReport?.readBusy ?? '?'}readBusy  ${r.wallMs}ms`;
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
if (!mustPass.strictlyIncreasing)
  problems.push('must-PASS produced a non-increasing sequence — AUTOINCREMENT is not holding the total order');
if (mustPass.missingCount !== 0)
  problems.push(
    `must-PASS is missing ${mustPass.missingCount} of the exact bodies the writers were told to send ` +
      `(e.g. ${mustPass.missingSample.join(', ')}) — this is the check that can actually fire, unlike a sequence-gap count`,
  );
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
  `\nPASS — ${mustPass.rowsInDb}/${EXPECTED} committed, 0 SQLITE_BUSY, 0 missing bodies, sequence strictly increasing; ` +
    `control lost ${control.lost} (${lossPct}%) with busy_timeout=0, so the rig demonstrably creates contention.`,
);
