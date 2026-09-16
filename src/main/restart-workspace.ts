// `orchestra restart <id> [--fresh]` — issue #111.
//
// Relaunch a workspace's `claude` process so a fresh boot re-reads
// CLAUDE.md/settings, WITHOUT touching worktree/branch/commits. This is the
// CLI/socket surface the ticket asks for: the lifecycle had spawn and delete
// but nothing in between, so an agent could not restart a peer (or itself) by
// script.
//
// It routes BOTH agent surfaces (the ticket's gap #3 — the UI Restart button
// gates on `isRunning(id)` = PTY-only and silently skips a structured session):
//
//   - PTY (terminal agent): stop the live PTY (if any) and respawn it MAIN-SIDE
//     via startAgentPty. A socket call has no renderer, so we cannot rely on the
//     renderer-driven `pty:restart` broadcast the UI uses — startAgentPty is the
//     same respawn account-migration / wake already use headlessly. Default
//     resumes (`claude --continue`); `--fresh` launches vierge.
//   - STRUCTURED (SDK session): sdkRestart, which reuses agent-sdk's internal
//     restart recipe (sdkStop → killKeeper → ensureSession, resuming the
//     transcript) for the default, and sdkClear for `--fresh`.
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
import { isRunning, stopPty, getPtySize } from './pty';
import { startAgentPty, clearBusRunStale } from './workspaces';
import { sdkRestart } from './agent-sdk';
import { sdkSessionLive } from './sdk-delivery.ts';
import { resolveRestart, type RestartResult } from '../shared/restart-mode.ts';
import type { RestartTrigger } from '../shared/types';

export type { RestartResult } from '../shared/restart-mode.ts';

// A stopped PTY has no live winsize; a socket restart has no renderer to assert
// one. Reuse the size the terminal last had (survives stopPty in pty.ts), else
// a headless default — same fallback wakeAgentWithPrompt uses.
const RESTART_FALLBACK_COLS = 120;
const RESTART_FALLBACK_ROWS = 32;

/** Restart the workspace's agent process. `id` is a workspace id; `fresh` maps
 *  to the CLI `--fresh` flag.
 *
 *  This is the THIN Electron adapter: it resolves the store record, the live
 *  probes (`isRunning`/`sdkSessionLive`), and the real side effects, then hands
 *  them to the PURE `resolveRestart` (src/shared) which owns every guard, the
 *  mode routing, and the error wrap — so all of that has a runtime arm without
 *  Electron (issue #111 F1, restart-mode.test.ts). Neither effect runs any git
 *  op → worktree/branch/commits untouched (T111.3). */
export async function dispatchRestartRequest(input: {
  id?: string;
  fresh?: boolean;
  /** Which producer asked (issue #148) — recorded on the restart marker so the
   *  neutral row's detail names it. Defaults to `cli` (the socket verb). */
  trigger?: RestartTrigger;
}): Promise<RestartResult> {
  const id = input.id;
  const ws = id ? (store.getWorkspace(id) ?? null) : null;
  const fresh = input.fresh === true;
  const trigger: RestartTrigger = input.trigger ?? 'cli';
  const res = await resolveRestart({
    id,
    ws,
    live: { ptyLive: id ? isRunning(id) : false, sdkLive: id ? sdkSessionLive(id) : false },
    fresh,
    effects: {
      // sdkStop + killKeeper + ensureSession (default, resumes) or sdkClear (fresh).
      restartStructured: (f) => sdkRestart(id!, { fresh: f, trigger }),
      restartPty: async (f) => {
        // Stop the live process (if any), then respawn main-side. When already
        // stopped, isRunning is false and stopPty is a no-op — we just
        // (re)launch. Reuse the last known size so an open terminal keeps its
        // width across the out-of-band respawn.
        if (isRunning(id!)) stopPty(id!);
        const size = getPtySize(id!);
        await startAgentPty(
          ws!,
          size?.cols ?? RESTART_FALLBACK_COLS,
          size?.rows ?? RESTART_FALLBACK_ROWS,
          { fresh: f },
        );
      },
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
