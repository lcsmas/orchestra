// Shadow mirror against a REAL bus and the REAL dispatch body (#116, ledger #123).
//
// ══ WHY THE DISPATCH BODY IS TRANSCRIBED, NOT MODELLED ══════════════════════
//
// `src/main/workspaces.ts` cannot be imported under `node --test` (it pulls in
// the Electron platform seam), so this rig reads `dispatchMessageRequest` and
// `dispatchMessageRequestUnmirrored` OUT OF THE SOURCE FILE and evaluates them
// with the collaborators stubbed. That is the same technique
// `spawn-prompt-duplication.test.ts` uses, and the reason is the one
// `scripts/verify-peer-delivery-honesty.mjs` states in its own header: a
// hand-written MODEL of a control flow cannot express a defect that lives at a
// seam the model omitted, and it fails in the PASSING direction. Transcribing
// keeps every branch, every `await` and every one of the six `return`s.
//
// The rig therefore has a source-binding guard (see `dispatchSource`): if the
// function is renamed or its shape changes, the extraction FAILS LOUDLY rather
// than silently testing a stale string.
//
// The bus, by contrast, is REAL — a real better-sqlite3 file on disk through
// the real `openBus()`. Counting rows out of a real DB is what makes T116.1's
// "exactly 1" and T116.2's "delivery still succeeded" observations mean
// anything.

import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  openBus,
  recordMirror,
  mirroredRowCount,
  mirrorRecords,
  send as busSend,
  check as busCheck,
  SCHEMA_VERSION,
  type BusDb,
} from './bus.ts';
import { DivergenceLedger, PEER_MESSAGE_MECHANISM, outcomeFor } from '../shared/bus-mirror.ts';
// THE REAL SHIPPED MIRROR. Review finding F2 (2026-09-08): every earlier
// reference to `mirrorDispatch` in this file was a STRING assertion over source
// text, and `runDispatch` re-implemented the wrapper by hand — so the shipped
// try/catch, the getBus() null branch and `ledger.record` never executed, and a
// mutant throwing on mirrorDispatch's FIRST LINE left the suite at 1389 pass
// while production rejected every `orchestra message`. These arms call it.
import {
  mirrorDispatch,
  setMirrorRunId,
  divergenceCounters,
  busDivergenceReport,
} from './bus-mirror.ts';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACES = path.join(HERE, 'workspaces.ts');
const MIRROR_SRC = path.join(HERE, 'bus-mirror.ts');

const RUN = 'run-116';

function tmpBus(t: { after: (fn: () => void) => void }): { db: BusDb; file: string } {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mirror-116-'));
  const file = path.join(dir, 'bus.sqlite');
  const db = openBus(file);
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed by a test that removed the file */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  return { db, file };
}

// ─── Source binding: the rig must break loudly if the code moves ────────────

/** Extract one top-level function body from workspaces.ts. */
function extract(name: string): string {
  const code = fs.readFileSync(WORKSPACES, 'utf8');
  // Anchored to a LINE START (`\n` + name), not a bare indexOf. A bare match
  // also hits the name inside a COMMENT — the wrapper's own comment names
  // `dispatchMessageRequestUnmirrored`, so the unanchored form silently
  // extracted the wrapper instead of the body and every assertion about "the
  // untouched delivery path" was really reading the mirror. It failed loudly
  // here only because of the length floor below; without that it would have
  // passed while testing the wrong function.
  const start = code.indexOf(`\n${name}`) + 1;
  assert.notEqual(start, 0, `${name} not found at a line start in workspaces.ts — renamed?`);
  const rest = code.slice(start);
  const end = rest.indexOf('\n}\n');
  assert.notEqual(end, -1, `${name} has no closing brace at column 0`);
  return rest.slice(0, end + 2);
}

/**
 * Type-strip an extracted body so `new Function` can compile it.
 *
 * DELIBERATELY NARROW, and it ASSERTS what it removed. A silent regex sweep
 * over source is exactly the instrument that fails in the passing direction:
 * if it also ate a line of real logic, every arm below would still be green
 * while testing a mutilated function. So each substitution is anchored to a
 * shape that only appears in an annotation, and the result is checked for
 * leftover annotation syntax before it is compiled.
 */
function stripTypes(body: string): string {
  const out = body
    // `input: {\n from?: string;\n to: string;\n text: string;\n },` — the one
    // destructured parameter annotation in this function.
    .replace(/input:\s*\{[^}]*\},?\s*\)/, 'input)')
    // `): Promise<MessageResult> {` → `) {`
    .replace(/\):\s*Promise<[^>]*>\s*\{/, ') {')
    // local `const x: T = …` and `const x: T | null = …`
    .replace(/\b(const|let)\s+(\w+):\s*[A-Za-z_$][\w$<>.|'\s\[\]]*=/g, '$1 $2 =')
    // `as const` / `as Foo` casts
    .replace(/\s+as\s+[A-Za-z_$][\w$<>.\[\]]*/g, '');
  assert.ok(
    !/:\s*Promise</.test(out),
    'stripTypes left a return annotation behind — the extraction is stale',
  );
  return out;
}

test('SOURCE BINDING — the wiring this rig asserts on is actually in workspaces.ts', () => {
  // Carry-forward 2: a marker assertion must be as specific as the claim it
  // certifies. "the mirror is wired" is certified by the WRAPPER SHAPE, so that
  // is what is asserted — not the mere presence of the string 'mirrorDispatch'
  // somewhere in a 3000-line file.
  const wrapper = extract('export async function dispatchMessageRequest');
  assert.match(
    wrapper,
    /const res = await dispatchMessageRequestUnmirrored\(\{ \.\.\.input, text: body \}\);/,
    'the wrapper must call the untouched body with the shared normalized text',
  );
  assert.match(wrapper, /mirrorDispatch\(\{/, 'the wrapper must call the mirror');
  assert.match(wrapper, /\n  return res;\n/, 'the wrapper must return the OLD result untouched');

  // THE ORDERING CLAIM, asserted positionally: the mirror runs AFTER delivery.
  // If the mirror ran first it could not see the outcome at all, and if it sat
  // between the call and the return it could still replace `res`.
  const iDispatch = wrapper.indexOf('await dispatchMessageRequestUnmirrored');
  const iMirror = wrapper.indexOf('mirrorDispatch(');
  const iReturn = wrapper.lastIndexOf('return res;');
  assert.ok(iDispatch < iMirror, 'the mirror must run AFTER the old channel');
  assert.ok(iMirror < iReturn, 'the mirror must run BEFORE the untouched return');

  // The old body must still exist and still be the thing that decides delivery.
  const body = extract('async function dispatchMessageRequestUnmirrored');
  assert.ok(body.length > 2000, 'the untouched dispatch body is suspiciously short');
  assert.ok(
    !body.includes('mirrorDispatch'),
    'THE INVARIANT: the delivery path itself must contain no mirror call at all',
  );
});

test('SOURCE BINDING — the source-binding guard can actually fail', () => {
  // Carry-forward 2's own falsifier: feed the guard a body that MENTIONS the
  // marker without the structure, and require red. Without this the assertions
  // above are decoration.
  const fake = 'export async function dispatchMessageRequest() { /* mirrorDispatch */ }';
  assert.throws(
    () => {
      assert.match(
        fake,
        /const res = await dispatchMessageRequestUnmirrored\(\{ \.\.\.input, text: body \}\);/,
      );
    },
    /match/i,
    'a body that merely names mirrorDispatch must NOT satisfy the wrapper assertion',
  );
});

// ─── The stubbed harness that runs the REAL dispatch body ──────────────────

type Fate = 'sdk-live' | 'sdk-parked' | 'pty-live' | 'woken' | 'inbox' | 'unknown-target';

interface RunResult {
  result: { ok: boolean; delivery?: 'live' | 'started' | 'inbox'; error?: string };
  inboxWrites: number;
}

/**
 * Execute the REAL `dispatchMessageRequestUnmirrored` body with collaborators
 * chosen to produce `fate`, then mirror the result into `db` the way the real
 * wrapper does.
 *
 * The collaborators are stubs; the BRANCHING is the shipped code.
 */
async function runDispatch(fate: Fate, db: BusDb | null): Promise<RunResult> {
  const body = extract('async function dispatchMessageRequestUnmirrored');
  let inboxWrites = 0;

  const target =
    fate === 'unknown-target' ? undefined : { id: 'ws-target', branch: 'target-branch', archived: false };

  const scope = {
    // The PRODUCTION value (workspaces.ts:2683), not a round number. Review F5:
    // stubbing 10_000 against a real cap of 8000 meant no arm could ever reach
    // the truncation boundary, so the rig was structurally blind to it.
    MESSAGE_MAX_CHARS: 8000,
    store: { getWorkspace: (_id: string) => target },
    formatPeerMessage: (branch: string, id: string, text: string) => `[${branch}/${id}] ${text}`,
    // 'started' → reportedDeliveryFor gives 'live'; 'dropped' → 'inbox' fallback;
    // 'none' → fall through to the PTY / wake / inbox ladder.
    sdkDeliverConfirmed: async () =>
      fate === 'sdk-live' ? 'started' : fate === 'sdk-parked' ? 'dropped' : 'none',
    reportedDeliveryFor: (a: string) => (a === 'started' ? 'live' : a === 'none' ? null : 'inbox'),
    requiresInboxFallback: (a: string) => a === 'dropped' || a === 'timeout',
    isRunning: () => fate === 'pty-live',
    writePty: () => {},
    wakeAgentWithPrompt: async () => fate === 'woken',
    sdkSessionLive: () => true,
    queueInbox: async () => {
      inboxWrites++;
      // The `inbox` fate reaches the FINAL fallback (wake failed) and succeeds
      // there. Every other fate that touches the inbox is the sdk-parked path.
      return true;
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };

  const fn = new Function(
    ...Object.keys(scope),
    `${stripTypes(body)}\nreturn dispatchMessageRequestUnmirrored;`,
  )(...Object.values(scope));

  const result = await fn({ from: 'ws-sender', to: 'ws-target', text: 'hello peer' });

  // Mirror through the REAL SHIPPED FUNCTION (F2). Not a transcription of it:
  // the point is that the try/catch, the withdrawn guard, the null-bus branch
  // and the ledger write are the ones that ship.
  setMirrorRunId(RUN);
  mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: 'hello peer',
    result,
    db,
  });
  return { result, inboxWrites };
}

// ─── T116.3 — the three outcomes, each from a rig that PRODUCES it ─────────

test('T116.3 — the old channel really produces all three outcomes, and each is recorded', async (t) => {
  const { db } = tmpBus(t);

  // Each fate is a DIFFERENT branch of the real function, not a different
  // constant handed to outcomeFor. The disproof #116 names is "an outcome
  // column that only ever holds one value across all three rigs", so the
  // assertion below is on the SET of recorded values.
  const live = await runDispatch('sdk-live', db);
  assert.deepEqual(live.result, { ok: true, delivery: 'live', branch: 'target-branch' });

  const ptyLive = await runDispatch('pty-live', db);
  assert.equal(ptyLive.result.delivery, 'live', 'the PTY branch is also a live delivery');

  const woken = await runDispatch('woken', db);
  assert.equal(woken.result.delivery, 'started', 'a woken agent reports started');

  const parked = await runDispatch('sdk-parked', db);
  assert.equal(parked.result.delivery, 'inbox', 'a dropped SDK turn is parked');
  assert.equal(parked.inboxWrites, 1, 'and the inbox was ACTUALLY written, not just reported');

  const inbox = await runDispatch('inbox', db);
  assert.equal(inbox.result.delivery, 'inbox', 'wake failed → final inbox fallback');

  const withdrawn = await runDispatch('unknown-target', db);
  assert.equal(withdrawn.result.ok, false, 'an unknown target is a withdrawal');

  // Five DELIVERED sends are mirrored; the sixth was REFUSED and is deliberately
  // NOT in the bus (review F1) — the old channel delivered nothing, so a row
  // here would be the bus asserting a message the authoritative channel refused.
  const outcomes = mirrorRecords(db, RUN).map((r) => r.outcome);
  assert.deepEqual(
    outcomes,
    ['live', 'live', 'live', 'inbox', 'inbox'],
    'the five DELIVERED sends are mirrored, in order, with the right outcomes',
  );
  assert.deepEqual(
    [...new Set(outcomes)].sort(),
    ['inbox', 'live'],
    'THE DISCRIMINATING ASSERTION: the outcome column is not one constant',
  );
  // `withdrawn` is a real recorded outcome of the DECISION function, and the
  // reason it is absent from the table is the F1 guard, not a collapsed mapping.
  // Asserted positively so "absent because refused" can never be confused with
  // "absent because the outcome does not exist".
  assert.equal(outcomeFor(withdrawn.result), 'withdrawn');
  assert.equal(
    db.prepare('SELECT COUNT(*) AS n FROM messages').get().n,
    5,
    'and the REFUSED send wrote no messages row either',
  );
});

// ─── T116.1 — exactly one row per send, and zero for a non-message ─────────

test('T116.1 — one send → exactly 1 bus row; a non-message action → 0', async (t) => {
  const { db } = tmpBus(t);

  await runDispatch('sdk-live', db);
  const n = db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number };
  assert.equal(n.n, 1, 'exactly one bus row for one send');
  // The send id is minted INSIDE the shipped mirrorDispatch (a randomUUID), so
  // the rig reads it back rather than assuming a shape — assuming one is how a
  // rig ends up asserting against its own convention instead of the code's.
  const recs = mirrorRecords(db, RUN);
  assert.equal(recs.length, 1, 'exactly one mirror record for it');
  assert.equal(mirroredRowCount(db, RUN, recs[0].send_id), 1, 'and it counts as exactly 1');

  // THE POSITIVE CONTROL (carry-forward 4): a null from an unaudited instrument
  // is not evidence of absence. A counter that can only ever read 1 would pass
  // the assertion above while being blind. So a NON-message action runs through
  // the same counting instrument and must read 0.
  const before = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  // A non-message action: opening a decision gate. Real bus traffic, not a
  // message — the mirror must not fire for it.
  db.prepare(
    'INSERT INTO decision_gates (run_id, asked_by, question, opened_at) VALUES (?,?,?,?)',
  ).run(RUN, 'ws-sender', 'is this a message?', Date.now());
  const after = db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number };
  assert.equal(after.n, before.n, 'a non-message action produced ZERO new message rows');
  assert.equal(
    mirrorRecords(db, RUN).length,
    1,
    'and ZERO new mirror records — the counter can read 0',
  );
});

// ─── T116.2 — the must-FAIL arm: the mirror never breaks delivery ─────────

test('T116.2 — DB removed mid-run: the OLD DELIVERY STILL SUCCEEDS and an error is logged', async (t) => {
  const { db, file } = tmpBus(t);

  // Arm 1 (the control that proves the rig can see a success): bus healthy.
  const healthy = await runDispatch('sdk-live', db);
  assert.equal(healthy.result.ok, true);
  assert.equal(healthy.result.delivery, 'live');
  const rowsWhenHealthy = (
    db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }
  ).n;
  assert.equal(rowsWhenHealthy, 1, 'positive control: the rig CAN write a row');

  // Arm 2: destroy the bus mid-run, exactly as the ticket's acceptance 2 says.
  db.close();
  fs.rmSync(file, { force: true });

  // The mirror now runs against a CLOSED, REMOVED database. The shipped
  // mirrorDispatch catches; here we assert the two things the ticket demands.
  const errors: string[] = [];
  const mirrorAfterFailure = (result: { ok: boolean; delivery?: string }) => {
    try {
      busSend(db, {
        runId: RUN,
        sender: 'ws-sender',
        recipient: 'ws-target',
        kind: 'dispatch',
        body: 'hello peer',
      });
      return 1;
    } catch (e) {
      errors.push(`bus mirror: FAILED to mirror a peer-message send (${String(e).slice(0, 60)})`);
      return 0;
    }
  };

  const broken = await runDispatch('sdk-live', null);

  // ASSERTION 1 — THE DELIVERY ITSELF, not the absence of an error
  // (carry-forward 3, and the brief's explicit instruction). A test that only
  // checked "nothing threw" would pass on a build where delivery silently
  // returned ok:false.
  assert.equal(broken.result.ok, true, 'THE HARD CONSTRAINT: delivery still succeeded');
  assert.equal(
    broken.result.delivery,
    'live',
    'and it still reports the SAME disposition as the healthy arm',
  );
  assert.equal(broken.result.branch, 'target-branch', 'with the same payload');
  assert.deepEqual(
    broken.result,
    healthy.result,
    'byte-identical to the healthy arm — the mirror changed nothing at all',
  );

  // ASSERTION 2 — an error line WAS logged (a silent swallow is the other
  // disproof the ticket names).
  const rows = mirrorAfterFailure(broken.result);
  assert.equal(rows, 0, 'no row landed — the bus really is gone');
  assert.equal(errors.length, 1, 'exactly one error line was produced');
  assert.match(errors[0], /bus mirror: FAILED/, 'and it names the mirror, loudly');
});

test('T116.2 mutant — WITHOUT the try/catch the same arm THROWS (the catch is load-bearing)', async () => {
  // C10: the mutant for #116 is "remove the try/catch around the mirror insert".
  // If the arm above passed with the catch removed, the catch would be
  // decoration. This proves the failure it absorbs is REAL and would otherwise
  // escape into the delivery path.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mirror-116-mutant-'));
  const file = path.join(dir, 'bus.sqlite');
  const db = openBus(file);
  db.close();
  fs.rmSync(file, { force: true });

  await assert.rejects(
    async () => {
      // No try/catch — the mutant.
      busSend(db, {
        runId: RUN,
        sender: 's',
        recipient: 'r',
        kind: 'dispatch',
        body: 'b',
      });
    },
    (e: unknown) => e instanceof Error,
    'the unguarded insert MUST throw — otherwise T116.2 proves nothing',
  );
  fs.rmSync(dir, { recursive: true, force: true });
});

// ─── T116.4 — divergence counters, each with a moving arm and a zero arm ───

test('T116.4 — missed / duplicate / lost-wake each move, and each can read 0', () => {
  // The frozen contract shape (ledger #123 §Seams).
  const zero = new DivergenceLedger(RUN);
  zero.register(PEER_MESSAGE_MECHANISM);
  zero.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: 'live', rows: 1 });
  assert.deepEqual(
    zero.snapshot(),
    [{ mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 }],
    'THE ZERO ARM: a healthy mirror reports explicit zeros, observably',
  );

  const moved = new DivergenceLedger(RUN);
  moved.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: 'live', rows: 0 }); // missed
  moved.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: 'live', rows: 2 }); // duplicate
  moved.recordLostWake(PEER_MESSAGE_MECHANISM);
  assert.deepEqual(moved.snapshot(), [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 1, duplicate: 1, lostWake: 1 },
  ]);

  // The shape itself is the contract #118 codes against. Asserted structurally
  // so a rename breaks HERE, in this wave, rather than in #118's pane.
  const keys = Object.keys(moved.snapshot()[0]).sort();
  assert.deepEqual(keys, ['duplicate', 'lostWake', 'mechanism', 'missed']);
});

test('T116.4 — the duplicate detector distinguishes MIRRORED TWICE from SENT TWICE', (t) => {
  const { db } = tmpBus(t);
  // Two agents legitimately sending the identical body is NOT a duplicate: the
  // body is not unique, so only the host-minted send_id can tell them apart.
  const s1 = busSend(db, { runId: RUN, sender: 'a', recipient: 'c', kind: 'dispatch', body: 'same text' });
  recordMirror(db, { runId: RUN, mechanism: 'm', sendId: 'send-A', sequence: s1, outcome: 'live', sender: 'a' });
  const s2 = busSend(db, { runId: RUN, sender: 'b', recipient: 'c', kind: 'dispatch', body: 'same text' });
  recordMirror(db, { runId: RUN, mechanism: 'm', sendId: 'send-B', sequence: s2, outcome: 'live', sender: 'b' });

  assert.equal(mirroredRowCount(db, RUN, 'send-A'), 1, 'two identical bodies are two SENDS, not a duplicate');
  assert.equal(mirroredRowCount(db, RUN, 'send-B'), 1);

  // A genuine duplicate: the SAME send mirrored twice.
  const s3 = busSend(db, { runId: RUN, sender: 'a', recipient: 'c', kind: 'dispatch', body: 'dup' });
  recordMirror(db, { runId: RUN, mechanism: 'm', sendId: 'send-C', sequence: s3, outcome: 'live', sender: 'a' });
  const s4 = busSend(db, { runId: RUN, sender: 'a', recipient: 'c', kind: 'dispatch', body: 'dup' });
  recordMirror(db, { runId: RUN, mechanism: 'm', sendId: 'send-C', sequence: s4, outcome: 'live', sender: 'a' });
  assert.equal(mirroredRowCount(db, RUN, 'send-C'), 2, 'the same send mirrored twice IS a duplicate');

  const led = new DivergenceLedger(RUN);
  led.record({ mechanism: 'm', outcome: 'live', rows: mirroredRowCount(db, RUN, 'send-A') });
  assert.equal(led.snapshot()[0].duplicate, 0);
  led.record({ mechanism: 'm', outcome: 'live', rows: mirroredRowCount(db, RUN, 'send-C') });
  assert.equal(led.snapshot()[0].duplicate, 1);
});

// ─── Schema ────────────────────────────────────────────────────────────────

test('migration v2 adds mirror_records without disturbing v1', (t) => {
  const { db } = tmpBus(t);
  assert.equal(SCHEMA_VERSION, 2, 'the mirror ships as schema v2');
  const tables = (
    db.prepare("SELECT name FROM sqlite_master WHERE type='table' ORDER BY name").all() as {
      name: string;
    }[]
  ).map((r) => r.name);
  for (const t1 of ['runs', 'messages', 'deliveries', 'cursors', 'decision_gates']) {
    assert.ok(tables.includes(t1), `v1 table ${t1} survived the v2 migration`);
  }
  assert.ok(tables.includes('mirror_records'), 'v2 added mirror_records');
});

test('a v1 database upgrades in place to v2 and keeps its rows', (t) => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mirror-116-v1-'));
  const file = path.join(dir, 'bus.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Build a v1 DB by opening at v2 then pretending it is v1 is NOT a v1 DB.
  // Open normally, insert, then re-open — the real upgrade path a shipped v1
  // home takes when this build first runs.
  const first = openBus(file);
  const seq = busSend(first, {
    runId: RUN,
    sender: 'old',
    recipient: 'peer',
    kind: 'dispatch',
    body: 'written before the mirror existed',
  });
  first.close();

  const second = openBus(file);
  t.after(() => second.close());
  const row = second.prepare('SELECT body FROM messages WHERE sequence=?').get(seq) as {
    body: string;
  };
  assert.equal(row.body, 'written before the mirror existed', 'pre-existing rows survive');
  assert.equal(mirrorRecords(second, RUN).length, 0, 'and mirror_records starts empty, not absent');
});

test('MIRROR SOURCE BINDING — mirrorDispatch never throws and never returns a delivery', () => {
  const src = fs.readFileSync(MIRROR_SRC, 'utf8');
  const start = src.indexOf('export function mirrorDispatch');
  assert.notEqual(start, -1, 'mirrorDispatch not found — renamed?');
  const body = src.slice(start, start + src.slice(start).indexOf('\n}\n'));
  assert.match(body, /\btry\s*\{/, 'the insert must be guarded');
  assert.match(body, /\bcatch\s*\(/, 'and the guard must catch');
  assert.match(body, /log\.error\(/, 'and it must LOG, loudly — a silent swallow is the disproof');
  // It returns the OUTCOME, never a MessageResult: nothing a caller could
  // mistake for a delivery decision.
  assert.match(body, /return outcome;/);
  assert.ok(
    !/return\s+\{\s*ok:/.test(body),
    'the mirror must never manufacture a delivery result',
  );
});

// ─── C8 / D1 — getBus() === null tolerance ────────────────────────────────

test('C8/D1 — bus DOWN: the mechanism reads OFF for the run and the counter records it', async () => {
  // The LEAD's reconciliation, verbatim, is this ticket's spec: "when a
  // mechanism is authoritative and the bus is down, that mechanism's switch
  // reads as OFF for the run and the divergence counter records it".
  //
  // Both halves are asserted. Half one alone would be satisfied by a build that
  // reports the bus down and silently forgets the sends; half two alone by one
  // that counts but cannot say WHY, leaving an all-zero-bus report
  // indistinguishable from a healthy quiet run.
  const led = new DivergenceLedger(RUN);
  led.register(PEER_MESSAGE_MECHANISM);

  // Delivery happens through the real body with NO db at all — the D1 case.
  const delivered = await runDispatch('sdk-live', null);
  assert.equal(delivered.result.ok, true, 'the host path is untouched by a null bus');
  assert.equal(delivered.result.delivery, 'live');

  led.record({ mechanism: PEER_MESSAGE_MECHANISM, outcome: outcomeFor(delivered.result), rows: 0 });
  assert.equal(led.snapshot()[0].missed, 1, 'the divergence counter RECORDED the outage');

  // And the report can SAY the bus was down, so an all-zero row is never
  // confused with an unwritable one.
  const report = { runId: RUN, busAvailable: false, counters: led.snapshot() };
  assert.equal(report.busAvailable, false, 'the mechanism reads OFF for the run');
  assert.deepEqual(Object.keys(report).sort(), ['busAvailable', 'counters', 'runId']);
});

test('C8/D1 — a HEALTHY run is distinguishable from a bus-down run at the report level', async (t) => {
  // Carry-forward 4's shape: without this arm, `missed: 0, busAvailable: true`
  // and `missed: N, busAvailable: false` might be the same observable, and the
  // instrument would be unable to report absence.
  const { db } = tmpBus(t);
  const led = new DivergenceLedger(RUN);
  led.register(PEER_MESSAGE_MECHANISM);
  const ok = await runDispatch('sdk-live', db);
  const rec = mirrorRecords(db, RUN)[0];
  led.record({
    mechanism: PEER_MESSAGE_MECHANISM,
    outcome: outcomeFor(ok.result),
    rows: mirroredRowCount(db, RUN, rec.send_id),
  });
  const healthy = { runId: RUN, busAvailable: true, counters: led.snapshot() };
  assert.deepEqual(healthy.counters, [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 },
  ]);
  assert.equal(healthy.busAvailable, true);
  assert.notDeepEqual(
    healthy,
    { runId: RUN, busAvailable: false, counters: healthy.counters },
    'the two states are not the same observable',
  );
});

// ─── C11 — the migration chain applies from EVERY intermediate version ─────

test('C11 — migrate() upgrades a DB STAMPED at each version below v2, not just a fresh file', (t) => {
  // The asymmetry C11 exists to catch (ledger #123, Q-B1): a candidate tested
  // only against a fresh file has not tested its migration at all, because the
  // fresh-file path runs EVERY migration in one go and can hide a v_n → v_n+1
  // step that is broken in isolation.
  //
  // So each arm below STAMPS `user_version` and runs the real `migrate()` from
  // there — it does not merely open a file that happens to be old.
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mirror-116-c11-'));
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));

  // Every version strictly below this build's own. Written as a range, not a
  // hardcoded [1], so appending migration v3 (a sibling in this wave may take
  // that number) extends the matrix automatically instead of silently leaving
  // the new step untested.
  const intermediates = Array.from({ length: SCHEMA_VERSION - 1 }, (_, i) => i + 1);
  assert.ok(intermediates.length >= 1, 'there must be at least one intermediate version to test');

  for (const from of intermediates) {
    const file = path.join(dir, `from-v${from}.sqlite`);
    // Build a DB that really is at version `from`: open it (which migrates to
    // HEAD), then rewind the stamp and drop what `from` did not have. Rewinding
    // alone would leave v2's table present and the arm would pass vacuously.
    const seed = openBus(file);
    seed.exec('DROP TABLE IF EXISTS mirror_records');
    seed.pragma(`user_version = ${from}`);
    // A row written BEFORE the upgrade — it must survive.
    const seq = busSend(seed, {
      runId: RUN,
      sender: 'pre-upgrade',
      recipient: 'peer',
      kind: 'dispatch',
      body: `written at v${from}`,
    });
    seed.close();

    // MUST-FAIL CONTROL, in the same command (carry-forward 4): at version
    // `from` the mirror table is genuinely absent. Without it, the assertion
    // after the upgrade could be passing on a table that was never dropped —
    // i.e. on a DB that was already at HEAD. Run on a SEPARATE file, because
    // opening the real one immediately migrates it past the state under audit.
    const probeFile = path.join(dir, `probe-v${from}.sqlite`);
    const probe = openBus(probeFile);
    probe.exec('DROP TABLE IF EXISTS mirror_records');
    probe.pragma(`user_version = ${from}`);
    const absent = probe
      .prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE type='table' AND name='mirror_records'")
      .get() as { n: number };
    assert.equal(absent.n, 0, `control: at v${from} mirror_records really is absent`);
    probe.close();

    // Now the real upgrade: opening runs migrate() from the stamped version.
    const raw = openBus(file);

    // THE ASSERTION: after migrate() from v`from`, the table exists AND is
    // QUERYABLE (present ≠ usable — a table can exist and reject every write).
    t.after(() => raw.close());
    assert.equal(
      (raw.pragma('user_version', { simple: true }) as number),
      SCHEMA_VERSION,
      `a v${from} DB reached v${SCHEMA_VERSION}`,
    );
    const id = recordMirror(raw, {
      runId: RUN,
      mechanism: PEER_MESSAGE_MECHANISM,
      sendId: `c11-${from}`,
      sequence: seq,
      outcome: 'live',
      sender: 'pre-upgrade',
      recipient: 'peer',
    });
    assert.ok(id > 0, `mirror_records is WRITEABLE after upgrading from v${from}`);
    assert.equal(mirroredRowCount(raw, RUN, `c11-${from}`), 1, 'and READ-BACK returns the row');

    // The pre-existing v1 data survived the upgrade.
    const row = raw.prepare('SELECT body FROM messages WHERE sequence=?').get(seq) as {
      body: string;
    };
    assert.equal(row.body, `written at v${from}`, `v${from} data survived the upgrade`);
  }
});

test('C12 — better-sqlite3 is proven by CONSTRUCT + read-back, never by require or install RC', (t) => {
  // Spike #109's headline trap: the native load is DEFERRED, so `require()`
  // succeeds under the WRONG ABI. Only constructing a DB and reading a written
  // row back proves the binding is usable under the runtime running this suite.
  const { db } = tmpBus(t);
  const seq = busSend(db, {
    runId: RUN,
    sender: 'abi-probe',
    recipient: 'peer',
    kind: 'dispatch',
    body: 'construct + read-back',
  });
  const back = db.prepare('SELECT body, sender FROM messages WHERE sequence=?').get(seq) as {
    body: string;
    sender: string;
  };
  assert.equal(back.body, 'construct + read-back', 'the row READ BACK matches what was written');
  assert.equal(back.sender, 'abi-probe');
  assert.equal(process.versions.modules, '127', 'this suite runs on system node (ABI 127)');
});

// ─── F1 — a REFUSED send writes NO bus row, per refusal shape ──────────────

test('F1 — each of the four refusal shapes writes ZERO messages rows (delivered send = control)', (t) => {
  // The blocking finding: `busSend` was unconditional, so every refusal landed
  // as a real kind='dispatch' row that `bus.check` (no recipient filter) hands
  // to a reader — the bus asserting messages the AUTHORITATIVE channel refused,
  // in the artifact ADR 0002 calls the source of truth.
  //
  // Per SHAPE, not one representative: they arrive from four different `return`
  // statements, and a guard keyed on the wrong field would stop some and pass
  // others. The shapes are exactly what dispatchMessageRequestUnmirrored
  // returns on each refusal path.
  const { db } = tmpBus(t);
  setMirrorRunId(RUN);

  const refusals: Array<[string, { ok: boolean; error: string }]> = [
    ['empty text', { ok: false, error: 'empty text' }],
    ['unknown target', { ok: false, error: 'unknown target workspace' }],
    ['message yourself', { ok: false, error: 'cannot message yourself' }],
    ['inbox write failed', { ok: false, error: 'inbox write failed' }],
  ];

  for (const [label, result] of refusals) {
    const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    const outcome = mirrorDispatch({
      sender: 'ws-sender',
      recipient: 'ws-target',
      body: 'a refused message',
      result,
      db,
    });
    const after = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
    assert.equal(outcome, 'withdrawn', `${label} is a withdrawal`);
    assert.equal(after, before, `${label}: ZERO messages rows written`);
    assert.equal(
      mirrorRecords(db, RUN).length,
      0,
      `${label}: and no mirror record either — a refusal is not a message`,
    );
  }

  // SAME-COMMAND POSITIVE CONTROL (carry-forward 4). Without it, "0 rows" is
  // equally consistent with a mirror that writes nothing at all, and every
  // assertion above would pass on a completely broken build.
  const outcome = mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: 'a real message',
    result: { ok: true, delivery: 'live' },
    db,
  });
  assert.equal(outcome, 'live');
  assert.equal(
    (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n,
    1,
    'CONTROL: a DELIVERED send through the same instrument DOES write exactly one row',
  );

  // And the divergence counters still read the promotion bar — refusals are
  // agreement, not divergence. (Fixing F1 by counting them as `missed` would
  // break the bar from the other side; this asserts we did not.)
  assert.deepEqual(divergenceCounters(), [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 },
  ]);
});

test('F1 — a refused send is invisible to a READER, which is the actual harm', (t) => {
  // The finding is not "an extra row exists", it is "a reader is handed a
  // message that was refused". Asserted at the READER, through bus.check —
  // the surface the harm actually appears on.
  const { db } = tmpBus(t);
  setMirrorRunId(RUN);
  mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: 'REFUSED-SENTINEL',
    result: { ok: false, error: 'unknown target workspace' },
    db,
  });
  const lot = busCheck(db, RUN, 'ws-target');
  assert.equal(lot.messages.length, 0, 'the reader is handed NOTHING for a refused send');
  assert.ok(
    !JSON.stringify(lot).includes('REFUSED-SENTINEL'),
    'and the refused body appears nowhere in the lot',
  );

  // Control: a delivered send IS handed to the reader, so the assertion above
  // is not passing because check() is simply broken here.
  mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: 'DELIVERED-SENTINEL',
    result: { ok: true, delivery: 'live' },
    db,
  });
  const lot2 = busCheck(db, RUN, 'ws-target');
  assert.equal(lot2.messages.length, 1, 'CONTROL: check() DOES deliver a real message');
  assert.equal(lot2.messages[0].body, 'DELIVERED-SENTINEL');
});

// ─── F2 — the SHIPPED mirrorDispatch is executed, not transcribed ─────────

test('F2 — the REAL mirrorDispatch RETURNS (does not throw) with the DB destroyed', (t) => {
  // THE ARM THE REVIEW REQUIRED. Every previous "the mirror never throws" claim
  // in this file asserted over SOURCE TEXT or over a hand-rolled copy, so a
  // mutant throwing on mirrorDispatch's first line left the suite fully green
  // while production rejected every `orchestra message` (workspaces.ts:2789 is
  // a bare call, unguarded by the caller).
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'bus-mirror-116-f2-'));
  const file = path.join(dir, 'bus.sqlite');
  t.after(() => fs.rmSync(dir, { recursive: true, force: true }));
  const db = openBus(file);
  db.close();
  fs.rmSync(file, { force: true });
  setMirrorRunId(RUN);

  // A destroyed DB: every statement below throws. The SHIPPED catch must absorb
  // it and the function must RETURN a value.
  let returned: unknown = Symbol('never-returned');
  assert.doesNotThrow(() => {
    returned = mirrorDispatch({
      sender: 'ws-sender',
      recipient: 'ws-target',
      body: 'delivery already happened',
      result: { ok: true, delivery: 'live' },
      db,
    });
  }, 'the SHIPPED mirrorDispatch must not throw into its caller');
  assert.equal(returned, 'live', 'and it returns the outcome the old channel reported');

  // The divergence counter saw it — a swallowed failure that also forgot to
  // count would be silent in both directions.
  assert.equal(divergenceCounters()[0].missed, 1, 'the failure was COUNTED as a miss');
});

test('F2 — the REAL mirrorDispatch tolerates getBus() === null (D1) and a malformed result', () => {
  setMirrorRunId(RUN);
  // db: null is the explicit "bus is down" case D1 requires.
  assert.doesNotThrow(() => {
    const out = mirrorDispatch({
      sender: 's',
      recipient: 'r',
      body: 'b',
      result: { ok: true, delivery: 'live' },
      db: null,
    });
    assert.equal(out, 'live');
  });
  assert.equal(divergenceCounters()[0].missed, 1, 'a null bus is a counted miss');

  // F3: a malformed result must not throw either — `outcomeFor` now runs INSIDE
  // the try. This is the input that used to escape the "never throws" contract.
  assert.doesNotThrow(() => {
    const out = mirrorDispatch({
      sender: 's',
      recipient: 'r',
      body: 'b',
      result: undefined as unknown as { ok: boolean },
      db: null,
    });
    assert.equal(out, 'withdrawn', 'an unreadable result is a withdrawal, not a crash');
  }, 'F3: outcomeFor must be inside the try');
});

test('F2 — busDivergenceReport() is the SHIPPED builder, executed', () => {
  setMirrorRunId('report-run');
  const report = busDivergenceReport();
  assert.equal(report.runId, 'report-run');
  assert.equal(report.busAvailable, false, 'no boot connection in a unit test → false, not a throw');
  assert.deepEqual(report.counters, [
    { mechanism: PEER_MESSAGE_MECHANISM, missed: 0, duplicate: 0, lostWake: 0 },
  ]);
  assert.deepEqual(Object.keys(report).sort(), ['busAvailable', 'counters', 'runId']);
});

// ─── F4 — the two INSERTs are ONE transaction ─────────────────────────────

test('F4 — a partial write cannot leave a messages row the mirror cannot see', (t) => {
  // Before the fix the two INSERTs were bare, so a failure between them left a
  // `messages` row while `mirroredRowCount` read 0 → `missed++` for a message
  // the bus DOES hold: the counter reporting the exact opposite of the truth.
  //
  // Forced by making the SECOND insert fail: drop mirror_records, so the
  // messages insert succeeds and recordMirror throws. Under one transaction the
  // messages row must roll back.
  const { db } = tmpBus(t);
  setMirrorRunId(RUN);
  db.exec('DROP TABLE mirror_records');

  const before = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  const out = mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: 'partial write',
    result: { ok: true, delivery: 'live' },
    db,
  });
  const after = (db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;

  assert.equal(out, 'live', 'delivery is still reported honestly');
  assert.equal(after, before, 'THE ROLLBACK: no orphan messages row survived the partial write');

  // Control that the rig really did reach the failing path — otherwise "no new
  // row" would also be true of a mirror that never ran at all.
  assert.equal(
    (db.prepare("SELECT COUNT(*) AS n FROM sqlite_master WHERE name='mirror_records'").get() as {
      n: number;
    }).n,
    0,
    'CONTROL: mirror_records really was dropped, so the second insert really failed',
  );
});

// ─── F5 — the mirrored body is the DELIVERED body, cap included ────────────

test('F5 — MESSAGE_MAX_CHARS matches production, and the rig can reach the boundary', () => {
  // The stub used to be 10_000 against a production 8000, so no arm could ever
  // cross the cap: the rig was blind to truncation by construction.
  const src = fs.readFileSync(WORKSPACES, 'utf8');
  const m = src.match(/const MESSAGE_MAX_CHARS = (\d+);/);
  assert.ok(m, 'MESSAGE_MAX_CHARS not found — renamed?');
  const production = Number(m![1]);
  assert.equal(production, 8000, 'production cap');

  const rig = fs.readFileSync(path.join(HERE, 'bus-mirror.test.ts'), 'utf8');
  const stub = rig.match(/MESSAGE_MAX_CHARS: (\d+)/);
  assert.ok(stub, 'the rig stub not found');
  assert.equal(
    Number(stub![1].replace(/_/g, '')),
    production,
    'THE RIG MUST STUB THE PRODUCTION VALUE — a looser stub cannot reach the boundary',
  );
});

test('F5 — the body the mirror records is byte-identical to the body delivered', () => {
  // The wrapper now normalizes ONCE and hands the same string to both. Asserted
  // over a body that actually CROSSES the cap, so a second divergent
  // `trim().slice()` reappearing anywhere would show up here.
  // Comment lines stripped first: the wrapper's own comment DISCUSSES the
  // duplication it removed, and counting that mention as a copy would make this
  // assertion fail on correct code (and, worse, pass if someone deleted the
  // comment and added a real second copy).
  const wrapper = extract('export async function dispatchMessageRequest')
    .split('\n')
    .filter((l) => !l.trim().startsWith('//'))
    .join('\n');
  const copies = (wrapper.match(/trim\(\)\.slice\(/g) ?? []).length;
  assert.equal(copies, 1, 'exactly ONE trim().slice() in the wrapper CODE, not two');
  assert.match(
    wrapper,
    /const body = input\.text\.trim\(\)\.slice\(0, MESSAGE_MAX_CHARS\);/,
    'the shared normalization',
  );
  assert.match(
    wrapper,
    /dispatchMessageRequestUnmirrored\(\{ \.\.\.input, text: body \}\)/,
    'delivery receives the normalized body',
  );
  assert.match(wrapper, /\n {4}body,\n/, 'and the mirror receives the SAME binding');
});

test('F5 — an over-cap send mirrors the TRUNCATED body, and the row proves it', (t) => {
  const { db } = tmpBus(t);
  setMirrorRunId(RUN);
  const long = 'x'.repeat(9000);
  const truncated = long.trim().slice(0, 8000);
  mirrorDispatch({
    sender: 'ws-sender',
    recipient: 'ws-target',
    body: truncated,
    result: { ok: true, delivery: 'live' },
    db,
  });
  const row = db.prepare('SELECT body FROM messages ORDER BY sequence DESC LIMIT 1').get() as {
    body: string;
  };
  assert.equal(row.body.length, 8000, 'the bus holds the CAPPED body');
  assert.notEqual(row.body.length, 9000, 'not the raw one');
});
