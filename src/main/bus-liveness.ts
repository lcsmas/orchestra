// Liveness + phase — the effectful half (issue #120, ledger #125). Policy lives
// in src/shared/bus-liveness.ts; this file reads the app's OWN activity signals
// (the status dot's sources) plus durable bus state, gates on the frozen
// `liveness` switch, and writes `escalation` rows to coordinators.
//
// ── What this is, and what it deliberately is NOT ───────────────────────────
//
// It is a LEVEL-TRIGGERED sweep, the same shape as #117's wake sweep: it reads
// who is stale RIGHT NOW from host-observed activity, decides per member, and
// acts, with no memory of individual activity events. It reuses the EXISTING
// activity signal (`getLastActivity`, fed by `applyAgentEvent`'s `noteActivity`
// on every lifecycle event incl. tool-call START) — it adds NO new probe, per
// the ticket boundary.
//
// It is NOT the phase half. Phase (`orchestra status` → a `status` row) is
// written at the note's own write chokepoint (`dispatchStatusRequest`,
// workspaces.ts), on genuine change, with no timer — a sweep would re-emit an
// unchanged note every tick.
//
// ── D1: the bus NEVER blocks boot (ledger #122) ─────────────────────────────
//
// `getBus()` returns null whenever the bus failed to open, and this module is a
// bus writer, so every entry point tolerates it: the sweep logs ONCE and
// returns, the escalation writer logs once and returns — never a throw into the
// host path. Nothing is lost that matters: a bus that comes back is swept again.

import { getBus, send, type BusDb } from './bus.ts';
import { busSwitch } from './bus-runs.ts';
import { log } from './logger.ts';
import {
  decideEscalation,
  pruneEscalationLedger,
  escalationBody,
  STALE_AFTER_MS,
  type MemberLivenessState,
  type EscalationLedgerEntry,
} from '../shared/bus-liveness.ts';

/** How often the level-triggered sweep runs. Matches #117's cadence; every
 *  escalation is produced by this timer alone (an accelerator would only lower
 *  latency, and staleness at a 10-min granularity needs none). */
const SWEEP_MS = 60_000;

// ─── The member roster seam (injected, like #117's wake roster) ─────────────
//
// INJECTED rather than imported: `store.ts` reaches the platform seam through a
// directory import node's --experimental-strip-types runner cannot resolve, so a
// direct import would make this module — and the policy with it — untestable
// under `pnpm run test`. The seam is also the honest shape: which members exist
// and who observed activity is not something the liveness policy should know.

/** One member the sweep considers, as the host sees it right now. The `runId` is
 *  what the `liveness` switch is keyed on (each run carries its own frozen
 *  flags, #118) — the same per-run rule #117's wake sweep follows. */
export interface LivenessMember {
  reader: string;
  coordinator: string | null;
  hasTask: boolean;
  lastActivityAt: number | undefined;
  running: boolean;
  /** App-level parked signal (needs-input `waiting` status). #119's bus-level
   *  `waiting` is layered on top via {@link setLivenessWaiting}, so this stays
   *  the app half and the two OR together in the sweep. */
  waiting: boolean;
  runId: string;
}

let readMembers: () => LivenessMember[] = () => [];

/** Wired at boot (index.ts) with the real store, and by rigs with a fixture. */
export function setLivenessRoster(fn: () => LivenessMember[]): void {
  readMembers = fn;
}

// ─── #119's `waiting` surface — CONSUMED, never reimplemented ────────────────
//
// SEAM (ledger #125 §Seams): #119 owns the `waiting` concept (an asker parked on
// an open ask/gate) and the wake-predicate edit. #120 MUST NOT reimplement it.
// #119 exposes the set of readers currently parked as an asker; this module
// subtracts them from its escalation candidates. Injected so #120 builds and
// tests before #119 lands: the default returns an empty set (nobody bus-waiting),
// which is the coexistence-safe direction — it never SUPPRESSES an escalation the
// app-level `waiting` did not already cover, so a missing #119 cannot hide a real
// stall.
//
// SIGNATURE FROZEN to #119's actual export (Q-C1 confirmed on ledger #125, read
// off `origin/bus-asks-gates-119` src/main/bus-wake.ts before rebase):
//   readWaitingReaders(db, readers: {reader, runId}[]): Set<string>
// It returns the SENDER/OPENER side — a reader that AUTHORED an open ask or
// OPENED an unresolved gate (waiting for an answer), which is exactly the "asker
// in waiting" #120 excludes from staleness (NOT the recipient, who is woken by
// #119's predicate). At rebase this seam is wired to that export verbatim, with
// no shape change: the sweep already passes `{reader, runId}` pairs below.

/** The pair #119's `readWaitingReaders` consumes — the same shape its wake
 *  predicate uses ({reader, runId}), so the run-scoping is preserved. */
export interface WaitingReaderKey {
  reader: string;
  runId: string;
}

let readBusWaiting: (db: BusDb, readers: readonly WaitingReaderKey[]) => Set<string> = () =>
  new Set<string>();

/** Wire in #119's asker-`waiting` accessor (`readWaitingReaders`) or a rig's. */
export function setLivenessWaiting(
  fn: (db: BusDb, readers: readonly WaitingReaderKey[]) => Set<string>,
): void {
  readBusWaiting = fn;
}

// ─── The switch seam (#118 owns the storage; this module only READS) ─────────
//
// Standing ruling: a switch-gated mechanism is COUNTED, not fired, while its
// switch is OFF, and switches are read at wave start and FROZEN PER RUN. Read
// PER SWEEP, keyed on the run the member belongs to — never a process-wide
// cache (#117's ledger #123 Q1: run A OFF and run B ON is the normal steady
// state of a fleet mid-wave, and one boolean cannot answer for both). The
// default reader is `busSwitch(db, runId, 'liveness')`; a rig may override it.

export type LivenessSwitchReader = (runId: string) => boolean;

let readLivenessSwitch: LivenessSwitchReader | null = null;

/** Override the switch accessor (rig seam). Production reads `busSwitch` off the
 *  live bus per sweep — see {@link sweepBusLiveness}. */
export function setLivenessSwitchReader(fn: LivenessSwitchReader | null): void {
  readLivenessSwitch = fn;
}

// ─── Shadow counters ─────────────────────────────────────────────────────────

export interface BusLivenessCounters {
  /** Escalation rows actually written. */
  fired: number;
  /** Would-have-escalated, suppressed because the switch is OFF (the shadow
   *  signal — COUNTED, not fired). */
  counted: number;
  /** `status` rows written by the phase half (the note-change chokepoint). */
  phaseRows: number;
  /** Phase changes seen while the switch was OFF — the shadow signal for the
   *  phase half (COUNTED, not fired). */
  countedPhase: number;
}

const counters: BusLivenessCounters = { fired: 0, counted: 0, phaseRows: 0, countedPhase: 0 };

export function busLivenessCounters(): BusLivenessCounters {
  return { ...counters };
}

/** The dedup ledger: member handle → the activity high-water we escalated at.
 *  Presence IS the dedup (one escalation per silence). */
const ledger = new Map<string, EscalationLedgerEntry>();

// ─── The sweep ─────────────────────────────────────────────────────────────

/** Where the sweep gets its connection. Defaults to the boot bus; a rig points
 *  it at a temp file so the sweep runs without an Electron main, and so the D1
 *  `null` arm is exercised on purpose. */
let readBusDb: () => BusDb | null = getBus;

export function __setBusReaderForTests(fn: () => BusDb | null): void {
  readBusDb = fn;
}

/** Injected clock so a rig can advance a member past STALE_AFTER_MS without
 *  sleeping (acceptance 1's "fake activity clock"). Production is `Date.now`. */
let nowFn: () => number = () => Date.now();

export function __setNowForTests(fn: () => number): void {
  nowFn = fn;
}

let started = false;
let sweeping = false;

/**
 * One level-triggered pass: read members, decide per member, escalate or count.
 *
 * Re-entrancy guarded (the timer could land while a prior sweep's `send` is in
 * flight): two concurrent sweeps would each read the ledger before either wrote
 * it, the read-modify-write-across-a-yield that #57 measured losing an entry.
 * The guard makes the ledger single-writer.
 */
export function sweepBusLiveness(): void {
  if (sweeping) return;
  const db = readBusDb();
  if (!db) {
    // D1: no bus is not an error and must not throw into the host path. Nothing
    // is lost — the next sweep re-reads host-observed state.
    return;
  }
  if (!started) return; // startBusLiveness() has not run
  sweeping = true;
  try {
    const members = readMembers();
    const now = nowFn();
    // #119's bus-`waiting` set, ORed with each member's app-level `waiting`.
    let busWaiting: ReadonlySet<string> = new Set<string>();
    try {
      // Pass {reader, runId} pairs — #119's readWaitingReaders is run-scoped, so
      // a bare-handle list would collapse a handle that exists in two runs.
      busWaiting = readBusWaiting(
        db,
        members.map((m) => ({ reader: m.reader, runId: m.runId })),
      );
    } catch (e) {
      // A failing #119 accessor must not take the whole sweep down or SUPPRESS
      // an escalation. Empty set = "nobody bus-waiting", the safe direction: the
      // app-level `waiting` still excludes needs-input members.
      log.warn('bus-liveness: waiting accessor failed — treating as none', e);
    }

    // First pass: who is stale THIS tick (for the ledger prune / re-arm). Stale
    // = the decision would escalate-or-count. Computed independent of the switch
    // so a member re-arms whether the mechanism fired or only counted.
    const stale = new Set<string>();
    for (const m of members) {
      const state: MemberLivenessState = {
        reader: m.reader,
        coordinator: m.coordinator,
        hasTask: m.hasTask,
        lastActivityAt: m.lastActivityAt,
        appStartedAt: 0, // floored by caller below; not used when lastActivityAt set
        running: m.running,
        waiting: m.waiting || busWaiting.has(m.reader),
      };
      // Use the member's real activity floor: undefined clock → app-start, which
      // the roster provides via lastActivityAt already (index.ts floors it), so
      // appStartedAt is only the belt-and-braces default. Decide with no ledger
      // to learn staleness, then again with the ledger to get the action.
      const probe = decideEscalation(state, undefined, now, false);
      if (probe.kind !== 'skip') stale.add(m.reader);
    }
    pruneEscalationLedger(ledger, stale);

    for (const m of members) {
      const state: MemberLivenessState = {
        reader: m.reader,
        coordinator: m.coordinator,
        hasTask: m.hasTask,
        lastActivityAt: m.lastActivityAt,
        appStartedAt: 0,
        running: m.running,
        waiting: m.waiting || busWaiting.has(m.reader),
      };
      // PER SWEEP, PER RUN — never a process-wide cache. The safe direction on an
      // unreadable flag is OFF (counted, never fired), and it must not take the
      // sweep down for other members.
      let switchOn = false;
      try {
        switchOn = readLivenessSwitch
          ? readLivenessSwitch(m.runId)
          : busSwitch(db, m.runId, 'liveness');
      } catch (e) {
        log.warn(`bus-liveness: switch read failed for ${m.reader} — treating as OFF`, e);
      }
      const action = decideEscalation(state, ledger.get(m.reader), now, switchOn);
      if (action.kind === 'skip') continue;
      // Mark BEFORE the write, not after: even though `send` is synchronous, the
      // ledger is what makes "one per silence" hold across the whole loop — set
      // it the instant we decide to act (the #112/#57 shape, kept for safety if
      // the write ever becomes async).
      ledger.set(action.reader, { escalatedAtActivity: m.lastActivityAt });
      if (action.kind === 'count') {
        counters.counted++;
        log.info(
          `bus-liveness: would have escalated ${action.reader} → ${action.coordinator} ` +
            `(silent ${Math.floor(action.silentForMs / 60_000)}m; switch OFF — counted, not fired)`,
        );
        continue;
      }
      // FIRED: write an escalation row to the coordinator. A failed write must be
      // observable (D1) and must WITHDRAW the ledger mark so the next sweep
      // retries — leaving the mark would suppress every future escalation for
      // this silence.
      const wrote = writeEscalation(db, m.runId, action.reader, action.coordinator, action.silentForMs);
      if (wrote) {
        counters.fired++;
        log.info(
          `bus-liveness: escalated ${action.reader} → ${action.coordinator} ` +
            `(silent ${Math.floor(action.silentForMs / 60_000)}m)`,
        );
      } else {
        ledger.delete(action.reader);
      }
    }
  } catch (e) {
    log.warn('bus-liveness: sweep failed', e);
  } finally {
    sweeping = false;
  }
}

/** Write ONE `escalation` message row to `coordinator` about `reader`. Reuses the
 *  existing `escalation` kind and the existing `send` verb — no migration, no new
 *  probe. Returns false (never throws) on a bus failure so the sweep can withdraw
 *  the dedup mark and retry (D1). */
function writeEscalation(
  db: BusDb,
  runId: string,
  reader: string,
  coordinator: string,
  silentForMs: number,
): boolean {
  try {
    send(db, {
      runId,
      sender: reader,
      recipient: coordinator,
      kind: 'escalation',
      body: escalationBody(reader, silentForMs),
    });
    return true;
  } catch (e) {
    // D1: a bus write failure LOGS ONCE and returns — never a throw into the
    // sweep, which is on a host timer.
    log.warn(`bus-liveness: failed to write escalation for ${reader} → ${coordinator}`, e);
    return false;
  }
}

// ─── The phase half — a `status` row on every NOTE CHANGE ────────────────────
//
// Called from `dispatchStatusRequest` (workspaces.ts), the ONE chokepoint every
// `orchestra status` write crosses (CLI verb + SDK local-command both land
// there). NO timer: phase is event-driven off the note write. The CHANGE guard
// lives at the call site (compare new text vs `ws.statusText`), so an unchanged
// re-set writes zero rows (acceptance 3, positive control). This function is
// only reached on a genuine change.

/**
 * Write a `status` message row recording a member's new phase note. Tolerates
 * `getBus() === null` (D1): logs once and returns, never throwing into the
 * status write's host path (a phase row must never break `orchestra status`).
 *
 * `text === ''` records a CLEARED note (the member went from a phase to none),
 * which is a real transition worth a row; the caller still gates on
 * text-vs-previous so an unchanged clear (already empty → clear) writes nothing.
 *
 * SWITCH-GATED like the escalation half (C5, coexistence): while the `liveness`
 * switch is OFF for the run, this COUNTS a would-have-written row but writes
 * nothing — the old channel (the store's `statusText` broadcast, untouched)
 * stays authoritative. Only when the switch is ON does the `status` row land.
 */
export function recordPhaseChange(runId: string, reader: string, text: string): void {
  const db = readBusDb();
  if (!db) {
    log.warn(`bus-liveness: no bus — phase change for ${reader} not recorded`);
    return;
  }
  let switchOn = false;
  try {
    switchOn = readLivenessSwitch ? readLivenessSwitch(runId) : busSwitch(db, runId, 'liveness');
  } catch (e) {
    log.warn(`bus-liveness: switch read failed for ${reader} phase — treating as OFF`, e);
  }
  if (!switchOn) {
    // COUNTED, not FIRED: the shadow signal, no row written.
    counters.countedPhase++;
    return;
  }
  try {
    send(db, {
      runId,
      sender: reader,
      recipient: null,
      kind: 'status',
      body: text,
    });
    counters.phaseRows++;
  } catch (e) {
    log.warn(`bus-liveness: failed to write status row for ${reader}`, e);
  }
}

// ─── Lifecycle ─────────────────────────────────────────────────────────────

let timer: ReturnType<typeof setInterval> | null = null;

/** Start the liveness sweep (idempotent). Ships OFF: the `liveness` switch
 *  (#118) defaults false, so out of the box this only COUNTS would-have-escalated
 *  (coexistence — old channels stay authoritative). */
export function startBusLiveness(): void {
  if (timer) return;
  started = true;
  let defaultOn = false;
  try {
    const db = readBusDb();
    defaultOn = db ? busSwitch(db, 'default', 'liveness') : false;
  } catch {
    /* an unreadable switch is OFF — the sweep logs its own warning */
  }
  log.info(
    `bus-liveness: started (switch ${defaultOn ? 'ON — escalating' : 'OFF — counting only'})`,
  );
  // Run once immediately so a restart reconciles who is already stale, then on
  // the interval. Unref'd so it never holds the process open.
  sweepBusLiveness();
  timer = setInterval(() => sweepBusLiveness(), SWEEP_MS);
  timer.unref();
}

export function stopBusLiveness(): void {
  if (timer) {
    clearInterval(timer);
    timer = null;
  }
  started = false;
}

/** Test/rig seam: clear the dedup ledger, counters and injected seams so a rig
 *  drives from a known baseline instead of inheriting a previous test's marks. */
export function __resetBusLivenessForTests(): void {
  ledger.clear();
  counters.fired = 0;
  counters.counted = 0;
  counters.phaseRows = 0;
  counters.countedPhase = 0;
  started = false;
  sweeping = false;
  readMembers = () => [];
  readBusWaiting = () => new Set<string>();
  readLivenessSwitch = null;
  readBusDb = getBus;
  nowFn = () => Date.now();
}

/** Rig seam: arm the sweep WITHOUT starting the timer. `startBusLiveness()` is
 *  the production path; a unit rig wants no timer but the same per-run switch
 *  read that ships — so it drives `sweepBusLiveness()` directly after this. */
export function __armForTests(): void {
  started = true;
}

/** Exposed for the phase-half rig: the STALE_AFTER_MS the policy uses. */
export { STALE_AFTER_MS };
