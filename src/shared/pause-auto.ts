// Fleet PAUSE auto (#256, wave E ledger #276 D6) — the PURE half: what a `usage_limit` stop does to a run's pause, and when the
// quota is back. Impure half = src/main/pause-auto.ts (bus) + pause-auto-host.ts (store / usage pollers / activity observer).
//
// Auto = a structured member's usage-limit stop ⇒ Pause DURE of its run, `runs.pause_auto` = PauseAutoReason; auto-Reprise
// (`beginReprise` host:true) once the PINNED account of EVERY triggering member has quota again. A MANUAL pause (pause_auto NULL) is never
// auto-resumed. Plugs into #74's tick (prompt-queue.ts) — no 2nd poller/timer.

import { usageLimitedUntil, type UsageWindows } from './accounts.ts';
import type { PauseAutoReason } from './pause-lifecycle.ts';

/** `runs.paused_by` of a pause the host wrote itself (display only — authority never keys on it). */
export const PAUSE_AUTO_BY = 'host:usage_limit';

/** Stored `pause_auto` = the frozen {@link PauseAutoReason} + `epoch` (= `runs.paused_at` it was written for). A reader that finds a
 *  different `paused_at` ignores it, so a stale column that survived a lift can never turn a LATER manual pause into an auto one. */
export interface StoredPauseAuto extends PauseAutoReason {
  epoch: number;
}

/** No fresh reading can be had (endpoint down, 429…): the stored reset time is then the only evidence — act this long after it. */
export const RESET_GRACE_MS = 5 * 60_000;
/** Flap guard: auto-Reprises of one run inside this window count as a streak; the next one waits {@link repriseBackoffMs}(streak) after the LATEST limit stop. */
export const REPRISE_STREAK_WINDOW_MS = 2 * 3_600_000;
const REPRISE_BACKOFF_BASE_MS = 5 * 60_000;
const REPRISE_BACKOFF_CAP_MS = 60 * 60_000;
/** A limit the 5h/7d windows cannot show (a Fable-only cap, a non-plan 429) reads as "quota" at once: without this the fleet would loop
 *  pause → trap (snapshot + kill tool trees) → Reprise → limit. 5, 10, 20, 40 min, then 60 min per streak step; streak 0 = no wait. */
export function repriseBackoffMs(streak: number): number {
  return streak <= 0 ? 0 : Math.min(REPRISE_BACKOFF_BASE_MS * 2 ** (streak - 1), REPRISE_BACKOFF_CAP_MS);
}

/** A pause whose host trap never stamps (no members found, store not ready…) must not freeze the fleet forever: Reprise anyway after this. */
export const TRAP_WAIT_MAX_MS = 10 * 60_000;

export function encodePauseAuto(reason: PauseAutoReason, epoch: number): string {
  const stored: StoredPauseAuto = { reason: reason.reason, wsIds: [...reason.wsIds], accountIds: [...reason.accountIds], epoch };
  return JSON.stringify(stored);
}

/** The auto reason of the pause that began at `pausedAt`, or null = MANUAL. Malformed / unknown reason / other epoch ⇒ null (fail safe:
 *  never auto-resume what we cannot prove we paused). */
export function parsePauseAuto(json: string | null | undefined, pausedAt: number | null): PauseAutoReason | null {
  if (!json || pausedAt === null) return null;
  let v: unknown;
  try {
    v = JSON.parse(json);
  } catch {
    return null;
  }
  if (!v || typeof v !== 'object') return null;
  const o = v as Record<string, unknown>;
  if (o.reason !== 'usage_limit') return null;
  if (o.epoch !== pausedAt) return null;
  if (!Array.isArray(o.wsIds) || !o.wsIds.every((x) => typeof x === 'string')) return null;
  if (!Array.isArray(o.accountIds) || !o.accountIds.every((x) => x === null || typeof x === 'string')) return null;
  return { reason: 'usage_limit', wsIds: o.wsIds as string[], accountIds: o.accountIds as Array<string | null> };
}

/** Add one triggering member (idempotent per ws id; wsIds/accountIds stay index-parallel, the LATEST pinned account wins for a repeat). */
export function mergePauseAuto(prev: PauseAutoReason | null, add: { wsId: string; accountId: string | null }): PauseAutoReason {
  const wsIds = [...(prev?.wsIds ?? [])];
  const accountIds = [...(prev?.accountIds ?? [])];
  while (accountIds.length < wsIds.length) accountIds.push(null);
  const i = wsIds.indexOf(add.wsId);
  if (i >= 0) accountIds[i] = add.accountId;
  else {
    wsIds.push(add.wsId);
    accountIds.push(add.accountId);
  }
  return { reason: 'usage_limit', wsIds, accountIds };
}

/** A usage reading of one account as the pollers cache it (`data` null = the fetch produced nothing). */
export interface UsageReading {
  fetchedAt: number;
  data: UsageWindows | null;
}

export interface MemberEvidence {
  /** When the member's limit stop was recorded — or, once its marker is gone, when the pause began. */
  blockedAt: number;
  /** When the member's PINNED account last changed (migration / re-login). A reading older than this was fetched for the OLD account. */
  accountChangedAt: number | null;
  /** `Workspace.usageLimitResetsAt` (epoch ms), null = unknown (the 429 path reports none). */
  resetsAtMs: number | null;
  /** The freshest reading of the member's CURRENT pinned account, or null. */
  reading: UsageReading | null;
  now: number;
}

export type MemberVerdict =
  | { ok: true; via: 'quota' | 'reset-grace' }
  | { ok: false; why: 'limited' | 'no-fresh-reading'; /** ask the poller for a newer reading (the reset time has passed / is unknown) */ refresh: boolean };

/**
 * Is the quota back for ONE triggering member?
 *  1. A reading fetched AFTER the block (and after the last account change) is conclusive: usable ⇒ OK — this OVERRIDES the stored reset
 *     time, which #74 alone waits out; still limited until a reset that is still ahead ⇒ wait. A "limited" reading whose own reset has since
 *     passed is stale, not evidence.
 *  2. No conclusive reading: a known reset time + {@link RESET_GRACE_MS} is the last resort (#74 resumes coordinators at the reset too);
 *     an UNKNOWN reset never resumes blind.
 */
export function memberVerdict(e: MemberEvidence): MemberVerdict {
  const r = e.reading;
  // The stored reset time belongs to the account the limit was hit on: once the member changed account it says nothing about the new one.
  const resetsAtMs = e.accountChangedAt !== null ? null : e.resetsAtMs;
  // `>` against the block (a reading taken in the SAME ms is ambiguous ⇒ stale, #74's rule); `>=` against an account change (the forced read may land in its ms)
  if (r && r.data && r.fetchedAt > e.blockedAt && (e.accountChangedAt === null || r.fetchedAt >= e.accountChangedAt)) {
    const until = usageLimitedUntil(r.data, r.fetchedAt);
    if (until === null) return { ok: true, via: 'quota' };
    if (e.now < until) return { ok: false, why: 'limited', refresh: false };
    // the reading's own block has expired since it was taken: it says nothing about now
  }
  if (resetsAtMs !== null && e.now >= resetsAtMs + RESET_GRACE_MS) return { ok: true, via: 'reset-grace' };
  return { ok: false, why: 'no-fresh-reading', refresh: resetsAtMs === null || e.now >= resetsAtMs };
}

export interface RunRepriseInput {
  /** one verdict per triggering member that still exists (a deleted/archived member cannot be waited for) */
  verdicts: MemberVerdict[];
  pausedAt: number;
  /** `runs.pause_trap_at` — the Bilans (the Consigne de reprise's only source) exist once the trap finished. */
  trapAt: number | null;
  /** Flap guard: no Reprise before this instant (latest limit stop + {@link repriseBackoffMs}), null = none. */
  holdoffUntil?: number | null;
  now: number;
}

export type RunRepriseDecision =
  | { action: 'reprise' }
  | { action: 'wait'; why: 'no-trigger-member' | 'quota-not-back' | 'backoff' | 'trap-pending' };

/** Reprise the run iff EVERY triggering member's account has quota, the flap guard has elapsed and the trap's Bilans exist (or the trap is overdue). */
export function decideRunReprise(i: RunRepriseInput): RunRepriseDecision {
  if (i.verdicts.length === 0) return { action: 'wait', why: 'no-trigger-member' };
  if (!i.verdicts.every((v) => v.ok)) return { action: 'wait', why: 'quota-not-back' };
  if (i.holdoffUntil != null && i.now < i.holdoffUntil) return { action: 'wait', why: 'backoff' };
  if (i.trapAt === null && i.now < i.pausedAt + TRAP_WAIT_MAX_MS) return { action: 'wait', why: 'trap-pending' };
  return { action: 'reprise' };
}
