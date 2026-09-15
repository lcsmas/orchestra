// Which agent surface a workspace's `orchestra restart` targets.
//
// The CLI restart verb (issue #111) must relaunch a workspace's claude process
// WITHOUT touching worktree/branch/commits, and it must handle BOTH agent
// surfaces Orchestra runs:
//
//   - PTY (terminal agent): a live `claude` TUI in a node-pty, driven by the
//     renderer's TerminalView. Restart = stop the PTY + respawn it (main-side,
//     since a socket call has no renderer). `--continue` keeps the conversation.
//   - STRUCTURED (SDK session): a `claude` process driven by the Agent SDK
//     (agent-sdk.ts). Restart = sdkStop + killKeeper + ensureSession, which
//     resumes the same transcript. `--fresh` = sdkClear-equivalent (blank the
//     resume id → a vierge session).
//
// The ticket flags gap #3: the UI Restart button gates on `isRunning(id)` =
// PTY-only, so a STRUCTURED workspace silently falls through it. The CLI must
// route each surface to its own restart path — and the SEPARATION of the pure
// decision from the effectful dispatch is exactly what makes the T111.4
// structured-mode gate testable without Electron: feed this function a
// structured workspace and assert it does NOT resolve to 'pty'.
//
// This module is intentionally pure (no Electron, no fs, no process): the
// effectful handler in src/main/restart-workspace.ts feeds it liveness probes
// (`isRunning`, `sdkSessionLive`) and the persisted workspace record, then acts
// on the verdict. Kept on the shared side so the runner reaches it directly.

/** The subset of a persisted Workspace record the classifier reads. */
export interface RestartWorkspaceView {
  /** Set the first time the user submitted a prompt to the TERMINAL agent, so a
   *  respawn picks `claude --continue`. See Workspace.hasInput. */
  hasInput?: boolean;
  /** Last SDK session id. `undefined` = a structured session has NEVER run for
   *  this workspace; a string (a real id OR the `''` cleared marker) = the
   *  structured surface owns it. See Workspace.sdkSessionId. */
  sdkSessionId?: string;
}

/** Live-process probes, read at the moment restart acts (never cached — a
 *  workspace's live surface can change between the CLI call and the dispatch). */
export interface RestartLiveness {
  /** A live PTY (terminal) `claude` process owns this workspace (pty.ts
   *  `isRunning`). */
  ptyLive: boolean;
  /** A live (non-stopping) structured SDK session owns this workspace
   *  (sdk-delivery.ts `sdkSessionLive`). */
  sdkLive: boolean;
}

/** The resolved restart surface. `'unknown'` = nothing has ever run for this
 *  workspace under either surface, so there is no process to relaunch and no
 *  conversation to preserve — the caller refuses DIAGNOSABLY rather than
 *  spawning a stray agent. */
export type RestartMode = 'pty' | 'structured' | 'unknown';

/** Decide which surface `orchestra restart <id>` targets.
 *
 *  Order matters — a LIVE process wins over persisted state, because that is the
 *  process the user means when they say "restart":
 *
 *   1. A live PTY → 'pty' (restart the running terminal agent).
 *   2. A live structured session → 'structured'.
 *   3. Stopped: fall back to persisted state. `sdkSessionId` defined (a real id
 *      OR the `''` cleared marker) means the structured surface owns this
 *      workspace → 'structured' (resume it / clear it). Otherwise, `hasInput`
 *      with NO `sdkSessionId` is the terminal-only workspace → 'pty'.
 *   4. Neither surface has ever run → 'unknown'.
 *
 *  A workspace cannot be BOTH live at once in practice (one agent per worktree),
 *  but if a caller ever passes both live, PTY wins deterministically — it is the
 *  visible foreground surface.
 *
 *  NOTE the deliberate asymmetry at step 3: a STOPPED structured workspace is
 *  identified by `sdkSessionId !== undefined`, not by liveness. `''` (the
 *  sdkClear marker) still counts as structured — the workspace's surface is
 *  structured even though its conversation was cleared, so a restart should
 *  re-open a structured session, not spawn a PTY. */
export function classifyRestartMode(
  ws: RestartWorkspaceView,
  live: RestartLiveness,
): RestartMode {
  if (live.ptyLive) return 'pty';
  if (live.sdkLive) return 'structured';
  if (ws.sdkSessionId !== undefined) return 'structured';
  if (ws.hasInput === true) return 'pty';
  return 'unknown';
}

/** The side effects the restart orchestration needs. Injected so the routing —
 *  the T111.4 gate class — is testable without Electron: a stub records WHICH
 *  effect fired for a given workspace, and the must-FAIL control mutates the
 *  routing (force it to always call `restartPty`) and asserts a structured
 *  workspace is mishandled. */
export interface RestartEffects {
  /** Structured (SDK) restart: sdkStop → killKeeper → ensureSession (default,
   *  resumes the transcript) or sdkClear (fresh). */
  restartStructured(fresh: boolean): Promise<void>;
  /** PTY (terminal) restart: stop the live PTY (if any), respawn main-side with
   *  `--continue` (default) or vierge (fresh). */
  restartPty(fresh: boolean): Promise<void>;
}

/** Route a resolved {@link RestartMode} to the matching side effect. Pure
 *  routing (no Electron, no fs) — the effects are injected. Returns the mode
 *  that fired so the caller can report it. Throws on `'unknown'` (nothing to
 *  restart): the caller turns that into a diagnosable refusal.
 *
 *  This is the T111.4 gate class isolated: mutate this function to drop the
 *  `structured` branch (so it falls through to PTY) and a structured workspace
 *  is routed through `restartPty` — the must-FAIL control observes exactly that
 *  in restart-mode.test.ts. */
export async function routeRestart(
  mode: RestartMode,
  fresh: boolean,
  effects: RestartEffects,
): Promise<RestartMode> {
  if (mode === 'unknown') {
    throw new Error('no agent to restart');
  }
  if (mode === 'structured') {
    await effects.restartStructured(fresh);
    return 'structured';
  }
  await effects.restartPty(fresh);
  return 'pty';
}
