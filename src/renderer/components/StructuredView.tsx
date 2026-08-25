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

import { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { useStore } from '../store';
import { isPeerMessage } from '../../shared/peer-messages';
import { scoped } from '../log';
import { WorkspaceAccountBadge } from './AccountBadge';
import { CmComposer, type CmComposerHandle } from './agent/CmComposer';
import { QueueTray } from './agent/QueueTray';
import { useVoiceDictation } from './agent/useVoiceDictation';
import { McpPopover, McpIndicator } from './agent/McpPopover';
import { readComposerVim, writeComposerVim, vimChipLabel, type VimMode } from '../composer-vim-pref';
import {
  readVoiceHotkey,
  writeVoiceHotkey,
  matchesVoiceHotkey,
  voiceHotkeyLabel,
  hotkeyFromEvent,
  type VoiceHotkey,
} from '../voice-hotkey-pref';
import {
  isScratchLike,
  type AgentImage,
  type AgentSession,
  type AgentSkillInfo,
  type RenderMessage,
} from '../../shared/types';
import { computeTurnDivider, type TurnDivider } from '../../shared/message-time';
// Design mode: the browser pane's element picker drops picks in the store; the
// composer drains them into its draft + attachments (see the Composer's
// design-pick effect). appendPickToDraft is the pure formatter (shared/, tested).
import { appendPickToDraft } from '../../shared/design-mode';
import { shouldRequestHistory } from '../history-backfill';
import { resolveAnchorIndex } from '../scroll-anchor';
// A3: real presentational components (markdown bubbles, tool cards, diffs,
// thinking spinner). AgentMessage routes tool→ToolCard else→MessageBubble and
// owns the `av-message`/`av-tool-card` wrappers + thinking indicator, so it
// fully replaces the placeholder MessageSlot/ToolSlot bodies below.
// A4: interaction surfaces mounted into the slots below (permission dialog,
// AskUserQuestion UI, model/permission-mode controls, rich turn footer).
import {
  AgentMessage,
  ToolGroup,
  PeerMessageGroup,
  PermissionDialog,
  AgentControls,
  RemoteControl,
  StripStats,
  WorkingIndicator,
  BackgroundTasksPanel,
  runningTaskCount,
  totalTaskCount,
} from './agent';
import { MemorySizeBanner } from './agent/MemorySizeBanner';
import { RewindContext } from './agent/rewind-context';
import { previousRewindId, rewindPrefillText } from './agent/rewind-util';

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

const log = scoped('structured-view');

// How many synchronous measure→render passes may chain within a single frame
// before the row-measure path degrades to the coalesced (rAF) one. React throws
// error #185 at ~50 nested updates and the app black-screens, so this must stay
// comfortably below that. Normal streaming settles in a handful of passes (each
// pass measures every mounted row, so one commit of N new rows is ONE pass).
const MAX_SYNC_MEASURE_PASSES = 12;

export function StructuredView({ workspaceId, isActive }: Props) {
  const session = useStore((s) => s.agentSessions[workspaceId]);
  // A prior SDK session on disk means the next message RESUMES it (the agent
  // keeps its memory), even though the message list starts empty this render.
  const canResume = useStore(
    (s) => !!s.workspaces.find((w) => w.id === workspaceId)?.sdkSessionId,
  );
  const injectEvent = useStore((s) => s.__injectAgentEvent);
  const applyHistory = useStore((s) => s.applyAgentHistory);

  // The "Background tasks" slide-over. Stays closed by default when a task
  // spins up — a background task should not steal the transcript view; its
  // presence is surfaced by the toolbar toggle + running-count badge instead,
  // and the user opens the panel on demand. `panelOpen` is fully user-owned.
  const [panelOpen, setPanelOpen] = useState(false);
  // The /mcp manager popover. Owned HERE (not in Composer) because two
  // surfaces open it: submitting `/mcp` in the composer, and clicking the
  // amber/red MCP health chip in the session-controls bar.
  const [mcpOpen, setMcpOpen] = useState(false);
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
  // Keyed on whether THIS SESSION was backfilled — not on whether it has any
  // messages. App.tsx unmounts panes past MAX_MOUNTED_PANES while the
  // `agent:event` subscription keeps folding for unmounted workspaces, so a
  // reopened workspace can hold a few messages from a background turn with its
  // real transcript still only on disk. The old `messages.length > 0` gate read
  // those as "history already present" and rendered them as the entire
  // conversation — the reported disappearing transcript.
  // ── Rewind ────────────────────────────────────────────────────────────────
  // Undo a previous user turn (Claude Code's double-Esc restore, as a
  // per-message action). Two ids are involved and they are NOT the same:
  // `rewindId` is the message being undone (the file-restore target), while the
  // SESSION is truncated at its PREDECESSOR, because `resumeSessionAt` keeps the
  // message it targets — see docs/spikes/rewind-sdk-findings.md. Deriving the
  // predecessor here (from the rendered transcript) keeps that ordering rule in
  // one place instead of duplicating it in main.
  const composerRef = useRef<{ prefill: (text: string) => void } | null>(null);
  const rewindBusy = !!session?.running;

  const onRewindPreview = useCallback(
    (rewindId: string) => window.orchestra.agentSdkRewindPreview(workspaceId, rewindId),
    [workspaceId],
  );

  const onRewindConfirm = useCallback(
    async (rewindId: string) => {
      const msgs = session?.messages ?? [];
      // Edit-and-retry: the undone message's text returns to the composer. Read
      // it BEFORE the rewind, since the fold is about to drop the row.
      const text = rewindPrefillText(msgs, rewindId);
      // Cut the SESSION at the predecessor — resumeSessionAt keeps the message
      // it targets, so targeting `rewindId` itself would leave the very turn we
      // are undoing in place (rewind-util.ts documents the rule; it is tested).
      const prev = previousRewindId(msgs, rewindId);
      try {
        const res = await window.orchestra.agentSdkRewind(workspaceId, rewindId, prev);
        if (text) composerRef.current?.prefill(text);
        // A partial rewind must never read as a complete one: if the files
        // could not be restored (a session predating checkpointing), say so in
        // the transcript rather than letting the truncation imply a full undo.
        if (res.filesError) {
          injectEvent(workspaceId, {
            type: 'notice',
            kind: 'info',
            text: `Conversation rewound. Files were left unchanged — ${res.filesError}`,
            seq: 0,
            at: Date.now(),
          });
        }
      } catch (e) {
        injectEvent(workspaceId, {
          type: 'notice',
          kind: 'warning',
          text: `Rewind failed: ${e instanceof Error ? e.message : String(e)}`,
          seq: 0,
          at: Date.now(),
        });
      }
    },
    [workspaceId, session, injectEvent],
  );

  const rewindApi = useMemo(
    () => ({ onPreview: onRewindPreview, onConfirm: onRewindConfirm, busy: rewindBusy }),
    [onRewindPreview, onRewindConfirm, rewindBusy],
  );

  const alreadyBackfilled = session?.historyBackfilled === true;
  useEffect(() => {
    if (
      !shouldRequestHistory({
        requestedThisMount: historyRequested.current,
        alreadyBackfilled,
        messageCount: 0, // deliberately not consulted; see history-backfill.ts
        cleared: false, // main returns [] for a cleared session
      })
    )
      return;
    historyRequested.current = true;
    void window.orchestra
      .agentSdkHistory(workspaceId)
      .then((events) => {
        if (events.length === 0) return;
        // Prepend (deduped) rather than skip: history is older than anything
        // folded live, so a session that gained messages while unmounted must
        // still get its earlier transcript back.
        applyHistory(workspaceId, events);
      })
      .catch(() => {
        // A failed backfill used to be a silently blank transcript — say so
        // (the conversation still resumes fine; only the display is missing).
        injectEvent(workspaceId, {
          type: 'notice',
          kind: 'warning',
          text: "Couldn't load the conversation history — the session will still resume.",
          seq: 0,
          at: Date.now(),
        });
      });
  }, [alreadyBackfilled, workspaceId, injectEvent, applyHistory]);

  return (
    <RewindContext.Provider value={rewindApi}>
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
      {/* Pinned above the scroller: an oversized CLAUDE.md is a standing
          condition of the environment, not a moment in the conversation. */}
      {session?.oversizedMemory?.length ? (
        <MemorySizeBanner files={session.oversizedMemory} />
      ) : null}
      <MessageList session={session} canResume={canResume} />
      {/* A4 extension point: permission dialog(s) for parked canUseTool calls.
          Rendered as an overlay above the list. */}
      <PermissionSlot session={session} workspaceId={workspaceId} />
      {/* The model/mode controls and the ambient cost/context/branch readout are
          passed INTO the composer: they render as the card's bottom row and the
          caption strip beneath it, so the whole send surface is one frame. */}
      <Composer
        session={session}
        workspaceId={workspaceId}
        isActive={isActive}
        handleRef={composerRef}
        mcpOpen={mcpOpen}
        setMcpOpen={setMcpOpen}
        bar={
          <SessionControls
            session={session}
            workspaceId={workspaceId}
            onOpenMcp={() => setMcpOpen(true)}
          />
        }
        strip={<ContextStrip session={session} workspaceId={workspaceId} />}
      />
      {/* The Background tasks slide-over, over the transcript. */}
      {panelOpen && (
        <BackgroundTasksPanel
          session={session}
          workspaceId={workspaceId}
          onClose={() => setPanelOpen(false)}
        />
      )}
    </div>
    </RewindContext.Provider>
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
  // The sized wrapper carrying the virtualization's explicit `totalHeight`. Also
  // observed for follow-mode: it is the growth path for content OUTSIDE the mounted
  // window, which `innerRef` structurally cannot see (see the ResizeObserver below).
  const sizedRef = useRef<HTMLDivElement>(null);
  const [viewport, setViewport] = useState({ scrollTop: 0, height: 0 });
  // Measured row heights, keyed by message id — falls back to the estimate for
  // rows not yet measured. A ref (not state) so measuring doesn't re-render;
  // we bump `measureTick` to recompute the window after a batch of measures.
  const heights = useRef<Map<string, number>>(new Map());
  const [measureTick, setMeasureTick] = useState(0);
  // Content-space layout of the CURRENT render — item ids + their cumulative
  // offsets, written every render (a ref: reading it never re-renders). The
  // scroll-anchoring effect and onScroll's anchor tracking read it.
  const layoutRef = useRef<{ ids: string[]; offsets: number[] }>({ ids: [], offsets: [0] });
  // Scroll anchor while follow is RELEASED: the item currently under the
  // viewport top plus how far the top sits below that item's offset. When a
  // measure pass replaces a 72px estimate with a real height for a row ABOVE
  // the viewport, every offset below it moves while scrollTop stays put — the
  // content the user is reading visibly jumps under a fixed viewport ("random
  // jumps while scrolling up"). The anchoring effect below compensates by
  // restoring this item to the same viewport position before paint.
  // `index` rides along so the anchor can be resolved POSITIONALLY
  // (resolveAnchorIndex) instead of by `ids.indexOf`, which resolves to the
  // first namesake — see scroll-anchor.ts for the transcript-teleport that came
  // from trusting id uniqueness here.
  const anchorRef = useRef<{ id: string; delta: number; index: number } | null>(null);
  // Guards against the React #185 render loop (see the onHeight handler). Counts
  // synchronous measure→render passes since the last painted frame; a frame
  // boundary resets it, so only an unbroken chain WITHIN one frame can trip it.
  const syncMeasurePasses = useRef(0);
  const measureLoopWarned = useRef(false);
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
  // Mirror of `stickBottom` as RENDER state, purely so the UI can show whether
  // follow-mode is engaged. `stickBottom` stays a ref because the scroll/resize
  // hot paths read and write it every frame and must not trigger re-renders; this
  // flag is updated only on an actual transition (see `setFollowing`), so the
  // indicator re-renders at most once per engage/disengage rather than per event.
  const [following, setFollowingState] = useState(true);
  const setFollowing = useCallback((next: boolean) => {
    if (stickBottom.current === next) return; // no transition — skip the render
    stickBottom.current = next;
    setFollowingState(next);
  }, []);

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
    const distanceFromBottom = el.scrollHeight - cur - el.clientHeight;
    // A meaningful DECREASE in scrollTop is the signature of a user scroll-up —
    // a pin never moves it up, and content GROWING pushes the bottom further away
    // without moving scrollTop. But a decrease alone is NOT sufficient: the browser
    // also CLAMPS scrollTop down to `scrollHeight - clientHeight` whenever the
    // scrollable range shrinks, and that clamp fires an ordinary scroll event
    // indistinguishable from a drag. It happens routinely here — the composer
    // auto-grows/shrinks as the user types or clears a draft (and the attachment
    // strip mounts/unmounts), which changes the LIST's clientHeight; content also
    // shrinks when a tool group collapses or a turn ends. Measured in a real
    // browser: clearing a 200px draft grew clientHeight 300→460 and clamped
    // scrollTop 600→440, which the old bare `cur < prev - 2` test read as a
    // scroll-up and silently disengaged follow mid-stream.
    //
    // The discriminator is WHERE we ended up, not merely that we moved up: a clamp
    // leaves the viewport still parked AT the bottom, whereas a real scroll-up moves
    // away from it. So only release follow when the decrease actually took us off
    // the bottom.
    const AT_BOTTOM_PX = 24;
    if (cur < prev - 2 && distanceFromBottom >= AT_BOTTOM_PX) {
      setFollowing(false);
      initialPin.current = false;
    } else if (distanceFromBottom < AT_BOTTOM_PX) {
      // At (or scrolled back to) the bottom — re-engage follow.
      setFollowing(true);
    }
    setViewport({ scrollTop: cur, height: el.clientHeight });
    // Re-anchor to the item under the viewport top. Every scroll — user drags,
    // clamp corrections, our own anchoring writes — re-derives the anchor from
    // the CURRENT offsets, so it is always consistent with the painted layout.
    const { ids, offsets } = layoutRef.current;
    let lo = 0;
    while (lo < ids.length && offsets[lo + 1] <= cur) lo++;
    anchorRef.current = lo < ids.length ? { id: ids[lo], delta: cur - offsets[lo], index: lo } : null;
  }, [setFollowing]);

  // Re-engage follow from the indicator: jump to the newest output and resume.
  const resumeFollow = useCallback(() => {
    setFollowing(true);
    pinToBottom();
  }, [setFollowing, pinToBottom]);

  // Follow-mode: whenever the REAL rendered content resizes (typewriter reveal,
  // async row re-measure, a new row mounting), snap to the bottom synchronously if
  // the user is stuck to the bottom (or the initial pin is still active). Observing
  // the sized inner wrapper reacts to the actual DOM height — this is the direct,
  // per-resize path that replaces the laggy `measureTick`-gated scroll for the
  // steady-streaming case. It runs in the ResizeObserver callback (a frame after
  // layout), so `scrollHeight` already reflects the new content.
  //
  // We observe BOTH the translated row container (`innerRef`, whose box tracks the
  // mounted rows' real height) AND the sized wrapper (`sizedRef`, whose explicit
  // `totalHeight` carries the estimated height of rows OUTSIDE the window). Watching
  // only the row container silently stalls follow-mode: the scroll container's
  // `scrollHeight` is max(sized wrapper, overflowing content), so when the wrapper is
  // the taller of the two, content can grow — a row below the window being measured
  // taller than its 72px estimate, the window sliding so a tall row unmounts — WITHOUT
  // the row container's own box changing at all. No resize entry fires, no pin runs,
  // and the viewport falls behind while `stickBottom` is still true (measured in a real
  // browser: scrollHeight 2400→2700 with the row container flat at 1200px left a 300px
  // gap and ZERO observer callbacks). `measureTick` doesn't cover it either — it only
  // bumps when a MOUNTED row's measured height changes.
  useLayoutEffect(() => {
    const inner = innerRef.current;
    const sized = sizedRef.current;
    if (!inner && !sized) return;
    const ro = new ResizeObserver(() => {
      if (stickBottom.current || initialPin.current) pinToBottom();
    });
    if (inner) ro.observe(inner);
    if (sized) ro.observe(sized);
    return () => ro.disconnect();
    // Re-attach when the observed elements are (re)created — they only exist once
    // there are messages (the empty state renders a different subtree).
  }, [pinToBottom, messages.length > 0]);

  // Reset the measure-loop counter once per painted frame. Only an unbroken
  // chain of synchronous measure→render passes WITHIN a single frame can trip
  // the guard; reaching a paint means layout settled, so normal streaming (which
  // paints between batches) never accumulates toward the limit.
  useEffect(() => {
    let raf = 0;
    const tick = () => {
      syncMeasurePasses.current = 0;
      raf = requestAnimationFrame(tick);
    };
    raf = requestAnimationFrame(tick);
    return () => cancelAnimationFrame(raf);
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
    // `session?.running` is a dep so the WorkingIndicator mounting/unmounting
    // (it renders outside the ResizeObserver'd wrapper) re-pins the bottom.
  }, [messages.length, measureTick, pinToBottom, session?.running]);

  // SCROLL ANCHORING while follow is released. Reading history means scrolling
  // UP through rows that have never mounted — history backfill folds the whole
  // transcript in one commit, so only the bottom window was ever measured and
  // everything above carries the 72px ESTIMATE. As those rows enter the
  // overscan and measure for the first time, the offsets of every row below
  // them (including the ones on screen) shift while scrollTop stays put, and
  // the content visibly jumps under the viewport (reproduced in the real app:
  // wheel-scrolling up produced 20-50px uncommanded shifts, one per few ticks
  // — scripts/verify-scroll-anchoring.mjs). The browser's native anchoring
  // cannot help: it doesn't track content repositioned via translateY inside
  // an explicitly-sized wrapper (and we disable it in CSS so it can't fight
  // this compensation either).
  //
  // Runs after EVERY commit (no dep array — a measure pass is exactly the
  // commit that moves offsets): restore the anchor item (the one under the
  // viewport top, tracked in onScroll) to the same viewport position, before
  // paint, using THIS commit's offsets from layoutRef. While following, the
  // bottom pin owns the scroll position instead; a hidden pane
  // (`display: none`, clientHeight 0) has no geometry to correct.
  useLayoutEffect(() => {
    const el = scrollRef.current;
    if (!el) return;
    if (stickBottom.current || initialPin.current) return;
    if (el.clientHeight === 0) return;
    const anchor = anchorRef.current;
    if (!anchor) return;
    const { ids, offsets } = layoutRef.current;
    const idx = resolveAnchorIndex(ids, anchor.id, anchor.index);
    if (idx < 0) return; // anchor item left the list — re-anchors on next scroll
    const desired = offsets[idx] + anchor.delta;
    if (Math.abs(desired - el.scrollTop) <= 1) return;
    // 'instant' for the same reason as pinToBottom: the stylesheet's
    // `scroll-behavior: smooth` would animate the correction into a wobble.
    el.scrollTo({ top: desired, behavior: 'instant' as ScrollBehavior });
    // The correction is not a user scroll: keep onScroll's baseline current so
    // the follow-release discriminator never misreads it.
    lastScrollTop.current = el.scrollTop;
  });

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
  // Publish this render's layout for the anchoring effect + onScroll (above).
  layoutRef.current = { ids: items.map((it) => it.id), offsets };

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
    <div className="av-list-shell">
      {/* Follow-mode indicator. Only shown once there IS output and follow has been
          released — while following it stays out of the way entirely (the transcript
          scrolling itself is the affordance). Clicking jumps to the newest output and
          re-engages, which is otherwise only reachable by manually dragging to the
          very bottom. */}
      {messages.length > 0 && !following && (
        <button
          type="button"
          className="av-follow-pill"
          onClick={resumeFollow}
          title="Jump to the latest output and resume following"
        >
          <svg width="12" height="12" viewBox="0 0 16 16" fill="none" aria-hidden="true">
            <path
              d="M8 3v9m0 0 3.5-3.5M8 12 4.5 8.5"
              stroke="currentColor"
              strokeWidth="1.6"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
          Resume following
        </button>
      )}
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
        <div
          ref={sizedRef}
          className="av-message-list-inner"
          style={{ height: totalHeight, position: 'relative' }}
        >
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
                  // A zero measurement has TWO very different causes and they
                  // need opposite handling:
                  //   • HIDDEN PANE — inactive panes are `display: none` (theme
                  //     CSS) but their layout effects still run on background
                  //     store updates, and then EVERY row reports 0. Caching
                  //     those zeros would poison the offsets (and drop the
                  //     scroll position) the user comes back to.
                  //   • GENUINELY EMPTY ROW — MessageBubble returns null when a
                  //     message has no text, no thinking and no images (a
                  //     block-start whose first delta hasn't landed, a
                  //     thinking-only block after the spinner settles). That row
                  //     really is 0px and MUST be cached: refusing to record it
                  //     leaves it stuck on the 72px ESTIMATE forever, so the
                  //     sized wrapper reserves space no row occupies — blank
                  //     scrollable voids and gaps between rows (the v0.5.190
                  //     regression this guard caused).
                  // Discriminate by the SCROLLER, not the row: a hidden pane has
                  // clientHeight 0, a live pane measuring an empty row does not.
                  if (h === 0 && (scrollRef.current?.clientHeight ?? 0) === 0) return;
                  const known = heights.current.get(it.id);
                  if (known === h) return;
                  heights.current.set(it.id, h);
                  // Circuit breaker for React error #185 ("Maximum update depth
                  // exceeded"), which black-screened the whole app.
                  //
                  // MeasuredRow's layout effect is dependency-free, so it
                  // re-measures after EVERY render and calls back in here. The
                  // `known === h` guard above terminates that only when heights
                  // SETTLE. They don't have to: a viewport resize recomputes the
                  // virtualized window, which mounts a different row set, whose
                  // measurements move the window back — an A→B→A oscillation
                  // where every pass reports a genuinely new height, so the
                  // guard never fires and the synchronous path below re-renders
                  // forever. Archiving the workspace you are viewing is the
                  // reliable trigger: it switches to a cold StructuredView whose
                  // rows all measure for the first time WHILE the pane is being
                  // resized by the sidebar row disappearing.
                  //
                  // So bound the synchronous path: after enough back-to-back
                  // passes without a paint, fall through to the coalesced rAF
                  // path, which yields to the browser and cannot recurse. A
                  // frame boundary resets the counter, so normal streaming (a
                  // handful of passes per frame) is untouched.
                  syncMeasurePasses.current += 1;
                  const looping = syncMeasurePasses.current > MAX_SYNC_MEASURE_PASSES;
                  if (looping && !measureLoopWarned.current) {
                    measureLoopWarned.current = true;
                    log.warn(
                      `row-measure loop guard tripped after ` +
                        `${MAX_SYNC_MEASURE_PASSES} synchronous passes (row ${it.id}: ` +
                        `${String(known)}px -> ${h}px) — falling back to coalesced ` +
                        `measurement. This prevented a React #185 render loop.`,
                    );
                  }
                  if (known === undefined && !looping) {
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
            {/* Live "Working…" readout BELOW the streaming output, inside the
                transcript (CC-desktop placement). It must live INSIDE this
                translated row container, directly after the last mounted row:
                the sized wrapper's `totalHeight` is built from height
                ESTIMATES that lag real typewriter growth, so anything placed
                after the wrapper in normal flow sits at the stale estimated
                bottom and gets overlapped by the overflowing streamed text
                (measured: child 193px vs wrapper 142px mid-stream). Only
                rendered when the window reaches the list's end — scrolled up,
                the indicator belongs below the fold, not after row N of M.
                Mounting here also grows the ResizeObserver'd child, so
                follow-mode re-pins automatically. */}
            {session?.running && end === items.length && (
              <WorkingIndicator session={session} />
            )}
          </div>
        </div>
      )}
      </div>
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
  | { kind: 'message'; id: string; message: RenderMessage; divider?: TurnDivider }
  | { kind: 'tool-group'; id: string; tools: RenderMessage[] }
  // A run of consecutive INTER-AGENT messages, collapsed to compact rows so
  // fleet traffic doesn't drown the human's conversation (issue #56).
  | { kind: 'peer-group'; id: string; messages: RenderMessage[] };

/** Tools that must NOT be folded into a collapsed group — they own a first-class,
 *  always-visible surface. TodoWrite is the live task list (Claude-Code shows it
 *  expanded, never buried); it renders as its own always-open ToolCard. */
function isStandaloneTool(m: RenderMessage): boolean {
  return m.role === 'tool' && m.toolUse?.name === 'TodoWrite';
}

function buildRenderItems(messages: RenderMessage[]): RenderItem[] {
  const items: RenderItem[] = [];
  let run: RenderMessage[] | null = null;
  // TURN DIVIDER bookkeeping: each USER turn gets a divider above its bubble
  // (time + day-on-change + idle gap ≥ 10 min). `prevAt` is the last stamped
  // message of ANY role, so the gap measures real transcript silence, not just
  // prompt-to-prompt distance. The divider rides INSIDE the user message's
  // virtualized row (rendered by ItemSlot) so row heights stay a pure function
  // of item content.
  const nowMs = Date.now();
  let prevAt: number | undefined;
  // Consecutive peer deliveries group into ONE collapsed item, the same way a
  // run of tools does — a wave of fleet messages reads as one quiet row.
  let peerRun: RenderMessage[] | null = null;
  const flushPeers = () => {
    if (peerRun && peerRun.length > 0) {
      items.push({ kind: 'peer-group', id: `pg:${peerRun[0].id}`, messages: peerRun });
    }
    peerRun = null;
  };
  const flush = () => {
    if (run && run.length > 0) {
      items.push({ kind: 'tool-group', id: `tg:${run[0].id}`, tools: run });
    }
    run = null;
  };
  for (const m of messages) {
    // Peer messages break a tool run and accumulate into their own run. Checked
    // FIRST so a peer delivery never falls through to the user-bubble branch.
    // `isPeerMessage` is structural (the origin tag) — a human turn, whatever
    // its text, can never land here.
    if (isPeerMessage(m)) {
      flush();
      (peerRun ??= []).push(m);
      if (m.at !== undefined) prevAt = m.at;
      continue;
    }
    flushPeers();
    if (m.role === 'tool' && !isStandaloneTool(m)) {
      (run ??= []).push(m);
    } else {
      // A standalone tool (TodoWrite) and any non-tool message both break the
      // current run and render as their own item.
      flush();
      const divider =
        m.role === 'user' && m.at !== undefined
          ? computeTurnDivider(m.at, prevAt, nowMs)
          : undefined;
      items.push({ kind: 'message', id: m.id, message: m, ...(divider ? { divider } : {}) });
    }
    if (m.at !== undefined) prevAt = m.at;
  }
  flush();
  flushPeers();
  return items;
}

// ── Item renderer (A3) ───────────────────────────────────────────────────────
//
// A `message` item routes through <AgentMessage> (markdown bubble / thinking /
// lone tool card). A `tool-group` item routes through <ToolGroup>, which shows
// the collapsed "2 Read · 1 Bash" summary and expands to individual ToolCards.

function ItemSlot({ item }: { item: RenderItem }) {
  if (item.kind === 'tool-group') return <ToolGroup tools={item.tools} />;
  if (item.kind === 'peer-group') return <PeerMessageGroup messages={item.messages} />;
  return (
    <>
      {item.divider ? (
        <div className="av-turn-divider" title={item.divider.title} aria-hidden="true">
          <span className="av-turn-divider-label">
            {item.divider.day ? <b>{item.divider.day} · </b> : null}
            {item.divider.time}
            {item.divider.gap ? <span className="av-turn-divider-gap"> · {item.divider.gap}</span> : null}
          </span>
        </div>
      ) : null}
      <AgentMessage message={item.message} />
    </>
  );
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
      onReplied={(requestId, kind) => resolveAgentPermission(workspaceId, requestId, kind)}
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
  onOpenMcp,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
  onOpenMcp?: () => void;
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
      {/* MCP health chip — renders ONLY when a server needs attention. */}
      <McpIndicator session={session} onOpen={onOpenMcp} />
      <span className="av-deck-account" title="Account this agent runs as — click to migrate">
        <WorkspaceAccountBadge workspaceId={workspaceId} migratable />
      </span>
    </div>
  );
}

// ── Context strip ────────────────────────────────────────────────────────────
//
// The quiet caption-weight line UNDER the composer card: which worktree this
// message will change, how much context is left, and the branch. It answers
// "what am I about to touch?" at the moment of sending — the app toolbar's
// branch chip is correct but sits at the opposite end of the window from the
// send button, so it isn't read at decision time.
//
// Deliberately NOT interactive (the toolbar's BranchPicker remains the one
// place branches are switched): duplicating that control here would give two
// writers for one piece of state. This is a readout.

function ContextStrip({
  session,
  workspaceId,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
}) {
  const ws = useStore((s) => s.workspaces.find((w) => w.id === workspaceId));
  if (!ws) return null;
  // Scratch/orchestrator workspaces have no repo: `branch` is a display label
  // and worktreePath is empty (see types.ts Workspace.kind), so show neither
  // rather than render an empty chip.
  const isGit = !isScratchLike(ws) && !!ws.worktreePath;
  const folder = ws.worktreePath ? ws.worktreePath.split('/').filter(Boolean).pop() : '';
  return (
    <div className="av-strip">
      {isGit && folder && (
        <span className="av-strip-item" title={ws.worktreePath}>
          <span className="av-strip-glyph" aria-hidden="true">
            🗀
          </span>
          {folder}
        </span>
      )}
      <StripStats session={session} />
      {isGit && (
        <span
          className="av-strip-branch"
          title={ws.baseBranch ? `${ws.branch} — base: ${ws.baseBranch}` : ws.branch}
        >
          <span className="av-strip-glyph" aria-hidden="true">
            ⑂
          </span>
          {ws.branch}
        </span>
      )}
    </div>
  );
}

// ── Composer ─────────────────────────────────────────────────────────────────

/** The input is exactly a slash-command prefix ("/", "/shi") — the only state
 *  in which the skills autocomplete shows. */
const SLASH_PREFIX = /^\/([A-Za-z0-9_-]*)$/;

/** One autocomplete row: an on-disk skill, or a built-in CLI slash command
 *  (from `session/init`'s `slash_commands` — /compact, /usage, …), or the
 *  Orchestra-side /clear. */
interface AcItem {
  name: string;
  description: string;
  source: AgentSkillInfo['source'] | 'builtin';
}

/** Descriptions for the built-ins worth explaining; the rest show bare. */
const BUILTIN_DESC: Record<string, string> = {
  clear: 'Start a fresh conversation (clears the transcript)',
  compact: 'Compact the conversation to free context',
  usage: 'Show plan usage / rate-limit status',
  mcp: 'Manage MCP servers — status, enable/disable, reconnect',
};

/** Commands Orchestra guarantees regardless of what the CLI reports. `clear`
 *  is handled Orchestra-side (agentSdkClear); `mcp` likewise (it opens the MCP
 *  manager popover on submit — never sent to the model); `compact` is sent to
 *  the CLI, which executes it as a built-in and reports back via
 *  status/compact events. */
const ALWAYS_COMMANDS = ['clear', 'compact', 'mcp'];

function Composer({
  session,
  workspaceId,
  isActive,
  bar,
  strip,
  handleRef,
  mcpOpen,
  setMcpOpen,
}: {
  session: AgentSession | undefined;
  workspaceId: string;
  isActive: boolean;
  /** The /mcp manager popover — state lives in the PARENT because the MCP
   *  health chip in the controls bar opens it too, not just `/mcp` submit. */
  mcpOpen: boolean;
  setMcpOpen: (open: boolean) => void;
  /** Control chrome docked into the card's bottom row (model / effort /
   *  permission menus, remote control, account badge). Passed in rather than
   *  rendered here so the composer stays a pure input concern. */
  bar?: React.ReactNode;
  /** Ambient readout under the card (worktree · cost · context · branch). */
  strip?: React.ReactNode;
  /** Imperative handle the parent uses to PREFILL the input — the edit-and-retry
   *  half of a rewind puts the undone message's text back for editing. The
   *  composer owns its text state, so this is the seam rather than lifting it. */
  handleRef?: React.MutableRefObject<{ prefill: (text: string) => void } | null>;
}) {
  const [text, setText] = useState('');
  // Images pasted into the composer, pending send. Each carries the base64 for
  // the wire plus a data URL for the thumbnail preview.
  const [pendingImages, setPendingImages] = useState<
    { id: string; mediaType: string; dataBase64: string; url: string }[]
  >([]);
  // Imperative handle on the CodeMirror editor (focus / read / set text).
  const cmRef = useRef<CmComposerHandle | null>(null);
  const running = !!session?.running;

  // Voice dictation (mic + voice-edit in the bar; ghost partials in the doc).
  // The workspace's branch + repo folder ride into the speaker dictionary so
  // "worktree", ticket-ish branch names and repo names transcribe right.
  const vocabExtra = useStore((s) => {
    const ws = s.workspaces.find((w) => w.id === workspaceId);
    if (!ws) return '';
    return [ws.branch, ws.repoPath?.split('/').pop()].filter(Boolean).join(', ');
  });
  const voice = useVoiceDictation(workspaceId, cmRef, setText, vocabExtra);

  // WINDOW-SCOPED push-to-talk. The CodeMirror keymap (Ctrl-m in CmComposer)
  // only fires with focus inside the composer, which is exactly when reaching
  // for the mouse is least annoying — the gesture is wanted while reading a
  // diff or a terminal. Capture-phase on window, gated on `isActive` so only
  // the visible workspace's pane responds (every mounted pane runs this hook).
  //
  // Not a `globalShortcut` (OS-wide): that would steal Ctrl+M from every other
  // app on the desktop, which the user did not ask for.
  //
  // keyup is NOT gated on `event.ctrlKey`: releasing Ctrl before M is a normal
  // way to end the gesture, and the keyup for "m" then reports ctrlKey=false.
  // Matching on `code`/`key` alone is what makes the release reliable.
  //
  // `voice` is read through a REF, not captured: `press` flips micState, which
  // would re-run this effect and swap the listeners out from under a key that
  // is still physically down. That happens to survive (the keyup lands on the
  // replacements) but it makes correctness depend on re-render timing, and the
  // effect would also churn on every keystroke via `text`. The ref keeps ONE
  // listener pair installed for the whole gesture.
  const voiceRef = useRef(voice);
  voiceRef.current = voice;
  // Bash mode (`!…`) disables the hotkey — but ONLY from idle. If dictation is
  // already running, an utterance that happens to start with "!" must not tear
  // the listeners down mid-gesture, which would swallow the keyup and strand
  // the mic on. Once it stops, the guard applies again normally.
  // The push-to-talk hotkey is USER-BOUND (see voice-hotkey-pref.ts): the old
  // hardcoded Ctrl+M is dead on AZERTY hardware driven by a `us` layout, where
  // the key labelled M reports code='Semicolon'. Held in a ref for the same
  // reason `voice` is — rebinding must not swap listeners mid-gesture.
  const [voiceHotkey, setVoiceHotkey] = useState<VoiceHotkey>(() => readVoiceHotkey());
  const hotkeyRef = useRef(voiceHotkey);
  hotkeyRef.current = voiceHotkey;
  // "Press a key" capture: shift-click the mic to rebind. Recording SUSPENDS the
  // normal hotkey (see micHotkeyOn) so the next keypress is captured instead of
  // starting dictation.
  const [rebinding, setRebinding] = useState(false);
  const rebindVoiceHotkey = useCallback((next: VoiceHotkey) => {
    setVoiceHotkey(next);
    writeVoiceHotkey(next);
  }, []);

  const micHotkeyOn =
    isActive &&
    voice.available &&
    !rebinding &&
    (voice.micState !== 'idle' || !text.startsWith('!'));
  useEffect(() => {
    if (!micHotkeyOn) return;
    const onDown = (e: KeyboardEvent) => {
      if (!matchesVoiceHotkey(e, hotkeyRef.current)) return;
      e.preventDefault();
      e.stopPropagation();
      voiceRef.current.press(e.shiftKey ? 'edit' : 'dictate');
    };
    // keyup is NOT gated on ctrlKey: releasing Ctrl before M is a normal way to
    // end the gesture, and the keyup for "m" then reports ctrlKey=false.
    // Matching the letter alone is what makes the release reliable.
    const onUp = (e: KeyboardEvent) => {
      // `false` = do not require the modifier: releasing Ctrl before the letter
      // is normal, and the keyup then reports ctrlKey=false. Matching on the
      // physical `code` alone is what makes the release reliable.
      if (!matchesVoiceHotkey(e, hotkeyRef.current, false)) return;
      const v = voiceRef.current;
      v.release(v.micState === 'edit' ? 'edit' : 'dictate');
    };
    // A hold whose keyup never arrives (focus lost to another window mid-press)
    // would latch the mic on silently — treat losing the window as a release so
    // the mic can never be stranded open.
    const onBlur = () => {
      const v = voiceRef.current;
      v.release(v.micState === 'edit' ? 'edit' : 'dictate');
    };
    window.addEventListener('keydown', onDown, true);
    window.addEventListener('keyup', onUp, true);
    window.addEventListener('blur', onBlur);
    return () => {
      window.removeEventListener('keydown', onDown, true);
      window.removeEventListener('keyup', onUp, true);
      window.removeEventListener('blur', onBlur);
    };
  }, [micHotkeyOn]);

  // Capture the next real keypress as the new hotkey. Escape cancels. Runs at
  // capture phase so the composer never sees the keystroke it is binding.
  useEffect(() => {
    if (!rebinding) return;
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape') {
        e.preventDefault();
        e.stopPropagation();
        setRebinding(false);
        return;
      }
      const next = hotkeyFromEvent(e);
      if (!next) return; // modifier-only: keep waiting for the real key
      e.preventDefault();
      e.stopPropagation();
      rebindVoiceHotkey(next);
      setRebinding(false);
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [rebinding, rebindVoiceHotkey]);

  // Expose PREFILL to the parent (rewind's edit-and-retry). Both the React
  // state and the CodeMirror document must be set: `text` drives bash-mode
  // detection, the send payload and the autocomplete, while the editor holds
  // the actual document. Setting only one silently desyncs them.
  useEffect(() => {
    if (!handleRef) return;
    handleRef.current = {
      prefill: (next: string) => {
        setText(next);
        cmRef.current?.setText(next);
        cmRef.current?.focus();
      },
    };
    return () => {
      handleRef.current = null;
    };
  }, [handleRef]);

  // Vim keybindings: ON by default, persisted per-user. `vimMode` is the live
  // mode reported by the editor and drives the composer-bar chip.
  const [vimEnabled, setVimEnabled] = useState(() => readComposerVim() === 'on');
  const [vimMode, setVimMode] = useState<VimMode | null>(null);
  const toggleVim = useCallback(() => {
    setVimEnabled((on) => {
      const next = !on;
      writeComposerVim(next ? 'on' : 'off');
      return next;
    });
    cmRef.current?.focus();
  }, []);

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

  // --- Design-mode picks ----------------------------------------------------
  //
  // The browser pane's element picker queues picks in the STORE (not straight
  // into this component), which is what makes a pick survive a composer that
  // isn't mounted: the user can pick while on the Terminal tab or on another
  // workspace, and the pick waits until this composer mounts and drains it.
  //
  // Draining is one atomic store action (`takeDesignPicks` reads + clears in a
  // single set), so a pick lands exactly once even across re-renders.
  const queuedDesignPicks = useStore((s) => s.designPicks[workspaceId]);
  const takeDesignPicks = useStore((s) => s.takeDesignPicks);
  useEffect(() => {
    if (!queuedDesignPicks || queuedDesignPicks.length === 0) return;
    const picks = takeDesignPicks(workspaceId);
    if (picks.length === 0) return;
    // Text half: append the fenced selector/url/html/css block to the draft,
    // preserving whatever the user had already typed.
    setText((prev) => picks.reduce((draft, p) => appendPickToDraft(draft, p), prev));
    // Image half: the cropped element screenshot rides the SAME pending-images
    // path as a paste/drop, so it renders as a thumbnail and is sent as a real
    // image block — no separate attachment type to teach the send path about.
    const shots = picks.filter((p) => p.screenshotBase64);
    if (shots.length > 0) {
      setPendingImages((prev) => [
        ...prev,
        ...shots.map((p, i) => ({
          id: `design:${p.selector}:${prev.length + i}`,
          mediaType: 'image/png',
          dataBase64: p.screenshotBase64 as string,
          url: `data:image/png;base64,${p.screenshotBase64}`,
        })),
      ]);
    }
    cmRef.current?.focus();
  }, [queuedDesignPicks, takeDesignPicks, workspaceId]);

  // No autosize hook here any more: CodeMirror grows with its content natively
  // and `.cm-scroller`'s `max-height: 200px` (set in the editor theme) reproduces
  // the old cap-then-scroll behaviour without measuring scrollHeight by hand.

  // Skills autocomplete: loaded lazily on the first "/" (cheap dir scan in
  // main), cached per mount. `acIndex` is the highlighted row.
  const [skills, setSkills] = useState<AgentSkillInfo[] | null>(null);
  const skillsRequested = useRef(false);
  const [acIndex, setAcIndex] = useState(0);
  // Escape dismisses the popover until the slash-prefix changes again.
  const [acDismissed, setAcDismissed] = useState(false);

  const slash = SLASH_PREFIX.exec(text);
  const acQuery = slash?.[1]?.toLowerCase() ?? null;
  // Merge on-disk skills with the CLI's built-in slash commands (reported at
  // session/init) plus the always-available /clear + /compact, so typed
  // built-ins are discoverable — CC-desktop parity. Skills win a name clash.
  const acItems: AcItem[] = (() => {
    if (acQuery === null || acDismissed) return [];
    const items: AcItem[] = [...(skills ?? [])];
    const have = new Set(items.map((s) => s.name.toLowerCase()));
    for (const name of [...ALWAYS_COMMANDS, ...(session?.slashCommands ?? [])]) {
      const clean = name.replace(/^\//, '');
      if (!clean || have.has(clean.toLowerCase())) continue;
      have.add(clean.toLowerCase());
      items.push({ name: clean, description: BUILTIN_DESC[clean] ?? '', source: 'builtin' });
    }
    return items
      .filter((s) => s.name.toLowerCase().includes(acQuery))
      .sort((a, b) => {
        const ap = a.name.toLowerCase().startsWith(acQuery) ? 0 : 1;
        const bp = b.name.toLowerCase().startsWith(acQuery) ? 0 : 1;
        return ap - bp || a.name.localeCompare(b.name);
      })
      .slice(0, 8);
  })();
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
    if (isActive) cmRef.current?.focus();
  }, [isActive]);

  const submit = useCallback((interruptFirst = false) => {
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
    // `/clear` is handled ORCHESTRA-side (parity with Claude Code): stop the
    // session, drop the resume id, reset every client's transcript. Any other
    // slash command (e.g. /compact) is sent through — the CLI executes its
    // built-ins itself and reports back via status/compact/command-output
    // events, which now render.
    if (t === '/clear') {
      void window.orchestra
        .agentSdkClear(workspaceId)
        .catch((e) => console.error('agentSdkClear failed', e));
      setText('');
      return;
    }
    // `/mcp` is likewise Orchestra-side: SUBMITTING it opens the MCP manager
    // popover over the composer (Option-D design — the popover pops on send,
    // not while typing) and the command never reaches the model.
    if (t === '/mcp') {
      setMcpOpen(true);
      setText('');
      return;
    }
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
    //
    // `interruptFirst` (Shift/Cmd+Enter while a turn runs) stops the current
    // turn so this prompt runs NOW instead of queueing. The interrupt is
    // awaited: sending first would race the queue-clearing inside
    // `interruptCancellingQueued` and could discard this very prompt.
    const send = () =>
      window.orchestra
        .agentSdkSend(workspaceId, t, images)
        .catch((e) => console.error('agentSdkSend failed', e));
    if (interruptFirst && running) {
      void window.orchestra
        .agentSdkInterrupt(workspaceId)
        .catch((e) => console.error('agentSdkInterrupt failed', e))
        .then(send);
    } else {
      void send();
    }
    setText('');
    setPendingImages([]);
  }, [text, pendingImages, workspaceId, setMcpOpen, running]);

  const completeSkill = (name: string) => {
    setText(`/${name} `);
    cmRef.current?.focus();
  };

  // Drag-and-drop into the composer (CC-desktop parity): image files become
  // attachments (same pipeline as paste); other files insert their absolute
  // path into the text (Electron exposes File.path).
  // Accepts BOTH a React synthetic DragEvent (the card's own onDrop) and a
  // native one (CodeMirror's domEventHandlers pass the raw event) — the two
  // share the only fields this needs.
  const onDrop = useCallback(
    (e: React.DragEvent | DragEvent) => {
      e.preventDefault();
      const dt = e.dataTransfer;
      if (!dt) return;
      addPastedImages(dt.items);
      const paths = Array.from(dt.files)
        .filter((f) => !f.type.startsWith('image/'))
        .map((f) => (f as File & { path?: string }).path)
        .filter((p): p is string => !!p);
      if (paths.length > 0) {
        setText((prev) => (prev ? `${prev.trimEnd()} ` : '') + paths.join(' '));
        cmRef.current?.focus();
      }
    },
    [addPastedImages],
  );

  return (
    <div className="av-composer">
      {/* Parked prompts sit ABOVE the input, inside the composer frame: they are
          about to become turns, so they belong to the send surface, and docking
          them here keeps them on-screen (the transcript scrolls away). */}
      <QueueTray
        queued={session?.queuedPrompts ?? []}
        onRemove={(id) => void window.orchestra.agentSdkQueueRemove(workspaceId, id)}
        onEdit={(id, t) => void window.orchestra.agentSdkQueueEdit(workspaceId, id, t)}
        onMove={(id, dir) => void window.orchestra.agentSdkQueueMove(workspaceId, id, dir)}
        onCoalesce={(id, on) => void window.orchestra.agentSdkQueueCoalesce(workspaceId, id, on)}
        onMergeAll={() => {
          // Merge every entry but the last — the last has nothing after it.
          const q = session?.queuedPrompts ?? [];
          for (const entry of q.slice(0, -1)) {
            if (!entry.coalesceWithNext) {
              void window.orchestra.agentSdkQueueCoalesce(workspaceId, entry.id, true);
            }
          }
        }}
      />
      <div
        className={`av-composer-field ${bashMode ? 'av-composer-field-bash' : ''}`}
        onDragOver={(e) => e.preventDefault()}
        onDrop={onDrop}
      >
        {mcpOpen && (
          <McpPopover
            workspaceId={workspaceId}
            seed={session?.mcpServers}
            onClose={() => {
              setMcpOpen(false);
              cmRef.current?.focus();
            }}
          />
        )}
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
          {/* The text surface is a CodeMirror editor (CmComposer). It replaced a
              textarea + highlight-mirror pair: a textarea cannot style a
              substring, so `/skill` had to be painted by a transparent-text
              textarea stacked over a mirror div whose text metrics had to stay
              byte-identical — and it cannot support modal editing at all. */}
          <CmComposer
            value={text}
            onChange={(t) => {
              setText(t);
              setAcDismissed(false);
            }}
            placeholder={
              bashMode
                ? 'Enter a shell command — runs in the worktree, output shared with the agent'
                : 'Message the agent — / for skills, ! for bash, paste an image…'
            }
            vimEnabled={vimEnabled}
            onVimMode={setVimMode}
            handleRef={(h) => {
              cmRef.current = h;
            }}
            onArrowDown={() => {
              if (!acOpen) return false;
              setAcIndex((i) => (i + 1) % acItems.length);
              return true;
            }}
            onArrowUp={() => {
              if (!acOpen) return false;
              setAcIndex((i) => (i - 1 + acItems.length) % acItems.length);
              return true;
            }}
            onTab={() => {
              if (!acOpen) return false;
              const it = acItems[acIndex];
              if (it) completeSkill(it.name);
              return true;
            }}
            onEnter={() => {
              if (acOpen) {
                const it = acItems[acIndex];
                if (it) completeSkill(it.name);
                return true;
              }
              submit();
              return true;
            }}
            onModEnter={() => {
              // Cmd/Ctrl+Enter — jump the queue: interrupt the running turn so
              // this prompt runs now. With nothing running it's just a send.
              if (acOpen) return false;
              submit(true);
              return true;
            }}
            onEscape={(mode) => {
              // Context-dependent Esc:
              //  1. popover open      → dismiss it
              //  2. vim INSERT/VISUAL → let vim leave the mode; do NOT interrupt
              //     (otherwise pressing Esc out of muscle memory mid-message
              //     kills the running turn)
              //  3. otherwise         → interrupt the in-flight turn
              if (acOpen) {
                setAcDismissed(true);
                return true;
              }
              if (mode === 'insert' || mode === 'visual') return false;
              if (running) {
                void window.orchestra
                  .agentSdkInterrupt(workspaceId)
                  .catch((err) => console.error('agentSdkInterrupt failed', err));
                return true;
              }
              return false;
            }}
            onPaste={(items) => addPastedImages(items)}
            onDrop={(e) => onDrop(e)}
            onVoiceDictate={() => {
              if (!voice.available || bashMode) return false;
              voice.toggle('dictate');
              return true;
            }}
            onVoiceEdit={() => {
              if (!voice.available || bashMode) return false;
              voice.toggle('edit');
              return true;
            }}
          />
        </div>
        {/* The control bar is docked INSIDE the card (bottom row) rather than
            rendered as its own bordered deck above it: the model / effort /
            permission menus govern the message being composed, so they belong
            to the same surface as the input. `bar` carries SessionControls +
            the send button. */}
        <div className="av-composer-bar">
          {bashMode ? (
            <span className="av-composer-bar-note">
              Runs locally in the worktree · output shared with the agent
            </span>
          ) : (
            bar
          )}
          {/* Vim chip — a per-user switch beside the model / effort / permission
              chips, which is what vim mode is. It DOUBLES as the mode indicator
              (`-- INSERT --` / `-- NORMAL --` / `-- VISUAL --`), so enabling vim
              costs no extra UI; with vim off it reads a quiet `vim`. `order:5`
              keeps it after the docked chrome (interrupt 1 · menus 2 · remote 3
              · account 4) and before the send button (9). */}
          <button
            type="button"
            className="av-composer-vim"
            data-on={vimEnabled ? '1' : '0'}
            data-mode={vimMode ? vimMode.toUpperCase() : undefined}
            onClick={toggleVim}
            aria-pressed={vimEnabled}
            aria-label={vimEnabled ? 'Disable vim keybindings' : 'Enable vim keybindings'}
            title={
              vimEnabled
                ? `vim ${vimMode?.toUpperCase() ?? ''} — click to disable vim keybindings`
                : 'Enable vim keybindings'
            }
          >
            {vimChipLabel(vimEnabled ? vimMode : null)}
          </button>
          {voice.available && !bashMode && (
            <>
              {rebinding ? (
                <span className="av-voice-status" aria-live="polite">
                  press a key… (Esc to cancel)
                </span>
              ) : (
                voice.status && (
                  <span className="av-voice-status" aria-live="polite">
                    {voice.status}
                  </span>
                )
              )}
              <button
                type="button"
                className="av-composer-mic"
                data-state={voice.micState === 'dictate' ? 'rec' : undefined}
                data-held={voice.micState === 'dictate' && voice.held ? '1' : undefined}
                onClick={(e) => {
                  if (e.shiftKey) {
                    setRebinding(true);
                    return;
                  }
                  voice.toggle('dictate');
                }}
                data-rebinding={rebinding ? '1' : undefined}
                aria-pressed={voice.micState === 'dictate'}
                aria-label={voice.micState === 'dictate' ? 'Stop dictation' : 'Dictate'}
                title={
                  voice.micState === 'dictate'
                    ? voice.held
                      ? `Listening — release ${voiceHotkeyLabel(voiceHotkey)} to stop`
                      : `Stop dictation (${voiceHotkeyLabel(voiceHotkey)}, or click)`
                    : `Dictate — HOLD ${voiceHotkeyLabel(voiceHotkey)} to talk, or tap it to keep the mic on. Works anywhere in the window; speech lands here as you talk, cleaned up on each pause. Shift-click this button to rebind the key.`
                }
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  aria-hidden="true"
                >
                  <rect x="6" y="1.5" width="4" height="8" rx="2" />
                  <path d="M3.5 7.5a4.5 4.5 0 0 0 9 0M8 12v2.5" />
                </svg>
              </button>
              <button
                type="button"
                className="av-composer-mic av-composer-voice-edit"
                data-state={voice.micState === 'edit' ? 'rec' : undefined}
                data-held={voice.micState === 'edit' && voice.held ? '1' : undefined}
                onClick={() => voice.toggle('edit')}
                aria-pressed={voice.micState === 'edit'}
                aria-label="Edit by voice"
                title="Edit by voice — HOLD Ctrl+Shift+M and speak an instruction (or tap to latch). Select text first, else the last utterance is the target"
              >
                <svg
                  width="17"
                  height="17"
                  viewBox="0 0 16 16"
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.6"
                  strokeLinecap="round"
                  strokeLinejoin="round"
                  aria-hidden="true"
                >
                  <path d="M11.5 2.5l2 2L6 12l-2.7.7.7-2.7z" />
                </svg>
              </button>
            </>
          )}
          <button
            className={`av-composer-send${bashMode ? ' av-composer-send-bash' : ''}`}
            // Wrapped, NOT `onClick={submit}`: React passes the MouseEvent as
            // the first argument, which would land in `interruptFirst` and make
            // every click on the send button kill the running turn.
            onClick={(e) => submit(e.metaKey || e.ctrlKey)}
            disabled={bashMode ? !bashCommand.trim() : !text.trim() && pendingImages.length === 0}
            aria-label={bashMode ? 'Run command' : running ? 'Queue message' : 'Send message'}
            title={
              bashMode
                ? 'Run the shell command locally (Enter)'
                : running
                  ? 'Agent is working — message will queue'
                  : 'Send (Enter)'
            }
          >
            {/* Icon-only: the Send/Queue/Run distinction the text label used to
                carry now rides on the GLYPH (arrow / queue-return / chevron)
                plus the tooltip + aria-label, which buys back the width the
                docked menus need. */}
            {bashMode ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M4 4l4 4-4 4" />
                <path d="M9 12h4" />
              </svg>
            ) : running ? (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M12 4v5a3 3 0 0 1-3 3H4" />
                <path d="M7 9l-3 3 3 3" />
              </svg>
            ) : (
              <svg
                width="13"
                height="13"
                viewBox="0 0 16 16"
                fill="none"
                stroke="currentColor"
                strokeWidth="2.2"
                strokeLinecap="round"
                strokeLinejoin="round"
                aria-hidden="true"
              >
                <path d="M8 13V3" />
                <path d="M3.5 7.5 8 3l4.5 4.5" />
              </svg>
            )}
          </button>
        </div>
      </div>
      {strip}
    </div>
  );
}
