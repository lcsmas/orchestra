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
         │  → the Electron window
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

**Rewind a message (parity with Claude Code's double-Esc restore).** Hovering a
user bubble reveals a **Rewind** control (`components/agent/RewindControl.tsx`,
`.av-rewind*`) — a ghost action row hanging below the bubble's bottom-right edge
(`.av-message-actions`, chosen from five mocked placements; the bubble reserves
the row's height so revealing it never reflows) — that undoes that turn: its file edits are restored AND the
conversation is truncated back to before it, with the message's text returned to
the composer for **edit-and-retry**. Three SDK primitives back it, and the
measured semantics are recorded in `docs/spikes/rewind-sdk-findings.md`:

The confirmation panel (`.av-rewind-pop`) is **portalled to `<body>`** with fixed
positioning anchored to the trigger (`RewindControl.tsx`), flipping above the
trigger when there is no room below. It has to be portalled: the bubble lives
inside `.av-message-list`, the `overflow:auto` scroller, so an in-flow panel is
clipped at the scroller's edge and then overpainted by `.av-composer` (a later
sibling) — neither of which a z-index inside the list can beat. The portal root
carries `av-view` (where the `--av-*` palette is declared) plus the live
`data-agent-theme`, because an earlier `<body>` portal without that scope
resolved its background to `rgba(0,0,0,0)`. `.av-rewind-portal` must therefore
also force `display: block !important`, since `.av-view:not(.active)` is
`display:none` and the wrapper is deliberately not `.active`.

- **`options.enableFileCheckpointing: true`** (set in `ensureSession`) makes the
  CLI snapshot tracked files per user message. Checkpoints only cover edits made
  AFTER it is on, so pre-feature sessions rewind the CONVERSATION only — surfaced
  as `filesError` rather than silently implying a full restore. Incompatible with
  the SDK's `sessionStore` option (Orchestra uses none).
- **`query.rewindFiles(userMessageId, {dryRun})`** restores the files. It is a
  CONTROL REQUEST, so it needs the transport OPEN — `sdkRewind` therefore runs it
  on the LIVE query FIRST and only then sets `session.cleared` + `sdkStop`
  (calling it after teardown throws `ProcessTransport is not ready for writing`).
  The `dryRun` backs the confirmation popover's "Restores N files (+x/−y)" line.
- **`options.resumeSessionAt: <uuid>`** truncates the resumed conversation. It
  keeps turns **1..N inclusive** of its target (measured, not inferred), so
  undoing message N means cutting at **N−1** — `previousRewindId`
  (`rewind-util.ts`, unit-tested + mutation-tested) owns that off-by-one. No
  predecessor ⇒ the first turn is being undone ⇒ `sdkSessionId: ''` and the next
  send opens a fresh session. The cut is parked in `rewindResumeAt` and consumed
  read-and-delete by the next `ensureSession`, so it can never apply twice.

**The rewind target is a uuid Orchestra MINTS ITSELF.** `SDKUserMessage.uuid` is
an optional *input* the CLI persists verbatim to the transcript, so `sdkSend`
generates one per turn (`randomUUID()`) and rides it on the `user-message` echo as
**`rewindId`** → `RenderMessage.rewindId`. This is the only way to know the id
synchronously: the SDK never echoes user messages back, and no output message
carries a back-reference, so there is NO stream path to a CLI-assigned uuid (and
reading it off disk would race). `agent-transcript.ts` also recovers the
envelope's `uuid` (camelCase on disk vs snake_case on the wire), so a REOPENED
workspace can rewind its history too. A message with no id — externally-originated
turns, pre-feature history — simply renders no affordance.

The fold's **`session/rewind`** case drops the target and everything after it
(`slice(0, cut)`), settles live turn state so the pane can't wedge on "Working…",
and clears `pendingPermissions` (their `canUseTool` promises died with the
session). An UNKNOWN id is a **no-op, never a wipe** — a stale or duplicate event
must not clear a transcript it doesn't match. The renderer passes the wiring by
**context** (`agent/rewind-context.ts`), not props, because the bubble sits below
several memo boundaries kept deliberately render-free on the streaming hot path.

**Reverse path (user → agent):** `window.orchestra.agentSdk*` invoke handlers call into
the live `query` object in main — `agentSdkSend(wsId, text, images?)`, `agentSdkRunBash(wsId, command)`, `agentSdkInterrupt(wsId)`,
`agentSdkRewind(wsId, rewindId, prevRewindId?)`, `agentSdkRewindPreview(wsId, rewindId)`,
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

**MCP tracking + management (`/mcp`, Option-D design).** MCP servers surface in
two places. (1) **Transcript notices — for USER ACTIONS ONLY** (`notice` kinds
`mcp`/`mcp-error`, `.av-notice-mcp*` — the interrupt-divider treatment, dot
color = state): the outcomes of toggle / reconnect / authenticate, emitted by
the `sdkMcp*` ops. The init normalize branch CAPTURES `mcp_servers` (with
`toolCount` derived from the init `tools` list by `mcp__<name>__` prefix —
`mcpServerFromInit`, agent-events.ts) but deliberately emits NO notices: the
CLI re-emits `system/init` at the start of EVERY request, so per-init notices
re-announced the whole server list each turn (user-rejected noise; regression
guard in agent-events.test.ts). Notice text comes from the shared pure
`describeMcpServer` (`disabled` → null). (2) **The `/mcp` manager popover**
(`components/agent/McpPopover.tsx`, `.av-mcp*`): SUBMITTING `/mcp` in the
composer is intercepted Orchestra-side like `/clear` (never sent to the model)
and opens a popover above the composer field listing
`session.mcpServers` — status dot, tool count, per-server enable/disable
switch, retry on failed/needs-auth. Backing IPC (`agentSdkMcp{Status,Toggle,
Reconnect}` → `sdkMcp*`, agent-sdk.ts) drives the SDK query's control requests
`mcpServerStatus()` / `toggleMcpServer(name, enabled)` /
`reconnectMcpServer(name)` — all LIVE on the running session, no restart (the
CLI persists toggles for future sessions); `sdkMcpStatus` lazily
`ensureSession`s (CC's /mcp also runs in-session — same pattern as Remote
Control). The popover's ↻ is **hover-revealed on every enabled row** and
always-visible (attention-tinted) on failed/needs-auth rows; **disabled
servers collapse into a "▸ disabled · N" section** (collapsed by default).
**↻ on a `needs-auth` server runs the REAL OAuth flow** (`sdkMcpAuth` →
`agentSdkMcpAuth`, LONG-RUNNING IPC): the SDK's internal `mcpAuthenticate`
control request starts the flow, `firstHttpUrl` (agent-events.ts, pure +
unit-tested) deep-scans its undocumented response for the authorization link
(field-name-agnostic on purpose), `platform.openExternal` opens it in the
SYSTEM browser, and the flow polls `mcpServerStatus()` (2s cadence, 3-min
cap) until the fresh token lands and the CLI reconnects — the row shows
"waiting for authentication…" (`.av-mcp-authwait`) meanwhile. A server
MISSING from the status list is terminal (no 3-min poll for a removed name);
a "ProcessTransport is not ready" throw (↻ clicked seconds after a cold
/mcp open, racing the subprocess boot) retries ONCE after 3s; every outcome
— success, failure, timeout, throw — lands as a transcript notice. At the
timeout boundary (and ONLY there) the flow fires one last `reconnectMcpServer`
before reporting failure, since status can lag a connection that is already
live; a *periodic* nudge was tried and reverted (v0.5.226→228) because it
would fire during the user's browser step and could disturb the in-flight
PKCE exchange — the reasoning is preserved in a long comment above
`MCP_STATUS_TIMEOUT_MS`, read it before re-proposing one. The SDK
also exposes `mcpSubmitOAuthCallbackUrl`/`mcpClearAuth` (unused so far).
The popover's footer carries a **`re-enumerate`** button (`.av-mcp-refresh`,
`agentSdkMcpRefresh` → `sdkMcpRefresh`) — the ONLY way to pick up
account-level connector changes. `claude.ai` connectors and their `mcpsrv_`
ids are resolved by the CLI **once, at process start**: no SDK call re-fetches
them, so a connector added/removed/re-connected on claude.ai (which mints a
NEW `mcpsrv_` id) leaves a long-lived CLI serving a stale set whose auth URLs
404 with "Server not found". Critically **an app relaunch does NOT fix this** —
the detached keeper (session-keeper.md) survives it and the app reattaches to
the same stale CLI, so the bad enumeration outlives every restart. Hence the
mechanism is a real process restart: `sdkStop` + `killKeeper` backstop (else
`ensureSession` could reattach to the very process being replaced) then
`ensureSession`. The conversation is PRESERVED — `sdkStop` deliberately leaves
`sdkSessionId` alone (only `sdkClear` drops it), so the fresh process resumes
the same transcript. Refuses while `session.turnGate !== null` (a turn is in
flight) rather than killing the agent mid-answer.
**The restart is deliberate — `setMcpServers()` cannot replace it (#23,
measured 2026-08-24, don't re-litigate).** The SDK's `setMcpServers()` reads
like a drop-in upgrade and is genuinely well-behaved — measured live against
the installed CLI, its reconnect scope is **delta only** (an already-live
server named again is not restarted, even though the returned `added` list
claims it was), the **session survives** (same `session_id` across add and
remove), and **in-flight tool calls are unharmed** (returned in ~108ms while
an 8s MCP call ran; that call finished normally). But it is **blind to
settings-file and account-level servers**: a server written into
`<configDir>/.claude.json` mid-session was never added, never spawned and
never appeared in `mcpServerStatus()`, while a *fresh* session over the same
file booted it `connected` (the control proving the fixture was valid). Since
account-level `claude.ai` connector changes are the ONLY thing ↻ exists to
pick up, swapping in `setMcpServers` would make the button a silent no-op for
its entire purpose. Orchestra's only dynamically-added server is the
in-process `browser` one, which ↻ is never for. Guarded by
`src/main/mcp-refresh-mechanism.test.ts`, which fails if the restart steps
(`sdkStop` + `killKeeper` + `ensureSession`) leave `sdkMcpRefresh` or if
`setMcpServers` appears in it.
A **health chip** (`McpIndicator`, exported from McpPopover.tsx; `.av-mcp-ind`,
`order:3` so it docks right after Remote control in the composer bar) renders
ONLY while a server is `failed`/`needs-auth` — amber for auth-only, red
(`-failed`) when anything failed, pulsing dot, native tooltip listing the
servers; clicking opens the /mcp popover, whose `mcpOpen` state therefore
lives in the PANE component (StructuredView), not in Composer — both the
`/mcp` submit intercept and the chip open it. No polling: the chip reads the
folded `session.mcpServers`, refreshed by every request's init and every
`session/mcp`. The popover is capped at `max-height: min(480px, 100vh-160px)`
with internal scroll — a real config (30+ servers with claude.ai connectors)
otherwise overflowed the viewport top (caught e2e). Harness gotcha recorded
in that drive: Electron's HTTP cache in a REUSED `ORCHESTRA_HOME` serves a
STALE `dist/` index.html+css across relaunches — clear `userData/Cache` (and
`Code Cache`) or use a fresh home, and verify the loaded stylesheet hash
before trusting a CSS assertion. Every op broadcasts a **`session/mcp`** full-list event
(fold: wholesale replace of `AgentSession.mcpServers`, mirroring
`session/remote-control`) plus an outcome notice, so toggling/reconnecting
writes its own history into the transcript. `sdkEventToStatusEvent` maps
`session/mcp` → null (the status dot never moves for MCP chatter). Guards in
`agent-events.test.ts` (init emits NO notices, toolCount, session/mcp fold,
describeMcpServer, status-map null). Known gap: the op-outcome notices are
Orchestra-side emissions (not CLI transcript lines), so the history backfill
does not reconstruct them on reopen.

**Peer/queue delivery + STRUCTURED-FIRST spawn/wake:** the lifecycle dispatchers in
`workspaces.ts`/`prompt-queue.ts` (peer `dispatchMessageRequest`, the usage-limit
prompt-queue flusher, `wakeAgentWithPrompt`, `/spawn`'s `startWorkspaceAgentHeadless`,
account migration) live "below" agent-sdk in
the import graph, so they reach the structured session manager through the
**`src/main/sdk-delivery.ts`** seam (a registration indirection that breaks the cycle,
like `sdkStopMany`). agent-sdk registers `{hasSession, send, start, stop}` at load:
`sdkDeliver(wsId, text)` routes a message/queued prompt to a LIVE session as its next
turn instead of blindly spawning a raw `claude` PTY beside it;
**`sdkStartAndDeliver(wsId, text)`** (→ agent-sdk's **`sdkWake`**) is the spawn/wake
entry — it lazy-STARTS a session and enqueues `text` as its opening turn, so
**`orchestra spawn` runs its child as a structured SDK session** and a stopped agent
woken by a peer message / queued prompt resumes structured (`ws.sdkSessionId`; a
terminal-only workspace first ADOPTS its newest on-disk transcript as the resume id —
the same session `--continue` picks — so context survives the switch). Account
migration calls `sdkStopIfLive` so the session doesn't keep running under the old
account's `CLAUDE_CONFIG_DIR`. The raw-PTY spawn/wake machinery (headless TUI typing,
readiness sentinel, submit retries) survives only as a fallback when the seam is
unregistered or the SDK start fails (`sdkStartAndDeliver` returns false and logs).
Post-wake insurance checks in the callers gate on `sdkSessionLive` too, since
`isRunning` is PTY-only and a structured wake would otherwise read as "died" and
double-deliver (inbox park / prompt re-queue).

## Silent-failure hardening + CC/PTY parity (2026-07 gap audit)

A three-axis audit (PTY-vs-structured, silent failures, CC-desktop parity)
closed these gaps — the regression guards live in `agent-events.test.ts`:

- **Notices** — `normalizeSdkMessage` used to consume only 5 of the SDK's ~39
  message variants and silently dropped the rest. Now an **`AgentNoticeEvent`**
  (`type:'notice'`, `kind`: rate-limit / auth / compact-boundary / compact-error
  / refusal / permission-denied / notification / warning / info /
  command-output / interrupted) surfaces `rate_limit_event`, `auth_status`,
  `system/{compact_boundary, local_command(_output), informational, notification,
  permission_denied, model_refusal_*}` as quiet system rows
  (`NoticeRow.tsx`, `.av-notice-*`). `interrupted` renders as a centered
  hairline divider with a square "stop" dot (`.av-notice-interrupted`), and
  the fold collapses back-to-back `interrupted` notices into one row. **`AgentStatusEvent`**
  (`session/status`, transient — never a transcript row) carries
  `system/api_retry` ("API 529 — retrying in 8s (3/10)") and
  `status:'compacting'`; folded into `session.statusNotice`, shown in the
  running TurnFooter, cleared when output resumes / at turn end.
  **`AgentMemorySizeEvent`** (`session/memory-size`) carries the CLAUDE.md
  memory files whose resolved size (imports inlined) exceeds the model's
  per-file char limit; folded into `session.oversizedMemory` (pinned session
  state, never a transcript row) and rendered as the persistent
  `MemorySizeBanner` strip above the message list. This one is NOT an SDK
  message: the Claude Code CLI shows this warning only in its Ink startup
  banner and never puts it on the wire (`system/init` carries `memory_paths`
  with no sizes and no over-limit flag), so `emitMemoryWarning`
  (`agent-sdk.ts`) measures the files itself, once per session, and synthesizes
  the event. The limit formula is an Orchestra-side REPLICA of the CLI's —
  `max(40000, contextWindow * 0.05 * 3)` — documented with its drift risks in
  `src/shared/memory-size.ts`; `src/main/memory-files.ts` does the (import-
  resolving) measurement. **`AgentThinkingTokensEvent`** (`system/thinking_tokens`) drives a live
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
  **Stop means stop (#26 item 3)**: when `system/init` advertises
  `interrupt_cancel_queued_v1`, the interrupt also cancels QUEUED/pending-dispatch
  messages (peer deliveries, task notifications) so they cannot start a fresh turn
  the instant the abort lands. Capabilities are latched onto the session on every
  init (`session.capabilities`, re-latched each turn since a keeper reattach can hit
  a different CLI build); the pure gate is `supportsCancelQueued(caps)`
  (`agent-events.ts`) — absent capabilities read as UNSUPPORTED, never "assume yes".
  ⚠️ Mechanism note: the SDK's typed `Query.interrupt()` hardcodes
  `{subtype:'interrupt'}` and CANNOT carry `cancel_queued` (verified in `sdk.mjs` at
  0.3.241 — it also discards the response's `cancelled` field), and `request()` is not
  on the public `Query` type. It IS a real runtime method (verified live:
  `typeof q.request === 'function'`; round-trip returns
  `{still_queued:[],cancelled:[]}`), so `interruptCancellingQueued` (`agent-sdk.ts`)
  reaches it behind a narrow local type, gated THREE ways — capability advertised,
  method present, call succeeded — each falling back to the plain `interrupt()`,
  which is the pre-#26 behaviour.
- **The queue tray — prompts parked behind an in-flight turn.** Sending while a
  turn runs has ALWAYS queued (`sdkSend` pushes onto `session.queue`
  unconditionally; `promptStream` gates the next yield on the previous turn's
  `result`), but nothing rendered that queue, so a parked prompt was visually
  indistinguishable from one the agent was working on. Now `sdkSend` computes
  `parked = session.turnGate !== null || session.queue.length > 0` and stamps it
  onto the echo (`AgentUserMessageEvent.queued`); the bubble renders dashed via
  `data-queued="1"` (`MessageBubble.tsx`, `.av-message-user[data-queued='1']`).
  The authoritative surface is `QueueTray.tsx`, docked INSIDE `.av-composer`
  above the input (the transcript scrolls, so ghost bubbles there scroll out of
  reach exactly when you want to cancel one — measured on the UI prototype).
  Every mutation goes through main and comes back as an `AgentQueueUpdateEvent`
  carrying the WHOLE queue (a snapshot cannot drift the way an ordered delta
  stream can under the RAF-batched queue); the fold reconciles bubbles against it
  and clears `queued` on anything that drained. IPC: `agent:sdkQueue{Remove,Edit,
  Move,Coalesce}` → `sdkQueue*` in `agent-sdk.ts`.
  **Coalescing** — an entry marked `coalesceWithNext` (`session.coalesce`, a Set
  keyed by minted uuid because the array is spliced/reordered) is absorbed into
  the following one at drain time, so several thoughts arrive as ONE turn. The
  tray's `turnCount()` and `promptStream`'s absorb loop are two encodings of that
  rule and are cross-checked over all 62 merge patterns of length ≤5.
  ⚠️ Two traps this closed: (a) a queued echo must NOT restart `turnStartedAt` /
  zero `liveOutputChars`, or the footer reports the running turn as just begun and
  the live token estimate loses its denominator (the fold returns early on
  `event.queued`); (b) `interruptCancellingQueued` now clears Orchestra's OWN
  `session.queue` too — `cancel_queued` reaches only what the CLI already holds,
  so without this Escape would leave parked prompts to start fresh turns the
  instant the abort landed. Cancelling/editing also rewrites `sdkPendingPrompts`,
  or the crash-recovery replay would resurrect a prompt the user cancelled.
  **Escape hatch**: `Mod+Enter` interrupts and sends immediately (bound in
  `CmComposer` as `onModEnter` — NOT Shift+Enter, which inserts a newline).
- **Rate-limit / overload terminations (#26 item 2)** — a turn ending with
  `is_error` is classified STRUCTURALLY from `api_error_status`, never from the error
  prose: `classifyTurnError` (`agent-events.ts`) maps **429 → `rate-limit`**, **529 →
  `overload`**, everything else → `error`. A 429 additionally emits the
  `rate-limit` NOTICE, so a usage-limit termination reaches the same surface a
  `rate_limit_event` drives (see [accounts-usage.md](accounts-usage.md)) instead of
  rendering as a generic red error. A 529 deliberately does NOT: it is transient
  upstream overload, not a quota problem, so it must not park prompts on the queue —
  it only gets an accurate message. Before this, `apiErrorStatus` was threaded to the
  error event but nothing ever read it, so 429 and 500 were indistinguishable.
- **Externally-originated user text** — stream `user` messages carrying TEXT
  (Remote Control turns typed on claude.ai/mobile, channel/peer injections)
  now emit `user-message` (with an `origin` badge, `.av-message-origin`);
  synthetic frames, subagent sidechains (`parent_tool_use_id`) and
  tool_result-only messages stay filtered. `emitFrom` drops replays matching
  `session.recentEchoes` (belt-and-braces vs future SDK replay behavior).
- **Claude Code's non-conversational user frames** — the stream/transcript
  writes slash-command INVOCATIONS (`<command-name>/x</command-name>…`), their
  acks (`<local-command-stdout>…</local-command-stdout>`) and the interrupt
  marker (`[Request interrupted by user…]`) as plain USER messages, which used
  to render as raw-XML user bubbles (and a phantom `running` turn).
  **`classifyUserText`** (agent-events.ts) routes them: invocation →
  reconstructed `/cmd args` user-message (deduped against the local echo by
  `recentEchoes`), ack → `command-output` notice (empty blocks, e.g. /clear's,
  drop), marker → `interrupted` notice (trailing typed text survives as its own
  bubble). Applied by BOTH the live normalize `user` branch and the
  `transcriptToEvents` backfill so live and reopened views agree.
- **Interrupt is not an error** — a user-requested interrupt ends the turn with
  an `is_error` result (`subtype: error_during_execution`) that used to raise a
  red "agent turn errored (error_during_execution)" banner. `emitFrom` now
  drops that error while `session.interruptRequested` is set (reset at the
  next `result` boundary in `consume` so a FUTURE turn's genuine EDE still
  renders), and consume's catch path emits a quiet `interrupted` notice
  instead of the old "Turn interrupted." error row.
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
- **CC-desktop parity in the UI** — `ContextGauge` in TurnFooter
  (`TurnFooter.tsx:172`; "N% used" + a small progress bar, amber ≥75% used /
  red ≥90%; since #16 it is a BUTTON opening the breakdown panel when the
  reading carries one — see "Context breakdown panel" below). Since #15 it
  prefers `AgentSession.contextUsage` — the AUTHORITATIVE
  live reading from `Query.getContextUsage()` (see "Context gauge sourcing"
  below) — and falls back to turn-end's `contextWindow` (max `modelUsage` entry)
  and `contextUsedTokens` (the LAST top-level assistant message's per-call usage,
  tracked in `NormalizeContext.lastApiCallUsage` and refreshed by
  compact_boundary `post_tokens` — never the `result` message's `usage`, which is
  session-cumulative and pinned the gauge at 100%); **Esc interrupts** the
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
- **Background-task control (#19)** — `sdkStopTask(wsId, taskId)` and
  `sdkBackgroundForegroundTasks(wsId, toolUseId?)` (`agent-sdk.ts`, behind
  `agent:sdkStopTask` / `agent:sdkBackgroundTasks`) call the SDK's
  `Query.stopTask()` / `Query.backgroundTasks()` on the retained `session.q`.
  Both return `false` with no live session (a task cannot outlive the CLI process
  that owns it) and emit a `warning` notice on a thrown SDK error. **`sdkStopTask`
  deliberately does NOT patch `session.tasks`** — the CLI's own
  `task_notification{status:'stopped'}` / `background_tasks_changed` drop does,
  through the normal fold, which is what keeps "the button was clicked" and "the
  task actually died" distinguishable. `backgroundTasks()`'s `false` is a contract
  outcome ("nothing to background"), not an error, so it draws no notice.
- **Skill / plugin hot-reload** — `sdkReloadSkills(wsId)` and
  `sdkReloadPlugins(wsId)` (`agent-sdk.ts`) call the SDK's `reloadSkills()` /
  `reloadPlugins()` control requests on the retained `session.q`, so a skill or
  plugin installed OUT OF BAND reaches sessions that are already running
  without restarting them (a restart would cost the agent its warm context).
  Both are TRANSIENT — nothing is persisted, unlike `sdkSetModel` — and both
  return `'skipped'` rather than booting a session via `ensureSession`, so an
  `--all` fan-out cannot cold-start every idle workspace as a side effect.
  `dispatchReloadSkillsRequest` fans out over the live `sessions` map (snapshot
  taken up front, since the awaits yield) behind the `/reloadSkills` socket
  route and the `orchestra reload-skills [<id>|--all] [--plugins]` CLI verb.
  Plain `~/.claude/skills`, `commands/` and `agents/` are already watched by the
  CLI itself and hot-reload unaided; the PLUGIN cache is NOT watched, which is
  why `--plugins` is an explicit opt-in. It also waits
  `PLUGIN_RELOAD_SETTLE_MS` (2.5s, once per fan-out) first: measured, the first
  `reloadPlugins()` after an install returns `plugins: []` because the settings
  file holding `enabledPlugins` sits behind a ~2s cache — and an empty array is
  NOT treated as a failure (`shared/reload-skills.ts` `isPluginReloadFailure`).

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
  three by default; matching it requires `'local'`. **An inline `settings` object
  pins `crossSessionInbound: 'hold'`** (`src/shared/cross-session-inbound.ts`) so an
  unsolicited cross-session peer message can never auto-run a paid turn: any local
  Claude session can address an Orchestra agent by peer name (`ListAgents` →
  `SendMessage`) over the CLI's messaging socket, and the CLI's UNSET default is *mode
  parity* — bypass↔bypass auto-delivers, which is exactly Orchestra's configuration, so
  the receiver started a full turn on its own ($0.13 measured, #13/#25). `'hold'` parks
  it for review without letting Claude act; `'refuse'` also works but discards the
  message and is indistinguishable to the sender, so `'hold'` is the least-destructive
  supported policy (matrix in `docs/research/cross-session-inbound.md`). This does NOT
  affect `orchestra message`, a different channel entirely (`sdkDeliver` / PTY / inbox
  file — `SendMessage` has zero hits in `src/` code at upstream `48bdbcb`,
  positive control `sdkDeliver` 4 files; it occurs only in the explanatory
  comment beside the setting). Inline settings land in the SDK's
  highest-priority "flag settings" layer, so a stale value in the user's `settings.json`
  cannot override it and `settingSources` is untouched. `buildSdkEnv` sets
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
      `tool-result`→`posttool`, `permission-request`/`user-dialog-request`/
      `elicitation-request`→`notify` (#21), `turn-end`→`stop`.
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
  (`MessageBubble`, else a lone `ToolCard`). **Bubble time indication**: every
  message the fold mints carries `RenderMessage.at` (the stamping event's epoch
  ms; history backfill recovers the REAL time from the transcript envelope's
  `timestamp` in `agent-transcript.ts`, so reopened workspaces don't show load
  time). `buildRenderItems` computes a **turn divider** per user turn
  (`computeTurnDivider` in `src/shared/message-time.ts` + tests): wall-clock
  time, day label when the calendar day changes (Today/Yesterday/date), and the
  idle gap since the previous stamped message when ≥ 10 min. The divider rides
  INSIDE the user turn's virtualized row (rendered by `ItemSlot`,
  `.av-turn-divider`) so row heights stay a pure function of item content; each
  bubble additionally has a hover-revealed ghost timestamp
  (`.av-message-ts` in `MessageBubble`). The list **opens scrolled to the last
  message** (an `initialPin` ref force-scrolls to bottom across the async
  height-settle passes). **Follow-mode (stick-to-bottom during streaming)** is
  driven by a **`ResizeObserver` watching BOTH the translated row container AND
  the sized wrapper**, calling `pinToBottom` the instant rendered content grows
  (typewriter reveal, async row re-measure, new row) — NOT the coalesced
  `measureTick` RAF, which lagged the follow scroll ≥1 frame behind and let the
  viewport fall progressively behind fast output (the "accumulating scroll lag"
  bug). Observing the row container ALONE silently stalls follow: the scroller's
  `scrollHeight` is max(sized wrapper, overflowing rows), so when the wrapper is
  the taller of the two, content can grow — a row *below the window* measuring
  taller than its 72px estimate, or the window sliding so a tall row unmounts —
  without the row container's own box changing, firing no resize entry and no pin
  (measured in a real browser: scrollHeight 2400→2700 with the row container flat
  at 1200px opened a 300px gap with ZERO callbacks). `measureTick` does not cover
  it either — it only bumps when a MOUNTED row's measured height changes.
  `pinToBottom` uses `scrollTo({behavior:'instant'})` to override the stylesheet's
  `scroll-behavior: smooth` — a bare `scrollTop=` (or `behavior:'auto'`) would
  animate the jump and, because content grows every frame, forever chase a moving
  target. Follow-mode releases **only on a genuine user scroll-UP**: a `scrollTop`
  DECREASE vs `lastScrollTop` **that also leaves the viewport ≥24px off the
  bottom**. The decrease alone is NOT sufficient — the browser also CLAMPS
  `scrollTop` down whenever the scrollable range shrinks, firing an ordinary
  `scroll` event indistinguishable from a drag. That happens routinely: the
  composer auto-grows/shrinks as the user types or clears a draft (changing the
  LIST's `clientHeight`), and content shrinks when a tool group collapses or a
  turn ends. The old bare `cur < prev - 2` test read those clamps as a scroll-up
  and silently disengaged follow mid-stream (reproduced e2e: clearing a draft grew
  `clientHeight` 366→537 and released follow, leaving a 71px gap). The
  discriminator is WHERE the scroll landed, not merely that it moved up — a clamp
  leaves the viewport still parked at the bottom.

  **Scroll anchoring while follow is released** (reading history). History
  backfill folds the whole transcript in ONE commit, so only the bottom window
  ever mounted — everything above carries the 72px estimate. Scrolling UP mounts
  those rows for the first time; each measurement shifts every offset below it
  while `scrollTop` stays put, so the content the user is reading visibly jumped
  under the viewport (reproduced in the real app: 20–50px uncommanded shifts
  every few wheel ticks — the "random jumps down / scroll not fluid" bug). Fix:
  `onScroll` tracks an **anchor** (the item under the viewport top + its delta,
  from `layoutRef`, the per-render ids/offsets snapshot), and a dep-less
  `useLayoutEffect` restores the anchor's viewport position before paint
  whenever a commit moved the offsets — content-space shifts still happen, but
  `scrollTop` compensates in the same frame so the row stays put on screen.
  Skipped while following (the pin owns the scroll) and for hidden panes.
  `.av-message-list` sets `overflow-anchor: none` so the browser's native
  anchoring (blind to translateY-repositioned rows) can't fight the correction.

  **The anchor resolves POSITIONALLY** — `resolveAnchorIndex(ids, id, hint)`
  (`src/renderer/scroll-anchor.ts` + `.test.ts`) picks the occurrence nearest the
  index the anchor was captured at, not `ids.indexOf(id)`. This is the fix for
  "scrolling up a notch from the bottom teleports to the beginning of the
  transcript": message ids were not unique (see **Message-id uniqueness** below),
  so `indexOf` resolved the row at the bottom to its namesake at the TOP and the
  anchoring effect scrolled there — then re-anchored on the top row, stranding the
  user at the start. Uniqueness is enforced at the source now; the positional
  lookup is the belt-and-braces, since this effect writes `scrollTop` on EVERY
  commit and must never be able to lose the reading position.
  Related guard: `MeasuredRow.onHeight` ignores `h === 0` **only when the
  scroller itself has `clientHeight === 0`** — i.e. a hidden pane, whose layout
  effects still run on background store updates and would otherwise cache a
  zero for every row (poisoning the offsets and dropping the scroll position
  the user returns to). It must NOT skip zeros generally: `MessageBubble`
  returns `null` for a message with no text, no thinking and no images (a
  `block-start` whose first delta never landed), so those rows genuinely are
  0px and their zero MUST be cached. v0.5.190 shipped the broad guard and
  regressed: such rows never settled, so each kept the 72px `ESTIMATED_ROW_H`
  until it entered the window, and the estimate then collapsed 72px→0px mid
  scroll — throwing the viewport by exactly one `ESTIMATED_ROW_H` (measured:
  `shifts=1, maxShift=72px` with `scrollTop` frozen, reproducibly the same row).
  Note the stale reserve is **only observable dynamically**: inside the mounted
  window rows are always flush (row container == sum of real heights), and four
  separate static geometry checks all passed on the buggy build — see the long
  comment in `verify-scroll-anchoring.mjs` before adding a fifth. Gate:
  `scripts/verify-scroll-anchoring.mjs` — seeds a backfill-shaped transcript
  (one-shot inject), wheel-scrolls up with trusted CDP input, and asserts ZERO
  uncommanded screen-space shifts (`Δ(cy − scrollTop)` over no-wheel frame
  pairs); mutation-tested (reverting the fix yields ~6 shifts, max ~49px).

  Sibling gate for the **teleport** (as opposed to the jitter):
  `scripts/verify-scroll-dup-anchor.mjs` seeds the hibernation-wake shape — a
  duplicate-id user row near the end of a ~18000px transcript — pins to bottom,
  wheels up and asserts the largest single-frame drop in `scrollTop` stays at
  one wheel tick. Mutation-tested: restoring `ids.indexOf` drops
  17067px → 768px on frame 4, i.e. straight to the top of the transcript. NOTE
  the seeded duplicate row must be TALL: the anchor is only re-derived on scroll
  events, so a one-line bubble (~50px) is narrower than a 120px wheel tick and
  the viewport top skips over it without the teleport ever firing — the first
  version of this gate reported a clean pass against the known-buggy build.

  **Follow indicator.** `MessageList` mirrors `stickBottom` into render state
  (`following`, updated only on a real transition so the hot scroll/resize paths
  stay render-free) and shows a discreet **"Resume following" pill**
  (`.av-follow-pill`) over the bottom of the transcript whenever follow is
  released and there is output. Clicking it re-pins and re-engages — otherwise
  reachable only by dragging to the very bottom. It lives in the positioned
  `.av-list-shell` wrapper (NOT the scrolled content, which would scroll it away).
  Gate: `scripts/verify-followmode.mjs` drives the built app over CDP and asserts
  pin-during-streaming, pill show/hide, click-to-resume, and the composer-clamp
  regression; it has been mutation-tested (reverting the `onScroll` fix turns the
  two clamp guards red). Verified e2e (CDP under headless sway) against a
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
  **Two SDK-reaching actions (#19)**, both taking `workspaceId` (the panel is
  otherwise a pure projection of `session`):
  - **Stop** (`av-bgtask-stop`, running cards only) → `agentSdkStopTask` →
    `sdkStopTask` → `Query.stopTask(taskId)`. The click records only a REQUEST in
    a renderer-local `stopRequested` set and the button reads **"Stopping…"**; the
    card is flipped by the CLI's own `task_notification{status:'stopped'}` OR by
    the id leaving the `background_tasks_changed` live set — both through the
    ordinary fold. So a settled card is evidence the task actually died, never
    that the button was pressed. A rejected request rolls the marker back.
  - **"Run current work in background"** (`av-bgtask-panel-foot`, shown only while
    `session.running`) → `agentSdkBackgroundTasks` → `sdkBackgroundForegroundTasks`
    → `Query.backgroundTasks()`. This is the SDK's **Ctrl+B parity**: it moves
    in-flight FOREGROUND work into the background. ⚠️ Despite the name it is **not
    a state query** — it returns `Promise<boolean>`, and at SDK 0.3.241 **no
    state-returning background-task method exists on the `Query` interface at all**
    (enumerated). Live state comes only from the organic `background_tasks_changed`
    level signal. The control is deliberately NOT gated on `session.tasks` being
    non-empty: foreground work has no card yet, which is the case it exists for.
- **`src/shared/background-task-actions.ts`** (+ `.test.ts`, 19 tests) — the pure
  decision logic behind those actions, testable without a renderer.
  `stopButtonState(task, requested)` → `'stoppable' | 'stopping' | 'settled'`,
  where **terminal status always outranks a pending request** (so a marker can only
  ever show while the task is genuinely running); `pruneStopRequests(requested,
  tasks)` drops markers whose task settled or left the live set (returning the same
  instance when unchanged, so a `setState` can skip a render);
  `canBackgroundForegroundWork(session)` gates the Ctrl+B control on `running`.
  All three guards are mutation-tested (revert → named failures).
- **`src/renderer/components/agent/ToolGroup.tsx`** — the aggregated tool run,
  rendered in the **Claude-Code-desktop compact style**: EVERY tool run (even a
  single tool) collapses to ONE quiet, muted, **borderless** one-line row —
  chevron + deduped tool-icon strip + a **verb label** (`describeToolRun`) +
  inline **red/green diff counts** (`aggregateDiff`) — and **no status dot** in
  either direction: running/failed state is carried by the row's color class alone
  (`av-tool-run-pending`/`-error`) plus a screen-reader-only state word. There is
  no card frame at rest, so the row recedes behind the
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
  **`MarkdownView.tsx`** (full CommonMark + GFM via **react-markdown + remark-gfm +
  remark-breaks** — tables, strikethrough, task/nested lists — replacing the former
  hand-rolled dep-free subset parser that silently dropped all of those, the "bad
  markdown reader"; fenced blocks route to `CodeBlock`. **`remark-breaks` maps a single
  newline to `<br>`**: strict CommonMark renders a soft break as a SPACE, so multi-line
  chat prose collapsed into one run-on paragraph (measured: 4 lines -> 1 `<p>`, 0 `<br>`;
  `.av-message-text` is `white-space: normal`, so nothing downstream rescued it). Plugin
  ORDER matters — `remarkGfm` runs first so table/task-list blocks parse before soft
  breaks become `<br>` nodes. Note the element overrides destructure react-markdown's
  internal `node` prop OUT before spreading onto DOM elements; spreading it emits a junk
  `node="[object Object]"` attribute on every `p`/`h*`/`ul`/`table`/... . **Streams smoothly via block-level memoization**: instead
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
  Electron renderer anymore either.
  **Non-execution classification (#26 item 1)**: an errored card reads
  *denied / blocked / interrupted / cancelled* instead of a bare *failed*, decided
  STRUCTURALLY from the CLI's `tool_result_meta` sidecar — never by matching the
  result prose. The sidecar rides WRAPPER-LEVEL on the `user` message (a sibling of
  `message`, so it is never replayed to the model), is keyed by `tool_use_id`, and
  carries `non_execution_kind` (7 values) plus an optional `user_feedback` — the deny
  comment a human typed, rendered at CARD level above the body (`.av-tool-deny-feedback`)
  so every tool body shows it, not just the generic one. Normalizer:
  `indexToolResultMeta` / `toNonExecutionKind` (`agent-events.ts`), label:
  `nonExecutionLabel` (`tool-util.ts`), state: `.av-tool-nonexec` +
  `data-nonexec="<kind>"` (muted, NOT red — a denial is not a failure).
  ⚠️ `tool_result_meta` is a RUNTIME SUPERSET: 0 occurrences in `sdk.d.ts` at SDK
  0.3.241, present in CLI 2.1.241 — so the shape is hand-written from the binary's own
  zod schema, and an unknown kind degrades to `null`. It is also LIVE-STREAM ONLY:
  measured over 300 on-disk transcripts (47 carrying `tool_use_id` as a positive
  control), ZERO persist it — so `agent-transcript.ts` backfill sets the kind `null`
  and a reopened workspace correctly falls back to a plain *failed* card),
  `ThinkingIndicator` (shimmer label), `PermissionDialog` (picks first *unanswered*
  pending request, not `pending[0]`; on reply calls `onReplied(requestId)` so the
  store clears the entry — see below), `AskUserQuestionCard` (**pages
  multi-question requests one at a time — Back/Next/step-dots — so the dialog
  never overflows the viewport; single questions render directly**),
  `AgentControls`,
  **`TurnFooter`** (slim single-row footer — cost and context-used gauge;
  token/turn-count/duration detail lives in the cost chip's tooltip; the previous
  turn's stats persist while a new turn runs). The **real-time "working"
  readout** is the sibling export **`WorkingIndicator`** — animated spark icon,
  **elapsed time counting up** from `session.turnStartedAt`, and a **live token
  estimate** from `session.liveOutputChars` (~chars/4) that ticks up and snaps to
  the exact `lastTurn.usage.outputTokens` at turn-end. It renders **inside the
  transcript, below the streaming output** (CC-desktop placement): MessageList
  mounts it inside the virtualized rows' translated container after the last
  mounted row, only when the window reaches the list end — NOT after the sized
  wrapper, whose estimate-based `totalHeight` lags typewriter growth and would
  let streamed text overlap it. A self-owned `useTick` hook
  re-renders it every second while mounted. The SDK stream carries no
  live duration/usage, so both live values are derived in the renderer — the
  duration is exact, the token count is approximate-until-close by construction),
  plus `agent-theme.ts` (a dependency-free `useAgentTheme` hook returning
  `'dark'|'light'` off the `data-agent-theme` attribute, used to pick the light/dark
  Shiki theme — formerly monaco-theme.ts, now Monaco-free).
- **`src/shared/reload-skills.ts`** (+ `.test.ts`) — pure logic behind
  `orchestra reload-skills`: `parseReloadSkillsArgs` (`--all` and an explicit id
  are mutually exclusive; an unknown flag is an ERROR, not an ignored token, so a
  typo'd `--plugin` can't report a clean success for a reload that never touched
  plugins), `isPluginReloadFailure` (always false — an empty `plugins` array is
  the ~2s settings cache, not a fault), `summarizeReload` (counts skipped
  sessions explicitly, so "reloaded nothing" and "reloaded everything" don't
  print the same line) and `reloadExitCode`. Electron-free so `node --test` can
  pin the decisions a live SDK session can't cheaply demonstrate.
- **`src/shared/agent-transcript.ts`** (+ `.test.ts`) — pure converter from the on-disk
  Claude Code session JSONL to `AgentEvent[]` (**history backfill**). On-disk lines
  differ from the live stream: assistant text is finalized (no stream_events → we
  synthesize block-start/delta/stop triplets at indexes ≥100k), there are no `result`
  lines (one quiet terminal `turn-end` is appended), and `isSidechain: true` lines
  (Task-subagent transcripts) are skipped. **A user turn's `image` content blocks are
  reconstructed into the `user-message`'s `images`** (Messages-API `{source:{base64}}`
  shape → `AgentImage[]`), so pasted images survive a reopen — the live echo carried
  them but the backfill formerly dropped `image` blocks, so they vanished on reload.
  **CLI-synthetic user frames are dropped, mirroring the live `isSynthetic` filter**:
  the CLI persists the wire's `isSynthetic` as the envelope's **`isMeta`** — skill-body
  expansions ("Base directory for this skill: …" + the whole SKILL.md), "Continue from
  where you left off." wake prompts, `[Image: …]` coordinate placeholders,
  `<local-command-caveat>` wrappers — and without the gate every one of them backfilled
  as a giant USER bubble a live session never showed ("skills show as messages from the
  user after an app restart", measured on a real transcript: 60 phantom bubbles).
  Tool_results on synthetic frames still flow (live-path parity), and an
  **`isCompactSummary`** line becomes a quiet `compact-boundary` notice instead of a
  wall-of-text bubble. The envelope's **`origin`** is also recovered (same shape as the
  wire's `msg.origin`, via the now-exported `originLabel`) so claude.ai/peer-originated
  turns keep their badge on reopen. Slash-command invocation frames
  (`<command-name>…`) are NOT synthetic on disk and still reconstruct as the
  `/cmd args` user bubble — same as live.
  `agent-sdk.ts sdkHistory(wsId)` locates the
  file (`<configDir>/projects/<mangleProjectDir(worktreePath)>/<sdkSessionId>.jsonl`,
  tail-capped at 4MB) and StructuredView requests it through the
  **`shouldRequestHistory`** gate (`src/renderer/history-backfill.ts` + `.test.ts`),
  applying the result via the store's **`applyAgentHistory`** action.
- **Session DISCOVERY is SDK-backed; the transcript READ is not** (#17). Which
  session to back the view with comes from the SDK's own session index —
  `agent-sdk.ts sdkListSessionIds(ws)` wraps `listSessions()` and feeds
  `scopeSessionsToWorktree` (`src/shared/session-discovery.ts` + `.test.ts`,
  where the pure decisions live so they are testable without Electron). It
  replaced a hand-rolled newest-`.jsonl`-by-mtime scan in BOTH `sdkHistory` and
  `sdkWake`'s terminal-transcript adoption. Four measured constraints, each of
  which silently breaks something if dropped:
  - **`CLAUDE_CONFIG_DIR` must be pinned per call** (`withAccountConfigDir`).
    `ListSessionsOptions` has NO `configDir`; the SDK reads the env var,
    defaulting to `~/.claude`. Orchestra pins every workspace to an account
    (`~/.claude-mc`, `~/.claude-perso`, …) and the default dir holds nothing —
    measured, listing unpinned returned **0 for all 31** workspaces with
    transcripts. The pin is restored in a `finally`: main-process env is global,
    so a leak re-homes every later lookup. Safe despite the SDK memoizing its
    resolved home, because that memo is KEYED on the env value (a change is a
    miss, not a stale hit — verified over 60+ alternations in one process).
  - **`includeWorktrees: false`** — the SDK defaults it to **true**, walking every
    worktree of the repo. With ~24 agents in sibling worktrees of one repo that
    returned **24 sessions for a workspace owning 8**: every workspace's history
    contaminated with other agents' conversations.
  - **`includeProgrammatic: true`** (the default, pinned explicitly) — Orchestra's
    structured sessions are `sdk-ts` entrypoints, exactly what the "IDE session
    picker" spelling (`false`) filters out: measured **8 → 4**.
  - **Never filter on a session's `cwd`.** It records where the session
    ORIGINALLY ran, so a workspace PROMOTED from scratch to a worktree keeps
    transcripts whose `cwd` is the old scratch path. A `cwd === worktreePath`
    "defensive" filter deleted such a workspace's entire history; the parity
    gate caught it as `onlyScan=1`. Scoping is the query's job (`dir` +
    `includeWorktrees:false`), not a post-filter's.

  **`getSessionMessages()` is deliberately NOT used for the fold.** It returns a
  parsed conversation chain that strips envelope fields `transcriptToEvents`
  depends on — measured against transcripts that actually contain them (positive
  controls, not vacuous zeroes): **`origin` stripped 6/6** (kills the
  claude.ai/peer badge on reopen) and **`isCompactSummary` stripped 1/1** (the
  quiet `compact-boundary` notice becomes a "This session is being continued…"
  wall-of-text bubble). It does correctly drop `isMeta` frames (5 → 0), so the
  phantom-skill-bubble class is handled — but two of three envelope behaviours
  regress, so the raw JSONL read stays until the SDK preserves them.

  Runtime payload note: `SDKSessionInfo` is
  `{sessionId, summary, lastModified, fileSize, customTitle, firstPrompt,
  gitBranch, cwd, tag, createdAt}` — there is **no `mtime`**. Recency is
  `lastModified` (== on-disk mtime to within a ms). Sorting on `mtime` is a
  no-op that still passes whenever the input arrives pre-sorted, which is how it
  hides; `session-discovery.test.ts` feeds reversed input to catch exactly that.

  Parity gate: `scripts/verify-session-discovery-parity.mjs` (not in
  `pnpm run test` — needs a real multi-account home; SKIPs loudly without one).
  Measured **31 workspaces / 2 accounts / sdk=41 == scan=41, onlyScan=0,
  onlySdk=0**, with an unpinned-control of 0, and mutation-tested: reinstating
  the `cwd` filter takes it to 40/41 and FAILS.
- **`ws.sdkSessionId` has THREE states, not two** — `undefined` (never ran a
  structured session → fall back to the newest discovered session, so a
  terminal-only workspace still shows history), `''` (`sdkClear`'s explicit
  CLEARED marker → blank history AND the fallback disabled, or a remount
  resurrects the just-cleared conversation), and a uuid (resume that). The
  decision is `chooseSession()` in `shared/session-discovery.ts`; collapsing
  `''` and `undefined` into one falsy check is the specific regression its
  signature exists to prevent, and a test asserts the two DISAGREE rather than
  only that each is individually right.
  **The gate keys on `AgentSession.historyBackfilled`, NOT on message count** —
  the fix for "part of the transcript disappeared". App.tsx unmounts panes past
  `MAX_MOUNTED_PANES` (12) while the `agent:event` subscription in store.ts is
  GLOBAL and ungated, so a session keeps folding events for an UNMOUNTED
  workspace (peer delivery, `sdkWake`, a queued prompt — all start turns
  headlessly). A workspace evicted from the LRU and then handed a background turn
  therefore holds a couple of orphan messages while its real transcript still
  lives only on disk; the old `messages.length > 0 → skip` gate read those as
  "history already present" and rendered them as the WHOLE conversation, and the
  old `.then()` additionally DISCARDED the backfill whenever live messages
  existed. Now the flag lives on the session (so it survives unmount, and
  `session/clear` resets it via `emptySession`), and history is **prepended**
  (deduped by message id) rather than dropped, since everything on disk predates
  anything folded live. Verified e2e on the built app by driving the REAL LRU
  eviction (open → visit 15 workspaces → pane unmounts → background turn →
  reopen): restored 1 → 81 messages with history visible, and mutation-tested —
  reverting to the message-count gate leaves the pane at 1 message with the
  transcript gone.
- **Message-id uniqueness (`seq` is identity, not just bookkeeping).** Every
  `RenderMessage.id` the fold mints comes from `event.seq` — `user:<seq>`,
  `error:<seq>`, `notice:<seq>`, `blockMsgId` = `<sessionId>:<seq>:<index>`
  (`shared/agent-events.ts`) — and those ids are the React keys, the
  virtualizer's measured-height cache keys AND its scroll-anchor keys. Two rows
  sharing one id is therefore a *scrolling* bug, not a cosmetic one. Two sources
  used to restart the counter mid-transcript:
  - **A new `Session` object minted `ctx: {seq: 0}`.** A Session dies on every
    teardown (hibernation sweep, `sdkStop`, crashed subprocess) while the
    RENDERER's folded transcript survives — it is store state, not pane state.
    So waking a hibernated workspace and sending one message appended a second
    `user:0` to a list whose first row was already `user:0`. Fixed by
    **`seqCursors` / `cursorFor(wsId)`** (`agent-sdk.ts`): ONE cursor per
    workspace for the app's lifetime, monotonic across session restarts, never
    reset (not even on `sdkClear`), dropped only in `sdkStopMany` (delete/archive
    — hibernation goes through `sdkStopIfLive` and must KEEP the cursor). The
    no-live-session emits (`error`/`turn-end`/`session/clear`/`session/rewind`)
    draw from it too instead of hardcoding `seq: 0`.
  - **A history backfill folded on its own `{seq: 0}`**, so history's first row
    was `user:0` — colliding with the live session's first turn. Fixed with
    **`HISTORY_SEQ_BASE = 1e9`** (`shared/agent-transcript.ts`, the identity
    sibling of `HISTORY_INDEX_BASE`): `sdkHistory` bases its cursor there, so
    history ids and live ids occupy disjoint spaces by construction.

  Regression coverage: `agent-transcript.test.ts` asserts a backfill is
  internally unique AND collision-free against a live session starting at seq 0.
  Reproduced beforehand against a real 181-message hibernated transcript (one
  duplicate: `user:0` at row 0 and row 181 → anchoring jumped 13032px → 0px).
  NOTE `applyAgentHistory`'s "dedupe by message id" only ever suppressed those
  accidental collisions — history and live ids are disjoint by design, so a turn
  present in BOTH lists (the LRU-eviction overlap) still renders twice; that is
  a separate, still-open bug needing content-based dedupe.
- **Skills autocomplete** — `agent-sdk.ts sdkListSkills(wsId)` scans the worktree's
  `.claude/skills/*` + the account config dir's `skills/*` (project shadows user) for
  `AgentSkillInfo` (shared/types.ts); the Composer shows a popover when the input is a
  pure `/prefix` (Tab/Enter complete, arrows navigate, Esc dismisses). The popover is
  CSS-fragile: it anchors to `.av-composer-field`, so that rule must keep
  `position:relative` and must never set `overflow:hidden` — see
  `agent-view-design.md`, where a redeclaration once clipped a correctly-rendered
  8-row popover into invisibility (the data/JS path was fine).
- **Composer editor** — the text surface is a CodeMirror 6 editor
  (`components/agent/CmComposer.tsx`), not a textarea: it decorates the leading
  `/skill` / `!bash` token via `shared/composer-highlight.ts` and carries VIM
  keybindings (`@replit/codemirror-vim`), ON by default and opening in INSERT.
  Esc is context-dependent (leaves vim INSERT/VISUAL, otherwise interrupts the
  turn). The `.av-composer-vim` chip in the bar is both the toggle and the mode
  readout; the preference persists via `renderer/composer-vim-pref.ts`.
  `window.__cmComposerView` is the E2E seam. All the CodeMirror/vim theming and
  keymap collisions are documented in `agent-view-design.md`.
  Its `domEventHandlers` also drop the Linux **middle-click PRIMARY-selection
  paste**: a middle click pastes text merely *selected* anywhere on the system,
  and a trackpad on `click_method=clickfinger` (Apple default) emits button 2
  for a three-finger PHYSICAL click — so resting a third finger while clicking
  silently dumped the last selection into the prompt. `mousedown` records a
  button-1 click and `paste` swallows the paste it triggers, correlated by
  timestamp via `shared/middle-click-paste.ts` (`isMiddleClickPaste`, ~2ms
  measured, 1s window); Ctrl+V/Cmd+V and the context menu are uncorrelated and
  pass through. Note the same hazard exists in the xterm terminals and is NOT
  fixed there: xterm's helper textarea is permanently focused and Chromium
  inserts the selection below the DOM, so preventDefault on the paste, on
  `beforeinput`, and on the middle-click mouse events were all measured
  ineffective (only the CodeMirror composer has a cancellable paste).
- **App-quit durability — the detached session keeper.** A LOCAL session's
  `claude` subprocess is spawned THROUGH a tiny detached daemon
  (`spawnClaudeCodeProcess: makeKeeperSpawn(wsId)` in ensureSession →
  `src/main/keeper-client.ts` → `src/keeper/index.ts`), so quitting Orchestra
  only detaches: an in-flight turn keeps running, and reopening the workspace
  lazily reattaches (`sdkAttachIfDetached`, fired from the `agentSdkHistory`
  handler) with parked permission requests redelivered by the attach
  handshake. Explicit stops (`sdkStop`, incl. its no-session path) DO kill the
  keeper + CLI. Full reference: `docs/codebase-map/session-keeper.md`; measured
  SDK semantics: `docs/spikes/keeper-findings.md`; gate:
  `scripts/verify-keeper-detach.mjs`.
- **Resume durability across reboot / internet loss.** A structured session is
  NOT a live process that survives a restart (except within the keeper's
  linger window above) — it's a *resume by id*. The SDK
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
- **Answerable dialogs & elicitations (#21)** — two MORE ways a live session
  blocks on the human, both of which used to hang it silently. Wired at the SAME
  single `query()` site as `canUseTool` (agent-sdk.ts), parked in their own maps,
  and rendered by the SAME slot.
  - **`onUserDialog`** — the CLI asks the host to render a blocking dialog
    (`request_user_dialog`). Bridge: `makeOnUserDialog` (agent-sdk.ts) → parks in
    `session.pendingDialogs` → emits `makeUserDialogRequest` →
    `AgentUserDialogRequestEvent`.
    **`supportedDialogKinds` is a HARD OPT-IN, not a hint:** the CLI fails closed
    and emits NOTHING for a kind not declared there, so wiring the callback alone
    is a green build with a dead feature. Orchestra declares
    `SUPPORTED_DIALOG_KINDS = ['refusal_fallback_prompt']` (agent-sdk.ts) — the
    one kind SDK 0.3.241's d.ts names. Passing a non-empty list WITHOUT the
    callback throws at option intake, so the two are set together.
    **An undeclared kind is left UNANSWERED (`Promise<null>`), never
    `cancelled`** — `cancelled` is a REAL settlement (the CLI treats it as the
    user dismissing the dialog and applies its default), so auto-cancelling would
    settle a dialog another attached client may be the declared renderer for.
    (sdk.d.ts contradicts itself here — the `UserDialogRequest` doc says answer
    unrecognized kinds `cancelled`, the wire-protocol comment on
    `SDKControlRequestUserDialogRequest` says never do that. We follow the
    wire-protocol one; ratified as ledger #49 D21-1.)
  - **`onElicitation`** — an MCP server asks the user for input. Bridge:
    `makeOnElicitation` → `session.pendingElicitations` → `makeElicitationRequest`
    → `AgentElicitationRequestEvent`. No opt-in list; without the callback the SDK
    AUTO-DECLINES, which was the silent failure. `mode` is optional on the SDK
    type and NORMALIZED at the boundary (`url` present ⇒ `'url'`, else `'form'`).
  - **One queue, one slot.** All three answerables fold into
    `AgentSession.pendingAnswerables` (agent-events.ts) in ARRIVAL order, so a
    dialog landing mid-permission QUEUES instead of stacking a rival modal.
    Permissions stay in `pendingPermissions` too (unchanged for existing callers);
    both lists are cleared by the same events so they cannot drift.
    **De-dupe and clear match the (kind, requestId) PAIR, not the id alone** — the
    SDK keys each control-request channel independently, so one id can be live as
    two different kinds; de-duping by id would swallow a card and leave its
    callback parked forever (`clearPendingAnswerable`, unit-tested).
  - **Replies** route through ONE channel, `agentSdkAnswerableReply(wsId,
    requestId, {kind, reply})` → `sdkAnswerableReply` (agent-sdk.ts), which
    dispatches on `kind` to the right parked map (permission delegates to
    `sdkPermissionReply`, keeping one implementation). Reply shapes mirror the SDK:
    `UserDialogResult` (`completed`+`result` / `cancelled`) and MCP `ElicitResult`
    (`accept`+`content` / `decline` / `cancel`). `ElicitResult.content` is flat
    primitives only — `AgentElicitationValue = string|number|boolean|string[]`,
    NOT `unknown`.
  - **Both drive the status dot** exactly like a permission: the bridges call
    `fireNeedsInput` on park and `resumeRunning` on every exit, and
    `sdkEventToStatusEvent` maps both new types to `notify` — without which the
    dot reads `running` (green) while the agent is in fact blocked.
  - **`consume()`'s turn-end sweep** resolves stragglers in all three maps
    (`cancelled` / `cancel`), since a turn cannot end with one still parked.
  - **UI**: `UserDialogCard.tsx` + `ElicitationCard.tsx`, rendered by
    `PermissionDialog` (the unified slot) inside the existing
    `.av-permission-backdrop`. The dialog card renders its payload
    **GENERICALLY** — `dialogKind` is an OPEN union and `payload` is opaque, so it
    probes conventional keys (`userDialog.ts`: title/message/options, both string
    and `{value,label}` encodings) and falls back to the humanized kind + raw
    payload rather than a blank card. That is what makes `SUPPORTED_DIALOG_KINDS`
    safe to grow without new UI. Elicitation schema→fields lives in
    `src/shared/elicitation-form.ts` (unit-tested: hostile-schema degradation,
    required-boolean-`false`-is-an-answer, blank-is-not-zero numeric coercion).
    Gate: `scripts/answerable-cards-render-smoke.mjs` (chained into
    `pnpm run test:render`), mutation-tested on the dismiss-must-not-accept,
    required-field-gate and `rel=noreferrer` guards.
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
  **The switcher's list is DYNAMIC**: `AgentControls` fetches the live runtime
  list via **`agentModels`** (`agent:models` → `sdkListModels(wsId)` in
  agent-sdk.ts — the Agent SDK's `query.supportedModels()`, the same source as
  Claude Code's `/model` picker, cached in-memory per ACCOUNT config dir so
  sessionless workspaces reuse a sibling's fetch; `[]` = unknown). New models
  therefore appear without an Orchestra release. `modelChoicesFrom(models)`
  maps the wire rows (`AgentModelInfo {value, resolvedModel?, displayName,
  description}`) to `ModelChoice`s and falls back to the static
  `MODEL_CHOICES` (**Fable 5, Opus 5, Sonnet 5, Haiku 4.5**; canonical
  aliases, never date-suffixed) when no session has answered yet this app run.
  **Labels are re-derived, not taken from the wire**: `versionedLabel(row)`
  renders the VERSIONED, context-free name — the runtime's `displayName` is the
  bare family ("Opus", "Fable") or carries a parenthetical ("Opus (1M
  context)"), so the label comes from the description's leading segment ("Opus 5
  with 1M context · …" → `Opus 5`), falling back to `resolvedModel`
  (`claude-opus-5[1m]` → `Opus 5`; a date snapshot like
  `claude-haiku-4-5-20251001` → `Haiku 4.5`) and finally to a
  parenthetical-stripped `displayName`. The `default` row keeps its wire label
  ("Default (recommended)") since that IS its meaning. `describeLiveModel`
  likewise never appends "· 1M context" — the context size lives in the
  description line only.
  `choiceCovers(choice, model)` decides which card a concrete model string
  belongs to via `modelKey()` (strip `[1m]`-style suffix + resolve alias)
  applied to **both** sides — normalizing only the incoming model was the
  v0.5.165 bug (an explicit `claude-opus-5` never matched rows resolving to
  `claude-opus-5[1m]`, so a redundant "Account default model" card was prepended
  and checkmarked). `AgentControls` highlights the covering card (preferring a
  non-`default` row, since the live list's "Default (recommended)" row resolves
  to the same id as its family row) and zips choices with `MODEL_FAMILY_ICONS`
  (substring match on fable/mythos/opus/sonnet/haiku, so post-build models get
  their family icon). `describeLiveModel(id, choices?)` renders a model no card
  covers into a friendly `{label, description}`: strips the bracketed context
  suffix (`[1m]`/`[200k]` → "· 1M context"), maps Claude Code short aliases,
  and reuses the matching card's label. Unknown ids fall back to the raw
  string, prepended as a verbatim card.
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


**The gauge's render decision is PURE — `describeContextGauge()`** in
`context-usage.ts` returns `{label, level, fillPct, title, source}` (or null),
and `ContextGauge` renders it with NO conditionals of its own. This is
structural, not stylistic: the visibility decision used to live in the
component, where `node --test` cannot reach it (the strip-types runner does not
transform JSX), so reverting the null-window branch left all 844 unit tests
GREEN while the gauge vanished in the built app. If you find yourself adding a
conditional to the component, put it in `describeContextGauge` instead.

**Renderer-level gate — `scripts/context-gauge-render-smoke.mjs`** (`pnpm run
test:render`). The unit suite CANNOT see the gauge's own render logic: re-adding
a `if (!window) return null` early return to `ContextGauge` — reverting the exact
behaviour the detached-session spec depends on — leaves all 844 unit tests GREEN,
because the behaviour lives in a React component `node --test` never renders
(JSX is not transformed by the strip-types runner). That regression was caught
only by driving the built app. This harness bundles the real component with
esbuild, renders it to static HTML, and fails on that mutation (RC=1).

BOTH layers are needed, and the mutation matrix shows why — neither alone
closes the hole:

| Mutation | Unit suite | Render smoke |
|---|---|---|
| null-window returns nothing (in `describeContextGauge`) | **3 fail** | fail |
| a hide-branch re-added to the **component** | **853 pass, 0 fail** | **fail** |

A decision moved into pure code is gated by the unit seam; a decision that
creeps back into the component is caught only by rendering it. It also
pins the threshold styling, the >100% unclamped number vs the clamped bar, and
`data-context-source` for every source.

## Context gauge sourcing (issue #15)

The gauge has THREE possible sources, normalized to one shape by the pure
`src/shared/context-usage.ts` (unit-tested in `context-usage.test.ts`, 20 tests;
the breakdown lists it also normalizes are covered by `context-breakdown.test.ts`,
25 tests):

| Source | Producer | Shape | When |
|---|---|---|---|
| `live` | `Query.getContextUsage()` | camelCase, `isDeferred` flags | live SDK session |
| `context-command` | `context_usage` on a `/context` result | snake_case, `kind` enum | user runs `/context` |
| `transcript` | `activity.ts computeContextTokens` / history replay | bare token count | no live Query |
| `turn-end` | `AgentTurnEndEvent` fields (inferred) | tokens + sometimes a window | last resort |

**Provenance is readable, not inferred.** Every reading carries
`ContextUsage.source`, `resolveContextUsage` (context-usage.ts) makes the ONE
sourcing decision and tags which producer won, and the rendered gauge carries
`data-context-source`. A driver can therefore assert WHICH path fed the gauge —
necessary because a fabricated turn-end and a real live reading can render the
same number, so the value alone proves nothing. Readable three ways:
`window.__readAgentSession(wsId).contextUsage.source` (emitted readings),
the `data-context-source` DOM attribute (the RESOLVED source, incl. `turn-end`),
or `resolveContextUsage()` directly in a unit test.

- **Primary — live.** `sdkGetContextUsage` (`agent-sdk.ts:1315`) calls
  `session.q.getContextUsage()`, raced against a 3s timeout exactly like
  `sdkListModels` (a control request to a dying subprocess parks forever).
  `refreshContextUsage` (`:1344`) normalizes and emits `session/context`.
  Called at **session bootstrap** (`:1088`, so a reopened pane has a gauge
  before any turn) and **after each turn** (`:732`, at the `result` boundary).
  Returns `null` — never a zeroed reading — on no-session/timeout/bad payload,
  because `0` is the app's "context was reset" sentinel and would clear the badge.
- **Bonus — `/context`.** `normalizeSdkMessage`'s `assistant` case lifts the
  top-level `context_usage` the CLI stamps on the synthetic `/context` message
  (`agent-events.ts:567`). Verified emitted at CLI 2.1.234; costs zero API calls.
- **Fallback — transcript.** Two places, for two different surfaces:
  `computeContextTokens` still drives the SIDEBAR badge over `agent:context`
  (unchanged); and `transcriptToEvents` seeds the STRUCTURED VIEW's gauge by
  accumulating the newest main-chain assistant line's `input + cache_creation +
  cache_read` during history replay (`agent-transcript.ts`, via the pure
  `transcriptContextTokens`) and appending one `session/context` event tagged
  `transcript`. Sidechain lines are excluded and a compaction boundary resets
  the accumulator, mirroring the on-disk recompute. Without this seed a
  history/detached session rendered NO gauge at all: its synthetic terminal
  turn-end carries `usage: null` and there is no live Query to ask.

**Render trigger is PANE MOUNT for both paths** (spec, issue #15): a live Query
renders immediately at mount without waiting for a turn-end, then refreshes
after each turn; a session with no live Query renders the transcript seed at
mount. `StripStats` therefore no longer returns null when `lastTurn` is absent,
and `ContextGauge` no longer requires a caller-supplied WINDOW.

**The transcript fallback NEVER invents a window** (audit ruling, final). A
percentage computed against a window nobody chose is a fabricated number, and a
confidently wrong percentage is worse than none — nobody re-checks a figure that
looks plausible. So `transcriptContextWindow(model)` returns a window ONLY for a
model id explicitly carrying `[1m]` (a positive statement about the window, not
an assumption); everything else returns null and the gauge renders the ABSOLUTE
TOKEN COUNT ("503k used"), which is true.

Measured, which is why this is not a judgement call:
- The transcript records no window at all: `message.context_management` is
  ABSENT on all 1,543 main-chain assistant lines scanned across the largest real
  local transcripts.
- `message.model` carries only the BASE id (`claude-opus-4-8`), never the `[1m]`
  alias — so an earlier "derive a default" implementation reported **251%** on a
  real 1M session that was actually 50% full.
- 17 of 29 workspaces in the real store have NO model set at all, so a default
  would be pure guesswork for most of them.

`sdkHistory` still passes `ws.model` into `transcriptToEvents`, because the
WORKSPACE record is the only place the `[1m]` alias survives (`opus[1m]`,
`claude-fable-5[1m]` are live values) — that is how a genuine 1M session gets a
real 50% instead of a token count.

**A transcript ending in a compaction boundary reports 0, not nothing.** Found
by replaying a real 2159-line transcript whose last boundary sat 19 lines from
EOF with no assistant turn after it: the accumulator correctly reset, then
nothing re-seeded it, so a real detached pane rendered a BLANK gauge. It now
emits a 0 reading — the app's existing "context was reset" sentinel
(`activity.ts resetContext`) — which the gauge renders as a real 0%.

This is an ASSUMED window, and the distinction is preserved rather than hidden:
such readings stay tagged `transcript`, so any live reading supersedes them the
moment a real session attaches. A model whose true window is neither 200k nor 1M
would render a wrong percentage here — which is precisely why the live source
exists and outranks it.

Two traps the normalizer encodes, both with regression tests:
- **Deferred categories are excluded from usage math.** Summing every category
  row overstates usage badly (the verified capture sums 267,809 against a 200K
  window — a >100% gauge on a session that is 37% full). The headline number
  always comes from the producer's own total, never from summing rows;
  `usedTokens()` exists for breakdown renderers and skips `deferred`/`free`.
- **Precedence, not recency.** `isMoreAuthoritative` stops the transcript
  recompute (which fires on every posttool) from clobbering the CLI's exact
  figure seconds after it lands. A stale live reading yields after `STALE_MS`
  (60s) so a dead SDK session cannot freeze the gauge forever.

The gauge no longer clamps its NUMBER at 100% (an over-limit session reads past
it — the state the gauge exists to warn about); only the bar fill is clamped.

### Context breakdown panel (issue #16)

Clicking the gauge opens a popover answering "what is filling my window?".

- **Normalized data.** `ContextUsage` carries four OPTIONAL detail lists beside
  `categories`: `memoryFiles`, `mcpTools`, `skills`, `agents`
  (`context-usage.ts`). Both adapters populate them, which needs more than a key
  alias — the two wire shapes genuinely diverge: `/context` sends `skills` as a
  FLAT ARRAY while `getContextUsage()` sends an OBJECT (`{totalSkills,
  includedSkills, tokens, skillFrontmatter[]}`) with the rows nested under
  `skillFrontmatter`, and `agents` alternates `agent_type`/`agentType`.
  `mapSkills` (`context-usage.ts:295`) sniffs the shape; `mapRows` DROPS rows
  missing a required field rather than defaulting them, so a token-less row
  never renders a measured-looking `0`. A list whose rows all fail to parse
  becomes `undefined`; an EMPTY producer list stays `[]` (issue #31 — `agents: []`
  means "asked, none configured", which is a different fact from an omitted key,
  though no renderer branches on it today).
- **`pluginName` is read off the WIRE, not the `.d.ts`** (issue #31). Plugin
  skill rows carry it (23 of 50 on a live CLI 2.1.241 capture) while sdk.d.ts
  0.3.241 does not declare it, so an adapter typed from the declarations drops
  the only disambiguator between same-named skills from different plugins. It
  now survives normalization and renders as the skills row's meta.
  `ContextBreakdown` REUSES `ContextSkill`/`ContextMemoryFile`/`ContextAgent`
  instead of re-declaring rows inline — the inline copies are how the field was
  lost, since a duplicated row type silently drops whatever the source gains.
- **Render model.** `src/shared/context-breakdown.ts` (pure, unit-tested):
  `buildContextBreakdown` (`:126`) returns ordered `used`/`deferred` rows + the
  `free` row + the four detail lists, or **`null`** when there is nothing to
  show — one null check for the renderer instead of five empty-list checks,
  which is how an empty panel ships. `groupMcpToolsByServer` (`:87`) aggregates
  tools per server (a user reads "which server costs me", not which of its 40
  tools); nameless servers collapse into one `unknown` bucket. `truncateList`
  backs the "+N more" tail (5 rows per list). Zero-token category rows are
  hidden (the SDK's own docs say renderers typically do).
- **`percentOfWindow` is a share of `maxTokens`, not of the summed rows** — so
  the used rows deliberately do NOT total 100%, and `usedTotal` is the legend's
  own arithmetic while the headline number stays the producer's `totalTokens`.
- **Graceful degradation is gated on CONTENT, not `source`.** `hasBreakdown`
  now LIVES IN `context-usage.ts` (moved there when `describeContextGauge` grew
  an `expandable` field — importing `context-breakdown.ts` from `context-usage.ts`
  would be circular, and the predicate reads only `ContextUsage` fields, so that
  is its natural home; `context-breakdown.ts` re-exports it so breakdown callers
  keep one import site). The renderer does NOT call it: per this file's own
  "no decisions in the component" rule, the panel's show/hide is decided in the
  pure layer as `ContextGaugeView.expandable`, where a test can execute it.
  It is what the gauge checks: true when any category carries tokens or
  any detail list is non-empty. The transcript fallback has only a token count,
  so it fails the gate and the gauge renders as the pre-#16 static readout with
  no button semantics and no hover affordance. A live reading whose categories
  all came back zero degrades identically — there is no empty-state panel.
- **Render coverage.** `scripts/context-gauge-render-smoke.mjs` (`pnpm run
  test:render`) also pins the #16 show/hide against real rendered HTML: a
  reading WITH categories must produce `.av-turn-context-btn` inside
  `.av-ctx-anchor` with `aria-haspopup="dialog"` and NO `.av-ctx-panel` before a
  click; a transcript reading and a live-but-all-zero reading must both stay a
  plain div. Every pre-#16 fixture in that script carries no categories, so
  without these cases the BUTTON path had zero render coverage. Mutation-tested
  both ways: forcing `expandable` true fails the three degradation assertions,
  forcing it false fails the three button assertions.
- **UI.** `ContextBreakdownPanel.tsx` — `ContextBreakdownBody` (`:136`, the
  markup, renderable standalone by a visual rig) inside `ContextBreakdownPanel`
  (`:237`, the popover shell: outside-click + Escape dismiss, `role="dialog"`,
  `aria-label="Context breakdown"`; Escape is captured and `stopPropagation`'d
  so it does not also reach the composer's own handler). The trigger carries
  `aria-haspopup="dialog"`/`aria-expanded` and an `aria-label` naming the
  percentage. Deferred rows render in their OWN section with an explicit
  "Not loaded — excluded from the totals above."
- **CSS.** The `av-ctx-*` layer in `agent-view-theme.css:2489`, in the view's
  existing popover language (`.av-rc-panel`'s glass on `--av-*` tokens). The
  5-slot segment palette is assigned **by rank** (rows arrive sorted
  largest-first), never keyed by category NAME — the CLI's names are
  presentation strings that have changed between versions, so a name-keyed map
  would silently collapse to one colour.

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
`onAgentEvent` in `src/shared/ipc.ts` + its `src/preload/index.ts` closure →
store subscription.

## Verified SDK behavior (from the Phase 0 spike)

`docs/spikes/phase0-sdk-findings.md` records the verified stream shapes with real event
JSON: token-level `text_delta`, `input_json_delta` (tool-input streaming), `canUseTool`
allow/deny, `interrupt()` (surfaces as the iterator **throwing** → handled as a terminal
`turn-end`/error, not a crash), `settingSources:['user','project']` loading the full
interactive tool set, the `SDKResultMessage` fields, diffs-from-input, streaming-input
multi-turn, and the packaging (SDK + native `claude` binary ship in `app.asar`). Redacted
thinking on Opus 4.8 and frequent transient 500s (arrive as `is_error` result messages) are
documented there.

## Voice dictation (composer mic — design "A: ghost inline")

Local push-to-talk STT into the composer, validated in a standalone PoC (`~/voice-poc`)
before landing. Dev-gated: `voiceAvailable()` requires `ORCHESTRA_VOICE_DIR`
(default `~/voice-poc`) to hold `whisper.cpp/build/bin/parakeet-cli` +
`models/ggml-parakeet-tdt-0.6b-v3-f16.bin`; without them the mic UI never renders.

- `src/shared/voice.ts` — pure layer: `VoiceEvent`, the Haiku ROUTER/EDIT prompts
  (each utterance is routed `append` vs `replace_last` — inline spoken corrections
  revise the previous utterance), `parseRouterReply` (malformed LLM reply degrades to
  append so an utterance is never eaten), and `EnergyEndpointer` (RMS gate + adaptive
  noise floor; sherpa was dropped — key-release is already a hard endpoint and an
  energy gate is language-independent where the monolingual zipformer broke on
  franglais). Unit tests in `src/shared/voice.test.ts`.
- `src/main/voice.ts` — engine: per-workspace `VoiceSession` (PCM in over
  `voice:pcm`), incremental parakeet re-decode of the live utterance for `partial`s
  (same model as finals — the industry-standard shape). Partials are paced by BOTH
  skip-if-busy and a wall-clock floor (`PARTIAL_MIN_GAP_MS` = 1500ms since the last
  decode FINISHED) and run at `PARTIAL_THREADS` = 4 while finals keep
  `FINAL_THREADS` = 8: because every partial re-decodes the whole utterance-so-far,
  skip-if-busy alone gave parakeet a ~100% duty cycle — measured 412% CPU / 51
  CPU-seconds per 12s of speech, versus 112% / 14 CPU-seconds paced (-73%, the
  audible-fan complaint). `lastIncrDoneAt` resets per utterance so each new one
  still paints its first ghost immediately,
  parakeet final on endpoint/stop, persistent `claude -p --input/output-format
  stream-json --model haiku` worker (`HaikuWorker`, serialized asks; cold CLI spawn
  measured ~6s vs ~1.5s warm). Handlers registered inline like `pickDirectory`
  (excluded from the api-handlers table). Events out via
  `platform.broadcast('voice:event', wsId, ev)`.
- `src/renderer/components/agent/useVoiceDictation.ts` — renderer controller:
  permanently-warm mic (getUserMedia + inline AudioWorklet downsampler to 16kHz
  Int16) with ~600ms pre-roll ring (cold pipeline startup measurably ate the first
  syllable: "1469" → "469"), applies events to the composer (`clean append` /
  `replace_last` by last-occurrence string match; edit `revision` splices the
  target). Edit target = CM selection, else last utterance, else full text.
- **Push-to-talk hotkey** — `Ctrl+M` (dictate) / `Ctrl+Shift+M` (voice-edit),
  registered WINDOW-WIDE in `StructuredView` (capture-phase `keydown`/`keyup` on
  `window`, gated on `isActive` so only the visible pane responds). Deliberately not
  an OS-level `globalShortcut`, which would steal the chord from every other app.
  One key expresses two gestures, arbitrated by `voiceReleaseAction`
  (`src/shared/voice.ts`, pure + unit-tested against `VOICE_TAP_MS` = 400):
  a HOLD (≥400ms) stops on release — true push-to-talk; a TAP latches the mic on
  until the next tap. Three traps the pure function encodes, each observed:
  (1) `voiceStart`+`getUserMedia` are async, so a fast hold can release before the
  mic exists — that release returns `'defer'` and is re-applied once the start lands,
  because dropping it strands the mic ON; (2) a key-up with no press outstanding
  (mic started by CLICK) is `'ignore'`, never a zero-length tap; (3) key-repeat is
  debounced with a `keyDownRef` "physically down" flag, NOT by testing
  `micState !== 'idle'` — that also matches a LATCHED mic and silently swallowed the
  second tap meant to stop it (caught only in the e2e drive: the rule was right, the
  guard around it wasn't). `window` blur counts as a release for the same
  stranded-mic reason. The `Ctrl-m` entries in `CmComposer`'s keymap remain as the
  vim claim + fallback, and normally never fire (the window handler stops
  propagation first); a CodeMirror keymap sees no keyup so it cannot express a hold.
  The mic button exposes `data-state='rec'` plus `data-held='1'` while the key is
  down, which is what distinguishes held (filled halo) from latched (bare pulse).
- `ghostForEvent(ev, micState)` (`src/shared/voice.ts`, unit + mutation tested) is
  the SINGLE decision point for the composer ghost: `null` clear / `undefined`
  leave / string paint. It exists because the ghost is the only voice state the
  user sees while the mic is OFF, and every stranding path failed silently —
  `stop()` skips `finalize()` for a sub-0.4s tail, `finalize()` returns early on
  an empty transcription, and a `partial` decode in flight resolves AFTER the mic
  goes idle. It is LEVEL-triggered on `micState` (idle ⇒ never paint), so the hook
  no longer relies on each case remembering to clear. Main pairs it with an
  explicit `partial:''` on both dead ends, and `state:'stopped'` is the
  guaranteed terminator on every stop path.
- `CmComposer` — `setGhost(text|null, kind)` renders partials as a `WidgetType`
  pinned at doc end (`.av-ghost`, grey italic; `.av-ghost-edit` amber) — never real
  doc text, so send/undo/caret can't touch it. `getSelection()` feeds edit mode.
- `StructuredView` Composer — mic + voice-edit chips in `.av-composer-bar` (flat,
  colour-carried rec state like the vim chip; `verify-composer-card.mjs` contract),
  `.av-voice-status` latency readout; workspace branch + repo folder are appended to
  the speaker dictionary (`DEFAULT_VOCAB`) so repo jargon transcribes right.
- Speaker dictionary — three layers, concatenated in `useVoiceDictation.ts:205`
  *inside* `toggle` (not a hook dep), so a Settings edit applies to the next
  utterance with no remount: `DEFAULT_VOCAB` (hardcoded baseline,
  `shared/voice.ts`) + the user's GLOBAL list (`renderer/voice-dictionary.ts`,
  localStorage key `orchestra:voiceDictionary`) + per-workspace terms (branch +
  repo folder, `StructuredView.tsx:1093`). The dictionary is consumed only by
  the Haiku stage (`ROUTER_PROMPT` / `EDIT_PROMPT` `{vocab}`) — parakeet never
  sees it, so it fixes SPELLING, not recognition.
- `VoiceDictionarySettings.tsx` — textarea modal editing that global list
  (`.voice-dict-input`), opened from the Sidebar header mic button; mirrors
  `SoundSettings` / `AgentViewSettings` (localStorage pref, persist-on-keystroke,
  no Cancel). `parseVoiceDictionary` splits on comma/newline/semicolon, trims,
  drops case-insensitive dupes, preserves casing.
