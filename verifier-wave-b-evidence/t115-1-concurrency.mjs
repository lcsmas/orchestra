#!/usr/bin/env node
/**
 * T115.1 — concurrency: N concurrent writers against one bus DB lose NO rows.
 * MUST-FAIL CONTROL: the same rig with busy_timeout=0 MUST lose rows. A clean
 * control means the rig created no contention and the passing arm proved nothing.
 *
 * Usage: node --experimental-strip-types t115-1-concurrency.mjs <repoRoot> [--busy-timeout=N] [--writers=N] [--per=N]
 * RC 0 = no loss · 1 = loss · 20 = rig could not run.
 */
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { execFileSync } from 'node:child_process';

const repo = path.resolve(process.argv[2] || process.cwd());
const arg = (n, d) => { const a = process.argv.find(x => x.startsWith(`--${n}=`)); return a ? Number(a.split('=')[1]) : d; };
const BUSY = arg('busy-timeout', 5000);
const WRITERS = arg('writers', 4);
const PER = arg('per', 250);
const EXPECTED = WRITERS * PER;

let openBus, send;
try { ({ openBus, send } = await import(path.join(repo, 'src/main/bus.ts'))); }
catch (e) { console.error(`RIG_CANNOT_RUN: ${e.message}`); process.exit(20); }

const dir = mkdtempSync(join(tmpdir(), 'vb-t115-1-'));
const file = join(dir, 'bus.db');
// Create the schema once, in-process, so writers only INSERT.
const seed = openBus(file, { busyTimeoutMs: BUSY });
seed.close();

// Child writer: its OWN process, so the contention is real OS-level lock
// contention, not one process serialising itself.
const childSrc = `
import path from 'node:path';
const repo = ${JSON.stringify(repo)};
const { open, send } = await import(path.join(repo, 'src/main/bus.ts'));
const file = ${JSON.stringify(file)};
const busy = ${BUSY}, per = ${PER};
const tag = process.argv[2];
const startAt = Number(process.argv[3]);
// BARRIER: spin until the shared start instant so writers genuinely overlap.
while (Date.now() < startAt) {}
const t0 = Date.now();
const db = open(file, { busyTimeoutMs: busy });
let ok = 0, err = 0, lastErr = '';
for (let i = 0; i < per; i++) {
  try { send(db, { runId: 'r1', sender: tag, kind: 'status', body: tag + ':' + i }); ok++; }
  catch (e) { err++; lastErr = e.message; }
}
db.close();
console.log(JSON.stringify({ tag, ok, err, lastErr, t0, t1: Date.now() }));
`;
const childPath = join(dir, 'writer.mjs');
writeFileSync(childPath, childSrc);

console.log(`T115.1  writers=${WRITERS} per=${PER} expected=${EXPECTED} busy_timeout=${BUSY}`);
const { spawn } = await import('node:child_process');
// All writers begin at the same wall-clock instant, after every process is up.
const startAt = Date.now() + 3000;
const results = await Promise.all(
  Array.from({ length: WRITERS }, (_, i) => new Promise((res) => {
    const p = spawn(process.execPath, ['--experimental-strip-types', childPath, `w${i}`, String(startAt)], { stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', errb = '';
    p.stdout.on('data', d => out += d);
    p.stderr.on('data', d => errb += d);
    p.on('exit', (code) => {
      const line = out.split('\n').find(l => l.trim().startsWith('{'));
      res(line ? { ...JSON.parse(line), code } : { tag: `w${i}`, ok: 0, err: PER, code, lastErr: errb.slice(-300) });
    });
  }))
);

const inserted = results.reduce((a, r) => a + r.ok, 0);
const errors = results.reduce((a, r) => a + r.err, 0);
for (const r of results) console.log(`  ${r.tag}: ok=${r.ok} err=${r.err} exit=${r.code} window=[${r.t0 ? r.t0 - startAt : '?'}..${r.t1 ? r.t1 - startAt : '?'}]ms${r.lastErr ? ' lastErr=' + r.lastErr.slice(0, 120) : ''}`);
{
  const t0s = results.map(r => r.t0).filter(Boolean), t1s = results.map(r => r.t1).filter(Boolean);
  const overlap = Math.min(...t1s) - Math.max(...t0s);
  console.log(`OVERLAP: all writers concurrently active for ${overlap}ms (<=0 means NO CONTENTION — both arms VOID)`);
}

// Count via a FRESH handle -- unbounded COUNT(*), never a paged read.
const vdb = openBus(file, { busyTimeoutMs: 5000 });
const rows = vdb.prepare("SELECT COUNT(*) c FROM messages WHERE run_id='r1'").get().c;
vdb.close();
rmSync(dir, { recursive: true, force: true });

const lost = EXPECTED - rows;
console.log(`RESULT rows_in_db=${rows} expected=${EXPECTED} write_errors=${errors} LOST=${lost}`);
if (lost === 0 && errors === 0) { console.log('T115.1: NO LOSS'); process.exit(0); }
console.log(`T115.1: LOSS DETECTED (${lost} rows, ${errors} write errors)`);
process.exit(1);
