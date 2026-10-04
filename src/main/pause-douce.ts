// Fleet PAUSE douce — the bus + host half (#254, wave E ledger #276 D3/D4). The state machine and roster shapes are the frozen
// interface (`src/shared/pause-lifecycle.ts`, `MIGRATIONS[10]`); the order text is `src/shared/pause-douce.ts`.
//
// `orchestra run pause` (no --hard) writes `paused_at` + `pause_mode='soft'` + `pause_deadline_at` (bus-pause.ts) — the existing gates
// refuse every AUTO start at once. THIS module is what the host does next, from the trap's sweep (`sweepPauseTrap`):
//   • enrol every member in `pause_members`;
//   • a member with a turn RUNNING gets a `kind='pause'` bus row + a one-shot order its tool-result hook injects (`pauseOrders`);
//     a member with NO turn running is confirmed by the host (`host-idle`, no wake);
//   • a member's `orchestra run confirm pause` records its accusé (`confirmMember`, `member`);
//   • all confirmed, or `pause_deadline_at` passed → `pause_escalated_at` is stamped and the #252 trap becomes owed
//     (`runsOwingPauseTrap` ← `trapOwed`); members the trap takes without an accusé are recorded `trap`.
// Switch `pause` OFF ⇒ `run pause` is refused ⇒ none of these columns/rows is ever written ⇒ nothing here runs.

import fs from 'node:fs';
import path from 'node:path';
import type { BusDb } from './bus.ts';
import { send } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { activePauseFor, runSubtreeIds, type RunPauseInfo } from './bus-pause.ts';
import { isCoordinatorHandle } from '../shared/bus-fencing.ts';
import { parseSwitches } from '../shared/bus-switches.ts';
import {
  pausePhaseOf,
  pauseRosterSummary,
  type CarrierPauseColumns,
  type PauseConfirmVia,
  type PauseMemberRow,
  type PausePhase,
} from '../shared/pause-lifecycle.ts';
import { renderPauseOrder, softDeadlineAt, type PauseStatusView } from '../shared/pause-douce.ts';
import type { TrapDeps, TrapMember } from './pause-trap.ts';
import { log } from './logger.ts';

/** Where the host drops a member's pause order for its tool-result hook (production: pause-trap-host.ts). `write` replaces, `remove` is idempotent. */
export interface PauseOrderDeps {
  write(wsId: string, text: string): void;
  remove(wsId: string): void;
  /** Drop every undelivered order whose member is NOT in `keep` (a lifted / escalated / confirmed pause leaves none behind). */
  prune(keep: ReadonlySet<string>): void;
}

/** The order files: `<dir>/<ws>.json` holds the order as ONE JSON string literal (spliced as-is into the hook's `additionalContext`);
 *  the tool-result hook `mv`s it to `<ws>.taken` (once-only), and that rename's ctime is the delivery time ({@link deliveredAt}). */
export function pauseOrderFiles(dir: string): PauseOrderDeps & { deliveredAt(wsId: string): number | null } {
  const file = (ws: string): string => path.join(dir, `${ws}.json`);
  const safe = (ws: string): boolean => /^[A-Za-z0-9._-]+$/.test(ws) && !ws.startsWith('.');
  return {
    write(wsId, text) {
      if (!safe(wsId)) throw new Error(`pause order: refusing unsafe workspace id ${JSON.stringify(wsId)}`);
      fs.mkdirSync(dir, { recursive: true });
      fs.rmSync(path.join(dir, `${wsId}.taken`), { force: true }); // a previous epoch's delivery receipt
      const tmp = path.join(dir, `.${wsId}.tmp`);
      fs.writeFileSync(tmp, JSON.stringify(text));
      fs.renameSync(tmp, file(wsId)); // atomic: the hook never reads a torn order
    },
    remove(wsId) {
      if (safe(wsId)) fs.rmSync(file(wsId), { force: true });
    },
    prune(keep) {
      let names: string[];
      try {
        names = fs.readdirSync(dir);
      } catch {
        return; // no orders dir ⇒ nothing to prune
      }
      for (const n of names) if (n.endsWith('.json') && !keep.has(n.slice(0, -'.json'.length))) fs.rmSync(path.join(dir, n), { force: true });
    },
    deliveredAt(wsId) {
      try {
        return fs.statSync(path.join(dir, `${wsId}.taken`)).ctimeMs;
      } catch {
        return null;
      }
    },
  };
}

// ── carrier columns ─────────────────────────────────────────────────────────

const num = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));

export function readCarrierColumns(db: BusDb, runId: string): CarrierPauseColumns | null {
  const r = db
    .prepare(
      `SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at FROM runs WHERE id = ?`,
    )
    .get(runId) as Record<string, unknown> | undefined;
  if (!r) return null;
  return {
    pausedAt: num(r.paused_at),
    mode: r.pause_mode === 'soft' ? 'soft' : r.pause_mode === 'hard' ? 'hard' : null,
    deadlineAt: num(r.pause_deadline_at),
    escalatedAt: num(r.pause_escalated_at),
    trapAt: num(r.pause_trap_at),
    resumeStartedAt: num(r.resume_started_at),
  };
}

/** The phase of a carrier run (`active` for an unknown run). */
export function carrierPhase(db: BusDb, runId: string): PausePhase {
  const c = readCarrierColumns(db, runId);
  return c ? pausePhaseOf(c) : 'active';
}

// ── roster (`pause_members`) ────────────────────────────────────────────────

interface RawMember {
  run_id: string;
  paused_at: number;
  ws_id: string;
  role: string;
  member_run: string | null;
  pause_confirmed_at: number | null;
  pause_confirm_via: string | null;
  released_at: number | null;
  released_by: string | null;
  reprise_confirmed_at: number | null;
}

function toMemberRow(r: RawMember): PauseMemberRow {
  return {
    runId: r.run_id,
    pausedAt: Number(r.paused_at),
    wsId: r.ws_id,
    role: r.role === 'coordinator' ? 'coordinator' : 'worker',
    memberRun: r.member_run,
    pauseConfirmedAt: num(r.pause_confirmed_at),
    pauseConfirmVia:
      r.pause_confirm_via === 'member' || r.pause_confirm_via === 'host-idle' || r.pause_confirm_via === 'trap'
        ? r.pause_confirm_via
        : null,
    releasedAt: num(r.released_at),
    releasedBy: r.released_by,
    repriseConfirmedAt: num(r.reprise_confirmed_at),
  };
}

/** The roster of one pause epoch, in enrolment order. */
export function listRoster(db: BusDb, carrierRunId: string, pausedAt: number): PauseMemberRow[] {
  return (
    db
      .prepare('SELECT * FROM pause_members WHERE run_id = ? AND paused_at = ? ORDER BY rowid')
      .all(carrierRunId, pausedAt) as RawMember[]
  ).map(toMemberRow);
}

/** A coordinator = the workspace the run row names as its coordinator; everyone else in the paused subtree is a worker. */
export function memberRole(db: BusDb, wsId: string, memberRun: string | null): 'coordinator' | 'worker' {
  const run = memberRun ? getRun(db, memberRun) : null;
  return run && isCoordinatorHandle(run.coordinator, wsId) ? 'coordinator' : 'worker';
}

export interface MemberIdentity {
  wsId: string;
  /** The member's own run (its nearest orchestrator) — whose coordinator releases it at Reprise. */
  memberRun: string | null;
}

/** Upsert a member's roster row (role / member_run only — never touches the accusé or the release columns). Whoever writes first (host or CLI) creates it.
 *  A caller that does not know the member's run (`memberRun` null: the CLI with no readable store) creates a worker row but NEVER overwrites a known role/run. */
export function enrollMember(db: BusDb, carrierRunId: string, pausedAt: number, m: MemberIdentity): void {
  if (m.memberRun === null) {
    db.prepare(`INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) VALUES (?,?,?,?,NULL) ON CONFLICT(run_id, paused_at, ws_id) DO NOTHING`).run(
      carrierRunId,
      pausedAt,
      m.wsId,
      'worker',
    );
    return;
  }
  db.prepare(
    `INSERT INTO pause_members (run_id, paused_at, ws_id, role, member_run) VALUES (?,?,?,?,?)
     ON CONFLICT(run_id, paused_at, ws_id) DO UPDATE SET role = excluded.role, member_run = excluded.member_run
       WHERE role IS NOT excluded.role OR member_run IS NOT excluded.member_run`, // no-op when unchanged: a write would re-trigger the bus-dir watcher → sweep → write …
  ).run(carrierRunId, pausedAt, m.wsId, memberRole(db, m.wsId, m.memberRun), m.memberRun);
}

/** The ACTIVE pause whose roster holds `wsId` (newest epoch first) — the CLI's fallback when it cannot read the app's store to walk the live tree. */
export function carrierFromRoster(db: BusDb, wsId: string): RunPauseInfo | null {
  const rs = db.prepare('SELECT run_id FROM pause_members WHERE ws_id = ? ORDER BY paused_at DESC LIMIT 20').all(wsId) as Array<{ run_id: string }>;
  for (const r of rs) {
    const hit = activePauseFor(db, r.run_id);
    if (hit && hit.runId === r.run_id) return hit;
  }
  return null;
}

/** Record a member's PAUSE accusé (`via`). First writer wins: a later confirmation never overwrites the time/via. true = this call wrote it. */
export function confirmMember(
  db: BusDb,
  carrierRunId: string,
  pausedAt: number,
  m: MemberIdentity,
  via: PauseConfirmVia,
  now: number,
): boolean {
  enrollMember(db, carrierRunId, pausedAt, m);
  return (
    db
      .prepare(
        `UPDATE pause_members SET pause_confirmed_at = ?, pause_confirm_via = ?
          WHERE run_id = ? AND paused_at = ? AND ws_id = ? AND pause_confirmed_at IS NULL`,
      )
      .run(now, via, carrierRunId, pausedAt, m.wsId).changes > 0
  );
}

/** Stamp the escalation (guarded on the epoch, the soft mode and "still waiting"). true = this call escalated. */
export function escalateSoftPause(db: BusDb, carrierRunId: string, pausedAt: number, now: number): boolean {
  return (
    db
      .prepare(
        `UPDATE runs SET pause_escalated_at = ?
          WHERE id = ? AND paused_at = ? AND pause_mode = 'soft' AND pause_escalated_at IS NULL AND pause_trap_at IS NULL AND resume_started_at IS NULL`,
      )
      .run(now, carrierRunId, pausedAt).changes > 0
  );
}

// ── the trap's side of the roster (hard pauses and douce stragglers) ────────

/** The trap enumerated the members: make sure each has a roster row (a hard pause has no douce sweep). */
export function enrollRoster(db: BusDb, carrier: { runId: string; pausedAt: number }, members: readonly TrapMember[]): void {
  for (const m of members) enrollMember(db, carrier.runId, carrier.pausedAt, { wsId: m.wsId, memberRun: m.runId });
}

/** The trap took this member (snapshot + Bilan + interrupt + kill complete): it is paused, whether or not it ever confirmed. */
export function confirmByTrap(db: BusDb, carrier: { runId: string; pausedAt: number }, m: TrapMember, now: number): void {
  confirmMember(db, carrier.runId, carrier.pausedAt, { wsId: m.wsId, memberRun: m.runId }, 'trap', now);
}

// ── the host sweep ──────────────────────────────────────────────────────────

export interface DouceSummary {
  carrier: string;
  pausedAt: number;
  members: number;
  confirmed: number;
  /** Members sent a pause row this sweep. */
  notified: number;
  escalated: 'all-confirmed' | 'deadline' | null;
  /** Members still waited on (unconfirmed) — their orders are the only ones worth keeping. */
  pending: string[];
}

/** Carriers in a Pause douce that is still WAITING: soft, switch ON, not escalated, trap not done, not resuming. */
export function softPausingCarriers(db: BusDb): RunPauseInfo[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.paused_at, r.paused_by, r.pause_deadline_at, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.paused_at IS NOT NULL AND r.pause_mode = 'soft' AND r.pause_escalated_at IS NULL
          AND r.pause_trap_at IS NULL AND r.resume_started_at IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  return rows
    .filter((r) => parseSwitches((r.flags_json as string | null | undefined) ?? null).pause === true)
    .map((r) => ({
      runId: String(r.id),
      pausedAt: Number(r.paused_at),
      pausedBy: (r.paused_by as string | null) ?? null,
      mode: 'soft',
      trapAt: null,
      deadlineAt: num(r.pause_deadline_at),
      escalatedAt: null,
    }));
}

/** A workspace archived/deleted mid-pause leaves an unconfirmed roster row nobody will ever confirm ("manquent : <id>" for ever): drop the rows of THIS epoch that are
 *  not in the current enumeration and never confirmed (a confirmed row is history the Reprise may need). Guarded by the caller on a loaded store + ≥ 1 member. */
function dropVanishedMembers(db: BusDb, c: RunPauseInfo, members: readonly TrapMember[]): void {
  const keep = new Set(members.map((m) => m.wsId));
  for (const r of listRoster(db, c.runId, c.pausedAt)) {
    if (r.pauseConfirmedAt === null && !keep.has(r.wsId)) {
      db.prepare('DELETE FROM pause_members WHERE run_id = ? AND paused_at = ? AND ws_id = ? AND pause_confirmed_at IS NULL').run(c.runId, c.pausedAt, r.wsId);
    }
  }
}

const inflight = new Set<string>();
const warned = new Set<string>();
function warnOnce(key: string, msg: string, err?: unknown): void {
  if (warned.has(key)) return;
  warned.add(key);
  log.warn(msg, err);
}

/** Was this member already sent its pause row for this epoch? (the row IS the dedupe — nothing else records "notified"). */
function orderSent(db: BusDb, m: TrapMember, pausedAt: number): boolean {
  return (
    db
      .prepare(
        `SELECT 1 FROM messages WHERE run_id = ? AND kind = 'pause' AND sender = 'host' AND recipient = ? AND created_at >= ? LIMIT 1`,
      )
      .get(m.runId, m.wsId, pausedAt) !== undefined
  );
}

/** Is THIS pause epoch still a douce that is waiting (not lifted, not escalated, not resuming)? */
function stillWaiting(db: BusDb, c: RunPauseInfo): boolean {
  const cols = readCarrierColumns(db, c.runId);
  return cols !== null && cols.pausedAt === c.pausedAt && pausePhaseOf(cols) === 'pausing';
}

async function douceStep(deps: TrapDeps, db: BusDb, c: RunPauseInfo): Promise<{ sum: DouceSummary; dueAt: number | null }> {
  const now = deps.now();
  const deadline = c.deadlineAt ?? softDeadlineAt(c.pausedAt);
  const sum: DouceSummary = { carrier: c.runId, pausedAt: c.pausedAt, members: 0, confirmed: 0, notified: 0, escalated: null, pending: [] };
  const ready = deps.storeReady ? deps.storeReady() : true; // UNKNOWN is not NONE: an unloaded store enumerates no members — never read that as "all confirmed"
  const members = ready ? deps.members(runSubtreeIds(db, c.runId), c.runId) : [];
  sum.members = members.length;
  for (const m of members) enrollMember(db, c.runId, c.pausedAt, { wsId: m.wsId, memberRun: m.runId });
  if (ready && members.length > 0) dropVanishedMembers(db, c, members);
  const confirmedNow = (): Set<string> =>
    new Set(listRoster(db, c.runId, c.pausedAt).filter((r) => r.pauseConfirmedAt !== null).map((r) => r.wsId));
  let done = confirmedNow();
  for (const m of members) {
    if (done.has(m.wsId)) continue;
    // A sandbox member has no turn the host can reach or wait on: the gate refuses its starts, the trap records it as not applicable.
    if (m.remote) {
      confirmMember(db, c.runId, c.pausedAt, { wsId: m.wsId, memberRun: m.runId }, 'host-idle', now);
      continue;
    }
    let running = true; // UNKNOWN is not NONE: an unreadable activity is treated as running (send the order), never as idle
    try {
      const act = await deps.activityOf(m);
      running = act.turnRunning || act.unknown === true;
    } catch (e) {
      warnOnce(`${c.runId}@${c.pausedAt}:act:${m.wsId}`, `pause-douce: could not read ${m.wsId}'s activity — treating its turn as running`, e);
    }
    if (!running) {
      confirmMember(db, c.runId, c.pausedAt, { wsId: m.wsId, memberRun: m.runId }, 'host-idle', now);
      try {
        deps.pauseOrders?.remove(m.wsId);
      } catch {
        /* best effort */
      }
      continue;
    }
    try {
      // re-checked right before the write: a lift landing mid-step must not leave a stale order behind
      if (!orderSent(db, m, c.pausedAt) && stillWaiting(db, c)) {
        const text = renderPauseOrder({ carrierRunId: c.runId, deadlineAt: deadline });
        deps.pauseOrders?.write(m.wsId, text); // the order file first: a failed write is retried (nothing marks "sent" yet); the bus row is the dedupe
        send(db, { runId: m.runId, sender: 'host', kind: 'pause', recipient: m.wsId, body: text });
        sum.notified++;
      }
    } catch (e) {
      warnOnce(`${c.runId}@${c.pausedAt}:send:${m.wsId}`, `pause-douce: could not send ${m.wsId} its pause order — retried next sweep`, e);
    }
  }
  done = confirmedNow();
  sum.confirmed = members.filter((m) => done.has(m.wsId)).length;
  sum.pending = members.filter((m) => !done.has(m.wsId)).map((m) => m.wsId);
  const allConfirmed = members.length > 0 && sum.confirmed === members.length;
  if (allConfirmed || now >= deadline) {
    if (escalateSoftPause(db, c.runId, c.pausedAt, now)) {
      sum.escalated = allConfirmed ? 'all-confirmed' : 'deadline';
      log.info(`pause-douce: run ${c.runId} escalated (${sum.escalated}) — ${sum.confirmed}/${members.length} confirmed; the host trap is owed`);
    }
    sum.pending = []; // the douce stopped waiting: a still-undelivered order is stale (pruned by the sweep)
    return { sum, dueAt: null };
  }
  return { sum, dueAt: deadline };
}

/**
 * One pass over every Pause douce still waiting (see the file header). Returns the per-carrier summaries and the earliest deadline still
 * pending — the trap sweep arms a one-shot timer on it so the escalation lands AT the deadline, not up to a sweep period later.
 * Never throws: a carrier that throws is logged and retried on the next sweep.
 */
export async function sweepSoftPauses(deps: TrapDeps): Promise<{ summaries: DouceSummary[]; dueAt: number | null }> {
  const db = deps.getBus();
  if (!db) return { summaries: [], dueAt: null };
  let carriers: RunPauseInfo[];
  try {
    carriers = softPausingCarriers(db);
  } catch (e) {
    log.warn('pause-douce: could not read the pending Pauses douces', e);
    return { summaries: [], dueAt: null };
  }
  const summaries: DouceSummary[] = [];
  let dueAt: number | null = null;
  let complete = true; // false when a carrier was not fully read this pass: its pending set is unknown ⇒ never prune on it
  for (const c of carriers) {
    const key = `${c.runId}@${c.pausedAt}`;
    if (inflight.has(key)) {
      complete = false;
      dueAt = Math.min(dueAt ?? Infinity, c.deadlineAt ?? softDeadlineAt(c.pausedAt));
      continue;
    }
    inflight.add(key);
    try {
      const r = await douceStep(deps, db, c);
      summaries.push(r.sum);
      if (r.dueAt !== null) dueAt = Math.min(dueAt ?? Infinity, r.dueAt);
    } catch (e) {
      log.warn(`pause-douce: run ${c.runId} step failed — retried next sweep`, e);
      complete = false;
      dueAt = Math.min(dueAt ?? Infinity, c.deadlineAt ?? softDeadlineAt(c.pausedAt));
    } finally {
      inflight.delete(key);
    }
  }
  try {
    if (complete) deps.pauseOrders?.prune(new Set(summaries.flatMap((x) => x.pending)));
  } catch (e) {
    warnOnce('prune', 'pause-douce: could not prune stale pause orders', e);
  }
  return { summaries, dueAt };
}

export function __resetPauseDouceForTests(): void {
  inflight.clear();
  warned.clear();
}

// ── reads: bus-status / run status ──────────────────────────────────────────

/** The pause governing `runId` (its own or an ancestor's, run-row walk) with its roster summary — null when not paused. */
export function pauseStatusView(db: BusDb, runId: string): PauseStatusView | null {
  const hit = activePauseFor(db, runId);
  if (!hit) return null;
  const cols = readCarrierColumns(db, hit.runId);
  if (!cols) return null;
  const phase = pausePhaseOf(cols);
  const rows = listRoster(db, hit.runId, hit.pausedAt);
  return {
    carrierRunId: hit.runId,
    mode: cols.mode,
    phase,
    pausedAt: hit.pausedAt,
    pausedBy: hit.pausedBy,
    deadlineAt: cols.deadlineAt,
    escalatedAt: cols.escalatedAt,
    trapAt: cols.trapAt,
    summary: pauseRosterSummary(phase, rows),
    rows,
  };
}

// ── the member's accusé (`orchestra run confirm pause`) ─────────────────────

export type ConfirmPauseOutcome = 'confirmed' | 'already-confirmed' | 'not-paused';

/** Record the CALLER's pause accusé on `carrier` (resolved by the live-tree walk, like `run resume`) AND on every ancestor run that is itself in an active pause
 *  (a nested douce: the outer carrier enrolled the same member and would otherwise wait for it until its deadline). First writer wins. */
export function confirmPauseFor(
  db: BusDb,
  carrier: RunPauseInfo | null,
  who: MemberIdentity,
  now: number = Date.now(),
): { outcome: ConfirmPauseOutcome; view: PauseStatusView | null } {
  if (!carrier) return { outcome: 'not-paused', view: null };
  const wrote = confirmMember(db, carrier.runId, carrier.pausedAt, who, 'member', now);
  const seen = new Set<string>([carrier.runId]);
  let cur = (db.prepare('SELECT parent_run_id AS p FROM runs WHERE id = ?').get(carrier.runId) as { p: string | null } | undefined)?.p ?? null;
  while (cur && !seen.has(cur)) {
    seen.add(cur);
    const outer = activePauseFor(db, cur);
    if (outer && outer.runId === cur) confirmMember(db, outer.runId, outer.pausedAt, who, 'member', now);
    cur = (db.prepare('SELECT parent_run_id AS p FROM runs WHERE id = ?').get(cur) as { p: string | null } | undefined)?.p ?? null;
  }
  return { outcome: wrote ? 'confirmed' : 'already-confirmed', view: pauseStatusView(db, carrier.runId) };
}

/** The `pause` part of the `/busStatus` reply (hooks-server.ts and the rig's socket stand-in both call this): `{}` when `runId` is not paused,
 *  else the carrier view + a label per roster member (`labelOf` = the app's workspace name). */
export function busStatusPausePayload(
  db: BusDb,
  runId: string,
  labelOf: (wsId: string) => string | null,
): { pause?: PauseStatusView; pauseLabels?: Record<string, string> } {
  const pv = pauseStatusView(db, runId);
  if (!pv) return {};
  const labels: Record<string, string> = {};
  for (const r of pv.rows) {
    const l = labelOf(r.wsId);
    labels[r.wsId] = l ? `${l} (${r.wsId.slice(0, 8)})` : r.wsId;
  }
  return { pause: pv, pauseLabels: labels };
}
