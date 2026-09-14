// Wake-as-turn — the host detects new bus rows and orders the reader to check
// (issue #117, ledger #123). Policy lives in src/shared/bus-wake.ts; this file
// is the effectful half: reading durable bus state, and firing the turn.
//
// ── Why the host watches instead of the agent polling ───────────────────────
//
// Frozen on #108 comments 4-5: NO blocking check inside an agent turn. A turn
// that runs `orchestra check --wait` burns against the 600s Bash cap and shows
// up as a hang, so the wait must live where waiting is free — the main process.
//
// ── Why fs.watch is NOT the mechanism, only an accelerator ──────────────────
//
// The sweep is LEVEL-TRIGGERED over durable state: it reads what is pending
// right now and acts on that, with no memory of which inserts it saw. `fs.watch`
// on `bus.sqlite-wal` (spike #109 arm 4: p50 0.23ms) merely makes the sweep run
// SOONER; every wake it could produce is also produced by the 60s timer and by
// the startup sweep. That is deliberate and it is what #117 acceptance 3 tests:
// kill the app between an insert and its wake, and the wake still fires on
// restart, because nothing about the decision was stored in the event.
//
// An edge-triggered design (watch fires → wake) reads identically in every happy
// path and loses every wake that lands while the app is closed. The failure is
// invisible precisely because the mechanism that would report it is the one that
// is off.
//
// ── D1: the bus NEVER blocks boot (ledger #122) ─────────────────────────────
//
// `getBus()` returns null whenever the bus failed to open, and this module is a
// READER, so every entry point tolerates it: the sweep logs once and returns,
// the watcher is simply never armed, and no wake is silently lost — the next
// sweep re-reads durable state, so a bus that comes back is not a bus that
// dropped anything.

import fs from 'node:fs';
import { getBus, busPath, openGatesForRecipient, type BusDb } from './bus.ts';
import { log } from './logger.ts';
import {
  decideWake,
  pruneWakeLedger,
  WAKE_ORDER,
  type ReaderPendingState,
  type WakeLedgerEntry,
} from '../shared/bus-wake.ts';

/** How often the level-triggered sweep runs regardless of any fs event. */
const SWEEP_MS = 60_000;

/** Debounce on the WAL watcher. A single `check` writes a delivery row, which
 *  itself touches the WAL, so an undebounced watcher re-enters the sweep it just
 *  caused. Short enough to keep the 2s acceptance-1 budget with room to spare. */
const WATCH_DEBOUNCE_MS = 150;

// ─── The switch seam (#118 owns the storage; this module only READS) ────────
//
// The standing ruling: a switch-gated mechanism is COUNTED, not fired, while its
// switch is off, and switches are read at wave start and FROZEN FOR THE RUN.
//
// "THE RUN" IS A BUS `run_id`, NOT THE APP PROCESS. This is the whole content of
// ledger #123 Q1, and getting it wrong is invisible to every gate in this
// ticket. An earlier version cached ONE boolean in `startBusWake()` and reused
// it for every sweep. That is correct-looking and correct for a single run, and
// it cannot be right for two: run A frozen OFF and run B frozen ON are the
// normal steady state of a fleet mid-wave, and one process-wide boolean must
// answer the same for both. The defect is not in a clause any mutant could
// delete — it is in WHICH EVENT the value binds to — so all 17 mutants and all
// of C1-C10 pass on it. The `Q1 two runs in ONE process` arm in
// bus-wake-sweep.test.ts is what actually discriminates.
//
// So the switch is read PER SWEEP, keyed on the run the reader belongs to. The
// FREEZE is the storage's job (#118 writes the flags onto the run row when the
// run starts, and never mutates them), which is where it belongs: freezing is a
// property of the run's data, not of how long this process has been up. An app
// restart mid-run therefore cannot change a running run's flags — it re-reads
// the same row.
//
// #118 owns the storage and src/main/workspaces.ts; this file must not. Until
// its accessor lands, the default reader below returns false (OFF) for every
// run, so the shipped default is shadow — counted, never fired.

/** Reads the wake flag OFF THE RUN ROW for `runId`. Must be a pure read: it is
 *  called once per reader per sweep, and it must return the value frozen when
 *  that run started, not a live setting. */
export type WakeSwitchReader = (runId: string) => boolean;

let readWakeSwitch: WakeSwitchReader = () => false;

/** Wire in #118's switch accessor (or a rig's). */
export function setWakeSwitchReader(fn: WakeSwitchReader): void {
  readWakeSwitch = fn;
}

/**
 * Reads the `askGate` flag OFF THE RUN ROW for `runId` (#119). SEPARATE from
 * `readWakeSwitch`: gate-wakes are a distinct mechanism behind a distinct switch
 * (`busSwitch(runId, 'ask_gate')`), so lot/question wakes and gate wakes flip
 * independently. Same contract as the wake reader — a pure per-run read of the
 * frozen flag, defaulting OFF (counted, not fired) until #118's accessor is
 * wired at boot, so the shipped default for gate-wakes is shadow too. */
export type AskGateSwitchReader = (runId: string) => boolean;

let readAskGateSwitch: AskGateSwitchReader = () => false;

/** Wire in #118's `askGate` accessor (or a rig's). */
export function setAskGateSwitchReader(fn: AskGateSwitchReader): void {
  readAskGateSwitch = fn;
}

/** True once startBusWake() has run — the sweep is inert before it. Replaces
 *  the old `switchOnForRun` cache, which conflated "started" with "the flag". */
let started = false;

// ─── Shadow counters ───────────────────────────────────────────────────────

export interface BusWakeCounters {
  /** Wakes actually delivered into a session. */
  fired: number;
  /** Would-have-woken, suppressed because the switch is off (the shadow signal). */
  counted: number;
  /** Wakes that could not be delivered — sdkWake threw. Never silent. */
  failed: number;
}

const counters: BusWakeCounters = { fired: 0, counted: 0, failed: 0 };

export function busWakeCounters(): BusWakeCounters {
  return { ...counters };
}

/** The dedup ledger: reader handle → the pending high-water we last acted on. */
const ledger = new Map<string, WakeLedgerEntry>();

// ─── Reading pending state from the bus ────────────────────────────────────

/**
 * Compute, for every reader we could wake, whether it has PENDING state.
 *
 * Pending = an unread lot OR an open QUESTION message addressed to the reader.
 * Read entirely from DURABLE tables — `messages`/`cursors`/`deliveries` — so a
 * restart recomputes the identical answer.
 *
 * The lot half is deliberately expressed as "is there anything past the reader's
 * durable cursor", NOT "is there an outstanding delivery row". Those differ in
 * the case that matters: a reader that has never checked has no delivery row at
 * all, and an outstanding-row predicate would report it as having nothing
 * pending — the reader that most needs waking is the one such a predicate is
 * blind to.
 *
 * ── Open GATES wake their RECIPIENT (#119, reversing wave-B D2) ──────────────
 *
 * Wave B (ledger #123 Q-B3) deliberately left gates OUT because they had no
 * recipient and `check` could not surface them, so a gate-woken reader was
 * ordered to look somewhere that could never show the gate. #119 fixes both: a
 * gate now carries a `recipient` (MIGRATIONS[4]) and `check` surfaces open gates
 * addressed to the caller. So an open gate addressed to the reader is pending —
 * carried in a SEPARATE field (`gatePending`/`gateThroughSeq`), because it is
 * gated on the `askGate` switch, not `wake`: the two mechanisms flip
 * independently and folding them into one boolean would make one switch answer
 * for both. A gate with a NULL recipient (pre-#119, or addressed to nobody)
 * matches no reader and wakes nobody — the coexistence-safe direction.
 */
export function readPendingReaders(
  db: BusDb,
  readers: readonly { reader: string; runId: string }[],
): ReaderPendingState[] {
  // EVERY query is scoped to the reader's OWN run. Without `run_id = ?` a reader
  // in run A is reported pending for run B's traffic, and would then be woken to
  // run `orchestra check`, which — scoped to ITS run by the CLI — returns an
  // empty lot. The reader is ordered to look at nothing, finds nothing, acks
  // nothing, and the pending state never clears, so it is woken again on every
  // sweep: a permanent wake loop whose only symptom is an agent repeatedly told
  // to check an empty mailbox. Run-scoping is also what makes the per-run switch
  // coherent — flags frozen per run are meaningless if the mail is not.
  const lotHigh = db.prepare(`
    SELECT COALESCE(MAX(m.sequence), 0) AS hi
      FROM messages m
     WHERE m.run_id = ?
       AND (m.recipient = ? OR m.recipient IS NULL)
       AND m.sequence > COALESCE(
             (SELECT c.acked_seq FROM cursors c WHERE c.reader = ? AND c.run_id = m.run_id), 0)
  `);
  // An UNANSWERED question addressed to the reader keeps it pending until the ask
  // is ANSWERED — not until the reader acks (#119, #108 Q15: "reading without
  // answering re-wakes until answered"). "Answered" = a message threaded to the
  // question (`thread_id = question.sequence`), which is what `send --thread
  // <ask-id>` writes. This is deliberately NOT cursor-based like the lot half: a
  // recipient that reads the ask and acks WITHOUT answering must still be re-woken
  // (the sweep's cursor-advance re-arm below drives that), because an unanswered
  // ask is exactly the reader the asker is blocked on. Unlike a gate before #119,
  // a question has a recipient and `check` surfaces it, so the wake order works.
  // "Answered" must be scoped to the RECIPIENT answering the ASKER (review-119
  // F1), not merely "some message is threaded to the ask". Without the sender/
  // recipient scope, ANY threaded message — a 3rd party's `send --thread`, the
  // asker self-replying, a mis-addressed reply — silently marks the ask answered,
  // so R is never re-woken and the asker's waiting-exclusion clears while it is
  // genuinely still blocked. The answer is the reply the ask verb documents:
  // sent BY the target (`r.sender = q.recipient`) and routed back TO the asker
  // (`r.recipient = q.sender`).
  const openQuestion = db.prepare(`
    SELECT COALESCE(MAX(q.sequence), 0) AS hi
      FROM messages q
     WHERE q.run_id = ? AND q.kind = 'question' AND q.recipient = ?
       AND NOT EXISTS (
         SELECT 1 FROM messages r
          WHERE r.run_id = q.run_id AND r.thread_id = CAST(q.sequence AS TEXT)
            AND r.sender = q.recipient AND r.recipient = q.sender
       )
  `);
  const cursorOf = db.prepare(
    'SELECT COALESCE(acked_seq, 0) AS c FROM cursors WHERE run_id = ? AND reader = ?',
  );

  const out: ReaderPendingState[] = [];
  for (const { reader, runId } of readers) {
    const hi = Number((lotHigh.get(runId, reader, reader) as { hi: number }).hi);
    const qhi = Number((openQuestion.get(runId, reader) as { hi: number }).hi);
    const cursorSeq = Number(
      ((cursorOf.get(runId, reader) as { c: number } | undefined)?.c) ?? 0,
    );
    // The lot half is cursor-based and clears on ack; the question half is
    // answer-based and does NOT. `pending` is either; `reWakeUntilAnswered` marks
    // that the question half is what keeps it pending, so the sweep uses the
    // cursor-advance re-arm rather than the ordinary prune-on-clear.
    const reWakeUntilAnswered = qhi > 0;
    const pendingThroughSeq = Math.max(hi, qhi);
    // Gate half (#119), computed SEPARATELY — it rides the `askGate` switch, not
    // `wake`. `gateThroughSeq` is the highest OPEN gate id addressed to this
    // reader; 0 when none. Kept apart from `pendingThroughSeq` on purpose: gate
    // ids and message sequences share no numbering, so a single combined mark
    // could let a high gate id suppress a genuinely newer lot (or vice versa).
    const gates = openGatesForRecipient(db, runId, reader);
    const gateThroughSeq = gates.reduce((mx, g) => Math.max(mx, g.id), 0);
    out.push({
      reader,
      pendingThroughSeq,
      pending: pendingThroughSeq > 0,
      gatePending: gates.length > 0,
      gateThroughSeq,
      reWakeUntilAnswered,
      cursorSeq,
    });
  }
  return out;
}

/**
 * The readers currently in state `waiting` — parked on their OWN open ask or
 * gate, awaiting an answer (#119; the export #120 consumes for staleness).
 *
 * A reader is `waiting` when it is the ASKER/OPENER of something still open:
 *   - it SENT a `question` message that has no threaded reply yet (no message
 *     whose `thread_id` equals that question's `sequence`), OR
 *   - it OPENED a `decision_gates` row that is not yet resolved.
 *
 * This is the SENDER side, deliberately distinct from `readPendingReaders`'s
 * RECIPIENT side: the recipient of an open ask/gate is woken (pending); the
 * asker is idle-by-design and must be EXCLUDED from staleness, never flagged as
 * a silent agent (#119 acceptance 3, T119.4). #120 subtracts this set from its
 * staleness candidates.
 *
 * Run-scoped exactly like the pending predicate: a reader waiting in run A is
 * not waiting for run B's traffic. Independent of any switch — being `waiting`
 * is a truth about the reader's durable state, not a fired mechanism.
 */
export function readWaitingReaders(
  db: BusDb,
  readers: readonly { reader: string; runId: string }[],
): Set<string> {
  // An open ask the reader SENT: a `question` it authored with no reply from the
  // TARGET back to it. Same F1 scope as the recipient side (review-119): the
  // "answer" is the reply sent BY the target (`r.sender = q.recipient`) and
  // routed back TO the asker (`r.recipient = q.sender`); a 3rd-party or self
  // threaded message must NOT clear the asker's waiting-exclusion while it is
  // genuinely still blocked (else #120 would treat the blocked asker as stale).
  const openAskSent = db.prepare(`
    SELECT 1
      FROM messages q
     WHERE q.run_id = ? AND q.kind = 'question' AND q.sender = ?
       AND NOT EXISTS (
         SELECT 1 FROM messages r
          WHERE r.run_id = q.run_id
            AND r.thread_id = CAST(q.sequence AS TEXT)
            AND r.sender = q.recipient AND r.recipient = q.sender
       )
     LIMIT 1
  `);
  // An open gate the reader OPENED (asked_by), not yet resolved.
  const openGateOpened = db.prepare(`
    SELECT 1 FROM decision_gates
     WHERE run_id = ? AND asked_by = ? AND resolved_at IS NULL
     LIMIT 1
  `);
  const waiting = new Set<string>();
  for (const { reader, runId } of readers) {
    if (openAskSent.get(runId, reader) || openGateOpened.get(runId, reader)) {
      waiting.add(reader);
    }
  }
  return waiting;
}

/** The readers the host could wake — every live workspace, keyed by its id,
 *  which is what `$ORCHESTRA_WS_ID` (and therefore #115's `--as` default) is.
 *
 *  INJECTED rather than imported. `store.ts` reaches the platform seam through
 *  a directory import that node's --experimental-strip-types runner cannot
 *  resolve, so importing it here would make this module — and the pending
 *  predicate with it — untestable under `pnpm run test`. The seam is also the
 *  honest shape: which workspaces exist is not something the wake policy should
 *  know, and a rig can now drive the sweep over a hand-written roster. */
export interface WakeableReader {
  reader: string;
  wakeable: boolean;
  /** The bus run this reader belongs to. The switch is keyed on it (each run
   *  carries its own frozen flags), and so is the reader's cursor — the same
   *  handle in two runs has two independent positions. */
  runId: string;
}

let readRoster: () => WakeableReader[] = () => [];

/** Wired at boot (index.ts) with the real store, and by rigs with a fixture. */
export function setWakeRoster(fn: () => WakeableReader[]): void {
  readRoster = fn;
}

/** How a wake reaches the reader's session. Resolves TRUE only when the turn
 *  was actually started or queued for the session — never merely attempted.
 *
 *  Injected for the same two reasons as the roster. First, mechanically:
 *  `sdk-delivery.ts` imports `./logger` extensionless, which the strip-types
 *  test runner cannot resolve, so a direct import makes this module untestable.
 *  Second, and more importantly, it is the seam that lets the gate assert what
 *  a wake DID rather than that no error was thrown — a rig binds a recorder
 *  here and counts turns, which is the observable T117.1/T117.2 actually name.
 *
 *  Wired at boot to `sdkStartAndDeliver` (src/main/sdk-delivery.ts), itself the
 *  cycle-safe seam over `sdkWake`: it lazy-starts a session, resuming the
 *  workspace's prior conversation, and delivers the order as that turn. It
 *  returns FALSE rather than throwing when the SDK module has not registered —
 *  a state this module must treat as "not woken", never as success. */
export type WakeDeliver = (wsId: string, text: string) => Promise<boolean>;

let deliverWake: WakeDeliver = async () => false;

export function setWakeDeliver(fn: WakeDeliver): void {
  deliverWake = fn;
}

// ─── The sweep ─────────────────────────────────────────────────────────────

/** Where the sweep gets its connection. Defaults to the boot bus; a rig points
 *  it at a temp file so the sweep can be driven end to end without an Electron
 *  main process, and so the `null` arm (D1) can be exercised on purpose rather
 *  than only in production. */
let readBusDb: () => BusDb | null = getBus;

export function __setBusReaderForTests(fn: () => BusDb | null): void {
  readBusDb = fn;
}

let sweeping = false;

/**
 * One level-triggered pass: read pending state, decide per reader, act.
 *
 * Re-entrancy guarded because the WAL watcher and the timer can both land while
 * an `await sdkWake` is in flight, and two concurrent sweeps would each read the
 * ledger BEFORE either wrote it — the classic read-modify-write across an await
 * that #57 measured losing an entry. The guard makes the ledger single-writer.
 */
export async function sweepBusWake(): Promise<void> {
  if (sweeping) return;
  const db = readBusDb();
  if (!db) {
    // D1: no bus is not an error here and must not throw into the host path.
    // Nothing is lost — the next sweep re-reads durable state.
    return;
  }
  if (!started) return; // startBusWake() has not run
  sweeping = true;
  try {
    const readers = readRoster();
    const pending = readPendingReaders(db, readers);
    // A reader stays in the dedup ledger while pending for EITHER a lot/question
    // OR a gate (#119): the re-arm is "no more pending state of any kind", so a
    // reader that acked its lot but still has an open gate must NOT be pruned, or
    // it would be woken again for the same gate on the next sweep.
    const stillPending = new Set(
      pending.filter((p) => p.pending || p.gatePending === true).map((p) => p.reader),
    );
    pruneWakeLedger(ledger, stillPending);

    for (const p of pending) {
      const entry = readers.find((r) => r.reader === p.reader);
      const session = { wakeable: entry?.wakeable ?? false };
      // PER SWEEP, PER RUN — never a process-wide cache. See the switch seam
      // header: two runs with different frozen flags are the normal steady
      // state of a fleet mid-wave, and one boolean cannot answer for both.
      // Read defensively: the accessor is #118's code reached through a seam,
      // and the safe direction on an unreadable flag is OFF — counted, never
      // fired — rather than taking the whole sweep down.
      let switchOn = false;
      let askGateOn = false;
      try {
        switchOn = entry ? readWakeSwitch(entry.runId) : false;
      } catch (e) {
        log.warn(`bus-wake: wake switch read failed for ${p.reader} — treating as OFF`, e);
      }
      // The `askGate` switch is read INDEPENDENTLY, in its own try, so a throw in
      // one accessor cannot silently drag the other to OFF and mask which
      // mechanism is actually unreadable. Both default OFF — counted, never
      // fired — which is the standing coexistence-safe direction.
      try {
        askGateOn = entry ? readAskGateSwitch(entry.runId) : false;
      } catch (e) {
        log.warn(`bus-wake: askGate switch read failed for ${p.reader} — treating as OFF`, e);
      }
      // ── The ask re-wake-until-answered re-arm (#119, #108 Q15) ──────────────
      // A reader parked on an UNANSWERED ask does not clear its pending state by
      // acking (the ask half is answer-based, not cursor-based). So the ordinary
      // prune-on-clear re-arm never fires and it would be woken exactly once —
      // but the ticket requires "reading without answering re-wakes until
      // answered". The re-arm signal is the reader's CURSOR advancing past where
      // it was when we last woke it: that is the reader having read (and acked)
      // the ask without answering. When we see that, drop the ledger entry so
      // decideWake fires a fresh wake. Bounded by ACKS, not sweeps: after we
      // re-fire we record the new cursor, so the reader is not re-woken again
      // until it acks again. An answered ask clears `pending` and prunes normally.
      const prev = ledger.get(p.reader);
      if (
        prev &&
        p.reWakeUntilAnswered === true &&
        prev.cursorAtWake !== undefined &&
        (p.cursorSeq ?? 0) > prev.cursorAtWake
      ) {
        ledger.delete(p.reader);
      }
      const action = decideWake(p, session, ledger.get(p.reader), switchOn, askGateOn);
      if (action.kind === 'skip') continue;
      // Mark BEFORE the await, not after: `sdkWake` yields, and a second sweep
      // entering during that yield would otherwise see no ledger entry and fire
      // a duplicate — the same shape as #112's duplicate prompt.
      ledger.set(action.reader, {
        wokeThroughSeq: action.throughSeq,
        // Record the cursor only for the re-wake-until-answered path, so a later
        // advance re-arms it. Left undefined for ordinary lot wakes.
        cursorAtWake: p.reWakeUntilAnswered === true ? (p.cursorSeq ?? 0) : undefined,
      });
      if (action.kind === 'count') {
        counters.counted++;
        log.info(
          `bus-wake: would have woken ${action.reader} through seq ${action.throughSeq} (switch OFF — counted, not fired)`,
        );
        continue;
      }
      let delivered = false;
      try {
        delivered = await deliverWake(action.reader, WAKE_ORDER);
      } catch (e) {
        log.warn(`bus-wake: wake threw for ${action.reader}`, e);
      }
      if (delivered) {
        counters.fired++;
        log.info(`bus-wake: woke ${action.reader} through seq ${action.throughSeq}`);
      } else {
        // A FALSE return is a failure, not a quiet success. `sdkStartAndDeliver`
        // returns false when the SDK module never registered or the start failed
        // — both look identical to "nothing happened" from outside, which is why
        // the counter and the log line are what make them observable at all.
        counters.failed++;
        // The ledger entry is withdrawn so the next sweep RETRIES. A wake that
        // failed must not be indistinguishable from one that landed: leaving the
        // mark would suppress every future wake for this reader's current lot.
        ledger.delete(action.reader);
        log.warn(`bus-wake: failed to wake ${action.reader} through seq ${action.throughSeq}`);
      }
    }
  } catch (e) {
    log.warn('bus-wake: sweep failed', e);
  } finally {
    sweeping = false;
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;
let watcher: fs.FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;

/** Start the wake subsystem (idempotent). Does NOT bind the switch value: the
 *  one `readWakeSwitch('default')` below is a shipped-state SIGNAL for the boot
 *  gate only — every sweep reads the flag per-run, per-sweep (ledger #123 Q1). */
export function startBusWake(): void {
  if (timer) return;
  started = true;
  // The line the packaged boot gate asserts. It reports the DEFAULT run's flag
  // purely as a shipped-state signal for that gate; it is NOT the value any
  // sweep uses, because each reader's flag is read from its own run row.
  let defaultOn = false;
  try {
    defaultOn = readWakeSwitch('default');
  } catch {
    /* an unreadable switch is OFF — the sweep logs its own warning */
  }
  log.info(`bus-wake: started (switch ${defaultOn ? 'ON — firing' : 'OFF — counting only'})`);

  // The startup sweep is half of what makes this level-triggered: it is what
  // fires a wake for an insert that landed while the app was closed (#117
  // acceptance 3). Run it before arming the watcher so a restart's first act is
  // to reconcile durable state, not to wait for the next write.
  void sweepBusWake();

  timer = setInterval(() => void sweepBusWake(), SWEEP_MS);
  timer.unref();

  // The accelerator. Watching the -wal file rather than bus.sqlite: in WAL mode
  // the main DB file is barely touched, so a watch on it misses nearly every
  // insert (spike #109 arm 4). Failure to arm is NOT fatal — the timer still
  // delivers every wake, just later.
  try {
    watcher = fs.watch(`${busPath()}-wal`, () => {
      if (debounce) clearTimeout(debounce);
      debounce = setTimeout(() => void sweepBusWake(), WATCH_DEBOUNCE_MS);
      debounce.unref?.();
    });
  } catch (e) {
    log.warn(`bus-wake: could not watch ${busPath()}-wal — falling back to the ${SWEEP_MS}ms sweep`, e);
  }
}

export function stopBusWake(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  if (debounce) {
    clearTimeout(debounce);
    debounce = null;
  }
  watcher?.close();
  watcher = null;
  started = false;
}

/** Test/rig seam: clear the dedup ledger and counters so a rig drives from a
 *  known baseline instead of inheriting a previous test's marks. */
export function __resetBusWakeForTests(): void {
  ledger.clear();
  counters.fired = 0;
  counters.counted = 0;
  counters.failed = 0;
  started = false;
  readWakeSwitch = () => false;
  readAskGateSwitch = () => false;
  readBusDb = getBus;
  readRoster = () => [];
  deliverWake = async () => false;
}

/** Rig seam: arm the sweep WITHOUT starting the timer or the fs watcher.
 *  `startBusWake()` is the production path and does both; a unit rig wants
 *  neither, but must drive the SAME per-run switch read that ships — so this
 *  takes the ACCESSOR, never a pre-resolved boolean. The `boolean` overload is
 *  sugar for "every run answers this"; it deliberately cannot express a two-run
 *  case, which is exactly why the Q1 arm passes a function. */
export function __freezeSwitchForTests(
  on: boolean | WakeSwitchReader,
  askGate?: boolean | AskGateSwitchReader,
): void {
  setWakeSwitchReader(typeof on === 'function' ? on : () => on);
  // The `askGate` switch (#119). Defaults to OFF when omitted, so every existing
  // wake test that passes only the wake arg keeps gate-wakes OFF unchanged. A
  // gate arm passes the second arg (a boolean, or a per-run reader for the
  // two-runs case) exactly as the wake arg does.
  if (askGate !== undefined) {
    setAskGateSwitchReader(typeof askGate === 'function' ? askGate : () => askGate);
  }
  started = true;
}
