// Fleet PAUSE auto (#256, wave E ledger #276 D6) — the bus half. NO Electron import (like bus-pause.ts): the store, the usage pollers and
// the activity observer reach it through `PauseAutoDeps`; src/main/pause-auto-host.ts binds the real ones. Pure policy: src/shared/pause-auto.ts.
//
//  • `autoPauseOnLimit` — a structured member's usage-limit stop ⇒ Pause DURE of its run: the FIRST run walking up the live tree whose
//    FROZEN `pause` switch is ON, `runs.pause_auto` = PauseAutoReason (+epoch). Already governed by a pause: an AUTO one absorbs the member,
//    a MANUAL one (pause_auto NULL) is left exactly as it is. Switch OFF everywhere above the member ⇒ nothing is written.
//  • `evaluateAutoPaused` — per auto-paused run: every triggering member's CURRENT pinned account has quota (a fresh reading beats the stored
//    reset time) and the trap's Bilans exist ⇒ `beginReprise(db, run, 'host', {host:true, reason:'usage_limit'})` (#255's entry point —
//    coordinators first, workers only via their OPS). Manual pauses are never selected.
//  • `afterAccountChange` — migration / re-login: force a fresh reading of the account(s) the paused runs wait on and re-evaluate AT ONCE.

import { openGate, send, type BusDb } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { pausedCarrierForWorkspace, runSubtreeIds } from './bus-pause.ts';
import { recordPauseOrigin } from './bus-pause-records.ts';
import { repriseAddressees, revertResumeToPaused } from './pause-reprise.ts';
import { parseSwitches } from '../shared/bus-switches.ts';
import { HUMAN_GATE_RECIPIENT } from '../shared/human-gates.ts';
import { resolveWorkspaceAccountId } from '../shared/accounts.ts';
import type { PauseAutoReason, RepriseEntry } from '../shared/pause-lifecycle.ts';
import {
  PAUSE_AUTO_BY,
  decideRunReprise,
  encodePauseAuto,
  heldAddresseesKey,
  memberVerdict,
  mergePauseAuto,
  parseAutoHeld,
  parsePauseAuto,
  repriseBackoffMs,
  type AutoHeld,
  type MemberVerdict,
  type UsageReading,
} from '../shared/pause-auto.ts';
import type { WaveNode } from './wave-run-id.ts';

/** The workspace fields auto-pause reads (a structural slice of `Workspace`). */
export interface AutoWorkspace extends WaveNode {
  archived?: boolean;
  accountId?: string;
  lastStopReason?: string;
  lastStopReasonAt?: number;
  usageLimitResetsAt?: number;
}

export interface PauseAutoDeps {
  getBus: () => BusDb | null;
  getWorkspace: (id: string) => AutoWorkspace | undefined;
  /** ids of the configured accounts — a pin to a deleted account resolves to the default login (null). */
  knownAccountIds: () => ReadonlySet<string>;
  /** freshest cached reading of an account (null id = the default login), or null. */
  readingFor: (accountId: string | null) => UsageReading | null;
  /** when this member's pinned account last changed (migration / re-login), null = never this app run. */
  accountChangedAt: (wsId: string) => number | null;
  noteAccountChanged: (wsId: string, at: number) => void;
  /** FORCE a fresh reading (bypasses the ≥180 s cache) of each account; null = the default login. Resolves when the fetch is done. */
  forceRefresh: (accountIds: Array<string | null>) => Promise<void>;
  /** NON-forcing nudge of the poller (a reading is wanted: the reset time passed / is unknown). */
  requestRefresh: (accountIds: Array<string | null>) => void;
  /** #255's `beginReprise` (src/main/bus-pause.ts). */
  beginReprise: RepriseEntry;
  /** auto-Reprises of this run in the last REPRISE_STREAK_WINDOW_MS (the flap guard's streak) and the recorder. In-memory is enough: a restart forgets a streak. */
  repriseStreak: (runId: string, now: number) => number;
  noteReprise: (runId: string, now: number) => void;
  /** An explicit account change / re-login is NEW evidence: it ends the flap guard's streak (the guard exists for an UNEXPLAINED loop). */
  resetStreak: (runId: string) => void;
  /** Workspaces whose #74 marker (`lastStopReason === 'usage_limit'`) is set, with the time it was recorded. */
  limitMarkedWorkspaces: () => Array<{ id: string; markedAt: number }>;
  /** Drop a member's marker (activity `clearStopReason`) — its Reprise row / Consigne was sent, so #74's generic nudge must not ALSO wake it. */
  clearLimitMarker: (wsId: string) => Promise<void>;
  /** Cursor over `messages.sequence` for the `reprise` rows already seen (in-memory: a restart re-reads them, harmless). */
  repriseCursor: { get: () => number; set: (seq: number) => void };
  /** First-time-only latch (true = first call for this key): the `no-wake` warn / escalation fire ONCE per carrier (+epoch). In-memory is enough: a restart repeats one line. */
  once: (key: string) => boolean;
  /** The memory guard says the memory Pause is in effect (critical memory): an auto Reprise of a usage-limit pause WAITS — it would wake the coordinators into a host that is about to be (or is) re-paused (#290). Absent = never. */
  memoryPauseHeld?: () => boolean;
  /** The workspace store is loaded from disk (the trap's rule: an unloaded store reads every trigger as "deleted"). Absent = always ready. */
  storeReady?: () => boolean;
  now: () => number;
  log: { info: (m: string) => void; warn: (m: string, e?: unknown) => void };
}

// ─── the live tree ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
/** `[ws, parent, …]` along the store's `parentId` chain (the gates' walk), bounded by a seen-set; `dangling` = the chain hit a missing parent. */
export function liveChain(deps: Pick<PauseAutoDeps, 'getWorkspace'>, ws: AutoWorkspace): { ids: string[]; dangling: boolean } {
  const ids: string[] = [];
  const seen = new Set<string>();
  let cur: AutoWorkspace | undefined = ws;
  let dangling = false;
  while (cur && !seen.has(cur.id)) {
    seen.add(cur.id);
    ids.push(cur.id);
    if (!cur.parentId) break;
    const parent = deps.getWorkspace(cur.parentId);
    if (!parent) {
      dangling = true;
      break;
    }
    cur = parent;
  }
  return { ids, dangling };
}

/** The carrier a member's limit stop pauses: the FIRST run walking up whose frozen `pause` switch is ON (null = none: nothing to pause). */
function carrierRunFor(db: BusDb, deps: PauseAutoDeps, ws: AutoWorkspace): string | null {
  const { ids, dangling } = liveChain(deps, ws);
  for (const id of ids) if (getRun(db, id)?.flags.pause === true) return id;
  if (dangling) {
    // a workspace on the chain is gone from the store: the bus run tree (`parent_run_id`, write-once) is the only evidence left
    const seen = new Set<string>();
    let cur = getRun(db, ids[ids.length - 1])?.parent_run_id ?? null;
    while (cur && !seen.has(cur)) {
      seen.add(cur);
      const run = getRun(db, cur);
      if (!run) break;
      if (run.flags.pause === true) return cur;
      cur = run.parent_run_id;
    }
  }
  return null;
}

export interface CarrierRow {
  pausedAt: number | null;
  trapAt: number | null;
  resumeStartedAt: number | null;
  pauseAuto: string | null;
}

export function readCarrier(db: BusDb, runId: string): CarrierRow | null {
  const r = db.prepare('SELECT paused_at, pause_trap_at, resume_started_at, pause_auto FROM runs WHERE id = ?').get(runId) as
    | Record<string, unknown>
    | undefined;
  if (!r) return null;
  const n = (v: unknown): number | null => (v === null || v === undefined ? null : Number(v));
  return { pausedAt: n(r.paused_at), trapAt: n(r.pause_trap_at), resumeStartedAt: n(r.resume_started_at), pauseAuto: (r.pause_auto as string | null) ?? null };
}

/** A host-written pause has no `orchestra run pause` process to spare: record an EMPTY origin chain so the trap does not wait ≤3 s for one (nobody is spared). */
export function recordHostOrigin(db: BusDb, deps: Pick<PauseAutoDeps, 'log'>, carrier: string, pausedAt: number): void {
  try {
    recordPauseOrigin(db, carrier, pausedAt, []);
  } catch (e) {
    deps.log.warn(`pause-auto: origin record failed for ${carrier} — the trap waits its origin grace`, e);
  }
}

// ─── can the Reprise wake everyone it addresses? ─────────────────────────────────────────────────────────────────────────────────────────
/** The coordinators the Reprise would address for `carrier` whose run has its frozen `wake` switch OFF — i.e. that the bus-wake sweep would never wake. The addressee set is
 *  #255's OWN plan (`repriseAddressees` ⇐ `planRoster`: the live workspace tree first, the bus run tree only for ids the live tree does not know) — never a second enumeration —
 *  minus workspaces that no longer exist / are archived (a deleted OPS's historical run row is nobody to wake). A run with no row reads all-OFF (unknown ⇒ not woken). */
export function wakeOffAddressees(db: BusDb, deps: Pick<PauseAutoDeps, 'getWorkspace'>, carrier: string, pausedAt?: number): Array<{ wsId: string; runId: string }> {
  return repriseAddressees(db, carrier, runSubtreeIds(db, carrier), pausedAt)
    .filter((a) => {
      const w = deps.getWorkspace(a.wsId);
      return !!w && !w.archived;
    })
    .filter((a) => getRun(db, a.runId)?.flags.wake !== true);
}

// ─── Pause on a usage-limit stop ──────────────────────────────────────────────────────────────────────────────────────────────────────────
export type AutoPauseOutcome =
  | 'paused' // a new Pause dure was written
  | 'merged' // the run was already auto-paused: the member joined the reason
  | 'repaused' // the run was RESUMING (auto): back to paused in a NEW epoch, the new member joined
  | 'manual-pause' // the member is already under a manual pause: untouched
  | 'no-carrier' // no run above the member has the frozen `pause` switch ON
  | 'no-wake' // a coordinator the Reprise would address sits in a run with its frozen `wake` switch OFF: a Reprise could not wake it — nothing is written (= master)
  | 'no-workspace'
  | 'no-bus';

export function autoPauseOnLimit(deps: PauseAutoDeps, wsId: string, attempt = 0): AutoPauseOutcome {
  const ws = deps.getWorkspace(wsId);
  if (!ws || ws.archived) return 'no-workspace';
  const db = deps.getBus();
  if (!db) return 'no-bus';
  const accountId = resolveWorkspaceAccountId(ws.accountId, deps.knownAccountIds());

  // Already governed by a pause (any phase)? Then this stop is NOT a new pause.
  // includeReleased: a member RELEASED during the Reprise still belongs to the (resuming) carrier — its limit stop re-pauses THAT run
  const nearest = carrierRunFor(db, deps, ws); // the FIRST run walking up with the frozen switch ON — where a NEW pause would go
  let gov = pausedCarrierForWorkspace(db, ws, deps.getWorkspace, { includeReleased: true });
  let govRow = gov ? readCarrier(db, gov.runId) : null;
  if (gov && govRow?.resumeStartedAt !== null && govRow !== null && nearest !== null && nearest !== gov.runId) {
    // a FARTHER run is RESUMING and has released this member: it no longer governs it — a new pause belongs to the nearest switch-ON run (which is not paused: else it would govern)
    gov = null;
    govRow = null;
  }
  if (gov && govRow) {
    const row = govRow;
    const auto = parsePauseAuto(row.pauseAuto, row.pausedAt);
    const resuming = row.resumeStartedAt !== null;
    // Still PAUSED by a human (manual): untouched. A human-led Reprise that already RELEASED this member no longer pauses it — its limit stop IS a new (auto) pause.
    if (row.pausedAt === null || (auto === null && !resuming)) return 'manual-pause';
    const merged = mergePauseAuto(auto, { wsId, accountId });
    if (resuming) {
      // A Pause while RESUMING = back to PAUSED in a NEW epoch (#255 `revertResumeToPaused`, #276 D3 "what changed": the old epoch's Bilan rows read "fully trapped", so a
      // re-owed trap on the SAME epoch would skip every member). `auto` writes the epoch-bound `pause_auto` in the SAME statement (no window with a NULL one).
      if (revertResumeToPaused(db, gov.runId, PAUSE_AUTO_BY, deps.now(), { auto: (epoch) => encodePauseAuto(merged, epoch) })) {
        const epoch = readCarrier(db, gov.runId)?.pausedAt;
        if (epoch !== null && epoch !== undefined) recordHostOrigin(db, deps, gov.runId, epoch);
        deps.log.info(`pause-auto: member ${wsId} hit the usage limit again during the Reprise — run ${gov.runId} is PAUSED again (new epoch)`);
        return 'repaused';
      }
      return attempt === 0 ? autoPauseOnLimit(deps, wsId, 1) : 'manual-pause'; // the Reprise finished / another pause landed meanwhile: classify again, once
    }
    db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ?').run(encodePauseAuto(merged, row.pausedAt as number, parseAutoHeld(row.pauseAuto, row.pausedAt)), gov.runId, row.pausedAt);
    return 'merged';
  }

  const carrier = nearest;
  if (!carrier) return 'no-carrier';
  // `pause` and `wake` are independent frozen opt-ins, frozen PER RUN: with `wake` OFF the Reprise's bus rows wake nobody and #74's nudge is refused by the pause — the fleet would
  // stall for good (worse than master, where the nudge wakes the member at the reset). The Reprise sends a row to every coordinator it addresses and the flag of the run each row
  // is sent in governs its wake: EVERY addressee (#255's own plan) needs wake ON — else no auto Pause: write nothing, say so once.
  const off = wakeOffAddressees(db, deps, carrier);
  if (off.length > 0) {
    if (deps.once(`no-wake:${carrier}`)) deps.log.warn(`pause-auto: member ${wsId} hit the usage limit but run ${carrier} is NOT auto-paused — its Reprise could not wake ${off.map((a) => `${a.wsId} (run ${a.runId}, wake OFF)`).join(', ')}; nothing written (same as before auto Pause)`);
    return 'no-wake';
  }
  const now = deps.now();
  const reason = mergePauseAuto(null, { wsId, accountId });
  const res = db
    .prepare(
      `UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'hard', pause_deadline_at = NULL, pause_escalated_at = NULL,
              pause_trap_at = NULL, resume_started_at = NULL, pause_auto = ?
        WHERE id = ? AND paused_at IS NULL`,
    )
    .run(now, PAUSE_AUTO_BY, encodePauseAuto(reason, now), carrier);
  if (res.changes === 1) {
    recordHostOrigin(db, deps, carrier, now);
    deps.log.info(`pause-auto: member ${wsId} hit the usage limit — run ${carrier} is now PAUSED (dure, auto; account ${accountId ?? 'default'})`);
    return 'paused';
  }
  // a pause landed between the read and the write: classify it now (once), never overwrite it
  return attempt === 0 ? autoPauseOnLimit(deps, wsId, 1) : 'manual-pause';
}

// ─── Reprise when the quota is back ───────────────────────────────────────────────────────────────────────────────────────────────────────
export interface AutoEvalEntry {
  runId: string;
  action: 'reprise' | 'wait';
  why?: string;
  outcome?: string;
}

interface AutoPausedRun {
  runId: string;
  pausedAt: number;
  trapAt: number | null;
  reason: PauseAutoReason;
  /** the hold recorded for THIS epoch (`pause_auto.held`), or null. */
  held: AutoHeld | null;
  depth: number;
}

/** Runs that are PAUSED by the host on a usage limit and not yet resuming (frozen switch ON, epoch-matched reason). Ancestor runs first. */
export function autoPausedRuns(db: BusDb): AutoPausedRun[] {
  const rows = db
    .prepare(
      `SELECT r.id, r.parent_run_id AS parent, r.paused_at, r.pause_trap_at, r.resume_started_at, r.pause_auto, f.flags AS flags_json
         FROM runs r LEFT JOIN run_flags f ON f.run_id = r.id
        WHERE r.paused_at IS NOT NULL AND r.pause_auto IS NOT NULL AND r.resume_started_at IS NULL`,
    )
    .all() as Array<Record<string, unknown>>;
  if (rows.length === 0) return [];
  const parents = new Map((db.prepare('SELECT id, parent_run_id AS p FROM runs').all() as Array<{ id: string; p: string | null }>).map((r) => [r.id, r.p]));
  const depthOf = (id: string): number => {
    let d = 0;
    const seen = new Set<string>([id]);
    for (let p = parents.get(id) ?? null; p && !seen.has(p); p = parents.get(p) ?? null) {
      seen.add(p);
      d++;
    }
    return d;
  };
  const out: AutoPausedRun[] = [];
  for (const r of rows) {
    if (parseSwitches((r.flags_json as string | null | undefined) ?? null).pause !== true) continue;
    const pausedAt = Number(r.paused_at);
    const reason = parsePauseAuto((r.pause_auto as string | null) ?? null, pausedAt);
    if (!reason) continue;
    out.push({ runId: String(r.id), pausedAt, trapAt: r.pause_trap_at === null || r.pause_trap_at === undefined ? null : Number(r.pause_trap_at), reason, held: parseAutoHeld((r.pause_auto as string | null) ?? null, pausedAt), depth: depthOf(String(r.id)) });
  }
  return out.sort((a, b) => a.depth - b.depth);
}

function verdictsFor(deps: PauseAutoDeps, run: AutoPausedRun, now: number): { verdicts: MemberVerdict[]; refresh: Array<string | null>; latestBlock: number } {
  const known = deps.knownAccountIds();
  const verdicts: MemberVerdict[] = [];
  const refresh = new Set<string | null>();
  const live: string[] = [];
  let latestBlock = run.pausedAt;
  run.reason.wsIds.forEach((wsId) => {
    const ws = deps.getWorkspace(wsId);
    if (!ws || ws.archived) return; // a deleted trigger cannot be waited for
    live.push(wsId);
    const account = resolveWorkspaceAccountId(ws.accountId, known); // the CURRENT pin — a migration moved it
    const marker = ws.lastStopReason === 'usage_limit' ? ws.lastStopReasonAt ?? null : null;
    latestBlock = Math.max(latestBlock, marker ?? 0);
    const blockedAt = marker ?? run.pausedAt;
    const changed = deps.accountChangedAt(wsId);
    const v = memberVerdict({
      blockedAt,
      // a change OLDER than this block is history (a later limit stop on the new account is judged on its own)
      accountChangedAt: changed !== null && changed > blockedAt ? changed : null,
      resetsAtMs: marker !== null ? ws.usageLimitResetsAt ?? null : null,
      reading: deps.readingFor(account),
      now,
    });
    verdicts.push(v);
    if (!v.ok && v.refresh) refresh.add(account);
  });
  if (live.length === 0) {
    // every trigger is gone: the stored accounts are the only thing left to wait on
    new Set(run.reason.accountIds).forEach((account) => {
      const a = account !== null && known.has(account) ? account : null;
      const v = memberVerdict({ blockedAt: run.pausedAt, accountChangedAt: null, resetsAtMs: null, reading: deps.readingFor(a), now });
      verdicts.push(v);
      if (!v.ok && v.refresh) refresh.add(a);
    });
  }
  return { verdicts, refresh: [...refresh], latestBlock };
}

/** Is a run ABOVE `runId` still fully paused (not yet resuming)? The gates govern a member by its nearest paused carrier, so a child run's Reprise
 *  would let its members start under a parent pause that still stands — a child waits for every ancestor (top-down). The LIVE workspace tree is the
 *  gates' truth (`runs.parent_run_id` is write-once: an OPS detached since creation is no longer under its old parent); the bus run tree only when the
 *  live chain is unknown or dangles. */
export function ancestorStillPaused(db: BusDb, deps: Pick<PauseAutoDeps, 'getWorkspace'>, runId: string): boolean {
  for (const id of ancestorRunIds(db, deps, runId)) {
    const run = getRun(db, id);
    if (run?.flags.pause !== true) continue; // a run with the switch OFF carries no pause (a stale column is inert)
    const c = readCarrier(db, id);
    if (c && c.pausedAt !== null && c.resumeStartedAt === null) return true;
  }
  return false;
}

/** The run ids ABOVE `runId`, nearest first: the LIVE workspace chain (the gates' truth), the bus run tree only when that chain is unknown or dangles. */
export function ancestorRunIds(db: BusDb, deps: Pick<PauseAutoDeps, 'getWorkspace'>, runId: string): string[] {
  const ids: string[] = [];
  const anchor = deps.getWorkspace(runId);
  let live = false;
  if (anchor) {
    const chain = liveChain(deps, anchor);
    ids.push(...chain.ids.slice(1));
    live = !chain.dangling;
  }
  if (!live) {
    const seen = new Set<string>([runId, ...ids]);
    for (let cur = getRun(db, runId)?.parent_run_id ?? null; cur && !seen.has(cur); cur = getRun(db, cur)?.parent_run_id ?? null) {
      seen.add(cur);
      ids.push(cur);
    }
  }
  return ids;
}

export async function evaluateAutoPaused(deps: PauseAutoDeps): Promise<AutoEvalEntry[]> {
  const db = deps.getBus();
  if (!db) return [];
  if (deps.storeReady && !deps.storeReady()) return []; // UNKNOWN is not NONE: with the store unloaded every trigger would read as "deleted
  const out: AutoEvalEntry[] = [];
  for (const run of autoPausedRuns(db)) {
    // one run failing must never starve the others on every tick
    try {
      const entry = evaluateOne(deps, db, run);
      if (entry) out.push(entry);
    } catch (e) {
      deps.log.warn(`pause-auto: evaluating run ${run.runId} threw — retried next tick`, e);
      out.push({ runId: run.runId, action: 'wait', why: 'evaluate-threw' });
    }
  }
  return out;
}

/** Who must hear that the auto-Reprise is HELD: the carrier's own coordinator is a member of the paused run — it cannot read (its wake is refused by the very pause the row asks to
 *  lift). So: the NEAREST ancestor run whose coordinator is not itself paused and can be woken (frozen wake ON), the live tree first and the bus run tree after; none ⇒ the human. */
export function escalationTarget(db: BusDb, deps: Pick<PauseAutoDeps, 'getWorkspace'>, carrier: string): { kind: 'coordinator'; runId: string; coordinator: string } | { kind: 'gate'; asker: string } {
  const seen = new Set<string>([carrier.toLowerCase()]);
  const ancestors: string[] = [];
  const own = deps.getWorkspace(carrier);
  const chain = own ? liveChain(deps, own) : null;
  if (chain) for (const id of chain.ids.slice(1)) if (!seen.has(id.toLowerCase())) (seen.add(id.toLowerCase()), ancestors.push(id));
  // the live tree first (`runs.parent_run_id` is write-once: a detached OPS is no longer under its old parent); the bus run tree only when the live chain is unknown or dangles
  if (!chain || chain.dangling) {
    for (let cur = getRun(db, carrier)?.parent_run_id ?? null; cur && !seen.has(cur.toLowerCase()); cur = getRun(db, cur)?.parent_run_id ?? null) (seen.add(cur.toLowerCase()), ancestors.push(cur));
  }
  for (const id of ancestors) {
    const run = getRun(db, id);
    if (!run || run.flags.wake !== true) continue; // not a run, or one the sweep never wakes
    const w = deps.getWorkspace(run.coordinator);
    if (!w || w.archived) continue; // a gone coordinator reads nothing
    if (pausedCarrierForWorkspace(db, w, deps.getWorkspace) !== null) continue; // itself paused ⇒ cannot read either
    return { kind: 'coordinator', runId: id, coordinator: run.coordinator };
  }
  return { kind: 'gate', asker: getRun(db, carrier)?.coordinator ?? carrier };
}

/** Tell someone that the Reprise of `run` is HELD, and record the hold in `pause_auto.held` — ONE transaction: the row/gate AND the record land together or neither does (a failed write
 *  is retried at the next tick and the log never claims an escalation that was not written). Returns the recorded hold, or null on failure. */
function escalateNoWake(db: BusDb, deps: PauseAutoDeps, run: AutoPausedRun, rawPauseAuto: string | null, off: Array<{ wsId: string; runId: string }>): AutoHeld | null {
  try {
    const reason = parsePauseAuto(rawPauseAuto, run.pausedAt);
    if (!reason) return null; // no longer THIS auto pause
    const list = off.map((a) => `${a.wsId} (run ${a.runId})`).join(', ');
    const target = escalationTarget(db, deps, run.runId);
    const body =
      `Auto-Reprise HELD for run ${run.runId}: the usage quota is back, but the Reprise would address ${list}, whose run has its frozen \`wake\` switch OFF — nobody would receive its \`reprise\` row ` +
      `and every worker below would stay blocked. The run stays PAUSED. Detach/remove that run, or lift the pause yourself once it is safe (\`orchestra run resume --run ${run.runId}\`).`;
    const held: AutoHeld = { at: deps.now(), addressees: heldAddresseesKey(off), to: target.kind === 'gate' ? HUMAN_GATE_RECIPIENT : target.coordinator };
    db.transaction(() => {
      if (target.kind === 'coordinator') send(db, { runId: target.runId, sender: 'host', recipient: target.coordinator, kind: 'escalation', body });
      else openGate(db, run.runId, target.asker, body, HUMAN_GATE_RECIPIENT);
      const upd = db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ? AND pause_auto = ?').run(encodePauseAuto(reason, run.pausedAt, held), run.runId, run.pausedAt, rawPauseAuto);
      if (upd.changes !== 1) throw new Error('the auto pause changed meanwhile'); // rolls the row back too
    }).immediate();
    return held;
  } catch (e) {
    deps.log.warn(`pause-auto: HELD escalation for run ${run.runId} failed — retried next tick`, e);
    return null;
  }
}

function clearHeld(db: BusDb, run: AutoPausedRun, rawPauseAuto: string | null): void {
  const reason = parsePauseAuto(rawPauseAuto, run.pausedAt);
  if (reason) db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ? AND pause_auto = ?').run(encodePauseAuto(reason, run.pausedAt, null), run.runId, run.pausedAt, rawPauseAuto);
}

function evaluateOne(deps: PauseAutoDeps, db: BusDb, run: AutoPausedRun): AutoEvalEntry {
  const now = deps.now();
  if (deps.memoryPauseHeld?.()) return { runId: run.runId, action: 'wait', why: 'memory-pause-held' };
  if (ancestorStillPaused(db, deps, run.runId)) return { runId: run.runId, action: 'wait', why: 'ancestor-paused' };
  const { verdicts, refresh, latestBlock } = verdictsFor(deps, run, now);
  const streak = deps.repriseStreak(run.runId, now);
  const decision = decideRunReprise({ verdicts, pausedAt: run.pausedAt, trapAt: run.trapAt, holdoffUntil: streak > 0 ? latestBlock + repriseBackoffMs(streak) : null, now });
  if (decision.action === 'wait') {
    if (refresh.length > 0) deps.requestRefresh(refresh);
    return { runId: run.runId, action: 'wait', why: decision.why };
  }
  // the row may have changed since the SELECT (a human lift, a manual re-pause): never Reprise what is no longer THIS auto pause
  const cur = readCarrier(db, run.runId);
  if (!cur || cur.pausedAt !== run.pausedAt || cur.resumeStartedAt !== null || parsePauseAuto(cur.pauseAuto, cur.pausedAt) === null) {
    return { runId: run.runId, action: 'wait', why: 'changed-meanwhile' };
  }
  // The addressee set is re-read NOW (a wake-OFF run created or attached after the pause is unknown at pause time): a Reprise nobody receives would leave every worker blocked forever.
  // Held instead — recorded in `pause_auto.held` (shown by `run status`) and told ONCE per addressee set to the nearest unpaused ancestor coordinator, else the human (decision gate);
  // re-evaluated every tick (the set may change: detaching the run lets the next tick Reprise, which also clears the hold).
  const off = wakeOffAddressees(db, deps, run.runId, run.pausedAt);
  if (off.length > 0) {
    const key = heldAddresseesKey(off);
    const curHeld = parseAutoHeld(cur.pauseAuto, cur.pausedAt);
    if (!curHeld || curHeld.addressees.join('|') !== key.join('|')) {
      const held = escalateNoWake(db, deps, run, cur.pauseAuto, off);
      if (held) deps.log.warn(`pause-auto: quota is back for run ${run.runId} but its Reprise could not wake ${off.map((a) => `${a.wsId} (run ${a.runId})`).join(', ')} (frozen wake switch OFF) — Reprise HELD, ${held.to === HUMAN_GATE_RECIPIENT ? 'asked the human (decision gate)' : `escalated to ${held.to}`}`);
    }
    return { runId: run.runId, action: 'wait', why: 'no-wake-addressee' };
  }
  if (parseAutoHeld(cur.pauseAuto, cur.pausedAt)) clearHeld(db, run, cur.pauseAuto); // the offending run is gone: the hold ends with it
  let outcome: string;
  try {
    outcome = deps.beginReprise(db, run.runId, 'host', { host: true, reason: 'usage_limit' });
  } catch (e) {
    deps.log.warn(`pause-auto: Reprise of run ${run.runId} threw — retried next tick`, e);
    return { runId: run.runId, action: 'wait', why: 'reprise-threw' };
  }
  if (outcome === 'resuming' || outcome === 'already-resuming') {
    deps.noteReprise(run.runId, now);
    // #74's marker of a trigger is dropped once ITS `reprise` row is sent (`clearRepriseDeliveredMarkers`, next tick head) — until then #74 stays the safety net.
    deps.log.info(`pause-auto: quota is back — run ${run.runId} Reprise started (${outcome}; triggers ${run.reason.wsIds.join(',')}; streak ${streak + 1})`);
  } else if (outcome === 'refused') {
    deps.log.warn(`pause-auto: Reprise of run ${run.runId} REFUSED for a host caller — contract breach (#276 D3)`);
  }
  return { runId: run.runId, action: 'reprise', outcome };
}

// ─── #74's marker once the member's Reprise row was sent ─────────────────────────────────────────────────────────────────────────────────
export interface MarkerClearEntry {
  wsId: string;
  sequence: number;
}

/** A `reprise` row (the coordinator's Bilan at `beginReprise`, a worker's Consigne at `run release`) addressed to a member whose #74 marker is older than the row:
 *  its restart is the Reprise's job — drop the marker, or #74's generic nudge would wake it a SECOND time (no second mechanism, D5/D6). Runs at the head of every tick,
 *  before #74's candidates, so the marker is gone before the nudge could read it. Incremental over `messages.sequence` (rowid range); only runs with the `pause` switch ON
 *  ever have `reprise` rows ⇒ nothing happens when the switch is OFF; and only when the row's run has `wake` ON (else nothing would deliver it). */
export async function clearRepriseDeliveredMarkers(deps: PauseAutoDeps): Promise<MarkerClearEntry[]> {
  const db = deps.getBus();
  if (!db) return [];
  const marked = deps.limitMarkedWorkspaces();
  const hi = (db.prepare('SELECT MAX(sequence) AS m FROM messages').get() as { m: number | null }).m ?? 0;
  const from = deps.repriseCursor.get();
  if (hi <= from) return [];
  const out: MarkerClearEntry[] = [];
  const byId = new Map(marked.map((m) => [m.id.toLowerCase(), m]));
  if (byId.size > 0) {
    const rows = db
      .prepare("SELECT sequence, run_id, recipient, created_at FROM messages WHERE sequence > ? AND sequence <= ? AND kind = 'reprise' AND recipient IS NOT NULL ORDER BY sequence")
      .all(from, hi) as Array<{ sequence: number; run_id: string; recipient: string; created_at: number }>;
    for (const r of rows) {
      const m = byId.get(String(r.recipient).toLowerCase());
      if (!m || r.created_at < m.markedAt) continue; // an OLDER row says nothing about THIS limit stop
      // the row is delivered by the wake of ITS run (the deeper run's frozen flag governs): with wake OFF there nobody is woken, so #74's nudge stays the member's only restart — human / manual path included
      if (getRun(db, r.run_id)?.flags.wake !== true) continue;
      byId.delete(m.id.toLowerCase());
      try {
        await deps.clearLimitMarker(m.id);
        out.push({ wsId: m.id, sequence: Number(r.sequence) });
        deps.log.info(`pause-auto: ${m.id} was sent its Reprise row — #74 marker cleared (no second wake)`);
      } catch (e) {
        deps.log.warn(`pause-auto: marker clear failed for ${m.id}`, e);
      }
    }
  }
  deps.repriseCursor.set(hi);
  return out;
}

// ─── account migration / re-login ─────────────────────────────────────────────────────────────────────────────────────────────────────────
export type AccountChange = { kind: 'migrate'; wsId: string } | { kind: 'login'; accountId: string };

export interface AccountChangeResult {
  /** auto-paused runs the change touched (none ⇒ NOTHING was forced, NOTHING evaluated: the OFF-identical path) */
  runs: string[];
  forced: Array<string | null>;
  evaluated: AutoEvalEntry[];
}

/** A paused run's trigger member changed account (`migrate`) or an account it waits on was re-logged (`login`): force a fresh reading of
 *  the account(s) that now matter and re-evaluate the paused runs AT ONCE — no waiting for the 180 s cache or the next 20 s tick. */
export async function afterAccountChange(deps: PauseAutoDeps, change: AccountChange): Promise<AccountChangeResult> {
  const db = deps.getBus();
  const none: AccountChangeResult = { runs: [], forced: [], evaluated: [] };
  if (!db) return none;
  const known = deps.knownAccountIds();
  const runs: string[] = [];
  const force = new Set<string | null>();
  for (const run of autoPausedRuns(db)) {
    let hit = false;
    for (const wsId of run.reason.wsIds) {
      const ws = deps.getWorkspace(wsId);
      if (!ws || ws.archived) continue;
      const account = resolveWorkspaceAccountId(ws.accountId, known);
      if ((change.kind === 'migrate' && wsId === change.wsId) || (change.kind === 'login' && account === change.accountId)) {
        hit = true;
        force.add(account);
        deps.noteAccountChanged(wsId, deps.now()); // readings older than this were taken for the OLD account / login
        if (change.kind === 'migrate') {
          // keep the stored (display) account of the trigger in step with the pin
          const merged = mergePauseAuto(run.reason, { wsId, accountId: account });
          db.prepare('UPDATE runs SET pause_auto = ? WHERE id = ? AND paused_at = ?').run(encodePauseAuto(merged, run.pausedAt, run.held), run.runId, run.pausedAt);
        }
      }
    }
    if (hit) {
      runs.push(run.runId);
      deps.resetStreak(run.runId); // an explicit switch / re-login is new evidence: the flap guard must not hold the Reprise it exists to make prompt
    }
  }
  if (runs.length === 0) return none;
  const forced = [...force];
  try {
    await deps.forceRefresh(forced);
  } catch (e) {
    deps.log.warn('pause-auto: forced usage refresh failed — evaluating on what is cached', e);
  }
  return { runs, forced, evaluated: await evaluateAutoPaused(deps) };
}
