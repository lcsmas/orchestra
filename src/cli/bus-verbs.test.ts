import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from '../main/bus.ts';
import { withReceipt } from '../main/bus-receipts.ts';
import {
  BUS_KINDS,
  DEFAULT_RUN_ID,
  describeBusOpenFailure,
  lotToOutput,
  renderLotMarkdown,
  resolveBusIdentity,
  verbAck,
  verbAsk,
  verbCheck,
  verbGate,
  verbSend,
  type BusVerbCtx,
} from './bus-verbs.ts';
import { startRun } from '../main/bus-runs.ts';
import { DEFAULT_BUS_SWITCHES } from '../shared/bus-switches.ts';

// These drive the verbs against a REAL SQLite bus on a real temp file, through
// the REAL src/main/bus.ts — no fake bus module. The whole class of bug #115 can
// have is "which rows does the reader get, and did the host ack for it", and a
// stand-in for the delivery table would just re-encode the answer I already
// believed. (The rig-measures-the-rig failure scripts/verify-bus-contention.mjs
// documents in its header is the same lesson, one layer down.)
//
// The RUNTIME half of the ticket — that the verbs work under real Electron and
// fail loudly under system node — cannot be asserted from inside this process,
// which IS system node. It is scripts/verify-bus-cli-verbs.sh, and the two
// halves are deliberately separate: a test that could pass under either runtime
// would tell us nothing about which one it ran on.
//
// EACH TEST NAMES THE PRODUCTION CLAUSE IT COVERS, so the C10 mutation arm has a
// target and a test that survives its own mutant is visible as decoration.

const RUN = 'run-cli';

interface Rig {
  /** `fencing` (#128) defaults to the unfenced path — no generation presented,
   *  switch OFF — so every pre-#128 verb test runs with the fence inert (a pass),
   *  which is what they assert. A fencing arm passes real values explicitly. */
  ctx: (handle: string, fencing?: { generation?: number | null; fencingOn?: boolean }) => BusVerbCtx;
  db: import('../main/bus.ts').BusDb;
  out: string[];
  fails: string[];
  /** #129 — flip the `capability` switch the capability seam reads. Off by
   *  default (shadow mode), so the default rig exercises COUNTED-not-FIRED. */
  setCapabilityEnabled: (on: boolean) => void;
  /** #130: the receipt gating switch this rig reports to the verbs, mutable per
   *  test so both the ON (short-circuit) and OFF (counted-not-fired) arms run
   *  through the SAME code path a real CLI takes. */
  switchOn: boolean;
}

function rig(t: { after: (fn: () => void) => void }): Rig {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-busverb-test-'));
  const db = bus.openBus(path.join(dir, 'bus.sqlite'));
  t.after(() => {
    try {
      db.close();
    } catch {
      /* already closed */
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });
  const out: string[] = [];
  const fails: string[] = [];
  // #129 — default OFF: the wave-D shadow default, so a test that does not opt
  // in measures COUNTED-not-FIRED. flip via setCapabilityEnabled.
  let capOn = false;
  const r: Rig = {
    db,
    out,
    fails,
    switchOn: false,
    setCapabilityEnabled: (on: boolean) => {
      capOn = on;
    },
    ctx: (handle: string, fencing?: { generation?: number | null; fencingOn?: boolean }) => ({
      db,
      // The bus slice index.ts injects (openBusForVerb): the real bus.ts verbs
      // plus the #130 receipt wrapper and a busSwitch reader. busSwitch is stubbed
      // to the rig's `switchOn` so a test drives both coexistence arms without a
      // run row — the production reader (bus-runs.busSwitch off the frozen flags)
      // is gated separately in bus-runs.test.ts.
      bus: {
        send: bus.send,
        check: bus.check,
        ack: bus.ack,
        openGate: bus.openGate,
        resolveGate: bus.resolveGate,
        openGatesForRecipient: bus.openGatesForRecipient,
        // #128 fencing + #129 capability, the real bus.ts helpers.
        fencedWrite: bus.fencedWrite,
        mintCapability: bus.mintCapability,
        verifyCapability: bus.verifyCapability,
        // #130 receipts + the frozen-flag reader. busSwitch is stubbed to the
        // rig's `switchOn` so a test drives both coexistence arms without a run
        // row (the production reader is gated in bus-runs.test.ts).
        withReceipt,
        busSwitch: () => r.switchOn,
      },
      id: { runId: RUN, handle },
      out: (text) => out.push(text),
      // Mirrors index.ts's fail(): it THROWS, so a refusal genuinely stops the
      // verb. A fail that merely recorded would let execution run on into the
      // success path — which is issue #59's bug exactly, and a test whose fake
      // fail() returns could never catch a verb that forgot to stop.
      fail: ((message: string) => {
        fails.push(message);
        throw new Error(`FAIL: ${message}`);
      }) as BusVerbCtx['fail'],
      // #128 fencing (F2): carried explicitly so the verbs exercise the real
      // fence, not a no-op from an undefined field. Defaults are the unfenced path.
      generation: fencing?.generation ?? null,
      fencingOn: fencing?.fencingOn ?? false,
      // #129 — the capability seam, wired to the REAL bus.ts shadow counter and
      // a switch this rig controls (default OFF). index.ts wires the same two
      // through busCtx from busRuns.busSwitch(...,'capability') and
      // bus.countCapabilityReject.
      capabilityEnabled: () => capOn,
      countCapabilityReject: () => {
        bus.countCapabilityReject(db, RUN);
      },
    }),
  };
  return r;
}

const lastJson = (r: Rig): ReturnType<typeof lotToOutput> =>
  JSON.parse(r.out[r.out.length - 1]);

// ─── identity ───────────────────────────────────────────────────────────────

test('resolveBusIdentity: flag beats env, env beats default', () => {
  // COVERS: the precedence chain in resolveBusIdentity().
  assert.deepEqual(
    resolveBusIdentity({ run: 'r1', as: 'h1' }, { ORCHESTRA_RUN_ID: 'r2', ORCHESTRA_WS_ID: 'h2' }),
    { runId: 'r1', handle: 'h1' },
  );
  assert.deepEqual(resolveBusIdentity({}, { ORCHESTRA_RUN_ID: 'r2', ORCHESTRA_WS_ID: 'h2' }), {
    runId: 'r2',
    handle: 'h2',
  });
  assert.deepEqual(resolveBusIdentity({}, { ORCHESTRA_WS_ID: 'h2' }), {
    runId: DEFAULT_RUN_ID,
    handle: 'h2',
  });
  // The SDK-session fallback: ORCHESTRA_WS_ID is spool-ownership-gated and can
  // be withheld while ORCHESTRA_WS_ID_IDENTITY is always set (see
  // resolveSelfWorkspaceId in index.ts). Without this the bus verbs would be
  // unusable from exactly the sessions #117 wakes.
  assert.deepEqual(resolveBusIdentity({}, { ORCHESTRA_WS_ID_IDENTITY: 'h3' }), {
    runId: DEFAULT_RUN_ID,
    handle: 'h3',
  });
});

test('resolveBusIdentity: no handle anywhere returns null, and whitespace is not a handle', () => {
  // COVERS: the `if (!handle) return null` clause. A '   ' handle would be a
  // DISTINCT reader on the (run_id, reader) unique index — a private universe
  // no relève would ever match — so trim-then-check, not truthiness.
  assert.equal(resolveBusIdentity({}, {}), null);
  assert.equal(resolveBusIdentity({ as: '   ' }, {}), null);
  assert.equal(resolveBusIdentity({}, { ORCHESTRA_WS_ID: '  ' }), null);
});

// ─── send ───────────────────────────────────────────────────────────────────

test('send appends a row and prints its sequence', (t) => {
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: 't-9', body: 'go' });
  // #129: a dispatch prints its sequence AND, on a second line, the minted
  // capability token. The sequence is still the FIRST line, unchanged for a
  // parser reading `out.split('\n')[0]`.
  const lines = r.out.join('').split('\n');
  assert.equal(lines[0], '1');
  assert.match(lines[1], /^dcap_[0-9a-f]{64}$/);
  const lot = bus.check(r.db, RUN, 'w1');
  assert.equal(lot.messages.length, 1);
  assert.equal(lot.messages[0].body, 'go');
  assert.equal(lot.messages[0].recipient, 'w1');
  assert.equal(lot.messages[0].thread_id, 't-9');
  assert.equal(lot.messages[0].sender, 'ops');
});

test('send refuses an unknown --type, and the refusal NAMES the legal set', (t) => {
  // COVERS: the BUS_KINDS guard in verbSend(). Named as well as refused because
  // an agent that guessed `--type note` needs to learn the vocabulary from the
  // error, not from reading bus.ts.
  const r = rig(t);
  assert.throws(() => verbSend(r.ctx('ops'), { kind: 'note', to: null, thread: null, body: 'x' }));
  assert.match(r.fails[0], /unknown --type "note"/);
  for (const k of BUS_KINDS) assert.ok(r.fails[0].includes(k), `refusal should list ${k}`);
  // And nothing was written — a refusal that still wrote would be worse than
  // no guard, since the caller believes it failed.
  assert.equal(bus.check(r.ctx('w1').db, RUN, 'w1').messages.length, 0);
});

test('send refuses a missing --type and an empty body', (t) => {
  const r = rig(t);
  assert.throws(() => verbSend(r.ctx('ops'), { kind: undefined, to: null, thread: null, body: 'x' }));
  assert.match(r.fails[0], /usage: orchestra send/);
  assert.throws(() => verbSend(r.ctx('ops'), { kind: 'status', to: null, thread: null, body: '   ' }));
  assert.match(r.fails[1], /body is empty/);
});

// ─── check: THE ticket's headline invariant ─────────────────────────────────

test('check does NOT ack: a second check replays the byte-identical lot', (t) => {
  // COVERS: the `if (a.ackPrevious)` gate in verbCheck() — i.e. the ABSENCE of
  // any ack on the plain path. This is #115's core promise and T115.4.
  //
  // THE MUTANT (C10): make verbCheck() ack unconditionally after taking a lot.
  // Then the second check below returns count 0 and this test goes RED.
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'first' });
  verbSend(r.ctx('ops'), { kind: 'status', to: null, thread: null, body: 'second' });

  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const one = lastJson(r);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const two = lastJson(r);

  // POSITIVE terminator, not "no error": the lot is non-empty AND identical.
  // An assertion that only compared the two would pass on two empty lots — the
  // exact shape of "the host acked and there is nothing left", which is the
  // failure this test exists to catch.
  assert.equal(one.count, 2);
  assert.equal(one.lot, 1);
  assert.equal(one.replay, false);
  assert.equal(two.replay, true);
  assert.deepEqual(two.messages, one.messages);
  assert.equal(two.lot, one.lot);
});

test('a new message arriving mid-lot is NOT folded into the replay', (t) => {
  // COVERS: check()'s outstanding-lot branch, from the CLI's side. A reader that
  // crashed gets back exactly what it was handed — if the replay grew, "the same
  // lot" would be a claim no consumer could rely on.
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'a' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const before = lastJson(r);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'b' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const after = lastJson(r);
  assert.equal(before.count, 1);
  assert.deepEqual(after.messages, before.messages);
  // …and the new message is genuinely THERE, waiting — the positive control
  // proving `after.count === 1` means "not folded in", not "the send failed".
  verbAck(r.ctx('w1'), String(before.lot));
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const next = lastJson(r);
  assert.equal(next.count, 1);
  assert.equal(next.messages[0].body, 'b');
});

test('check on an empty bus prints an empty lot, not a refusal', (t) => {
  // COVERS: check()'s `messages.length === 0` early return, mapped by
  // lotToOutput(). A reader woken by #117 will often find nothing; that must be
  // an ordinary RC-0 answer, not an error it has to distinguish from a fault.
  const r = rig(t);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const o = lastJson(r);
  assert.deepEqual(o, {
    run: RUN,
    reader: 'w1',
    lot: null,
    replay: false,
    from: 0,
    to: 0,
    count: 0,
    messages: [],
    gates: [], // #119: check always carries the (here empty) gate surface
  });
  assert.equal(r.fails.length, 0);
});

test('--ack-previous acks the OUTSTANDING lot then hands over the next one', (t) => {
  // COVERS: the `outstanding.replay` branch in verbCheck().
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'a' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const first = lastJson(r);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'b' });

  verbCheck(r.ctx('w1'), { ackPrevious: true, markdown: false, limit: 100 });
  const second = lastJson(r);
  assert.equal(first.messages[0].body, 'a');
  assert.equal(second.count, 1);
  assert.equal(second.messages[0].body, 'b');
  assert.notEqual(second.lot, first.lot);
});

test('--ack-previous with NO outstanding lot hands the fresh lot over UNACKED', (t) => {
  // COVERS: the `outstanding.delivery && !outstanding.replay` branch — the one
  // that is easy to get wrong. If --ack-previous acked whatever check() just
  // took, a reader using it in a loop would ack messages it has not seen, and a
  // crash in that window would lose them silently. The caller asked to close the
  // PREVIOUS lot; there was none.
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'only' });
  verbCheck(r.ctx('w1'), { ackPrevious: true, markdown: false, limit: 100 });
  const o = lastJson(r);
  assert.equal(o.count, 1);
  assert.equal(o.replay, false);
  // Still outstanding: a plain check replays it rather than returning empty.
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const again = lastJson(r);
  assert.equal(again.replay, true);
  assert.deepEqual(again.messages, o.messages);
});

test('check --limit bounds the lot and the remainder survives to the next lot', (t) => {
  const r = rig(t);
  for (let i = 0; i < 5; i++) {
    verbSend(r.ctx('ops'), { kind: 'status', to: null, thread: null, body: `m${i}` });
  }
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 2 });
  const o = lastJson(r);
  assert.equal(o.count, 2);
  assert.deepEqual(o.messages.map((m) => m.body), ['m0', 'm1']);
  verbAck(r.ctx('w1'), String(o.lot));
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 2 });
  assert.deepEqual(lastJson(r).messages.map((m) => m.body), ['m2', 'm3']);
});

// ─── ack ────────────────────────────────────────────────────────────────────

test('ack closes the lot and the cursor advances past it', (t) => {
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'a' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const lot = lastJson(r).lot;
  verbAck(r.ctx('w1'), String(lot));
  assert.equal(r.out[r.out.length - 1], `acked ${lot}\n`);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  assert.equal(lastJson(r).count, 0);
});

test('ack REFUSES another reader\'s lot, and that lot stays outstanding for its owner', (t) => {
  // COVERS: verbAck()'s `if (!closed) fail(...)`, standing on bus.ack()'s
  // `AND run_id=? AND reader=?` predicate. #108 round-4 hardening 1: the ack
  // belongs to the reader. A silent no-op here would let w2 believe it had
  // acked while w1's lot replayed forever.
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'a' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const lot = lastJson(r).lot!;
  assert.throws(() => verbAck(r.ctx('w2'), String(lot)));
  assert.match(r.fails[0], /not an outstanding lot for w2/);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  assert.equal(lastJson(r).replay, true);
});

test('a double ack is refused rather than silently succeeding', (t) => {
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: null, body: 'a' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: false, limit: 100 });
  const lot = lastJson(r).lot!;
  verbAck(r.ctx('w1'), String(lot));
  assert.throws(() => verbAck(r.ctx('w1'), String(lot)));
  assert.match(r.fails[0], /already acked, unknown id/);
});

test('ack refuses a non-numeric or absent lot id', (t) => {
  const r = rig(t);
  assert.throws(() => verbAck(r.ctx('w1'), undefined));
  assert.match(r.fails[0], /usage: orchestra ack/);
  assert.throws(() => verbAck(r.ctx('w1'), 'lot-3'));
  assert.match(r.fails[1], /is not a lot id/);
  assert.throws(() => verbAck(r.ctx('w1'), '0'));
  assert.match(r.fails[2], /is not a lot id/);
});

// ─── ask ────────────────────────────────────────────────────────────────────

test('ask writes ONE question row addressed to the target and prints its id', (t) => {
  // COVERS: verbAsk(). The kind is pinned to 'question' here rather than taken
  // from a flag — a reader scanning for open asks switches on that kind, so a
  // caller able to pick the kind could park an ask nothing would ever find.
  const r = rig(t);
  verbAsk(r.ctx('w1'), 'ops', 'may I proceed?');
  assert.equal(r.out.join(''), '1\n');
  const lot = bus.check(r.ctx('ops').db, RUN, 'ops');
  assert.equal(lot.messages.length, 1);
  assert.equal(lot.messages[0].kind, 'question');
  assert.equal(lot.messages[0].recipient, 'ops');
  assert.equal(lot.messages[0].sender, 'w1');
  assert.equal(lot.messages[0].body, 'may I proceed?');
});

test('ask refuses a missing --to or an empty question', (t) => {
  const r = rig(t);
  assert.throws(() => verbAsk(r.ctx('w1'), undefined, 'q'));
  assert.match(r.fails[0], /usage: orchestra ask/);
  assert.throws(() => verbAsk(r.ctx('w1'), '  ', 'q'));
  assert.match(r.fails[1], /usage: orchestra ask/);
  assert.throws(() => verbAsk(r.ctx('w1'), 'ops', '   '));
  assert.match(r.fails[2], /question is empty/);
});

// ─── gate ───────────────────────────────────────────────────────────────────

test('gate open prints the gate id and the gate reads back OPEN', (t) => {
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['ship', 'or', 'hold?']);
  assert.equal(r.out.join(''), '1\n');
  const g = bus.getGate(r.ctx('lead').db, 1)!;
  assert.equal(g.question, 'ship or hold?');
  assert.equal(g.asked_by, 'lead');
  assert.equal(g.resolved_at, null);
  assert.deepEqual(bus.openGates(r.ctx('lead').db, RUN).map((x) => x.id), [1]);
});

test('gate resolve records the ruling once and REFUSES to overwrite it', (t) => {
  // COVERS: verbGate()'s `if (!ok) fail(...)` on resolveGate's `resolved_at IS
  // NULL` predicate. Two agents racing to record the human's Ruling must not be
  // able to clobber each other, and the loser must KNOW it lost — a silent
  // success would have it report a ruling that is not the one on the bus.
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['ship?']);
  verbGate(r.ctx('lead'), 'resolve', ['1', 'ship', 'it']);
  assert.equal(r.out[r.out.length - 1], 'resolved 1\n');
  assert.throws(() => verbGate(r.ctx('ops'), 'resolve', ['1', 'hold', 'it']));
  assert.match(r.fails[0], /was NOT overwritten/);
  const g = bus.getGate(r.ctx('lead').db, 1)!;
  assert.equal(g.resolution, 'ship it');
  assert.equal(g.resolved_by, 'lead');
  assert.deepEqual(bus.openGates(r.ctx('lead').db, RUN), []);
});

test('gate refuses an unknown subcommand, an empty question and an empty ruling', (t) => {
  const r = rig(t);
  assert.throws(() => verbGate(r.ctx('lead'), 'close', ['1']));
  assert.match(r.fails[0], /usage: orchestra gate open/);
  assert.throws(() => verbGate(r.ctx('lead'), 'open', []));
  assert.match(r.fails[1], /usage: orchestra gate open/);
  verbGate(r.ctx('lead'), 'open', ['q?']);
  assert.throws(() => verbGate(r.ctx('lead'), 'resolve', ['1']));
  assert.match(r.fails[2], /ruling is empty/);
  assert.throws(() => verbGate(r.ctx('lead'), 'resolve', ['nope', 'x']));
  assert.match(r.fails[3], /usage: orchestra gate resolve/);
});

// ─── T119.2 — gate --to recipient, --resolution, list, re-resolve refused ─────

test('T119.2 gate open --to records the recipient; gate list surfaces it to R only', (t) => {
  // COVERS: verbGate 'open' --to parse + openGate(recipient) + 'list' via
  //   openGatesForRecipient.
  // MUTANT: pass `null` instead of `to.value` in verbGate open → the recipient is
  //   never stored and R's `gate list` returns [] → this arm red.
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['--to', 'ws-R', 'ship', 'or', 'hold?']);
  const gateId = Number(r.out[r.out.length - 1]);
  assert.ok(gateId > 0);
  const g = bus.getGate(r.ctx('lead').db, gateId)!;
  assert.equal(g.recipient, 'ws-R', 'the recipient is stored on the row');
  assert.equal(g.question, 'ship or hold?', '--to is stripped, not folded into the question');

  // R sees it via gate list; a NON-recipient does not (recipient-scoped).
  verbGate(r.ctx('ws-R'), 'list', []);
  const rList = JSON.parse(r.out[r.out.length - 1]) as Array<{ id: number; question: string }>;
  assert.deepEqual(rList.map((x) => x.id), [gateId]);
  verbGate(r.ctx('ws-other'), 'list', []);
  const otherList = JSON.parse(r.out[r.out.length - 1]) as unknown[];
  assert.deepEqual(otherList, [], 'a gate addressed to ws-R must not appear for ws-other');
});

test('T119.2 an unaddressed gate (no --to) appears in NOBODY\'s gate list', (t) => {
  // The coexistence-safe default: a gate with a NULL recipient wakes nobody and
  // is listed for nobody. (Positive control lives in the --to arm above.)
  // MUTANT: default recipient to ctx.id.handle instead of null → the opener would
  //   see it here → red.
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['unaddressed?']);
  verbGate(r.ctx('lead'), 'list', []);
  assert.deepEqual(JSON.parse(r.out[r.out.length - 1]), []);
});

test('T119.2 gate resolve --resolution records once; check of the run surfaces the resolution; re-resolve REFUSED', (t) => {
  // COVERS: --resolution flag path + resolveGate idempotent-by-refusal, AND that
  //   the RESOLUTION is readable (the gate leaves R's `check`/`gate list` once
  //   resolved).
  // MUTANT: drop the `WHERE resolved_at IS NULL` in resolveGate → the second
  //   resolve succeeds → the "REFUSED" assertion red.
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['--to', 'ws-R', 'ship?']);
  const gateId = Number(r.out[r.out.length - 1]);

  // Before resolve, R's check surfaces the open gate.
  verbCheck(r.ctx('ws-R'), { ackPrevious: false, markdown: false, limit: 100 });
  const beforeGates = (JSON.parse(r.out[r.out.length - 1]) as { gates: Array<{ id: number }> }).gates;
  assert.deepEqual(beforeGates.map((x) => x.id), [gateId], 'an open gate is surfaced by check to R');

  verbGate(r.ctx('lead'), 'resolve', [String(gateId), '--resolution', 'ship it now']);
  assert.equal(r.out[r.out.length - 1], `resolved ${gateId}\n`);
  const g = bus.getGate(r.ctx('lead').db, gateId)!;
  assert.equal(g.resolution, 'ship it now', 'the ruling text is recorded from --resolution');
  assert.equal(g.resolved_by, 'lead');

  // The resolution is readable and the gate is GONE from R's open surface.
  verbCheck(r.ctx('ws-R'), { ackPrevious: false, markdown: false, limit: 100 });
  const afterGates = (JSON.parse(r.out[r.out.length - 1]) as { gates: unknown[] }).gates;
  assert.deepEqual(afterGates, [], 'a resolved gate no longer surfaces to R');

  // Re-resolve is REFUSED, resolution unchanged.
  assert.throws(() => verbGate(r.ctx('ops'), 'resolve', [String(gateId), '--resolution', 'hold']));
  assert.match(r.fails[r.fails.length - 1], /was NOT overwritten/);
  assert.equal(bus.getGate(r.ctx('lead').db, gateId)!.resolution, 'ship it now', 'first ruling stands');
});

test('T119.2 --resolution needs a value; --to needs a recipient', (t) => {
  const r = rig(t);
  verbGate(r.ctx('lead'), 'open', ['q?']);
  assert.throws(() => verbGate(r.ctx('lead'), 'resolve', ['1', '--resolution']));
  assert.match(r.fails[r.fails.length - 1], /--resolution needs a ruling/);
  assert.throws(() => verbGate(r.ctx('lead'), 'open', ['--to']));
  assert.match(r.fails[r.fails.length - 1], /--to needs a recipient/);
});

// ─── output shapes ──────────────────────────────────────────────────────────

test('the markdown render names the lot, the replay and the ack command', (t) => {
  const r = rig(t);
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', thread: 'th', body: 'BODY-TEXT' });
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: true, limit: 100 });
  const md = r.out[r.out.length - 1];
  assert.match(md, /## Lot 1/);
  assert.ok(!md.includes('REPLAY'), 'a first take must not claim to be a replay');
  assert.match(md, /BODY-TEXT/);
  assert.match(md, /orchestra ack 1/);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: true, limit: 100 });
  // The negative control for the marker above: the SAME assertion must flip on
  // the replay arm, or "no REPLAY" was proving nothing.
  assert.match(r.out[r.out.length - 1], /REPLAY/);
});

test('the empty markdown render says so instead of printing an empty lot header', (t) => {
  const r = rig(t);
  verbCheck(r.ctx('w1'), { ackPrevious: false, markdown: true, limit: 100 });
  assert.match(r.out[0], /No pending messages for w1 in run run-cli/);
});

test('renderLotMarkdown and lotToOutput are pure over a lot', () => {
  const o = lotToOutput(
    { runId: 'r', handle: 'h' },
    {
      delivery: { id: 7, run_id: 'r', reader: 'h', from_seq: 3, to_seq: 4, taken_at: 0, acked_at: null },
      replay: false,
      messages: [
        {
          sequence: 4,
          run_id: 'r',
          thread_id: null,
          sender: 's',
          recipient: null,
          kind: 'status',
          body: 'b',
          created_at: 1,
        },
      ],
    },
  );
  assert.equal(o.lot, 7);
  assert.equal(o.from, 3);
  assert.equal(o.to, 4);
  assert.equal(o.count, 1);
  assert.match(renderLotMarkdown(o), /seq 4\.\.4/);
});

// ─── the ABI diagnosis ──────────────────────────────────────────────────────

test('describeBusOpenFailure turns an ABI mismatch into an actionable sentence', () => {
  // COVERS: the ABI branch of describeBusOpenFailure(). #115 Boundaries: "a
  // system-node launch must fail loudly with a clear message, not silently."
  // The native message is accurate and useless — nothing in it says which
  // runtime you should have used. This is the hand-written failing input the
  // wave-A carry-forward 1 asks for: I do not need luck to find out whether the
  // gate is blind.
  const native = new Error(
    "The module '/x/better_sqlite3.node'\nwas compiled against a different Node.js version using\n" +
      'NODE_MODULE_VERSION 130. This version of Node.js requires\nNODE_MODULE_VERSION 127.',
  );
  const msg = describeBusOpenFailure(native, '/home/u/.orchestra/bus.sqlite');
  assert.match(msg, /ELECTRON_RUN_AS_NODE/);
  assert.match(msg, /build:bus-abi/);
  assert.match(msg, /\/home\/u\/\.orchestra\/bus\.sqlite/);
  // The underlying error is CARRIED, not swallowed — a diagnosis that hides the
  // evidence is worse than the raw error for anyone debugging a NEW cause.
  assert.match(msg, /NODE_MODULE_VERSION 130/);
});

test('describeBusOpenFailure does NOT claim an ABI problem for an unrelated one', () => {
  // The negative control for the marker above (carry-forward 2): a message as
  // specific as its claim. An ENOENT reported as "wrong Electron runtime" would
  // send every reader down the wrong path, and a matcher that fired on anything
  // would make the ABI arm above vacuous.
  const msg = describeBusOpenFailure(new Error('SQLITE_CANTOPEN: unable to open database file'), '/x/bus.sqlite');
  assert.match(msg, /SQLITE_CANTOPEN/);
  assert.ok(!msg.includes('ELECTRON_RUN_AS_NODE'), 'must not blame the runtime for a disk error');
  assert.ok(!msg.includes('NODE_MODULE_VERSION'), 'must not invent an ABI diagnosis');
});

// ─── #128 fencing THROUGH THE VERB PATH (review F2 — committed, not an E2E script) ─

// These drive the SHIPPED verbs (verbSend/verbAck/verbGate → fenced → bus.fencedWrite),
// not fencedWrite directly, so they cover the ordering (fence BEFORE write), the
// err.name→ctx.fail routing that keeps issue #59 at bay, and the atomic tx (F1).
// Each seeds a run with the `fencing` switch frozen ON and bumps the generation so
// a gen-0 caller is stale.

function seedFencedRun(db: bus.BusDb, opts: { fencingOn: boolean; gen: number }): void {
  startRun(db, { id: RUN, kind: 'vague', coordinator: 'ops' }, {
    ...DEFAULT_BUS_SWITCHES,
    fencing: opts.fencingOn,
  });
  for (let i = 0; i < opts.gen; i++) bus.bumpCoordinatorGeneration(db, RUN);
}

test('F2 — verbSend fences a stale generation: RC-refusal via ctx.fail, NO row, fence_events fired', (t) => {
  const r = rig(t);
  seedFencedRun(r.ctx('x').db, { fencingOn: true, gen: 1 }); // current = 1
  const before = (r.ctx('x').db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n;
  // The stale coordinator (gen 0) sends. fenced() catches the typed throw and
  // routes it through ctx.fail (which throws FAIL:) — so the send never runs.
  assert.throws(
    () => verbSend(r.ctx('ops-old', { generation: 0, fencingOn: true }), { kind: 'dispatch', to: 'peer', thread: null, body: 'stale' }),
    /FAIL: bus: stale coordinator generation/,
  );
  const after = (r.ctx('x').db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n;
  assert.equal(after, before, 'the send never ran — messages row count unchanged');
  const counts = bus.fenceEventCounts(r.ctx('x').db, RUN);
  assert.equal(counts.fired, 1, 'the rejection recorded a FIRED fence event (survives the tx rollback)');
  assert.equal(counts.counted, 0);
  // Must-PASS control: the LIVE generation sends fine through the same verb.
  verbSend(r.ctx('ops-new', { generation: 1, fencingOn: true }), { kind: 'dispatch', to: 'peer', thread: null, body: 'live' });
  const afterLive = (r.ctx('x').db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n;
  assert.equal(afterLive, before + 1, 'the live coordinator write lands');
});

test('F2 — verbSend with the switch OFF COUNTS a stale send but STILL writes (coexistence)', (t) => {
  const r = rig(t);
  seedFencedRun(r.ctx('x').db, { fencingOn: false, gen: 1 });
  const before = (r.ctx('x').db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n;
  // Switch OFF: no throw, the send lands, and the would-have-fenced event is counted.
  verbSend(r.ctx('ops-old', { generation: 0, fencingOn: false }), { kind: 'dispatch', to: 'peer', thread: null, body: 'shadow' });
  const after = (r.ctx('x').db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n;
  assert.equal(after, before + 1, 'old channel authoritative — the write lands');
  const counts = bus.fenceEventCounts(r.ctx('x').db, RUN);
  assert.equal(counts.counted, 1, 'COUNTED not FIRED while OFF');
  assert.equal(counts.fired, 0);
});

test('F2 — verbAck fences a stale ack: refused, lot stays outstanding (row unchanged)', (t) => {
  const r = rig(t);
  const db = r.ctx('x').db;
  seedFencedRun(db, { fencingOn: true, gen: 0 }); // start at gen 0
  bus.send(db, { runId: RUN, sender: 'peer', kind: 'dispatch', body: 'm1' });
  const lot = bus.check(db, RUN, 'reader-1');
  assert.ok(lot.delivery);
  bus.bumpCoordinatorGeneration(db, RUN); // reader superseded, now gen 1
  assert.throws(
    () => verbAck(r.ctx('reader-1', { generation: 0, fencingOn: true }), String(lot.delivery!.id)),
    /FAIL: bus: stale coordinator generation/,
  );
  const still = (db.prepare('SELECT acked_at FROM deliveries WHERE id=?').get(lot.delivery!.id) as { acked_at: number | null }).acked_at;
  assert.equal(still, null, 'the lot stays outstanding — the ack never ran');
});

test('F2 — verbGate resolve fences a stale coordinator: refused, gate stays open', (t) => {
  const r = rig(t);
  const db = r.ctx('x').db;
  seedFencedRun(db, { fencingOn: true, gen: 0 });
  const gateId = bus.openGate(db, RUN, 'ops', 'ruling?', 'lead');
  bus.bumpCoordinatorGeneration(db, RUN); // now gen 1
  assert.throws(
    () => verbGate(r.ctx('ops-old', { generation: 0, fencingOn: true }), 'resolve', [String(gateId), '--resolution', 'sneaky']),
    /FAIL: bus: stale coordinator generation/,
  );
  assert.equal(bus.getGate(db, gateId)?.resolved_at, null, 'the gate stays open — the resolve never ran');
});

test('F1 — the fence and the write are ONE transaction: the generation is read AT write time', (t) => {
  // Review F1 (TOCTOU): with a separate fence-check then write, a bump landing in
  // the window lets a superseded coordinator write. The atomic form reads the
  // generation INSIDE the same IMMEDIATE tx as the write, so the decision uses the
  // generation current when the write happens — not a stale pre-read.
  //
  // In-process this is proven by: seed current=1, a gen-1 caller (live) writes; but
  // if a gen-0 caller is checked against current=1 it is refused. The discriminator
  // vs the OLD two-statement form: fencedWrite now takes the write as a CLOSURE it
  // runs inside the tx, so there is no statement gap for a bump to slip into. We
  // assert the shipped verb refuses a gen that is stale RELATIVE TO the tx-entry
  // generation, and that a non-stale write inside the same tx commits atomically.
  const r = rig(t);
  const db = r.ctx('x').db;
  seedFencedRun(db, { fencingOn: true, gen: 1 }); // current = 1
  // A gen-1 (live) send commits — proving the closure runs inside the fence's tx.
  verbSend(r.ctx('ops', { generation: 1, fencingOn: true }), { kind: 'dispatch', to: 'peer', thread: null, body: 'atomic-ok' });
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND body=?').get(RUN, 'atomic-ok') as { n: number }).n, 1);
  // A further bump to gen 2 makes the gen-1 caller stale — the SAME presented value
  // that passed a moment ago is now refused, because the decision reads current at
  // tx entry, not a value cached outside the tx.
  bus.bumpCoordinatorGeneration(db, RUN); // current = 2
  assert.throws(
    () => verbSend(r.ctx('ops', { generation: 1, fencingOn: true }), { kind: 'dispatch', to: 'peer', thread: null, body: 'now-stale' }),
    /FAIL: bus: stale coordinator generation/,
  );
  assert.equal((db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND body=?').get(RUN, 'now-stale') as { n: number }).n, 0, 'the now-stale write never landed');
});

// ─── #129 capability tokens (CLI seam) ───────────────────────────────────────

/** Mint a dispatch and return the CLEAR token the verb printed on line 2. */
function dispatchAndCap(r: Rig, to: string, body = 'go'): string {
  const before = r.out.length;
  verbSend(r.ctx('ops'), { kind: 'dispatch', to, thread: null, body });
  const printed = r.out.slice(before).join('');
  const token = printed.split('\n')[1];
  assert.match(token, /^dcap_[0-9a-f]{64}$/, 'dispatch must print a dcap token on line 2');
  return token;
}

test('#129 T129.1: a dispatch mints an ACTIVE capability and a fresh token verifies', (t) => {
  // COVERS: verbSend's dispatch mint branch + bus.verifyCapability. The token
  // the dispatcher prints is accepted while the dispatch is live.
  const r = rig(t);
  const token = dispatchAndCap(r, 'w1');
  assert.equal(bus.verifyCapability(r.db, RUN, token), true);
  // The stored form is a HASH — the clear token is nowhere in the table.
  const rows = r.db.prepare('SELECT * FROM dispatch_capabilities').all() as Array<{
    token_hash: string;
    state: string;
  }>;
  assert.equal(rows.length, 1);
  assert.equal(rows[0].state, 'active');
  assert.notEqual(rows[0].token_hash, token, 'the clear token must NOT be stored');
  assert.match(rows[0].token_hash, /^[0-9a-f]{64}$/);
});

test('#129 T129.1 must-FAIL arm: a stale (superseded) token is REJECTED when capability=ON', (t) => {
  // COVERS: the reject clause in verbSend. A respawn to the same recipient mints
  // a new capability and SUPERSEDES the first; the first worker's late
  // worker_done, carrying the now-stale token, must be refused — it cannot mask
  // the retry. THE MUTANT (C3): delete the `if (fired) ctx.fail(...)` block and
  // this test goes green-when-it-should-be-red because the completion lands.
  const r = rig(t);
  r.setCapabilityEnabled(true); // capability=ON -> the mechanism FIRES
  const stale = dispatchAndCap(r, 'w1'); // dispatch 1
  const fresh = dispatchAndCap(r, 'w1'); // dispatch 2 (respawn) supersedes #1
  assert.notEqual(stale, fresh);
  assert.equal(bus.verifyCapability(r.db, RUN, stale), false, 'stale token must not verify');
  assert.equal(bus.verifyCapability(r.db, RUN, fresh), true, 'fresh token still active');

  // The late completion from the SUPERSEDED dispatch is refused, and NOTHING is
  // written for it.
  const seqBefore = (r.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  assert.throws(
    () => verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: stale, body: 'late done' }),
    /worker_done rejected — the token is not an active capability/,
  );
  const seqAfter = (r.db.prepare('SELECT COUNT(*) AS n FROM messages').get() as { n: number }).n;
  assert.equal(seqAfter, seqBefore, 'a rejected completion must not land a message row');

  // The FRESH token's completion is accepted through the same path — the reject
  // is specific to the stale token, not a blanket refusal (positive control).
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: fresh, body: 'real done' });
  const bodies = (r.db.prepare("SELECT body FROM messages WHERE kind='worker_done'").all() as Array<{ body: string }>)
    .map((m) => m.body);
  assert.deepEqual(bodies, ['real done']);
});

test('#129 T129.3 COUNTED-not-FIRED: with capability=OFF a stale token is COUNTED but the completion LANDS', (t) => {
  // COVERS: the C5 seam. capability=OFF (the rig default) => the shadow counter
  // increments but the completion is NOT rejected — the old channel stays
  // authoritative. THE MUTANT: drop the `if (fired)` guard (always reject) and
  // this test goes RED because the completion no longer lands; drop the
  // countCapabilityReject call and the counter assertion goes RED.
  const r = rig(t);
  // default: capability OFF
  const stale = dispatchAndCap(r, 'w1');
  dispatchAndCap(r, 'w1'); // supersede the first
  assert.equal(bus.verifyCapability(r.db, RUN, stale), false);
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 0, 'counter starts at 0');

  // The stale completion LANDS (not fired) …
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: stale, body: 'late but landed' });
  const landed = (r.db.prepare("SELECT body FROM messages WHERE kind='worker_done'").all() as Array<{ body: string }>)
    .map((m) => m.body);
  assert.deepEqual(landed, ['late but landed'], 'OFF: the completion is authoritative on the old channel');
  // … AND it was COUNTED.
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 1, 'OFF still COUNTS the divergence');
});

test('#129 T129.2: a minted token never appears in a message body, and nothing carries it in clear', (t) => {
  // COVERS: --cap is extracted before the body join (index.ts) and the mint
  // prints to stdout only. The token must not be findable in any messages.body
  // nor in the capabilities table.
  const r = rig(t);
  r.setCapabilityEnabled(true);
  const token = dispatchAndCap(r, 'w1');
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: token, body: 'done' });
  const allBodies = (r.db.prepare('SELECT body FROM messages').all() as Array<{ body: string }>).map((m) => m.body);
  for (const b of allBodies) {
    assert.ok(!b.includes(token), `token leaked into a message body: ${b}`);
  }
  // And no durable table column holds it in clear.
  const capRows = r.db.prepare('SELECT * FROM dispatch_capabilities').all() as Array<Record<string, unknown>>;
  for (const row of capRows) {
    for (const v of Object.values(row)) {
      if (typeof v === 'string') assert.ok(!v.includes(token), `token leaked into a capability column: ${v}`);
    }
  }
});

// (REMOVED at review F1) The old "a no-cap completion is unaffected under ON"
// test asserted the exact BYPASS F1 fixes — a hung worker omitting --cap slipped
// through. Replaced by the two F1 fail-closed arms below (no-cap → rejected+counted
// under ON; lands+counted under OFF). A non-completion kind carrying --cap being
// ignored is still covered: dispatch mints (it is not a completion kind), and
// `ask`/`gate`/`status` (#165) never pass through the CAPABILITY_COMPLETION_KINDS
// branch.

test('#129 F1 fail-closed: a completion with NO --cap is REJECTED+COUNTED under capability=ON', (t) => {
  // COVERS: the fail-closed gate — the guard is on the KIND, not on `cap`
  // presence. A hung worker must not bypass the capability check by omitting the
  // flag (the exact threat #129 exists to stop). THE MUTANT: restore the old
  // `if (cap && ...)` guard and this test goes RED (the no-cap completion lands
  // and is not counted).
  const r = rig(t);
  r.setCapabilityEnabled(true); // capability=ON -> FIRES
  const before = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='worker_done'").get() as { n: number }).n;
  assert.throws(
    () => verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, body: 'sneaky no-cap done' }),
    /worker_done rejected — no --cap token was presented/,
  );
  const after = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='worker_done'").get() as { n: number }).n;
  assert.equal(after, before, 'a no-cap completion must NOT land under capability=ON');
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 1, 'the missing-token completion is COUNTED, same as a stale one');
});

test('#129 F1 coexistence: a completion with NO --cap LANDS+COUNTED under capability=OFF', (t) => {
  // COVERS: the OFF half of fail-closed. While the switch is OFF the old channel
  // stays authoritative, so a no-cap completion still lands — but it is COUNTED,
  // so the shadow signal shows the bypass that WOULD have been rejected once ON.
  // THE MUTANT: make the OFF path skip the count and the counter assertion reddens;
  // make it reject (drop `if (fired)`) and the landed assertion reddens.
  // NB (#165): the completion kind here is `worker_done` — `status` is NO LONGER
  // a completion, so it never enters the capability branch and is never counted
  // (asserted by the #165 arms below).
  const r = rig(t); // default: capability OFF
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, body: 'no-cap done' });
  const landed = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='worker_done'").get() as { n: number }).n;
  assert.equal(landed, 1, 'OFF: a no-cap completion lands (old channel authoritative)');
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 1, 'OFF still COUNTS the missing-token completion');
});

// ─── #165 `status` is NOT a completion — it passes untokened ─────────────────
// The live-repro matrix: under capability=ON a plain `--type status` with no
// token was REFUSED because 'status' sat in CAPABILITY_COMPLETION_KINDS. A
// status resolves no dispatch, so it must never enter the capability branch.
// THE SHARED MUTANT for arms 1 & 4: put 'status' back into
// CAPABILITY_COMPLETION_KINDS (the pre-fix state) — arm 1 throws (was RED as the
// live refusal) and arm 4's counter reads 1 instead of 0. Only `worker_done`
// arms (2 & 3) discriminate the OTHER mutant: removing `worker_done` too, which
// would let a stale/absent token through (C1 core softened).

test('#165 arm 1: untokened `--type status` is ACCEPTED under capability=ON (the live repro)', (t) => {
  // COVERS: the CAPABILITY_COMPLETION_KINDS change. PRE-FIX (status in the list)
  // this THREW the verbatim live refusal; POST-FIX the status lands and NOTHING
  // is counted (a status is not a capability divergence).
  const r = rig(t);
  r.setCapabilityEnabled(true); // capability=ON — the switch that broke status
  verbSend(r.ctx('lead'), { kind: 'status', to: null, thread: null, body: 'phase 2, no token' });
  assert.equal(r.fails.length, 0, 'a plain status must NOT be refused under capability=ON');
  const landed = (r.db.prepare("SELECT body FROM messages WHERE kind='status'").all() as Array<{ body: string }>)
    .map((m) => m.body);
  assert.deepEqual(landed, ['phase 2, no token'], 'the status row lands untokened');
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 0, 'a status is not a completion — nothing is counted');
});

test('#165 arm 1b: a status FROM a token-holder MAY carry --cap and is still ACCEPTED (attribution, never required)', (t) => {
  // COVERS: the ticket's "if a status optionally carries --cap, accept it — never
  // require it" clause. A valid token on a status must not change the outcome:
  // it lands, uncounted, and the capability stays active (a status does not
  // resolve/consume the dispatch).
  const r = rig(t);
  r.setCapabilityEnabled(true);
  const token = dispatchAndCap(r, 'w1'); // w1 holds a live capability
  verbSend(r.ctx('w1'), { kind: 'status', to: 'ops', thread: null, cap: token, body: 'still working' });
  assert.equal(r.fails.length, 0, 'a status with a valid --cap is accepted');
  const landed = (r.db.prepare("SELECT body FROM messages WHERE kind='status'").all() as Array<{ body: string }>)
    .map((m) => m.body);
  assert.deepEqual(landed, ['still working']);
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 0, 'no divergence counted for a status');
  assert.equal(bus.verifyCapability(r.db, RUN, token), true, 'a status does not consume the capability — still active');
});

test('#165 arm 2: `worker_done` with a WRONG/absent token is STILL REJECTED+COUNTED under ON (C1 core intact)', (t) => {
  // COVERS: the guarantee that #165 does NOT soften C1. worker_done remains the
  // sole completion kind; a stale token and an absent token both fire.
  // THE MUTANT: remove `worker_done` from CAPABILITY_COMPLETION_KINDS (over-fix)
  // → both sub-arms go RED (the completion lands, nothing counted).
  const r = rig(t);
  r.setCapabilityEnabled(true);
  const stale = dispatchAndCap(r, 'w1');
  dispatchAndCap(r, 'w1'); // supersede the first → `stale` no longer active
  assert.equal(bus.verifyCapability(r.db, RUN, stale), false);

  const before = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='worker_done'").get() as { n: number }).n;
  // wrong (stale) token → rejected
  assert.throws(
    () => verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: stale, body: 'stale done' }),
    /worker_done rejected — the token is not an active capability/,
  );
  // absent token → rejected (fail-closed, F1)
  assert.throws(
    () => verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, body: 'no-cap done' }),
    /worker_done rejected — no --cap token was presented/,
  );
  const after = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='worker_done'").get() as { n: number }).n;
  assert.equal(after, before, 'no worker_done landed — C1 core did not soften');
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 2, 'both the stale and the absent completion are COUNTED');
});

test('#165 arm 3: `worker_done` with the VALID minted token is accepted (happy path, uncounted)', (t) => {
  // COVERS: the positive path — a real completion with its live token lands and
  // is NOT counted as a divergence. (verbSend does not itself mutate the cap row
  // on acceptance — the token stays active; resolution/fail is a separate step.)
  // THE MUTANT: remove `worker_done` from the list and the arm still passes
  // (it lands either way), so this arm alone does NOT discriminate the over-fix;
  // arm 2 is the discriminator. This arm proves the fix did not break the happy
  // path — its token was active at send time.
  const r = rig(t);
  r.setCapabilityEnabled(true);
  const token = dispatchAndCap(r, 'w1');
  assert.equal(bus.verifyCapability(r.db, RUN, token), true, 'the minted token is active before the completion');
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, cap: token, body: 'real done' });
  assert.equal(r.fails.length, 0, 'a valid-token worker_done is accepted');
  const landed = (r.db.prepare("SELECT body FROM messages WHERE kind='worker_done'").all() as Array<{ body: string }>)
    .map((m) => m.body);
  assert.deepEqual(landed, ['real done']);
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 0, 'a valid completion is not a divergence');
});

test('#165 arm 4: OFF-run coexistence — a status passes untokened and is NOT counted, shadow counter intact', (t) => {
  // COVERS: the OFF half. With capability OFF a status was already landing (the
  // switch gates only the REFUSAL), but PRE-FIX it was still COUNTED as a
  // divergence (status in the list) — polluting the shadow counter that the
  // canary reads. POST-FIX a status is never a divergence in either switch state.
  // THE SHARED MUTANT (status back in the list): the counter reads 1 → RED.
  const r = rig(t); // default: capability OFF
  verbSend(r.ctx('lead'), { kind: 'status', to: null, thread: null, body: 'off-run status' });
  assert.equal(r.fails.length, 0, 'a status always lands');
  const landed = (r.db.prepare("SELECT COUNT(*) AS n FROM messages WHERE kind='status'").get() as { n: number }).n;
  assert.equal(landed, 1, 'the status landed');
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 0, 'OFF: a status is NOT a completion, so the shadow counter stays 0');

  // A worker_done divergence under OFF still moves the counter (control: the
  // counter is not simply dead) — proving the fix scoped the change to `status`,
  // not the whole OFF path.
  verbSend(r.ctx('w1'), { kind: 'worker_done', to: 'ops', thread: null, body: 'no-cap done' });
  assert.equal(bus.capabilityRejectCount(r.db, RUN), 1, 'a real completion divergence STILL counts under OFF');
});

// ─── #130 mutation receipts through the CLI verbs ────────────────────────────

const msgCount = (r: Rig): number =>
  Number((r.db.prepare('SELECT COUNT(*) AS n FROM messages WHERE run_id=?').get(RUN) as { n: number }).n);

// NB: these use kind `handoff` — NOT `dispatch` (which mints a #129 capability
// and prints a second token line) and NOT the completion kind `worker_done`
// (which the #129 seam gates). `handoff` exercises the #130 receipt in
// isolation; the dispatch+receipt seam has its own arm below.
test('T130.1/T130.2 send: --request-id replay is a NO-OP returning the original seq (switch ON)', (t) => {
  // COVERS: verbSend → runMutation → withReceipt short-circuit, the full CLI
  // path a retried `orchestra send --request-id r1` takes.
  // MUTANT: make runMutation ignore requestId (always `return exec()`) → the
  //   second send lands a SECOND row and prints a NEW seq → RED.
  const r = rig(t);
  r.switchOn = true;
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'hi', requestId: 'r1' });
  const firstSeq = r.out[r.out.length - 1].trim();
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'hi', requestId: 'r1' });
  const secondSeq = r.out[r.out.length - 1].trim();
  assert.equal(secondSeq, firstSeq, 'replay prints the ORIGINAL sequence');
  assert.equal(msgCount(r), 1, 'exactly ONE message landed — the retry was a no-op');
});

test('T130.1b send: a DIFFERENT --request-id sends a second message (switch ON)', (t) => {
  const r = rig(t);
  r.switchOn = true;
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'a', requestId: 'r1' });
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'b', requestId: 'r2' });
  assert.equal(msgCount(r), 2, 'two distinct request ids → two messages');
});

test('T130.3 send: switch OFF → the retry re-sends (v1); the old channel stays authoritative', (t) => {
  // COVERS: runMutation reading busSwitch=false → withReceipt COUNTED-not-FIRED.
  // MUTANT: fire regardless of switch → only one message → RED (expects two).
  const r = rig(t);
  r.switchOn = false;
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'x', requestId: 'r1' });
  verbSend(r.ctx('ops'), { kind: 'handoff', body: 'x', requestId: 'r1' });
  assert.equal(msgCount(r), 2, 'switch OFF: two sends executed (v1 behaviour)');
});

test('T130 seam: a dispatch replay does NOT re-mint its capability (switch ON)', (t) => {
  // COVERS: verbSend's `a.kind === 'dispatch' && !sent.replayed` guard. Without
  // it, a receipt replay re-runs mintCapability on the already-minted dispatch
  // and hits the (run_id, dispatch_seq) PK.
  // MUTANT: drop `&& !sent.replayed` → the second call throws SQLITE_CONSTRAINT.
  const r = rig(t);
  r.switchOn = true;
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', body: 'go', requestId: 'd1' });
  const firstLines = r.out.join('').trim().split('\n');
  assert.match(firstLines[1], /^dcap_[0-9a-f]{64}$/, 'first dispatch mints a token');
  const before = r.out.length;
  verbSend(r.ctx('ops'), { kind: 'dispatch', to: 'w1', body: 'go', requestId: 'd1' });
  assert.equal(r.fails.length, 0, 'the dispatch replay did not throw (no re-mint)');
  // The replay printed exactly ONE line (the original seq), no new token.
  const replayOut = r.out.slice(before).join('');
  assert.equal(replayOut.trim(), firstLines[0], 'replay prints the original seq only');
  assert.equal(msgCount(r), 1, 'one dispatch row — the retry was a no-op');
});

test('send with NO --request-id behaves exactly as v1 (two sends → two rows)', (t) => {
  // COVERS: runMutation's `if (!requestId?.trim()) return exec()` bypass — the
  // default path every pre-#130 caller takes.
  // MUTANT: engage the receipt with an empty key → withReceipt throws
  //   "requestId is required" → the verb fails → RED.
  const r = rig(t);
  r.switchOn = true; // even ON, no key means no receipt.
  verbSend(r.ctx('ops'), { kind: 'dispatch', body: 'x' });
  verbSend(r.ctx('ops'), { kind: 'dispatch', body: 'x' });
  assert.equal(r.fails.length, 0, 'no refusal — an absent key is not an error');
  assert.equal(msgCount(r), 2, 'no key → no idempotency, v1 behaviour');
});

test('T130.2 ack: --request-id replay returns success without re-acking (switch ON)', (t) => {
  const r = rig(t);
  r.switchOn = true;
  verbSend(r.ctx('ops'), { kind: 'dispatch', body: 'm1' });
  verbCheck(r.ctx('reader'), { ackPrevious: false, markdown: false, limit: 100 });
  const lot = lastJson(r);
  assert.ok(lot.lot, 'a lot was taken');
  verbAck(r.ctx('reader'), String(lot.lot), 'ack-r1');
  const firstOut = r.out[r.out.length - 1];
  assert.match(firstOut, /acked/);
  // Replay: without the receipt this would FAIL (lot already acked). With it,
  // the stored `true` is returned and the verb prints "acked" again, no refusal.
  verbAck(r.ctx('reader'), String(lot.lot), 'ack-r1');
  assert.equal(r.fails.length, 0, 'the ack replay did not refuse — the receipt short-circuited');
});

test('T130.2 gate resolve: --request-id replay returns success without re-resolving (switch ON)', (t) => {
  const r = rig(t);
  r.switchOn = true;
  verbGate(r.ctx('ops'), 'open', ['--to', 'lead', 'ship?']);
  const gateId = r.out[r.out.length - 1].trim();
  verbGate(r.ctx('lead'), 'resolve', [gateId, '--resolution', 'yes', '--request-id', 'gr1']);
  assert.match(r.out[r.out.length - 1], /resolved/);
  // Replay: without the receipt this FAILS (already resolved). With it, success.
  verbGate(r.ctx('lead'), 'resolve', [gateId, '--resolution', 'yes', '--request-id', 'gr1']);
  assert.equal(r.fails.length, 0, 'the resolve replay did not refuse — the receipt short-circuited');
});

test('T130.3 gate resolve: switch OFF → replay re-resolves and REFUSES (v1 idempotent-by-refusal)', (t) => {
  // The v1 behaviour resolveGate() already had: a second resolve returns false
  // and the verb refuses. The receipt must NOT paper over that while OFF.
  const r = rig(t);
  r.switchOn = false;
  verbGate(r.ctx('ops'), 'open', ['--to', 'lead', 'ship?']);
  const gateId = r.out[r.out.length - 1].trim();
  verbGate(r.ctx('lead'), 'resolve', [gateId, '--resolution', 'yes', '--request-id', 'gr1']);
  assert.throws(
    () => verbGate(r.ctx('lead'), 'resolve', [gateId, '--resolution', 'yes', '--request-id', 'gr1']),
    /not open/,
    'switch OFF: v1 refusal is preserved, the receipt did not short-circuit',
  );
});
