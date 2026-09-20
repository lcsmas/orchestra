// Human-directed decision gates — the backend for the #161 app-UI ask surfaces.
//
// A `decision_gates` row (bus.ts, #119) with `recipient='human'` is a fleet
// question routed to the app's USER. `orchestra gate open --to human "<q>"`
// writes it; this module reads every OPEN human gate the fleet has, projects it
// into a `HumanGateView` the renderer renders (surface A: an inline row in the
// asking workspace; surface B: an aggregated "Asks" sidebar section), and
// resolves one from the UI.
//
// ── WHY THIS MIRRORS inbox-tray.ts BUT KEYS ON THE DB, NOT A FILE ────────────
// The inbox tray's source of truth is `~/.orchestra/inbox/<id>.txt`; a human
// gate's is the bus DB row. Keying on the DB gives two acceptance criteria for
// FREE: DURABLE-across-restart (the row survives; every read rebuilds from it)
// and BACKFILL==LIVE (#57 — the snapshot is reconstructed from the DB on every
// push, so a "live" render and one reconstructed after a restart are byte-
// identical). There is no in-memory gate state to drift.
//
// ── CHANGE DETECTION ────────────────────────────────────────────────────────
// Gates OPEN via the CLI (`orchestra gate open`), which writes the bus DB
// directly and bypasses the main process entirely — so main learns of a new gate
// the same way #149's wake accelerator does: an fs.watch on the bus DB DIRECTORY,
// filtered to the `-wal` basename (the WAL is what every write touches; watching
// the directory survives SQLite's WAL inode recycle — see bus-wake.ts). On any
// bus write we recompute the human-gate snapshot and broadcast it ONLY when it
// changed. A RESOLVE performed here broadcasts immediately (no watch latency for
// the user's own action). Startup reconciles once.

import fs from 'node:fs';
import path from 'node:path';
import { log } from './logger';
import { platform } from './platform';
import { store } from './store';
import {
  getBus,
  busPath,
  getGate,
  resolveGate,
  sendGateResolutionRewake,
  openGatesForRecipientAllRuns,
  type BusDb,
} from './bus.ts';
import {
  HUMAN_GATE_RECIPIENT,
  byOpenedAtAsc,
  type HumanGateView,
  type HumanGateResolveResult,
} from '../shared/human-gates.ts';

/** The wire payload the `human-gates:update` push carries — the whole open set,
 *  fleet-wide, rebuilt from the DB. A snapshot (not a delta) so it cannot drift
 *  the way an ordered event stream can (same reasoning as the queue snapshot). */
export interface HumanGatesSnapshot {
  gates: HumanGateView[];
}

/** A short label for the asker: the workspace's branch if we know it, else the
 *  handle itself (a gate from a run whose workspace is gone still names its
 *  asker). `asked_by` IS a workspace id (the CLI opens with `$ORCHESTRA_WS_ID`),
 *  so this is a direct store lookup — `run_id` is the WAVE ANCHOR, not the asker,
 *  and must never be used to identify the asking workspace. */
function projectGate(db: BusDb, row: {
  id: number;
  run_id: string;
  asked_by: string;
  question: string;
  opened_at: number;
}): HumanGateView {
  const ws = store.getWorkspace(row.asked_by);
  return {
    id: row.id,
    runId: row.run_id,
    askedBy: row.asked_by,
    askedByWorkspaceId: ws ? ws.id : null,
    askedByLabel: ws?.branch || ws?.name || row.asked_by,
    question: row.question,
    openedAt: row.opened_at,
  };
}

/** Every OPEN human gate across the whole fleet, oldest first. Empty when the
 *  bus is down (D1: `getBus()` may be null at any moment) — the coexistence-safe
 *  direction, matching every other bus read. */
export function readHumanGates(): HumanGateView[] {
  const db = getBus();
  if (!db) return [];
  try {
    return openGatesForRecipientAllRuns(db, HUMAN_GATE_RECIPIENT)
      .map((g) => projectGate(db, g))
      .sort(byOpenedAtAsc);
  } catch (e) {
    log.warn('human-gates: read failed', e);
    return [];
  }
}

// ── Broadcast, diffed ────────────────────────────────────────────────────────

/** The last snapshot we broadcast, as a stable JSON string, so the watcher can
 *  fire on every bus write (a `check` touches the WAL too) without re-pushing an
 *  unchanged set to every renderer. Reset to a sentinel so the FIRST call always
 *  publishes. */
let lastBroadcast = '\u0000never';

function snapshotKey(gates: HumanGateView[]): string {
  // Order is already oldest-first from readHumanGates; the projected label can
  // change (a workspace rename) so it is part of the key.
  return JSON.stringify(
    gates.map((g) => [g.id, g.askedByWorkspaceId, g.askedByLabel, g.question, g.openedAt]),
  );
}

/** Recompute the fleet human-gate snapshot and broadcast it IF it changed. Also
 *  mirrors a per-workspace open-gate count onto each Workspace record (#88
 *  pattern), so the sidebar's surface B can badge a workspace whose pane has
 *  never been opened (its renderer has no per-pane cache). */
export function broadcastHumanGates(): void {
  const gates = readHumanGates();
  const key = snapshotKey(gates);
  if (key === lastBroadcast) return;
  lastBroadcast = key;
  platform.broadcast('human-gates:update', { gates } satisfies HumanGatesSnapshot);
  void syncWorkspaceGateCounts(gates);
}

/** Force the next broadcast even if the set is unchanged (used right after a
 *  resolve, and by tests). */
export function invalidateHumanGatesBroadcast(): void {
  lastBroadcast = '\u0000never';
}

/** Bring every workspace's open-human-gate count in line with the snapshot.
 *  Only workspaces whose count MOVES are re-persisted (a full store flush per
 *  bus write would be far too costly — the watcher fires on every insert). The
 *  count is stored ABSENT rather than 0 for the common no-gate case. */
async function syncWorkspaceGateCounts(gates: HumanGateView[]): Promise<void> {
  const counts = new Map<string, number>();
  for (const g of gates) {
    if (g.askedByWorkspaceId) {
      counts.set(g.askedByWorkspaceId, (counts.get(g.askedByWorkspaceId) ?? 0) + 1);
    }
  }
  for (const ws of store.workspaces) {
    if (ws.archived) continue;
    const next = counts.get(ws.id) ?? 0;
    if ((ws.openHumanGateCount ?? 0) === next) continue;
    const updated = { ...ws, openHumanGateCount: next > 0 ? next : undefined };
    try {
      await store.upsertWorkspace(updated);
    } catch (e) {
      log.warn(`human-gates: could not persist gate count for ${ws.id}`, e);
      continue;
    }
    // Assigned explicitly (incl. to undefined): the renderer MERGES
    // workspace:update, and a merge cannot unset an absent key, so a dropped key
    // would leave a stale badge after the gate resolved.
    platform.broadcast('workspace:update', updated);
  }
}

// ── Resolve from the UI ──────────────────────────────────────────────────────

/**
 * Record the human's ruling on a gate and re-wake its asker (#161).
 *
 * `resolved_by='human'` is the audit trail the ticket requires. The re-wake is
 * the EXACT #158 path an agent resolve takes (shared `sendGateResolutionRewake`),
 * so a human answer reaches the asker identically to an agent answer. Resolve is
 * idempotent-by-refusal (bus.resolveGate returns false on an already-resolved
 * gate), so two windows racing to answer cannot overwrite each other — the second
 * gets `not-open` and the first ruling stands.
 */
export function resolveHumanGate(gateId: number, resolution: string): HumanGateResolveResult {
  const ruling = resolution.trim();
  if (!ruling) return { ok: false, reason: 'empty', gateId };
  const db = getBus();
  if (!db) return { ok: false, reason: 'no-bus', gateId };
  // Read BEFORE resolving so we have the asker + gate run for the re-wake reply
  // (asked_by / run_id are immutable once opened).
  const gateBefore = getGate(db, gateId);
  const ok = resolveGate(db, gateId, HUMAN_GATE_RECIPIENT, ruling);
  if (!ok) return { ok: false, reason: 'not-open', gateId };
  if (gateBefore) sendGateResolutionRewake(db, gateBefore, HUMAN_GATE_RECIPIENT, ruling);
  log.info(`human-gates: gate ${gateId} resolved by human — asker ${gateBefore?.asked_by ?? '?'} re-woken`);
  // The user's own action must reflect instantly — do not wait on the watch.
  invalidateHumanGatesBroadcast();
  broadcastHumanGates();
  return { ok: true, gateId };
}

// ── Watching the bus for new/resolved gates ──────────────────────────────────
//
// Mirrors bus-wake.ts's #149 accelerator: watch the DB DIRECTORY, filter the
// `-wal` basename, debounce. A directory watch survives SQLite's WAL inode
// recycle (an inode-pinned watch dies SILENTLY across a `-wal` unlink/recreate);
// the parent directory's inode is stable. A gate open (CLI) or resolve (agent)
// both write the WAL, so this catches both.

let watcher: fs.FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
const WATCH_DEBOUNCE_MS = 150;

/** Start broadcasting `human-gates:update` whenever the bus changes. Idempotent;
 *  best-effort (a platform without usable fs watching falls back to the resolve-
 *  time broadcast + the renderer's mount-time read). */
export function startHumanGatesWatcher(): void {
  if (watcher) return;
  const bus = busPath();
  const dir = path.dirname(bus);
  const walName = `${path.basename(bus)}-wal`;
  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => broadcastHumanGates(), WATCH_DEBOUNCE_MS);
    debounce.unref?.();
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_event, filename) => {
      // A null filename (platform-dependent) is treated as a match — a spurious
      // idempotent recompute is cheaper than a missed gate.
      if (filename && filename !== walName && filename !== path.basename(bus)) return;
      fire();
    });
  } catch (e) {
    log.warn('human-gates: could not watch the bus directory', e);
  }
}

export function stopHumanGatesWatcher(): void {
  if (debounce) clearTimeout(debounce);
  debounce = null;
  watcher?.close();
  watcher = null;
}

/** Reconcile at startup: publish the current set and repair per-workspace counts
 *  (gates may have opened/resolved via the CLI while the app was closed). */
export function reconcileHumanGates(): void {
  invalidateHumanGatesBroadcast();
  broadcastHumanGates();
}
