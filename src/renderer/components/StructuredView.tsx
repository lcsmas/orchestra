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
 *     bubbles, collapsible tool cards, and diff summaries.
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
import { WorkspaceAccountBadge } from './AccountBadge';
import type { AgentImage, AgentSession, AgentSkillInfo, RenderMessage } from '../../shared/types';
// A3: real presentational components (markdown bubbles, tool cards, diffs,
// thinking spinner). AgentMessage routes tool→ToolCard else→MessageBubble and
// owns the `av-message`/`av-tool-card` wrappers + thinking indicator, so it
// fully replaces the placeholder MessageSlot/ToolSlot bodies below.
// A4: interaction surfaces mounted into the slots below (permission dialog,
// AskUserQuestion UI, model/permission-mode controls, rich turn footer).
import {
  AgentMessage,
  ToolGroup,
  PermissionDialog,
  AgentControls,
  RemoteControl,
  TurnFooter,
  BackgroundTasksPanel,
  runningTaskCount,
  totalTaskCount,
} from './agent';

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
  const injectEvent = useStore((s) => s.__injectAgentEvent);

  // The "Background tasks" slide-over. Stays closed by default when a task
  // spins up — a background task should not steal the transcript view; its
  // presence is surfaced by the toolbar toggle + running-count badge instead,
  // and the user opens the panel on demand. `panelOpen` is fully user-owned.
  const [panelOpen, setPanelOpen] = useState(false);
  const runningTasks = runningTaskCount(session);
  const totalTasks = totalTaskCount(session);

  // History backfill: a workspace with any prior session on disk opens with
  // the transcript rendered, not a blank pane. Main resolves the file (the
  // persisted SDK session, else the newest transcript — terminal-born sessions
  // have no sdkSessionId) and converts it to AgentEvents (agent-sdk.ts
  // sdkHistory); they fold through the same RAF queue as live events.
  // Requested at most once per mount, only while the folded session is empty —
  // and unconditionally on `canResume` (main returns [] when there is nothing).
  const historyRequested = useRef(false);
  const hasMessages = (session?.messages.length ?? 0) > 0;
  useEffect(() => {
    if (historyRequested.current || hasMessages) return;
    historyRequested.current = true;
    void window.orchestra
      .agentSdkHistory(workspaceId)
      .then((events) => {
        // Re-check: if live events landed while we read the file, skip the
        // backfill rather than appending stale history after fresh messages.
        const live = useStore.getState().agentSessions[workspaceId];
        if ((live?.messages.length ?? 0) > 0) return;
        for (const ev of events) injectEvent(workspaceId, ev);
      })
      .catch(() => {});
  }, [hasMessages, workspaceId, injectEvent]);

  return (
    <div className={`av-view ${isActive ? 'active' : ''}`} data-workspace={workspaceId}>
      {/* Toolbar toggle for the Background tasks panel — only shown once the
          session has spawned at least one task. Mirrors Claude Desktop's panel
          affordance; the running count rides as a badge. */}
      {totalTasks > 0 && (
        <button
          type="button"
          className={`av-bgtask-toggle ${panelOpen ? 'av-bgtask-toggle-open' : ''}`}
          onClick={() => setPanelOpen((v) => !v)}
          aria-pressed={panelOpen}
          aria-label="Background tasks"
          title="Background tasks"
        >
          <BgTaskIcon />
          {runningTasks > 0 && <span className="av-bgtask-toggle-badge">{runningTasks}</span>}
        </button>
      )}
      <MessageList session={session} canResume={canResume} />
      {/* A4 extension point: permission dialog(s) for parked canUseTool calls.
          Rendered as an overlay above the list. */}
      <PermissionSlot session={session} workspaceId={workspaceId} />
      {/* A4 extension point: cost/token/duration turn footer + model/mode
          controls. Given the last turn-end and running state. */}
      <SessionControls session={session} workspaceId={workspaceId} />
      <Composer session={session} workspaceId={workspaceId} isActive={isActive} />
      {/* The Background tasks slide-over, over the transcript. */}
      {panelOpen && (
        <BackgroundTasksPanel session={session} onClose={() => setPanelOpen(false)} />
      )}
    </div>
  );
}

/** The Background-tasks toggle glyph — a small stacked-layers mark reading as
 *  "parallel tasks". Inherits color via currentColor. */
function BgTaskIcon() {
  return (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none" aria-hidden="true">
      <rect x="2.5" y="2.5" width="7.5" height="7.5" rx="1.5" stroke="currentColor" strokeWidth="1.4" />
      <path
        d="M6 12.2v.3A1.5 1.5 0 0 0 7.5 14h5A1.5 1.5 0 0 0 14 12.5v-5A1.5 1.5 0 0 0 12.2 6"
        stroke="currentColor"
        strokeWidth="1.4"
        strokeLinecap="round"
      />
    </svg>
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
  // The sized inner wrapper. A ResizeObserver on it drives follow-mode scrolling
  // directly off REAL content-height changes (streaming typewriter growth, async
  // row re-measures) instead of routing through the coalesced `measureTick` RAF —
  // that indirection lagged the follow scroll ≥1 frame behind the content and
  // dropped intermediate growths, so the viewport fell progressively further
  // behind fast streaming output. See `pinToBottom` / the observer below.
  const innerRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  // Measured row heights, keyed by message id — falls back to the estimate for
  // rows not yet measured. A ref (not state) so measuring doesn't re-render;
  // we bump `measureTick` to recompute the window after a batch of measures.
  const heights = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  // Stick to bottom while the user hasn't scrolled up — streaming output should
  // keep the latest message in view, like a terminal.
  const stickBottom = useRef(true);
  // Last scrollTop we observed, to tell a USER scroll-up apart from a programmatic
  // pin or a content-growth reflow. Key insight: a user scrolling up is the ONLY
  // thing that DECREASES scrollTop. `pinToBottom` only ever increases it (toward
  // the bottom), and a row growing taller during streaming pushes the bottom
  // further down without moving scrollTop up. So follow-mode releases iff
  // scrollTop dropped meaningfully below the previous value — a comparison immune
  // to the pin-vs-growth race that a naive `atBottom` threshold got wrong (it read
  // the few px a row grew between the pin's write and the event as "user scrolled
  // up" and disengaged follow mid-stream — the gradual-streaming e2e divergence).
  const lastScrollTop = useRef(0);
  // Initial-open pin: force the view to the LAST message when content first
  // appears, and keep forcing it while row heights are still settling (they
  // refine asynchronously over several RAF-batched measure passes, growing
  // scrollHeight after each programmatic scroll). Without this the async height
  // refinement leaves the transcript stranded mid-list on open, and a programmatic
  // scroll firing onScroll mid-settle can even flip stickBottom off. Cleared once
  // the user scrolls, or once the layout has settled at the bottom.
  const initialPin = useRef(true);

  const messages = session?.messages ?? [];

  // Scroll the viewport to the bottom IMMEDIATELY (no smooth easing). Follow-mode
  // must snap to the true bottom every time content grows: CSS `scroll-behavior:
  // smooth` animates a programmatic `scrollTop = scrollHeight` over ~hundreds of
  // ms, and because streaming grows the content every frame the animation forever
  // chases a moving target and never lands — the accumulating lag the user saw.
  // `scrollTo({ behavior: 'instant' })` forces a jump regardless of the CSS
  // `scroll-behavior: smooth` (a bare `scrollTop =` assignment, and `behavior:
  // 'auto'`, both DEFER to the stylesheet's smooth value — only 'instant' overrides).
  const pinToBottom = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    el.scrollTo({ top: el.scrollHeight, behavior: 'instant' as ScrollBehavior });
    // Remember where we left it so the next onScroll can tell "content grew / we
    // pinned" (scrollTop unchanged or up) from "user dragged up" (scrollTop down).
    lastScrollTop.current = el.scrollTop;
  }, []);

  const onScroll = useCallback(() => {
    const el = scrollRef.current;
    if (!el) return;
    const prev = lastScrollTop.current;
    const cur = el.scrollTop;
    lastScrollTop.current = cur;
    // A meaningful DECREASE in scrollTop is the unmistakable signature of a user
    // scroll-up — neither a pin nor content growth ever moves it up. Release
    // follow so the user can read earlier output without being yanked back.
    if (cur < prev - 2) {
      stickBottom.current = false;
      initialPin.current = false;
    } else if (el.scrollHeight - cur - el.clientHeight < 24) {
      // At (or scrolled back to) the bottom — re-engage follow.
      stickBottom.current = true;
    }
    setViewport({ scrollTop: cur, height: el.clientHeight });
  }, []);

  // Follow-mode: whenever the REAL rendered content resizes (typewriter reveal,
  // async row re-measure, a new row mounting), snap to the bottom synchronously if
  // the user is stuck to the bottom (or the initial pin is still active). Observing
  // the sized inner wrapper reacts to the actual DOM height — this is the direct,
  // per-resize path that replaces the laggy `measureTick`-gated scroll for the
  // steady-streaming case. It runs in the ResizeObserver callback (a frame after
  // layout), so `scrollHeight` already reflects the new content.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    if (!inner) return;
    const ro = new ResizeObserver(() => {
      if (stickBottom.current || initialPin.current) pinToBottom();
    });
    ro.observe(inner);
    return () => ro.disconnect();
    // Re-attach when the inner element is (re)created — it only exists once there
    // are messages (the empty state renders a different subtree).
  }, [pinToBottom, messages.length > 0]);

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

  // Auto-scroll to bottom when a new message lands and we're stuck to bottom, or
  // while the initial-open pin is active (open at the LAST message — task: the
  // structured view should open scrolled to the latest message). The pin keeps
  // firing across the async measure passes; it releases once we're genuinely at
  // the bottom AND the layout has stopped growing (scrollHeight stable), or when
  // the user scrolls up (handled in onScroll).
  const lastScrollHeight = useRef(0);
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (initialPin.current) {
      pinToBottom();
      // Release the pin once the layout has settled: we're at the bottom and the
      // total height didn't change since the previous measure pass.
      const settled =
        el.scrollHeight === lastScrollHeight.current &&
        el.scrollHeight - el.scrollTop - el.clientHeight < 2;
      lastScrollHeight.current = el.scrollHeight;
      if (settled && messages.length > 0) initialPin.current = false;
      return;
    }
    if (stickBottom.current) pinToBottom();
  }, [messages.length, measureTick, pinToBottom]);

  // Fold the flat message list into RENDER ITEMS: a run of consecutive `tool`
  // messages collapses into ONE `tool-group` item (rendered by ToolGroup, which
  // shows a "2 Read · 1 Bash" summary and expands to the individual cards). Every
  // other message is its own item. Virtualization then windows over ITEMS, so a
  // whole collapsed tool run is a single measured row — heights stay a pure
  // function of item content. The group's id is stable (its first tool's id) so
  // its expand/collapse state and height cache survive re-renders and scrolling.
  const items = buildRenderItems(messages);

  // Compute cumulative offsets from cached/estimated heights, then the visible
  // window [start, end). O(n) per layout — n is item count; only the sliced rows
  // actually mount as DOM.
  const itemH = (it: RenderItem) => heights.current.get(it.id) ?? ESTIMATED_ROW_H;
  const offsets: number[] = new Array(items.length + 1);
  offsets[0] = 0;
  for (let i = 0; i < items.length; i++) offsets[i + 1] = offsets[i] + itemH(items[i]);
  const totalHeight = offsets[items.length] ?? 0;

  const top = viewport.scrollTop;
  const bottom = top + (viewport.height || 1);
  let start = 0;
  while (start < items.length && offsets[start + 1] < top) start++;
  let end = start;
  while (end < items.length && offsets[end] < bottom) end++;
  start = Math.max(0, start - OVERSCAN);
  end = Math.min(items.length, end + OVERSCAN);

  const visible = items.slice(start, end);
  const padTop = offsets[start] ?? 0;

  return (
    <div ref={scrollRef} className="av-message-list" onScroll={onScroll}>
      {messages.length === 0 ? (
        <div className="av-empty">
          <div className="av-empty-mark" aria-hidden="true">
            <svg
              width="20"
              height="20"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="1.5"
              strokeLinecap="round"
              strokeLinejoin="round"
            >
              <path d="M3 5.5 6 8l-3 2.5" />
              <path d="M8.5 11H13" />
            </svg>
          </div>
          <div className="av-empty-title">
            {session
              ? 'Session ready'
              : canResume
                ? 'Resume your session'
                : 'Start a structured session'}
          </div>
          <div className="av-empty-desc">
            {!session && canResume
              ? 'Previous session found — your next message resumes it. The agent keeps its memory; earlier messages aren’t re-shown here.'
              : 'Send a message to start the agent — replies, tool activity and diffs render natively here.'}
          </div>
          <div className="av-empty-hint">
            <kbd>Enter</kbd> to send · <kbd>Shift</kbd>+<kbd>Enter</kbd> for a new line
          </div>
        </div>
      ) : (
        <div className="av-message-list-inner" style={{ height: totalHeight, position: 'relative' }}>
          {/* Observe THIS wrapper (the actually-mounted rows) for follow-mode
              resize, not the sized parent: its height reflects real streaming
              growth the instant the typewriter reveals more text, whereas the
              parent's explicit `totalHeight` only refreshes after the coalesced
              `measureTick` recompute. The overflowing content still extends the
              scroll container's `scrollHeight`, so pinToBottom reaches the true
              bottom immediately. */}
          <div ref={innerRef} style={{ transform: `translateY(${padTop}px)` }}>
            {visible.map((it, i) => (
              <MeasuredRow
                key={it.id}
                item={it}
                onHeight={(h) => {
                  const known = heights.current.get(it.id);
                  if (known === h) return;
                  heights.current.set(it.id, h);
                  if (known === undefined) {
                    // FIRST measure of a newly-mounted row: recompute the
                    // window synchronously (we're inside a layout effect, so
                    // this re-renders BEFORE paint). Until measured, offsets
                    // use ESTIMATED_ROW_H (72px) — letting that paint makes
                    // the pinned viewport overshoot by the estimate error and
                    // correct itself a frame later, a per-new-row vertical
                    // bounce that reads as flicker exactly when a tool row or
                    // message lands. React batches these across rows, so N
                    // new rows in one commit still cost one extra render.
                    setMeasureTick((t) => t + 1);
                  } else {
                    // RESIZE of an already-measured row (typewriter growth,
                    // image load): coalesce to the next frame — the follow
                    // pin tracks real growth via the ResizeObserver, so the
                    // window recompute is not paint-critical here.
                    scheduleMeasureFlush(() => setMeasureTick((t) => t + 1));
                  }
                }}
                // Index in the full item list, for debugging/keys downstream.
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
  item,
  onHeight,
  dataIndex,
}: {
  item: RenderItem;
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
      <ItemSlot item={item} />
    </div>
  );
}

// ── Render-item model ────────────────────────────────────────────────────────
//
// The transcript is a flat RenderMessage[]; we present it as RenderItem[] where a
// run of consecutive `tool` messages becomes ONE `tool-group` item (collapsed by
// default). A group's id is its first tool message's id — stable across renders,
// so its measured height and expand state survive scrolling.

type RenderItem =
  | { kind: 'message'; id: string; message: RenderMessage }
  | { kind: 'tool-group'; id: string; tools: RenderMessage[] };

/** Tools that must NOT be folded into a collapsed group — they own a first-class,
 *  always-visible surface. TodoWrite is the live task list (Claude-Code shows it
 *  expanded, never buried); it renders as its own always-open ToolCard. */
function isStandaloneTool(m: RenderMessage): boolean {
  return m.role === 'tool' && m.toolUse?.name === 'TodoWrite';
}

function buildRenderItems(messages: RenderMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: RenderMessage[] | null = null;
  const flush = () => {
    if (run && run.length > 0) {
      items.push({ kind: 'tool-group', id: `tg:${run[0].id}`, tools: run });
    }
    run = null;
  };
  for (const m of messages) {
    if (m.role === 'tool' && !isStandaloneTool(m)) {
      (run ??= []).push(m);
    } else {
      // A standalone tool (TodoWrite) and any non-tool message both break the
      // current run and render as their own item.
      flush();
      items.push({ kind: 'message', id: m.id, message: m });
    }
  }
  flush();
  return items;
}

// ── Item renderer (A3) ───────────────────────────────────────────────────────
//
// A `message` item routes through <AgentMessage> (markdown bubble / thinking /
// lone tool card). A `tool-group` item routes through <ToolGroup>, which shows
// the collapsed "2 Read · 1 Bash" summary and expands to individual ToolCards.

function ItemSlot({ item }: { item: RenderItem }) {
  if (item.kind === 'tool-group') return <ToolGroup tools={item.tools} />;
  return <AgentMessage message={item.message} />;
}

// ── Permission slot (A4) ─────────────────────────────────────────────────────
//
// The native approve/deny dialog + AskUserQuestion UI. Reads
// `session.pendingPermissions`, shows the oldest first (one at a time), and
// answers via `agentSdkPermissionReply(wsId, requestId, reply)`. On reply we
// ALSO clear the request from the folded store session (`resolveAgentPermission`)
// — main resolves the parked call but emits no clearing event, so without this
// the answered request lingers in `pendingPermissions` until the turn ends and
// reappears as a stale modal when the view is left and re-entered (the dialog's
// local answered-set resets on unmount, but the store survives).

function PermissionSlot({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  const resolveAgentPermission = useStore((s) => s.resolveAgentPermission);
  return (
    <PermissionDialog
      workspaceId={workspaceId}
      session={session}
      onReplied={(requestId) => resolveAgentPermission(workspaceId, requestId)}
    />
  );
}

// ── Session controls + turn footer (A4) ──────────────────────────────────────
//
// One horizontal deck bar sharing a single y-axis: interrupt (left) + the rich
// cost/token/duration/error turn footer (TurnFooter, middle) + the account badge
// and model / permission-mode switches (AgentControls, right). Previously these
// stacked as two rows; collapsing them reclaims a row of vertical space at the
// bottom.
//
// The account badge answers "which login is this agent spending?" right where
// the cost/token figures are read — the SDK session's CLAUDE_CONFIG_DIR comes
// from exactly this pin (agent-sdk.ts buildSdkEnv). It's the same migratable
// control as the sidebar's, so clicking it moves the workspace to another
// account (auto-stops the session; the next send restarts it under the new
// login).

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
    <div className="av-deck-bar">
      <AgentControls
        workspaceId={workspaceId}
        session={session}
        wsModel={ws?.model}
        wsPermissionMode={ws?.sdkPermissionMode}
        wsEffort={ws?.sdkEffort}
      />
      <RemoteControl workspaceId={workspaceId} session={session} />
      <TurnFooter session={session} />
      <span className="av-deck-account" title="Account this agent runs as — click to migrate">
        <WorkspaceAccountBadge workspaceId={workspaceId} migratable />
      </span>
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

/** The input is exactly a slash-command prefix ("/", "/shi") — the only state
 *  in which the skills autocomplete shows. */
const SLASH_PREFIX = /^\/([A-Za-z0-9_-]*)$/;

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
  // Images pasted into the composer, pending send. Each carries the base64 for
  // the wire plus a data URL for the thumbnail preview.
  const [pendingImages, setPendingImages] = useState<
    { id: string; mediaType: string; dataBase64: string; url: string }[]
  >([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  const running = !!session?.running;

  // Bash mode (parity with Claude Code's `!command`): a leading `!` switches the
  // composer into bash mode — the command runs LOCALLY in the worktree and its
  // output is fed to the agent as context, instead of the text being sent to the
  // model. The `!` is the mode trigger; the command is everything after it.
  // Deleting back to empty exits the mode (the chip/placeholder update live).
  const bashMode = text.startsWith('!');
  const bashCommand = bashMode ? text.slice(1) : '';

  // Accept image data from a clipboard/paste event: read each image item as a
  // data URL, split off the base64 payload, and stash it for send + preview.
  const addPastedImages = useCallback((items: DataTransferItemList | null) => {
    if (!items) return false;
    const files: File[] = [];
    for (const it of Array.from(items)) {
      if (it.kind === 'file' && it.type.startsWith('image/')) {
        const f = it.getAsFile();
        if (f) files.push(f);
      }
    }
    if (files.length === 0) return false;
    for (const [i, f] of files.entries()) {
      const reader = new FileReader();
      reader.onload = () => {
        const url = typeof reader.result === 'string' ? reader.result : '';
        // data:<mediaType>;base64,<data>
        const m = /^data:([^;]+);base64,(.*)$/.exec(url);
        if (!m) return;
        setPendingImages((prev) => [
          ...prev,
          {
            // A stable-ish id from load time + index + size (no Date.now in a
            // render path is fine here — this is an event handler).
            id: `img:${f.size}:${i}:${prev.length}`,
            mediaType: m[1],
            dataBase64: m[2],
            url,
          },
        ]);
      };
      reader.readAsDataURL(f);
    }
    return true;
  }, []);

  const removePendingImage = (id: string) =>
    setPendingImages((prev) => prev.filter((p) => p.id !== id));

  // Auto-grow: the textarea height tracks its content up to the CSS max-height
  // (then it scrolls). Reset to `auto` first so it can SHRINK when lines are
  // removed, not just grow — measuring scrollHeight off a stale taller box would
  // ratchet the height up permanently. Runs on every text change (incl. skill
  // completion / programmatic setText, not just keystrokes) via the effect below.
  const autosize = useCallback(() => {
    const el = taRef.current;
    if (!el) return;
    el.style.height = 'auto';
    el.style.height = `${el.scrollHeight}px`;
  }, []);
  useLayoutEffect(autosize, [text, autosize]);

  // Skills autocomplete: loaded lazily on the first "/" (cheap dir scan in
  // main), cached per mount. `acIndex` is the highlighted row.
  const [skills, setSkills] = useState<AgentSkillInfo[] | null>(null);
  const skillsRequested = useRef(false);
  const [acIndex, setAcIndex] = useState(0);
  // Escape dismisses the popover until the slash-prefix changes again.
  const [acDismissed, setAcDismissed] = useState(false);

  const slash = SLASH_PREFIX.exec(text);
  const acQuery = slash?.[1]?.toLowerCase() ?? null;
  const acItems =
    acQuery !== null && !acDismissed && skills
      ? skills
          .filter((s) => s.name.toLowerCase().includes(acQuery))
          .sort((a, b) => {
            const ap = a.name.toLowerCase().startsWith(acQuery) ? 0 : 1;
            const bp = b.name.toLowerCase().startsWith(acQuery) ? 0 : 1;
            return ap - bp || a.name.localeCompare(b.name);
          })
          .slice(0, 8)
      : [];
  const acOpen = acQuery !== null && acItems.length > 0;

  useEffect(() => {
    if (acQuery === null || skillsRequested.current) return;
    skillsRequested.current = true;
    void window.orchestra
      .agentSkills(workspaceId)
      .then(setSkills)
      .catch(() => setSkills([]));
  }, [acQuery, workspaceId]);

  // Clamp the highlight when the filtered list shrinks.
  useEffect(() => {
    if (acIndex >= acItems.length) setAcIndex(0);
  }, [acItems.length, acIndex]);

  // Focus the composer when this tab becomes active, so the user can type
  // immediately after switching to the structured view.
  useEffect(() => {
    if (isActive) taRef.current?.focus();
  }, [isActive]);

  const submit = useCallback(() => {
    // Bash mode: run the command locally instead of sending a turn to the model.
    // The `!` prefix is the mode trigger; strip it. Empty command → no-op.
    if (text.startsWith('!')) {
      const cmd = text.slice(1).trim();
      if (!cmd) return;
      void window.orchestra
        .agentSdkRunBash(workspaceId, cmd)
        .catch((e) => console.error('agentSdkRunBash failed', e));
      setText('');
      return;
    }
    const t = text.trim();
    // Allow send when there's text OR at least one pasted image (an image with
    // no caption is a valid turn).
    if (!t && pendingImages.length === 0) return;
    const images: AgentImage[] | undefined =
      pendingImages.length > 0
        ? pendingImages.map(({ mediaType, dataBase64 }) => ({ mediaType, dataBase64 }))
        : undefined;
    // First submit lazily starts the SDK session (no separate start IPC).
    // Main emits an `error` agent event on failure (rendered in the list), so we
    // don't need to surface it here — but log rather than silently swallow, so a
    // failure is never invisible in devtools either.
    void window.orchestra
      .agentSdkSend(workspaceId, t, images)
      .catch((e) => console.error('agentSdkSend failed', e));
    setText('');
    setPendingImages([]);
  }, [text, pendingImages, workspaceId]);

  const completeSkill = (name: string) => {
    setText(`/${name} `);
    taRef.current?.focus();
  };

  return (
    <div className="av-composer">
      <div className={`av-composer-field ${bashMode ? 'av-composer-field-bash' : ''}`}>
        {acOpen && (
          <div className="av-ac" role="listbox" aria-label="Skills">
            {acItems.map((s, idx) => (
              <button
                key={s.name}
                type="button"
                role="option"
                aria-selected={idx === acIndex}
                className={`av-ac-item ${idx === acIndex ? 'av-ac-item-active' : ''}`}
                onMouseEnter={() => setAcIndex(idx)}
                // mousedown (not click) so the textarea never loses focus.
                onMouseDown={(e) => {
                  e.preventDefault();
                  completeSkill(s.name);
                }}
              >
                <span className="av-ac-name">/{s.name}</span>
                {s.description && <span className="av-ac-desc">{s.description}</span>}
                <span className={`av-ac-source av-ac-source-${s.source}`}>{s.source}</span>
              </button>
            ))}
            <div className="av-ac-hint">
              <kbd>↑</kbd>
              <kbd>↓</kbd> navigate · <kbd>Tab</kbd> complete · <kbd>Esc</kbd> dismiss
            </div>
          </div>
        )}
        <div className="av-composer-stack">
          {bashMode && (
            <span className="av-composer-bash-chip" aria-hidden="true">
              bash
            </span>
          )}
          {pendingImages.length > 0 && (
            <div className="av-composer-attachments" aria-label="Pasted images">
              {pendingImages.map((img) => (
                <div key={img.id} className="av-composer-attachment">
                  <img src={img.url} alt="Pasted attachment" />
                  <button
                    type="button"
                    className="av-composer-attachment-remove"
                    aria-label="Remove image"
                    title="Remove"
                    onClick={() => removePendingImage(img.id)}
                  >
                    ×
                  </button>
                </div>
              ))}
            </div>
          )}
          <textarea
            ref={taRef}
            className="av-composer-input"
            value={text}
          placeholder={
            bashMode
              ? 'Enter a shell command — runs in the worktree, output shared with the agent'
              : 'Message the agent — / for skills, ! for bash, paste an image…'
          }
          rows={1}
          onPaste={(e) => {
            // If the clipboard carries image data, capture it and stop it from
            // also inserting a filename/text into the textarea.
            if (addPastedImages(e.clipboardData?.items ?? null)) {
              e.preventDefault();
            }
          }}
          onChange={(e) => {
            setText(e.target.value);
            setAcDismissed(false);
          }}
          onKeyDown={(e) => {
            if (acOpen) {
              if (e.key === 'ArrowDown') {
                e.preventDefault();
                setAcIndex((i) => (i + 1) % acItems.length);
                return;
              }
              if (e.key === 'ArrowUp') {
                e.preventDefault();
                setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
                return;
              }
              if (e.key === 'Tab' || (e.key === 'Enter' && !e.shiftKey)) {
                e.preventDefault();
                const it = acItems[acIndex];
                if (it) completeSkill(it.name);
                return;
              }
              if (e.key === 'Escape') {
                e.preventDefault();
                setAcDismissed(true);
                return;
              }
            }
            // Enter submits; Shift+Enter inserts a newline (chat convention).
            if (e.key === 'Enter' && !e.shiftKey) {
              e.preventDefault();
              submit();
            }
          }}
          />
        </div>
        <button
          className="av-composer-send"
          onClick={submit}
          disabled={bashMode ? !bashCommand.trim() : !text.trim() && pendingImages.length === 0}
          title={
            bashMode
              ? 'Run the shell command locally (Enter)'
              : running
                ? 'Agent is working — message will queue'
                : 'Send (Enter)'
          }
        >
          {bashMode ? (
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M4 4l4 4-4 4" />
              <path d="M9 12h4" />
            </svg>
          ) : (
            <svg
              width="13"
              height="13"
              viewBox="0 0 16 16"
              fill="none"
              stroke="currentColor"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
              aria-hidden="true"
            >
              <path d="M8 13V3" />
              <path d="M3.5 7.5 8 3l4.5 4.5" />
            </svg>
          )}
          <span className="av-composer-send-label">
            {bashMode ? 'Run' : running ? 'Queue' : 'Send'}
          </span>
        </button>
      </div>
    </div>
  );
}
