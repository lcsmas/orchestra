// #327: the app-bound facade of the scope stop (the logic and its unit tests live in scope-stop-host-core.ts): the REAL keeper client (the per-workspace keeper lock, the conditional keeper kill, the tracked pid) and the
// app logger plugged into the core. The explicit-stop call sites (delete, archive, clear, account migration) import ONLY from here; each entry does NOTHING for a member without a kernel scope.

import { stopMemberScope, type ScopeStopReport } from './scope-stop.ts';
import { realScopeEnv } from './memory-scope.ts';
import { killKeeperIfHeld, readTrackedKeeperPid, withKeeperLock } from './keeper-client';
import { log } from './logger';
import * as core from './scope-stop-host-core.ts';

export { SCOPE_STOP_DEADLINE_MS } from './scope-stop-host-core.ts';

const io: core.HostIo = { log, pidOf: readTrackedKeeperPid };

export const realHostDeps: core.HostDeps = {
  hasScope: (wsId) => core.memberHasScope(wsId, realScopeEnv(), log),
  lock: withKeeperLock,
  stop: (wsId, reason) => stopMemberScope(wsId, reason, core.realScopeStopDeps(wsId, io)),
  killKeeperIfHeld,
  log,
};

/** Does the member have a kernel scope (any generation)? An unreadable lookup reads as NO (said once). */
export const memberHasScope = (wsId: string): boolean => realHostDeps.hasScope(wsId);

/** Best effort, never throws; under the member's keeper lock, bounded for the caller. */
export const stopMemberScopeFor = (wsId: string, reason: string, deadlineMs = core.SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> => core.stopMemberScopeFor(wsId, reason, deadlineMs, realHostDeps);

/** THE entry of delete / archive / account migration: a member WITHOUT a scope ⇒ null and nothing at all happens; WITH one ⇒ `extra` (the stops master did not do at that site), then the scope stop. */
export const stopMemberScopeIfAny = (wsId: string, reason: string, extra?: () => Promise<void>, deadlineMs = core.SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> => core.stopMemberScopeIfAny(wsId, reason, extra, deadlineMs, realHostDeps);

/** The /clear tail of a member WITH a scope: announce first, then the old keeper, then the scope — one hold of the keeper lock (see core). */
export const clearScopedMember = (wsId: string, oldKeeperPid: number | null, announce: () => Promise<void>, deadlineMs = core.SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> => core.clearScopedMember(wsId, oldKeeperPid, announce, deadlineMs, realHostDeps);
