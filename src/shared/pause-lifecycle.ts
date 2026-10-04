// Fleet PAUSE lifecycle — the FROZEN interface of wave E (ledger #276 D3; #254 douce, #255 Reprise, #256 auto).
// Pure: no bus, no store. A change here = one "what changed" line to every dependent track on the ledger.
//
// State lives on the CARRIER `runs` row (MIGRATIONS[9] + [10]); per-member progress lives in `pause_members`
// (one row per member per pause epoch = `runs.paused_at` at pause time).

/** The run-level state machine: active → pausing (douce only) → paused → resuming → active. */
export type PausePhase = 'active' | 'pausing' | 'paused' | 'resuming';

/** `runs.pause_mode`. 'soft' = Pause douce (#254), 'hard' = Pause dure (#252). */
export type PauseMode = 'soft' | 'hard';

/** A Pause douce turns into a Pause dure for the stragglers this long after `paused_at` (#254, D4). */
export const SOFT_PAUSE_DEADLINE_MS = 3 * 60_000;

/** The pause columns of the carrier `runs` row (epoch ms; null = unset). */
export interface CarrierPauseColumns {
  pausedAt: number | null;
  mode: PauseMode | null;
  /** soft: `paused_at + SOFT_PAUSE_DEADLINE_MS`; hard: null. */
  deadlineAt: number | null;
  /** When the douce stopped waiting (every member confirmed, or the deadline passed) and the trap became owed. null = still waiting. */
  escalatedAt: number | null;
  /** `pause_trap_at` (#252). */
  trapAt: number | null;
  /** Set by {@link RepriseEntry} — the run is resuming. Cleared (with every other pause column) when every member is released. */
  resumeStartedAt: number | null;
}

/** The ONE derivation of the phase. Gates keep reading `paused_at` (pausing/paused/resuming all refuse AUTO starts, except a
 *  RELEASED member while resuming — {@link memberMayStart}). */
export function pausePhaseOf(c: CarrierPauseColumns): PausePhase {
  if (c.pausedAt === null) return 'active';
  if (c.resumeStartedAt !== null) return 'resuming';
  if (c.mode === 'soft' && c.escalatedAt === null && c.trapAt === null) return 'pausing';
  return 'paused';
}

/** Is the host trap (#252) owed for this carrier? Hard: at once. Soft: only once escalated (all confirmed or deadline). */
export function trapOwed(c: CarrierPauseColumns): boolean {
  if (c.pausedAt === null || c.trapAt !== null || c.resumeStartedAt !== null) return false;
  return c.mode !== 'soft' || c.escalatedAt !== null;
}

/** How a member reached "paused". 'member' = it ran `orchestra run confirm pause` (its pause accusé);
 *  'host-idle' = no turn running when the douce landed (the host confirms for it, no wake);
 *  'trap' = taken by the host trap (hard pause, or a douce straggler at the deadline). */
export type PauseConfirmVia = 'member' | 'host-idle' | 'trap';

/** One `pause_members` row. Keyed (runId = CARRIER, pausedAt = epoch, wsId). Upserted by whoever writes first (host or CLI). */
export interface PauseMemberRow {
  runId: string;
  pausedAt: number;
  wsId: string;
  /** 'coordinator' = the coordinator of a run in the paused subtree (released by the HOST at Reprise, depth order);
   *  'worker' = released only by its coordinator (`orchestra run release`). */
  role: 'coordinator' | 'worker';
  /** The run this member belongs to (whose coordinator releases it). */
  memberRun: string | null;
  pauseConfirmedAt: number | null;
  pauseConfirmVia: PauseConfirmVia | null;
  releasedAt: number | null;
  /** 'host' (coordinators at Reprise) or the releasing coordinator's handle. */
  releasedBy: string | null;
  /** The member's reprise accusé (`orchestra run confirm reprise`). Tracking only — never gates. */
  repriseConfirmedAt: number | null;
}

/** While RESUMING, may this member start (réveil/turn/spawn)? Only once released. Any other phase but 'active': no. */
export function memberMayStart(phase: PausePhase, m: Pick<PauseMemberRow, 'releasedAt'> | null): boolean {
  if (phase === 'active') return true;
  return phase === 'resuming' && m !== null && m.releasedAt !== null;
}

/** "N/M en pause" / "N/M repris" — what `orchestra bus-status` prints, missing members named. */
export interface PauseRosterSummary {
  phase: PausePhase;
  total: number;
  /** pausing/paused: confirmed (any via). resuming: reprise-confirmed. */
  done: number;
  /** ws ids not yet done, in roster order. */
  missing: string[];
}

export function pauseRosterSummary(phase: PausePhase, rows: readonly PauseMemberRow[]): PauseRosterSummary {
  const isDone = (r: PauseMemberRow) =>
    phase === 'resuming' ? r.repriseConfirmedAt !== null : r.pauseConfirmedAt !== null;
  return {
    phase,
    total: rows.length,
    done: rows.filter(isDone).length,
    missing: rows.filter((r) => !isDone(r)).map((r) => r.wsId),
  };
}

/** `runs.pause_auto` (JSON). null = a MANUAL pause — never auto-resumed (#256, D6). */
export interface PauseAutoReason {
  reason: 'usage_limit';
  /** Members whose usage-limit stop triggered the pause. */
  wsIds: string[];
  /** Their PINNED account ids (null = the default login) — auto-Reprise waits for a fresh reading showing quota on each. */
  accountIds: Array<string | null>;
}

/** The outcome of {@link RepriseEntry}. */
export type RepriseOutcome =
  | 'resuming' // resume_started_at set, coordinators released + sent their `reprise` row
  | 'already-resuming'
  | 'not-paused'
  | 'no-run'
  | 'refused'; // CLI caller without the hold authority (host callers are never refused)

/**
 * THE resume entry point (#255 implements it in src/main/bus-pause.ts as `beginReprise`; #256 calls it with
 * `{ host: true, reason: 'usage_limit' }`; `orchestra run resume` calls it with the caller's handle).
 * Bus-only (store-less, like `run pause`): coordinators come from `runs.coordinator` over `runSubtreeIds`.
 */
export type RepriseEntry = (
  db: unknown,
  carrierRunId: string,
  actor: string | null,
  opts?: { host?: boolean; reason?: 'manual' | 'usage_limit' },
) => RepriseOutcome;

/** What a Consigne de reprise carries — derived ONLY from the member's Bilan de pause row (+ its pause_members row). */
export interface ConsigneDeReprise {
  runId: string;
  wsId: string;
  pausedAt: number;
  pausedBy: string | null;
  mode: PauseMode;
  confirmedVia: PauseConfirmVia | null;
  /** Bilan `activity`: was a turn running, which tools were in flight, background tasks, the last task line. */
  wasDoing: { turnRunning: boolean; inFlightTools: string[]; bgTasks: string[]; lastTask: string | null };
  branch: string | null;
  head: string | null;
  /** `refs/orchestra/pause/…` — `git diff <head> <ref>` = the uncommitted non-ignored work. null = no snapshot (say why in notes). */
  snapshotRef: string | null;
  snapshotIncomplete: 'timeout' | null;
  dirty: boolean | null;
  /** Killed commands — listed, NEVER re-run automatically. */
  killed: Array<{ cmd: string; cwd: string | null }>;
  notes: string[];
}
