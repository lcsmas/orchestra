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
import { startAgentPty } from './workspaces';
import { sdkRestart } from './agent-sdk';
import { sdkSessionLive } from './sdk-delivery.ts';
import {
  classifyRestartMode,
  routeRestart,
  type RestartMode,
} from '../shared/restart-mode.ts';

/** The reply the CLI renders. `ok:false` carries a human-actionable `error`
 *  (the CLI turns it into a `fail()` / non-zero exit) — never a stack trace. */
export interface RestartResult {
  ok: boolean;
  /** Which surface was restarted (only on success) — so `orchestra restart`
   *  reports "restarted (structured, conversation preserved)" honestly. */
  mode?: RestartMode;
  /** True when `--fresh` was applied (conversation cleared). */
  fresh?: boolean;
  error?: string;
}

// A stopped PTY has no live winsize; a socket restart has no renderer to assert
// one. Reuse the size the terminal last had (survives stopPty in pty.ts), else
// a headless default — same fallback wakeAgentWithPrompt uses.
const RESTART_FALLBACK_COLS = 120;
const RESTART_FALLBACK_ROWS = 32;

/** Restart the workspace's agent process. `id` is a workspace id; `fresh` maps
 *  to the CLI `--fresh` flag. */
export async function dispatchRestartRequest(input: {
  id?: string;
  fresh?: boolean;
}): Promise<RestartResult> {
  const id = input.id;
  if (!id) return { ok: false, error: 'missing id' };
  const ws = store.getWorkspace(id);
  if (!ws) {
    // Diagnosable, not a stack trace (T111.1): the caller passed an id that is
    // not a workspace, or is stale.
    return { ok: false, error: `unknown workspace: ${id}` };
  }
  if (ws.archived) {
    return { ok: false, error: `workspace is archived: ${id} — cannot restart` };
  }
  const fresh = input.fresh === true;
  const mode = classifyRestartMode(ws, {
    ptyLive: isRunning(id),
    sdkLive: sdkSessionLive(id),
  });

  if (mode === 'unknown') {
    // Nothing has ever run under either surface — there is no process to
    // relaunch and no conversation to preserve. Refuse rather than spawn a
    // stray agent nobody asked to start.
    return {
      ok: false,
      error:
        `workspace ${id} has no agent to restart yet ` +
        `(no terminal or structured session has run). Open it first.`,
    };
  }

  try {
    // routeRestart is the pure routing (src/shared) that the T111.4 gate class
    // pins; here we inject the real effects. Never touches worktree/branch/
    // commits — neither branch runs any git op.
    await routeRestart(mode, fresh, {
      restartStructured: (f) =>
        // sdkStop + killKeeper + ensureSession (default, resumes) or sdkClear (fresh).
        sdkRestart(id, { fresh: f }),
      restartPty: async (f) => {
        // Stop the live process (if any), then respawn main-side. When already
        // stopped, isRunning is false and stopPty is a no-op — we just
        // (re)launch. Reuse the last known size so an open terminal keeps its
        // width across the out-of-band respawn.
        if (isRunning(id)) stopPty(id);
        const size = getPtySize(id);
        await startAgentPty(
          ws,
          size?.cols ?? RESTART_FALLBACK_COLS,
          size?.rows ?? RESTART_FALLBACK_ROWS,
          { fresh: f },
        );
      },
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`restart: ${mode} restart failed for ${id}: ${message}`);
    return { ok: false, error: `restart failed: ${message}` };
  }

  log.info(`restart: ${id} (${mode}${fresh ? ', fresh' : ', conversation preserved'})`);
  return { ok: true, mode, fresh };
}
