/**
 * StructuredView — the container for the structured agent view (Phase 2 / A2).
 *
 * Renders a live Claude Agent SDK session as native React UI instead of raw
 * terminal bytes. This file owns the PLUMBING only:
 *   • reads the folded `AgentSession` for its workspace from the store
 *     (built by the RAF-batched `agent:event` fold — see store.ts / agent-event-queue.ts),
 *   • a VIRTUALIZED (windowed) message list so a 500-message session stays 60fps
 *     — only messages in/near the viewport mount,
 *   • a composer that sends turns via `window.orchestra.agentSdkSend`,
 *   • an interrupt button wired to `window.orchestra.agentSdkInterrupt`,
 *   • PLACEHOLDER slots per RenderMessage type.
 *
 * It deliberately does NOT own the pretty message/tool/permission components —
 * those are extension points other swarm agents fill:
 *   • A3 replaces {@link MessageSlot}'s per-role bodies with real markdown
 *     bubbles, collapsible tool cards, and Monaco diffs.
 *   • A4 replaces {@link PermissionSlot} and {@link SessionControls} with the
 *     native approve/deny dialog, AskUserQuestion UI, model/mode controls, and
 *     the cost/token turn footer.
 * All visual styling lives in A5's `src/renderer/agent-view.css`, keyed on the
 * `av-*` class names stamped here. This file only sets structure + defaults.
 *
 * Lazy start: there is no separate "start" IPC — the SDK session is started by
 * the first `agentSdkSend` (see ipc.ts:242). So the composer's first submit both
 * starts the session and sends the opening turn; nothing extra to call on tab open.
 */

import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { useStore } from '../store';
import type { AgentSession, RenderMessage } from '../../shared/types';

interface Props {
  workspaceId: string;
  /** Whether this workspace's structured tab is the visible one. The component
   *  stays mounted when inactive (like TerminalView) so scroll/session survive
   *  tab switches; CSS hides it via `av-view` (no `.active`). */
  isActive: boolean;
}

// Windowing constants. The list is a simple fixed-overscan windowed renderer:
// we measure each row after it mounts (heights vary — a one-line text delta vs a
// tool card), cache the measurements, and render only the rows whose estimated
// offset intersects the viewport plus an overscan margin. This keeps the DOM
// node count bounded (~viewport/ESTIMATED_ROW_H + 2*OVERSCAN) regardless of
// session length, which is what holds 60fps at 500 messages.
const ESTIMATED_ROW_H = 72;
const OVERSCAN = 6;

export function StructuredView({ workspaceId, isActive }: Props) {
  const session = useStore((s) => s.agentSessions[workspaceId]);

  return (
    <div className={`av-view ${isActive ? 'active' : ''}`} data-workspace={workspaceId}>
      <MessageList session={session} />
      {/* A4 extension point: permission dialog(s) for parked canUseTool calls.
          Rendered as an overlay above the list. */}
      <PermissionSlot session={session} workspaceId={workspaceId} />
      {/* A4 extension point: cost/token/duration turn footer + model/mode
          controls. Given the last turn-end and running state. */}
      <SessionControls session={session} workspaceId={workspaceId} />
      <Composer session={session} workspaceId={workspaceId} isActive={isActive} />
    </div>
  );
}

// ── Virtualized message list ─────────────────────────────────────────────────

function MessageList({ session }: { session: AgentSession | undefined }) {
  const scrollRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  // Measured row heights, keyed by message id — falls back to the estimate for
  // rows not yet measured. A ref (not state) so measuring doesn't re-render;
  // we bump `measureTick` to recompute the window after a batch of measures.
  const heights = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  // Stick to bottom while the user hasn't scrolled up — streaming output should
  // keep the latest message in view, like a terminal.
  const stickBottom = useRef(true);

  const messages = session?.messages ?? [];

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const atBottom = el.scrollHeight - el.scrollTop - el.clientHeight < 24;
    stickBottom.current = atBottom;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
  }, []);

  // Track viewport height (resize) so the window recomputes on layout changes.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    setViewport({ scrollTop: el.scrollTop, height: el.clientHeight });
    const ro = new ResizeObserver(() => {
      setViewport((v) => ({ ...v, height: el.clientHeight }));
    });
    ro.observe(el);
    return () => ro.disconnect();
  }, []);

  // Auto-scroll to bottom when a new message lands and we're stuck to bottom.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (el && stickBottom.current) el.scrollTop = el.scrollHeight;
  }, [messages.length, measureTick]);

  // Compute cumulative offsets from cached/estimated heights, then the visible
  // window [start, end). O(n) per layout — n is message count; the win is that
  // only the sliced rows actually mount as DOM.
  const rowH = (m: RenderMessage) => heights.current.get(m.id) ?? ESTIMATED_ROW_H;
  const offsets: number[] = new Array(messages.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < messages.length; i++) offsets[i + 1] = offsets[i] + rowH(messages[i]);
  const totalHeight = offsets[messages.length] ?? 0;

  const top = viewport.scrollTop;
  const bottom = top + (viewport.height || 1);
  let start = 0;
  while (start < messages.length && offsets[start + 1] < top) start++;
  let end = start;
  while (end < messages.length && offsets[end] < bottom) end++;
  start = Math.max(0, start - OVERSCAN);
  end = Math.min(messages.length, end + OVERSCAN);

  const visible = messages.slice(start, end);
  const padTop = offsets[start] ?? 0;

  return (
    <div ref={scrollRef} className="av-message-list" onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="av-empty">
          {session
            ? 'Session ready — send a message to start the agent.'
            : 'No structured session yet. Send a message to start the agent.'}
        </div>
      ) : (
        <div className="av-message-list-inner" style={{ height: totalHeight, position: 'relative' }}>
          <div style={{ transform: `translateY(${padTop}px)` }}>
            {visible.map((m, i) => (
              <MeasuredRow
                key={m.id}
                message={m}
                onHeight={(h) => {
                  if (heights.current.get(m.id) !== h) {
                    heights.current.set(m.id, h);
                    // Coalesce measure-driven recomputes to the next frame so a
                    // batch of newly-mounted rows triggers one window recompute.
                    scheduleMeasureFlush(() => setMeasureTick((t) => t + 1));
                  }
                }}
                // Index in the full list, for debugging/keys downstream.
                dataIndex={start + i}
              />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}

// One shared microtask/frame coalescer for height measurements so N rows
// mounting in one commit cause one recompute, not N.
let measureFlushScheduled = false;
function scheduleMeasureFlush(cb: () => void) {
  if (measureFlushScheduled) return;
  measureFlushScheduled = true;
  requestAnimationFrame(() => {
    measureFlushScheduled = false;
    cb();
  });
}

function MeasuredRow({
  message,
  onHeight,
  dataIndex,
}: {
  message: RenderMessage;
  onHeight: (h: number) => void;
  dataIndex: number;
}) {
  const ref = useRef<HTMLDivElement>(null);
  useLayoutEffect(() => {
    const el = ref.current;
    if (el) onHeight(el.offsetHeight);
  });
  return (
    <div ref={ref} className="av-row" data-index={dataIndex}>
      <MessageSlot message={message} />
    </div>
  );
}

// ── Placeholder message renderer (A3 extension point) ────────────────────────
//
// A3 replaces the bodies below with real components: markdown bubbles, tool
// cards with collapsible sections, Monaco diffs reconstructed from tool_use
// input, etc. The structure (one `av-message` per RenderMessage, role in a
// data attribute + class) and the field access are the contract A3 builds on.

function MessageSlot({ message }: { message: RenderMessage }) {
  const role = message.role;
  return (
    <div className={`av-message av-message-${role}`} data-role={role}>
      {message.thinking && (
        // A3 may replace with a nicer spinner; thinking text is redacted on
        // Opus 4.8 so this is a boolean indicator only.
        <div className="av-thinking" aria-label="thinking">
          <span className="av-thinking-dot" /> thinking…
        </div>
      )}

      {message.role === 'tool' && message.toolUse ? (
        <ToolSlot message={message} />
      ) : (
        typeof message.text === 'string' && (
          <div className="av-message-text">{message.text}</div>
        )
      )}
    </div>
  );
}

function ToolSlot({ message }: { message: RenderMessage }) {
  const tu = message.toolUse!;
  const result = message.toolResult;
  return (
    <div className={`av-tool-card av-tool-${tu.name.toLowerCase()}`} data-tool={tu.name}>
      <div className="av-tool-card-header">
        <span className="av-tool-name">{tu.name}</span>
        {!message.done && <span className="av-tool-streaming">…</span>}
      </div>
      {/* A3: render tool-specific bodies — Edit/Write → diff from input,
          Bash → command+output, Read/Grep/Glob → summary, etc. Until then,
          show the assembling/assembled input JSON as a compact default. */}
      <pre className="av-tool-input">{tu.input ? JSON.stringify(tu.input, null, 2) : tu.inputJson}</pre>
      {result && (
        <div className={`av-tool-result ${result.isError ? 'av-tool-result-error' : ''}`}>
          {typeof result.content === 'string'
            ? result.content
            : JSON.stringify(result.content)}
        </div>
      )}
    </div>
  );
}

// ── Permission slot (A4 extension point) ─────────────────────────────────────
//
// A4 replaces this with the native approve/deny dialog + AskUserQuestion UI. It
// reads `session.pendingPermissions` and answers via
// `window.orchestra.agentSdkPermissionReply(wsId, requestId, reply)`.

function PermissionSlot({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  const pending = session?.pendingPermissions ?? [];
  if (pending.length === 0) return null;
  return (
    <div className="av-permission-dialog" role="dialog" aria-label="Permission request">
      {pending.map((p) => (
        <div key={p.requestId} className="av-permission-request" data-request={p.requestId}>
          <div className="av-permission-title">{p.title ?? `Allow ${p.name}?`}</div>
          <pre className="av-permission-input">{JSON.stringify(p.input, null, 2)}</pre>
          {/* Default approve/deny so the view is usable before A4's dialog lands. */}
          <div className="av-permission-actions">
            <button
              className="av-permission-allow"
              onClick={() =>
                void window.orchestra
                  .agentSdkPermissionReply(workspaceId, p.requestId, { behavior: 'allow' })
                  .catch(() => {})
              }
            >
              Allow
            </button>
            <button
              className="av-permission-deny"
              onClick={() =>
                void window.orchestra
                  .agentSdkPermissionReply(workspaceId, p.requestId, {
                    behavior: 'deny',
                    message: 'Denied by user',
                  })
                  .catch(() => {})
              }
            >
              Deny
            </button>
          </div>
        </div>
      ))}
    </div>
  );
}

// ── Session controls + turn footer (A4 extension point) ──────────────────────
//
// A4 replaces this with model/permission-mode switches and a rich cost/token/
// duration footer. For now: an interrupt button (wired) + a minimal footer.

function SessionControls({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  const running = !!session?.running;
  const lastTurn = session?.lastTurn;
  return (
    <div className="av-controls">
      <div className="av-turn-footer">
        {session?.model && <span className="av-model">{session.model}</span>}
        {typeof session?.totalCostUsd === 'number' && session.totalCostUsd > 0 && (
          <span className="av-cost">${session.totalCostUsd.toFixed(4)}</span>
        )}
        {lastTurn?.usage && (
          <span className="av-tokens">
            {lastTurn.usage.inputTokens + lastTurn.usage.outputTokens} tok
          </span>
        )}
      </div>
      {running && (
        <button
          className="av-interrupt"
          onClick={() => void window.orchestra.agentSdkInterrupt(workspaceId).catch(() => {})}
          title="Interrupt the current turn"
        >
          Stop
        </button>
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

function Composer({
  session,
  workspaceId,
  isActive,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
  isActive: boolean;
}) {
  const [text, setText] = useState('');
  const taRef = useRef<HTMLTextAreaElement>(null);
  const running = !!session?.running;

  // Focus the composer when this tab becomes active, so the user can type
  // immediately after switching to the structured view.
  useEffect(() => {
    if (isActive) taRef.current?.focus();
  }, [isActive]);

  const submit = useCallback(() => {
    const t = text.trim();
    if (!t) return;
    // First submit lazily starts the SDK session (no separate start IPC).
    void window.orchestra.agentSdkSend(workspaceId, t).catch(() => {});
    setText('');
  }, [text, workspaceId]);

  return (
    <div className="av-composer">
      <textarea
        ref={taRef}
        className="av-composer-input"
        value={text}
        placeholder="Message the agent…"
        rows={1}
        onChange={(e) => setText(e.target.value)}
        onKeyDown={(e) => {
          // Enter submits; Shift+Enter inserts a newline (chat convention).
          if (e.key === 'Enter' && !e.shiftKey) {
            e.preventDefault();
            submit();
          }
        }}
      />
      <button className="av-composer-send" onClick={submit} disabled={!text.trim()}>
        {running ? 'Queue' : 'Send'}
      </button>
    </div>
  );
}
