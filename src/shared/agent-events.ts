/**
 * Pure normalization + folding for the structured agent view.
 *
 * The main process drives a Claude Agent SDK `query()` and gets a stream of
 * SDK messages (`system`/`init`, `assistant`, `user`, `stream_event`, `result`).
 * Those shapes are the SDK's internal, volatile contract. This module maps them
 * ONCE, in one place, into Orchestra's own {@link AgentEvent} union (the wire
 * contract the renderer consumes) and then folds that flat
 * event stream into a coherent {@link AgentSession} for rendering.
 *
 * WHY it lives in `src/shared/` and imports NOTHING from electron/node beyond
 * types: it is pure data-in/data-out, so `node --test` can exercise it directly
 * (the test runner crashes the instant a module transitively imports `electron`).
 * Every SDK-shape assumption below is grounded in the Phase 0 spike's real event
 * JSON (docs/spikes/phase0-sdk-findings.md) — see the inline `spike (x)` refs.
 *
 * Two entry points:
 *   • {@link normalizeSdkMessage}(sdkMsg, ctx) → AgentEvent[]  — main-process side.
 *     `ctx` is a tiny mutable cursor the caller threads across messages so events
 *     get a monotonic `seq` and a timestamp; the caller owns it (one per session).
 *   • {@link foldEvent}(session, event) → AgentSession  — renderer side. Immutable
 *     fold: returns a new session with the event applied. Replaying every event
 *     through it from {@link emptySession} reconstructs the whole view — no hidden
 *     state, which is what makes the renderer store a pure projection.
 */

import type {
  AgentEvent,
  AgentImage,
  AgentMcpServer,
  AgentNoticeKind,
  AgentPermissionMode,
  AgentPermissionRequestEvent,
  AgentSession,
  AgentStopReason,
  AgentLocalCommandEvent,
  AgentTaskEvent,
  AgentTaskUsage,
  AgentUserMessageEvent,
  BackgroundTask,
  RenderMessage,
  TokenUsage,
} from './types';

// ─── SDK message shapes (only the fields we read) ────────────────────────────
//
// Deliberately loose/partial: the SDK ships its own full types, but this module
// must stay electron/node-free AND resilient to the SDK adding fields. We read
// only what the spike proved is present and treat everything as optional so a
// missing field degrades to a skipped event, never a throw.

/** The `now` + `seq` cursor the caller threads across a session's messages. The
 *  caller mutates `seq` (we return the next value on each event) and supplies a
 *  clock so this module never calls `Date.now()` (keeps it deterministic and
 *  test-friendly). */
export interface NormalizeContext {
  /** Next sequence number to assign. Advanced by {@link normalizeSdkMessage}. */
  seq: number;
  /** Epoch-ms clock. Defaults to `Date.now` when omitted, but tests inject a
   *  fixed stamp. */
  now?: () => number;
  /** Correlates a `canUseTool` requestId with the eventual tool_use. The caller
   *  (agent-sdk.ts) owns the request→resolver map; this is only used so a
   *  permission event can be emitted from within normalize when the caller
   *  routes canUseTool through here. Optional — permission events are usually
   *  emitted directly by the manager, not via normalize. */
  nextRequestId?: () => string;
  /** Usage of the LAST top-level (non-sidechain) assistant API call seen on this
   *  stream. Mutated by normalize on every `assistant` message and read at
   *  `result` time to compute `contextUsedTokens` — the `result` message's own
   *  `usage` is a SESSION-CUMULATIVE accumulator (the CLI merges every API
   *  call's usage on message_stop), so summing it reads hundreds of millions of
   *  tokens on a long session and pinned the context gauge at 100%. Only the
   *  final call's `input + cache + output` measures what's actually in the
   *  window. */
  lastApiCallUsage?: RawUsage | null;
}

interface RawDelta {
  type?: string;
  text?: string;
  thinking?: string;
  partial_json?: string;
  stop_reason?: string;
}

interface RawStreamEvent {
  type?: string; // content_block_start | content_block_delta | content_block_stop | message_delta | ...
  index?: number;
  delta?: RawDelta;
  content_block?: { type?: string; id?: string; name?: string };
}

interface RawContentBlock {
  type?: string; // text | thinking | tool_use | tool_result
  id?: string;
  name?: string;
  input?: unknown;
  tool_use_id?: string;
  content?: unknown;
  is_error?: boolean;
}

interface RawUsage {
  input_tokens?: number;
  output_tokens?: number;
  cache_creation_input_tokens?: number;
  cache_read_input_tokens?: number;
  service_tier?: string | null;
}

/** The subset of any SDK message we ever read. */
export interface SdkMessage {
  type?: string; // system | assistant | user | stream_event | result | auth_status | rate_limit_event
  subtype?: string; // init | success | error_during_execution | ...
  session_id?: string;
  // system/init:
  model?: string;
  cwd?: string;
  permissionMode?: string;
  tools?: string[];
  slash_commands?: string[];
  mcp_servers?: { name?: string; status?: string }[];
  /** system/init: absolute paths of the CLAUDE.md memory files in effect. The
   *  CLI sends PATHS ONLY — no sizes, no over-limit flag — so the oversized-
   *  memory banner has to be recomputed from these (see memory-size.ts). */
  memory_paths?: string[];
  // stream_event:
  event?: RawStreamEvent;
  // assistant / user (an object); system/permission_denied reuses the key as a
  // plain STRING (the rejection text) — every reader must typeof-guard.
  // Assistant messages are full API BetaMessages, so they carry the PER-CALL
  // `usage` (unlike `result`'s session-cumulative one — see lastApiCallUsage).
  message?: { role?: string; content?: RawContentBlock[] | string; usage?: RawUsage } | string;
  // user (externally-originated turn provenance / synthetic filtering):
  isSynthetic?: boolean;
  parent_tool_use_id?: string | null;
  origin?: { kind?: string; from?: string; name?: string; body?: string };
  tool_use_result?: unknown;
  // system/status:
  compact_result?: string; // 'success' | 'failed'
  compact_error?: string;
  // system/api_retry:
  attempt?: number;
  max_retries?: number;
  retry_delay_ms?: number;
  error_status?: number | null;
  // system/compact_boundary:
  compact_metadata?: { trigger?: string; pre_tokens?: number; post_tokens?: number };
  // system/local_command_output + informational + refusal messages:
  content?: string;
  level?: string; // informational: 'info' | 'notice' | 'suggestion' | 'warning'
  // system/notification:
  text?: string;
  priority?: string;
  // system/permission_denied:
  tool_name?: string;
  decision_reason?: string;
  // system/thinking_tokens:
  estimated_tokens?: number;
  // auth_status:
  error?: string;
  isAuthenticating?: boolean;
  // rate_limit_event:
  rate_limit_info?: {
    status?: string; // 'allowed' | 'allowed_warning' | 'rejected'
    resetsAt?: number;
    rateLimitType?: string;
    utilization?: number;
  };
  // result:
  is_error?: boolean;
  api_error_status?: number | null;
  num_turns?: number;
  total_cost_usd?: number;
  /** result: per-model usage — `contextWindow` backs the context-left gauge. */
  modelUsage?: Record<string, { contextWindow?: number }>;
  /** `result` messages carry a Messages-API usage; `task_*` messages carry a
   *  distinct `{ total_tokens, tool_uses, duration_ms }` counter. Widened to
   *  both — normalize reads the right subset by message subtype. */
  usage?: RawUsage & { total_tokens?: number; tool_uses?: number; duration_ms?: number };
  result?: string;
  stop_reason?: string;
  duration_ms?: number;
  // system/task_* + background_tasks_changed (see sdk.d.ts):
  task_id?: string;
  tool_use_id?: string;
  description?: string;
  task_type?: string;
  subagent_type?: string;
  last_tool_name?: string;
  summary?: string;
  output_file?: string;
  status?: string; // 'completed' | 'failed' | 'stopped' (task_notification)
  /** task_updated patch (wire-safe subset that changed). */
  patch?: { status?: string; description?: string; end_time?: number };
  /** background_tasks_changed: the full live set (replace-semantics). */
  tasks?: { task_id: string; task_type?: string; description?: string }[];
}

// ─── normalize: SDK message → AgentEvent[] ───────────────────────────────────

function clockNow(ctx: NormalizeContext): number {
  return (ctx.now ?? Date.now)();
}

/** All AgentEvent bodies without the `seq`/`at` envelope — the shapes callers
 *  pass to {@link stamp}. Distributes over the union so each variant keeps its
 *  own fields (a plain `Omit<AgentEvent,…>` would collapse to the shared keys). */
export type AgentEventBody = { [E in AgentEvent as E['type']]: Omit<E, 'seq' | 'at'> }[AgentEvent['type']];

/** Assign the next seq/at envelope to a bare event body. Mutates `ctx.seq`. The
 *  generic keeps the specific variant type through the call, so a caller passing
 *  a `text-delta` body gets an `AgentTextDeltaEvent` back. */
export function stamp<B extends AgentEventBody>(ctx: NormalizeContext, body: B): B & { seq: number; at: number } {
  const at = clockNow(ctx);
  const seq = ctx.seq++;
  return { ...body, seq, at };
}

function toPermissionMode(m: string | undefined): AgentSession['permissionMode'] {
  switch (m) {
    case 'acceptEdits':
    case 'bypassPermissions':
    case 'plan':
      return m;
    default:
      return 'default';
  }
}

/** Map an SDK `result` subtype + stop_reason to our normalized reason. */
function toStopReason(msg: SdkMessage): AgentStopReason {
  // An interrupted turn arrives as subtype `error_during_execution` (spike d).
  if (msg.subtype === 'error_during_execution') return 'interrupted';
  if (msg.stop_reason === 'max_turns' || msg.subtype === 'error_max_turns') return 'max_turns';
  if (msg.is_error) return 'error';
  return 'end_turn';
}

function toUsage(u: RawUsage | undefined): TokenUsage | null {
  if (!u) return null;
  return {
    inputTokens: u.input_tokens ?? 0,
    outputTokens: u.output_tokens ?? 0,
    cacheCreationInputTokens: u.cache_creation_input_tokens ?? 0,
    cacheReadInputTokens: u.cache_read_input_tokens ?? 0,
    serviceTier: u.service_tier ?? null,
  };
}

/** Lift the SDK task-usage counter (`{ total_tokens, tool_uses, duration_ms }`,
 *  distinct from the Messages-API `usage`) into our {@link AgentTaskUsage}.
 *  Returns undefined when absent so `foldEvent` keeps the prior counters. */
function toTaskUsage(u: SdkMessage['usage']): AgentTaskUsage | undefined {
  if (!u || (u.total_tokens == null && u.tool_uses == null && u.duration_ms == null)) {
    return undefined;
  }
  return {
    totalTokens: u.total_tokens ?? 0,
    toolUses: u.tool_uses ?? 0,
    ...(u.duration_ms != null ? { durationMs: u.duration_ms } : {}),
  };
}

/** Normalize the background-task system messages — `task_started`,
 *  `task_progress`, `task_updated`, `task_notification`, and the
 *  `background_tasks_changed` level signal — into {@link AgentTaskEvent}s.
 *  Non-task subtypes return `[]`. These drive the "Background tasks" panel;
 *  see sdk.d.ts for the exact wire shapes. */
function normalizeTaskSystem(ctx: NormalizeContext, msg: SdkMessage): AgentEvent[] {
  switch (msg.subtype) {
    case 'task_started':
      return [
        stamp(ctx, {
          type: 'task',
          kind: 'started',
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          taskType: msg.task_type,
          subagentType: msg.subagent_type,
          description: msg.description ?? '',
        }),
      ];
    case 'task_progress':
      return [
        stamp(ctx, {
          type: 'task',
          kind: 'progress',
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          subagentType: msg.subagent_type,
          description: msg.description,
          usage: toTaskUsage(msg.usage),
          lastToolName: msg.last_tool_name,
          summary: msg.summary,
        }),
      ];
    case 'task_updated':
      return [
        stamp(ctx, {
          type: 'task',
          kind: 'updated',
          taskId: msg.task_id,
          description: msg.patch?.description,
          // A running/completed/failed/killed/paused patch status; the fold maps
          // it onto our narrower AgentTaskStatus. Only terminal states here set
          // an end.
          status: toTerminalTaskStatus(msg.patch?.status),
        }),
      ];
    case 'task_notification':
      return [
        stamp(ctx, {
          type: 'task',
          kind: 'notification',
          taskId: msg.task_id,
          toolUseId: msg.tool_use_id,
          status: toTerminalTaskStatus(msg.status),
          usage: toTaskUsage(msg.usage),
          summary: msg.summary,
          outputFile: msg.output_file,
        }),
      ];
    case 'background_tasks_changed':
      return [
        stamp(ctx, {
          type: 'task',
          kind: 'changed',
          liveIds: Array.isArray(msg.tasks) ? msg.tasks.map((t) => t.task_id) : [],
        }),
      ];
    default:
      return [];
  }
}

/** Map an SDK task status string onto our terminal {@link AgentTaskStatus}
 *  subset, or undefined for a non-terminal ('running'/'pending'/'paused') or
 *  missing value. `killed` maps to `stopped`. */
function toTerminalTaskStatus(s: string | undefined): 'completed' | 'failed' | 'stopped' | undefined {
  switch (s) {
    case 'completed':
      return 'completed';
    case 'failed':
      return 'failed';
    case 'stopped':
    case 'killed':
      return 'stopped';
    default:
      return undefined;
  }
}

/** Normalize one raw `stream_event` (the token-streaming envelope). Returns 0..n
 *  events — a `content_block_start` for a thinking block yields BOTH a
 *  block-start and a thinking-start. */
function normalizeStreamEvent(ctx: NormalizeContext, ev: RawStreamEvent): AgentEvent[] {
  const out: AgentEvent[] = [];
  const index = ev.index ?? 0;

  if (ev.type === 'content_block_start') {
    const blockType = ev.content_block?.type;
    if (blockType === 'text' || blockType === 'thinking' || blockType === 'tool_use') {
      // A tool_use block-start carries the tool's id + name up front (the
      // Messages-API streaming shape). Lifting them lets the fold create the
      // tool message with its FINAL id and real name immediately — so the
      // later finalizing tool-use event updates in place (stable React key,
      // no remount flicker) and the collapsed run label reads "Bash…" while
      // the input is still streaming, not a generic "used a tool".
      const cb = ev.content_block;
      out.push(
        stamp(ctx, {
          type: 'block-start',
          index,
          kind: blockType,
          ...(blockType === 'tool_use' && typeof cb?.id === 'string' ? { toolUseId: cb.id } : {}),
          ...(blockType === 'tool_use' && typeof cb?.name === 'string' ? { name: cb.name } : {}),
        }),
      );
      if (blockType === 'thinking') {
        out.push(stamp(ctx, { type: 'thinking-start', index }));
      }
    }
    return out;
  }

  if (ev.type === 'content_block_stop') {
    out.push(stamp(ctx, { type: 'block-stop', index }));
    return out;
  }

  if (ev.type === 'content_block_delta' && ev.delta) {
    const d = ev.delta;
    if (d.type === 'text_delta' && typeof d.text === 'string') {
      out.push(stamp(ctx, { type: 'text-delta', index, text: d.text }));
    } else if (d.type === 'input_json_delta' && typeof d.partial_json === 'string') {
      out.push(stamp(ctx, { type: 'tool-input-delta', index, partialJson: d.partial_json }));
    }
    // thinking_delta text was empty on Opus 4.8 under the OLD thinking config
    // (`{type:'enabled',budgetTokens}`) — spike b, reproduced 4x with text_delta
    // flowing alongside as a positive control (docs/spikes/phase0-sdk-findings.md).
    //
    // SCOPE, re-checked 2026-08-05 against the current streaming docs: that is
    // the documented behaviour of `thinking.display: "omitted"` ("no
    // thinking_delta events are sent; the block opens, receives a single
    // signature_delta, and closes") — NOT a platform invariant. The config is
    // now `{type:'adaptive', display:'summarized'|'omitted'}`, and the docs show
    // thinking_delta carrying real cleartext under "summarized".
    //
    // So the spike's observation stands for the config it tested; its
    // generalization ("a live thinking-stream panel is not achievable") is
    // UNVERIFIED on today's models/config. Emitting no text event is still the
    // correct DEFAULT — an empty string must never render as a thinking bubble —
    // but if a readable thinking stream is wanted, the thing to test is passing
    // `display:'summarized'` and confirming non-empty deltas BEFORE building UI
    // on it. Until then the thinking-start indicator (above) is the whole UI.
    return out;
  }

  // message_start / message_delta / message_stop carry no per-block content we
  // render incrementally; the terminal `result` message is the turn boundary.
  return out;
}

/** Build one {@link AgentMcpServer} from an init `mcp_servers` entry, deriving
 *  `toolCount` from the init `tools` list (`mcp__<name>__<tool>` prefix count) —
 *  the init message itself carries no per-server tool info. */
export function mcpServerFromInit(
  s: { name?: string; status?: string } | undefined,
  tools: string[],
): AgentMcpServer {
  const name = s?.name ?? '';
  const prefix = `mcp__${name}__`;
  const toolCount = name ? tools.filter((t) => t.startsWith(prefix)).length : 0;
  return {
    name,
    status: s?.status ?? '',
    ...(toolCount > 0 ? { toolCount } : {}),
  };
}

/** One-line transcript-notice text for an MCP server's connection outcome —
 *  "context7 connected · 12 tools", "linear failed to connect". Returns null
 *  for statuses that don't warrant a notice (`disabled` — the user turned it
 *  off; re-announcing it every session start is noise). Shared by the init
 *  normalize path and the main-process toggle/reconnect ops so live and
 *  reopened transcripts read the same. */
export function describeMcpServer(s: AgentMcpServer): string | null {
  const tools = s.toolCount !== undefined ? ` · ${s.toolCount} tool${s.toolCount === 1 ? '' : 's'}` : '';
  switch (s.status) {
    case 'connected':
      return `${s.name} connected${tools}`;
    case 'failed':
      return `${s.name} failed to connect${s.error ? ` — ${s.error}` : ''}`;
    case 'needs-auth':
      return `${s.name} needs authentication`;
    case 'pending':
      return `${s.name} connecting…`;
    case 'disabled':
      return null;
    default:
      // Unknown status: surface it rather than hide a server the SDK reported.
      return s.status ? `${s.name} — ${s.status}` : null;
  }
}

/** First http(s) URL found anywhere in a value — deep-walks objects/arrays and
 *  scans strings. Used to pull the OAuth authorization link out of the SDK's
 *  `mcpAuthenticate` response, whose shape is an INTERNAL contract (untyped in
 *  the public d.ts, like `enableRemoteControl`): rather than betting on a field
 *  name (`authUrl`? `authorizationUrl`?), find the URL wherever it lives so a
 *  rename can't silently break the auth flow. Depth-capped against cycles. */
export function firstHttpUrl(value: unknown, depth = 0): string | null {
  if (depth > 6 || value == null) return null;
  if (typeof value === 'string') {
    const m = value.match(/https?:\/\/[^\s"'<>)\]}]+/);
    return m ? m[0] : null;
  }
  if (Array.isArray(value)) {
    for (const v of value) {
      const url = firstHttpUrl(v, depth + 1);
      if (url) return url;
    }
    return null;
  }
  if (typeof value === 'object') {
    for (const v of Object.values(value as Record<string, unknown>)) {
      const url = firstHttpUrl(v, depth + 1);
      if (url) return url;
    }
  }
  return null;
}

/** Normalize one SDK message into zero or more {@link AgentEvent}s. Pure except
 *  for advancing `ctx.seq`. Unknown/irrelevant messages return `[]`. */
export function normalizeSdkMessage(msg: SdkMessage, ctx: NormalizeContext): AgentEvent[] {
  if (!msg || typeof msg !== 'object') return [];

  switch (msg.type) {
    case 'system':
      if (msg.subtype === 'init') {
        const tools = Array.isArray(msg.tools) ? msg.tools : [];
        // MCP server state is CAPTURED (for the /mcp popover) but deliberately
        // emits NO transcript notices here: the CLI re-emits `system/init` at
        // the start of EVERY request, so per-init notices re-announced the
        // whole server list on every turn — pure noise (user-rejected). The
        // only MCP notices in the transcript are the outcomes of EXPLICIT user
        // actions (toggle / reconnect / authenticate, emitted by the sdkMcp*
        // ops in agent-sdk.ts).
        const mcpServers = Array.isArray(msg.mcp_servers)
          ? msg.mcp_servers.map((s) => mcpServerFromInit(s, tools))
          : undefined;
        return [
          stamp(ctx, {
            type: 'session/init',
            sessionId: msg.session_id ?? '',
            model: msg.model ?? '',
            cwd: msg.cwd ?? '',
            permissionMode: toPermissionMode(msg.permissionMode),
            tools,
            ...(Array.isArray(msg.slash_commands)
              ? { slashCommands: msg.slash_commands.filter((c): c is string => typeof c === 'string') }
              : {}),
            ...(mcpServers !== undefined ? { mcpServers } : {}),
            ...(Array.isArray(msg.memory_paths)
              ? { memoryPaths: msg.memory_paths.filter((p): p is string => typeof p === 'string') }
              : {}),
          }),
        ];
      }
      return normalizeSystemNotice(ctx, msg) ?? normalizeTaskSystem(ctx, msg);

    case 'stream_event':
      return msg.event ? normalizeStreamEvent(ctx, msg.event) : [];

    case 'assistant': {
      // Track the newest top-level API call's usage for the context gauge —
      // sidechain (subagent) calls are excluded: their context is not this
      // session's window.
      if (msg.parent_tool_use_id == null && typeof msg.message === 'object' && msg.message?.usage) {
        ctx.lastApiCallUsage = msg.message.usage;
      }
      // Finalized assistant blocks. The token-level text already streamed via
      // stream_event; here we only lift `tool_use` blocks, which carry the FULL
      // parsed input the diff is reconstructed from (spike g).
      const content = typeof msg.message === 'object' ? msg.message?.content : undefined;
      if (!Array.isArray(content)) return [];
      const out: AgentEvent[] = [];
      for (const b of content) {
        if (b.type === 'tool_use' && typeof b.id === 'string') {
          out.push(
            stamp(ctx, {
              type: 'tool-use',
              toolUseId: b.id,
              name: b.name ?? '',
              input: (b.input && typeof b.input === 'object' ? b.input : {}) as Record<
                string,
                unknown
              >,
            }),
          );
        }
      }
      return out;
    }

    case 'user': {
      const out: AgentEvent[] = [];
      const raw = typeof msg.message === 'object' ? msg.message : undefined;
      const content = raw?.content;
      if (Array.isArray(content)) {
        // Tool results come back as `tool_result` blocks on a synthetic user msg.
        for (const b of content) {
          if (b.type === 'tool_result' && typeof b.tool_use_id === 'string') {
            out.push(
              stamp(ctx, {
                type: 'tool-result',
                toolUseId: b.tool_use_id,
                content: normalizeResultContent(b.content),
                isError: b.is_error === true,
              }),
            );
          }
        }
      }
      // EXTERNALLY-ORIGINATED USER TEXT (Remote Control turns typed on
      // claude.ai/mobile, channel/peer deliveries the CLI injected itself).
      // Locally-typed prompts are echoed by sdkSend and — per the Phase 0
      // spike — are NEVER replayed by the stream, so a text-bearing `user`
      // message here is one the local composer never saw. Without this branch
      // it was dropped and a phone-driven session showed assistant replies
      // answering nothing. Filters: synthetic/meta frames, subagent
      // sidechains (parent_tool_use_id), and pure tool_result messages.
      // The manager additionally drops any text matching a just-sent local
      // echo (belt-and-braces against future SDK replay behavior).
      if (msg.isSynthetic !== true && msg.parent_tool_use_id == null) {
        const text = userTextFrom(content);
        if (text) {
          const origin = originLabel(msg.origin) ? { origin: originLabel(msg.origin) } : {};
          // Route Claude Code's non-conversational user frames to their proper
          // surfaces instead of raw-XML bubbles (see classifyUserText): a
          // slash-command ack becomes a quiet command-output notice, the
          // interrupt marker an `interrupted` notice, a replayed command
          // invocation the `/cmd args` the user typed (which the manager's
          // recentEchoes guard then dedupes against the local echo). Bonus fix:
          // as notices these no longer flip the fold's `running`/`turnStartedAt`
          // or the sidebar dot the way a phantom user-message did.
          const c = classifyUserText(text);
          if (c.kind === 'interrupted') {
            out.push(stamp(ctx, { type: 'notice', kind: 'interrupted', text: 'Interrupted by user' }));
            if (c.rest) out.push(stamp(ctx, { type: 'user-message', text: c.rest, ...origin }));
          } else if (c.kind === 'command-output') {
            if (c.text) out.push(stamp(ctx, { type: 'notice', kind: 'command-output', text: c.text }));
          } else if (c.text) {
            out.push(stamp(ctx, { type: 'user-message', text: c.text, ...origin }));
          }
        }
      }
      return out;
    }

    case 'result': {
      const out: AgentEvent[] = [];
      // A transient API error result (typically a 500) arrives here, NOT thrown
      // (spike, note 6). Surface it as an error event alongside the turn-end so
      // the UI shows the failure and the manager can decide to retry.
      if (msg.is_error) {
        out.push(
          stamp(ctx, {
            type: 'error',
            message: msg.result || `agent turn errored (${msg.subtype ?? 'unknown'})`,
            apiErrorStatus: msg.api_error_status ?? null,
            // The manager owns the retry decision; normalize records it as not
            // retrying and the manager overrides if it schedules one.
            willRetry: false,
          }),
        );
      }
      out.push(
        stamp(ctx, {
          type: 'turn-end',
          isError: msg.is_error === true,
          stopReason: toStopReason(msg),
          numTurns: msg.num_turns ?? 0,
          costUsd: typeof msg.total_cost_usd === 'number' ? msg.total_cost_usd : null,
          usage: toUsage(msg.usage),
          resultText: typeof msg.result === 'string' ? msg.result : null,
          sessionId: msg.session_id ?? '',
          durationMs: typeof msg.duration_ms === 'number' ? msg.duration_ms : null,
          contextWindow: contextWindowFrom(msg.modelUsage),
          // NOT msg.usage: the result's usage is session-cumulative (every API
          // call summed), which pinned the gauge at 100% after a few calls.
          // The last per-call usage is the real context in use; fall back to
          // the cumulative figure only when no assistant call was ever seen
          // (first-result edge, where the two coincide).
          contextUsedTokens: contextUsedFrom(ctx.lastApiCallUsage ?? msg.usage),
        }),
      );
      return out;
    }

    // ── Previously-dropped top-level message types (silent-failure audit) ──
    case 'auth_status':
      // Auth died mid-session (token expired/revoked). Without this the turn
      // just stalls with no hint that a re-login is needed.
      if (typeof msg.error === 'string' && msg.error) {
        return [stamp(ctx, { type: 'notice', kind: 'auth', text: `Authentication problem: ${msg.error}` })];
      }
      return [];

    case 'rate_limit_event': {
      const info = msg.rate_limit_info;
      if (!info) return [];
      if (info.status === 'rejected') {
        return [
          stamp(ctx, {
            type: 'notice',
            kind: 'rate-limit',
            text: 'Usage limit reached',
            ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
          }),
        ];
      }
      if (info.status === 'allowed_warning') {
        const pct = typeof info.utilization === 'number' ? ` (${Math.round(info.utilization * 100)}% used)` : '';
        return [
          stamp(ctx, {
            type: 'notice',
            kind: 'rate-limit',
            text: `Approaching usage limit${pct}`,
            ...(typeof info.resetsAt === 'number' ? { resetsAt: info.resetsAt } : {}),
          }),
        ];
      }
      return []; // 'allowed' — nothing to show
    }

    default:
      return [];
  }
}

/** Normalize the user-relevant `system` subtypes that used to fall through to
 *  `[]` (the silent-failure audit's biggest class). Returns null for subtypes
 *  this function doesn't own (task_* — handled by {@link normalizeTaskSystem}),
 *  so the caller can chain. */
function normalizeSystemNotice(ctx: NormalizeContext, msg: SdkMessage): AgentEvent[] | null {
  switch (msg.subtype) {
    case 'status': {
      const out: AgentEvent[] = [];
      // 'compacting' is the only status worth a live line; 'requesting' fires
      // per API call (noise) and `null` is an explicit clear — both map to
      // clearing the transient status.
      out.push(
        stamp(ctx, {
          type: 'session/status',
          status: msg.status === 'compacting' ? 'Compacting conversation…' : null,
        }),
      );
      if (msg.compact_result === 'failed' || msg.compact_error) {
        out.push(
          stamp(ctx, {
            type: 'notice',
            kind: 'compact-error',
            text: `Compaction failed${msg.compact_error ? `: ${msg.compact_error}` : ''}`,
          }),
        );
      }
      // A status message can carry a CLI-side permission-mode change (e.g.
      // plan-mode exit switching to acceptEdits) — reflect it live.
      if (typeof msg.permissionMode === 'string') {
        out.push(stamp(ctx, { type: 'session/update', permissionMode: toPermissionMode(msg.permissionMode) }));
      }
      return out;
    }

    case 'api_retry': {
      // Mid-turn retryable API failure. This is the multi-minute "Working…"
      // stall the spike documented — now it names itself.
      const status = msg.error_status != null ? `API ${msg.error_status}` : 'Connection error';
      const delay = typeof msg.retry_delay_ms === 'number' ? ` in ${Math.max(1, Math.round(msg.retry_delay_ms / 1000))}s` : '';
      const nth = msg.attempt != null && msg.max_retries != null ? ` (${msg.attempt}/${msg.max_retries})` : '';
      return [stamp(ctx, { type: 'session/status', status: `${status} — retrying${delay}${nth}` })];
    }

    case 'compact_boundary': {
      const m = msg.compact_metadata;
      // Compaction just shrank the window contents — refresh the gauge's
      // source so a turn-end before the next API call doesn't report the
      // pre-compact size.
      if (typeof m?.post_tokens === 'number') {
        ctx.lastApiCallUsage = { input_tokens: m.post_tokens };
      }
      const trigger = m?.trigger === 'auto' ? 'auto' : 'manual';
      const sizes =
        m?.pre_tokens != null
          ? ` — ${formatTokens(m.pre_tokens)}${m.post_tokens != null ? ` → ${formatTokens(m.post_tokens)}` : ''} tokens`
          : '';
      return [
        stamp(ctx, { type: 'session/status', status: null }),
        stamp(ctx, { type: 'notice', kind: 'compact-boundary', text: `Conversation compacted (${trigger})${sizes}` }),
      ];
    }

    case 'local_command': // observed on-disk spelling (subtype `local_command`)
    case 'local_command_output': {
      // Output of a built-in slash command (/compact ack, /usage, …) — CC
      // renders these as assistant-style text; we use a command-output notice.
      // The content may arrive wrapped in `<local-command-stdout>` tags (the
      // transcript shape) — unwrap so the notice never shows raw XML, and drop
      // empty blocks (e.g. /clear's `<local-command-stdout></local-command-stdout>`).
      if (typeof msg.content !== 'string' || !msg.content.trim()) return [];
      const c = classifyUserText(msg.content);
      const text = c.kind === 'command-output' ? c.text : msg.content.trim();
      return text ? [stamp(ctx, { type: 'notice', kind: 'command-output', text })] : [];
    }

    case 'informational': {
      if (typeof msg.content !== 'string' || !msg.content.trim()) return [];
      const kind: AgentNoticeKind = msg.level === 'warning' ? 'warning' : 'info';
      return [stamp(ctx, { type: 'notice', kind, text: msg.content })];
    }

    case 'notification':
      return typeof msg.text === 'string' && msg.text.trim()
        ? [stamp(ctx, { type: 'notice', kind: 'notification', text: msg.text })]
        : [];

    case 'permission_denied': {
      // A tool call auto-denied WITHOUT a prompt (deny rule, classifier, mode).
      // Without this row the agent's tool just "fails" with no visible why.
      const reason = msg.decision_reason ? ` — ${msg.decision_reason}` : '';
      const rejection = typeof msg.message === 'string' && msg.message ? `: ${msg.message}` : '';
      return [
        stamp(ctx, {
          type: 'notice',
          kind: 'permission-denied',
          text: `${msg.tool_name ?? 'Tool'} was denied${reason}${rejection}`,
        }),
      ];
    }

    case 'model_refusal_fallback':
    case 'model_refusal_no_fallback':
      // The model refused. Without a row, retracted/hung output reads as a
      // truncated answer with no explanation.
      return typeof msg.content === 'string' && msg.content
        ? [stamp(ctx, { type: 'notice', kind: 'refusal', text: msg.content })]
        : [];

    case 'thinking_tokens':
      return typeof msg.estimated_tokens === 'number'
        ? [stamp(ctx, { type: 'thinking-tokens', tokens: msg.estimated_tokens })]
        : [];

    case 'worker_shutting_down':
      // Session-death forewarning: clear any transient status so a stale
      // "retrying…" line can't outlive the process. The consume loop's own
      // finally emits the terminal turn-end.
      return [stamp(ctx, { type: 'session/status', status: null })];

    default:
      return null; // not ours — let normalizeTaskSystem try
  }
}

/** Compact human token count for notice rows (52.3k / 998). */
function formatTokens(n: number): string {
  return n >= 1000 ? `${(n / 1000).toFixed(1)}k` : String(n);
}

/** The largest reported context window across the result's per-model usage —
 *  the main model's window (subagent models may report smaller ones). */
function contextWindowFrom(mu: SdkMessage['modelUsage']): number | null {
  if (!mu || typeof mu !== 'object') return null;
  let max = 0;
  for (const v of Object.values(mu)) {
    if (v && typeof v.contextWindow === 'number' && v.contextWindow > max) max = v.contextWindow;
  }
  return max > 0 ? max : null;
}

/** Approximate context tokens in use after a turn: ONE API call's input
 *  (fresh + cached) plus its output. Callers must pass a per-call usage
 *  (`ctx.lastApiCallUsage`), never the `result` message's session-cumulative
 *  one — summing that pinned the gauge at 100% (fixed 2026-07-24). */
function contextUsedFrom(u: RawUsage | null | undefined): number | null {
  if (!u) return null;
  const used =
    (u.input_tokens ?? 0) +
    (u.cache_read_input_tokens ?? 0) +
    (u.cache_creation_input_tokens ?? 0) +
    (u.output_tokens ?? 0);
  return used > 0 ? used : null;
}

/** Claude Code writes several NON-conversational frames into the user-message
 *  stream/transcript that must not render as bubbles of raw XML (the bug this
 *  fixes: `/model` acks showing as `<local-command-stdout>…` user bubbles, and
 *  `[Request interrupted by user]` markers rendering as if the user typed them):
 *    • `<command-name>/x</command-name><command-message>…</command-message>
 *      <command-args>…</command-args>` — a built-in slash-command INVOCATION
 *      (tag order varies across CC versions) → reconstructed as the `/x args`
 *      the user actually typed.
 *    • `<local-command-stdout|stderr>…</…>` — the command's OUTPUT, CC's channel
 *      for feeding it to the model's next turn → a quiet `command-output`
 *      notice (empty blocks, e.g. /clear's, drop entirely).
 *    • `[Request interrupted by user]` / `…for tool use]` — the interrupt
 *      marker → an `interrupted` notice; any trailing real text (the prompt
 *      typed after interrupting) survives as `rest`.
 *  Shared by the live normalize path (agent-events.ts `case 'user'`) and the
 *  on-disk backfill (agent-transcript.ts) so both surfaces agree. */
export type UserTextClassification =
  | { kind: 'text'; text: string }
  | { kind: 'command'; text: string }
  | { kind: 'command-output'; text: string }
  | { kind: 'interrupted'; rest: string };

const INTERRUPT_MARKER_RE = /^\[Request interrupted by user[^\]]*\]\s*/;

export function classifyUserText(raw: string): UserTextClassification {
  const text = raw.trim();
  const marker = INTERRUPT_MARKER_RE.exec(text);
  if (marker) return { kind: 'interrupted', rest: text.slice(marker[0].length).trim() };
  if (/^<command-(name|message)>/.test(text)) {
    const name = /<command-name>([\s\S]*?)<\/command-name>/.exec(text)?.[1]?.trim() ?? '';
    const args = /<command-args>([\s\S]*?)<\/command-args>/.exec(text)?.[1]?.trim() ?? '';
    return { kind: 'command', text: [name, args].filter(Boolean).join(' ') };
  }
  if (/^<local-command-std(out|err)\b/.test(text)) {
    const inner: string[] = [];
    const re = /<local-command-std(?:out|err)\b[^>]*>([\s\S]*?)<\/local-command-std(?:out|err)>/g;
    let m: RegExpExecArray | null;
    while ((m = re.exec(text))) {
      const t = m[1].trim();
      if (t) inner.push(t);
    }
    return { kind: 'command-output', text: inner.join('\n') };
  }
  return { kind: 'text', text };
}

/** Extract renderable user TEXT from a stream `user` message's content —
 *  a plain string, or the joined `text` blocks of an array (ignoring
 *  tool_result/image blocks). Returns '' when there is none. */
function userTextFrom(content: RawContentBlock[] | string | undefined): string {
  if (typeof content === 'string') return content.trim();
  if (!Array.isArray(content)) return '';
  const texts: string[] = [];
  for (const b of content) {
    if (b.type === 'text' && typeof (b as { text?: unknown }).text === 'string') {
      texts.push((b as { text: string }).text);
    }
  }
  return texts.join('\n').trim();
}

/** Short display label for an SDK user-message origin. Exported for the
 *  on-disk backfill (agent-transcript.ts), whose envelope persists the same
 *  `origin` shape — so a reopened workspace keeps the badge live turns had. */
export function originLabel(origin: SdkMessage['origin']): string | undefined {
  if (!origin || typeof origin !== 'object') return undefined;
  switch (origin.kind) {
    case 'channel':
      return 'claude.ai';
    case 'peer':
      return origin.name || origin.from ? `peer: ${origin.name ?? origin.from}` : 'peer';
    case 'task-notification':
      return 'task notification';
    default:
      return undefined; // 'human' / unknown → no badge
  }
}

/** A `tool_result.content` is usually a string but the SDK can send a content-
 *  block array; collapse the common text-block array to a string, otherwise pass
 *  the array through for the renderer to handle. */
export function normalizeResultContent(content: unknown): string | unknown[] {
  if (typeof content === 'string') return content;
  if (Array.isArray(content)) {
    // If every block is a `{type:'text', text}` block, join to a plain string.
    const texts = content
      .map((b) => (b && typeof b === 'object' && (b as { text?: unknown }).text) || null)
      .filter((t): t is string => typeof t === 'string');
    if (texts.length === content.length && texts.length > 0) return texts.join('');
    return content;
  }
  if (content == null) return '';
  return String(content);
}

/** Build a permission-request event from a `canUseTool` callback's arguments.
 *  The manager calls this (it owns the requestId map); kept here so the shape
 *  stays with the rest of the contract and is unit-testable. */
export function makePermissionRequest(
  ctx: NormalizeContext,
  requestId: string,
  name: string,
  input: Record<string, unknown>,
  opts?: { toolUseId?: string | null; title?: string },
): AgentPermissionRequestEvent {
  return stamp(ctx, {
    type: 'permission-request',
    requestId,
    toolUseId: opts?.toolUseId ?? null,
    name,
    input,
    ...(opts?.title ? { title: opts.title } : {}),
  });
}

/** The `AskUserQuestion` tool name. Shared source of truth: the renderer's
 *  question UI (src/renderer/components/agent/askUserQuestion.ts) re-exports it,
 *  and agent-sdk.ts's canUseTool bridge tests against it. */
export const ASK_USER_QUESTION = 'AskUserQuestion';

/** Whether a `canUseTool` call should be auto-approved WITHOUT prompting, given
 *  the session's permission mode. `bypassPermissions` auto-approves every tool —
 *  EXCEPT `AskUserQuestion`, which is interactive by nature and must always park
 *  for a real human answer (auto-approving it resolves the tool with no
 *  `answers`, so the harness returns "The user did not answer the questions" and
 *  the prompt appears to close by itself). Pure so it is unit-testable without
 *  Electron — the regression guard for that auto-close bug. */
export function shouldAutoApprovePermission(
  permissionMode: AgentPermissionMode,
  toolName: string,
): boolean {
  return permissionMode === 'bypassPermissions' && toolName !== ASK_USER_QUESTION;
}

/** Whether a session-start error means the persisted `resume` session id is
 *  itself bad/unusable — as opposed to a TRANSIENT failure (network loss, API
 *  500, spawn hiccup, interrupt/abort) that leaves the on-disk transcript intact.
 *
 *  WHY this matters: on a failed resume, `sdkSend` used to clear
 *  `ws.sdkSessionId` for ANY error except "directory not found", so the next
 *  send would start a BLANK session. That over-broad rule discards a perfectly
 *  good session id whenever the resume attempt fails for a reason unrelated to
 *  the id — e.g. the exact internet-loss case (reboot / dropped connection):
 *  a transient error would silently throw away the conversation resume even
 *  though the transcript on disk was fine. We now clear ONLY when the error
 *  POSITIVELY indicates the resume target is bad, and preserve the id otherwise
 *  so a later send resumes the same conversation.
 *
 *  The signals come from the Claude Code CLI/SDK's own error text (verified
 *  against the shipped `sdk.mjs`): `Session <id> not found` (no transcript for
 *  that id) and `Invalid sessionId: <id>` (malformed id). Pure so it is
 *  unit-testable without Electron. */
export function isBadResumeError(message: string): boolean {
  return (
    /session\s+\S+\s+not\s+found/i.test(message) ||
    /invalid\s+session\s*id/i.test(message) ||
    /no\s+conversation\s+found/i.test(message)
  );
}

/** The spool-event names the activity status machine (`applyAgentEvent`,
 *  src/main/activity.ts) consumes — the same lexicon the terminal path's shell
 *  hooks append to the durable events spool. */
/** The spool events that move the sidebar status dot.
 *
 *  `stopfail` mirrors Claude Code's StopFailure hook (a turn that ended on an
 *  API error): `applyAgentEvent` has always handled it alongside `stop` — both
 *  land on `waiting` — but it was missing from this union, so the SDK path had
 *  no way to express "the turn ended badly" even though it knows. */
export type StatusSpoolEvent =
  | 'submit'
  | 'pretool'
  | 'posttool'
  | 'notify'
  | 'stop'
  | 'stopfail';

/** Map one live SDK {@link AgentEvent} onto the spool event that should drive
 *  the sidebar status dot, or `null` when the event doesn't move status.
 *
 *  WHY: the terminal agent's dot is fed by Claude Code's shell lifecycle hooks
 *  (UserPromptSubmit/PreToolUse/PostToolUse/Notification/Stop). The Claude Agent
 *  SDK runs turns programmatically and does NOT fire those per-turn hooks, so a
 *  structured-only session's spool never gets `submit`/`pretool`/`stop` lines
 *  and the dot stays `idle` while the agent works. The SDK manager
 *  (agent-sdk.ts) feeds `applyAgentEvent` itself using this mapping, so ONE
 *  status state machine serves both surfaces. Pure so the mapping is unit-tested
 *  without Electron (the SDK-view "idle while working" regression guard). */
export function sdkEventToStatusEvent(ev: AgentEvent): StatusSpoolEvent | null {
  switch (ev.type) {
    case 'user-message':
      // A submitted turn — the agent is now working (↔ UserPromptSubmit).
      return 'submit';
    case 'tool-use':
      // A tool is about to run: `running` + the active-tool label (↔ PreToolUse).
      return 'pretool';
    case 'tool-result':
      // Tool finished: stay `running`, clear the label (↔ PostToolUse).
      return 'posttool';
    case 'permission-request':
      // The agent parked a permission / AskUserQuestion — it needs the user
      // (↔ Notification → `waiting`).
      return 'notify';
    case 'session/attach':
      // Reattached to a keeper-hosted turn still in flight: the submit that
      // started it happened in a previous app run, so re-assert `running`.
      return ev.turnInFlight ? 'submit' : null;
    case 'turn-end':
      // Turn boundary: finished, waiting for the next prompt (↔ Stop → `waiting`).
      //
      // A turn that ended in an ERROR maps to `stopfail`, the spool event the
      // terminal path already uses for Claude Code's StopFailure hook. Both
      // still land on `waiting` in applyAgentEvent — the distinction is not the
      // status but the REASON, which the finished-toast reads so an errored turn
      // doesn't announce itself as "ready for review".
      //
      // `ev.stopReason` is computed by toStopReason() and already rides on the
      // turn-end event for the renderer's TurnFooter; before this it was dropped
      // at exactly this line, collapsing end_turn / interrupted / max_turns /
      // error into one indistinguishable `waiting`. Both the Messages API
      // (`message_delta.stop_reason`) and Managed Agents (typed `stop_reason` on
      // `session.status_idle`) model turn-end the same way: one idle state, a
      // typed reason beside it.
      return ev.stopReason === 'error' ? 'stopfail' : 'stop';
    default:
      return null;
  }
}

/** The turn-end reason for a status event, when the event carries one.
 *
 *  Kept separate from {@link sdkEventToStatusEvent} so the status mapping stays
 *  a pure event→event function: the reason is metadata ABOUT a terminal event,
 *  not a different event. Returns undefined for every non-terminal event, which
 *  is what `applyAgentEvent` expects for the spool path (shell hooks carry no
 *  reason — Claude Code's Stop hook has no equivalent field, so the terminal
 *  path simply passes nothing and behaves exactly as before). */
export function sdkEventToStopReason(ev: AgentEvent): AgentStopReason | undefined {
  return ev.type === 'turn-end' ? ev.stopReason : undefined;
}

/** Build a stamped user-message echo (see {@link AgentUserMessageEvent}) — the
 *  manager emits one per sdkSend so the submitted prompt renders immediately. */
export function makeUserMessage(
  ctx: NormalizeContext,
  text: string,
  images?: AgentImage[],
  rewindId?: string,
): AgentUserMessageEvent {
  return stamp(ctx, {
    type: 'user-message',
    text,
    ...(images && images.length > 0 ? { images } : {}),
    ...(rewindId ? { rewindId } : {}),
  });
}

/** Build a stamped local-command event (see {@link AgentLocalCommandEvent}) — the
 *  manager emits one when a `!command` bash-mode run starts (`running:true`) and
 *  one when it completes (`running:false` + output + exitCode), both sharing the
 *  same `commandId` so they fold into one transcript row. */
export function makeLocalCommand(
  ctx: NormalizeContext,
  fields: Omit<AgentLocalCommandEvent, 'type' | 'seq' | 'at'>,
): AgentLocalCommandEvent {
  return stamp(ctx, { type: 'local-command', ...fields });
}

// ─── fold: AgentEvent → AgentSession ─────────────────────────────────────────

/** A fresh, empty session for a workspace — the fold identity. */
export function emptySession(workspaceId: string): AgentSession {
  return {
    workspaceId,
    sessionId: '',
    model: '',
    // Mirrors the manager's session default (bypass — see ensureSession) so the
    // Permissions dropdown reads correctly before the first init event lands.
    permissionMode: 'bypassPermissions',
    running: false,
    messages: [],
    pendingPermissions: [],
    totalCostUsd: 0,
    liveOutputChars: 0,
    tasks: {},
    lastSeq: -1,
  };
}

/** The stable render-message id for a content block. `seq` is included because
 *  SDK content-block indexes RESET each turn (and a history backfill reuses
 *  low indexes too) — without it, turn 2's block 0 would collide with turn 1's
 *  (duplicate React keys, corrupted height cache). Correlation between events
 *  of one block happens via `index` lookup (findByIndex), never via this id. */
function blockMsgId(sessionId: string, index: number, seq: number): string {
  return `${sessionId || 'nosession'}:${seq}:${index}`;
}

/** Find the render message for a block index (text/thinking/tool), or -1. */
function findByIndex(messages: RenderMessage[], index: number): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].index === index) return i;
  }
  return -1;
}

/** Find the tool render message by tool_use id, or -1. */
function findByToolUseId(messages: RenderMessage[], toolUseId: string): number {
  for (let i = messages.length - 1; i >= 0; i--) {
    if (messages[i].toolUse?.toolUseId === toolUseId) return i;
  }
  return -1;
}

/** Apply one event to a session immutably, returning the new session. Replaying
 *  the whole stream from {@link emptySession} rebuilds the view. Safe to call
 *  out of order-ish (it tolerates a delta before its block-start), but `seq`
 *  gaps are the caller's to detect via {@link AgentSession.lastSeq}. */
export function foldEvent(session: AgentSession, event: AgentEvent): AgentSession {
  // Every branch returns a shallow-cloned session; message mutations clone the
  // messages array and the touched message so React sees new references.
  const next: AgentSession = { ...session, lastSeq: Math.max(session.lastSeq, event.seq) };

  switch (event.type) {
    case 'session/init':
      return {
        ...next,
        sessionId: event.sessionId,
        model: event.model,
        permissionMode: event.permissionMode,
        // A session can boot WITHOUT a turn in flight (lazy start from a bash
        // run or the Remote Control toggle), so init must NOT flip `running` —
        // that wedged a perpetual "Working…" footer with no result ever coming
        // (silent-failure audit H8). The user-message echo is what opens a
        // turn; it precedes init whenever a prompt caused the boot.
        running: next.running,
        turnStartedAt: next.turnStartedAt,
        liveOutputChars: next.running ? next.liveOutputChars : 0,
        ...(event.slashCommands !== undefined ? { slashCommands: event.slashCommands } : {}),
        ...(event.mcpServers !== undefined ? { mcpServers: event.mcpServers } : {}),
      };

    case 'block-start': {
      const messages = [...next.messages];
      const id = blockMsgId(next.sessionId, event.index, event.seq);
      if (event.kind === 'tool_use') {
        // The tool message is created here (empty), filled by tool-input-delta
        // then finalized by the tool-use event. When the stream gave us the
        // tool's real id/name at block-start, mint the message with its FINAL
        // id + name immediately: the id is the React key + measured-height
        // cache key downstream, and it must never change once rendered (a
        // change remounts the row mid-stream — the tool-card flicker bug).
        messages.push({
          id: event.toolUseId || id,
          role: 'tool',
          index: event.index,
          at: event.at,
          toolUse: { toolUseId: event.toolUseId ?? '', name: event.name ?? '', inputJson: '' },
        });
      } else if (event.kind === 'thinking') {
        // Thinking text was empty on Opus 4.8 under the old thinking config
        // (spike b) — the message is a pure indicator, so it gets NO `text`
        // slot, only the boolean flag. See normalizeStreamEvent's thinking note
        // for the scope of that finding (it describes `display:'omitted'`, not
        // every model/config) and what to test before building a text UI here.
        messages.push({ id, role: 'assistant', index: event.index, at: event.at, thinking: true });
      } else {
        messages.push({ id, role: 'assistant', index: event.index, at: event.at, text: '' });
      }
      return { ...next, messages };
    }

    case 'thinking-start': {
      const messages = [...next.messages];
      let i = findByIndex(messages, event.index);
      if (i === -1) {
        messages.push({
          id: blockMsgId(next.sessionId, event.index, event.seq),
          role: 'assistant',
          index: event.index,
          at: event.at,
          thinking: true,
        });
      } else {
        messages[i] = { ...messages[i], thinking: true };
      }
      return { ...next, messages };
    }

    case 'text-delta': {
      const messages = [...next.messages];
      let i = findByIndex(messages, event.index);
      if (i === -1) {
        // Delta before its block-start: create the text message on the fly.
        messages.push({
          id: blockMsgId(next.sessionId, event.index, event.seq),
          role: 'assistant',
          index: event.index,
          at: event.at,
          text: event.text,
        });
      } else {
        messages[i] = { ...messages[i], text: (messages[i].text ?? '') + event.text };
      }
      // Track streamed output length for the live token estimate (see
      // AgentSession.liveOutputChars). Text deltas are the assistant's visible
      // output; the exact token count still arrives at turn-end. Output
      // resuming also retires any transient status line ("retrying…").
      return {
        ...next,
        messages,
        liveOutputChars: next.liveOutputChars + event.text.length,
        statusNotice: undefined,
      };
    }

    case 'tool-input-delta': {
      const messages = [...next.messages];
      let i = findByIndex(messages, event.index);
      if (i === -1) {
        messages.push({
          id: blockMsgId(next.sessionId, event.index, event.seq),
          role: 'tool',
          index: event.index,
          at: event.at,
          toolUse: { toolUseId: '', name: '', inputJson: event.partialJson },
        });
      } else {
        const m = messages[i];
        const tu = m.toolUse ?? { toolUseId: '', name: '', inputJson: '' };
        messages[i] = { ...m, toolUse: { ...tu, inputJson: tu.inputJson + event.partialJson } };
      }
      return { ...next, messages };
    }

    case 'block-stop': {
      const messages = [...next.messages];
      const i = findByIndex(messages, event.index);
      if (i !== -1) {
        // Clearing `index` retires the block from findByIndex: SDK block
        // indexes reset every turn, so a closed turn-1 block must never absorb
        // a stray turn-2 delta arriving before its own block-start.
        messages[i] = { ...messages[i], thinking: false, done: true, index: undefined };
        return { ...next, messages };
      }
      return next;
    }

    case 'tool-use': {
      const messages = [...next.messages];
      // Prefer the exact match: block-start minted the message with this
      // toolUseId already (the streaming content_block_start carries it).
      let i = findByToolUseId(messages, event.toolUseId);
      if (i === -1) {
        // Legacy/defensive fallback (a stream whose block-start carried no id):
        // tool-use events arrive in content-block order, so the FIRST tool row
        // still awaiting finalization is the one this event completes. (A
        // last-unfinalized rule here swapped names/inputs across parallel tool
        // blocks streamed in one assistant message — audit M6.)
        i = messages.findIndex(
          (m) =>
            m.role === 'tool' &&
            m.toolUse !== undefined &&
            m.toolUse.input === undefined &&
            m.toolUse.toolUseId === '',
        );
      }

      if (i === -1) {
        messages.push({
          id: event.toolUseId,
          role: 'tool',
          at: event.at,
          toolUse: {
            toolUseId: event.toolUseId,
            name: event.name,
            inputJson: '',
            input: event.input,
          },
        });
      } else {
        const m = messages[i];
        const tu = m.toolUse ?? { toolUseId: '', name: '', inputJson: '' };
        // NEVER rewrite `m.id` here: the message id is the React key and the
        // virtualizer's measured-height cache key. Rewriting it (the old code
        // set it to event.toolUseId) unmounted + remounted the row — and the
        // whole ToolGroup when this was the run's first tool — exactly when
        // the card finalized: the mid-stream flicker/jump the user saw.
        messages[i] = {
          ...m,
          toolUse: { ...tu, toolUseId: event.toolUseId, name: event.name, input: event.input },
        };
      }
      // A finalized tool call means the model is producing again — retire any
      // transient "retrying…" status line.
      return { ...next, messages, statusNotice: undefined };
    }

    case 'tool-result': {
      const messages = [...next.messages];
      const i = findByToolUseId(messages, event.toolUseId);
      if (i !== -1) {
        messages[i] = {
          ...messages[i],
          toolResult: { content: event.content, isError: event.isError },
          done: true,
        };
        return { ...next, messages };
      }
      // Result with no known tool_use (out-of-order or missed tool-use): create
      // a standalone tool message so the result still shows.
      messages.push({
        id: event.toolUseId,
        role: 'tool',
        at: event.at,
        toolUse: { toolUseId: event.toolUseId, name: '', inputJson: '' },
        toolResult: { content: event.content, isError: event.isError },
        done: true,
      });
      return { ...next, messages };
    }

    case 'permission-request': {
      // De-dupe by requestId (a re-emit shouldn't stack two prompts).
      if (next.pendingPermissions.some((p) => p.requestId === event.requestId)) return next;
      return { ...next, pendingPermissions: [...next.pendingPermissions, event] };
    }

    case 'session/update':
      return {
        ...next,
        ...(event.model !== undefined ? { model: event.model } : {}),
        ...(event.permissionMode !== undefined ? { permissionMode: event.permissionMode } : {}),
      };

    case 'session/remote-control':
      // Full-state replace (the manager always emits the complete state), so a
      // replay from emptySession reconstructs the current toggle state.
      return { ...next, remoteControl: event.state };

    case 'session/mcp':
      // Full-list replace, mirroring session/remote-control: the MCP control
      // ops always emit the complete server list from mcpServerStatus().
      return { ...next, mcpServers: event.servers };

    case 'user-message': {
      const messages = [...next.messages];
      // `running: true` from the moment a prompt is submitted — the turn is in
      // flight before the first SDK event lands, and the composer/interrupt
      // should reflect that immediately.
      messages.push({
        id: `user:${event.seq}`,
        role: 'user',
        at: event.at,
        text: event.text,
        ...(event.origin ? { origin: event.origin } : {}),
        ...(event.images && event.images.length > 0 ? { images: event.images } : {}),
        // The rewind target for this turn, when Orchestra minted one (locally
        // submitted turns) or the history backfill recovered it from disk.
        ...(event.rewindId ? { rewindId: event.rewindId } : {}),
        done: true,
      });
      // A fresh prompt starts a new turn: start the live clock and reset the
      // per-turn output-char counter that feeds the live token estimate.
      return {
        ...next,
        messages,
        running: true,
        turnStartedAt: event.at,
        liveOutputChars: 0,
        statusNotice: undefined,
        liveThinkingTokens: undefined,
      };
    }

    case 'local-command': {
      // A `!command` bash-mode run. Two events share one `commandId`: a start
      // (`running:true`) that appends the row, and a completion (`running:false`
      // + output + exitCode) that updates it in place. Keyed by commandId so the
      // completion finds and replaces the running row rather than appending.
      const id = `bash:${event.commandId}`;
      const messages = [...next.messages];
      const idx = messages.findIndex((m) => m.id === id);
      const localCommand = {
        command: event.command,
        running: event.running,
        ...(event.output !== undefined ? { output: event.output } : {}),
        ...(event.exitCode !== undefined ? { exitCode: event.exitCode } : {}),
      };
      const row: RenderMessage = {
        id,
        role: 'local-command',
        localCommand,
        // The completion event replaces the row wholesale — keep the START
        // time (the mint's `at`), not the completion's.
        at: idx >= 0 ? messages[idx].at : event.at,
        done: !event.running,
      };
      if (idx >= 0) messages[idx] = row;
      else messages.push(row);
      // A bash-mode run does NOT start a model turn (it runs locally), so it
      // must not flip `running`/`turnStartedAt` — leave the turn state untouched.
      return { ...next, messages };
    }

    case 'turn-end':
      return {
        ...next,
        running: false,
        lastTurn: event,
        totalCostUsd: next.totalCostUsd + (event.costUsd ?? 0),
        // The turn is over — stop the live clock; the footer now reads the exact
        // duration/token usage off `lastTurn` instead of the live estimate.
        turnStartedAt: undefined,
        // A finished turn resolves any still-pending permission prompts (the
        // turn cannot end with a live canUseTool call outstanding).
        pendingPermissions: [],
        // …and retires the transient working-readout extras.
        statusNotice: undefined,
        liveThinkingTokens: undefined,
      };

    case 'error': {
      const messages = [...next.messages];
      messages.push({
        id: `error:${event.seq}`,
        role: 'error',
        at: event.at,
        text: event.message,
        // Terminal by construction — without `done` the bubble would show a
        // live streaming cursor on a finished error.
        done: true,
      });
      return { ...next, messages };
    }

    case 'task':
      return { ...next, tasks: foldTaskEvent(next.tasks, event) };

    case 'notice': {
      // Collapse back-to-back interrupt markers: one interrupt can surface
      // twice (the stream's "[Request interrupted by user]" marker AND the
      // manager's catch-path notice) — one row tells the story.
      if (event.kind === 'interrupted') {
        const last = next.messages[next.messages.length - 1];
        if (last?.role === 'system' && last.noticeKind === 'interrupted') return next;
      }
      const messages = [...next.messages];
      messages.push({
        id: `notice:${event.seq}`,
        role: 'system',
        at: event.at,
        text: event.text,
        noticeKind: event.kind,
        ...(event.resetsAt !== undefined ? { noticeResetsAt: event.resetsAt } : {}),
        done: true,
      });
      return { ...next, messages };
    }

    case 'session/status':
      return { ...next, statusNotice: event.status ?? undefined };

    case 'session/memory-size':
      // Replaced wholesale, never merged: the event carries the complete set of
      // over-limit files, so an empty list must be able to CLEAR a previous
      // warning (a merge-shaped fold could only ever add — the absent-means-no-
      // opinion trap that leaves a stale banner pinned after the file shrinks).
      return { ...next, oversizedMemory: event.files };

    case 'thinking-tokens':
      return { ...next, liveThinkingTokens: event.tokens };

    case 'session/attach':
      // Reattached to a detached keeper's CLI with a turn mid-flight: no
      // `user-message` echo ever ran in THIS app instance, so without this the
      // reattached turn streams into an "idle" pane (no Working indicator, no
      // interrupt affordance). `turnStartedAt` measures from the attach — the
      // original submit instant died with the previous app run.
      if (!event.turnInFlight) return next;
      return { ...next, running: true, turnStartedAt: event.at, liveOutputChars: 0 };

    case 'session/clear':
      // Full reset (composer /clear): a fresh transcript for every client. The
      // fold identity keeps only the workspace binding.
      return emptySession(next.workspaceId);

    case 'session/rewind': {
      // The main process has truncated the underlying session back to just
      // BEFORE the target user message (see sdkRewind). Mirror that in the
      // rendered transcript: the target and everything after it are gone.
      //
      // Cut at the FIRST message carrying this rewindId. Messages are appended
      // in stream order, so everything at a higher index came after it — no
      // ordering assumption beyond that is needed. An unknown id is a no-op
      // rather than a wipe: a stale/duplicate event must never clear a
      // transcript it doesn't match (the destructive failure mode).
      const cut = next.messages.findIndex((m) => m.rewindId === event.rewindId);
      if (cut < 0) return next;
      return {
        ...next,
        messages: next.messages.slice(0, cut),
        // The rewind ends any in-flight turn: the session was stopped and will
        // be restarted lazily on the next send. Clear the live turn state so
        // the pane can't wedge on a "Working…" footer for a turn that no
        // longer exists (same reasoning as consume()'s synthetic turn-end).
        running: false,
        turnStartedAt: undefined,
        liveOutputChars: 0,
        statusNotice: undefined,
        liveThinkingTokens: undefined,
        // Any permission parked by the discarded turn can never be answered —
        // its canUseTool promise died with the session.
        pendingPermissions: [],
      };
    }

    default: {
      // Compile-time exhaustiveness (the `never` assignment errors if a variant
      // is unhandled) WITHOUT the runtime throw: an unknown event from a newer
      // main process must degrade to a skip, not poison the whole RAF
      // batch — `drain()` clears the queue before folding, so a throw here used
      // to drop every event in the frame for every workspace (audit H5).
      const _exhaustive: never = event;
      void _exhaustive;
      return next;
    }
  }
}

/** Fold one {@link AgentTaskEvent} into the session's `tasks` map immutably.
 *  Split out so `foldEvent` stays flat.
 *
 *  Lifecycle:
 *   • `started`      — create the card (or, if a `progress`/`changed` raced
 *                      ahead of it, backfill the started-only fields).
 *   • `progress`     — merge live usage/last-tool/summary/description.
 *   • `updated`      — merge a patch; a terminal status finalizes.
 *   • `notification` — finalize: terminal status + final usage + transcript.
 *   • `changed`      — REPLACE-semantics reconcile of the running set: any task
 *                      still marked `running` but absent from `liveIds` is
 *                      finalized to `stopped`, so a missed finish bookend can't
 *                      wedge a permanently-spinning card (sdk.d.ts calls this a
 *                      "level signal"). It never creates a card (the payload
 *                      carries ids only) nor resurrects a finished one.
 *
 *  All merges preserve first-seen insertion order (object key order), which the
 *  panel relies on for a stable card list. */
function foldTaskEvent(
  tasks: Record<string, BackgroundTask>,
  event: AgentTaskEvent,
): Record<string, BackgroundTask> {
  if (event.kind === 'changed') {
    const live = new Set(event.liveIds ?? []);
    let mutated = false;
    const out: Record<string, BackgroundTask> = {};
    for (const [id, task] of Object.entries(tasks)) {
      if (task.status === 'running' && !live.has(id)) {
        out[id] = { ...task, status: 'stopped', endedAt: task.endedAt ?? event.at };
        mutated = true;
      } else {
        out[id] = task;
      }
    }
    return mutated ? out : tasks;
  }

  const id = event.taskId;
  if (!id) return tasks;

  const prev = tasks[id];
  const base: BackgroundTask = prev ?? {
    id,
    description: '',
    status: 'running',
    startedAt: event.at,
  };

  // Merge only the fields this event carries; leave the rest as-was.
  const merged: BackgroundTask = {
    ...base,
    ...(event.toolUseId !== undefined ? { toolUseId: event.toolUseId } : {}),
    ...(event.taskType !== undefined ? { taskType: event.taskType } : {}),
    ...(event.subagentType !== undefined ? { subagentType: event.subagentType } : {}),
    ...(event.description !== undefined ? { description: event.description } : {}),
    ...(event.usage !== undefined ? { usage: mergeTaskUsage(base.usage, event.usage) } : {}),
    ...(event.lastToolName !== undefined ? { lastToolName: event.lastToolName } : {}),
    ...(event.summary !== undefined ? { summary: event.summary } : {}),
    ...(event.outputFile !== undefined ? { outputFile: event.outputFile } : {}),
  };

  // A terminal status (from `notification` or a terminal `updated` patch)
  // freezes the card and stamps its end time once.
  if (event.status) {
    merged.status = event.status;
    merged.endedAt = merged.endedAt ?? event.at;
  }

  return { ...tasks, [id]: merged };
}

/** Merge an incoming task-usage counter over the prior one. The SDK reports
 *  cumulative counters, so a later report simply supersedes; but a
 *  `notification`'s `durationMs` should stick even if a subsequent (unlikely)
 *  event omits it. */
function mergeTaskUsage(
  prev: AgentTaskUsage | undefined,
  next: AgentTaskUsage,
): AgentTaskUsage {
  return {
    totalTokens: next.totalTokens,
    toolUses: next.toolUses,
    ...(next.durationMs != null
      ? { durationMs: next.durationMs }
      : prev?.durationMs != null
        ? { durationMs: prev.durationMs }
        : {}),
  };
}

/** Fold a whole ordered event list into a session (test/replay helper). */
export function foldEvents(session: AgentSession, events: AgentEvent[]): AgentSession {
  return events.reduce(foldEvent, session);
}

/** Remove a resolved permission request from the pending list. */
export function clearPendingPermission(session: AgentSession, requestId: string): AgentSession {
  const pendingPermissions = session.pendingPermissions.filter((p) => p.requestId !== requestId);
  if (pendingPermissions.length === session.pendingPermissions.length) return session;
  return { ...session, pendingPermissions };
}
