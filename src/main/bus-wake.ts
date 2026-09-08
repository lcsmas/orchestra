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
import { getBus, busPath, type BusDb } from './bus.ts';
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
 * Pending = an unread lot OR an open ask/gate addressed to the reader (#108
 * Q15). Read entirely from DURABLE tables — `messages`/`cursors`/`deliveries`/
 * `decision_gates` — so a restart recomputes the identical answer.
 *
 * The lot half is deliberately expressed as "is there anything past the reader's
 * durable cursor", NOT "is there an outstanding delivery row". Those differ in
 * the case that matters: a reader that has never checked has no delivery row at
 * all, and an outstanding-row predicate would report it as having nothing
 * pending — the reader that most needs waking is the one such a predicate is
 * blind to.
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
  // An open ask/gate keeps the reader pending even with no unread lot: a reader
  // parked on an ask is `waiting`, never stale (#117 Intent).
  const openAsk = db.prepare(`
    SELECT COUNT(*) AS n FROM decision_gates
     WHERE run_id = ? AND resolved_at IS NULL AND asked_by <> ?
  `);
  const openQuestion = db.prepare(`
    SELECT COALESCE(MAX(m.sequence), 0) AS hi
      FROM messages m
     WHERE m.run_id = ? AND m.kind = 'question' AND m.recipient = ?
       AND m.sequence > COALESCE(
             (SELECT c.acked_seq FROM cursors c WHERE c.reader = ? AND c.run_id = m.run_id), 0)
  `);

  const out: ReaderPendingState[] = [];
  for (const { reader, runId } of readers) {
    const hi = Number((lotHigh.get(runId, reader, reader) as { hi: number }).hi);
    const qhi = Number((openQuestion.get(runId, reader, reader) as { hi: number }).hi);
    const asks = Number((openAsk.get(runId, reader) as { n: number }).n);
    const pendingThroughSeq = Math.max(hi, qhi);
    out.push({
      reader,
      pendingThroughSeq,
      pending: pendingThroughSeq > 0 || asks > 0,
    });
  }
  return out;
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
    const stillPending = new Set(pending.filter((p) => p.pending).map((p) => p.reader));
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
      try {
        switchOn = entry ? readWakeSwitch(entry.runId) : false;
      } catch (e) {
        log.warn(`bus-wake: switch read failed for ${p.reader} — treating as OFF`, e);
      }
      const action = decideWake(p, session, ledger.get(p.reader), switchOn);
      if (action.kind === 'skip') continue;
      // Mark BEFORE the await, not after: `sdkWake` yields, and a second sweep
      // entering during that yield would otherwise see no ledger entry and fire
      // a duplicate — the same shape as #112's duplicate prompt.
      ledger.set(action.reader, { wokeThroughSeq: action.throughSeq });
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

/** Start the wake subsystem (idempotent). Reads the switch ONCE, here. */
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
export function __freezeSwitchForTests(on: boolean | WakeSwitchReader): void {
  setWakeSwitchReader(typeof on === 'function' ? on : () => on);
  started = true;
}
