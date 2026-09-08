#!/usr/bin/env node
/**
 * T115.2 — ack-replay across a crash. A consumer SIGKILLed after `check` but
 * before `ack` must, on its next `check`, receive the BYTE-IDENTICAL lot (same
 * ids). After `ack`, only newer rows.
 *
 * The crash is a REAL SIGKILL of a child process -- not a simulated "didn't call
 * ack", which would prove nothing about durability across process death.
 *
 * Usage: node --experimental-strip-types t115-2-ack-replay.mjs <repoRoot>
 * RC 0 PASS · 1 FAIL · 20 rig could not run.
 */
import path from 'node:path';
import { mkdtempSync, rmSync, writeFileSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';

const repo = path.resolve(process.argv[2] || process.cwd());
let openBus, send, check, ack;
try { ({ openBus, send, check, ack } = await import(path.join(repo, 'src/main/bus.ts'))); }
catch (e) { console.error(`RIG_CANNOT_RUN: ${e.message}`); process.exit(20); }
for (const [n, f] of Object.entries({ openBus, send, check, ack }))
  if (typeof f !== 'function') { console.error(`RIG_CANNOT_RUN: bus.ts does not export ${n}`); process.exit(20); }

const dir = mkdtempSync(join(tmpdir(), 'vb-t115-2-'));
const file = join(dir, 'bus.db');
const RUN = 'r1', READER = 'ws-1';
let failures = 0;
const log = (ok, m) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${m}`); if (!ok) failures++; };

const db = openBus(file, { busyTimeoutMs: 5000 });
for (const b of ['m1', 'm2', 'm3']) send(db, { runId: RUN, sender: 'ops', kind: 'dispatch', body: b, recipient: READER });
db.close();

// Child: opens the bus, calls check(), writes the lot to disk (atomic tmp+rename
// so a partial file can never be read as a result), then BLOCKS forever so the
// parent can SIGKILL it strictly between check and ack.
const outFile = join(dir, 'lot1.json');
const childPath = join(dir, 'consumer.mjs');
writeFileSync(childPath, `
import path from 'node:path'; import fs from 'node:fs';
const { openBus, check } = await import(path.join(${JSON.stringify(repo)}, 'src/main/bus.ts'));
const db = openBus(${JSON.stringify(file)}, { busyTimeoutMs: 5000 });
const lot = check(db, ${JSON.stringify(RUN)}, ${JSON.stringify(READER)});
const tmp = ${JSON.stringify(outFile)} + '.tmp';
fs.writeFileSync(tmp, JSON.stringify(lot));
fs.renameSync(tmp, ${JSON.stringify(outFile)});
console.log('CHILD_CHECKED');
setInterval(() => {}, 1000);   // block: die only by SIGKILL, never acking
`);

const child = spawn(process.execPath, ['--experimental-strip-types', childPath], { stdio: ['ignore', 'pipe', 'pipe'] });
let cout = '', cerr = '';
child.stdout.on('data', d => cout += d);
child.stderr.on('data', d => cerr += d);

// Wait for the lot file to EXIST (a positive terminator), bounded — never sleep-then-read.
const deadline = Date.now() + 30000;
while (!existsSync(outFile) && Date.now() < deadline && child.exitCode === null) {
  await new Promise(r => setTimeout(r, 25));
}
if (!existsSync(outFile)) {
  console.error(`RIG_CANNOT_RUN: child never produced a lot. stdout=${cout} stderr=${cerr.slice(-500)}`);
  try { child.kill('SIGKILL'); } catch {}
  rmSync(dir, { recursive: true, force: true });
  process.exit(20);
}
const lot1 = JSON.parse(readFileSync(outFile, 'utf8'));

// SIGKILL strictly between check and ack, and CONFIRM death.
child.kill('SIGKILL');
const died = await new Promise(res => { child.on('exit', (c, s) => res({ c, s })); setTimeout(() => res(null), 10000); });
log(died !== null, `consumer SIGKILLed between check and ack (exit code=${died?.c} signal=${died?.s})`);
log(died?.s === 'SIGKILL' || died?.c === 137, `death was by SIGKILL, not a clean exit (signal=${died?.s})`);

const ids1 = (lot1.messages ?? []).map(m => m.id ?? m.sequence);
console.log(`lot1: delivery.id=${lot1.delivery?.id} from_seq=${lot1.delivery?.from_seq} to_seq=${lot1.delivery?.to_seq} replay=${lot1.replay} ids=[${ids1.join(',')}]`);
log(lot1.delivery != null, 'lot1 has a delivery row (rig reads lot.delivery.id, NOT lot.id)');
log(lot1.replay === false, `lot1.replay is FALSE on the first check (got ${lot1.replay})`);
log(ids1.length === 3, `lot1 carries all 3 pending messages (got ${ids1.length})`);

// ── Arm A: next check REPLAYS the byte-identical lot ──
const db2 = openBus(file, { busyTimeoutMs: 5000 });
const lot2 = check(db2, RUN, READER);
const ids2 = (lot2.messages ?? []).map(m => m.id ?? m.sequence);
console.log(`lot2: delivery.id=${lot2.delivery?.id} from_seq=${lot2.delivery?.from_seq} to_seq=${lot2.delivery?.to_seq} replay=${lot2.replay} ids=[${ids2.join(',')}]`);
log(lot2.replay === true, `lot2.replay is TRUE — the bus itself declares this a replay (got ${lot2.replay})`);
log(lot1.delivery?.id === lot2.delivery?.id, `REPLAY: same delivery id (${lot1.delivery?.id} vs ${lot2.delivery?.id})`);
log(lot1.delivery?.from_seq !== undefined, 'from_seq is READABLE (guards the undefined===undefined vacuity)');
log(JSON.stringify(ids1) === JSON.stringify(ids2), `REPLAY: same ids after crash ([${ids1}] vs [${ids2}])`);
log(lot1.delivery?.from_seq === lot2.delivery?.from_seq &&
    lot1.delivery?.to_seq === lot2.delivery?.to_seq, 'REPLAY: identical from_seq/to_seq');

// ── Arm B: after ack, only NEWER rows (positive control: the lot CAN change) ──
const acked = ack(db2, RUN, READER, lot2.delivery.id);
log(acked === true, `ack() returned true (got ${acked})`);
send(db2, { runId: RUN, sender: 'ops', kind: 'dispatch', body: 'm4-after-ack', recipient: READER });
const lot3 = check(db2, RUN, READER);
const bodies3 = (lot3.messages ?? []).map(m => m.body);
console.log(`lot3 after ack: ids=[${(lot3.messages ?? []).map(m => m.id ?? m.sequence).join(',')}] bodies=[${bodies3.join(',')}]`);
log(!bodies3.some(b => ['m1', 'm2', 'm3'].includes(b)), 'after ack, the acked messages do NOT reappear');
log(bodies3.includes('m4-after-ack'), 'after ack, the NEWER message is delivered (control: check() can return different rows)');
db2.close();

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'T115.2 RESULT: PASS' : `T115.2 RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
