import { randomUUID } from 'node:crypto';
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
import type { Query, SDKUserMessage, PermissionResult } from '@anthropic-ai/claude-agent-sdk';
import { platform } from './platform';
import { store } from './store';
import { log } from './logger';
import {
  installOrchestraHooks,
  workspaceAccountConfigDir,
  mangleProjectDir,
} from './workspaces';
import { transcriptToEvents } from '../shared/agent-transcript';
import { syncAccountInheritance } from './account-inherit';
import { agentCliBinDir } from './cli-shim';
import { getHookSocketPath } from './hooks-server';
import {
  normalizeSdkMessage,
  makePermissionRequest,
  makeUserMessage,
  type NormalizeContext,
  type SdkMessage,
} from '../shared/agent-events';
import type {
  AgentEvent,
  AgentPermissionMode,
  AgentPermissionReply,
  AgentSkillInfo,
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

/** The SDK's `query` factory signature (mirrors the module's export). Declared
 *  locally so nothing here depends on a runtime import of the ESM package. */
type QueryFactory = (params: {
  prompt: string | AsyncIterable<SDKUserMessage>;
  options?: Record<string, unknown>;
}) => Query;

/** Cached dynamic import of the pure-ESM SDK. `import()` is the only construct
 *  that can pull an ESM package from this CJS bundle; a static import would
 *  compile to `require()` and crash Electron at boot (ERR_REQUIRE_ESM). Cached
 *  so the subprocess-heavy module loads exactly once. */
let sdkModule: { query: QueryFactory } | null = null;
async function loadSdk(): Promise<{ query: QueryFactory }> {
  if (!sdkModule) {
    sdkModule = (await import('@anthropic-ai/claude-agent-sdk')) as unknown as {
      query: QueryFactory;
    };
  }
  return sdkModule;
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

  // CLI-identity parity with startAgentPty — carefully NOT the spool trigger.
  //
  // The hazard is that ORCHESTRA_WS_ID is DUAL-PURPOSE. The generated activity
  // hook writes the durable events spool for any process where it is set
  // (`[ -n "$ORCHESTRA_WS_ID" ] || exit 0`, and ORCHESTRA_EVENTS_DIR *defaults*
  // to ~/.orchestra/events when unset — so WS_ID alone is enough to write). The
  // `orchestra` CLI ALSO reads ORCHESTRA_WS_ID for its own identity
  // (cli/index.ts:167). So while a terminal PTY can coexist with this SDK
  // session for the same workspace (phases 1–5), setting WS_ID here would make
  // BOTH processes' hooks append to the same `<wsId>.jsonl` with independent
  // `seq` counters and corrupt the sidebar dot.
  //
  // Until the SDK session is the SOLE driver (Phase 6: structured is default and
  // the PTY isn't started for the workspace), we set only the spool-free
  // identity/round-trip plumbing — the worktree root and the hook socket, plus
  // the CLI shim on PATH. These let hooks resolve their scripts and reach the
  // socket without writing the spool. Full WS_ID parity (and letting the SDK
  // session's hooks drive the dot exactly like the PTY's did) lands with the
  // default-flip that guarantees the two drivers are mutually exclusive.
  const remote = ws.host?.kind === 'sandbox';
  if (!remote) {
    env.ORCHESTRA_WORKTREE = ws.worktreePath;
    const binDir = agentCliBinDir();
    env.PATH = env.PATH ? `${binDir}${path.delimiter}${env.PATH}` : binDir;
    const sock = getHookSocketPath();
    if (sock) env.ORCHESTRA_SOCK = sock;
  }
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

  // Resolve the query factory: a test override, else the dynamically-imported
  // real ESM SDK (never a static require — that crashes Electron at boot).
  const query = queryOverride ?? (await loadSdk()).query;
  session.q = query({
    prompt: promptStream(session),
    options: {
      cwd: remote ? '/workspace' : ws.worktreePath,
      includePartialMessages: true,
      settingSources: ['user', 'project'],
      permissionMode,
      canUseTool: makeCanUseTool(session) as never,
      env: buildSdkEnv(ws),
      // Start on the workspace's configured model (set by `orchestra spawn
      // --model` or the Model dropdown). Undefined falls back to the account's
      // default model. `sdkSetModel` switches it live.
      ...(ws.model ? { model: ws.model } : {}),
      // Resume the workspace's prior structured session so re-opening the view
      // continues the conversation with its memory intact, instead of starting
      // blank. The captured session id is persisted on `ws.sdkSessionId` as the
      // stream reports it (see consume()). Absent → a fresh session.
      ...(ws.sdkSessionId ? { resume: ws.sdkSessionId } : {}),
      // A large cap: real turns end on their own; this only backstops runaways.
      maxTurns: 200,
    },
  });

  sessions.set(wsId, session);
  // Fire-and-forget the consume loop; it self-cleans on end/throw.
  void consume(session);
  return session;
}

/** Max transcript bytes read for a history backfill — tail window; transcripts
 *  reach 10MB+ and the fold shouldn't balloon on them. */
const HISTORY_MAX_BYTES = 4 * 1024 * 1024;

/** Read a workspace's persisted on-disk session transcript and convert it into
 *  an AgentEvent stream for the structured view's history backfill. Returns []
 *  when there is nothing to backfill (no persisted id, file missing/empty).
 *  Fail-open: an unreadable transcript is a blank history, never an error. */
export async function sdkHistory(wsId: string): Promise<AgentEvent[]> {
  const ws = store.getWorkspace(wsId);
  if (!ws?.sdkSessionId || !ws.worktreePath) return [];
  // Same resolution as `claude --continue` (see workspaces.ts): the PINNED
  // account's config dir, falling back to ~/.claude.
  const base = workspaceAccountConfigDir(ws, undefined) || path.join(os.homedir(), '.claude');
  const file = path.join(
    base,
    'projects',
    mangleProjectDir(ws.worktreePath),
    `${ws.sdkSessionId}.jsonl`,
  );
  let text: string;
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
      } finally {
        await fh.close();
      }
    } else {
      text = await fs.promises.readFile(file, 'utf8');
    }
  } catch {
    return [];
  }
  // Fresh cursor: history seq-space is independent of the live session's (seq
  // only feeds gap detection; message identity includes seq + index, and
  // history block indexes start far above live ones so they never collide).
  return transcriptToEvents(text, { seq: 0 });
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
export async function sdkSend(wsId: string, text: string): Promise<void> {
  let session: Session;
  try {
    session = await ensureSession(wsId);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    log.warn(`agent-sdk: could not start session for ${wsId}: ${message}`);
    emit(wsId, {
      type: 'error',
      seq: 0,
      at: Date.now(),
      message: `Couldn't start the agent: ${message}`,
      apiErrorStatus: null,
      willRetry: false,
    });
    // If we were trying to RESUME, a stale/incompatible resume id can wedge every
    // future send — clear it so the next attempt starts a fresh session instead of
    // repeating the same failure. Only when a resume was in play (a
    // missing-worktree failure isn't the resume id's fault; leave it).
    const wsNow = store.getWorkspace(wsId);
    if (wsNow?.sdkSessionId && !/directory not found/i.test(message)) {
      await persistWorkspacePatch(wsId, { sdkSessionId: undefined }).catch(() => {});
    }
    throw err;
  }
  const msg: SDKUserMessage = {
    type: 'user',
    parent_tool_use_id: null,
    message: { role: 'user', content: text },
  };
  session.queue.push(msg);
  // Echo the prompt to every attached UI — the SDK stream never repeats plain
  // user text, so this event is the transcript's only record of it.
  emit(session.wsId, makeUserMessage(session.ctx, text));
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

/** Persist a partial workspace change and broadcast it so the renderer's store
 *  (and the GTK client) update. Used to make the Model/Permissions dropdowns
 *  and the resume session-id stick even when no live session exists. */
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
  try {
    await session.q.setModel(model);
  } catch (err) {
    log.warn(`agent-sdk: setModel failed for ${wsId}`, err);
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
