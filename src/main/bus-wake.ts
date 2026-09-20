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
import path from 'node:path';
import {
  getBus,
  busPath,
  openGatesForRecipientInRuns,
  ownRunRecipientSql,
  relatedRunRecipientSql,
  type BusDb,
} from './bus.ts';
import { getRelatedRunIds } from './bus-runs.ts';
import { log } from './logger.ts';
import {
  decideWake,
  pruneWakeLedger,
  buildWakeOrder,
  type ReaderPendingState,
  type WakeLedgerEntry,
  type SkipReason,
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

/** The FIRE dedup ledger: reader handle → the high-water a DELIVERED wake covered.
 *  Only `fire` actions write here (mark-before-await, #112). */
const ledger = new Map<string, WakeLedgerEntry>();

/** The COUNT dedup ledger (#153): reader handle → the high-water a COUNTED (switch
 *  OFF, never delivered) would-have-woken covered. SEPARATE from `ledger` so a count
 *  never arms the FIRE dedup — a counted reader was never delivered a wake and never
 *  acks, so if a count wrote the fire ledger, a mid-process OFF→ON flip would leave
 *  it in `already-woken` starvation forever (the C5 shape #150, reintroduced by the
 *  shadow path; canary-4 F-C4-1). Counts dedup against counts here, so the shadow
 *  counter still measures WAKES, not 60 sweep-ticks a minute. */
const countLedger = new Map<string, WakeLedgerEntry>();

/**
 * #159 OBSERVABILITY — per-reader wakeable-state TRANSITION log.
 *
 * A `skip` in the sweep is the ONE outcome with no log line (fire → "woke",
 * count → "would have woken", failed → "failed to wake"), so a reader stuck
 * SKIPPED while it has pending mail — the #159 `already-woken` starvation, or a
 * genuine `not-wakeable` — is invisible: a 19-min silent window was diagnosable
 * only by elimination (F-C5-3, F-C6). This map records the last state we LOGGED
 * for each reader so the sweep logs ONCE per transition (never per sweep, or a
 * stuck reader would spam 60 lines a minute — the exact noise the count-ledger
 * dedup avoids). State = `'active'` (fired/counted this sweep — the healthy
 * observable already logs) or the `SkipReason` of a reader that HAS pending but
 * was skipped. Only PENDING readers are tracked; a reader with nothing pending
 * is not "silently skipped", it is correctly idle (and prunes below). */
const skipState = new Map<string, 'active' | SkipReason>();

/** Log a reader's wakeable-state transition ONCE (#159). No-op when the state is
 *  unchanged since the last logged value — so a reader stuck `already-woken` for
 *  18 sweeps logs a SINGLE line on entry, not one per sweep. Entering a skip state
 *  warns (it is the diagnosable event); recovering to `active` is info. */
function logWakeableTransition(reader: string, next: 'active' | SkipReason): void {
  if (skipState.get(reader) === next) return;
  const prev = skipState.get(reader);
  skipState.set(reader, next);
  if (next === 'active') {
    // Only announce a RECOVERY, not the first-ever active observation — a reader
    // that was never stuck has no transition worth a line (the fire/count log
    // already records the healthy event).
    if (prev !== undefined) {
      log.info(`bus-wake: ${reader} wakeable again (was ${prev}) — pending wake will be delivered`);
    }
  } else {
    log.warn(
      `bus-wake: ${reader} is PENDING but not being woken — skip reason '${next}'` +
        (prev && prev !== 'active' ? ` (was '${prev}')` : '') +
        ' (this is logged once per transition, not per sweep — #159)',
    );
  }
}

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
  // #134 D1a-bis (ledger #135): a reader is pending for mail addressed to it in
  // its OWN run, any DESCENDANT run, OR any ANCESTOR run. The store-less CLI
  // writes mail with the SENDER's run, so an OPS→LEAD digest sits in the OPS's
  // DESCENDANT run and a LEAD→OPS ruling sits in the LEAD's ANCESTOR run — the
  // reader must look both up and down its chain. Which run's `wake` flag GOVERNS
  // is the INNERMOST = the DEEPER of (mail run, reader run), computed below from
  // the depth map and carried as `switchRunId`; the sweep reads THAT flag.
  //
  // Two scopes, deliberately different:
  //   - the reader's OWN run: `recipient = reader OR NULL` (a null-recipient
  //     BROADCAST in the reader's own run still wakes it, as before);
  //   - a RELATED (ancestor/descendant) run: `recipient = reader` EXACTLY — never
  //     a null broadcast. A broadcast belongs to the run it was sent in, not up or
  //     down the tree; pulling it across would wake unrelated parties.
  //
  // Still run-scoped (never a bare cross-run read): the mail must be in a run
  // RELATED to the reader, so the reader is never woken for a stranger run's
  // traffic. The cursor subquery self-scopes to `m.run_id`, so the lot clears
  // against the reader's cursor IN THE RUN THE MAIL SITS IN.
  const lotRows = db.prepare(`
    SELECT m.run_id AS run_id, m.sequence AS seq
      FROM messages m
     WHERE m.run_id IN (SELECT value FROM json_each(?))
       AND (
         (m.run_id = ? AND ${ownRunRecipientSql('m')})      -- own run: exact OR broadcast
         OR (m.run_id != ? AND ${relatedRunRecipientSql('m')}) -- related run: exact ONLY
       )
       AND m.sequence > COALESCE(
             (SELECT c.acked_seq FROM cursors c WHERE c.reader = ? AND c.run_id = m.run_id), 0)
     ORDER BY m.sequence DESC
     LIMIT 1
  `);
  // An UNANSWERED question addressed to the reader keeps it pending until the ask
  // is ANSWERED — not until the reader acks (#119, #108 Q15). Same related-run
  // widening as the lot half (recipient EXACT outside the own run). "Answered" =
  // a reply sent BY the target (`r.sender = q.recipient`) TO the asker
  // (`r.recipient = q.sender`), threaded to the question, in the SAME run as the
  // question (review-119 F1: a 3rd-party/self/mis-addressed reply must not clear it).
  const questionRows = db.prepare(`
    SELECT q.run_id AS run_id, q.sequence AS seq
      FROM messages q
     WHERE q.run_id IN (SELECT value FROM json_each(?))
       AND q.kind = 'question' AND q.recipient = ?
       AND NOT EXISTS (
         SELECT 1 FROM messages r
          WHERE r.run_id = q.run_id AND r.thread_id = CAST(q.sequence AS TEXT)
            AND r.sender = q.recipient AND r.recipient = q.sender
       )
     ORDER BY q.sequence DESC
     LIMIT 1
  `);
  const cursorOf = db.prepare(
    'SELECT COALESCE(acked_seq, 0) AS c FROM cursors WHERE run_id = ? AND reader = ?',
  );
  // #134 D2: the DISTINCT set of runs (own ∪ related) that currently have pending
  // mail for the reader — a pending lot OR an unanswered question. The wake order
  // names EVERY one of these (`orchestra check --run <r>` per run), because a
  // reader can have unread mail in several runs at once. Same predicates as the
  // newest-item queries above, without the LIMIT 1, grouped to distinct runs.
  const pendingRunSet = db.prepare(`
    SELECT DISTINCT run_id FROM (
      SELECT m.run_id AS run_id
        FROM messages m
       WHERE m.run_id IN (SELECT value FROM json_each(?))
         AND (
           (m.run_id = ? AND ${ownRunRecipientSql('m')})
           OR (m.run_id != ? AND ${relatedRunRecipientSql('m')})
         )
         AND m.sequence > COALESCE(
               (SELECT c.acked_seq FROM cursors c WHERE c.reader = ? AND c.run_id = m.run_id), 0)
      UNION
      SELECT q.run_id AS run_id
        FROM messages q
       WHERE q.run_id IN (SELECT value FROM json_each(?))
         AND q.kind = 'question' AND q.recipient = ?
         AND NOT EXISTS (
           SELECT 1 FROM messages r
            WHERE r.run_id = q.run_id AND r.thread_id = CAST(q.sequence AS TEXT)
              AND r.sender = q.recipient AND r.recipient = q.sender
         )
    )
  `);

  const out: ReaderPendingState[] = [];
  for (const { reader, runId } of readers) {
    // The reader's run + every ancestor + every descendant, with a depth map.
    // json_each turns the id array into a table so ONE prepared statement covers
    // a variable-size run set.
    const related = getRelatedRunIds(db, runId);
    const runSetJson = JSON.stringify(related.ids);
    const lot = lotRows.get(runSetJson, runId, reader, runId, reader, reader) as
      | { run_id: string; seq: number }
      | undefined;
    const q = questionRows.get(runSetJson, reader) as
      | { run_id: string; seq: number }
      | undefined;
    const hi = Number(lot?.seq ?? 0);
    const qhi = Number(q?.seq ?? 0);
    // The MAIL's run — where the newest pending item sits (seqs are a global total
    // order). This is the retrieval + ack run (the wake order names it). Falls
    // back to the reader's own run when nothing pends.
    const mailRunId =
      (hi >= qhi ? (lot?.run_id ?? q?.run_id) : (q?.run_id ?? lot?.run_id)) ?? runId;
    // The GOVERNING run = the INNERMOST = the DEEPER of (mail run, reader run).
    // Upward mail (OPS→LEAD): mail (OPS) is deeper → mail run. Downward mail
    // (LEAD→OPS): reader (OPS) is deeper → reader run. Equal/unknown depth (same
    // run, or an unrelated run with no depth) → the mail run, which for own-run
    // mail is the reader run anyway.
    const mailDepth = related.depth.get(mailRunId) ?? 0;
    const readerDepth = related.depth.get(runId) ?? 0;
    const switchRunId = readerDepth > mailDepth ? runId : mailRunId;
    // The re-arm cursor is the reader's cursor IN THE MAIL'S run (the run the ack
    // advances), not the reader's own run.
    const cursorSeq = Number(
      ((cursorOf.get(mailRunId, reader) as { c: number } | undefined)?.c) ?? 0,
    );
    const reWakeUntilAnswered = qhi > 0;
    const pendingThroughSeq = Math.max(hi, qhi);
    // The FULL set of runs with pending mail — the wake order names them all (D2).
    const pendingRunIds =
      pendingThroughSeq > 0
        ? (pendingRunSet.all(runSetJson, runId, reader, runId, reader, reader, runSetJson, reader) as {
            run_id: string;
          }[]).map((r) => r.run_id)
        : [];
    // Per-run cursors for the #150 re-arm (review-150 F1): the reader's cursor in
    // EVERY RELATED run — not just the currently-pending ones. `messages.sequence`
    // is global but cursors are PER-RUN, so the re-arm must read the cursor of the
    // SAME run the ledger's high-water (`wokeThroughSeq`/`wokeRunId`) was recorded
    // against. The woken run may NO LONGER be pending this sweep (the reader acked
    // it; a different run is now newest), so populating only the pending runs would
    // omit exactly the cursor the re-arm needs — the whole related set covers it.
    const cursorByRun = new Map<string, number>();
    for (const r of related.ids) {
      cursorByRun.set(
        r,
        Number(((cursorOf.get(r, reader) as { c: number } | undefined)?.c) ?? 0),
      );
    }
    // Gate half (#119) — rides the `askGate` switch. WIDENED to the related run
    // set (#158): a gate carries an explicit recipient, and an OPS→LEAD ruling
    // gate is opened in the ASKER's run with the recipient in ANOTHER run, so the
    // pre-#158 own-run-only lookup made every such gate invisible to its recipient
    // — no wake, no check surface (ledger #157 F-C5-1). Now symmetric with the lot
    // half: gates addressed to this reader in own ∪ ancestors ∪ descendants, the
    // same `related.ids` computed above. `gateThroughSeq` stays a global gate-id
    // high-water (one `decision_gates` table), so the D-H1 gate-axis re-arm is
    // unchanged across runs.
    const gates = openGatesForRecipientInRuns(db, related.ids, reader);
    const gateThroughSeq = gates.reduce((mx, g) => Math.max(mx, g.id), 0);
    // The DISTINCT runs those open gates sit in — the wake order names them so the
    // recipient's `orchestra check --run <gateRun>` surfaces the gate (D2 shape).
    const gateRunIds = [...new Set(gates.map((g) => g.run_id))];
    out.push({
      reader,
      pendingThroughSeq,
      pending: pendingThroughSeq > 0,
      gatePending: gates.length > 0,
      gateThroughSeq,
      gateRunIds: gates.length > 0 ? gateRunIds : undefined,
      reWakeUntilAnswered,
      cursorSeq,
      cursorByRun,
      pendingRunId: pendingThroughSeq > 0 ? mailRunId : undefined,
      pendingRunIds: pendingThroughSeq > 0 ? pendingRunIds : undefined,
      switchRunId: pendingThroughSeq > 0 ? switchRunId : undefined,
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
    // #153: the COUNT ledger prunes on the SAME level-triggered signal as the fire
    // ledger — a reader whose pending state cleared re-arms for the next count too.
    pruneWakeLedger(countLedger, stillPending);
    // #159: a reader with NO pending state is not stuck — drop its transition state
    // so a future stall re-logs. A reader that recovered by DRAINING (pending went
    // false) logs the recovery here rather than via the `active` branch (which only
    // sees readers still pending this sweep).
    for (const reader of [...skipState.keys()]) {
      if (!stillPending.has(reader)) {
        const prev = skipState.get(reader);
        skipState.delete(reader);
        if (prev && prev !== 'active') {
          log.info(`bus-wake: ${reader} no longer pending (was '${prev}') — resolved`);
        }
      }
    }

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
      // #134 D1a-bis: the `wake` switch is read for the GOVERNING run — the
      // INNERMOST = the DEEPER of (mail run, reader run), precomputed as
      // `p.switchRunId`. Upward mail (OPS→LEAD) → the mail's (OPS) run governs;
      // downward mail (LEAD→OPS) → the reader's (OPS) run governs. Reading the
      // reader's own run for upward mail, or the mail's run for downward mail, is
      // the mutant the two G4a fire arms redden. Falls back to the reader's own
      // run when nothing lot/question-shaped pends (e.g. gate-only).
      const wakeRunId = p.switchRunId ?? entry?.runId;
      try {
        switchOn = wakeRunId ? readWakeSwitch(wakeRunId) : false;
      } catch (e) {
        log.warn(`bus-wake: wake switch read failed for ${p.reader} — treating as OFF`, e);
      }
      // The `askGate` switch is read INDEPENDENTLY, in its own try, so a throw in
      // one accessor cannot silently drag the other to OFF and mask which
      // mechanism is actually unreadable. Both default OFF — counted, never
      // fired — which is the standing coexistence-safe direction. Gates are NOT
      // part of the digest-up widening (own-run only), so this stays keyed on the
      // reader's own run.
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
      // The ask re-wake-until-answered re-arm (#119) applies to whichever ledger the
      // reader's ask wake landed in — a FIRED ask (wake ON) or a COUNTED one (wake
      // OFF): the reader acking without answering must re-arm the same-kind dedup.
      for (const led of [ledger, countLedger]) {
        const prev = led.get(p.reader);
        if (
          prev &&
          p.reWakeUntilAnswered === true &&
          prev.cursorAtWake !== undefined &&
          (p.cursorSeq ?? 0) > prev.cursorAtWake
        ) {
          led.delete(p.reader);
        }
      }
      const action = decideWake(
        p,
        session,
        ledger.get(p.reader),
        switchOn,
        askGateOn,
        countLedger.get(p.reader),
      );
      // #159 transition log. `no-pending` is not a "silent skip" — the reader has
      // nothing to wake for — so it is not tracked here (its entry is pruned below,
      // which also LOGS the recovery if it was previously stuck). Any OTHER skip on a
      // pending reader (`already-woken`, `not-wakeable`) is the invisible state: log
      // the ENTRY into it and each CHANGE of reason, ONCE. fire/count are the
      // recovery — log the transition back to active, then the healthy line follows.
      if (action.kind === 'skip') {
        if (action.why !== 'no-pending') logWakeableTransition(p.reader, action.why);
        continue;
      }
      logWakeableTransition(action.reader, 'active');
      // #153: write the FIRE mark to the fire ledger and the COUNT mark to the count
      // ledger — NEVER cross them. A count writing the fire ledger is the exact bug:
      // a counted reader never acks, so its fire-dedup entry can never re-arm, and a
      // later OFF→ON flip strands it in `already-woken` starvation.
      const ledgerEntry: WakeLedgerEntry = {
        // TWO AXES recorded separately (D-H1): the LOT high-water re-arms on the
        // cursor (#150 F1), the GATE high-water on its own id rising. decideWake
        // carries each axis's mark forward when only the other axis acted, so a lot
        // re-arm never resets the gate mark (which would spuriously re-fire gates).
        wokeLotSeq: action.lotSeq,
        wokeGateSeq: action.gateSeq,
        // The run the LOT high-water belongs to — the mail run that justified it.
        // The #150 lot re-arm reads the reader's cursor IN THIS run next sweep,
        // because a global seq is only comparable to the same run's per-run cursor
        // (review-150 F1). Carried forward by decideWake when only the gate acted.
        wokeRunId: action.wokeRunId,
        // Record the cursor only for the re-wake-until-answered path, so a later
        // advance re-arms it. Left undefined for ordinary lot wakes.
        cursorAtWake: p.reWakeUntilAnswered === true ? (p.cursorSeq ?? 0) : undefined,
      };
      if (action.kind === 'count') {
        // A count arms ONLY the count ledger (dedup counts vs counts), never the
        // fire ledger. No await follows, so this needs no mark-before-await.
        countLedger.set(action.reader, ledgerEntry);
        counters.counted++;
        log.info(
          `bus-wake: would have woken ${action.reader} through seq ${action.throughSeq} (switch OFF — counted, not fired)`,
        );
        continue;
      }
      // Mark BEFORE the await, not after: `sdkWake` yields, and a second sweep
      // entering during that yield would otherwise see no ledger entry and fire
      // a duplicate — the same shape as #112's duplicate prompt.
      ledger.set(action.reader, ledgerEntry);
      // #134 D2 + #158: the wake ORDER names every run the reader must check —
      // its pending lot/question runs (own ∪ related) UNION every run an open gate
      // addressed to it sits in (own ∪ related, #158). A cross-run gate is opened
      // in the ASKER's run, so naming only the reader's own run (the pre-#158
      // fallback) ordered a `check` against a run that could never surface the
      // gate — the "no check surface" half of ledger #157 F-C5-1. When neither a
      // lot nor a gate names a run (should not happen for a woken reader) fall
      // back to the reader's own run. One `orchestra check --run <r>` line per
      // run; the reader checks/acks each per-run.
      const namedRuns = [
        ...(p.pendingRunIds ?? []),
        ...(p.gateRunIds ?? []),
      ];
      const orderRuns =
        namedRuns.length > 0 ? namedRuns : [entry?.runId ?? p.reader];
      const order = buildWakeOrder(orderRuns);
      let delivered = false;
      try {
        delivered = await deliverWake(action.reader, order);
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

/** Rig seam (#149 acceptance): the must-FAIL arm disables the accelerator so the
 *  wake latency reverts to the SWEEP_MS timer. Default true = the accelerator is
 *  armed in production. Set false BEFORE startBusWake()/armBusWalWatcher(). */
let watcherEnabled = true;

/** #149: disable/enable the WAL accelerator. The disabled arm is the acceptance
 *  must-FAIL control — with the watcher off, lone-message latency must revert to
 *  the 60s sweep, which is what proves the watcher is what buys sub-second wake. */
export function __setWatcherEnabledForTests(on: boolean): void {
  watcherEnabled = on;
}

/** The bus DB path the accelerator watches. Production reads `busPath()` (the
 *  live `<ORCHESTRA_HOME>/bus.sqlite`); a rig points it at its own temp bus so
 *  the directory watch is driven against a real on-disk file WITHOUT touching the
 *  live bus (contract rule 5). Resolved lazily per arm, never cached. */
let watchBusPath: () => string = busPath;

/** #149 rig seam: point the accelerator at a rig's temp bus file. */
export function __setWatchPathForTests(fn: () => string): void {
  watchBusPath = fn;
}

/**
 * Arm the WAL accelerator: watch the DIRECTORY and filter events by the `-wal`
 * basename, debouncing a sweep. Idempotent, and safe to call even when the DB
 * file does not yet exist (the directory is what we watch).
 *
 * ── #149: why the DIRECTORY, not the `-wal` file inode ──────────────────────
 *
 * The shipped watcher armed `fs.watch(bus.sqlite-wal)`, which pins the inotify
 * watch to the WAL file's INODE. Measured on this btrfs machine (ledger #151,
 * `scripts/diag-149-wal-watch.mjs`): SQLite unlinks `-wal` when the last WAL-mode
 * connection closes and recreates it at a NEW inode on the next write (inode
 * 32138494 → 32138511). An inode-pinned watch cannot follow that swap — after the
 * recycle it delivered 0/10 cross-process inserts while a directory watch
 * delivered 10/10 — and the detach is SILENT: the FSWatcher never emits `'error'`,
 * so a fallback-on-throw could never fire. (`wal_checkpoint(TRUNCATE)` alone does
 * NOT recycle the inode — it truncates in place — so the trigger is any lifecycle
 * that DELETES `-wal`.) The PROVEN silent-detach case is boot-time: after a clean
 * quit `closeBus` checkpoints `-wal` away, so an inode watch armed at the next
 * boot can ENOENT and ride the 60s sweep all session. Whether canary-3's 58.84s
 * live-session worst case was also a recycle is UNCONFIRMED (review-149: the inode
 * is stable while ONE connection is held open, as mid-session it is) — this fix is
 * strictly safer regardless and a directory watch is immune to every recycle mode.
 *
 * Watching the directory inode instead is stable across every `-wal`
 * unlink/recreate: the parent directory's inode does not change, and `fs.watch`
 * reports the child filename so we filter to exactly `bus.sqlite-wal`. The 60s
 * sweep stays as the level-triggered safety net (never removed).
 *
 * A `null` filename (some platforms/kernels omit it) is treated as a match — a
 * spurious sweep is cheap and the sweep is idempotent, whereas dropping a real
 * WAL event is the exact failure this fixes.
 */
export function armBusWalWatcher(): void {
  if (watcher) return; // already armed
  // `ORCHESTRA_BUS_WATCHER=off` disables the accelerator in a PACKAGED app — the
  // #149 acceptance must-FAIL arm (latency must revert to the 60s sweep), and a
  // real operational escape hatch if the watch ever misbehaves. The test seam
  // (`__setWatcherEnabledForTests`) is the unit-level equivalent.
  const envOff = (process.env.ORCHESTRA_BUS_WATCHER || '').trim().toLowerCase() === 'off';
  if (!watcherEnabled || envOff) {
    log.info(`bus-wake: WAL accelerator DISABLED (${envOff ? 'ORCHESTRA_BUS_WATCHER=off' : 'test'}) — sweep-only`);
    return;
  }
  const bus = watchBusPath();
  const dir = path.dirname(bus);
  const walName = `${path.basename(bus)}-wal`; // e.g. bus.sqlite-wal
  const fire = () => {
    // Opt-in diagnostic (OFF at the default `info` level): the exact latency
    // observable for #149. `ORCHESTRA_LOG_LEVEL=debug` prints one line per WAL
    // event so a rig can measure send→sweep latency directly — the packaged-app
    // acceptance gate keys on it (`scripts/verify-149-wake-latency.mjs`). Costs
    // nothing in production because `log.debug` is below the shipped threshold.
    log.debug(`bus-wake: WAL event → sweep scheduled (+${WATCH_DEBOUNCE_MS}ms debounce)`);
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => void sweepBusWake(), WATCH_DEBOUNCE_MS);
    debounce.unref?.();
  };
  try {
    watcher = fs.watch(dir, (_event, filename) => {
      // Filter to the WAL file. A null filename (platform-dependent) is treated
      // as a match rather than dropped — a spurious idempotent sweep is cheaper
      // than a missed wake, which is the whole defect (#149).
      if (filename === null || filename === walName) fire();
    });
    watcher.on('error', (e) => {
      // A directory-watch error is rare but must never be silent: log it and let
      // the 60s sweep carry every wake, just later.
      log.warn(`bus-wake: WAL directory watch errored — falling back to the ${SWEEP_MS}ms sweep`, e);
    });
    log.info(`bus-wake: WAL accelerator armed on directory ${dir} (filter ${walName})`);
  } catch (e) {
    log.warn(`bus-wake: could not watch directory ${dir} — falling back to the ${SWEEP_MS}ms sweep`, e);
  }
}

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

  // The accelerator (#149: directory watch + filename filter, survives WAL inode
  // recycle where the old `-wal` inode watch died silently). Failure to arm is
  // NOT fatal — the timer still delivers every wake, just later.
  armBusWalWatcher();
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
  countLedger.clear();
  skipState.clear();
  counters.fired = 0;
  counters.counted = 0;
  counters.failed = 0;
  started = false;
  watcherEnabled = true;
  watchBusPath = busPath;
  readWakeSwitch = () => false;
  readAskGateSwitch = () => false;
  readBusDb = getBus;
  readRoster = () => [];
  deliverWake = async () => false;
}

/** Rig seam: arm the sweep (`started = true`) WITHOUT touching the switch
 *  accessors — for a rig (like #134's G7) that has already wired the REAL
 *  production `setWakeSwitchReader`/`setAskGateSwitchReader` and must NOT have
 *  them overwritten by `__freezeSwitchForTests`. Does not start the timer or the
 *  fs watcher (a unit rig wants neither). */
export function __armStartedForTests(): void {
  started = true;
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
