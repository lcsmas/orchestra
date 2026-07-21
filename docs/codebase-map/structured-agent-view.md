# Structured agent view (SDK-driven)

The `structured` agent tab renders a live Claude Code session from the **TypeScript
Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`) as native React UI — streaming
markdown, collapsible tool cards, real diffs, native permission dialogs, a cost/token
turn footer — instead of scraping the terminal. Opt-in alongside the terminal (phases
1–5); slated to become the default agent surface in Phase 6. See
`docs/adr/0001-sdk-structured-agent-view.md` for the decision and
`docs/plans/sdk-structured-agent-view.md` for the phased plan. Design-system/CSS
reference is the sibling doc `agent-view-design.md`.

## Data path

```
main:  @anthropic-ai/claude-agent-sdk query()   src/main/agent-sdk.ts
         │  yields SDKMessage / stream_event
         ▼
       normalizeSdkMessage() (pure)             src/shared/agent-events.ts
         │  → AgentEvent[]  (discriminated union on `type`, {seq,at} per event)
         ▼
       platform.broadcast('agent:event', wsId, event)   platform seam
         │  → Electron window + ui-rpc clients (wired in ui-rpc-protocol.ts)
         ▼
preload: window.orchestra.onAgentEvent(cb)       src/preload/index.ts
         ▼
renderer store: agentSessions[wsId] = foldEvent(prev, event)   src/renderer/store.ts
         │  via a RAF-batched queue (agent-event-queue.ts): one foldEvents/setState per frame
         ▼
       <StructuredView workspaceId>              src/renderer/components/StructuredView.tsx
         → virtualized message list of typed components (components/agent/*)
```

**Reverse path (user → agent):** `window.orchestra.agentSdk*` invoke handlers call into
the live `query` object in main — `agentSdkSend(wsId, text)`, `agentSdkInterrupt(wsId)`,
`agentSdkPermissionReply(wsId, requestId, reply)`, `agentSdkSetModel`,
`agentSdkSetPermissionMode`. Multi-turn uses the **streaming-input pattern**: one
long-lived `query()` per session fed by an async-generator prompt (each follow-up turn
gated on the prior `result`), so the subprocess stays warm and `canUseTool` fires in-loop.

## Key files

- **`src/shared/types.ts`** — the `AgentEvent` discriminated union (on `type`),
  `AgentSession`, `RenderMessage`, `TokenUsage`, `AgentPermissionMode`,
  `AgentPermissionReply`. Blocks keyed by numeric SDK content-block `index`. **Thinking is
  a boolean** (`thinking-start` only) — cleartext thinking is redacted on Opus 4.8
  (verified in `docs/spikes/phase0-sdk-findings.md`).
- **`src/shared/agent-events.ts`** (+ `.test.ts`, 32 tests) — pure `normalizeSdkMessage`
  (SDK message → `AgentEvent[]`) and immutable `foldEvent`/`foldEvents`/`emptySession`/
  `clearPendingPermission`. The renderer store is a pure projection: replaying the event
  stream from `emptySession` rebuilds the view. Testable without Electron.
- **`src/main/agent-sdk.ts`** — per-workspace SDK session manager. Owns the `query`
  object, the async-generator prompt queue, the `canUseTool` bridge (parks the call, emits
  a `permission-request` event, resolves on the renderer's `agentSdkPermissionReply`), and
  lifecycle (lazy start on first `agentSdkSend`, interrupt, `sdkStopMany` teardown on
  workspace delete). **The SDK is pure ESM — loaded via a cached dynamic `import()`, NOT a
  static import** (a static import + vite `external` emits `require()` in the CJS main
  bundle → `ERR_REQUIRE_ESM` boot crash). `buildSdkEnv` (:136) sets only
  `ORCHESTRA_BRANCH`/`KIND` — deliberate for phases 1–5 (the coexisting PTY session drives
  the hooks/events-spool; an SDK session also setting `ORCHESTRA_WS_ID`/`EVENTS_DIR` would
  double-write the spool). **Phase 6 must copy the full `pty.ts` env block** (see plan).
- **`src/renderer/agent-event-queue.ts`** (+ `.test.ts`) — pure RAF-batch queue; coalesces
  a frame of events and folds them in one `setState` (test asserts batched-fold ==
  sequential-fold). ~1600 events/commit under load; holds 60fps at 600+ messages.
- **`src/renderer/components/StructuredView.tsx`** — always-mounted-per-workspace
  virtualized container + composer. Slots: `AgentMessage` (routes tool→`ToolCard` else
  `MessageBubble`), `PermissionDialog`, `AgentControls`, `TurnFooter`.
- **`src/renderer/components/agent/*`** — `MessageBubble` (dep-free markdown +
  Monaco code blocks), `ToolCard`/`ToolDiff` (Edit/Write diffs reconstructed from the
  `tool_use` **input**, not the plain-text `tool_result`), `ThinkingIndicator` (spinner),
  `PermissionDialog` (picks first *unanswered* pending request, not `pending[0]`),
  `AskUserQuestionCard`, `AgentControls`, `TurnFooter`.
- **CSS** — three cascade layers imported in `main.tsx`: `agent-view-defaults.css` (A3
  structural) → `agent-view-structure.css` (A2 layout) → `agent-view-theme.css` (A5 design
  system, wins). Reference: `agent-view-design.md`.

## Channel wiring (to add a new agent broadcast)

`platform.broadcast('agent:event', …)` (seam `src/main/platform/index.ts`) →
`WIRE_EVENT_CHANNELS` row in `src/shared/ui-rpc-protocol.ts` (so ui-rpc/GTK clients get it)
→ `onAgentEvent` in `src/shared/ipc.ts` + preload closure → store subscription.

## Verified SDK behavior (from the Phase 0 spike)

`docs/spikes/phase0-sdk-findings.md` records the verified stream shapes with real event
JSON: token-level `text_delta`, `input_json_delta` (tool-input streaming), `canUseTool`
allow/deny, `interrupt()` (surfaces as the iterator **throwing** → handled as a terminal
`turn-end`/error, not a crash), `settingSources:['user','project']` loading the full
interactive tool set, the `SDKResultMessage` fields, diffs-from-input, streaming-input
multi-turn, and the packaging (SDK + native `claude` binary ship in `app.asar`). Redacted
thinking on Opus 4.8 and frequent transient 500s (arrive as `is_error` result messages) are
documented there.
