import { randomUUID } from 'node:crypto';
import { spawn } from 'node:child_process';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
// TYPE-ONLY import: erased at compile time, so it emits NO runtime require().
// @anthropic-ai/claude-agent-sdk is a pure-ESM package (type:module, exports
// only ./sdk.mjs, no CJS entry). Because it's externalized, a static value
// import would become `require("…")` in the CJS main bundle and crash Electron
// at boot with ERR_REQUIRE_ESM. The `query` VALUE is loaded via a cached
// dynamic import() instead (see {@link loadSdk}) — the one form Node can use to
// pull ESM from CJS.
import type {
  Query,
  SDKUserMessage,
  PermissionResult,
  RewindFilesResult,
} from '@anthropic-ai/claude-agent-sdk';
import { platform } from './platform';
import { store } from './store';
import { log, scoped } from './logger';

/** SDK-scoped logger. The structured agent view spans two processes (events are
 *  produced here, folded in the renderer), so attributing a wrong pane to the
 *  producer or the consumer needs a record of what was actually emitted. */
const slog = scoped('sdk');
import {
  installOrchestraHooks,
  workspaceAccountConfigDir,
  mangleProjectDir,
  autoRenameActive,
  orchestratorBrief,
} from './workspaces';
import { transcriptToEvents, HISTORY_SEQ_BASE } from '../shared/agent-transcript';
import { scopeSessionsToWorktree, type SessionCandidate } from '../shared/session-discovery';
import {
  normalizeLiveContextUsage,
  type ContextUsage,
  type LiveContextUsagePayload,
} from '../shared/context-usage';
import {
  isPluginReloadFailure,
  summarizeReload,
  type ReloadResult,
} from '../shared/reload-skills';
import { withCrossSessionInboundPolicy } from '../shared/cross-session-inbound';
import { syncAccountInheritance } from './account-inherit';
import { agentCliBinDir } from './cli-shim';
import { getHookSocketPath } from './hooks-server';
import { isRunning as isPtyRunning } from './pty';
import { getEventsDir } from './events-spool';
import {
  reconcileExited,
  applyAgentEvent,
  fireNeedsInput,
  resumeRunning,
  markLooping,
} from './activity';
import { makeKeeperSpawn, killKeeper, probeKeeper } from './keeper-client';
import { registerSdkDelivery } from './sdk-delivery';
import { clearHibernated } from './hibernation.ts';
import { buildBrowserToolServer } from './agent-browser-tools';
import {
  normalizeSdkMessage,
  makePermissionRequest,
  describeMcpServer,
  firstHttpUrl,
  makeUserMessage,
  makeLocalCommand,
  shouldAutoApprovePermission,
  isBadResumeError,
  sdkEventToStatusEvent,
  sdkEventToStopReason,
  stamp,
  supportsCancelQueued,
  type NormalizeContext,
  type SdkMessage,
} from '../shared/agent-events';
import { findOversizedMemoryFiles } from './memory-files.ts';
import { contextWindowFromModelId } from '../shared/memory-size.ts';
import type {
  AgentEffortLevel,
  AgentEvent,
  AgentInitEvent,
  AgentImage,
  AgentMcpServer,
  AgentPermissionMode,
  AgentModelInfo,
  AgentPermissionReply,
  AgentSessionRewindEvent,
  AgentSkillInfo,
  AgentStopReason,
  RemoteControlState,
  Workspace,
} from '../shared/types';

// ─── Structured-agent-view session manager ───────────────────────────────────
//
// One long-lived Claude Agent SDK `query()` per workspace drives the structured
// agent view. Where the terminal path (pty.ts / startAgentPty) spawns the
// interactive `claude` TUI and scrapes ANSI, this spawns the SAME agent loop as
// a subprocess through the SDK and gets typed, structured messages back. We
// normalize each SDK message into Orchestra's own {@link AgentEvent} contract
// (src/shared/agent-events.ts — pure + tested) and broadcast it on the
// `agent:event` channel so the renderer can fold it into a live view.
//
// Design decisions, all grounded in the Phase 0 spike (docs/spikes/
// phase0-sdk-findings.md), which the plan's assumptions defer to:
//   • Multi-turn is STREAMING-INPUT (spike h): one `query()` per session, fed by
//     an async-generator prompt. Each follow-up turn is gated on the prior turn's
//     `result` message so the subprocess stays warm and `canUseTool` fires
//     in-loop. We implement the generator as a hand-rolled queue with a "turn
//     boundary" gate {@link Session.turnGate}.
//   • interrupt() makes the `for await` consume loop THROW (spike d,
//     `error_during_execution`). The loop is wrapped in try/catch and an
//     interrupt is treated as an expected terminal state, not a crash.
//   • Transient API 500s arrive as normal `result` messages with `is_error:true`
//     (spike note 6), NOT thrown — the manager surfaces them and lets the user
//     re-send. (Full auto-retry/backoff is a Phase-6 refinement; here we surface
//     gracefully and keep the session alive.)
//   • Env parity with the terminal spawn: same account CLAUDE_CONFIG_DIR, same
//     hook install, same account-inheritance sync as startAgentPty, so the
//     structured session behaves like the interactive one.
//
// Lifecycle: lazy — a session starts only when the renderer first sends a turn
// (or explicitly starts one) to a workspace. It stays alive across turns until
// stopped, interrupted, or the workspace is removed.

/** The SDK's `query` factory signature (mirrors the module's export). Declared
 *  locally so nothing here depends on a runtime import of the ESM package. */
type QueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Record<string, unknown>;
}) => Query;

/** The SDK's `listSessions` signature (mirrors the module's export). Declared
 *  locally for the same reason as {@link QueryFactory}: no runtime import of
 *  the ESM package leaks into this CJS module's type graph.
 *
 *  NOTE the option bag has NO `configDir` — session discovery reads
 *  `process.env.CLAUDE_CONFIG_DIR` instead. See {@link withAccountConfigDir}. */
type ListSessionsFn = (options?: {
  dir?: string;
  limit?: number;
  offset?: number;
  includeWorktrees?: boolean;
  includeProgrammatic?: boolean;
}) => Promise<SessionCandidate[]>;

/** Cached dynamic import of the pure-ESM SDK. `import()` is the only construct
 *  that can pull an ESM package from this CJS bundle; a static import would
 *  compile to `require()` and crash Electron at boot (ERR_REQUIRE_ESM). Cached
 *  so the subprocess-heavy module loads exactly once. */
let sdkModule: { query: QueryFactory; listSessions: ListSessionsFn } | null = null;
async function loadSdk(): Promise<{ query: QueryFactory; listSessions: ListSessionsFn }> {
  if (!sdkModule) {
    sdkModule = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      query: QueryFactory;
      listSessions: ListSessionsFn;
    };
  }
  return sdkModule;
}

/** Test seam: override the SDK's `listSessions` (so unit tests can exercise the
 *  discovery/fallback logic without a real `~/.claude` on disk). */
let listSessionsOverride: ListSessionsFn | null = null;
export function __setListSessionsForTests(fn: ListSessionsFn | null): void {
  listSessionsOverride = fn;
}

/** Test seam: override the SDK `query` factory (so e2e/tests can inject a fake
 *  that yields canned SDK messages without spawning a real `claude`). When set,
 *  {@link ensureSession} uses it instead of the dynamically-imported real one. */
let queryOverride: QueryFactory | null = null;
export function __setQueryFactoryForTests(factory: QueryFactory | null): void {
  queryOverride = factory;
}

interface Session {
  wsId: string;
  q: Query;
  /** The seq/clock cursor threaded through every normalize call for this
   *  session, so events carry a monotonic seq. */
  ctx: NormalizeContext;
  /** Pending user turns not yet yielded to the SDK. The async-generator prompt
   *  drains this; {@link Session.pump} wakes it when a new turn arrives. */
  queue: SDKUserMessage[];
  /** Resolver for the generator's current await — called to hand it the next
   *  queued message (or signal shutdown). */
  pump: (() => void) | null;
  /** Resolves when the in-flight turn's `result` message is observed, so the
   *  generator gates the next turn on turn completion (spike h). Null between
   *  turns. */
  turnGate: (() => void) | null;
  /** Parked `canUseTool` calls keyed by requestId; the renderer resolves each
   *  via {@link permissionReply}. */
  pending: Map<string, (result: PermissionResult) => void>;
  /** Set once stop()/removal is requested so the generator ends cleanly. */
  stopping: boolean;
  /** The live permission mode, echoed into new-turn behavior. */
  permissionMode: AgentPermissionMode;
  /** The SDK session id last persisted to `ws.sdkSessionId`, to avoid rewriting
   *  the store on every message (the id is stable across a session's turns). */
  persistedSessionId?: string;
  /** Whether THIS session must drive the sidebar status dot itself from its event
   *  stream (`driveStatusFromEvent`), captured once at spawn. True in exactly ONE
   *  case — a LOCAL workspace where a terminal PTY already owned the events spool,
   *  so `buildSdkEnv` withheld `ORCHESTRA_WS_ID`, the SDK's own shell hooks no-op,
   *  and (the PTY being an idle Raw tab) nobody else moves the dot: the "SDK view
   *  idle while working" bug. False when:
   *    • no PTY coexists → the SDK got `ORCHESTRA_WS_ID`, its hooks write the spool
   *      and the tailer drives the dot (direct-driving too would double-fire);
   *    • the workspace is REMOTE → the container's spool tail drives it over the
   *      wire (sandbox-manager `onEvent`), likewise not to be double-driven.
   *  Fixed for the subprocess's life: a PTY starting/stopping later doesn't change
   *  what env THIS subprocess was given. `= !remote && isPtyRunning(ws.id)` at
   *  spawn, i.e. local-and-spool-withheld (see buildSdkEnv, which returns it). */
  driveStatus: boolean;
  /** Last Remote Control state emitted for this session, so a fresh `ensureSession`
   *  (e.g. after the view re-mounts and re-sends) can re-broadcast it and the
   *  toggle survives. Undefined until the user first enables it. */
  remoteControl?: RemoteControlState;
  /** Output from `!command` bash-mode runs (composer bash mode) not yet handed to
   *  the model. Parity with Claude Code: a local command runs immediately and its
   *  command+output are added to the conversation as CONTEXT, seen by the agent on
   *  its NEXT real turn (never a turn of their own). {@link sdkSend} drains this and
   *  prepends it (as `<local-command-stdout>` blocks) to the next user message. */
  pendingLocalContext: string[];
  /** Set by {@link sdkInterrupt} just before calling the SDK's `interrupt()`, so
   *  the consume loop's catch can label the resulting throw "interrupted" from
   *  OUR OWN action instead of pattern-matching /abort/ against arbitrary error
   *  text (which relabeled genuine crashes as interrupts). */
  interruptRequested?: boolean;
  /** The last few user texts sdkSend fed the generator, so emitFrom can drop a
   *  hypothetical stream replay of a LOCALLY-sent prompt (the spike says the
   *  stream never replays them; this is the belt-and-braces for a future SDK
   *  that does). Externally-originated user text (Remote Control, channel) is
   *  never in here and always renders. */
  recentEchoes: string[];
  /** Set once the oversized-memory warning has been emitted for this session.
   *  The CLI re-sends `system/init` at the start of EVERY request, so without
   *  this the banner would re-announce on every turn — the same noise that got
   *  per-init MCP notices rejected (see the init branch in agent-events.ts). */
  memoryWarned?: boolean;
  /** Protocol capabilities the CLI advertised on `system/init`, so control
   *  requests can be feature-detected instead of assumed. Measured at CLI
   *  2.1.241: `["interrupt_receipt_v1","interrupt_cancel_queued_v1",
   *  "msg_lifecycle_v1"]`. Undefined until the first init lands — treat that
   *  as "no capabilities", never as "assume supported". */
  capabilities?: string[];
  /** Set by {@link sdkClear}: the user cleared the conversation, so the dying
   *  session's tail events (interrupt error, synthetic turn-end, stray stream
   *  messages) must NOT be emitted — they'd land AFTER the `session/clear`
   *  reset and dirty the fresh transcript. */
  cleared?: boolean;
}

const sessions = new Map<string, Session>();

/** Per-workspace event cursors, kept ALIVE across session teardown.
 *
 *  `seq` is not just gap-detection bookkeeping: every RenderMessage id the fold
 *  mints is derived from it (`user:<seq>`, `error:<seq>`, `notice:<seq>`,
 *  `<sessionId>:<seq>:<index>`), and those ids are the renderer's React keys,
 *  measured-height cache keys and scroll-anchor keys.
 *
 *  A Session object dies on every teardown — hibernation sweep, `sdkStop`, a
 *  crashed subprocess — while the RENDERER's folded transcript survives (it is
 *  store state, not pane state). Minting a fresh `{seq: 0}` per Session
 *  therefore restarted id numbering in the middle of a transcript that still
 *  held the earlier rows: waking a hibernated workspace and sending one message
 *  produced a second `user:0` at the bottom of a list whose top was already
 *  `user:0`. `StructuredView`'s anchor lookup resolves an id to its FIRST
 *  occurrence, so scrolling up a little from the bottom jumped to the very
 *  beginning of the transcript.
 *
 *  Keeping ONE cursor per workspace for the app's lifetime makes seq monotonic
 *  across session restarts, so ids stay unique for as long as the transcript
 *  they key does. It is never reset — not even on `sdkClear`: reuse only ever
 *  risks collisions, and a monotonic counter also makes the renderer's
 *  `lastSeq` gap detection meaningful across a restart. */
const seqCursors = new Map<string, NormalizeContext>();

/** The (monotonic, never-reset) event cursor for a workspace. */
function cursorFor(wsId: string): NormalizeContext {
  let ctx = seqCursors.get(wsId);
  if (!ctx) {
    ctx = { seq: 0 };
    seqCursors.set(wsId, ctx);
  }
  return ctx;
}

/** Pending `resumeSessionAt` cuts, keyed by workspace — set by {@link sdkRewind}
 *  and consumed by the very next {@link ensureSession}.
 *
 *  A rewind can't truncate a RUNNING session: the cut is a `query()` START
 *  option, so the flow is stop-now / restart-truncated-later. Rather than
 *  eagerly respawning a subprocess the user may not need (they might rewind and
 *  walk away), the cut is parked here and applied lazily when the next send
 *  rebuilds the session — matching how `resume` itself is lazy. Consumed
 *  read-and-delete so it can never apply twice. */
const rewindResumeAt = new Map<string, string>();

/** Broadcast one normalized event to the renderer. */
function emit(wsId: string, event: AgentEvent): void {
  // Single choke point for the whole structured-view event stream. Tracing here
  // gives an exact, ordered record of what the renderer's fold was fed — which
  // is the only way to tell a BACKEND bug (never emitted) from a RENDERER bug
  // (emitted, mis-folded) when the agent pane shows something wrong. Those two
  // are otherwise indistinguishable from the UI, and they live in different
  // processes. Errors are always logged: they are low-volume and load-bearing.
  if (event.type === 'error') {
    slog.warn(
      `emit error event ws=${wsId} seq=${event.seq}: ${(event as { message?: string }).message ?? ''}`,
    );
  } else if (slog.traceEnabled()) {
    slog.trace(`emit ${event.type} ws=${wsId} seq=${(event as { seq?: number }).seq ?? '?'}`);
  }
  platform.broadcast('agent:event', wsId, event);
}

/** Find the `claude` executable on the session env's PATH (the shim dir the
 *  env prepends holds only the `orchestra` CLI, so this lands on the user's
 *  real install). Returns null when absent — callers fall back to the SDK's
 *  bundled default, which only works outside the packaged asar. */
function resolveClaudeBinary(env: Record<string, string>): string | null {
  for (const dir of (env.PATH ?? '').split(path.delimiter)) {
    if (!dir) continue;
    const candidate = path.join(dir, 'claude');
    try {
      fs.accessSync(candidate, fs.constants.X_OK);
      return candidate;
    } catch {
      /* keep looking */
    }
  }
  return null;
}

/** Drive the sidebar status dot from the SDK event stream.
 *
 *  WHY THIS EXISTS: in the terminal path the dot is fed by the durable events
 *  spool — shell hooks (UserPromptSubmit/PreToolUse/PostToolUse/Stop) that
 *  Claude Code fires and that append `submit`/`pretool`/`posttool`/`stop` lines
 *  the tailer replays into `applyAgentEvent`. The Claude Agent SDK's `query()`
 *  runs turns programmatically (streaming-input generator) and does NOT fire
 *  those per-turn lifecycle hooks — verified on a live structured session whose
 *  spool held only the one `session/startup` line while the agent worked and
 *  spawned subagents, so the dot stayed `idle` the whole turn. (The exit case
 *  was already known-unreliable — see the `reconcileExited` floor in consume().)
 *  So a structured-only session must feed the SAME status state machine itself,
 *  mapping its own AgentEvents onto the spool events `applyAgentEvent` expects.
 *
 *  GATED on `session.driveStatus` — the SINGLE-WRITER invariant, fixed at spawn:
 *    • driveStatus=false, no PTY → the SDK got `ORCHESTRA_WS_ID`, so its OWN shell
 *      hooks write `submit`/`pretool`/`stop` to the spool and the tailer drives the
 *      dot. Direct-driving here too would DOUBLE-fire every transition (e.g. two
 *      turn-end chimes) — so we skip.
 *    • driveStatus=true (LOCAL + a coexisting PTY owns the spool) → the SDK's hooks
 *      are withheld (no `ORCHESTRA_WS_ID`) and no-op; that PTY is usually an idle Raw
 *      tab doing no turns, so NOBODY drives the dot and it sticks `idle` while the SDK
 *      works — the reported bug. Here direct-drive is the ONLY driver, so we run it.
 *    • driveStatus=false, REMOTE → the container's spool tail drives the dot over the
 *      wire (sandbox-manager `onEvent → applyAgentEvent`); we must not double-drive.
 *  Evaluating this per-event via `isPtyRunning` was wrong: a PTY that starts or stops
 *  after the SDK session began does not change what env THIS subprocess got, and the
 *  per-event read (a) skipped the whole PTY-coexist bug case and (b) double-drove the
 *  common no-PTY case (masked only by setStatus idempotency).
 *
 *  Transcript is passed `undefined`: `emitContext` no-ops without it, and the
 *  structured view's context badge is already driven by the SDK usage path
 *  (`agent:context`/TurnFooter), not the transcript-tail recompute. The pure
 *  event→spool-event mapping lives in `sdkEventToStatusEvent` (agent-events.ts)
 *  so it is unit-tested without Electron; the `tool` label (for `pretool`) is
 *  the only per-event datum threaded through here. */
function driveStatusFromEvent(session: Session, ev: AgentEvent): void {
  // Single-writer: only drive the dot when nothing else will (see doc above).
  if (!session.driveStatus) return;
  const spoolEvent = sdkEventToStatusEvent(ev);
  if (!spoolEvent) return;
  const tool = ev.type === 'tool-use' ? ev.name : undefined;
  // Thread the turn-end reason through (undefined for every non-terminal event).
  // The SDK path is the only one that HAS a reason — Claude Code's Stop hook
  // carries no equivalent field — so this is where end_turn / interrupted /
  // max_turns / error stop being collapsed into one indistinguishable `waiting`.
  applyAgentEvent(session.wsId, spoolEvent, tool, undefined, sdkEventToStopReason(ev));
}

/** Normalize an SDK message and broadcast every event it produces, and (when this
 *  session must, i.e. its spool hooks are withheld) drive the sidebar status dot
 *  off the same stream — see driveStatusFromEvent for the single-writer gate. */
function emitFrom(session: Session, msg: SdkMessage): void {
  // A cleared session's tail must stay silent — the transcript was reset.
  if (session.cleared) return;
  for (const ev of normalizeSdkMessage(msg, session.ctx)) {
    // Drop a stream replay of a LOCALLY-sent prompt: sdkSend already echoed it
    // (the transcript's record), so re-rendering it would duplicate the bubble.
    // Normalize only surfaces stream user TEXT for externally-originated turns
    // (Remote Control, channel, CLI-injected) — this guard is for the case
    // where a future SDK starts replaying local input too.
    if (ev.type === 'user-message' && !ev.origin) {
      const i = session.recentEchoes.indexOf(ev.text);
      if (i !== -1) {
        session.recentEchoes.splice(i, 1);
        continue;
      }
    }
    // A USER-requested interrupt ends the turn with an `is_error` result
    // (subtype error_during_execution) whose normalized error read "agent turn
    // errored (error_during_execution)" — a red banner for the routine mechanics
    // of the stop the user just asked for. The stream's own interrupt marker
    // (rendered as an `interrupted` notice) is the transcript's record, so drop
    // the redundant error. A genuine EDE crash (no interrupt requested) still
    // renders; the flag resets at the result boundary in consume().
    if (
      ev.type === 'error' &&
      session.interruptRequested &&
      /error_during_execution|ede_diagnostic/i.test(ev.message)
    ) {
      continue;
    }
    emit(session.wsId, ev);
    // Loop tracking: the SDK path is the only one that sees a tool call's full
    // INPUT, so it alone can catch `ScheduleWakeup({stop: true})` — the /loop
    // skill's own termination. The SET side ('ScheduleWakeup' fired at all)
    // rides the shared `pretool` chokepoint in activity.ts, which this event
    // also reaches via driveStatusFromEvent/the spool; markLooping is
    // idempotent, so the paths can overlap safely. Deliberately OUTSIDE the
    // driveStatus single-writer gate: that gate exists to avoid double-DRIVING
    // the status dot, but the loop flag is a store field with its own
    // no-change guard.
    if (ev.type === 'tool-use' && ev.name === 'ScheduleWakeup') {
      void markLooping(session.wsId, ev.input?.stop !== true);
    }
    driveStatusFromEvent(session, ev);
    if (ev.type === 'session/init') {
      // Feature-detection state for control requests. `system/init` repeats on
      // EVERY request, so this re-latches each turn — deliberately, since a
      // reconnect/keeper-reattach can land on a different CLI build than the
      // one that started the session.
      session.capabilities = ev.capabilities ?? [];
      emitMemoryWarning(session, ev);
    }
  }
}

/** Emit the oversized-memory warning the CLI shows in its startup banner but
 *  never puts on the wire (see src/shared/memory-size.ts for why we recompute
 *  it). Fires at most ONCE per session: `system/init` repeats on every request,
 *  and a per-turn re-announcement is the noise that got per-init MCP notices
 *  rejected. Measuring is a few small file reads, so it stays on this path. */
function emitMemoryWarning(session: Session, ev: AgentInitEvent): void {
  if (session.memoryWarned) return;
  session.memoryWarned = true;
  const paths = ev.memoryPaths ?? [];
  if (!paths.length) return;
  let over: ReturnType<typeof findOversizedMemoryFiles>;
  try {
    over = findOversizedMemoryFiles(paths, contextWindowFromModelId(ev.model));
  } catch (e) {
    // A warning about context is never worth breaking the session for.
    slog.warn(`memory-size check failed: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  if (!over.length) return;
  emit(
    session.wsId,
    stamp(session.ctx, {
      type: 'session/memory-size',
      // Shorten paths under $HOME the way the CLI relativizes against cwd —
      // the full path is noise in a one-line banner.
      files: over.map((f) => ({ path: tildePath(f.path), chars: f.chars, limit: f.limit })),
    }),
  );
}

/** `/home/x/.claude/LESSONS.md` -> `~/.claude/LESSONS.md`. */
function tildePath(p: string): string {
  const home = os.homedir();
  return home && p.startsWith(home + path.sep) ? `~${p.slice(home.length)}` : p;
}

/** Build the SDK env for a workspace, matching startAgentPty's plumbing: the
 *  pinned account's CLAUDE_CONFIG_DIR (so the agent logs in as that account),
 *  with CLAUDE_CONFIG_DIR otherwise UNSET so a leftover value from Orchestra's
 *  own environment can't silently retarget the session (self-tune.ts:201-206). */
/** Build the SDK subprocess env AND report whether this session must drive the
 *  status dot itself (`driveStatus`) — true ONLY for a LOCAL workspace where a
 *  terminal PTY already owns the spool, so `ORCHESTRA_WS_ID` is withheld, the SDK's
 *  own hooks no-op, and nobody else moves the dot. False otherwise (no PTY → SDK
 *  hooks + tailer drive it; remote → the container's spool tail drives it). The
 *  caller stores this on the Session for `driveStatusFromEvent` (see that function). */
function buildSdkEnv(ws: Workspace): { env: Record<string, string>; driveStatus: boolean } {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  delete env.CLAUDE_CONFIG_DIR;
  // Orchestra-launched-from-Orchestra (or from any agent shell) inherits the
  // PARENT session's ORCHESTRA_WS_ID / ORCHESTRA_EVENTS_DIR through process.env.
  // These are spool-ownership vars we assign deliberately below (only when
  // `ownsSpool`), so a stale inherited value must NOT survive: the `orchestra`
  // CLI resolves the caller via ORCHESTRA_WS_ID FIRST (resolveSelfWorkspaceId),
  // so a leaked parent id makes `whoami`/`peers`/`rename`/`message`/`spawn`
  // resolve to the WRONG workspace (the parent's) — observed live as
  // `orchestra whoami` printing `id  <parent-id>` (→ empty record) from an
  // orchestrator's structured session. Delete them up front (like
  // CLAUDE_CONFIG_DIR) so ONLY the explicit `if (ownsSpool)` assignment governs
  // them; identity always flows through ORCHESTRA_WS_ID_IDENTITY (set
  // unconditionally below). Mirrors the terminal path, which always overwrites
  // ORCHESTRA_WS_ID with this workspace's id (pty.ts) and so never leaks.
  delete env.ORCHESTRA_WS_ID;
  delete env.ORCHESTRA_EVENTS_DIR;
  // Same hygiene for the hook socket: a stale inherited path must not leak
  // into a child whose own assignment below is the source of truth. (The
  // value set below is durable across app restarts — hooks-server binds a
  // STABLE per-ORCHESTRA_HOME socket precisely so a keeper-surviving CLI's
  // frozen env keeps resolving the CURRENT app instance.)
  delete env.ORCHESTRA_SOCK;
  const configDir = workspaceAccountConfigDir(ws, undefined);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  env.ORCHESTRA_BRANCH = ws.branch;
  env.ORCHESTRA_KIND = ws.kind ?? 'worktree';
  // Auto-rename gate parity with startAgentPty (workspaces.ts): the SessionStart
  // /UserPromptSubmit rename-instruction hook hard-gates on
  // `ORCHESTRA_BRANCH_AUTO=1` and reads `ORCHESTRA_AUTO_RENAME_COUNT` to pick the
  // stage-appropriate wording. Without these the nudge self-suppresses (defaults
  // to 0/off) even once the `'local'` hooks load — so a structured session's
  // branch would never get auto-renamed. autoRenameActive() is the single source
  // of truth (a human-pinned name or a spent rename budget turns it off).
  env.ORCHESTRA_BRANCH_AUTO = autoRenameActive(ws) ? '1' : '0';
  env.ORCHESTRA_AUTO_RENAME_COUNT = String(ws.autoRenameCount ?? 0);

  // CLI-identity parity with startAgentPty, PLUS the activity spool when this SDK
  // session is the SOLE driver of the workspace.
  //
  // ORCHESTRA_WS_ID USED TO BE DUAL-PURPOSE and that overload was a bug. The
  // generated activity hook writes the durable events spool for any process
  // where ORCHESTRA_WS_ID is set (`[ -n "$ORCHESTRA_WS_ID" ] || exit 0` — its
  // ONLY gate), keyed by `<wsId>.jsonl` + a `<wsId>.seq` counter; the `orchestra`
  // CLI ALSO read it for identity. The hazard is a COEXISTING terminal PTY for
  // the SAME workspace: if both its hooks and this SDK session's hooks set the
  // same WS_ID, they interleave writes to one spool with independent seq counters
  // and corrupt the sidebar status dot. So the spool half MUST be gated on
  // `isPtyRunning(ws.id)`.
  //
  // But gating identity ALONGSIDE the spool broke `orchestra rename`/`peers`/
  // `message`/`spawn` in a structured session whenever a PTY happened to own the
  // spool — the reported empty-`$ORCHESTRA_WS_ID` → `usage:` rename failure.
  // Note ORCHESTRA_EVENTS_DIR cannot decouple them: the hook DEFAULTS it to the
  // same getEventsDir() path when unset, so withholding it alone still lets the
  // hook write. The fix is a dedicated identity var (ORCHESTRA_WS_ID_IDENTITY,
  // set unconditionally below, never read by the hook), leaving ORCHESTRA_WS_ID
  // to mean spool ownership only.
  //
  // The terminal PTY lazy-starts only when the user actually opens the Terminal
  // tab (Terminal.tsx `allowStartRef`), so in a structured-view session there is
  // usually NO PTY — and we can safely own the spool so the status dot works in
  // the structured view too. We gate on `isPtyRunning(ws.id)` at session-start
  // time: no live PTY → set WS_ID/EVENTS_DIR (the SDK session drives the dot);
  // a PTY is already running → stay spool-free and let the PTY keep ownership.
  // Worst case if the user opens the Terminal tab AFTER the SDK session started
  // is a brief double-writer until one ends — no worse than the pre-existing
  // behavior for a user who ran both, and avoided in the common (single-view)
  // path. Full Phase 6 makes the two mutually exclusive by not starting the PTY
  // at all when structured is the default; identity no longer depends on it.
  const remote = ws.host?.kind === 'sandbox';
  // The SDK owns the spool (its own hooks + the tailer drive the dot) for a LOCAL
  // workspace with no terminal PTY already writing the spool. Computed once so the
  // env and the returned flag agree by construction. `driveStatus` (the SDK must
  // drive the dot itself) is the inverse restricted to local: local AND a PTY owns
  // the spool. Remote is neither — the container's spool tail drives it.
  const spoolWithheldByPty = !remote && isPtyRunning(ws.id);
  const ownsSpool = !remote && !spoolWithheldByPty;
  const driveStatus = spoolWithheldByPty;
  if (!remote) {
    env.ORCHESTRA_WORKTREE = ws.worktreePath;
    const binDir = agentCliBinDir();
    env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
    const sock = getHookSocketPath();
    if (sock) env.ORCHESTRA_SOCK = sock;
    // CLI IDENTITY, always. `orchestra rename`/`peers`/`message`/`spawn` resolve
    // the caller's workspace via selfWorkspaceId() (cli/index.ts), which reads
    // ORCHESTRA_WS_ID first and falls back to ORCHESTRA_WS_ID_IDENTITY. We set
    // the identity var UNCONDITIONALLY here so those commands work in a
    // structured session even when the spool gate below withholds
    // ORCHESTRA_WS_ID — the spool hook (workspaces.ts ORCHESTRA_HOOK_SCRIPT)
    // never reads the identity var, so this cannot cause a double-writer.
    // Without it, the rename-instruction hook's `orchestra rename
    // "$ORCHESTRA_WS_ID" ...` collapses to a single arg and prints `usage:`.
    env.ORCHESTRA_WS_ID_IDENTITY = ws.id;
    // SPOOL OWNERSHIP, gated. The activity hook writes `<wsId>.jsonl` whenever
    // ORCHESTRA_WS_ID is set (its ONLY gate; ORCHESTRA_EVENTS_DIR merely picks
    // the dir and DEFAULTS to the same getEventsDir() path when unset — so
    // withholding EVENTS_DIR alone does NOT stop the write). To keep the sidebar
    // status dot single-writer we must withhold ORCHESTRA_WS_ID itself when a
    // terminal PTY already owns the spool for this workspace; otherwise the SDK
    // session claims it (drives the dot in the structured view too).
    if (ownsSpool) {
      env.ORCHESTRA_WS_ID = ws.id;
      env.ORCHESTRA_EVENTS_DIR = getEventsDir();
    }
  }
  return { env, driveStatus };
}

/** The canUseTool bridge: park the call, emit a permission-request event, and
 *  wait for the renderer's reply (or the turn/session ending).
 *
 *  In `bypassPermissions` mode we auto-allow here rather than parking a prompt
 *  — EXCEPT for `AskUserQuestion`, which is interactive by nature and always
 *  parks for a real answer (see the note inside). The SDK requires
 *  `allowDangerouslySkipPermissions` for the CLI to honor bypass at all, but
 *  `canUseTool` — once supplied — is still invoked per tool, so without this
 *  short-circuit a "bypass" session would silently fall back to prompting (the
 *  reported "behaves like auto-accept" symptom). Reading `session.permissionMode`
 *  (not a captured value) means a *live* switch to bypass via
 *  `sdkSetPermissionMode` takes effect on the very next tool call. */
function makeCanUseTool(session: Session) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; requestId: string; title?: string; signal: AbortSignal },
  ): Promise<PermissionResult> => {
    // AskUserQuestion must ALWAYS park for a real human reply, in every mode —
    // it is NOT a permission to bypass. Grounded in the SDK's OWN documented
    // intent for the two mechanisms that collide here:
    //   • bypassPermissions (SDK warning text): "auto-approves every tool call
    //     … before the callback is consulted" — i.e. skip approval of the AGENT's
    //     dangerous ACTIONS (writes, Bash) so it runs unattended.
    //   • askUserQuestionTimeout (SDK setting): "Idle time before Claude's
    //     questions auto-continue with any answers selected so far. Defaults to
    //     never." So a question is INTENDED to WAIT for the human indefinitely by
    //     default; auto-continuing with nothing is opt-in, not the default.
    // In a normal interactive CLI these never collide — the CLI renders the
    // question in its own UI and waits regardless of bypass. But Orchestra runs
    // the SDK HEADLESS with no interactive question renderer, so if bypass
    // auto-approves the AskUserQuestion *tool call*, it resolves instantly with
    // the original input (no `answers`) → the harness returns "The user did not
    // answer the questions" and the prompt appears to close by itself (the
    // reported bug — reproduced live). Orchestra provides the question UI
    // (AskUserQuestionCard), so AskUserQuestion has to stay OUT of the bypass
    // auto-approve path and park for the user, matching the CLI's wait-for-human
    // default. (Verified against SDK 0.3.216: bypass auto-approval yields the
    // "did not answer" tool_result; parking + real answer records the choice.)
    // The decision is the pure `shouldAutoApprovePermission` — unit-tested in
    // agent-events.test.ts as the regression guard for this auto-close bug.
    if (shouldAutoApprovePermission(session.permissionMode, toolName)) {
      return Promise.resolve({ behavior: 'allow', updatedInput: input });
    }
    const requestId = opts.requestId || randomUUID();
    emit(
      session.wsId,
      makePermissionRequest(session.ctx, requestId, toolName, input, {
        toolUseId: opts.toolUseID ?? null,
        title: opts.title,
      }),
    );
    // The agent is now blocked on the user: flip the sidebar dot to `waiting`
    // (orange) and — if the window is unfocused — raise the "needs input"
    // toast/chime, matching the terminal path's Notification hook. The
    // structured view's parked question rides a renderer-only `agent:event`
    // channel that never reaches the events spool, so activity.ts wouldn't
    // otherwise know the turn stopped to ask. Restored to `running` the moment
    // the promise settles (reply, interrupt-abort, or turn-end).
    fireNeedsInput(session.wsId);
    return new Promise<PermissionResult>((resolve) => {
      // Wrap resolve so EVERY exit from the parked state (renderer reply,
      // abort, or the turn-end sweep in consume()) restores the dot to
      // `running` — a live PTY owner is respected by resumeRunning's guard.
      const settle = (result: PermissionResult) => {
        resumeRunning(session.wsId);
        resolve(result);
      };
      session.pending.set(requestId, settle);
      // If the turn is aborted (interrupt) the parked promise must not dangle:
      // deny on abort so the SDK unwinds.
      const onAbort = () => {
        if (session.pending.delete(requestId)) {
          settle({ behavior: 'deny', message: 'interrupted' });
        }
      };
      if (opts.signal.aborted) onAbort();
      else opts.signal.addEventListener('abort', onAbort, { once: true });
    });
  };
}

/** The async-generator prompt: yields queued user turns, gating each follow-up
 *  turn on the prior turn's `result` (spike h) so the SDK never has two turns in
 *  flight. Ends when the session stops.
 *
 *  The gate is a single promise per turn: `turnInFlight` resolves when the
 *  consume loop sees this turn's `result` message (it calls `session.turnGate`).
 *  The next iteration awaits it before yielding, keeping the subprocess warm and
 *  the turns strictly sequential. */
async function* promptStream(session: Session): AsyncGenerator<SDKUserMessage> {
  let turnInFlight: Promise<void> | null = null;

  for (;;) {
    // Gate: don't yield the next turn until the previous one's result landed.
    if (turnInFlight) {
      await turnInFlight;
      turnInFlight = null;
    }
    if (session.stopping) return;

    // Wait for a queued turn to arrive.
    while (session.queue.length === 0) {
      if (session.stopping) return;
      await new Promise<void>((res) => {
        session.pump = res;
      });
      session.pump = null;
    }
    if (session.stopping) return;

    const msg = session.queue.shift()!;
    // Arm the gate for THIS turn before yielding: consume() resolves it on the
    // turn's `result` (or stop()/interrupt() resolves it to unblock shutdown).
    turnInFlight = new Promise<void>((res) => {
      session.turnGate = res;
    });
    yield msg;
  }
}

/** Consume the SDK message stream for a session until it ends or throws. */
async function consume(session: Session): Promise<void> {
  let endedByInterrupt = false;
  try {
    for await (const raw of session.q) {
      const msg = raw as unknown as SdkMessage;
      emitFrom(session, msg);
      // Persist the SDK session id the first time the stream reports it, so
      // re-opening the structured view resumes THIS conversation (see the
      // `resume` option in ensureSession). The id is stable across a session's
      // turns; only write on change to avoid needless store saves.
      const sid = (msg as { session_id?: string }).session_id;
      if (sid && sid !== session.persistedSessionId) {
        session.persistedSessionId = sid;
        void persistSessionId(session.wsId, sid);
      }
      if (msg.type === 'result') {
        // Turn boundary — the interrupt (if any) is fully accounted for, so
        // reset the flag: it must not linger and mislabel/suppress a FUTURE
        // turn's genuine error as interrupt fallout. (emitFrom already ran for
        // this result, so its suppression saw the flag still set.)
        session.interruptRequested = false;
        // The turn ran to a boundary — the pending-prompt insurance (sdkSend)
        // has served its purpose; drop it so a later reopen can't replay.
        if (store.getWorkspace(session.wsId)?.sdkPendingPrompts?.length) {
          void persistWorkspacePatch(session.wsId, { sdkPendingPrompts: undefined });
        }
        // Resolve any parked permission (belt & suspenders) and
        // open the gate so the next queued turn can proceed.
        for (const [id, resolve] of session.pending) {
          resolve({ behavior: 'deny', message: 'turn ended' });
          session.pending.delete(id);
        }
        const openNext = session.turnGate;
        session.turnGate = null;
        openNext?.();
        // Re-read the authoritative context figure now the turn has settled.
        // Fire-and-forget: the turn is already complete and the gauge updating
        // a beat later is fine, but blocking the consume loop on a control
        // request would stall every subsequent message.
        refreshContextUsage(session.wsId);
      }
    }
  } catch (err) {
    // interrupt() surfaces here as a throw (spike d) — expected terminal state,
    // not a crash. Emit a normal error event; the session is done. "Interrupted"
    // is keyed on OUR OWN interrupt request first — a bare /abort/ text match
    // relabeled genuine crashes "Turn interrupted." and skipped their log line.
    const message = err instanceof Error ? err.message : String(err);
    const interrupted =
      session.interruptRequested || /error_during_execution|ede_diagnostic/i.test(message);
    endedByInterrupt = interrupted;
    if (!session.cleared) {
      // An interrupt is the user's own action, not a failure — surface it as a
      // quiet `interrupted` notice (the fold collapses it into the stream's
      // "[Request interrupted by user]" marker when that already rendered)
      // instead of the red error banner it used to raise. Real crashes keep
      // the error row.
      if (interrupted) {
        emit(session.wsId, {
          type: 'notice',
          kind: 'interrupted',
          seq: session.ctx.seq++,
          at: (session.ctx.now ?? Date.now)(),
          text: 'Interrupted by user',
        });
      } else {
        emit(session.wsId, {
          type: 'error',
          seq: session.ctx.seq++,
          at: (session.ctx.now ?? Date.now)(),
          message,
          apiErrorStatus: null,
          willRetry: false,
        });
      }
    }
    if (!interrupted) {
      log.warn(`agent-sdk: session ${session.wsId} consume loop errored`, err);
    }
    // A stream-surfaced BAD-RESUME error (the transcript for ws.sdkSessionId is
    // gone / the id is malformed) would otherwise wedge EVERY future send into
    // the same failure: ensureSession never awaits the subprocess, so the resume
    // failure surfaces HERE, not in sdkSend's catch where the original guard
    // lived (silent-failure audit H3). Clear the id on the positive signal only;
    // transient failures keep it so a later send resumes the same conversation.
    if (isBadResumeError(message)) {
      const wsNow = store.getWorkspace(session.wsId);
      if (wsNow?.sdkSessionId) {
        void persistWorkspacePatch(session.wsId, { sdkSessionId: undefined });
      }
    }
  } finally {
    // ── Close the ledger BEFORE dropping the session (silent-failure audit
    // H1/H2). Without this, an iterator that ends mid-turn (subprocess died,
    // worker shutdown, kill) left the folded view `running` forever — elapsed
    // timer counting up, composer stuck on "Queue", interrupt a dead button.
    const hadOpenTurn = session.turnGate !== null && !session.cleared;
    const undelivered = session.cleared ? 0 : session.queue.length;
    if (undelivered > 0) {
      // Queued turns that never reached the model: their user-message echoes
      // are already in the transcript, so say plainly that they were dropped —
      // a transcript that LOOKS sent but never was is the worst kind of lie.
      session.queue.length = 0;
      emit(
        session.wsId,
        stamp(session.ctx, {
          type: 'error',
          message: `${undelivered} queued message${undelivered === 1 ? ' was' : 's were'} not delivered because the session ended — send again.`,
          apiErrorStatus: null,
          willRetry: false,
        }),
      );
    }
    if (hadOpenTurn || undelivered > 0) {
      const turnEnd = stamp(session.ctx, {
        type: 'turn-end' as const,
        isError: !endedByInterrupt,
        stopReason: (endedByInterrupt ? 'interrupted' : 'error') as AgentStopReason,
        numTurns: 0,
        costUsd: null,
        usage: null,
        resultText: null,
        sessionId: session.persistedSessionId ?? '',
        durationMs: null,
      });
      emit(session.wsId, turnEnd);
      driveStatusFromEvent(session, turnEnd);
    }
    // Release any waiter and drop the session; the renderer can restart it.
    session.stopping = true;
    session.pump?.();
    session.turnGate?.();
    sessions.delete(session.wsId);
    // Status-dot reconciliation floor, mirroring the terminal PTY's exit handler
    // (pty.ts reconcileExited): once the SDK subprocess is gone — natural end,
    // interrupt, crash, or kill — the agent can't be `running`, so self-heal a
    // dot the activity `stop` hook may not have flipped (a crash never fires it).
    // Guard on no live PTY: if a terminal PTY owns the dot for this workspace,
    // let ITS exit handler reconcile — knocking it to `waiting` here would fight
    // a still-live terminal agent. reconcileExited itself no-ops unless status is
    // currently `running`, so this is safe when the agent legitimately idled.
    if (!isPtyRunning(session.wsId)) reconcileExited(session.wsId);
  }
}

/** Start (lazily) the SDK session for a workspace and return it. Idempotent —
 *  returns the existing session if one is live. */
/** In-flight ensureSession promises, keyed by wsId. The sessions map is only
 *  populated at the END of a (multi-await) start, so two near-simultaneous
 *  callers — a send racing the lazy keeper reattach (sdkAttachIfDetached), or
 *  a peer delivery racing a user send — would BOTH pass the `sessions.get`
 *  check and spawn two rival query()/keeper clients (the second's hello
 *  preempts the first's socket). Coalesce them onto one start instead. */
const ensuring = new Map<string, Promise<Session>>();

function ensureSession(wsId: string): Promise<Session> {
  const existing = sessions.get(wsId);
  if (existing && !existing.stopping) return Promise.resolve(existing);
  const inFlight = ensuring.get(wsId);
  if (inFlight) return inFlight;
  const p = ensureSessionInner(wsId).finally(() => ensuring.delete(wsId));
  ensuring.set(wsId, p);
  return p;
}

async function ensureSessionInner(wsId: string): Promise<Session> {
  const existing = sessions.get(wsId);
  if (existing && !existing.stopping) return existing;

  const ws = store.getWorkspace(wsId);
  if (!ws) throw new Error(`unknown workspace: ${wsId}`);

  // A pending rewind cut, consumed EXACTLY ONCE by the restart it was queued
  // for (see sdkRewind). Read-and-clear before any `await` below so a second
  // concurrent ensureSession can't apply the same truncation twice — and so a
  // later, unrelated resume never silently re-truncates the conversation.
  const pendingRewindAt = rewindResumeAt.get(wsId);
  rewindResumeAt.delete(wsId);

  // A structured session is about to (re)start — the single funnel for every
  // SDK start, resume and wake — so this workspace is no longer hibernated.
  // Clearing here rather than at each call site (sdkSend/sdkWake/sdkDeliver)
  // means no restore path can forget to drop the chip.
  clearHibernated(wsId);

  // Env parity with the terminal spawn (installOrchestraHooks + account
  // inheritance + CLAUDE_CONFIG_DIR), skipped for remote/sandbox workspaces
  // whose worktree lives in the container.
  const remote = ws.host?.kind === 'sandbox';

  // Validate the worktree BEFORE the SDK spawns `claude` there. The SDK's
  // spawnLocalProcess passes this as cwd; a missing/non-directory path throws a
  // cryptic `spawn ENOTDIR` deep in the SDK that our old silent catch hid ("send
  // does nothing"). Mirror the terminal path (pty.ts) with a clear, actionable
  // error the caller surfaces. Remote worktrees live in the container — skip.
  if (!remote) {
    let ok = false;
    try {
      ok = fs.statSync(ws.worktreePath).isDirectory();
    } catch {
      ok = false;
    }
    if (!ok) {
      throw new Error(
        `Workspace directory not found: ${ws.worktreePath}. The worktree may have been removed — recreate it or delete this workspace from the sidebar.`,
      );
    }
  }
  if (!remote) {
    await installOrchestraHooks(ws.worktreePath).catch((err) =>
      log.warn(`agent-sdk: hook install failed for ${wsId}`, err),
    );
    if (ws.accountId) {
      const account = store.accounts.find((a) => a.id === ws.accountId);
      if (account) {
        await syncAccountInheritance(account).catch((err) =>
          log.warn(`agent-sdk: account-inherit sync failed for ${wsId}`, err),
        );
      }
    }
  }

  // Honor the workspace's chosen permission mode (set by the Permissions
  // dropdown, persisted so a pre-session choice sticks). Defaults to BYPASS:
  // Orchestra's whole model is autonomous agents in isolated worktrees — the
  // terminal path runs claude with full permissions, and parity matters more
  // than a per-tool prompt wall (explicit user decision, 2026-07-21).
  const permissionMode: AgentPermissionMode = ws.sdkPermissionMode ?? 'bypassPermissions';
  // Build the env BEFORE the session so `driveStatus` (whether THIS subprocess
  // must drive the dot itself, because its hooks are withheld and nothing else
  // will) can be captured on the session and read per-event by
  // driveStatusFromEvent. isPtyRunning is sampled here, at spawn — stable for the
  // subprocess's life.
  const { env: sdkEnv, driveStatus } = buildSdkEnv(ws);
  const session: Session = {
    wsId,
    // q is assigned right after — the generator/canUseTool close over `session`,
    // not over `q`, so the forward reference is safe.
    q: undefined as unknown as Query,
    // Shared, monotonic across session restarts — see `seqCursors`. NOT a fresh
    // `{seq: 0}`: the renderer's transcript outlives this Session, and restarting
    // the counter mints ids that collide with rows already in it.
    ctx: cursorFor(wsId),
    queue: [],
    pump: null,
    turnGate: null,
    pending: new Map(),
    stopping: false,
    permissionMode,
    driveStatus,
    pendingLocalContext: [],
    recentEchoes: [],
  };

  // Resolve the query factory: a test override, else the dynamically-imported
  // real ESM SDK (never a static require — that crashes Electron at boot).
  const query = queryOverride ?? (await loadSdk()).query;
  // The SDK's DEFAULT executable path resolves relative to its own module —
  // which, in the packaged app, is a bundled chunk inside app.asar. Spawning
  // through the asar (a file, not a directory) fails with `spawn ENOTDIR`,
  // invisible in dev where there is no asar. Drive the user's real `claude`
  // (the same binary the terminal path spawns from PATH) instead; only fall
  // back to the SDK default when none is on PATH (dev-friendly).
  const claudeBin = resolveClaudeBinary(sdkEnv);
  // In-process browser tools: give the agent an embedded Browser pane it can
  // drive (navigate/read_page/screenshot/click/type), scoped to THIS wsId so it
  // can only touch its own workspace's panel. Built via the SDK's
  // createSdkMcpServer (no subprocess/port). Local (non-remote) sessions only —
  // a sandboxed/remote agent has no WebContentsView on this host to drive.
  const browserServer = remote ? null : await buildBrowserToolServer(wsId);
  session.q = query({
    prompt: promptStream(session),
    options: {
      ...(browserServer ? { mcpServers: { browser: browserServer } } : {}),
      cwd: remote ? '/workspace' : ws.worktreePath,
      includePartialMessages: true,
      // Emit periodic AI-generated one-line progress summaries for running
      // subagents (SDK `task_progress.summary`, e.g. "Analyzing auth module").
      // Drives the summary line on the "Background tasks" panel cards. The fork
      // reuses the subagent's model + prompt cache, so cost is typically
      // minimal (sdk.d.ts). The default `task_started`/`task_progress`/
      // `task_notification` heartbeats (usage + tool count) fire regardless —
      // this only adds the human-readable summary.
      agentProgressSummaries: true,
      // MUST include 'local': Orchestra writes ALL its per-workspace hooks
      // (auto-rename nudge, inbox delivery, comms-resurface, orchestrator
      // reminder, field-guide, activity spool) into
      // `<worktree>/.claude/settings.local.json` — the SDK's `'local'` setting
      // source (sdk.d.ts: "'local' - Local settings (.claude/settings.local.json)").
      // The terminal path spawns `claude` with NO source restriction, so it
      // loads all three by default and those hooks fire. Passing only
      // ['user','project'] here silently EXCLUDED the file every Orchestra hook
      // lives in — so in structured mode the branch was never auto-renamed, peer
      // messages were never delivered into context, and the orchestrator brief
      // reminder never re-surfaced. Matching the terminal path means loading all
      // three. (Skills are `.claude/skills/` — project-discovered — so they load
      // regardless; only the settings-file hooks needed 'local'.)
      settingSources: ['user', 'project', 'local'],
      permissionMode,
      // Required by the SDK whenever permissionMode is (or is switched to)
      // 'bypassPermissions' — without it the CLI ignores bypass and falls back
      // to prompting/accept-edits. Safe to always set: it only *enables* bypass
      // to be honored; the active mode is still governed by `permissionMode`
      // (and live changes via `setPermissionMode`).
      allowDangerouslySkipPermissions: true,
      // Never let an UNSOLICITED cross-session peer message auto-run a paid
      // turn on an Orchestra-managed session. Any local Claude session can
      // address this one by peer name (ListAgents -> SendMessage) over the
      // CLI's messaging socket; with no policy set the CLI delivers it with no
      // hold and starts a model turn on its own ($0.13 measured, #13/#25).
      // Orchestra runs bypassPermissions by design, which is exactly the case
      // the CLI's unset "mode parity" default auto-delivers (bypass<->bypass).
      // 'hold' parks such a message for review without letting Claude act; it
      // does NOT touch `orchestra message`, which is a different channel
      // entirely (sdkDeliver / PTY / inbox file, never the peer socket).
      // Inline `settings` lands in the SDK's highest-priority "flag settings"
      // layer, so a stale value in the user's settings.json cannot override it,
      // and `settingSources` above (which carries every Orchestra hook) is
      // unaffected. See src/shared/cross-session-inbound.ts for the measurement.
      settings: withCrossSessionInboundPolicy(),
      canUseTool: makeCanUseTool(session) as never,
      env: sdkEnv,
      ...(claudeBin ? { pathToClaudeCodeExecutable: claudeBin } : {}),
      // LOCAL sessions run the CLI behind the detached session KEEPER
      // (src/keeper/index.ts via keeper-client.ts): the subprocess belongs to
      // a tiny daemon instead of Electron main, so quitting Orchestra only
      // drops the socket (detach) and an in-flight turn keeps running; the
      // next ensureSession transparently REATTACHES to the live CLI (the
      // SDK's initialize handshake works mid-session and even redelivers
      // parked canUseTool permission requests — measured in
      // docs/spikes/keeper-findings.md). Remote/sandbox sessions keep the
      // SDK's own spawn (their process lives in the container). Typed `as
      // never` like canUseTool: the local SpawnedProcess mirror is
      // structurally identical but not nominally the SDK's.
      ...(remote
        ? {}
        : {
            spawnClaudeCodeProcess: makeKeeperSpawn(wsId, (pid, turnInFlight) => {
              log.info(
                `agent-sdk[${wsId}] reattached to detached keeper session (cli pid=${pid ?? '?'}, turnInFlight=${turnInFlight})`,
              );
              // Restore the turn state this app never saw the start of: the
              // fold flips running/turnStartedAt so the Working indicator and
              // interrupt affordance come back with the reattached turn.
              const live = sessions.get(wsId);
              if (live && !live.cleared) {
                const attachEv = stamp(live.ctx, { type: 'session/attach' as const, turnInFlight });
                emit(wsId, attachEv);
                driveStatusFromEvent(live, attachEv);
              }
            }) as never,
          }),
      // Start on the workspace's configured model (set by `orchestra spawn
      // --model` or the Model dropdown). Undefined falls back to the account's
      // default model. `sdkSetModel` switches it live.
      ...(ws.model ? { model: ws.model } : {}),
      // Start on the workspace's chosen reasoning effort (the deck bar's Effort
      // slider, persisted like the model). Undefined falls back to the model's
      // own default (`high`). `options.effort` accepts 'max' (unlike the
      // persisted Settings.effortLevel, which is why Orchestra stores the choice
      // in ITS OWN store). `sdkSetEffort` switches it live.
      ...(ws.sdkEffort ? { effort: ws.sdkEffort } : {}),
      // Resume the workspace's prior structured session so re-opening the view
      // continues the conversation with its memory intact, instead of starting
      // blank. The captured session id is persisted on `ws.sdkSessionId` as the
      // stream reports it (see consume()). Absent → a fresh session.
      ...(ws.sdkSessionId ? { resume: ws.sdkSessionId } : {}),
      // Orchestrator brief parity with startAgentPty (workspaces.ts): an
      // orchestrator's standing delegation brief is appended to the Claude Code
      // system prompt on a FRESH session only — on resume the persisted session
      // already carries it, so re-appending would duplicate it (mirrors the
      // terminal path's `!resuming` gate; `ws.sdkSessionId` present === resuming).
      // The `preset: 'claude_code'` keeps the full default system prompt and only
      // APPENDS the brief. Durable enforcement across compaction is still the
      // orchestrator-instruction SessionStart hook (now loaded via the 'local'
      // source above); this is the richer one-time onboarding.
      ...(!ws.sdkSessionId && ws.kind === 'orchestrator'
        ? {
            systemPrompt: {
              type: 'preset' as const,
              preset: 'claude_code' as const,
              append: orchestratorBrief(ws),
            },
          }
        : {}),
      // Track per-user-message file snapshots so `sdkRewind` can restore the
      // files a turn touched (`Query.rewindFiles` REQUIRES this — without it it
      // returns canRewind:false). Checkpoints only cover edits made AFTER the
      // flag is on, so sessions predating this feature rewind the conversation
      // only; the UI says so rather than implying a full restore. Note this is
      // incompatible with the SDK's `sessionStore` option (backup blobs aren't
      // mirrored) — Orchestra doesn't use one. See docs/spikes/rewind-sdk-findings.md.
      enableFileCheckpointing: true,
      // Truncate the resumed conversation to just before the message the user
      // rewound to. Set for exactly ONE restart (consumed below) — a rewind
      // tears the session down and the next send rebuilds it with this cut.
      ...(pendingRewindAt ? { resumeSessionAt: pendingRewindAt } : {}),
      // A large cap: real turns end on their own; this only backstops runaways.
      maxTurns: 200,
    },
  });

  sessions.set(wsId, session);
  // Fire-and-forget the consume loop; it self-cleans on end/throw.
  void consume(session);
  // Seed the context gauge for the freshly-opened pane. `getContextUsage()` is
  // answerable as soon as the session bootstraps — before any turn has run —
  // which is the whole point: the inferred per-turn figure does not exist until
  // a turn CLOSES, so without this a reopened pane shows no gauge until the
  // agent next replies.
  refreshContextUsage(wsId);
  return session;
}

/** Max transcript bytes read for a history backfill — tail window; transcripts
 *  reach 10MB+ and the fold shouldn't balloon on them. */
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/** The workspace's on-disk Claude Code transcript directory — the PINNED
 *  account's config dir (falling back to ~/.claude) + the mangled worktree
 *  path. Same resolution as `claude --continue` (see workspaces.ts). */
function transcriptDir(ws: Workspace): string {
  const base = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  return path.join(base, 'projects', mangleProjectDir(ws.worktreePath));
}

/** Run `fn` with `CLAUDE_CONFIG_DIR` pinned to a workspace's ACCOUNT config dir,
 *  restoring the previous value afterwards.
 *
 *  ## Why this exists (measured, SDK 0.3.241)
 *
 *  `listSessions` has no `configDir` option — it resolves the Claude home from
 *  `process.env.CLAUDE_CONFIG_DIR`, falling back to `~/.claude`. Orchestra pins
 *  every workspace to an ACCOUNT (`~/.claude-mc`, `~/.claude-perso`, …), and on
 *  a real multi-account home the default dir holds **nothing**: measured across
 *  31 workspaces with transcripts, listing with the var unset returned 0 for
 *  every one, and pinning it returned exactly the on-disk set (41/41, no
 *  asymmetry either way). So this pin is load-bearing, not cosmetic.
 *
 *  Mutating `process.env` is safe here despite the SDK memoizing its resolved
 *  home: the memo is keyed on the env value itself
 *  (`memoize(() => env.CLAUDE_CONFIG_DIR ?? ~/.claude, () => env.CLAUDE_CONFIG_DIR)`),
 *  so a changed value is a cache MISS, never a stale hit. Verified by
 *  alternating both accounts 60+ times in one process with no bleed.
 *
 *  Restored in a `finally` because main-process env is global: leaking a pinned
 *  value would silently re-home every LATER session lookup — including other
 *  workspaces on other accounts. */
async function withAccountConfigDir<T>(ws: Workspace, fn: () => Promise<T>): Promise<T> {
  const configDir = workspaceAccountConfigDir(ws, undefined);
  if (!configDir) return fn();
  const prev = process.env.CLAUDE_CONFIG_DIR;
  process.env.CLAUDE_CONFIG_DIR = configDir;
  try {
    return await fn();
  } finally {
    if (prev === undefined) delete process.env.CLAUDE_CONFIG_DIR;
    else process.env.CLAUDE_CONFIG_DIR = prev;
  }
}

/** Session ids for a workspace's worktree, newest-first, via the SDK's own
 *  session index — the replacement for hand-rolled transcript-dir mtime
 *  scanning. Returns `[]` (never throws) so history stays fail-open.
 *
 *  Two non-default options, both measured and both load-bearing:
 *
 *  • **`includeWorktrees: false`** — the SDK DEFAULTS this to `true`, which
 *    walks every git worktree of the same repo. Orchestra runs ~24 agents in
 *    sibling worktrees of ONE repo, so the default pulled 24 sessions into a
 *    workspace that owns 8: every workspace's history would be contaminated
 *    with other agents' conversations. Scope is this worktree, exactly.
 *  • **`includeProgrammatic: true`** (the SDK default, pinned explicitly so a
 *    future default flip can't silently truncate us) — Orchestra's structured
 *    sessions are `sdk-ts` entrypoints, which is precisely what the
 *    "IDE session picker" spelling (`false`) filters OUT: measured 8 → 4 on a
 *    real workspace. */
async function sdkListSessionIds(ws: Workspace): Promise<SessionCandidate[]> {
  try {
    const listSessions = listSessionsOverride ?? (await loadSdk()).listSessions;
    const sessions = await withAccountConfigDir(ws, () =>
      listSessions({
        dir: ws.worktreePath,
        includeWorktrees: false,
        includeProgrammatic: true,
      }),
    );
    // Order newest-first — that ordering IS the newest-transcript fallback, so
    // it is asserted rather than assumed (tested in shared/session-discovery).
    // Scoping is done by the QUERY above (`dir` + includeWorktrees:false) and
    // deliberately NOT by filtering on each session's `cwd`: a workspace
    // promoted from scratch to a worktree records the OLD path there, and
    // filtering on it drops that workspace's entire history.
    return scopeSessionsToWorktree(sessions, ws.worktreePath);
  } catch (err) {
    log.warn(`agent-sdk: listSessions failed for ${ws.id}`, err);
    return [];
  }
}

/** Read a workspace's persisted on-disk session transcript and convert it into
 *  an AgentEvent stream for the structured view's history backfill. Returns []
 *  when there is nothing to backfill (no persisted id, file missing/empty).
 *  Fail-open: an unreadable transcript is a blank history, never an error.
 *
 *  ## Why discovery is SDK-backed but the READ is still raw JSONL
 *
 *  `getSessionMessages()` is the obvious counterpart to `listSessions()`, and
 *  it is deliberately NOT used: it returns a PARSED conversation chain that
 *  drops envelope fields this fold depends on. Measured on real transcripts
 *  (SDK 0.3.241), with positive controls — i.e. transcripts that actually
 *  contain the frames in question, so these are observed losses, not the
 *  vacuous "0 on a transcript that had none":
 *
 *  • **`origin` is stripped** (6/6 origin-bearing frames survived as messages,
 *    0 kept the field). That silently drops the claude.ai / peer / task-
 *    notification badge on every reopened externally-originated turn.
 *  • **`isCompactSummary` is stripped** (1/1 survived, flag gone). The fold
 *    turns that frame into a quiet `compact-boundary` notice; without the flag
 *    it renders as the full "This session is being continued from a previous
 *    conversation…" wall-of-text bubble.
 *
 *  It does correctly drop `isMeta` frames (5 on disk → 0 emitted), so the
 *  phantom-skill-bubble class is handled — but two of three envelope
 *  behaviours regress, so the raw read stays until the SDK preserves them.
 *  The multi-account win (finding the RIGHT session across per-account config
 *  dirs) is entirely in discovery, which is what moved to the SDK. */
export async function sdkHistory(wsId: string): Promise<AgentEvent[]> {
  const ws = store.getWorkspace(wsId);
  if (!ws?.worktreePath) return [];
  const dir = transcriptDir(ws);

  // `''` is sdkClear's explicit "conversation cleared" marker — no backfill
  // until a new session mints a fresh id (the newest-session fallback below
  // would otherwise resurrect the cleared conversation on remount).
  //
  // `''` (cleared) and `undefined` (never had a structured session) are
  // DIFFERENT states and must stay that way: `undefined` falls through to the
  // newest-session fallback, `''` short-circuits to a blank history. Collapsing
  // them into a single falsy check re-opens "/clear then reopen shows the
  // cleared conversation again".
  if (ws.sdkSessionId === '') return [];
  // Prefer the persisted structured-session transcript; workspaces that have
  // only ever run the TERMINAL agent have no sdkSessionId but DO have
  // transcripts — fall back to the newest session, which is exactly the one
  // `claude --continue` (both drivers) resumes.
  //
  // Discovery goes through the SDK's session index (`listSessions`, scoped to
  // this worktree and this workspace's ACCOUNT config dir); the transcript is
  // then READ off disk. That split is deliberate — see the note below on why
  // `getSessionMessages` cannot back the fold.
  let file: string | null = null;
  if (ws.sdkSessionId) {
    const candidate = path.join(dir, `${ws.sdkSessionId}.jsonl`);
    if (fs.existsSync(candidate)) file = candidate;
  }
  if (!file) {
    for (const info of await sdkListSessionIds(ws)) {
      const candidate = path.join(dir, `${info.sessionId}.jsonl`);
      if (fs.existsSync(candidate)) {
        file = candidate;
        break;
      }
    }
  }
  if (!file) return [];
  let text: string;
  let truncated = false;
  try {
    const stat = await fs.promises.stat(file);
    if (stat.size > HISTORY_MAX_BYTES) {
      const fh = await fs.promises.open(file, 'r');
      try {
        const buf = Buffer.alloc(HISTORY_MAX_BYTES);
        await fh.read(buf, 0, HISTORY_MAX_BYTES, stat.size - HISTORY_MAX_BYTES);
        // Drop the first (almost certainly partial) line of the tail window.
        const s = buf.toString('utf8');
        text = s.slice(s.indexOf('\n') + 1);
        truncated = true;
      } finally {
        await fh.close();
      }
    } else {
      text = await fs.promises.readFile(file, 'utf8');
    }
  } catch (err) {
    // Fail-open (a blank history, never an error) — but not SILENTLY: an
    // unreadable transcript used to vanish with no log at all (audit M5).
    log.warn(`agent-sdk: history backfill read failed for ${wsId} (${file})`, err);
    return [];
  }
  // History gets its OWN seq space, based far above any live cursor
  // (HISTORY_SEQ_BASE). Message identity is derived from seq, and a backfill is
  // merged into the SAME transcript array as live messages — a shared origin at
  // 0 made history's first row and the live session's first row the same id.
  const ctx: NormalizeContext = { seq: HISTORY_SEQ_BASE };
  const events: AgentEvent[] = [];
  if (truncated) {
    // A tail-cut backfill used to render with no marker — the missing early
    // history read as "that's the whole conversation".
    events.push(
      stamp(ctx, {
        type: 'notice',
        kind: 'info',
        text: 'Earlier history not shown (transcript too large — showing the most recent part).',
      }),
    );
  }
  // Pass the WORKSPACE's model: it is the only place the `[1m]` long-context
  // alias survives (the transcript records the base id), and without it the
  // gauge sizes a 1M session against 200k and reports >100%.
  events.push(...transcriptToEvents(text, ctx, ws.model));
  return events;
}

/** Read the `model` key from a Claude Code `settings.json`, or '' if absent /
 *  unreadable / not a string. Fail-open: a missing or malformed file is "no
 *  setting here", never an error. */
function readSettingsModel(file: string): string {
  try {
    const parsed = JSON.parse(fs.readFileSync(file, 'utf8')) as unknown;
    if (parsed && typeof parsed === 'object') {
      const m = (parsed as { model?: unknown }).model;
      if (typeof m === 'string' && m.trim()) return m.trim();
    }
  } catch {
    /* absent / unparseable → no setting */
  }
  return '';
}

/** The model this workspace's structured session WILL start on when no explicit
 *  `ws.model` is set — i.e. the account's default, so the Model dropdown can show
 *  a real value (e.g. `opus[1m]`) BEFORE the first turn instead of an opaque
 *  "Account default" placeholder. An explicit `ws.model` (set by `orchestra
 *  spawn --model` or the dropdown) always wins and is returned verbatim.
 *
 *  Otherwise this reads Claude Code's `settings.json` `model` in the SAME
 *  precedence the SDK loads (`settingSources: ['user','project','local']`, where
 *  a later source wins): worktree `.claude/settings.local.json` (local) →
 *  worktree `.claude/settings.json` (project) → the pinned account config dir's
 *  `settings.json` (user, default `~/.claude`). Returns the raw setting string
 *  (an ALIAS like `opus[1m]`, which the SDK later resolves to a full id such as
 *  `claude-opus-4-8[1m]` at `session/init`), or '' when nothing sets it (the
 *  account/CLI built-in default, which only the SDK can resolve — the renderer
 *  keeps the placeholder then). Cheap: a few small JSON reads, invoked when the
 *  structured view mounts without a live session. */
export function sdkDefaultModel(wsId: string): string {
  const ws = store.getWorkspace(wsId);
  if (!ws) return '';
  if (ws.model?.trim()) return ws.model.trim();

  const configDir = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  // Last writer wins → check in reverse precedence and let a higher-priority
  // source overwrite. local > project > user.
  const layers = [
    path.join(configDir, 'settings.json'), // user (lowest)
    ws.worktreePath ? path.join(ws.worktreePath, '.claude', 'settings.json') : '', // project
    ws.worktreePath ? path.join(ws.worktreePath, '.claude', 'settings.local.json') : '', // local (highest)
  ];
  let model = '';
  for (const file of layers) {
    if (!file) continue;
    const m = readSettingsModel(file);
    if (m) model = m;
  }
  return model;
}

/** Model lists last reported by a live session, keyed by the ACCOUNT config
 *  dir that answered (model availability is an account/CLI property, not a
 *  workspace one) — so a workspace with no live session still gets the list a
 *  sibling on the same account fetched. In-memory only: on a fresh app run
 *  with no session yet, {@link sdkListModels} returns [] and the renderer
 *  falls back to its static list (model-util.ts MODEL_CHOICES). */
const modelListCache = new Map<string, AgentModelInfo[]>();

/** List the models the workspace's Claude runtime actually offers, via the
 *  live session's `supportedModels()` control request — the same source as
 *  Claude Code's /model picker, so newly released models (and account-gated
 *  ones) appear without hardcoding. Falls back to the last list cached for
 *  this workspace's account, then []. The control request is raced against a
 *  short timeout so a wedged subprocess can't hang the renderer's menu open. */
export async function sdkListModels(wsId: string): Promise<AgentModelInfo[]> {
  const ws = store.getWorkspace(wsId);
  const cacheKey =
    (ws && workspaceAccountConfigDir(ws, undefined)) || path.join(os.homedir(), '.claude');

  const session = sessions.get(wsId);
  if (session) {
    try {
      const models = await Promise.race([
        session.q.supportedModels(),
        // A control request to a dying subprocess can park forever; the menu
        // must still open, so time-box and fall back to the cache.
        new Promise<never>((_, reject) =>
          setTimeout(() => reject(new Error('supportedModels timed out')), 3000),
        ),
      ]);
      const mapped: AgentModelInfo[] = models.map((m) => ({
        value: m.value,
        resolvedModel: m.resolvedModel,
        displayName: m.displayName,
        description: m.description,
      }));
      if (mapped.length) {
        modelListCache.set(cacheKey, mapped);
        return mapped;
      }
    } catch (err) {
      log.warn(
        `agent-sdk: supportedModels failed for ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  return modelListCache.get(cacheKey) ?? [];
}

/** Read the workspace's context-window usage from the LIVE SDK session — the
 *  CLI's own accounting (`Query.getContextUsage()`), the same figure its
 *  `/context` view renders.
 *
 *  Returns `null` when there is no live session, when the control request fails
 *  or times out, or when the payload is unreadable — in every one of those
 *  cases the caller must fall back to the transcript recompute in
 *  `activity.ts`, which is why this reports absence rather than a zeroed
 *  reading (0 is the app's "context was reset" sentinel and would clear the
 *  badge).
 *
 *  Callable as soon as the session has bootstrapped, before any turn has run —
 *  verified against CLI 2.1.234 — so the gauge can be seeded at pane mount
 *  instead of waiting for a turn to end. Time-boxed exactly like
 *  {@link sdkListModels}: a wedged subprocess must not hang the caller. */
export async function sdkGetContextUsage(wsId: string): Promise<ContextUsage | null> {
  const session = sessions.get(wsId);
  if (!session) return null;
  try {
    const payload = await Promise.race([
      session.q.getContextUsage(),
      new Promise<never>((_, reject) =>
        setTimeout(() => reject(new Error('getContextUsage timed out')), 3000),
      ),
    ]);
    return normalizeLiveContextUsage(payload as LiveContextUsagePayload, Date.now());
  } catch (err) {
    // Expected whenever the subprocess is mid-restart or the installed CLI is
    // too old for the control request — the transcript fallback covers it, so
    // this is a warn, not an error.
    log.warn(
      `agent-sdk: getContextUsage failed for ${wsId}: ${err instanceof Error ? err.message : String(err)}`,
    );
    return null;
  }
}

/** Take a live context reading and broadcast it if it beats what the renderer
 *  already has. Fire-and-forget: every call site (pane mount, turn end) wants
 *  the gauge refreshed but none should block on it.
 *
 *  The precedence check is what stops this from fighting the transcript
 *  recompute — both producers fire independently, and without it a posttool's
 *  inferred figure would clobber this exact one moments after it landed. */
function refreshContextUsage(wsId: string): void {
  void sdkGetContextUsage(wsId)
    .then((usage) => {
      const session = sessions.get(wsId);
      // The session can end while the control request is in flight; emitting
      // against a dead session would stamp a seq on a cursor nobody reads.
      if (!usage || !session) return;
      emit(wsId, stamp(session.ctx, { type: 'session/context', usage }));
    })
    .catch((e) => log.warn(`agent-sdk: refreshContextUsage failed for ${wsId}`, e));
}

/** List the skills (slash commands) available to a workspace: the worktree's
 *  `.claude/skills/*` plus the pinned account config dir's (default ~/.claude)
 *  `skills/*`. Project shadows user on a name clash. Cheap directory scan,
 *  invoked when the composer's autocomplete opens. */
export async function sdkListSkills(wsId: string): Promise<AgentSkillInfo[]> {
  const ws = store.getWorkspace(wsId);
  if (!ws) return [];
  const configDir = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  const roots: { dir: string; source: AgentSkillInfo['source'] }[] = [];
  if (ws.worktreePath) {
    roots.push({ dir: path.join(ws.worktreePath, '.claude', 'skills'), source: 'project' });
  }
  roots.push({ dir: path.join(configDir, 'skills'), source: 'user' });

  const byName = new Map<string, AgentSkillInfo>();
  for (const { dir, source } of roots) {
    let entries: string[] = [];
    try {
      entries = await fs.promises.readdir(dir);
    } catch {
      continue;
    }
    for (const name of entries) {
      if (byName.has(name)) continue;
      let description = '';
      try {
        const head = (
          await fs.promises.readFile(path.join(dir, name, 'SKILL.md'), 'utf8')
        ).slice(0, 2000);
        const m = /^description:\s*(.+)$/m.exec(head);
        if (m) description = m[1].trim().split(/(?<=\.)\s/)[0].slice(0, 140);
      } catch {
        continue; // not a skill dir
      }
      byName.set(name, { name, description, source });
    }
  }
  return [...byName.values()].sort((a, b) => a.name.localeCompare(b.name));
}

/** Enqueue a user turn (text) to a workspace's session, starting it lazily.
 *  If starting the session fails (missing worktree, SDK spawn error, bad
 *  resume), EMIT an error event so the structured view shows it — the old
 *  behavior rejected silently and the composer swallowed it ("send does
 *  nothing"). Still rethrows so the IPC caller can react too. */
export async function sdkSend(
  wsId: string,
  text: string,
  images?: AgentImage[],
): Promise<void> {
  let session: Session;
  try {
    session = await ensureSession(wsId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: could not start session for ${wsId}: ${message}`);
    emit(wsId, {
      type: 'error',
      // Unique even with no live Session: the workspace cursor outlives
      // sessions, so two failed sends can't both mint id `error:0`.
      seq: cursorFor(wsId).seq++,
      at: Date.now(),
      message: `Couldn't start the agent: ${message}`,
      apiErrorStatus: null,
      willRetry: false,
    });
    // If we were trying to RESUME, a genuinely BAD resume id (its transcript is
    // gone or the id is malformed) can wedge every future send — clear it so the
    // next attempt starts a fresh session instead of repeating the same failure.
    // But clear ONLY on that positive signal: a TRANSIENT failure (network loss
    // on reboot/internet drop, API 500, spawn hiccup, interrupt/abort) leaves the
    // on-disk transcript intact, so preserving the id lets a later send resume the
    // SAME conversation. The old rule cleared on any error but "directory not
    // found", which silently discarded a good session id on exactly the
    // internet-loss case this resume exists to survive (isBadResumeError guards it).
    const wsNow = store.getWorkspace(wsId);
    if (wsNow?.sdkSessionId && isBadResumeError(message)) {
      await persistWorkspacePatch(wsId, { sdkSessionId: undefined }).catch(() => {});
    }
    throw err;
  }
  // Bash-mode parity (Claude Code `!command`): any local-command output run since
  // the last turn is prepended to THIS message as `<local-command-stdout>` context
  // so the agent sees what the user ran. Drained once — it belongs to exactly one
  // turn. The blocks precede the user's own text, matching CC's ordering.
  const localContext = session.pendingLocalContext;
  session.pendingLocalContext = [];
  const contextPrefix = localContext.length > 0 ? localContext.join('\n') + (text ? '\n\n' : '') : '';
  const sendText = contextPrefix + text;
  // With pasted images, the SDK message content becomes an ARRAY of content
  // blocks — image blocks (base64 source, per the Messages API vision shape)
  // followed by the text block. Plain text stays a bare string (the common path).
  const content =
    images && images.length > 0
      ? [
          ...images.map((img) => ({
            type: 'image' as const,
            source: {
              type: 'base64' as const,
              media_type: img.mediaType,
              data: img.dataBase64,
            },
          })),
          ...(sendText ? [{ type: 'text' as const, text: sendText }] : []),
        ]
      : sendText;
  // Mint this turn's message uuid OURSELVES — the rewind target. `uuid` is an
  // optional *input* on SDKUserMessage that the CLI persists verbatim to the
  // on-disk transcript (verified, with a uuid-omitted negative control, in
  // docs/spikes/rewind-sdk-findings.md). Minting it here is what makes the id
  // known synchronously: the SDK never echoes user messages back, so there is
  // NO stream path to learn a CLI-assigned uuid, and reading it off disk would
  // be racy. It rides the echo below so the bubble is rewindable immediately.
  const rewindId = randomUUID();
  const msg: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    uuid: rewindId,
    // The SDK's content-block union is wider than our narrowed shape; the base64
    // image + text blocks match the Messages API vision contract exactly.
    message: { role: 'user', content: content as SDKUserMessage['message']['content'] },
  };
  session.queue.push(msg);
  // Echo the prompt (text + images) to every attached UI — the SDK stream never
  // repeats plain user content, so this event is the transcript's only record.
  // This echo (not a `normalizeSdkMessage` event) is also the `submit` signal
  // for the status dot, so drive status off it directly: it flips the sidebar to
  // `running` the instant the turn is queued, before the first SDK event lands —
  // parity with the terminal path's UserPromptSubmit hook.
  const userMsg = makeUserMessage(session.ctx, text, images, rewindId);
  emit(session.wsId, userMsg);
  driveStatusFromEvent(session, userMsg);
  // Remember what we fed the generator so emitFrom can drop a stream replay of
  // this exact text (see the guard there). `sendText` is what a replay would
  // carry (context prefix included). Bounded — this is a dedupe window, not a log.
  session.recentEchoes.push(sendText);
  if (session.recentEchoes.length > 8) session.recentEchoes.shift();
  // Insurance for the quit-right-after-send window: until this turn COMPLETES
  // (cleared in consume() at the result), the raw prompt is persisted on the
  // workspace. If the app quits before the CLI ever runs the turn (session
  // init orphaned → the keeper's initGrace kills the CLI), the prompt would
  // otherwise exist nowhere — recoverPendingPrompts re-sends it on the next
  // structured-view open. Raw `text`, not sendText: a replay must not carry a
  // stale local-command context prefix.
  if (text.trim()) {
    const wsNow = store.getWorkspace(wsId);
    void persistWorkspacePatch(wsId, {
      sdkPendingPrompts: [...(wsNow?.sdkPendingPrompts ?? []), text],
    });
  }
  session.pump?.();
}

/** Start (or reuse) a structured session for `wsId` and deliver `text` as its
 *  next turn — the spawn/wake entry point behind the sdk-delivery seam
 *  (`sdkStartAndDeliver`). Unlike `sdkDeliver` this does NOT require a live
 *  session: {@link sdkSend} lazy-starts one, resuming `ws.sdkSessionId` when
 *  present. A workspace that has only ever run the TERMINAL agent (`hasInput`
 *  set but no `sdkSessionId`) first ADOPTS its newest on-disk transcript as the
 *  resume id, so a structured wake continues the same conversation the old PTY
 *  wake's `claude --continue` would have — instead of silently starting blank.
 *  (`sdkSessionId === ''` is sdkClear's explicit "cleared" marker and starts
 *  fresh; a genuinely bad adopted id is cleared by sdkSend's isBadResumeError
 *  guard, so a corrupt transcript can't wedge future sends.) */
export async function sdkWake(wsId: string, text: string): Promise<void> {
  const ws = store.getWorkspace(wsId);
  if (ws?.worktreePath && ws.hasInput && ws.sdkSessionId === undefined && !sessions.has(wsId)) {
    // Newest session for THIS worktree under THIS workspace's account config
    // dir, via the SDK's session index (see sdkListSessionIds). Requiring the
    // transcript to exist on disk keeps the adopted id resumable.
    const dir = transcriptDir(ws);
    const adopted =
      (await sdkListSessionIds(ws)).find((info) =>
        fs.existsSync(path.join(dir, `${info.sessionId}.jsonl`)),
      )?.sessionId ?? '';
    if (adopted) {
      log.info(`agent-sdk: wake ${wsId} adopting terminal transcript ${adopted} as resume id`);
      await persistWorkspacePatch(wsId, { sdkSessionId: adopted });
    }
  }
  await sdkSend(wsId, text);
}

/** Reattach to a DETACHED keeper session, if one is live for this workspace.
 *
 *  A structured session's CLI survives app quit inside the detached keeper
 *  (keeper-client.ts); after a relaunch the app has no in-memory session but
 *  the turn may still be running. This lazily rebuilds the session AROUND the
 *  live CLI — ensureSession's keeper spawn facade finds the live keeper and
 *  attaches instead of spawning, so the in-flight turn's stream flows into
 *  consume() again (and any parked permission request is redelivered by the
 *  attach handshake — docs/spikes/keeper-findings.md). Called fire-and-forget
 *  when a workspace's structured view loads (api-handlers sdkHistory), keeping
 *  attach LAZY per the no-mass-resume-at-startup philosophy (index.ts).
 *  Returns true when an attach was started. */
export async function sdkAttachIfDetached(wsId: string): Promise<boolean> {
  if (sessions.has(wsId)) return false;
  const ws = store.getWorkspace(wsId);
  if (!ws || ws.host?.kind === 'sandbox') return false;
  const probe = await probeKeeper(wsId);
  if (!probe?.running) return false;
  if (probe.everStarted === false) {
    // The CLI never ran a turn — it's still in (likely orphaned) session init,
    // which a dead client wedges for ~60s (docs/spikes/keeper-findings.md
    // follow-up). Attaching would only inherit the wedge: kill it and let the
    // pending-prompt recovery start a FRESH session that runs immediately.
    // AWAITED — the recovery's respawn follows right behind, and racing a
    // dying keeper bridged a fresh query onto the SIGTERM'd child in testing.
    log.info(`agent-sdk: keeper for ${wsId} holds a never-started CLI — killing instead of attaching`);
    await killKeeper(wsId);
    return false;
  }
  log.info(`agent-sdk: live detached keeper found for ${wsId} (cli pid=${probe.pid ?? '?'}) — reattaching`);
  try {
    await ensureSession(wsId);
    return true;
  } catch (err) {
    log.warn(`agent-sdk: reattach failed for ${wsId}`, err);
    return false;
  }
}

/** Re-send prompts that were sent before a quit but never actually RAN.
 *
 *  `ws.sdkPendingPrompts` holds every prompt whose turn hasn't completed (set
 *  in sdkSend, cleared at the result in consume()). On structured-view open,
 *  any entry the on-disk transcript does NOT contain as user text was lost in
 *  the quit-right-after-send window (the CLI queued it during init and the
 *  keeper's initGrace reaped that CLI) — re-send it so the user's message
 *  reappears, with the normal echo restoring the bubble, the Working
 *  indicator, and the status dot. Entries the transcript DOES contain simply
 *  clear (the turn ran — possibly to completion while the app was closed).
 *  Runs AFTER sdkAttachIfDetached so a resend can never race the attach's
 *  session start. */
export async function recoverPendingPrompts(wsId: string, history: AgentEvent[]): Promise<void> {
  const ws = store.getWorkspace(wsId);
  const pending = ws?.sdkPendingPrompts ?? [];
  if (pending.length === 0) return;
  const userTexts = history.filter((e) => e.type === 'user-message').map((e) => e.text ?? '');
  const missing = pending.filter((p) => !userTexts.some((t) => t.includes(p)));
  // Clear FIRST: the resend below re-appends via sdkSend, so leaving the old
  // entries would double them; and a transcript-covered entry is done for good.
  await persistWorkspacePatch(wsId, { sdkPendingPrompts: undefined });
  if (missing.length === 0) return;
  log.info(`agent-sdk: re-sending ${missing.length} pending prompt(s) lost to a quit for ${wsId}`);
  try {
    await sdkSend(wsId, missing.join('\n'));
  } catch (err) {
    log.warn(`agent-sdk: pending-prompt recovery send failed for ${wsId}`, err);
  }
}

/** Cap on captured bash output so a runaway command (e.g. `yes`, `cat bigfile`)
 *  can't blow up the transcript or the context we feed the model. Matches the
 *  spirit of Claude Code's own bash-output truncation. */
const BASH_OUTPUT_CAP = 30_000;

/** Hard wall-clock limit for a `!command` bash-mode run. Bash mode is
 *  non-interactive (stdin closed) and has no cancel affordance, so without a
 *  timeout a never-exiting command (`tail -f`, a prompt waiting on stdin, a hung
 *  login shell) left the spinner row running forever and the child alive
 *  (silent-failure audit H7). */
const BASH_TIMEOUT_MS = 5 * 60_000;

/** Total chars of pending `<local-command-stdout>` context queued for the next
 *  turn. N back-to-back bash runs used to accumulate unbounded (30k each) and
 *  all prepend to one send — a silent context blowout. Oldest entries drop
 *  first; the transcript rows still show everything. */
const LOCAL_CONTEXT_CAP = 60_000;

/** Run a `!command` bash-mode command (composer bash mode — parity with Claude
 *  Code). The command runs LOCALLY in the workspace's worktree (never the model),
 *  its command+output render inline in the transcript, and the pair is queued as
 *  context for the agent's NEXT real turn (drained by {@link sdkSend}). Returns
 *  when the command has exited.
 *
 *  Lazily ensures the session so the context has somewhere to live and the
 *  transcript echo reaches every attached UI — but does NOT start a model turn. */
export async function sdkRunBash(wsId: string, command: string): Promise<void> {
  const cmd = command.trim();
  if (!cmd) return;
  let session: Session;
  try {
    session = await ensureSession(wsId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: could not start session for bash run ${wsId}: ${message}`);
    emit(wsId, {
      type: 'error',
      // Unique even with no live Session: the workspace cursor outlives
      // sessions, so two failed sends can't both mint id `error:0`.
      seq: cursorFor(wsId).seq++,
      at: Date.now(),
      message: `Couldn't run the command: ${message}`,
      apiErrorStatus: null,
      willRetry: false,
    });
    throw err;
  }

  const ws = store.getWorkspace(wsId);
  const remote = ws?.host?.kind === 'sandbox';
  if (remote) {
    // Bash mode runs on the LOCAL machine; a sandbox worktree lives in a remote
    // container we don't have a shell into here. Surface a clear message rather
    // than silently running against the wrong filesystem.
    const startEv = makeLocalCommand(session.ctx, { commandId: randomUUID(), command: cmd, running: false, output: 'Bash mode is not available for sandbox workspaces.', exitCode: null });
    emit(wsId, startEv);
    return;
  }

  const commandId = randomUUID();
  // Start event — renders the command row with a running spinner immediately.
  emit(wsId, makeLocalCommand(session.ctx, { commandId, command: cmd, running: true }));

  const { env } = buildSdkEnv(ws!);
  const cwd = ws!.worktreePath;
  const shell = process.env.SHELL || '/bin/bash';

  const output = await new Promise<{ text: string; exitCode: number | null }>((resolve) => {
    let buf = '';
    let capped = false;
    let child: ReturnType<typeof spawn> | null = null;
    const kill = () => {
      try {
        child?.kill('SIGKILL');
      } catch {
        /* already gone */
      }
    };
    const append = (chunk: Buffer) => {
      if (capped) return;
      buf += chunk.toString('utf8');
      if (buf.length > BASH_OUTPUT_CAP) {
        buf = buf.slice(0, BASH_OUTPUT_CAP) + '\n… (output truncated; command killed)';
        capped = true;
        // A command that blew the cap is a runaway — capturing more is pointless
        // and letting it run leaks a live child behind a "truncated" row.
        kill();
      }
    };
    // Hard timeout: no cancel affordance exists, so this is the only way a hung
    // command's spinner row ever resolves.
    const timer = setTimeout(() => {
      if (!capped) buf += `\n… (timed out after ${BASH_TIMEOUT_MS / 60_000} minutes; command killed)`;
      kill();
    }, BASH_TIMEOUT_MS);
    try {
      // `-l -c` so the user's login shell config (aliases, PATH) is honored,
      // matching what the terminal path gives them. stdin closed (bash mode is
      // non-interactive).
      child = spawn(shell, ['-l', '-c', cmd], { cwd, env, stdio: ['ignore', 'pipe', 'pipe'] });
    } catch (err) {
      clearTimeout(timer);
      resolve({ text: err instanceof Error ? err.message : String(err), exitCode: null });
      return;
    }
    child.stdout?.on('data', append);
    child.stderr?.on('data', append);
    child.on('error', (err) => {
      clearTimeout(timer);
      append(Buffer.from(`\n${err instanceof Error ? err.message : String(err)}`));
      resolve({ text: buf, exitCode: null });
    });
    child.on('close', (code) => {
      clearTimeout(timer);
      resolve({ text: buf, exitCode: code });
    });
  });

  // Completion event — replaces the running row with the captured output.
  emit(
    wsId,
    makeLocalCommand(session.ctx, {
      commandId,
      command: cmd,
      running: false,
      output: output.text,
      exitCode: output.exitCode,
    }),
  );

  // Queue the command+output as context for the agent's NEXT real turn — the
  // Claude Code `<local-command-stdout>` mechanism. The agent never sees a turn
  // of its own from this; it just gains awareness of what the user ran.
  const exitLine =
    output.exitCode !== null && output.exitCode !== 0 ? ` (exit ${output.exitCode})` : '';
  session.pendingLocalContext.push(
    `<local-command-stdout command=${JSON.stringify(cmd)}${exitLine}>\n${output.text}\n</local-command-stdout>`,
  );
  // Bound the queued context (oldest-first drop): the transcript rows keep the
  // full record; only what's prepended to the NEXT model turn is capped.
  let total = session.pendingLocalContext.reduce((n, s) => n + s.length, 0);
  while (total > LOCAL_CONTEXT_CAP && session.pendingLocalContext.length > 1) {
    total -= session.pendingLocalContext.shift()!.length;
  }
}

/** Interrupt the in-flight turn (spike d: the consume loop will throw and the
 *  session ends). When NO live session exists but the folded view still reads
 *  `running` (a wedged state — e.g. the consume loop died without a result
 *  before the H1 ledger-close existed, or a history backfill ended mid-turn),
 *  the click used to be a silent no-op; now it emits a synthetic turn-end so
 *  the view self-heals (silent-failure audit M4). */
/** The control-request escape hatch. `Query.interrupt()` hardcodes
 *  `{subtype:'interrupt'}` and cannot carry `cancel_queued` (verified in
 *  sdk.mjs at 0.3.241), and `request()` is NOT on the public `Query` type — but
 *  it IS a real method on the runtime object (verified live: `typeof q.request
 *  === 'function'`). Same runtime-superset situation as `tool_result_meta`.
 *  Narrow, local, and only reached behind a capability check. */
type ControlRequester = {
  request?: (req: { subtype: 'interrupt'; cancel_queued?: boolean }) => Promise<unknown>;
};

/** Stop means stop: when the CLI advertises `interrupt_cancel_queued_v1`, the
 *  interrupt ALSO cancels queued/pending-dispatch messages (peer deliveries,
 *  task notifications) instead of letting them start a fresh turn the instant
 *  the abort lands. Orchestra's Stop button is exactly the "Stop-means-stop-
 *  everything client" the SDK docs describe.
 *
 *  Gated three ways, because each can independently be false on an older CLI or
 *  a future SDK: the capability must be advertised, `request` must exist on the
 *  runtime object, and the call must succeed — any miss falls back to the plain
 *  typed `interrupt()`, which is the pre-#26 behavior. */
async function interruptCancellingQueued(session: Session): Promise<void> {
  const supported = supportsCancelQueued(session.capabilities);
  const req = (session.q as unknown as ControlRequester).request;
  if (supported && typeof req === 'function') {
    try {
      await req.call(session.q, { subtype: 'interrupt', cancel_queued: true });
      return;
    } catch (err) {
      // The capability was advertised but the request failed — fall through to
      // the plain interrupt rather than leaving the turn running.
      log.warn(`agent-sdk: cancel_queued interrupt failed, falling back`, err);
    }
  }
  await session.q.interrupt();
}

export async function sdkInterrupt(wsId: string): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) {
    emit(wsId, {
      type: 'turn-end',
      // Unique even with no live Session: the workspace cursor outlives
      // sessions, so two failed sends can't both mint id `error:0`.
      seq: cursorFor(wsId).seq++,
      at: Date.now(),
      isError: false,
      stopReason: 'interrupted',
      numTurns: 0,
      costUsd: null,
      usage: null,
      resultText: null,
      sessionId: '',
      durationMs: null,
    });
    return;
  }
  // Mark BEFORE calling: the consume loop's catch reads this to label the
  // resulting throw an interrupt (not a crash) without text-matching /abort/.
  session.interruptRequested = true;
  try {
    await interruptCancellingQueued(session);
  } catch (err) {
    log.warn(`agent-sdk: interrupt failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'error',
        message: `Couldn't interrupt the turn: ${err instanceof Error ? err.message : String(err)}`,
        apiErrorStatus: null,
        willRetry: false,
      }),
    );
  }
}

/** Resolve a parked canUseTool call with the renderer's decision. */
export function sdkPermissionReply(
  wsId: string,
  requestId: string,
  reply: AgentPermissionReply,
): void {
  const session = sessions.get(wsId);
  if (!session) return;
  const resolve = session.pending.get(requestId);
  if (!resolve) return;
  session.pending.delete(requestId);
  if (reply.behavior === 'allow') {
    resolve({ behavior: 'allow', updatedInput: reply.updatedInput });
  } else {
    resolve({ behavior: 'deny', message: reply.message });
  }
}

// ---------- Background tasks (#19) ----------
//
// Two distinct SDK capabilities, easy to conflate because both are named for
// "background tasks" — they are opposites:
//
//  • `Query.stopTask(taskId)` KILLS a task that is already running in the
//    background. The CLI answers with a `task_notification` carrying
//    `status: 'stopped'`, which the normal event path folds onto the card — so
//    this function deliberately does NOT patch `session.tasks` itself. The card
//    flipping to "Stopped" is therefore evidence the CLI actually killed the
//    task, not evidence the button was clicked (an optimistic local flip would
//    make those two indistinguishable, which is exactly the failure the gate
//    for this issue is written to catch).
//
//  • `Query.backgroundTasks(toolUseId?)` MOVES in-flight FOREGROUND work
//    (a blocking Bash call or subagent) INTO the background — the SDK's Ctrl+B
//    parity. It returns a boolean, NOT state: there is no state-returning
//    background-task method anywhere on the `Query` interface at SDK 0.3.241
//    (verified by enumerating it). Anything that needs the live set reads the
//    ORGANIC `background_tasks_changed` level signal, which the fold already
//    reconciles with replace-semantics (see foldTaskEvent in
//    shared/agent-events.ts).

/** Kill a running background task via the SDK's `Query.stopTask`.
 *
 *  Resolves `true` when the request was accepted by the CLI. The card does NOT
 *  flip here: the CLI's own `task_notification { status: 'stopped' }` (or the
 *  `background_tasks_changed` level signal dropping the id) is what finalizes
 *  it through the normal fold, so a green button and a dead task stay separable.
 *
 *  Returns `false` when there is no live session — a task cannot outlive the
 *  CLI process that owns it, so there is nothing to stop and nothing to warn
 *  about. A genuine SDK failure surfaces as a `warning` notice (matching
 *  {@link sdkSetModel}'s rule that a UI must never silently lie about what the
 *  running session did) and also resolves `false`. */
export async function sdkStopTask(wsId: string, taskId: string): Promise<boolean> {
  const session = sessions.get(wsId);
  if (!session) return false;
  if (!taskId) return false;
  try {
    await session.q.stopTask(taskId);
    return true;
  } catch (err) {
    log.warn(`agent-sdk: stopTask failed for ${wsId} (${taskId})`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: `Couldn't stop the background task: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return false;
  }
}

/** Move in-flight FOREGROUND work into the background — the SDK's Ctrl+B
 *  parity (`Query.backgroundTasks`). Without `toolUseId` it backgrounds every
 *  foreground task; with one it targets just that tool_use block.
 *
 *  Resolves the SDK's own boolean: `true` when at least one task was
 *  backgrounded, `false` when a given `toolUseId` matched no foreground task.
 *  That `false` is a real contract outcome ("nothing to background"), not an
 *  error — the caller renders it as a no-op rather than a failure, so this
 *  function does not emit a notice for it. Only a thrown SDK/transport error
 *  gets a warning notice. */
export async function sdkBackgroundForegroundTasks(
  wsId: string,
  toolUseId?: string,
): Promise<boolean> {
  const session = sessions.get(wsId);
  if (!session) return false;
  try {
    return await session.q.backgroundTasks(toolUseId);
  } catch (err) {
    log.warn(`agent-sdk: backgroundTasks failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: `Couldn't move the running work to the background: ${err instanceof Error ? err.message : String(err)}`,
      }),
    );
    return false;
  }
}
/** Persist a partial workspace change and broadcast it so the renderer's store
 *  updates. Used to make the Model/Permissions dropdowns and the resume
 *  session-id stick even when no live session exists. */
async function persistWorkspacePatch(
  wsId: string,
  patch: Partial<Workspace>,
): Promise<void> {
  const ws = store.getWorkspace(wsId);
  if (!ws) return;
  const updated = { ...ws, ...patch };
  await store.upsertWorkspace(updated).catch((err) =>
    log.warn(`agent-sdk: persist workspace patch failed for ${wsId}`, err),
  );
  platform.broadcast('workspace:update', updated);
}

function persistSessionId(wsId: string, sessionId: string): Promise<void> {
  return persistWorkspacePatch(wsId, { sdkSessionId: sessionId });
}

/** Set the workspace's model. Persists to `ws.model` so the Model dropdown
 *  sticks and the choice applies when the session (re)starts, AND switches a
 *  live session immediately if one exists. Works before the first message. */
export async function sdkSetModel(wsId: string, model: string | undefined): Promise<void> {
  await persistWorkspacePatch(wsId, { model });
  const session = sessions.get(wsId);
  if (!session) return; // choice is persisted; it applies on next start
  // Reflect the switch in the folded session — session/init (the only other
  // source of session.model) fires once, so without this the dropdown snaps
  // back to the init value. '' conveys "session default".
  emit(wsId, stamp(session.ctx, { type: 'session/update', model: model ?? '' }));
  try {
    await session.q.setModel(model);
  } catch (err) {
    log.warn(`agent-sdk: setModel failed for ${wsId}`, err);
    // The dropdown already shows the NEW value (persisted; applies on restart) —
    // say out loud that the LIVE session kept the old model instead of letting
    // the UI silently lie about what's running (silent-failure audit M3).
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: 'Model switch could not be applied to the running session — it will apply on the next session start.',
      }),
    );
  }
}

/** Set the workspace's reasoning-effort level. Persists to `ws.sdkEffort` so
 *  the Effort slider sticks and the level applies when the session (re)starts
 *  (ensureSession's `options.effort`), AND switches a live session immediately
 *  via the SDK's `applyFlagSettings({effortLevel})` — the mid-session
 *  equivalent of the inline settings option, which accepts 'max'
 *  (session-scoped in CC's own settings; Orchestra re-applies it from its own
 *  store on restart). Works before the first message. The renderer reads the
 *  value straight from `ws.sdkEffort` (broadcast by persistWorkspacePatch), so
 *  no session/update event is needed — the SDK never reports effort back. */
export async function sdkSetEffort(wsId: string, effort: AgentEffortLevel): Promise<void> {
  await persistWorkspacePatch(wsId, { sdkEffort: effort });
  const session = sessions.get(wsId);
  if (!session) return; // choice is persisted; it applies on next start
  try {
    await session.q.applyFlagSettings({ effortLevel: effort });
  } catch (err) {
    // An older installed `claude` CLI may not know apply_flag_settings; the
    // persisted choice still applies on the next session start.
    log.warn(`agent-sdk: setEffort failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: 'Effort change could not be applied to the running session — it will apply on the next session start.',
      }),
    );
  }
}

/** Set the workspace's permission mode. Persists to `ws.sdkPermissionMode` so
 *  the dropdown sticks and the mode applies when the session (re)starts, AND
 *  switches a live session immediately. Works before the first message. */
export async function sdkSetPermissionMode(
  wsId: string,
  mode: AgentPermissionMode,
): Promise<void> {
  await persistWorkspacePatch(wsId, { sdkPermissionMode: mode });
  const session = sessions.get(wsId);
  if (!session) return; // choice is persisted; it applies on next start
  session.permissionMode = mode;
  emit(wsId, stamp(session.ctx, { type: 'session/update', permissionMode: mode }));
  try {
    await session.q.setPermissionMode(mode as never);
  } catch (err) {
    // Orchestra's own canUseTool bridge honors the new mode regardless (it reads
    // session.permissionMode live), but the CLI-side mode (plan-mode read-only
    // enforcement, edit auto-accept) did NOT switch — surface it.
    log.warn(`agent-sdk: setPermissionMode failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: 'Permission-mode switch could not be fully applied to the running session — it will apply on the next session start.',
      }),
    );
  }
}

// ---------- Skill / plugin hot-reload ----------
//
// Skills and plugins installed OUT OF BAND (a `git pull` in ~/.claude/skills, a
// plugin marketplace install, another agent writing a SKILL.md) are invisible to
// a session that is already running: the CLI resolved its skill and plugin set
// at startup. Restarting the session to pick them up costs the conversation's
// warm context, which is exactly the thing a long-lived agent is holding.
//
// The SDK exposes two control requests for this — `reloadSkills()` and
// `reloadPlugins()` — and Orchestra retains the `Query` handle per workspace
// (`session.q`), so both are reachable mid-session for every live agent at once.
//
// What each one covers is NOT the same, and the difference decides whether you
// need this verb at all:
//   - plain `~/.claude/skills`, `commands/` and `agents/` are WATCHED by the
//     CLI itself (a chokidar watch over `.md`, depth 2) and hot-reload on their
//     own. `reloadSkills()` is the explicit nudge for when that watch didn't
//     fire — a skill added outside the watched depth, or a project-level
//     `.claude/skills` the watch never covered.
//   - the PLUGIN cache (`~/.claude/plugins/cache/…`) is NOT watched. A plugin
//     install is invisible to a running session until something calls
//     `reloadPlugins()`, which is why `--plugins` exists as an explicit opt-in.
//
// Both are TRANSIENT runtime actions: nothing is persisted (contrast
// {@link sdkSetModel}, which writes `ws.model` so the choice survives a
// restart). There is nothing to persist — a reload has no state, only an
// effect on the process that is running right now, and a session that starts
// later reads the new skills at startup anyway.

/** How long to wait before issuing `reloadPlugins()`, to let the CLI's settings
 *  cache turn over.
 *
 *  MEASURED, and the reason this constant exists at all: immediately after an
 *  out-of-band plugin install, the FIRST `reloadPlugins()` returns
 *  `plugins: []` — the settings file carrying `enabledPlugins` sits behind a
 *  ~2s cache, so the reload re-reads a stale view and finds nothing enabled.
 *  Two back-to-back immediate calls both came back empty; a single call issued
 *  after ~5s picked the plugin up. So the wait is not politeness, it is what
 *  makes the FIRST call the one that works.
 *
 *  Only paid on the `--plugins` path, and only once per fan-out (not per
 *  workspace) — see {@link dispatchReloadSkillsRequest}. */
const PLUGIN_RELOAD_SETTLE_MS = 2_500;

/** Reload the skill set of a workspace's LIVE session.
 *
 *  Returns `'skipped'` when the workspace has no live session — deliberately
 *  NOT `ensureSession`. Booting a session in order to reload its skills would
 *  be backwards (a fresh session reads the new skills at startup regardless),
 *  and on the `--all` fan-out it would cold-start every idle workspace in the
 *  sidebar, spawning ~20 CLI processes as a side effect of a refresh. "No live
 *  session" is the normal state for most workspaces and is reported as such
 *  rather than as an error.
 *
 *  Emits an `info` notice into the transcript on success so the agent's own
 *  view records that its capabilities changed underneath it — otherwise a skill
 *  appears mid-conversation with no explanation of where it came from — and a
 *  `warning` notice on failure, matching {@link sdkSetModel}'s rule that the
 *  UI never silently lies about what the running session actually has. */
export async function sdkReloadSkills(wsId: string): Promise<ReloadResult> {
  const ws = store.getWorkspace(wsId);
  const label = ws?.branch ?? ws?.name ?? wsId;
  const session = sessions.get(wsId);
  if (!session) return { id: wsId, label, outcome: 'skipped' };
  try {
    const res = await session.q.reloadSkills();
    const skills = res?.skills?.length ?? 0;
    slog.info(`reload-skills ${wsId}: session reports ${skills} skill(s)`);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'info',
        text: `Skills reloaded — ${skills} available to this session.`,
      }),
    );
    return { id: wsId, label, outcome: 'reloaded', skills };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: reloadSkills failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: `Skills could not be reloaded into the running session (${message}) — restart the session to pick them up.`,
      }),
    );
    return { id: wsId, label, outcome: 'failed', error: message };
  }
}

/** Reload the plugin set (and, with it, the commands/agents/MCP servers plugins
 *  contribute) of a workspace's LIVE session. Same skip/notice contract as
 *  {@link sdkReloadSkills}.
 *
 *  An EMPTY `plugins` array is NOT a failure — see {@link isPluginReloadFailure}
 *  for the measured reasoning. It is reported as a plain count so the caller can
 *  see it, and the caller waits out {@link PLUGIN_RELOAD_SETTLE_MS} before
 *  getting here so the count is usually the real one. */
export async function sdkReloadPlugins(wsId: string): Promise<ReloadResult> {
  const ws = store.getWorkspace(wsId);
  const label = ws?.branch ?? ws?.name ?? wsId;
  const session = sessions.get(wsId);
  if (!session) return { id: wsId, label, outcome: 'skipped' };
  try {
    const res = await session.q.reloadPlugins();
    const plugins = res?.plugins?.length ?? 0;
    // Deliberately not branched on: the predicate always answers "not a
    // failure". It is called anyway so the rule is expressed in code at the one
    // place a future edit would be tempted to add `if (!plugins) throw`.
    if (isPluginReloadFailure(res ?? {})) {
      throw new Error('plugin reload reported no usable plugin set');
    }
    slog.info(`reload-plugins ${wsId}: session reports ${plugins} plugin(s)`);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'info',
        text: `Plugins reloaded — ${plugins} active in this session.`,
      }),
    );
    return { id: wsId, label, outcome: 'reloaded', plugins };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: reloadPlugins failed for ${wsId}`, err);
    emit(
      wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'warning',
        text: `Plugins could not be reloaded into the running session (${message}) — restart the session to pick them up.`,
      }),
    );
    return { id: wsId, label, outcome: 'failed', error: message };
  }
}

/** Reload skills (and optionally plugins) for one workspace, merging both
 *  results into the single row the caller reports.
 *
 *  Merge rule: a failure on EITHER half fails the row. A row that said
 *  "reloaded" because skills succeeded while plugins threw would be the silent
 *  half-success this repo keeps paying for — the user installed a plugin, the
 *  report said reloaded, and the session never saw it. */
async function reloadOne(wsId: string, withPlugins: boolean): Promise<ReloadResult> {
  const skills = await sdkReloadSkills(wsId);
  if (!withPlugins || skills.outcome === 'skipped') return skills;
  const plugins = await sdkReloadPlugins(wsId);
  return {
    ...skills,
    outcome: plugins.outcome === 'failed' ? 'failed' : skills.outcome,
    plugins: plugins.plugins,
    error: skills.error ?? plugins.error,
  };
}

/** The `/reloadSkills` socket route behind `orchestra reload-skills`.
 *
 *  Fan-out (`all: true`) iterates the LIVE `sessions` map rather than the
 *  workspace store: the store lists every workspace that has ever existed
 *  (archived ones included), and only a live session can be reloaded at all, so
 *  iterating sessions is both the correct set and the cheap one. One
 *  out-of-band install therefore reaches every running agent in a single call,
 *  which is the point — a 20-workspace sidebar is not somewhere you re-run a
 *  command per row.
 *
 *  The snapshot (`[...sessions.keys()]`) is taken UP FRONT and deliberately:
 *  the awaits below yield, and a session that dies mid-fan-out would otherwise
 *  mutate the map we are iterating. A workspace that ends between snapshot and
 *  call simply reports `skipped`, which is already a first-class outcome. */
export async function dispatchReloadSkillsRequest(input: {
  id?: string;
  all?: boolean;
  plugins?: boolean;
}): Promise<{ ok: boolean; results?: ReloadResult[]; error?: string }> {
  const withPlugins = input.plugins === true;
  if (!input.all && !input.id) return { ok: false, error: 'missing id (or pass --all)' };
  // Pay the settings-cache wait ONCE for the whole fan-out, before any call —
  // the cache is per-CLI-install, not per-session, so waiting per workspace
  // would multiply a 2.5s wait by the number of live agents for no benefit.
  if (withPlugins) await new Promise((r) => setTimeout(r, PLUGIN_RELOAD_SETTLE_MS));
  if (input.all) {
    const ids = [...sessions.keys()];
    const results: ReloadResult[] = [];
    for (const id of ids) results.push(await reloadOne(id, withPlugins));
    slog.info(`reload-skills --all: ${summarizeReload(results)}`);
    return { ok: true, results };
  }
  const ws = store.getWorkspace(input.id!);
  if (!ws) return { ok: false, error: 'unknown workspace' };
  return { ok: true, results: [await reloadOne(input.id!, withPlugins)] };
}

/** The shape of the SDK worker's `remote_control` control-request response. The
 *  `Query.enableRemoteControl(enabled, name?)` method exists on the concrete
 *  query object (sdk.mjs) but is not in the public `Query` d.ts, so we type it
 *  locally. On enable the worker returns `{ session_url, connect_url,
 *  environment_id }` (the claude.ai/code link to drive the session from another
 *  device); disable resolves with no payload. */
interface RemoteControlResponse {
  session_url?: string;
  connect_url?: string;
  environment_id?: string;
}
type QueryWithRemoteControl = Query & {
  enableRemoteControl?: (enabled: boolean, name?: string) => Promise<RemoteControlResponse | void>;
};

/** Emit (and remember on the session) a Remote Control state change, folded into
 *  `AgentSession.remoteControl`. */
function emitRemoteControl(session: Session, state: RemoteControlState): void {
  session.remoteControl = state;
  emit(session.wsId, stamp(session.ctx, { type: 'session/remote-control', state }));
}

/** Enable or disable Remote Control for a workspace's structured session —
 *  Orchestra's parity with Claude Code's `/remote-control`. Starts the session
 *  lazily (enabling before the first turn is valid, matching CC's
 *  `remoteControlAtStartup`). On enable, calls the SDK's `enableRemoteControl(true)`
 *  control request; the worker opens a bridge to Anthropic's relay and returns
 *  the `session_url` (claude.ai/code/<id>) the user opens on another device / the
 *  Claude mobile app. Failures (org policy, rollout-not-enabled, network) surface
 *  as `state.error` instead of silently staying off. */
export async function sdkSetRemoteControl(wsId: string, enabled: boolean): Promise<void> {
  let session: Session;
  try {
    session = await ensureSession(wsId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: could not start session for remote control ${wsId}: ${message}`);
    emit(wsId, {
      type: 'error',
      // Unique even with no live Session: the workspace cursor outlives
      // sessions, so two failed sends can't both mint id `error:0`.
      seq: cursorFor(wsId).seq++,
      at: Date.now(),
      message: `Couldn't start the agent: ${message}`,
      apiErrorStatus: null,
      willRetry: false,
    });
    throw err;
  }
  const q = session.q as QueryWithRemoteControl;
  if (typeof q.enableRemoteControl !== 'function') {
    emitRemoteControl(session, {
      active: false,
      error: 'Remote Control is not available in this Claude Code version.',
    });
    return;
  }
  // Optimistic pending state so the toggle disables itself against double-clicks.
  emitRemoteControl(session, {
    ...(session.remoteControl ?? { active: false }),
    pending: true,
    error: undefined,
  });
  try {
    const res = (await q.enableRemoteControl(enabled)) || {};
    if (enabled) {
      emitRemoteControl(session, {
        active: true,
        sessionUrl: res.session_url,
        connectUrl: res.connect_url,
        environmentId: res.environment_id,
        pending: false,
      });
    } else {
      emitRemoteControl(session, { active: false, pending: false });
    }
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: enableRemoteControl(${enabled}) failed for ${wsId}`, err);
    // On a failed ENABLE the bridge did not come up → stay inactive with the
    // reason. A failed DISABLE leaves the prior state but surfaces the error.
    emitRemoteControl(session, {
      ...(enabled ? { active: false } : (session.remoteControl ?? { active: false })),
      pending: false,
      error: message || 'Remote Control request failed.',
    });
  }
}

// ─── MCP server tracking + control (`/mcp` popover, Option-D design) ─────────

/** The SDK's `McpServerStatus` shape, read loosely (see SdkMessage's rationale:
 *  optional everywhere so a missing field degrades, never throws). */
interface RawMcpServerStatus {
  name?: string;
  status?: string;
  error?: string;
  tools?: { name?: string }[];
}

/** Map one SDK `McpServerStatus` onto Orchestra's {@link AgentMcpServer}. */
function toAgentMcpServer(s: RawMcpServerStatus): AgentMcpServer {
  return {
    name: s?.name ?? '',
    status: s?.status ?? '',
    ...(Array.isArray(s?.tools) && s.tools.length > 0 ? { toolCount: s.tools.length } : {}),
    ...(typeof s?.error === 'string' && s.error ? { error: s.error } : {}),
  };
}

/** Fetch the live MCP server list from the session's query and broadcast it as
 *  a `session/mcp` full-list event (folded into `AgentSession.mcpServers`, so
 *  every attached client — and a later replay — agrees with the popover). */
async function emitMcpServers(session: Session): Promise<AgentMcpServer[]> {
  const q = session.q as Query & { mcpServerStatus?: () => Promise<RawMcpServerStatus[]> };
  if (typeof q.mcpServerStatus !== 'function') {
    throw new Error('MCP server status is not available in this Claude Code version.');
  }
  const raw = await q.mcpServerStatus();
  const servers = (Array.isArray(raw) ? raw : []).map(toAgentMcpServer);
  emit(session.wsId, stamp(session.ctx, { type: 'session/mcp', servers }));
  return servers;
}

/** Current MCP server statuses for the `/mcp` popover. Lazily starts the
 *  session (like Remote Control): CC's `/mcp` also runs in-session, and the
 *  status/toggle/reconnect control requests all need a live query. */
export async function sdkMcpStatus(wsId: string): Promise<AgentMcpServer[]> {
  const session = await ensureSession(wsId);
  return emitMcpServers(session);
}

/** Enable/disable one MCP server on the LIVE session (SDK `toggleMcpServer` —
 *  no session restart; the CLI persists the toggle for future sessions). Emits
 *  a quiet transcript notice with the outcome plus a `session/mcp` refresh, and
 *  returns the refreshed list so the popover can render it without a second
 *  round-trip. */
export async function sdkMcpToggle(
  wsId: string,
  serverName: string,
  enabled: boolean,
): Promise<AgentMcpServer[]> {
  const session = await ensureSession(wsId);
  const q = session.q as Query & {
    toggleMcpServer?: (name: string, enabled: boolean) => Promise<void>;
  };
  if (typeof q.toggleMcpServer !== 'function') {
    throw new Error('MCP server toggling is not available in this Claude Code version.');
  }
  try {
    await q.toggleMcpServer(serverName, enabled);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: toggleMcpServer(${serverName}, ${enabled}) failed for ${wsId}`, err);
    emit(
      session.wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'mcp-error',
        text: `Couldn't ${enabled ? 'enable' : 'disable'} ${serverName} — ${message}`,
      }),
    );
    throw err;
  }
  const servers = await emitMcpServers(session);
  // Announce the outcome in the transcript (Option D: connection history lives
  // in the conversation flow). Enabling reports the resulting connection state
  // ("connected · N tools" / "failed to connect"); disabling is user intent,
  // announced at info prominence rather than as an error.
  const changed = servers.find((s) => s.name === serverName);
  const text = enabled
    ? changed
      ? describeMcpServer(changed)
      : `${serverName} enabled`
    : `${serverName} disabled`;
  if (text) {
    emit(
      session.wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: !enabled ? 'info' : changed && changed.status !== 'connected' ? 'mcp-error' : 'mcp',
        text,
      }),
    );
  }
  return servers;
}

/** Re-enumerate MCP servers from scratch by RESTARTING the CLI process —
 *  the popover's "refresh" action, and the only way to pick up account-level
 *  changes.
 *
 *  ## Why a restart is the mechanism
 *
 *  The set of `claude.ai` connectors (and their `mcpsrv_…` ids) is resolved by
 *  the CLI ONCE, at process start. Nothing in the SDK re-fetches it:
 *  `mcpServerStatus()` re-reads the CLI's existing view, `reconnectMcpServer()`
 *  re-dials one already-known server. So if the account's connectors change
 *  (a connector added/removed/re-connected on claude.ai — which mints a NEW
 *  `mcpsrv_` id), a long-lived CLI keeps serving the stale set indefinitely,
 *  and its auth URLs 404 with "Server not found" against ids that no longer
 *  exist. Observed 2026-08-13: a CLI ~2.5h old still offering a dead Slack id.
 *
 *  Crucially, the DETACHED KEEPER (session-keeper.md) means "restart the app"
 *  does NOT fix this — the app reattaches to the same surviving CLI, so the
 *  stale enumeration outlives every relaunch. Before this, the only real
 *  remedy was `/clear` (destroys the conversation) or killing the process by
 *  hand. Hence an explicit action.
 *
 *  ## Conversation safety
 *
 *  {@link sdkStop} deliberately does NOT touch the persisted `sdkSessionId`
 *  (only {@link sdkClear} does) — so the next `ensureSession` RESUMES the same
 *  conversation in a brand-new process. The transcript survives; only the OS
 *  process is replaced.
 *
 *  Refuses while a turn is in flight rather than killing the agent mid-answer:
 *  the caller surfaces that as an inline popover error. */
export async function sdkMcpRefresh(wsId: string): Promise<AgentMcpServer[]> {
  const live = sessions.get(wsId);
  // `turnGate` is non-null exactly while a turn is in flight (same idiom as
  // the reattach path's `hadOpenTurn`).
  if (live && live.turnGate !== null) {
    throw new Error('The agent is working — interrupt it first, then refresh.');
  }
  // Tear down (graceful: lets the CLI flush its transcript), then make sure
  // the keeper's process is really gone before booting a replacement. Without
  // the killKeeper backstop, ensureSession below could reattach to the very
  // process we are trying to replace and the refresh would be a no-op.
  await sdkStop(wsId);
  await killKeeper(wsId).catch(() => {
    /* already gone — the common case after a graceful stop */
  });
  const session = await ensureSession(wsId);
  // A just-booted CLI reports every server as `pending` for a few seconds while
  // it dials them. Returning that first snapshot would leave the popover
  // showing "connecting…" for all of them FOREVER: the popover has no polling,
  // and the next `session/mcp` broadcast would otherwise only arrive on the
  // next turn's init. So settle here — each emitMcpServers() also broadcasts,
  // so an open popover updates live as servers land rather than jumping at the
  // end. Bounded: a server that never leaves `pending` must not hang the IPC.
  let servers = await emitMcpServers(session);
  const settleBy = Date.now() + MCP_REFRESH_SETTLE_MS;
  while (servers.some((s) => s.status === 'pending') && Date.now() < settleBy) {
    await new Promise((r) => setTimeout(r, MCP_REFRESH_SETTLE_POLL_MS));
    servers = await emitMcpServers(session);
  }
  const stillPending = servers.filter((s) => s.status === 'pending').length;
  slog.info(
    `mcp refresh ${wsId}: re-enumerated ${servers.length} server(s) on a fresh CLI` +
      (stillPending ? ` (${stillPending} still connecting after settle window)` : ''),
  );
  emit(
    session.wsId,
    stamp(session.ctx, {
      type: 'notice',
      kind: 'mcp',
      text: `MCP servers re-enumerated on a fresh session — ${servers.length} server(s)`,
    }),
  );
  return servers;
}

/** Reconnect one MCP server (SDK `reconnectMcpServer`) — the popover's retry
 *  action for a `failed` / `needs-auth` server. Emits the outcome notice and a
 *  `session/mcp` refresh; returns the refreshed list. */
export async function sdkMcpReconnect(wsId: string, serverName: string): Promise<AgentMcpServer[]> {
  const session = await ensureSession(wsId);
  const q = session.q as Query & { reconnectMcpServer?: (name: string) => Promise<void> };
  if (typeof q.reconnectMcpServer !== 'function') {
    throw new Error('MCP server reconnect is not available in this Claude Code version.');
  }
  let reconnectError: string | null = null;
  try {
    await q.reconnectMcpServer(serverName);
  } catch (err) {
    // Keep going: the status refresh below is the source of truth either way.
    reconnectError = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: reconnectMcpServer(${serverName}) failed for ${wsId}`, err);
  }
  const servers = await emitMcpServers(session);
  const server = servers.find((s) => s.name === serverName);
  const text = reconnectError
    ? `${serverName} failed to reconnect — ${reconnectError}`
    : server
      ? describeMcpServer(server)
      : null;
  if (text) {
    emit(
      session.wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: !reconnectError && server?.status === 'connected' ? 'mcp' : 'mcp-error',
        text,
      }),
    );
  }
  return servers;
}

/** How long the OAuth flow may take end-to-end (user switches to the browser,
 *  logs in, approves). Claude Code's own flow is similarly patient. */
const MCP_AUTH_TIMEOUT_MS = 180_000;
/** Status-poll cadence while waiting for the fresh token to land. */
const MCP_AUTH_POLL_MS = 2_000;
/** Per-call bound on a single `mcpServerStatus()` control request. Some
 *  providers (observed with claude.ai connectors like Slack/Datadog) leave the
 *  CLI's mcp subsystem wedged on that ONE server mid-handshake — the request
 *  never rejects, it just never comes back. Without this, that single stuck
 *  await silently defeats {@link MCP_AUTH_TIMEOUT_MS}: the deadline is only
 *  ever re-checked *between* completed status calls, so one hung call means
 *  the popover spins forever (and every retry click just piles on another
 *  permanently-pending promise, still spinning). */
const MCP_STATUS_TIMEOUT_MS = 10_000;
/** How long {@link sdkMcpRefresh} waits for a freshly-booted CLI's servers to
 *  finish connecting before returning. Only a bound, not a target: it returns
 *  as soon as nothing is `pending`. */
const MCP_REFRESH_SETTLE_MS = 30_000;
/** Re-poll cadence inside that settle window. Each poll also broadcasts
 *  `session/mcp`, so an open popover ticks from "connecting…" to the real
 *  status as each server lands. */
const MCP_REFRESH_SETTLE_POLL_MS = 1_000;
/** NOT taken: actively nudging `reconnectMcpServer()` every N seconds WHILE
 *  the poll loop runs. A live cross-workspace probe (2026-08-13) showed the
 *  underlying connection for a `claude.ai`-account connector (Slack) can go
 *  fully functional — real tool calls succeeding — while `mcpServerStatus()`
 *  keeps reporting `needs-auth`, which made an active nudge look attractive.
 *  A periodic version shipped (v0.5.226) and was reverted (v0.5.228): the
 *  only signal available to gate it is `mcpAuthenticate()`'s own request
 *  settling, and for exactly this provider class that request resolves
 *  almost immediately (URL handed back) — long before the user finishes the
 *  consent step in the browser. So the nudge would fire every ~15s *during*
 *  the user's browser step, and whether `mcp_reconnect` can rotate/invalidate
 *  an in-flight PKCE exchange for the same server is undocumented
 *  CLI-internal behavior with no way to verify from here. No confirmed
 *  benefit for the case it targeted, and an unruled-out chance of breaking
 *  every such auth deterministically, was not a trade worth taking.
 *
 *  TAKEN instead (v0.5.230): a SINGLE `reconnectMcpServer()` call at the
 *  timeout boundary, after the loop gives up — see its call site below. By
 *  then MCP_AUTH_TIMEOUT_MS has fully elapsed, so the browser step is either
 *  finished or abandoned; there's no live exchange left to interleave with,
 *  which is precisely what made the periodic version unsafe. This recovers
 *  most of the periodic nudge's value (reconciling a connection that's
 *  already live) in the one spot a false negative is most expensive, without
 *  reintroducing the risk.
 *
 *  If a claude.ai connector auth ever starts failing outright despite this:
 *  that failure mode is INDISTINGUISHABLE BY SYMPTOM from the bug this file
 *  originally fixed — both look like "popover row spins, auth never
 *  completes". Don't assume a regression in the status-poll fix above; the
 *  discriminator is timing, not appearance. Stale status resolves on ITS OWN
 *  if you wait, or on a later MANUAL reconnect — the connection was live the
 *  whole time (this is what the boundary call above already tries once). A
 *  genuinely broken exchange never resolves no matter how long you wait or
 *  how many times you reconnect after the fact, because the server-side
 *  authorization itself failed. One question — "does it come good on a later
 *  manual reconnect?" — separates the two in a single step, and saves a
 *  session spent debugging the wrong file. (h/t a sibling agent's review,
 *  2026-08-13, for the original nudge's evidence, this discriminator, and
 *  the boundary-call design that replaced the periodic version.) */

/** Run the OAuth flow for a `needs-auth` MCP server — Claude Code's `/mcp`
 *  authenticate, as the popover's ↻ action:
 *
 *  1. `mcpAuthenticate(serverName)` (internal control request, typed locally
 *     like `enableRemoteControl`) asks the CLI to start the flow. Its response
 *     shape is undocumented, so {@link firstHttpUrl} deep-scans it for the
 *     authorization link; if one surfaces, it opens in the SYSTEM browser
 *     (existing login cookies live there, and some providers refuse webviews).
 *     If none does, the CLI may have opened/completed the flow itself — either
 *     way the poll below is the source of truth.
 *  2. Poll `mcpServerStatus()` until the server leaves `needs-auth` (fresh
 *     token landed → the CLI reconnects it) or the timeout hits. The
 *     renderer's row shows "waiting for authentication…" while this IPC
 *     promise is pending.
 *  2b. If step 2 hits the timeout still needing auth, ONE last-ditch
 *     `reconnectMcpServer()` before giving up — see the comment at its call
 *     site for why this single boundary call is safe where a mid-loop nudge
 *     was not.
 *  3. Broadcast the final `session/mcp` + an outcome notice, and resolve with
 *     the refreshed list.
 *
 *  The authenticate promise itself may resolve fast (URL handed back) or only
 *  after the callback completes — both are handled: it is raced against the
 *  poll loop, and whichever signals completion first wins. */
export async function sdkMcpAuth(wsId: string, serverName: string): Promise<AgentMcpServer[]> {
  const session = await ensureSession(wsId);
  const q = session.q as Query & {
    mcpAuthenticate?: (serverName: string, redirectUri?: string) => Promise<unknown>;
    mcpServerStatus?: () => Promise<RawMcpServerStatus[]>;
  };
  const { mcpAuthenticate, mcpServerStatus, reconnectMcpServer } = q;
  if (typeof mcpAuthenticate !== 'function' || typeof mcpServerStatus !== 'function') {
    throw new Error('MCP authentication is not available in this Claude Code version.');
  }
  // Bound: these are class methods on the concrete Query (they use `this`).
  const bound = {
    mcpAuthenticate: mcpAuthenticate.bind(q),
    mcpServerStatus: mcpServerStatus.bind(q),
    // Optional: older SDKs may lack it. Used ONLY once, at the timeout
    // boundary — see MCP_STATUS_TIMEOUT_MS's neighboring comment for why a
    // mid-loop nudge was rejected but this single call is safe.
    reconnectMcpServer: typeof reconnectMcpServer === 'function' ? reconnectMcpServer.bind(q) : undefined,
  };
  try {
    try {
      return await runMcpAuthFlow(session, bound, serverName);
    } catch (err) {
      // Clicking ↻ seconds after a cold /mcp open races the subprocess boot —
      // control requests throw "ProcessTransport is not ready for writing"
      // until the transport opens. That is the EXPECTED first interaction for
      // a user who opened /mcp to fix auth, so retry once after a beat rather
      // than making them click again.
      const m = err instanceof Error ? err.message : String(err);
      if (!/not ready/i.test(m)) throw err;
      slog.info(`mcp auth ${serverName}: transport not ready, retrying once`);
      await new Promise((r) => setTimeout(r, 3_000));
      return await runMcpAuthFlow(session, bound, serverName);
    }
  } catch (err) {
    // A thrown flow (e.g. a control request racing the session boot —
    // "ProcessTransport is not ready") must STILL write its outcome into the
    // transcript, like every other MCP op; the popover additionally shows the
    // rejection inline.
    const message = err instanceof Error ? err.message : String(err);
    emit(
      session.wsId,
      stamp(session.ctx, {
        type: 'notice',
        kind: 'mcp-error',
        text: `${serverName} authentication failed — ${message}`,
      }),
    );
    throw err;
  }
}

async function runMcpAuthFlow(
  session: Session,
  q: {
    mcpAuthenticate: (serverName: string, redirectUri?: string) => Promise<unknown>;
    mcpServerStatus: () => Promise<RawMcpServerStatus[]>;
    reconnectMcpServer?: (serverName: string) => Promise<void>;
  },
  serverName: string,
): Promise<AgentMcpServer[]> {
  const deadline = Date.now() + MCP_AUTH_TIMEOUT_MS;
  let opened = false;
  let authError: string | null = null;

  // Kick off the flow. Do NOT await to completion before polling — the promise
  // may only resolve after the user finishes in the browser.
  const authPromise = q
    .mcpAuthenticate(serverName)
    .then((res) => {
      const url = firstHttpUrl(res);
      if (url && !opened) {
        opened = true;
        slog.info(`mcp auth ${serverName}: opening authorization URL`);
        void platform.openExternal(url);
      }
    })
    .catch((err) => {
      authError = err instanceof Error ? err.message : String(err);
      slog.warn(`mcp auth ${serverName} failed for ${session.wsId}: ${authError}`);
    });
  // Give a fast URL-carrying response a moment to surface before polling.
  await Promise.race([authPromise, new Promise((r) => setTimeout(r, 1_500))]);

  const stillNeedsAuth = (servers: AgentMcpServer[]) => {
    const s = servers.find((x) => x.name === serverName);
    // A server MISSING from the status list is terminal, not pending — it was
    // removed from config (or never existed); polling can't make it appear,
    // so waiting the full timeout would just hold the popover row for 3 min.
    return s !== undefined && (s.status === 'needs-auth' || s.status === 'pending');
  };

  // Bounded status check: on timeout, return null rather than hanging — the
  // caller keeps its last-known list and the outer while's Date.now() check
  // still fires next iteration, so a wedged control request degrades to "stale
  // reading, deadline still enforced" instead of "stuck forever".
  const pollStatus = async (): Promise<AgentMcpServer[] | null> => {
    const STUCK = Symbol('mcp-status-timeout');
    const result = await Promise.race([
      q.mcpServerStatus().catch(() => STUCK),
      new Promise<typeof STUCK>((r) => setTimeout(() => r(STUCK), MCP_STATUS_TIMEOUT_MS)),
    ]);
    if (result === STUCK) {
      slog.warn(`mcp auth ${serverName}: mcpServerStatus() stuck/failed for ${session.wsId}`);
      return null;
    }
    return (Array.isArray(result) ? result : []).map(toAgentMcpServer);
  };

  // `haveReading` distinguishes "never got a real status yet" from "got one
  // and the server is genuinely gone" — pollStatus() returning null (stuck
  // call) must NOT collapse servers to `[]` and have stillNeedsAuth's
  // missing-is-terminal rule mistake "no data yet" for "server was removed"
  // and bail out on the very first iteration.
  let servers: AgentMcpServer[] = [];
  let haveReading = false;
  const firstRead = await pollStatus();
  if (firstRead !== null) {
    servers = firstRead;
    haveReading = true;
  }
  while ((!haveReading || stillNeedsAuth(servers)) && authError === null && Date.now() < deadline) {
    await Promise.race([authPromise, new Promise((r) => setTimeout(r, MCP_AUTH_POLL_MS))]);
    const next = await pollStatus();
    if (next !== null) {
      servers = next;
      haveReading = true;
    }
  }

  // ONE last-ditch reconnect right at the timeout boundary, before reporting
  // failure — NOT a mid-loop nudge (see the "NOT taken" comment above
  // MCP_STATUS_TIMEOUT_MS for why that was reverted). This is a different,
  // narrower move: by the time we're here, MCP_AUTH_TIMEOUT_MS (3 minutes)
  // has already elapsed, so the user's browser step is either finished or
  // abandoned — there is no live PKCE exchange left for a reconnect to
  // interrupt. If mcpServerStatus() has simply been lagging a connection
  // that's ACTUALLY already live (the exact staleness this file's poll loop
  // was diagnosed with), this is the one call that can still catch it before
  // the user is told "it didn't work" — precisely where a false negative is
  // most expensive. Best-effort and silent on failure: worst case, nothing
  // changes and the existing timeout message still fires below.
  if (authError === null && stillNeedsAuth(servers) && q.reconnectMcpServer) {
    await q.reconnectMcpServer(serverName).catch((err) => {
      slog.info(
        `mcp auth ${serverName}: timeout-boundary reconnect failed for ${session.wsId} — ${err instanceof Error ? err.message : String(err)}`,
      );
    });
    const finalRead = await pollStatus();
    if (finalRead !== null) servers = finalRead;
  }

  // Broadcast whatever we ended on (even a timeout leaves fresher state than
  // the popover's seed) and write the outcome into the transcript.
  emit(session.wsId, stamp(session.ctx, { type: 'session/mcp', servers }));
  const server = servers.find((s) => s.name === serverName);
  const connected = server?.status === 'connected';
  const text = connected
    ? describeMcpServer(server)
    : authError
      ? `${serverName} authentication failed — ${authError}`
      : `${serverName} authentication timed out — finish the flow in your browser, then retry`;
  if (text) {
    emit(
      session.wsId,
      stamp(session.ctx, { type: 'notice', kind: connected ? 'mcp' : 'mcp-error', text }),
    );
  }
  return servers;
}

/** Tear down a workspace's session (stop/interrupt + drop). Called on explicit
 *  stop and on workspace removal so a deleted workspace never leaks a query. */
export async function sdkStop(wsId: string): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) {
    // No in-memory session — but a DETACHED KEEPER may still be running this
    // workspace's CLI (app relaunched while a turn survived the quit). Every
    // explicit-stop path (/clear, rewind, archive, delete, hibernate, branch
    // switch, account migration) funnels through here and must not leave an
    // orphan CLI running a conversation the app just discarded. Best-effort:
    // instant no-op when no keeper exists.
    void killKeeper(wsId);
    return;
  }
  session.stopping = true;
  // Wake any waiters so the generator returns, then interrupt to unwind the SDK.
  session.pump?.();
  session.turnGate?.();
  try {
    await session.q.interrupt();
  } catch {
    // interrupt on an already-ended query throws; ignore.
  }
  sessions.delete(wsId);
  // NOTE: no killKeeper here — the SDK's graceful close ends stdin, which the
  // bridge forwards as a stdinEnd frame; the keeper then EOF→SIGTERM→SIGKILL
  // escalates on its own clock. That preserves the CLI's clean shutdown
  // (transcript flush) where an immediate SIGTERM would race it.
}

/** Clear the conversation (composer `/clear` — parity with Claude Code): tear
 *  down any live session WITHOUT letting its tail events dirty the view, drop
 *  the persisted resume id, and broadcast `session/clear` so every attached
 *  client resets its folded transcript. The next send starts a brand-new
 *  conversation in the same worktree.
 *
 *  The resume id is set to `''` (not `undefined`): `''` is the explicit
 *  "cleared" marker that also disables sdkHistory's newest-.jsonl fallback —
 *  otherwise a remount after /clear would backfill the just-cleared
 *  conversation right back. Both values are falsy where it matters
 *  (ensureSession's `resume` gate), and the next live session overwrites it
 *  with the fresh id. */
export async function sdkClear(wsId: string): Promise<void> {
  const session = sessions.get(wsId);
  if (session) {
    session.cleared = true;
    await sdkStop(wsId);
  }
  await persistWorkspacePatch(wsId, { sdkSessionId: '' });
  emit(wsId, {
    type: 'session/clear',
    seq: cursorFor(wsId).seq++,
    at: Date.now(),
  });
}

/** Rewind the conversation to a previous user message — Claude Code's
 *  double-Esc restore, as an explicit per-message action (parity feature).
 *
 *  `rewindId` is the {@link AgentUserMessageEvent.rewindId} of the message being
 *  UNDONE: it and everything after it leave the conversation, and the files that
 *  turn touched are restored. `prevRewindId` is the uuid of the user message
 *  BEFORE it, or undefined when rewinding the very first turn.
 *
 *  ## Why two ids
 *
 *  The two SDK primitives take DIFFERENT targets, and conflating them is an
 *  off-by-one that silently keeps or drops a whole turn:
 *    • `rewindFiles(rewindId)` — restores files to their state AT that message,
 *      i.e. before its edits. Targets the message being undone.
 *    • `resumeSessionAt(uuid)` — keeps turns 1..N **inclusive** of the targeted
 *      message (measured, not inferred: docs/spikes/rewind-sdk-findings.md).
 *      So to DROP the target we must cut at its PREDECESSOR.
 *  Rewinding the first message therefore has no cut target at all — the next
 *  send starts a fresh session (`sdkSessionId: ''`, the explicit cleared marker).
 *
 *  ## Ordering
 *
 *  `rewindFiles` runs on the LIVE query object BEFORE teardown — checkpoints are
 *  session-scoped, so a stopped (or forked) session can no longer restore them.
 *  Files first, then stop, then park the conversation cut for the next start.
 *
 *  The file restore is best-effort and NEVER blocks the conversation rewind: a
 *  session that predates `enableFileCheckpointing` has no snapshots and the SDK
 *  reports `canRewind:false` (or throws "No file checkpoint found for this
 *  message"). That is surfaced as `filesError` on the event so the UI can say
 *  "conversation rewound, files untouched" instead of implying a full restore. */
export async function sdkRewind(
  wsId: string,
  rewindId: string,
  prevRewindId?: string,
): Promise<AgentSessionRewindEvent> {
  const session = sessions.get(wsId);

  // 1. Files FIRST, while the session (and its checkpoints) are still alive.
  let files: RewindFilesResult | undefined;
  let filesError: string | undefined;
  if (session && !session.stopping) {
    try {
      files = await session.q.rewindFiles(rewindId);
      if (!files.canRewind) {
        filesError = files.error || 'No file checkpoint exists for this message.';
      }
    } catch (err) {
      // Thrown for an unknown/uncheckpointed message ("No file checkpoint found
      // for this message.") — expected for pre-feature sessions, so it is a
      // reported caveat, not a failure of the rewind.
      filesError = err instanceof Error ? err.message : String(err);
    }
  } else {
    filesError = 'The agent session was not running, so file changes were left as they are.';
  }
  if (filesError) {
    log.info(`agent-sdk: rewind ${wsId}: files not restored — ${filesError}`);
  }

  // 2. Tear the session down. `cleared` suppresses its tail events so the dying
  //    subprocess can't append rows to a transcript we are about to truncate.
  if (session) {
    session.cleared = true;
    await sdkStop(wsId);
  }

  // 3. Park the conversation cut for the next lazy start (see rewindResumeAt).
  //    No predecessor ⇒ the whole conversation goes: drop the resume id so the
  //    next send opens a brand-new session rather than resuming the full one.
  if (prevRewindId) {
    rewindResumeAt.set(wsId, prevRewindId);
  } else {
    rewindResumeAt.delete(wsId);
    await persistWorkspacePatch(wsId, { sdkSessionId: '' }).catch(() => {});
  }

  const event: AgentSessionRewindEvent = {
    type: 'session/rewind',
    seq: cursorFor(wsId).seq++,
    at: Date.now(),
    rewindId,
    ...(files?.filesChanged ? { filesChanged: files.filesChanged } : {}),
    ...(typeof files?.insertions === 'number' ? { insertions: files.insertions } : {}),
    ...(typeof files?.deletions === 'number' ? { deletions: files.deletions } : {}),
    ...(files?.skippedLinks ? { skippedLinks: files.skippedLinks } : {}),
    ...(filesError ? { filesError } : {}),
  };
  emit(wsId, event);
  // The turn the rewind killed leaves the dot stuck `running`; settle it the
  // same way the consume loop's exit floor does.
  reconcileExited(wsId);
  return event;
}

/** Preview a rewind WITHOUT changing anything — the SDK's `dryRun`, so the
 *  confirmation can state exactly which files would be restored (and whether
 *  any can be) before the user commits. Never throws: an un-checkpointed
 *  session reports `canRewind:false` with the reason. */
export async function sdkRewindPreview(
  wsId: string,
  rewindId: string,
): Promise<RewindFilesResult> {
  const session = sessions.get(wsId);
  if (!session || session.stopping) {
    return {
      canRewind: false,
      error: 'The agent session is not running, so file changes cannot be restored.',
    };
  }
  try {
    return await session.q.rewindFiles(rewindId, { dryRun: true });
  } catch (err) {
    return { canRewind: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Whether a workspace currently has a live SDK session. */
export function sdkHasSession(wsId: string): boolean {
  const s = sessions.get(wsId);
  return !!s && !s.stopping;
}

/** Tear down the SDK sessions for a set of workspaces (best-effort, fire &
 *  forget). Called from the workspace delete/archive paths so a removed
 *  workspace never leaks its `query()` subprocess. Exposed as a plain function
 *  rather than importing agent-sdk into workspaces.ts to keep the delete path
 *  from having to know about the SDK when no session was ever started. */
export function sdkStopMany(wsIds: readonly string[]): void {
  for (const wsId of wsIds) {
    if (sessions.has(wsId)) void sdkStop(wsId);
    // The workspace is being deleted/archived — no transcript can reference its
    // message ids any more, so its seq cursor can go. (Hibernation goes through
    // sdkStopIfLive, NOT here: a hibernated workspace comes back and MUST keep
    // its cursor, or the wake re-mints ids its transcript already holds.)
    seqCursors.delete(wsId);
  }
}

// Register the delivery seam so the lifecycle dispatchers in workspaces.ts /
// prompt-queue.ts can route a peer message, a usage-limit-parked prompt, or an
// account migration to a LIVE structured session — instead of blindly spawning a
// raw `claude` PTY (a stray second agent that never receives the message). The
// seam breaks the import cycle (workspaces.ts can't import agent-sdk.ts back).
// `send` maps to sdkSend (enqueues a live turn); the echo it emits also renders
// the delivered text in the structured transcript, exactly like a typed turn.
// `start` maps to sdkWake — the structured-FIRST spawn/wake entry: it lazy-starts
// a session (resuming prior context) when none is live, so `orchestra spawn` and
// wake-on-message run the agent in the structured view instead of a raw PTY.
registerSdkDelivery({
  hasSession: sdkHasSession,
  send: (wsId, text) => sdkSend(wsId, text),
  start: (wsId, text) => sdkWake(wsId, text),
  stop: sdkStop,
});
