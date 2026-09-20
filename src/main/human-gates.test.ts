// Acceptance arms for human-directed decision gates (#161), driven over a REAL
// SQLite bus — no mock. These pin the LIFECYCLE the two UI surfaces ride:
//   • a gate opened to the human is readable fleet-wide and wakes NO agent;
//   • resolving it records resolved_by=human AND re-wakes the ASKER;
//   • re-resolve is refused (the first ruling stands, two windows can't clobber);
//   • the read is DURABLE (survives closing and reopening the DB) and
//     BACKFILL==LIVE (rebuilt from the row, not from memory).
//
// The pixel-asserted RENDER of surfaces A/B, and the cross-surface LIVE flip,
// are the headless-sway E2E's job (a DOM/store read is blind to a glyphless
// render); this file is the deterministic DB half. Each arm names the clause it
// covers and the mutation that reddens it.
//
// The pure `main/human-gates.ts` read/resolve wrap getBus()+store (an Electron
// seam node --test can't import), so these arms drive the SHIPPED bus functions
// those wrappers call — `openGatesForRecipientAllRuns` (the fleet-wide human
// read) and `resolveGate` + `sendGateResolutionRewake` (the resolve + re-wake) —
// exactly as `resolveHumanGate` composes them. A source-binding note below keeps
// the two in step.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  openBus,
  openGate,
  resolveGate,
  getGate,
  sendGateResolutionRewake,
  openGatesForRecipientAllRuns,
  openGatesForRecipient,
  check,
  type BusDb,
} from './bus.ts';
import { readPendingReaders } from './bus-wake.ts';
import { HUMAN_GATE_RECIPIENT } from '../shared/human-gates.ts';

const RUN = 'run-A';
const OTHER_RUN = 'run-B';

function tmpBus(t: { after: (fn: () => void) => void }): BusDb {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-humangate-test-'));
  const db = openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed by a durability arm that reopens */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return db;
}

test('HUMAN_GATE_RECIPIENT gate: readable fleet-wide, across runs, oldest-first', (t) => {
  const db = tmpBus(t);
  // Two human gates in DIFFERENT runs (the human sees the whole fleet, unlike an
  // agent recipient scoped to its related run set).
  const g1 = openGate(db, RUN, 'ws-alpha', 'Ship the 303 arm?', HUMAN_GATE_RECIPIENT);
  const g2 = openGate(db, OTHER_RUN, 'ws-beta', 'Go/no-go on attach?', HUMAN_GATE_RECIPIENT);
  // A gate to an AGENT (not the human) must NOT appear in the human read.
  openGate(db, RUN, 'ws-alpha', 'peer question', 'ws-gamma');
  // A gate to nobody (NULL recipient) must NOT appear either.
  openGate(db, RUN, 'ws-alpha', 'addressed to no one');

  const gates = openGatesForRecipientAllRuns(db, HUMAN_GATE_RECIPIENT);
  assert.deepEqual(gates.map((g) => g.id), [g1, g2], 'both human gates, both runs, oldest first');
  assert.equal(gates.every((g) => g.recipient === HUMAN_GATE_RECIPIENT), true);
  // MUTANT: drop `AND recipient=?` → the agent + null gates leak in (len 4).
  // MUTANT: scope to a single run → g2 (OTHER_RUN) vanishes (len 1).
});

test('opening a human gate wakes NO agent (acceptance 1: no agent woken)', (t) => {
  const db = tmpBus(t);
  openGate(db, RUN, 'ws-alpha', 'Ship it?', HUMAN_GATE_RECIPIENT);
  // The wake predicate must not surface a HUMAN-recipient gate to any AGENT
  // reader: 'human' is not a workspace id, so no agent is woken for it. Positive
  // control in the SAME arm: an agent-recipient gate DOES make its recipient
  // pending, proving the predicate can fire (an all-quiet result would be a
  // vacuous pass — a dead predicate looks identical to "correctly no wake").
  openGate(db, RUN, 'ws-alpha', 'agent question', 'ws-gamma');
  // Drive the real wake predicate over an agent roster (each reader in RUN). It
  // returns per-reader pending state; a reader is woken iff `pending` or
  // `gatePending`. NB: 'human' is never in an agent roster (it is not a
  // workspace), so no reader is ever woken FOR the human gate.
  const states = readPendingReaders(db, [
    { reader: 'ws-gamma', runId: RUN },
    { reader: 'ws-delta', runId: RUN },
  ]);
  const woken = (r: string) => {
    const s = states.find((p) => p.reader === r);
    return !!s && (s.pending || s.gatePending === true);
  };
  // ws-gamma is woken by ITS agent gate (control — proves the predicate can fire;
  // an all-quiet result would be a vacuous pass). ws-delta, addressed by neither
  // gate, is not woken — the HUMAN gate contributes nothing to any agent reader.
  assert.equal(woken('ws-gamma'), true, 'agent-gate recipient IS woken (positive control)');
  assert.equal(woken('ws-delta'), false, 'no agent is woken by the human-recipient gate');
});

test('resolve records resolved_by=human and re-wakes the ASKER (acceptance 2)', (t) => {
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, 'ws-alpha', 'Ship the 303 arm?', HUMAN_GATE_RECIPIENT);
  // The exact composition resolveHumanGate() performs: read BEFORE, resolve, then
  // re-wake with the pre-resolve gate row.
  const before = getGate(db, gateId)!;
  const ok = resolveGate(db, gateId, HUMAN_GATE_RECIPIENT, 'nominate it');
  assert.equal(ok, true, 'the open gate resolved');
  sendGateResolutionRewake(db, before, HUMAN_GATE_RECIPIENT, 'nominate it');

  const g = getGate(db, gateId)!;
  assert.equal(g.resolved_by, HUMAN_GATE_RECIPIENT, 'resolved_by=human — the audit trail');
  assert.equal(g.resolution, 'nominate it');
  assert.notEqual(g.resolved_at, null);

  // The asker is re-woken: a threaded decision_gate message addressed to it lands
  // in ITS run, so its normal lot check surfaces the ruling. Assert on the
  // delivered lot (the observable the asker actually sees), not just a raw row.
  const lot = check(db, RUN, 'ws-alpha');
  const reply = lot.messages.find((m) => m.thread_id === `gate:${gateId}`);
  assert.ok(reply, 'the asker receives a threaded gate-resolution message');
  assert.equal(reply!.kind, 'decision_gate');
  assert.equal(reply!.recipient, 'ws-alpha', 'addressed to the ASKER');
  assert.equal(reply!.body, 'nominate it', 'carries the ruling');
  // MUTANT: drop the sendGateResolutionRewake call → no reply, asker never woken.
  // MUTANT: resolved_by literal changed → resolved_by assertion reddens.
});

test('resolve is idempotent-by-refusal: the first ruling stands (acceptance 2, race)', (t) => {
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, 'ws-alpha', 'Ship it?', HUMAN_GATE_RECIPIENT);
  assert.equal(resolveGate(db, gateId, HUMAN_GATE_RECIPIENT, 'first answer'), true);
  // A second window races to answer the same gate — must be refused, first stands.
  assert.equal(resolveGate(db, gateId, HUMAN_GATE_RECIPIENT, 'second answer'), false);
  assert.equal(getGate(db, gateId)!.resolution, 'first answer', 'the first ruling is intact');
  // MUTANT: drop `WHERE resolved_at IS NULL` in resolveGate → the second wins.
});

test('a resolved gate leaves the fleet human read (surface retracts)', (t) => {
  const db = tmpBus(t);
  const gateId = openGate(db, RUN, 'ws-alpha', 'Ship it?', HUMAN_GATE_RECIPIENT);
  assert.equal(openGatesForRecipientAllRuns(db, HUMAN_GATE_RECIPIENT).length, 1);
  resolveGate(db, gateId, HUMAN_GATE_RECIPIENT, 'done');
  assert.equal(
    openGatesForRecipientAllRuns(db, HUMAN_GATE_RECIPIENT).length,
    0,
    'the resolved gate is gone from the OPEN read — the row retracts from A and B',
  );
});

test('backfill==live AND durable across restart (acceptance 4 + 5)', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-humangate-durable-'));
  const file = path.join(dir, 'bus.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // "Live": open a gate, read it back from the SAME connection.
  const db1 = openBus(file);
  const gateId = openGate(db1, RUN, 'ws-alpha', 'Ship the 303 arm?', HUMAN_GATE_RECIPIENT);
  const live = openGatesForRecipientAllRuns(db1, HUMAN_GATE_RECIPIENT);
  db1.close();

  // "Backfill" after an app restart: a FRESH connection to the same file must
  // rebuild the identical open set — the row is the source of truth, there is no
  // in-memory gate state to lose. This is BOTH the #57 backfill==live rule and
  // the durable-across-restart acceptance, because the read IS the reconstruction.
  const db2 = openBus(file);
  const backfill = openGatesForRecipientAllRuns(db2, HUMAN_GATE_RECIPIENT);
  db2.close();

  assert.deepEqual(
    backfill.map((g) => [g.id, g.recipient, g.question, g.asked_by, g.run_id]),
    live.map((g) => [g.id, g.recipient, g.question, g.asked_by, g.run_id]),
    'a gate read after a restart is byte-identical to the live read',
  );
  assert.equal(backfill.length, 1);
  assert.equal(backfill[0].id, gateId);
});

test('openGatesForRecipient (single-run) still excludes cross-run human gates — the human read must NOT be it', (t) => {
  // Guards the design choice: the human read is the ALL-RUNS variant, not the
  // single-run one. If a future edit points the human surface at
  // openGatesForRecipient, THIS arm documents why it would go blind cross-run.
  const db = tmpBus(t);
  openGate(db, OTHER_RUN, 'ws-beta', 'cross-run human gate', HUMAN_GATE_RECIPIENT);
  assert.equal(
    openGatesForRecipient(db, RUN, HUMAN_GATE_RECIPIENT).length,
    0,
    'single-run read from RUN cannot see a gate in OTHER_RUN',
  );
  assert.equal(
    openGatesForRecipientAllRuns(db, HUMAN_GATE_RECIPIENT).length,
    1,
    'the all-runs read (what the human surface uses) sees it',
  );
});

// Source-binding: resolveHumanGate() in main/human-gates.ts MUST compose exactly
// these shipped functions (read-before → resolveGate(…, 'human', …) →
// sendGateResolutionRewake), so the arms above measure the real path. A crude
// but load-bearing check: the module's source names all three, so a refactor
// that drops one is caught here rather than only in the E2E.
test('resolveHumanGate composes the functions these arms drive (source-binding)', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'human-gates.ts'), 'utf8');
  for (const needle of ['resolveGate(', 'sendGateResolutionRewake(', 'HUMAN_GATE_RECIPIENT']) {
    assert.ok(src.includes(needle), `human-gates.ts must call ${needle}`);
  }
  // And it must read the gate BEFORE resolving (the re-wake needs the pre-resolve
  // asked_by). A body that resolved first would pass the arms above (they hard-code
  // the order) but break the shipped re-wake, so pin the order in source.
  const readIdx = src.indexOf('getGate(db, gateId)');
  const resolveIdx = src.indexOf('resolveGate(db, gateId');
  assert.ok(readIdx > -1 && resolveIdx > -1 && readIdx < resolveIdx, 'read the gate BEFORE resolving');
});
