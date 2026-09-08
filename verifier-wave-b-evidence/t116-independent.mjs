#!/usr/bin/env node
/**
 * T116.1 / T116.2 / T116.3 — INDEPENDENT verifier rig for #116.
 * Written from the TICKET's wording, not from the candidate's test file, and it
 * drives mirrorDispatch() + the real bus, asserting the OBSERVABLE the ticket
 * names (row counts in the DB, the delivery result object), never the
 * candidate's own assertions.
 *
 * RC 0 PASS · 1 FAIL · 20 rig could not run.
 */
import path from 'node:path';
import { mkdtempSync, rmSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const repo = path.resolve(process.argv[2] || process.cwd());
let bus, mirror, shared;
try {
  bus = await import(path.join(repo, 'src/main/bus.ts'));
  mirror = await import(path.join(repo, 'src/main/bus-mirror.ts'));
  shared = await import(path.join(repo, 'src/shared/bus-mirror.ts'));
} catch (e) { console.error(`RIG_CANNOT_RUN: ${e.message}`); process.exit(20); }

let failures = 0;
const log = (ok, m) => { console.log(`${ok ? 'ok  ' : 'FAIL'}  ${m}`); if (!ok) failures++; };
const dir = mkdtempSync(join(tmpdir(), 'vb-t116-'));
const file = join(dir, 'bus.db');
const RUN = 'vb-run-1';
mirror.setMirrorRunId(RUN);
const db = bus.openBus(file, { busyTimeoutMs: 5000 });

const countMessages = () => db.prepare('SELECT COUNT(*) c FROM messages WHERE run_id=?').get(RUN).c;
const countMirror  = () => db.prepare('SELECT COUNT(*) c FROM mirror_records WHERE run_id=?').get(RUN).c;

// ── T116.1 — EXACTLY ONE row per send, and a ZERO control ──────────────────
console.log('--- T116.1: exactly one row per send + zero control ---');
const before = { m: countMessages(), r: countMirror() };
log(before.m === 0 && before.r === 0, `ZERO CONTROL (pre-state): messages=${before.m} mirror_records=${before.r} — the counter CAN read zero`);

mirror.mirrorDispatch({ sender: 'ws-a', recipient: 'ws-b', body: 'hello', result: { ok: true, delivery: 'live' }, db });
const after1 = { m: countMessages(), r: countMirror() };
console.log(`after ONE mirrored send: messages=${after1.m} mirror_records=${after1.r}`);
log(after1.m - before.m === 1, `EXACTLY 1 message row per send (delta=${after1.m - before.m})`);
log(after1.r - before.r === 1, `EXACTLY 1 mirror_records row per send (delta=${after1.r - before.r})`);

// The non-message action control: recording a lost wake must produce ZERO rows.
const beforeNM = { m: countMessages(), r: countMirror() };
mirror.recordLostWake(shared.PEER_MESSAGE_MECHANISM, 1);
const afterNM = { m: countMessages(), r: countMirror() };
log(afterNM.m === beforeNM.m && afterNM.r === beforeNM.r,
  `NON-MESSAGE action produced 0 rows (messages ${beforeNM.m}->${afterNM.m}, mirror ${beforeNM.r}->${afterNM.r})`);

// ── T116.3 — the OUTCOME of the old channel is recorded, 3 DISTINCT values ──
console.log('--- T116.3: outcome column carries three distinct values ---');
// Drive each outcome from a DIFFERENT MessageResult shape, through the real
// outcomeFor()/mirrorDispatch path -- not by seeding the column.
const cases = [
  { label: 'delivered live',   result: { ok: true,  delivery: 'live' } },
  { label: 'parked in inbox',  result: { ok: true,  delivery: 'inbox' } },
  { label: 'withdrawn',        result: { ok: false, error: 'withdrawn' } },
];
const got = [];
for (const c of cases) {
  const o = mirror.mirrorDispatch({ sender: 'ws-a', recipient: 'ws-b', body: c.label, result: c.result, db });
  got.push(o);
  console.log(`  ${c.label.padEnd(16)} -> outcome '${o}'`);
}
const distinct = [...new Set(got)];
log(distinct.length === 3, `THREE DISTINCT outcome values produced by the real path: [${distinct.join(', ')}]`);
// And they must be persisted, not merely returned.
const persisted = db.prepare('SELECT DISTINCT outcome FROM mirror_records WHERE run_id=? ORDER BY outcome').all(RUN).map(r => r.outcome);
log(persisted.length >= 3, `outcomes PERSISTED in mirror_records: [${persisted.join(', ')}] (>=3 distinct)`);

// ── T116.2 — DB destroyed mid-run: DELIVERY STILL SUCCEEDS + error logged ──
console.log('--- T116.2: bus destroyed mid-run; assert the DELIVERY, not the absence of an error ---');
// Healthy arm first: the control proving the rig can see a success.
const healthy = mirror.mirrorDispatch({ sender: 'ws-a', recipient: 'ws-b', body: 'healthy', result: { ok: true, delivery: 'live' }, db });
log(healthy === 'live', `healthy arm outcome = '${healthy}' (control: the rig can observe a success)`);

// Now destroy the bus: close it and hand mirrorDispatch a CLOSED handle, which
// is what a mid-run failure looks like to this code path.
db.close();
let threw = null, brokenOutcome = null;
try {
  brokenOutcome = mirror.mirrorDispatch({ sender: 'ws-a', recipient: 'ws-b', body: 'broken', result: { ok: true, delivery: 'live' }, db });
} catch (e) { threw = e; }
log(threw === null, `mirrorDispatch did NOT throw with a destroyed bus${threw ? ': ' + threw.message : ''}`);
log(brokenOutcome === 'live',
  `POSITIVE TERMINATOR: the delivery outcome is STILL 'live' (got '${brokenOutcome}') — byte-identical to the healthy arm, so the mirror changed nothing`);

rmSync(dir, { recursive: true, force: true });
console.log(failures === 0 ? 'T116 RESULT: PASS' : `T116 RESULT: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
