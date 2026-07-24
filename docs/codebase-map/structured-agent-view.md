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

**Bash mode (`!command`, parity with Claude Code).** Typing a leading `!` in the
composer switches it into **bash mode** (a purple `bash` chip leads the input, the
send button reads "Run"). On submit the command runs LOCALLY in the workspace's
worktree — never the model — via **`agentSdkRunBash(wsId, command)`** →
`sdkRunBash` (agent-sdk.ts): it `spawn`s `$SHELL -l -c <cmd>` in `ws.worktreePath`
with the session env, captures stdout+stderr (capped at `BASH_OUTPUT_CAP` 30k),
and emits an **`AgentLocalCommandEvent`** (`type:'local-command'`, `{commandId,
command, running, output?, exitCode?}`) — one `running:true` start (spinner row)
then a completion — folded into ONE `local-command` `RenderMessage` keyed by
`bash:<commandId>` (`LocalCommandCard.tsx`). The command+output are ALSO queued on
`session.pendingLocalContext` and prepended to the NEXT real `sdkSend` as a
`<local-command-stdout>` block, so the agent sees what the user ran (CC's
mechanism). A bash run never starts a model turn — the fold leaves `running`/
`turnStartedAt` untouched and `sdkEventToStatusEvent` maps `local-command`→null so
the status dot doesn't move. Sandbox workspaces surface a "not available" notice
(bash runs on the local machine; the sandbox worktree lives in a remote container).

**Reverse path (user → agent):** `window.orchestra.agentSdk*` invoke handlers call into
the live `query` object in main — `agentSdkSend(wsId, text, images?)`, `agentSdkRunBash(wsId, command)`, `agentSdkInterrupt(wsId)`,
`agentSdkPermissionReply(wsId, requestId, reply)`, `agentSdkSetModel`,
`agentSdkSetEffort`, `agentSdkSetPermissionMode`, `agentSdkSetRemoteControl(wsId, enabled)`. Multi-turn uses the
**streaming-input pattern**: one long-lived `query()` per session fed by an async-generator
prompt (each follow-up turn gated on the prior `result`), so the subprocess stays warm and
`canUseTool` fires in-loop.

**Remote Control (parity with Claude Code's `/remote-control`).** The structured
view carries a Remote Control toggle in the deck bar
(`components/agent/RemoteControl.tsx`) that connects the session to Anthropic's
relay so it can be driven from `claude.ai/code` or the Claude mobile app —
Orchestra's parity with the CC app's in-session toggle. `sdkSetRemoteControl(wsId,
enabled)` (agent-sdk.ts) calls the SDK query object's **`enableRemoteControl(enabled,
name?)`** — an internal control-request method present on the concrete `Query`
(sdk.mjs) but NOT in the public `Query` d.ts, so it's typed locally
(`QueryWithRemoteControl`). On enable the worker opens the bridge and returns
`{ session_url, connect_url, environment_id }` (the `claude.ai/code/<id>` link);
disable resolves empty. The manager emits a **`session/remote-control`** event
carrying the full `RemoteControlState` (`{active, sessionUrl?, connectUrl?,
environmentId?, error?, pending?}`, shared/types.ts), folded into
`AgentSession.remoteControl` (full-state replace, so a replay reconstructs the
toggle). Failures (org policy, rollout-not-enabled, network) surface as
`state.error` rather than silently staying off. The account's
`remoteControlAtStartup` setting may auto-enable it at session start, so the
toggle can read active without a user click (verified e2e: full disable→re-enable
round-trip against the live relay flips `active` and mints a fresh `session_url`).

**Peer/queue delivery to a live session:** the lifecycle dispatchers in
`workspaces.ts`/`prompt-queue.ts` (peer `dispatchMessageRequest`, the usage-limit
prompt-queue flusher, `wakeAgentWithPrompt`, account migration) live "below" agent-sdk in
the import graph, so they reach a live structured session through the
**`src/main/sdk-delivery.ts`** seam (a registration indirection that breaks the cycle,
like `sdkStopMany`). agent-sdk registers `{hasSession, send, stop}` at load;
`sdkDeliver(wsId, text)` routes a message/queued prompt to the live session as its next
turn instead of blindly spawning a raw `claude` PTY beside it, and account migration
calls `sdkStopIfLive` so the session doesn't keep running under the old account's
`CLAUDE_CONFIG_DIR`. When no structured session is live these no-op and callers fall back
to the unchanged PTY path.

## Silent-failure hardening + CC/PTY parity (2026-07 gap audit)

A three-axis audit (PTY-vs-structured, silent failures, CC-desktop parity)
closed these gaps — the regression guards live in `agent-events.test.ts`:

- **Notices** — `normalizeSdkMessage` used to consume only 5 of the SDK's ~39
  message variants and silently dropped the rest. Now an **`AgentNoticeEvent`**
  (`type:'notice'`, `kind`: rate-limit / auth / compact-boundary / compact-error
  / refusal / permission-denied / notification / warning / info /
  command-output) surfaces `rate_limit_event`, `auth_status`,
  `system/{compact_boundary, local_command_output, informational, notification,
  permission_denied, model_refusal_*}` as quiet system rows
  (`NoticeRow.tsx`, `.av-notice-*`). **`AgentStatusEvent`**
  (`session/status`, transient — never a transcript row) carries
  `system/api_retry` ("API 529 — retrying in 8s (3/10)") and
  `status:'compacting'`; folded into `session.statusNotice`, shown in the
  running TurnFooter, cleared when output resumes / at turn end.
  **`AgentThinkingTokensEvent`** (`system/thinking_tokens`) drives a live
  "thinking · N tokens" readout while redacted thinking streams nothing else.
  A `status` message's `permissionMode` also emits `session/update` (CLI-side
  mode changes reflect live).
- **Turn-lifecycle ledger close (consume())** — the loop's `catch`/`finally`
  now (a) emits an error for undelivered `session.queue` entries ("N queued
  messages were not delivered"), (b) emits a **synthetic `turn-end`** whenever
  a turn was open (`turnGate` armed) so the pane can never wedge on a
  perpetual "Working…" after the subprocess dies, (c) runs `isBadResumeError`
  on stream-surfaced errors and clears `ws.sdkSessionId` (the resume failure
  surfaces in consume, NOT in sdkSend's catch — ensureSession never awaits the
  subprocess), and (d) keys "interrupted" on `session.interruptRequested`
  (set by sdkInterrupt) instead of matching /abort/ against arbitrary text.
  `session/init` no longer flips `running` — only the `user-message` echo
  opens a turn (a lazy boot from bash mode / Remote Control used to wedge
  "Working…" forever). `sdkInterrupt` with NO live session emits a synthetic
  turn-end so a wedged view self-heals; interrupt failures surface as errors.
- **Externally-originated user text** — stream `user` messages carrying TEXT
  (Remote Control turns typed on claude.ai/mobile, channel/peer injections)
  now emit `user-message` (with an `origin` badge, `.av-message-origin`);
  synthetic frames, subagent sidechains (`parent_tool_use_id`) and
  tool_result-only messages stay filtered. `emitFrom` drops replays matching
  `session.recentEchoes` (belt-and-braces vs future SDK replay behavior).
- **Fold robustness** — the fold's default case tolerates unknown event types
  at runtime (compile-time exhaustiveness kept via a `never` assignment); the
  store's RAF flush try/catches per workspace so one bad event can't discard a
  whole frame for every workspace. Parallel `tool_use` blocks finalize onto
  the FIRST unfinalized streaming row (the old last-match rule swapped
  names/inputs across parallel calls).
- **Bash mode hardening** — `sdkRunBash` kills the child on output-cap
  overflow and on a 5-min timeout (`BASH_TIMEOUT_MS`), so a hung `tail -f`
  can't spin forever; `pendingLocalContext` is capped (`LOCAL_CONTEXT_CAP`,
  oldest dropped) so N bash runs can't blow the next turn's context.
- **`/clear` + `/compact`** — the composer intercepts `/clear` →
  `agentSdkClear` (`agent:sdkClear` → `sdkClear`): stops the session with
  `session.cleared` suppressing its tail events, persists `sdkSessionId: ''`
  (the explicit cleared marker that also disables sdkHistory's newest-.jsonl
  fallback), and broadcasts **`session/clear`** (fold → `emptySession`).
  `/compact` (and any built-in) is sent through — the CLI executes it and the
  new status/compact-boundary/command-output events render the result. The
  composer autocomplete merges on-disk skills with `session.slashCommands`
  (now captured from init, along with `session.mcpServers`).
- **CC-desktop parity in the UI** — `ContextGauge` in TurnFooter ("N% context
  left", amber ≤25% / red ≤10%, from turn-end's `contextWindow`/
  `contextUsedTokens` lifted off `modelUsage`); **Esc interrupts** the
  in-flight turn from the composer; **drag-and-drop** files onto the composer
  (images → attachments, other files → absolute path inserted);
  **ExitPlanMode renders a plan-review card** (markdown plan +
  Keep planning / Approve·accept edits / Approve&run, the latter two calling
  `agentSdkSetPermissionMode`) instead of the generic raw-JSON dialog.
- **Misc surfacing** — setModel/setEffort/setPermissionMode live-apply
  failures emit a warning notice (the dropdown no longer silently lies);
  history backfill logs read failures, renders a "couldn't load history"
  notice on IPC rejection and an "earlier history not shown" marker on the
  4MB tail cut; BackgroundTasksPanel's "View transcript" reports a missing
  file ("Transcript unavailable") instead of a dead click; the unreachable
  "API error — retrying" footer branch was removed (mid-turn retries surface
  via `statusNotice`). `switchWorkspaceBranch` (workspaces.ts) now calls
  `sdkStopIfLive` so a live structured session can't keep stale branch context.

## Key files

- **`src/shared/types.ts`** — the `AgentEvent` discriminated union (on `type`),
  `AgentSession`, `RenderMessage`, `TokenUsage`, `AgentPermissionMode`,
  `AgentPermissionReply`. `AgentSession` also carries **`turnStartedAt?`** (epoch
  ms the current turn started, set on `user-message`/`session/init`, cleared at
  `turn-end`) and **`liveOutputChars`** (assistant output chars streamed this
  turn, reset at turn start) — the two fields that back the TurnFooter's live
  elapsed timer + live token estimate. Blocks keyed by numeric SDK content-block `index`. **Thinking is
  a boolean** (`thinking-start` only) — cleartext thinking is redacted on Opus 4.8
  (verified in `docs/spikes/phase0-sdk-findings.md`). **Background tasks:** an
  `AgentTaskEvent` variant (`type:'task'`, `kind: started|progress|updated|
  notification|changed`) carries the SDK's Task-subagent lifecycle; the folded
  `BackgroundTask` (id, description, status, `AgentTaskUsage`, lastToolName,
  summary, outputFile, startedAt/endedAt) lives on `AgentSession.tasks`
  (`Record<id, BackgroundTask>`, first-seen order).
- **`src/shared/agent-events.ts`** (+ `.test.ts`) — pure `normalizeSdkMessage`
  (SDK message → `AgentEvent[]`) and immutable `foldEvent`/`foldEvents`/`emptySession`/
  `clearPendingPermission`/`makeUserMessage`. The renderer store is a pure projection:
  replaying the event stream from `emptySession` rebuilds the view. Testable without
  Electron. **A message's `id` NEVER changes once created** — it is the React key
  and the virtualizer's measured-height cache key, so a rewrite unmounts+remounts
  the row (and the whole ToolGroup when it's the run's first tool) mid-stream:
  the tool-card flicker bug. To keep tool ids stable, `block-start` for
  `tool_use` lifts the stream's `content_block.id`/`name` (normalizeStreamEvent
  + agent-transcript backfill) so the fold mints the message with its FINAL id
  (`toolu_…`) and real name up front (the collapsed run label reads "Ran a
  command…" while the input is still streaming), and the finalizing `tool-use`
  fold matches by `toolUseId` and updates IN PLACE — it never rewrites an
  existing `id` (guarded by agent-events.test.ts id-stability tests; verified
  e2e: same DOM node across finalize). **Background-task normalization** (`normalizeTaskSystem`) maps the SDK
  `system`/`task_started|task_progress|task_updated|task_notification` messages and
  the `background_tasks_changed` level signal into `AgentTaskEvent`s; `foldTaskEvent`
  merges them into `session.tasks` — `started` creates, `progress`/`updated` merge,
  `notification` finalizes (status + duration + `output_file` transcript path), and
  `changed` reconciles the running set (any still-`running` task absent from the live
  ids is finalized to `stopped`, so a missed finish bookend can't wedge a stuck card;
  it never resurrects a finished task nor creates one). Out-of-order tolerant (a
  `progress` before its `started` backfills). **User prompts are echoed as a `user-message` event** emitted by `sdkSend`
  (agent-sdk.ts) — the SDK stream never repeats plain user text (its `user` messages
  only carry `tool_result` blocks), so without this event a sent prompt would never
  appear in the transcript. The fold also flips `running: true` on it so the
  interrupt/footer react before the first SDK event lands. **Pasted images** ride
  the same path: `AgentImage[]` (`{mediaType,dataBase64}`, shared/types.ts) on
  `agentSdkSend`/`AgentUserMessageEvent`/`makeUserMessage`/`RenderMessage.images`.
  When present, `sdkSend` builds the SDK `content` as an array of `image` (base64
  source) + `text` blocks instead of a bare string; the echo carries the images so
  the user bubble renders them (MessageBubble `.av-message-image`).
- **`src/main/agent-sdk.ts`** — per-workspace SDK session manager. Owns the `query`
  object, the async-generator prompt queue, the `canUseTool` bridge (parks the call, emits
  a `permission-request` event, resolves on the renderer's `agentSdkPermissionReply`), and
  lifecycle (lazy start on first `agentSdkSend`, interrupt, `sdkStopMany` teardown on
  workspace delete). **The SDK is pure ESM — loaded via a cached dynamic `import()`, NOT a
  static import** (a static import + vite `external` emits `require()` in the CJS main
  bundle → `ERR_REQUIRE_ESM` boot crash). **`settingSources` is
  `['user','project','local']`** — the `'local'` source (`.claude/settings.local.json`)
  is where Orchestra installs EVERY per-workspace hook (auto-rename nudge, inbox
  delivery, comms-resurface, orchestrator reminder, field-guide, activity spool), so
  omitting it (the pre-fix `['user','project']`) silently disabled all of them in
  structured mode — the branch never auto-renamed and peer messages never reached the
  agent. The terminal path spawns `claude` with no source restriction, so it loads all
  three by default; matching it requires `'local'`. `buildSdkEnv` sets
  `ORCHESTRA_BRANCH`/`KIND` **plus `ORCHESTRA_BRANCH_AUTO`/`AUTO_RENAME_COUNT`** (the
  rename-hook's gate/stage vars, from `autoRenameActive(ws)`), the spool-free identity
  plumbing, and **sets `ORCHESTRA_WS_ID`/`EVENTS_DIR` ONLY when no terminal PTY is
  running for the workspace** (`isPtyRunning(ws.id)`, sampled once at spawn). It returns
  that decision as **`ownsSpool`** — the single-writer key for the **sidebar status dot**:
    - **`ownsSpool=true`** (no coexisting PTY): the SDK subprocess got `ORCHESTRA_WS_ID`,
      so ITS own shell lifecycle hooks (UserPromptSubmit/PreToolUse/PostToolUse/Stop) fire
      and write `submit`/`pretool`/`stop` spool lines that the tailer replays into
      `applyAgentEvent` — the terminal path's mechanism, reused as-is.
    - **`ownsSpool=false`** (a terminal/Raw PTY coexists, so `ORCHESTRA_WS_ID` is withheld):
      the SDK's hooks no-op, and that PTY is usually an **idle Raw tab** running no turns, so
      NOBODY writes the running/tool/turn-end spool lines and the dot stuck `idle` while the
      SDK worked (the reported bug — verified live: the PTY-coexist spool held only
      `session/startup`). Here **the dot is driven directly from the SDK event stream:**
      `emitFrom`/`sdkSend` call `driveStatusFromEvent` (agent-sdk.ts), which maps each
      `AgentEvent` onto the same spool event via the pure `sdkEventToStatusEvent`
      (agent-events.ts, unit-tested): `user-message`→`submit`, `tool-use`→`pretool`,
      `tool-result`→`posttool`, `permission-request`→`notify`, `turn-end`→`stop`.
  So exactly ONE writer drives the dot per session (gate is `session.ownsSpool`, fixed at
  spawn — NOT a per-event `isPtyRunning` read, which both missed the PTY-coexist case and
  double-drove the no-PTY case). Remote/sandbox sessions never direct-drive (their dot comes
  from the container's spool tail via sandbox-manager). Verified e2e on the built app: dot
  flips `idle→running→waiting` in both the no-PTY and PTY-coexist cases, with the spool
  never double-written. **Identity is decoupled
  from that spool gate**: `buildSdkEnv` ALSO sets `ORCHESTRA_WS_ID_IDENTITY = ws.id`
  **unconditionally**, and the CLI's `resolveSelfWorkspaceId` (`cli/index.ts`) falls
  back to it when `ORCHESTRA_WS_ID` is withheld — so `orchestra rename`/`peers`/
  `message`/`spawn` work in a structured session even while a PTY owns the spool
  (previously the rename hook's `orchestra rename "$ORCHESTRA_WS_ID" …` collapsed to
  one arg → `usage:` error). The spool hook (`ORCHESTRA_HOOK_SCRIPT`) gates only on
  `ORCHESTRA_WS_ID` and never reads the identity var; note `ORCHESTRA_EVENTS_DIR`
  alone can't decouple them since the hook defaults it to the same `getEventsDir()`
  path. An **orchestrator** workspace
  also gets its standing brief appended to the Claude Code system prompt on a FRESH
  session (`systemPrompt: {preset:'claude_code', append: ORCHESTRATOR_BRIEF}`, gated on
  `!ws.sdkSessionId` so a resume doesn't duplicate it) — parity with the terminal path's
  `--append-system-prompt`. When the consume loop ends/throws, a `reconcileExited(wsId)`
  floor (guarded on no live PTY) self-heals a stuck `running` status dot, mirroring the
  PTY exit handler. The terminal PTY
  lazy-starts just when the Terminal tab is opened (`Terminal.tsx allowStartRef`), so
  a structured-only session safely owns the spool; a live PTY keeps ownership and the
  SDK session stays spool-free — avoiding the double-writer that corrupts the dot's
  per-`wsId` `seq` counter. **Phase 6 makes the two mutually exclusive** (don't start
  the PTY when structured is default) so the gate is always satisfied — see plan.
- **`src/renderer/agent-event-queue.ts`** (+ `.test.ts`) — pure RAF-batch queue; coalesces
  a frame of events and folds them in one `setState` (test asserts batched-fold ==
  sequential-fold). ~1600 events/commit under load; holds 60fps at 600+ messages.
- **`src/renderer/components/StructuredView.tsx`** — always-mounted-per-workspace
  virtualized container + composer. It folds the flat `RenderMessage[]` into
  **render items** (`buildRenderItems`): a run of consecutive `tool` messages
  becomes ONE `tool-group` item, every other message its own item; virtualization
  windows over items so a collapsed tool run is a single measured row. **A new
  row's FIRST height measurement flushes synchronously** (setState inside
  MeasuredRow's layout effect → re-render before paint): until measured, offsets
  use `ESTIMATED_ROW_H` (72px), and letting that estimate paint made the pinned
  viewport overshoot by the error and correct a frame later — a per-new-row
  vertical bounce that read as flicker whenever a tool row landed (verified e2e:
  scrollHeight now monotonic, 0px drop while pinned; resizes of already-measured
  rows still coalesce via `scheduleMeasureFlush`). Items route
  through `ItemSlot` → `ToolGroup` (tool runs) or `AgentMessage`
  (`MessageBubble`, else a lone `ToolCard`). The list **opens scrolled to the last
  message** (an `initialPin` ref force-scrolls to bottom across the async
  height-settle passes). **Follow-mode (stick-to-bottom during streaming)** is
  driven by a **`ResizeObserver` on the sized inner wrapper** that calls
  `pinToBottom` the instant the rendered content grows (typewriter reveal, async
  row re-measure, new row) — NOT the coalesced `measureTick` RAF, which lagged the
  follow scroll ≥1 frame behind and let the viewport fall progressively behind fast
  output (the "accumulating scroll lag" bug). `pinToBottom` uses
  `scrollTo({behavior:'instant'})` to override the stylesheet's
  `scroll-behavior: smooth` — a bare `scrollTop=` (or `behavior:'auto'`) would
  animate the jump and, because content grows every frame, forever chase a moving
  target. Follow-mode releases **only on a genuine user scroll-UP**, detected by
  `scrollTop` DECREASING vs the previous value (`lastScrollTop`) — a pin or a
  content-growth reflow never moves scrollTop up, so this is immune to the
  pin-vs-growth race a naive `atBottom` threshold got wrong (it read the few px a
  row grew between the pin and its `scroll` event as "user scrolled up" and
  disengaged follow mid-stream). Verified e2e (CDP under headless sway) against a
  positive control: baseline streamMaxGap ~6666px vs fixed 0px, with user
  scroll-up still releasing (a real wheel event leaves the viewport where the user
  put it while more text streams in). The **composer** auto-grows and accepts **pasted images**
  (`onPaste` → base64 via FileReader → thumbnail strip → sent on submit as
  `AgentImage[]`). Slots: `PermissionDialog`, `AgentControls`, `TurnFooter`,
  **`BackgroundTasksPanel`**. A floating top-right **toggle** (`av-bgtask-toggle`,
  running-count badge) appears once `session.tasks` is non-empty and opens/closes
  the panel; the panel **stays closed by default** when a task spins up (it never
  steals the transcript view) — the toggle + badge surface the task and the user
  opens the panel on demand (`panelOpen` is fully user-owned).
- **`src/renderer/components/agent/BackgroundTasksPanel.tsx`** — the right-side
  slide-over listing the session's background tasks (Task-tool subagents, shells,
  monitors, workflows), mirroring the Claude Desktop app. Reads `session.tasks`;
  Running/Finished groups with header counts; each **card** shows title, task-type
  label, live elapsed (a 1s `setInterval`, active only while a task is running),
  `usage` tokens + tool-uses, `lastToolName`, an optional progress `summary`, and a
  **"View transcript"** button that calls `window.orchestra.agentSdkOpenTaskTranscript`
  on the task's `outputFile`. `runningTaskCount`/`totalTaskCount` helpers drive the
  toggle. CSS lives in `agent-view-theme.css` (`av-bgtask-*`; the `--av-task`
  accent-2 token). Pinned inside `.av-view` (position:absolute/inset:0) as an overlay.
- **`src/renderer/components/agent/ToolGroup.tsx`** — the aggregated tool run,
  rendered in the **Claude-Code-desktop compact style**: EVERY tool run (even a
  single tool) collapses to ONE quiet, muted, **borderless** one-line row —
  chevron + deduped tool-icon strip + a **verb label** (`describeToolRun`) +
  inline **red/green diff counts** (`aggregateDiff`) + a live status dot while
  running. There is no card frame at rest, so the row recedes behind the
  assistant's prose; expanding reveals the individual `ToolCard`s inside a framed
  `.av-tool-run-body`. The verb label groups by ACTION, not tool name — "Created
  5 files", "Read 3 files", "Ran a command, used a tool", "Used 6 tools" (a
  single create/read names the file: "Created types.ts"). `describeToolRun` /
  `aggregateDiff` / `diffCounts` / `fileBase` are pure helpers in **`tool-util.ts`**
  (unit-tested in `agent-components.test.ts`). A lone tool is NO LONGER a plain
  `ToolCard` — the only exception is `isStandaloneTool` (TodoWrite), which
  `buildRenderItems` breaks out as its own always-open `ToolCard`. The legacy
  name-count `summarizeToolRun` ("2 Read · 1 Bash") is retained (exported, unused
  by the UI) for any caller wanting the per-name breakdown. CSS: `.av-tool-run*`
  (replaced the old `.av-tool-group*`).
- **`src/renderer/components/agent/*`** — `MessageBubble` (renders text via
  `MarkdownView`; renders `null` when a message has no text and isn't thinking;
  **streaming assistant text reveals via a typewriter** — `useTypewriter` +
  the pure `renderer/typewriter.ts` scheduler decouple bursty SDK arrival from
  display by revealing a growing prefix at a steady frame-paced, backlog-adaptive
  cadence, so output flows fluidly instead of snapping in chunk-by-chunk.
  **A finished block DRAINS, never snaps**: at live rates (~250 ch/s arriving vs
  the ~150 ch/s base reveal) the typewriter runs a ~80-char backlog, and the old
  `done → snap to full` rule dumped that tail in ONE frame at every block
  boundary — exactly when a tool card pops in below, the "sudden output /
  instant jump when tool cards appear" bug. Now `done` switches the scheduler to
  `FINISH_TYPEWRITER` (typewriter.ts: overflow drain from backlog 0 — ~80 chars
  over ~7 frames ≈ 115ms, still `maxCharsPerFrame`-capped) and the loop stops
  once caught up; `MarkdownView` keeps the streaming treatment (tail remend)
  until the shown prefix reaches the full text. Only messages that mount
  already-`done` (history backfill, remounted rows) render in full instantly —
  the hook captures done-at-mount (finished/user/system/error text and SSR
  render in full). The revealed prefix still goes through the block-split
  `MarkdownView` so per-frame render stays cheap. Verified e2e at the real
  operating point (28-char deltas / 120ms): backlog 72 at block-stop drained
  over 7 frames, max 24 ch/frame),
  **`MarkdownView.tsx`** (full CommonMark + GFM via **react-markdown + remark-gfm** —
  tables, strikethrough, task/nested lists — replacing the former hand-rolled dep-free
  subset parser that silently dropped all of those, the "bad markdown reader"; fenced
  blocks route to `CodeBlock`. **Streams smoothly via block-level memoization**: instead
  of re-parsing/re-reconciling the whole accumulated markdown every frame — which grows
  with message length and, past a few KB, blows the 16ms frame budget so text arrives in
  visible *blocks* — it splits the text into top-level blocks
  (`src/shared/markdown-blocks.ts`, fence-aware, `join('')===text` round-trip) via
  `partitionStreamingMarkdown`, renders each already-final block as its own memoized
  `MarkdownBlock` keyed by content (React reuses those DOM subtrees), and re-renders only
  the growing tail block per frame — bounding per-frame work to the current paragraph.
  Measured: a 15.8KB message drops from a ~22ms worst frame to ~1.7ms. Verified by the
  `__smoke__` harness's block-split-vs-naive equivalence checks at every streaming prefix.
  **Dangling inline tokens** are closed by **`remend`** (zero-dep, Apache-2.0) applied
  ONLY to the still-streaming tail block, so a half-written `**bold` / `[link` /
  `` `code `` renders formatted instead of flashing raw markers; stable blocks and
  `done` messages skip it (complete by construction). This is an INLINE-only fix —
  CommonMark already handles unterminated BLOCK constructs correctly (verified: an
  unclosed ```` ``` ```` fence and a partial GFM table both parse fine), which is why the
  common "streaming parsers break on unterminated fences" claim does not apply here.
  Note `remend` marks an unfinished link with `href="streamdown:incomplete-link"`, but
  react-markdown's protocol allowlist rejects that unknown scheme and rewrites it to an
  **empty string** before the `a` component sees it — so `isIncompleteLink` tests for a
  falsy href, and such links render as plain text until the URL arrives),
  **`CodeBlock.tsx`** (syntax highlighting via
  **Shiki** — `shiki-highlighter.ts` — not Monaco: a static highlighted-HTML surface,
  far lighter on the streaming hot path; highlights ONLY a finalized block, showing
  plain mono while `done===false` so a token delta never re-highlights),
  **`shiki-highlighter.ts`** (lazy singleton via the fine-grained `createHighlighterCore`
  + JS regex engine + **dynamically-imported** curated grammars/`github-dark`/`-light`
  themes — so none of Shiki's registry lands in the main renderer chunk; it splits into
  async chunks fetched on first highlight),
  `ToolCard`/`ToolDiff` (Edit/Write change info reconstructed from the `tool_use` **input**,
  not the plain-text `tool_result`; per-tool SVG icons in `tool-icons.tsx`; **ToolDiff
  renders a one-line summary — file path · kind · +added/−removed — NOT a full editor**.
  Monaco was removed from the app entirely: it was the heaviest thing this view mounted
  and the dominant driver of the GPU-process-crash black screen. No Diff tab in the
  Electron renderer anymore either),
  `ThinkingIndicator` (shimmer label), `PermissionDialog` (picks first *unanswered*
  pending request, not `pending[0]`; on reply calls `onReplied(requestId)` so the
  store clears the entry — see below), `AskUserQuestionCard` (**pages
  multi-question requests one at a time — Back/Next/step-dots — so the dialog
  never overflows the viewport; single questions render directly**),
  `AgentControls`,
  **`TurnFooter`** (turn cost/token/duration once a turn ends; while a turn is in
  flight it renders the **real-time "working" readout** — animated spark icon,
  **elapsed time counting up** from `session.turnStartedAt`, and a **live token
  estimate** from `session.liveOutputChars` (~chars/4) that ticks up and snaps to
  the exact `lastTurn.usage.outputTokens` at turn-end. A `useTick` hook
  re-renders it every second while `session.running`. The SDK stream carries no
  live duration/usage, so both live values are derived in the renderer — the
  duration is exact, the token count is approximate-until-close by construction),
  plus `agent-theme.ts` (a dependency-free `useAgentTheme` hook returning
  `'dark'|'light'` off the `data-agent-theme` attribute, used to pick the light/dark
  Shiki theme — formerly monaco-theme.ts, now Monaco-free).
- **`src/shared/agent-transcript.ts`** (+ `.test.ts`) — pure converter from the on-disk
  Claude Code session JSONL to `AgentEvent[]` (**history backfill**). On-disk lines
  differ from the live stream: assistant text is finalized (no stream_events → we
  synthesize block-start/delta/stop triplets at indexes ≥100k), there are no `result`
  lines (one quiet terminal `turn-end` is appended), and `isSidechain: true` lines
  (Task-subagent transcripts) are skipped. **A user turn's `image` content blocks are
  reconstructed into the `user-message`'s `images`** (Messages-API `{source:{base64}}`
  shape → `AgentImage[]`), so pasted images survive a reopen — the live echo carried
  them but the backfill formerly dropped `image` blocks, so they vanished on reload.
  `agent-sdk.ts sdkHistory(wsId)` locates the
  file (`<configDir>/projects/<mangleProjectDir(worktreePath)>/<sdkSessionId>.jsonl`,
  tail-capped at 4MB) and StructuredView requests it once per mount while the folded
  session is empty, folding events through the normal RAF queue.
- **Skills autocomplete** — `agent-sdk.ts sdkListSkills(wsId)` scans the worktree's
  `.claude/skills/*` + the account config dir's `skills/*` (project shadows user) for
  `AgentSkillInfo` (shared/types.ts); the Composer shows a popover when the input is a
  pure `/prefix` (Tab/Enter complete, arrows navigate, Esc dismisses).
- **Resume durability across reboot / internet loss.** A structured session is
  NOT a live process that survives a restart — it's a *resume by id*. The SDK
  session id is captured from the stream (`consume()`) and persisted to the
  on-disk store as `ws.sdkSessionId` (types.ts); the next `sdkSend` passes
  `resume: ws.sdkSessionId` (ensureSession) with `cwd: ws.worktreePath`, so the
  same conversation continues on the same worktree. Resume is **lazy** (fires on
  the next send, not at app launch) and a turn interrupted by the cut is lost.
  On a *failed* resume, `sdkSend` clears `ws.sdkSessionId` (→ next send starts
  blank) **only when `isBadResumeError(message)` (agent-events.ts) matches** —
  i.e. the id is genuinely bad (`Session <id> not found` / `Invalid sessionId` /
  `No conversation found`, verified against `sdk.mjs`). A TRANSIENT failure
  (network loss on reboot/internet drop, 500, abort) PRESERVES the id so a later
  send resumes the same conversation. The prior rule cleared on any error but
  "directory not found", which silently discarded a good session id on exactly
  the internet-loss case (guarded by `agent-events.test.ts`).
- **Permission-mode default is `bypassPermissions`** (ensureSession + emptySession +
  AgentControls fallbacks) — parity with the terminal path's autonomous agents;
  a persisted `ws.sdkPermissionMode` still wins. **Exception: `AskUserQuestion`
  always parks for a real reply, in every mode** — the pure
  `shouldAutoApprovePermission(mode, toolName)` (agent-events.ts) excludes it from
  the bypass auto-approve path. Bypass skips approval of the agent's *actions*, not
  a question addressed to the user; auto-approving AskUserQuestion resolves the
  tool with no `answers`, so the harness returns "The user did not answer the
  questions" and the prompt appears to auto-close (guarded by
  `agent-events.test.ts`).
- **Answered permissions are cleared from the STORE, not just the dialog.**
  `sdkPermissionReply` (agent-sdk.ts) resolves the parked `canUseTool` call but
  emits NO event, so the folded `session.pendingPermissions` would otherwise
  hold the answered request until the next `turn-end` clears it. For an
  AskUserQuestion answered mid-turn, that leaves the request pending in the store
  while the turn keeps running — and `PermissionDialog`'s local `answered` set
  (a `useState`) resets whenever the dialog unmounts (e.g. leaving to the
  Resources page / no active workspace, which unmounts `StructuredView` at
  App.tsx `loaded && active && …`), so the stale prompt **reappeared on return**.
  Fix: `PermissionSlot` passes `onReplied` → the store's `resolveAgentPermission`
  action (store.ts) folds `clearPendingPermission` immediately, making the clear
  durable across remounts (the store is the source of truth). Verified with a
  discriminating CDP mutation test (inject AskUserQuestion → answer → unmount via
  Resources → remount: modal must NOT reappear and `pendingPermissions` must be 0).
- **Parked-prompt status dot** — when `makeCanUseTool` (agent-sdk.ts) parks ANY
  interactive tool call (AskUserQuestion, or an allow/deny permission prompt in a
  non-bypass mode) it calls `fireNeedsInput(wsId)` (activity.ts) to flip the
  sidebar dot to `waiting` (orange) + raise the "needs input" toast/chime,
  matching the terminal path's Claude Code `Notification` hook. This is needed in
  BOTH spool cases and does NOT overlap `driveStatusFromEvent`: the park event is
  `emit()`ed directly from `makeCanUseTool`, never through `emitFrom` →
  `driveStatusFromEvent`, so `sdkEventToStatusEvent`'s `permission-request→notify`
  mapping is unreachable for a real park — and the SDK subprocess's own Claude
  Code `Notification` hook does NOT fire for a programmatic `canUseTool` park
  (verified e2e: on master alone the no-PTY dot stuck `running` with a pending
  permission). So `fireNeedsInput` here is the sole driver of the parked-question
  dot. The parked promise is wrapped so EVERY exit (renderer reply via
  `sdkPermissionReply`, interrupt-abort, or the turn-end sweep in `consume()`)
  calls `resumeRunning(wsId)` — a guarded `waiting → running` flip (no-op unless
  currently `waiting`, so it never resurrects an idle/stopped session or fights a
  live PTY owner or `driveStatusFromEvent`'s own transitions).
- **`AvMenu`** (`components/agent/AvMenu.tsx`) — the custom dropdown replacing native
  selects in AgentControls (portalled glass panel; see agent-view-design.md).
- **`EffortSlider`** (`components/agent/EffortSlider.tsx`, pure logic in
  `effort-util.ts` + tests) — the deck bar's reasoning-effort control, modeled
  on the Claude Code desktop popover: ghost trigger (gauge icon + level label)
  → portalled glass panel ("Effort <Level>", Faster/Smarter, a five-stop
  low→max slider). The thumb tracks the pointer 1:1 while dragging
  (`.av-effort-dragging` kills the CSS transition) and snaps to the nearest
  stop with a short ease on release/click; header + description preview the
  would-be level during the drag, and the choice commits on release only.
  Keyboard: `role="slider"`, arrows/Home/End. The value is **`ws.sdkEffort`**
  (persisted like `sdkPermissionMode`; unset = the model default `high` —
  `DEFAULT_EFFORT`) — the SDK stream never reports effort back, so no
  `AgentSession` field / `session/update` variant exists for it; reactivity
  rides the `workspace:update` broadcast from `persistWorkspacePatch`.
  `sdkSetEffort(wsId, effort)` (agent-sdk.ts) persists + live-applies via the
  SDK's `applyFlagSettings({effortLevel})` (accepts `'max'`, which CC's own
  settings file can't persist — Orchestra's store can, and `ensureSession`
  re-applies it at start via `options.effort`). Unsupported levels are silently
  downgraded per model by the CLI, so the slider always offers all five. CSS:
  `av-effort-*` in agent-view-theme.css (raw dark-glass — portalled outside
  `.av-view`), blur killed in agent-view-flat.css.
- **`model-util.ts`** (`components/agent/`, + tests in `agent-components.test.ts`) —
  pure, React-free model-switcher data/logic so `node --test` can exercise it.
  `MODEL_CHOICES` is the switcher's model list (**Fable 5, Opus 4.8, Sonnet 5,
  Haiku 4.5**; canonical aliases, never date-suffixed) — `AgentControls` zips it
  with `MODEL_ICONS` into `AvMenuItem`s. `describeLiveModel(id)` renders a model
  the list has no card for into a friendly `{label, description}`: it strips a
  bracketed context suffix (`[1m]`/`[200k]` → "· 1M context"), maps Claude Code
  short aliases (`opus`→`claude-opus-4-8`, `sonnet`/`haiku`/`fable`) to a card,
  and reuses that card's label — so `opus[1m]` / `claude-opus-4-8[1m]` both read
  "Opus 4.8 · 1M context". Unknown ids fall back to the raw string. The
  `model`-not-in-list branch in `AgentControls` prepends the result as a `gear`
  fallback item.
- **Account-default model in the switcher (pre-session).** Before a turn starts
  there's no `session.model`; rather than an opaque placeholder, `AgentControls`
  fetches the model a fresh session *will* run on via **`agentSdkDefaultModel`**
  (`agent:sdkDefaultModel` → `sdkDefaultModel(wsId)` in agent-sdk.ts) and shows it
  (through `describeLiveModel`). The resolver returns an explicit `ws.model` if set,
  else reads Claude Code's `settings.json` `model` in the SDK's load precedence
  (`['user','project','local']`, last wins): worktree `.claude/settings.local.json`
  → worktree `.claude/settings.json` → the pinned account config dir's
  `settings.json` (default `~/.claude`). The stored value is an ALIAS
  (`opus[1m]`), which the SDK resolves to a full id (`claude-opus-4-8[1m]`) only at
  `session/init` — so `describeLiveModel`'s alias map is what lets the pre-session
  trigger read the same friendly label. Returns `''` when nothing configures it
  (the CLI's own built-in default, resolvable only once a session inits) — the
  `"Account default"` placeholder remains only in that case. **Display precedence
  gates on `session.sessionId`** (`effectiveModel` in model-util.ts): a folded
  session's model/permissionMode count only once `session/init` actually landed —
  a history-backfilled session (reopened workspace, no live subprocess) folds
  from `emptySession` with placeholder `model:''` / `permissionMode:bypass`, and
  `session?.model ?? wsModel` never falls through `''`, so those placeholders
  used to mask a freshly-picked `ws.model`/mode (selection looked like a no-op —
  the v0.5.153 bug, fixed v0.5.154, e2e-proven via `__injectAgentEvent`).
- New IPC: `agentSdkSetEffort` (`agent:sdkSetEffort`), `agentSdkHistory` (`agent:sdkHistory`), `agentSdkDefaultModel`
  (`agent:sdkDefaultModel`), `agentSkills` (`agent:skills`),
  `agentSdkOpenTaskTranscript` (`agent:sdkOpenTaskTranscript`) — opens a finished
  task's `output_file` transcript with the OS handler (`platform.openPath`, guarded
  to a real file; returns `false` when missing), like `openSelfTuneReport`.
- **`agent-sdk.ts` sets `agentProgressSummaries: true`** in the `query` options so
  the SDK emits one-line `task_progress.summary` strings for running subagents
  (drives the card summary line; fork reuses the subagent's model + prompt cache,
  ~free). The `task_started`/`task_progress`/`task_notification` heartbeats fire
  regardless; this only adds the human-readable summary.
- **`session/update` event** — `sdkSetModel`/`sdkSetPermissionMode` emit it so the
  folded `session.model`/`permissionMode` (otherwise set only once by `session/init`)
  reflect a live switch; without it the AvMenu trigger snapped back to the init value
  on a running session.
- **CSS** — three cascade layers imported in `main.tsx`: `agent-view-defaults.css` (A3
  structural) → `agent-view-structure.css` (A2 layout) → `agent-view-theme.css` (A5 design
  system, wins). Reference: `agent-view-design.md`.

## Availability by workspace kind

The structured view is available for **every** workspace kind — `worktree`
(including promoted `canOrchestrate` worktrees), `scratch`, AND `orchestrator`.
The main-process SDK path is kind-agnostic: `ensureSession` never checks
`ws.kind`/`isScratchLike`, `buildSdkEnv` derives everything from
`ws.branch`/`ws.worktreePath`/`ws.id` (scratch and orchestrator dirs live under
`~/.orchestra/scratch` and get `installOrchestraHooks` at creation, so their
`.claude/settings.local.json` carries the same comms/inbox/rename/spawn hooks),
and orchestrator sessions additionally get the `ORCHESTRATOR_BRIEF` appended
(agent-sdk.ts, `ws.kind === 'orchestrator'`). The renderer used to hide the
Structured tab + component for `isScratchLike` workspaces (App.tsx) — that gate
was removed; only the **git-only** surfaces (Run, Diff, PR) stay gated off for
scratch-like. So an orchestrator can coordinate (brief, `orchestra`
CLI = rename/peers/message/spawn/promote/attach, skills, peer-comms delivery via
`sdk-delivery.ts`) entirely from the structured view, at parity with the
terminal path.

## Default-view preference (Phase 6)

- **`src/renderer/default-agent-view.ts`** (+ `.test.ts`) — pure, localStorage-backed
  preference (`orchestra:defaultAgentView`, **default `'structured'`** — the SDK pane
  is the primary surface; only an explicit `'terminal'` opts back into the classic
  TUI, and `terminalTabLabel` then relabels that tab "Raw"). `readDefaultAgentView()`
  seeds the store's initial `view` (store.ts); `terminalTabLabel()` relabels the embedded
  terminal tab to **"Raw"** when structured is the default. Toggled via
  **`src/renderer/components/AgentViewSettings.tsx`** (a sidebar Settings modal, opened from
  Sidebar.tsx next to the sound-settings button).
- **`buildSdkEnv`** (`agent-sdk.ts`) sets the identity plumbing
  (`ORCHESTRA_WORKTREE`/`ORCHESTRA_SOCK`/PATH shim) and — when no terminal PTY is
  running for the workspace (`isPtyRunning(ws.id)`) — the events-spool trigger
  `ORCHESTRA_WS_ID`/`ORCHESTRA_EVENTS_DIR`, returning that decision as `ownsSpool`. That
  flag is the single-writer key for the status dot (see the `driveStatusFromEvent`
  discussion above): `ownsSpool=true` → the SDK's own hooks + the spool tailer drive it;
  `ownsSpool=false` → the SDK direct-drives it. Phase 6's default-flip (no PTY when
  structured is default) makes `ownsSpool` reliably true. The SDK session also inits its
  model from `ws.model`.

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
