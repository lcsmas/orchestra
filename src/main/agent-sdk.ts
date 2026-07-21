import os from 'node:os';
import { randomUUID } from 'node:crypto';
import { query, type Query, type SDKUserMessage, type PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { platform } from './platform';
import { store } from './store';
import { log } from './logger';
import {
  installOrchestraHooks,
  workspaceAccountConfigDir,
} from './workspaces';
import { syncAccountInheritance } from './account-inherit';
import {
  normalizeSdkMessage,
  makePermissionRequest,
  type NormalizeContext,
  type SdkMessage,
} from '../shared/agent-events';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentPermissionReply,
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
// `agent:event` channel so both the Electron renderer and any GTK ui-rpc client
// can fold it into a live view.
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

/** Test seam: override the SDK `query` factory (so e2e/tests can inject a fake
 *  that yields canned SDK messages without spawning a real `claude`). */
type QueryFactory = typeof query;
let queryFactory: QueryFactory = query;
export function __setQueryFactoryForTests(factory: QueryFactory | null): void {
  queryFactory = factory ?? query;
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
}

const sessions = new Map<string, Session>();

/** Broadcast one normalized event to every attached UI (Electron + ui-rpc). */
function emit(wsId: string, event: AgentEvent): void {
  platform.broadcast('agent:event', wsId, event);
}

/** Normalize an SDK message and broadcast every event it produces. */
function emitFrom(session: Session, msg: SdkMessage): void {
  for (const ev of normalizeSdkMessage(msg, session.ctx)) {
    emit(session.wsId, ev);
  }
}

/** Build the SDK env for a workspace, matching startAgentPty's plumbing: the
 *  pinned account's CLAUDE_CONFIG_DIR (so the agent logs in as that account),
 *  with CLAUDE_CONFIG_DIR otherwise UNSET so a leftover value from Orchestra's
 *  own environment can't silently retarget the session (self-tune.ts:201-206). */
function buildSdkEnv(ws: Workspace): Record<string, string> {
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(process.env)) {
    if (typeof v === 'string') env[k] = v;
  }
  delete env.CLAUDE_CONFIG_DIR;
  const configDir = workspaceAccountConfigDir(ws, undefined);
  if (configDir) env.CLAUDE_CONFIG_DIR = configDir;
  env.ORCHESTRA_BRANCH = ws.branch;
  env.ORCHESTRA_KIND = ws.kind ?? 'worktree';
  return env;
}

/** The canUseTool bridge: park the call, emit a permission-request event, and
 *  wait for the renderer's reply (or the turn/session ending). */
function makeCanUseTool(session: Session) {
  return (
    toolName: string,
    input: Record<string, unknown>,
    opts: { toolUseID: string; requestId: string; title?: string; signal: AbortSignal },
  ): Promise<PermissionResult> => {
    const requestId = opts.requestId || randomUUID();
    emit(
      session.wsId,
      makePermissionRequest(session.ctx, requestId, toolName, input, {
        toolUseId: opts.toolUseID ?? null,
        title: opts.title,
      }),
    );
    return new Promise<PermissionResult>((resolve) => {
      session.pending.set(requestId, resolve);
      // If the turn is aborted (interrupt) the parked promise must not dangle:
      // deny on abort so the SDK unwinds.
      const onAbort = () => {
        if (session.pending.delete(requestId)) {
          resolve({ behavior: 'deny', message: 'interrupted' });
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
  try {
    for await (const raw of session.q) {
      const msg = raw as unknown as SdkMessage;
      emitFrom(session, msg);
      if (msg.type === 'result') {
        // Turn boundary — resolve any parked permission (belt & suspenders) and
        // open the gate so the next queued turn can proceed.
        for (const [id, resolve] of session.pending) {
          resolve({ behavior: 'deny', message: 'turn ended' });
          session.pending.delete(id);
        }
        const openNext = session.turnGate;
        session.turnGate = null;
        openNext?.();
      }
    }
  } catch (err) {
    // interrupt() surfaces here as a throw (spike d) — expected terminal state,
    // not a crash. Emit a normal error event; the session is done.
    const message = err instanceof Error ? err.message : String(err);
    const interrupted = /error_during_execution|ede_diagnostic|abort/i.test(message);
    emit(session.wsId, {
      type: 'error',
      seq: session.ctx.seq++,
      at: (session.ctx.now ?? Date.now)(),
      message: interrupted ? 'Turn interrupted.' : message,
      apiErrorStatus: null,
      willRetry: false,
    });
    if (!interrupted) {
      log.warn(`agent-sdk: session ${session.wsId} consume loop errored`, err);
    }
  } finally {
    // Release any waiter and drop the session; the renderer can restart it.
    session.stopping = true;
    session.pump?.();
    session.turnGate?.();
    sessions.delete(session.wsId);
  }
}

/** Start (lazily) the SDK session for a workspace and return it. Idempotent —
 *  returns the existing session if one is live. */
async function ensureSession(wsId: string): Promise<Session> {
  const existing = sessions.get(wsId);
  if (existing && !existing.stopping) return existing;

  const ws = store.getWorkspace(wsId);
  if (!ws) throw new Error(`unknown workspace: ${wsId}`);

  // Env parity with the terminal spawn (installOrchestraHooks + account
  // inheritance + CLAUDE_CONFIG_DIR), skipped for remote/sandbox workspaces
  // whose worktree lives in the container.
  const remote = ws.host?.kind === 'sandbox';
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

  const permissionMode: AgentPermissionMode = 'default';
  const session: Session = {
    wsId,
    // q is assigned right after — the generator/canUseTool close over `session`,
    // not over `q`, so the forward reference is safe.
    q: undefined as unknown as Query,
    ctx: { seq: 0 },
    queue: [],
    pump: null,
    turnGate: null,
    pending: new Map(),
    stopping: false,
    permissionMode,
  };

  session.q = queryFactory({
    prompt: promptStream(session),
    options: {
      cwd: remote ? '/workspace' : ws.worktreePath,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      permissionMode,
      canUseTool: makeCanUseTool(session) as never,
      env: buildSdkEnv(ws),
      // A large cap: real turns end on their own; this only backstops runaways.
      maxTurns: 200,
    },
  });

  sessions.set(wsId, session);
  // Fire-and-forget the consume loop; it self-cleans on end/throw.
  void consume(session);
  return session;
}

/** Enqueue a user turn (text) to a workspace's session, starting it lazily. */
export async function sdkSend(wsId: string, text: string): Promise<void> {
  const session = await ensureSession(wsId);
  const msg: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
  session.queue.push(msg);
  session.pump?.();
}

/** Interrupt the in-flight turn (spike d: the consume loop will throw and the
 *  session ends). No-op if there is no live session. */
export async function sdkInterrupt(wsId: string): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) return;
  try {
    await session.q.interrupt();
  } catch (err) {
    log.warn(`agent-sdk: interrupt failed for ${wsId}`, err);
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

/** Switch the live session's model (spike/plan setModel). No-op if no session. */
export async function sdkSetModel(wsId: string, model: string | undefined): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) return;
  try {
    await session.q.setModel(model);
  } catch (err) {
    log.warn(`agent-sdk: setModel failed for ${wsId}`, err);
  }
}

/** Switch the live session's permission mode. No-op if no session. */
export async function sdkSetPermissionMode(
  wsId: string,
  mode: AgentPermissionMode,
): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) return;
  session.permissionMode = mode;
  try {
    await session.q.setPermissionMode(mode as never);
  } catch (err) {
    log.warn(`agent-sdk: setPermissionMode failed for ${wsId}`, err);
  }
}

/** Tear down a workspace's session (stop/interrupt + drop). Called on explicit
 *  stop and on workspace removal so a deleted workspace never leaks a query. */
export async function sdkStop(wsId: string): Promise<void> {
  const session = sessions.get(wsId);
  if (!session) return;
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
  }
}
