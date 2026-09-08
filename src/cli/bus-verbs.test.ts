import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import * as bus from '../main/bus.ts';
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
  ctx: (handle: string) => BusVerbCtx;
  out: string[];
  fails: string[];
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
  return {
    out,
    fails,
    ctx: (handle: string) => ({
      db,
      bus,
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
    }),
  };
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
  assert.equal(r.out.join(''), '1\n');
  const lot = bus.check(r.ctx('w1').db, RUN, 'w1');
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
