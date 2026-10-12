// `orchestra restart <id> [--fresh]` — issue #111.
//
// Relaunch a workspace's `claude` process so a fresh boot re-reads
// CLAUDE.md/settings, WITHOUT touching worktree/branch/commits. This is the
// CLI/socket surface the ticket asks for: the lifecycle had spawn and delete
// but nothing in between, so an agent could not restart a peer (or itself) by
// script.
//
// The Agent view is the only agent mode (#219/#230/#232), so a restart has two
// routes (there is no PTY route any more):
//
//   - STRUCTURED (SDK session): sdkRestart, which reuses agent-sdk's internal
//     restart recipe (sdkStop → killKeeper → ensureSession, resuming the
//     transcript) for the default, and sdkClear for `--fresh`.
//   - WAKE (#228): a stopped LEGACY terminal-only workspace (hasInput, no
//     sdkSessionId) — sdkWakeRestart adopts its terminal transcript, then sdkRestart.
//
// The pure surface decision lives in src/shared/restart-mode.ts so it is
// testable without Electron (classifyRestartMode); this module wires the live
// probes and effects around it.
//
// #124 BOUNDARY: the structured path calls sdkStop/ensureSession/killKeeper
// through the sdkRestart export in agent-sdk.ts and modifies none of them
// (issue #124 owns sdkStop/consume). This module adds no schema and no new
// lifecycle semantics.

import { store } from './store';
import { log } from './logger';
import { clearBusRunStale, startWorkspaceAgentHeadless } from './workspaces';
import { sdkRestart, sdkWakeRestart } from './agent-sdk';
import { sdkSessionLive, sdkFirstTurnFailed } from './sdk-delivery.ts';
import { resolveRestart, type RestartResult } from '../shared/restart-mode.ts';
import { sandboxPausedMessage } from '../shared/sandbox-pause.ts';
import { pauseRefusal } from './pause-gate.ts';
import { admissionGate } from './admission.ts';
import { reportAdmissionFailure } from './workspaces';
import { heldPhrase } from '../shared/admission.ts';
import { canOrchestrate } from '../shared/types';
import type { PauseOrigin } from '../shared/bus-pause.ts';
import { restartOwesOpeningTask } from '../shared/opening-task.ts';
import type { RestartTrigger } from '../shared/types';

export type { RestartResult } from '../shared/restart-mode.ts';

/** Restart the workspace's agent process. `id` is a workspace id; `fresh` maps
 *  to the CLI `--fresh` flag.
 *
 *  This is the THIN Electron adapter: it resolves the store record, the live
 *  probe (`sdkSessionLive`), and the real side effects, then hands them to the
 *  PURE `resolveRestart` (src/shared) which owns every guard, the mode routing,
 *  and the error wrap — so all of that has a runtime arm without Electron
 *  (issue #111 F1, restart-mode.test.ts). Neither effect runs any git op →
 *  worktree/branch/commits untouched (T111.3). */
export async function dispatchRestartRequest(input: {
  id?: string;
  fresh?: boolean;
  /** Which producer asked (issue #148) — recorded on the restart marker so the
   *  neutral row's detail names it. Defaults to `cli` (the socket verb). */
  trigger?: RestartTrigger;
  /** INTERNAL (#286): this restart is the RELEASE of a held one — it must not be held again. */
  admitted?: boolean;
}): Promise<RestartResult> {
  const id = input.id;
  const ws = id ? (store.getWorkspace(id) ?? null) : null;
  const fresh = input.fresh === true;
  const trigger: RestartTrigger = input.trigger ?? 'cli';
  // #226: sandbox agents are paused — refuse BEFORE the classifier so `--fresh` (sdkClear), a legacy hasInput/no-session ws (wake route) and recordRestart's state write are all covered.
  const paused = sandboxPausedMessage(ws);
  if (paused) return { ok: false, error: paused };
  // #252 fleet PAUSE (ledger #261 rows 5/6/7): the toolbar Restart is a HUMAN act (allowed, un-pauses nothing); `orchestra restart`
  // and the re-parent restart are AUTO and refused here — BEFORE the classifier and any stop, so a refusal never stops a running session.
  const restartOrigin: PauseOrigin = trigger === 'toolbar' ? 'human' : 'auto';
  const pausedRun = pauseRefusal(ws, restartOrigin);
  if (pausedRun) return { ok: false, error: pausedRun };
  // #286 Admission: under low memory an AUTOMATIC restart of a fleet member WAITS — BEFORE the classifier and any stop, so a held restart never
  // stops a running session. The toolbar Restart is a human act and passes. The release re-enters here with `admitted`.
  if (!input.admitted && id && ws) {
    const liveAtHold = sdkSessionLive(id);
    const gate = admissionGate({
      wsId: id,
      ws,
      origin: restartOrigin,
      kind: 'restart',
      coordinator: canOrchestrate(ws),
      run: () => dispatchRestartRequest({ id, fresh, trigger, admitted: true }),
      retryLater: () => pauseRefusal(store.getWorkspace(id) ?? null, restartOrigin) !== null,   // a fleet Pause refused the release: keep the slot
      report: (text) => reportAdmissionFailure(id, text),
      stillOwed: () => {
        const w = store.getWorkspace(id);
        // A member that was STOPPED when its restart was held and that a person has since started (the composer reaches `sdkSend` without
        // passing the two gates) needs no restart any more — it would be a redundant stop/start at recovery (review F4).
        return !!w && !w.archived && (liveAtHold || !sdkSessionLive(id));
      },
    });
    if (gate.held) return { ok: true, held: { since: gate.since }, note: heldPhrase('restart', gate.since) };
  }
  const live = { sdkLive: id ? sdkSessionLive(id) : false, sdkFailed: id ? sdkFirstTurnFailed(id) : false };
  // #227: a kept child whose SDK start failed owes its task and nothing ever ran (the classifier would say 'unknown'):
  // Restart retries THAT start, delivering the task once.
  const owed = !!(id && ws && restartOwesOpeningTask(ws, live));
  // ONE result, so the res.ok-gated stale-clear below covers both routes.
  let res: RestartResult;
  if (owed) res = await retryOpeningTask(id!, fresh, restartOrigin, input.admitted === true);
  else res = await resolveRestart({
    id,
    ws,
    live,
    fresh,
    effects: {
      // sdkStop + killKeeper + ensureSession (default, resumes) or sdkClear (fresh).
      restartStructured: (f) => sdkRestart(id!, { fresh: f, trigger }),
      // #228 — a legacy terminal-only workspace (hasInput, no sdkSessionId): the SDK
      // wake path adopts its terminal transcript, then the session restarts in the
      // Agent view. No PTY is launched.
      restartWake: (f) => sdkWakeRestart(id!, { fresh: f, trigger }),
    },
    onError: (mode, message) => log.warn(`restart: ${mode} restart failed for ${id}: ${message}`),
  });
  // #142 (REVIEW-142 F2) — the relaunch re-reads ORCHESTRA_RUN_ID (env rebuilt
  // from resolveWaveRunId at every launch), so a --no-restart re-parent's 'stale
  // run' block is resolved BY a successful restart. Clear the marker + flag ONLY
  // when the restart SUCCEEDED — mirroring the reconcile path (workspaces.ts,
  // which clears on `res.ok`). Clearing before/regardless would, if the relaunch
  // throws, drop the marker while the OLD session is still on the OLD run →
  // sends unblocked into the stale run (the exact fault the marker prevents).
  if (id && ws && res.ok) await clearBusRunStale(id);
  return res;
}

/** #227 — retry a kept child's SDK start (same operation as spawn); `fresh` is moot: nothing to keep or clear. */
async function retryOpeningTask(id: string, fresh: boolean, origin: PauseOrigin, admitted = false): Promise<RestartResult> {
  // #286: a RELEASED restart (`admitted`) must not be held a second time by the spawn gate inside this start.
  const started = await startWorkspaceAgentHeadless(id, origin, admitted);
  if (started.ok) return { ok: true, mode: 'structured', fresh, openingTask: true, ...(started.note ? { note: started.note } : {}) };
  log.warn(`restart: opening-task retry failed for ${id}: ${started.error}`);
  return { ok: false, error: `restart failed: ${started.error}` };
}
