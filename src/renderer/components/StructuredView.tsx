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
// A3: real presentational components (markdown bubbles, tool cards, diffs,
// thinking spinner). AgentMessage routes tool→ToolCard else→MessageBubble and
// owns the `av-message`/`av-tool-card` wrappers + thinking indicator, so it
// fully replaces the placeholder MessageSlot/ToolSlot bodies below.
// A4: interaction surfaces mounted into the slots below (permission dialog,
// AskUserQuestion UI, model/permission-mode controls, rich turn footer).
import { AgentMessage, PermissionDialog, AgentControls, TurnFooter } from './agent';

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
  // A prior SDK session on disk means the next message RESUMES it (the agent
  // keeps its memory), even though the message list starts empty this render.
  const canResume = useStore(
    (s) => !!s.workspaces.find((w) => w.id === workspaceId)?.sdkSessionId,
  );

  return (
    <div className={`av-view ${isActive ? 'active' : ''}`} data-workspace={workspaceId}>
      <MessageList session={session} canResume={canResume} />
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

function MessageList({
  session,
  canResume,
}: {
  session: AgentSession | undefined;
  canResume?: boolean;
}) {
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
            : canResume
              ? 'Previous session found — send a message to resume it (the agent keeps its memory; earlier messages aren’t re-shown here).'
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

// ── Message renderer (A3) ────────────────────────────────────────────────────
//
// A3's <AgentMessage> replaces the former placeholder MessageSlot/ToolSlot: it
// routes a RenderMessage to a MessageBubble (streaming markdown + thinking
// spinner) or a ToolCard (collapsible, per-tool bodies, Monaco diffs from
// tool_use input), and owns the `av-message`/`av-tool-card` wrappers itself.

function MessageSlot({ message }: { message: RenderMessage }) {
  return <AgentMessage message={message} />;
}

// ── Permission slot (A4) ─────────────────────────────────────────────────────
//
// The native approve/deny dialog + AskUserQuestion UI. Reads
// `session.pendingPermissions`, shows the oldest first (one at a time), and
// answers via `agentSdkPermissionReply(wsId, requestId, reply)`. Its own
// answered-set guards against a lagging fold resurrecting a resolved prompt, so
// no store callback is required.

function PermissionSlot({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  return <PermissionDialog workspaceId={workspaceId} session={session} />;
}

// ── Session controls + turn footer (A4) ──────────────────────────────────────
//
// Model / permission-mode switches + interrupt (AgentControls) above the rich
// cost/token/duration/error turn footer (TurnFooter).

function SessionControls({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  // Persisted per-workspace SDK settings source the dropdowns so a choice made
  // before the session starts sticks (reflected back via workspace:update).
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  return (
    <>
      <AgentControls
        workspaceId={workspaceId}
        session={session}
        wsModel={ws?.model}
        wsPermissionMode={ws?.sdkPermissionMode}
      />
      <TurnFooter session={session} />
    </>
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
