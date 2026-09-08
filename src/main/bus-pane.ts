// Main-process data layer for the READ-ONLY bus pane (#118, ledger #123).
//
// TWO INVARIANTS, both gated:
//
//   1. READ-ONLY IN v1 (T118.4). Every IPC handler registered here is a read.
//      Gate resolution from the UI is v2. The enumeration the ticket asks for
//      is not a comment — `BUS_PANE_IPC_CHANNELS` below is the literal list the
//      registrar iterates AND the list the test enumerates, so a handler that
//      is not in it cannot be registered, and one that writes cannot hide.
//
//   2. `getBus() === null` IS NORMAL (D1, C8). The bus opens AFTER the window
//      and may fail; every function here returns an `available: false` snapshot
//      instead of throwing. A throw would cross the IPC boundary as a rejected
//      invoke and blank the pane — the exact failure T118.5 forbids.

import { ipcMain } from 'electron';
import { getBus, busPath, type BusDb } from './bus.ts';
import { listRuns } from './bus-runs.ts';
import { getLiveSwitches } from './bus-settings.ts';
import {
  type BusSnapshot,
  type BusDivergenceReportView,
  type BusMessageView,
  type BusGateView,
  type BusMemberLiveness,
  type BusDivergenceCounter,
  type BusRunSummary,
  unavailableSnapshot,
} from '../shared/bus-view.ts';
import { scoped } from './logger.ts';

const log = scoped('bus-pane');

/**
 * THE ENUMERATION (T118.4). Every channel the pane may use, with the assertion
 * that it is a read.
 *
 * `writes: false` on every entry is not decoration — `registerBusPaneIpc`
 * REFUSES to register an entry marked `writes: true`, so the day someone adds a
 * write handler for v2 they must change this table, and the test that asserts
 * "every entry reads" turns red at the same moment. A comment saying "these are
 * all reads" would not.
 */
export const BUS_PANE_IPC_CHANNELS: ReadonlyArray<{
  channel: string;
  writes: boolean;
  what: string;
}> = [
  { channel: 'bus:snapshot', writes: false, what: 'read the whole pane projection for a run' },
  { channel: 'bus:listRuns', writes: false, what: 'read the mission → wave tree' },
  { channel: 'bus:switches', writes: false, what: 'read the LIVE switch values' },
];

/** Open a short-lived READ-ONLY view of the boot connection, or null. */
function db(): BusDb | null {
  return getBus();
}

function toMessage(row: Record<string, unknown>): BusMessageView {
  return {
    sequence: Number(row.sequence),
    runId: String(row.run_id),
    threadId: (row.thread_id as string | null) ?? null,
    sender: String(row.sender),
    recipient: (row.recipient as string | null) ?? null,
    kind: String(row.kind),
    body: String(row.body),
    createdAt: Number(row.created_at),
  };
}

function toGate(row: Record<string, unknown>): BusGateView {
  return {
    id: Number(row.id),
    runId: String(row.run_id),
    askedBy: String(row.asked_by),
    question: String(row.question),
    openedAt: Number(row.opened_at),
    resolution: (row.resolution as string | null) ?? null,
    resolvedBy: (row.resolved_by as string | null) ?? null,
    resolvedAt: (row.resolved_at as number | null) ?? null,
  };
}

/**
 * Liveness + pending lots per member, derived from the bus itself.
 *
 * A "member" is anyone who has SENT or been handed a lot in this run — derived,
 * not registered, so a member cannot be present in the fleet and absent from
 * the pane because nobody remembered to announce it. `phase` is the kind of the
 * member's most recent message, which is the only phase signal that exists on
 * the bus in v1 (a dedicated phase column is a later ticket's).
 */
function readMembers(d: BusDb, runId: string): BusMemberLiveness[] {
  const rows = d
    .prepare(
      `SELECT sender AS handle,
              MAX(created_at) AS last_seen,
              (SELECT kind FROM messages m2
                WHERE m2.run_id = m.run_id AND m2.sender = m.sender
                ORDER BY m2.sequence DESC LIMIT 1) AS phase
         FROM messages m
        WHERE run_id = ?
        GROUP BY sender
        ORDER BY sender`,
    )
    .all(runId) as { handle: string; last_seen: number; phase: string | null }[];

  const pending = d
    .prepare(
      `SELECT id, reader, from_seq, to_seq FROM deliveries
        WHERE run_id = ? AND acked_at IS NULL`,
    )
    .all(runId) as { id: number; reader: string; from_seq: number; to_seq: number }[];
  const countIn = d.prepare(
    'SELECT COUNT(*) AS n FROM messages WHERE run_id=? AND sequence>? AND sequence<=?',
  );
  const byReader = new Map<string, { id: number; n: number }>();
  for (const p of pending) {
    const n = Number((countIn.get(runId, p.from_seq, p.to_seq) as { n: number }).n);
    byReader.set(p.reader, { id: p.id, n });
  }

  const members: BusMemberLiveness[] = rows.map((r) => ({
    handle: r.handle,
    phase: r.phase ?? null,
    lastSeenAt: r.last_seen ?? null,
    pendingLotId: byReader.get(r.handle)?.id ?? null,
    pendingCount: byReader.get(r.handle)?.n ?? 0,
  }));
  // A reader with an outstanding lot but no message of its own is still a
  // member — and it is the MOST interesting one (a reader that has been handed
  // work and said nothing). Deriving members from senders alone would drop
  // exactly that row.
  for (const [reader, p] of byReader) {
    if (!members.some((m) => m.handle === reader)) {
      members.push({
        handle: reader,
        phase: null,
        lastSeenAt: null,
        pendingLotId: p.id,
        pendingCount: p.n,
      });
    }
  }
  return members.sort((a, b) => a.handle.localeCompare(b.handle));
}

let counterSourceWarned = false;

/**
 * Read #116's divergence report, or `null` when no source is registered.
 *
 * WHY A RUNTIME SEAM AND NOT A STATIC IMPORT: #116 and #118 are parallel
 * tickets merging in that order. `import { busDivergenceReport } from
 * './bus-mirror'` would not compile until #116 lands, and "unbuildable until my
 * dependency merges" is how a wave serializes itself. #116 confirmed the symbol
 * (`busDivergenceReport()` in `src/main/bus-mirror.ts`, returning
 * `BusDivergenceReport` from `src/shared/bus-mirror.ts`) — verified by me at
 * `835eb757`, not taken on trust. At merge, replace this seam with the direct
 * import and delete the registrar; the SHAPE does not change.
 *
 * NULL vs EMPTY is the whole point of the return type. `null` means no source
 * answered; an empty-but-present report means the mirror answered and had
 * nothing to say. Collapsing the two is exactly the unaudited-instrument
 * failure (carry-forward 4) — and #116's own API never returns `[]` for a down
 * bus, precisely so the outage is COUNTED rather than lost.
 */
export function readDivergenceReport(runId: string): BusDivergenceReportView | null {
  const src = (globalThis as Record<string, unknown>).__orchestraBusCounters as
    | ((runId: string) => unknown)
    | undefined;
  if (typeof src !== 'function') {
    if (!counterSourceWarned) {
      counterSourceWarned = true;
      log.info(
        'bus-pane: no divergence-counter source registered (#116 not present) — the pane will SAY SO rather than show 0',
      );
    }
    return null;
  }
  try {
    const raw = src(runId) as Partial<BusDivergenceReportView> | BusDivergenceCounter[] | null;
    if (!raw) return null;
    // Accept BOTH the wrapper and a bare array. #116 ships the wrapper, but the
    // ledger froze the bare array, and a consumer that hard-fails on the shape
    // it did not expect would turn a contract nuance into a blank pane.
    if (Array.isArray(raw)) {
      return { runId, busAvailable: true, counters: raw };
    }
    return {
      runId: typeof raw.runId === 'string' ? raw.runId : runId,
      // Absent flag reads as AVAILABLE: only #116 can assert an outage, and
      // inventing `false` from a missing field would render a scary, unfounded
      // claim about the bus.
      busAvailable: raw.busAvailable !== false,
      counters: Array.isArray(raw.counters) ? raw.counters : [],
    };
  } catch (e) {
    log.error('bus-pane: divergence-counter source threw — rendering none', e);
    return null;
  }
}

/**
 * The seam #116 calls to publish its counters. Accepts the wrapper
 * (`BusDivergenceReport`) or the bare frozen array.
 */
export function registerBusCounterSource(
  fn: (runId: string) => BusDivergenceReportView | BusDivergenceCounter[],
): void {
  (globalThis as Record<string, unknown>).__orchestraBusCounters = fn;
}

/**
 * Assemble the pane snapshot. NEVER THROWS — a failure becomes an
 * `available: false` snapshot carrying the reason.
 */
export function busSnapshot(runId?: string | null): BusSnapshot {
  const live = getLiveSwitches();
  const d = db();
  if (!d) {
    return unavailableSnapshot(
      busPath(),
      'The fleet bus is not open. Orchestra started normally (the bus never blocks boot) — see the log for the open failure.',
      live,
    );
  }
  try {
    const runs: BusRunSummary[] = listRuns(d).map((r) => ({
      id: r.id,
      kind: r.kind,
      coordinator: r.coordinator,
      parentRunId: r.parent_run_id,
      title: r.title,
      createdAt: r.created_at,
      closedAt: r.closed_at,
      flags: r.flags,
    }));
    const selected = runId && runs.some((r) => r.id === runId) ? runId : (runs[0]?.id ?? null);
    if (!selected) {
      return {
        available: true,
        error: null,
        path: busPath(),
        liveSwitches: live,
        runs,
        selectedRunId: null,
        messages: [],
        gates: [],
        members: [],
        counters: [],
        countersBusAvailable: null,
      };
    }
    const report = readDivergenceReport(selected);
    const messages = (
      d
        .prepare('SELECT * FROM messages WHERE run_id=? ORDER BY sequence')
        .all(selected) as Record<string, unknown>[]
    ).map(toMessage);
    const gates = (
      d
        .prepare('SELECT * FROM decision_gates WHERE run_id=? ORDER BY opened_at, id')
        .all(selected) as Record<string, unknown>[]
    ).map(toGate);
    return {
      available: true,
      error: null,
      path: busPath(),
      liveSwitches: live,
      runs,
      selectedRunId: selected,
      messages,
      gates,
      members: readMembers(d, selected),
      counters: report?.counters ?? [],
      countersBusAvailable: report ? report.busAvailable : null,
    };
  } catch (e) {
    // A malformed/locked DB is "unavailable", not a crashed pane. Same D1
    // contract as a failed open — the pane must still render something the user
    // can act on.
    log.error('bus-pane: snapshot failed — rendering the unavailable state', e);
    return unavailableSnapshot(
      busPath(),
      e instanceof Error ? e.message : String(e),
      live,
    );
  }
}

/**
 * Register the pane's IPC. Every channel comes from BUS_PANE_IPC_CHANNELS and a
 * `writes: true` entry is REFUSED — the read-only invariant is enforced by the
 * registrar, not by reviewer attention.
 */
export function registerBusPaneIpc(): void {
  const writers = BUS_PANE_IPC_CHANNELS.filter((c) => c.writes);
  if (writers.length) {
    throw new Error(
      `bus-pane is READ-ONLY in v1 (#118 boundary): refusing to register write channel(s) ${writers
        .map((w) => w.channel)
        .join(', ')} — gate resolution from the UI is v2`,
    );
  }
  ipcMain.handle('bus:snapshot', (_e, runId?: string | null) => busSnapshot(runId ?? null));
  ipcMain.handle('bus:listRuns', () => busSnapshot(null).runs);
  ipcMain.handle('bus:switches', () => getLiveSwitches());
}
