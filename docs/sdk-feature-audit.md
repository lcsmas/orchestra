# @anthropic-ai/claude-agent-sdk feature-gap audit

Audited 2026-08-24 on branch `bump-anthropic-sdk-check`. Installed SDK: **0.3.216**
(`package.json` pin, confirmed via `node_modules/@anthropic-ai/claude-agent-sdk/package.json`).
Latest npm: **0.3.241** (2026-08-22). Ground truth for the 0.3.216 surface is the installed
`node_modules/@anthropic-ai/claude-agent-sdk/sdk.d.ts` (7,087 lines); Orchestra's consumption
was enumerated from `src/main/agent-sdk.ts` (2,810 lines, read end-to-end),
`src/main/agent-browser-tools.ts`, and `src/shared/agent-events.ts` (the normalizer).

## TL;DR

- Orchestra uses 18 of 63 `Options` fields, ~13 of ~28 `Query` control methods, and 2 of ~17 exported top-level functions; the normalizer handles ~22 of ~38 `SDKMessage` kinds — roughly **87 surface items in the already-installed 0.3.216 go unused**.
- The biggest wins already available at 0.3.216: `getContextUsage()` (replace the transcript-JSONL context recompute in `activity.ts`), the session-management API (`listSessions`/`getSessionMessages`/`forkSession` — replace hand-rolled transcript-dir scanning in `sdkHistory`), `stopTask()`/`backgroundTasks()` for the Background-tasks panel, `setMcpServers()` (dynamic MCP without the full CLI restart `sdkMcpRefresh` does today), and the `hooks`/`onUserDialog`/`onElicitation` callbacks (dialogs and MCP elicitations are currently unanswerable headless).
- The 0.3.216→0.3.241 bump is **compile-safe for Orchestra**: the one breaking type change (0.3.234 removed `bypass_permissions_disabled` from `ExitReason`) has zero references in `src/` (`ExitReason` itself is never imported).
- Most changelog entries are **CLI-parity items**: Orchestra spawns the user's installed `claude` binary (`pathToClaudeCodeExecutable`, agent-sdk.ts:946/990), so runtime behavior (todo-tool removal, subagent depth cap) already tracks the installed CLI regardless of the npm pin — the bump mainly refreshes types and the SDK-side bridge.
- Of 49 substantive changelog items in 0.3.217–0.3.241, ~16 are relevant to Orchestra; top ones: structured `SDKContextUsage` on `/context` (0.3.232), `effort` on `system/init` (0.3.234 — removes the "SDK never reports effort back" gap at agent-sdk.ts:1796), `cancel_queued` interrupts (0.3.219), `crossSessionInbound` (0.3.224), headless background-subagent resume fix (0.3.225), and `background_tasks_changed` snapshot on re-initialize (0.3.239 — keeper reattach).

---

## What Orchestra USES today (baseline)

**Options passed to `query()`** (agent-sdk.ts:953–1067): `mcpServers` (in-process browser
server), `cwd`, `includePartialMessages`, `agentProgressSummaries`, `settingSources`,
`permissionMode`, `allowDangerouslySkipPermissions`, `canUseTool`, `env`,
`pathToClaudeCodeExecutable`, `spawnClaudeCodeProcess` (keeper), `model`, `effort`,
`resume`, `resumeSessionAt`, `systemPrompt` (preset+append), `enableFileCheckpointing`,
`maxTurns`.

**Query methods called**: `interrupt` (1706, 2619), `setPermissionMode` (1831), `setModel`
(1771), `applyFlagSettings` (1802, effortLevel only), `supportedModels` (1258),
`reloadSkills` (1913), `reloadPlugins` (1954), `mcpServerStatus` (2161), `toggleMcpServer`
(2193), `reconnectMcpServer` (2317, 2572), `rewindFiles` (2699, 2767), plus two
**undocumented** methods typed locally: `enableRemoteControl` (2054–2056, 2107) and
`mcpAuthenticate` (2432, 2497).

**Top-level exports used**: `createSdkMcpServer` + `tool` (agent-browser-tools.ts:15–28).

**Message kinds handled** by `normalizeSdkMessage` (agent-events.ts:501–820): `system/init`,
`stream_event`, `assistant`, `user`, `result`, `auth_status`, `rate_limit_event`, `status`,
`api_retry`, `compact_boundary`, `local_command`/`local_command_output`, `informational`,
`notification`, `permission_denied`, `model_refusal_fallback`/`_no_fallback`,
`thinking_tokens`, `worker_shutting_down`, `task_started`/`task_progress`/`task_updated`/
`task_notification`, `background_tasks_changed`.

**SDK-level hooks registered: none.** The `hooks` option is never passed; Orchestra's hooks
are shell hooks in `<worktree>/.claude/settings.local.json` loaded via
`settingSources: ['local']` (agent-sdk.ts:967–980).

---

## Unused features available in the installed 0.3.216

Effort: S = wire-up only, M = new UI or plumbing, L = design work.

### Query control methods (sdk.d.ts:2252–2558)

| Feature | d.ts line | What Orchestra could use it for | Effort |
|---|---|---|---|
| `getContextUsage()` | 2403 | Per-category context breakdown (system prompt / tools / MCP / memory / messages) for the ContextGauge; replaces (or enriches) the transcript-tail JSONL recompute in `activity.ts:523 computeContextTokens` | S |
| `usage_EXPERIMENTAL…()` (/usage data) | 2417 | Session cost + plan rate-limit windows per session — could feed the usage bars without the OAuth-endpoint polling in `account-usage.ts` (experimental; API may change) | M |
| `supportedCommands()` | 2378 | Composer `/` autocomplete: today `sdkListSkills` (agent-sdk.ts:1288) scans skills dirs by hand and misses plugin commands and built-in slash commands | S |
| `supportedAgents()` | 2390 | Agent-type picker / show which subagents a Task call can use | S |
| `initializationResult()` | 2355 | Cached init payload (commands, models, account, output style) without waiting for a turn's `system/init` | S |
| `reinitialize()` | 2372 | Explicit re-init after keeper reattach transport gaps — redelivers parked `canUseTool` dialogs the ring buffer evicted; today reattach relies on the implicit first-connect handshake (agent-sdk.ts:991–1018) | M |
| `setMcpServers()` | 2523 | Add/remove MCP servers on the LIVE session. `sdkMcpRefresh` (agent-sdk.ts:2261) currently **restarts the whole CLI process** to re-enumerate | M |
| `setMcpPermissionModeOverride()` | 2290 | Per-MCP-server permission tightening (force prompts for one server while the session runs bypass) — a natural fit for the `/mcp` popover | M |
| `stopTask(taskId)` | 2535 | A Stop button on Background-tasks panel cards (task ids are already folded from `task_notification`) | S |
| `backgroundTasks(toolUseId?)` | 2548 | Ctrl+B parity: background a long-running foreground Bash/subagent from the UI instead of interrupting the turn | M |
| `readFile(path)` | 2428 | Read files through the session for REMOTE/sandbox workspaces (no local fs there); local diff/file views read fs directly today | M |
| `seedReadState()` | 2472 | Only matters with context-snipping clients; not currently applicable | — |
| `close()` | 2557 | Hard-kill path; Orchestra uses `interrupt()`+keeper EOF-escalation instead (agent-sdk.ts:2624–2627) — deliberate, no action | — |
| interrupt receipt (`SDKControlInterruptResponse.still_queued`) | 2262, 3451 | `sdkInterrupt` discards the resolved value (agent-sdk.ts:1706) — queued async messages (e.g. peer deliveries) may still run after an interrupt with no UI indication | S |

### Options fields (sdk.d.ts:1295–2036) — notable unused

| Feature | What Orchestra could use it for | Effort |
|---|---|---|
| `hooks` (SDK callbacks, 30 `HOOK_EVENTS`, sdk.d.ts:797) | Typed in-process PreToolUse/PostToolUse/Stop/Notification observation in main — could replace parts of the shell-hook + events-spool plumbing for SDK sessions (status dot, needs-input) | L |
| `onUserDialog` / `supportedDialogKinds` | CLI dialog requests (trust prompts etc.) currently have no headless answerer — they presumably time out or block; wiring a renderer dialog closes a silent-failure hole | M |
| `onElicitation` | MCP elicitation requests (servers asking the user for input) are unanswerable today — those tools fail in structured sessions | M |
| `includeHookEvents` | Render `hook_started`/`hook_progress`/`hook_response` frames (transparency into the settings.local.json hooks that already run) | S |
| `thinking` (ThinkingConfig) | Explicit thinking control (adaptive / budgeted / off) next to the Effort slider | M |
| `betas: ['context-1m-2025-08-07']` | Explicit 1M-context opt-in instead of encoding it in the model alias string (`opus[1m]`) | S |
| `maxBudgetUsd` / `taskBudget` | Per-session cost caps for autonomous agents — a real safety knob for a 20-workspace sidebar | M |
| `outputFormat` (json_schema) | Structured outputs for programmatic runs (self-tune pipeline, loop-scan verdicts) | M |
| `agents` / `agent` (AgentDefinition, sdk.d.ts:38) | Define Orchestra-flavored subagents programmatically (verifier, explorer) without writing `.claude/agents` files into every worktree | M |
| `allowedTools` / `disallowedTools` / `tools` / `toolConfig` / `toolAliases` | Tool-surface control; **required to keep TodoWrite/TaskCreate on newer models after the CLI-side 0.3.233 change** (see risks) | S |
| `fallbackModel` | Auto-fallback when the chosen model is overloaded, instead of surfacing the 529 to the user | S |
| `forkSession` (+ `forkSession()` function) | Non-destructive rewind: fork at a message instead of truncating with `resumeSessionAt` (agent-sdk.ts:2687 sdkRewind); "duplicate conversation" affordance | M |
| `sessionId` | Mint the session id up front — removes the persist-on-first-stream-message dance (`persistSessionId`, agent-sdk.ts:698–702) and the adopt-newest-transcript heuristic in `sdkWake` (1450–1457) | M |
| `title` (+ `renameSession()`) | Title sessions with the workspace branch so `claude --resume` pickers and session lists are legible | S |
| `promptSuggestions` | Suggestion chips after a turn (pairs with the unhandled `prompt_suggestion` message kind) | M |
| `forwardSubagentText` | Stream subagent text into the transcript — Background-task cards currently show only usage/summary heartbeats | M |
| `persistSession` / `sessionStore` / `sessionStoreFlush` | Custom session persistence; NOTE sdk.d.ts documents `enableFileCheckpointing` (which Orchestra sets) as incompatible with `sessionStore` — deliberate non-use, keep it that way | — |
| `plugins`, `skills`, `settings`, `managedSettings`, `sandbox`, `strictMcpConfig`, `planModeInstructions`, `permissionPromptToolName`, `additionalDirectories`, `extraArgs`, `loadTimeoutMs`, `executable`/`executableArgs`, `debug`/`debugFile`/`stderr`, `abortController`, `continue`, `fallbackModel`, `maxThinkingTokens` (deprecated) | Misc, low current value; `abortController` could simplify teardown, `continue` is subsumed by the explicit `resume` id | — |

### Top-level exported functions (unused: 15 of ~17)

| Feature | d.ts line | What Orchestra could use it for | Effort |
|---|---|---|---|
| `listSessions()` / `getSessionInfo()` | 935 / 710 | Session pickers, replacing `newestTranscriptFile`'s mtime scan (agent-sdk.ts:1091) | S |
| `getSessionMessages()` | 740 | History backfill: replace the hand-rolled 4MB-tail JSONL read + parse in `sdkHistory` (agent-sdk.ts:1115–1179) with the SDK's own reader | M |
| `getSubagentMessages()` / `listSubagents()` | 777 / 990 | Drill into a background subagent's transcript from its task card | M |
| `forkSession()` / `deleteSession()` / `renameSession()` / `tagSession()` | 681 / 528 / 2571 / 6809 | Fork-instead-of-truncate rewind; delete transcript on `/clear` (today `sdkClear` orphans the JSONL on disk); branch-named session titles | S–M |
| `resolveSettings()` / `filterEscalatingDefaultMode()` | 2627 / 642 | Replace the hand-rolled 3-layer `settings.json` model lookup in `sdkDefaultModel` (agent-sdk.ts:1213–1233) with the SDK's real precedence resolver | S |
| `startup()` (+ `WarmQuery`) | 6695 / 7056 | Pre-warm a CLI process so the first turn of a freshly-opened workspace doesn't pay spawn latency | M |
| `importSessionToStore()` / `InMemorySessionStore` / `foldSessionSummary()` | 838 / 875 / 663 | Only meaningful with a custom `sessionStore` — n/a today | — |

### SDKMessage kinds the normalizer drops (union at sdk.d.ts:3981)

Unhandled (verified: zero matches in agent-events.ts / agent-sdk.ts): `hook_started`,
`hook_progress`, `hook_response`, `tool_progress`, `tool_use_summary`, `plugin_install`,
`session_state_changed`, `commands_changed`, `files_persisted`, `memory_recall`,
`elicitation_complete`, `prompt_suggestion`, `mirror_error`, `conversation_reset`,
`control_request_progress`. Most are cosmetic; the interesting ones are `tool_progress`
(live progress on slow tools), `commands_changed` (invalidate the composer's skill cache
instead of rescanning), and `session_state_changed`.

---

## New in 0.3.217 → 0.3.241 (nothing here is usable until the bump)

Relevant to Orchestra (changelog version in parens):

| Feature | Since | What Orchestra could use it for |
|---|---|---|
| Structured `SDKContextUsage` payload on `/context` results | 0.3.232 | Context-usage card without parsing markdown; complements `getContextUsage()` |
| `effort` field on `system/init` | 0.3.234 | The session finally reports its applied effort — removes the workaround documented at agent-sdk.ts:1793–1796 ("the SDK never reports effort back"; renderer reads `ws.sdkEffort` on faith) |
| `cancel_queued` on interrupt (`interrupt_cancel_queued_v1`) | 0.3.219 | Make Stop actually stop: cancel queued/pending-dispatch async messages (peer deliveries) along with the abort |
| `crossSessionInbound` + `dialogExpiry` settings; `peer-send-message` origin subkind | 0.3.224 | Native cross-session SendMessage moderation — inbound messages to bypass sessions held for approval; a native sibling of orchestra-comms socket messaging. The origin subkind refines the `peer` badge (agent-events.ts:926–930) |
| Peer `origin.fromMode` (same-permission-class auto-delivery) | 0.3.234 | Peer messages between Orchestra's bypass sessions deliver without prompting |
| Background subagents never resuming in headless/SDK sessions — FIX | 0.3.225 | Directly fixes Orchestra's exact configuration (headless SDK + background tasks panel) |
| `background_tasks_changed` snapshot after repeated `initialize` | 0.3.239 | Keeper reattach: a reconnecting app immediately sees background tasks still running from before the quit |
| `hooks_applied` in re-initialize response; SDK hook callbacks re-apply after re-init — FIX | 0.3.238 | Prereq for adopting SDK-level `hooks` alongside the keeper (hooks silently not applying after reattach is exactly Orchestra's topology) |
| `is_backgrounded` + `spawn_depth` on `task_started` | 0.3.238 | Distinguish backgrounded vs foreground tasks and nesting depth on Background-task cards |
| `command_lifecycle` state `refused` for declined cross-session messages | 0.3.238 | Sender-side feedback if Orchestra adopts native cross-session messaging (`command_lifecycle` is not in the 0.3.216 sdk.d.ts at all — 0 matches) |
| `api_error_status: 529` on repeated-overload results (and 429/529 mid-stream, 0.3.218) | 0.3.223 | Orchestra already threads `api_error_status` → `apiErrorStatus` (agent-events.ts:634); after the bump overload terminations become structurally detectable (auto-retry / backoff UI) |
| `resumeDropsTurn` option | 0.3.223 | Safety check for `sdkRewind`'s truncating resume — CLI refuses if the cut would drop more than intended |
| External `mcpServers` connected before first turn — FIX | 0.3.221 | Guards against tool-calls-as-literal-text; Orchestra's browser server is an in-process SDK server so likely unaffected, but future external servers via `setMcpServers` benefit |
| Notification hooks fire for pending permission prompts on the SDK path | 0.3.233 | Parity for needs-input notification if SDK hooks are adopted |
| `terminal_slash_commands` on init | 0.3.229 | Hide terminal-only commands from composer autocomplete if `supportedCommands()` is adopted |
| Cost fields: US-inference 1.1× multiplier in `total_cost_usd` (0.3.239); `canonicalModel`/`provider` in `modelUsage` (0.3.218); `usage` vs `modelUsage` semantics documented (0.3.223) | 0.3.218–239 | More accurate `costUsd` in TurnFooter; `modelUsage` (cumulative) is the documented field for cost accounting — relevant to the known cumulative-usage gotcha (memory: SDK result.usage is cumulative) |

Irrelevant / no current surface: `SkillToolOutput.background` (0.3.218), fast-mode fields
(0.3.219), `DirectoryAdded` hook, `sandbox.network.strictAllowlist`, `workflowSizeGuideline`
(0.3.219), skills-option validation (0.3.221), `sessionStore`+`resume` fix (0.3.222),
`system/permission_denied` in bare headless (0.3.223 — Orchestra supplies `canUseTool`),
plugin `archive` source, sandbox credential masking (0.3.224), long-path session-dir fix
(0.3.224 — Orchestra worktree paths are well under 200 chars), `output_tokens_details`
(0.3.228), 32MB `api_error` reclassification (0.3.229), vcs_state_changed refinements
(0.3.232/234/238), `ApiKeySource` values (0.3.234), `classifierContext` (0.3.236 — no auto
mode), `suppressOriginalPrompt` (0.3.238), prompt-suggestion near-limit fix (0.3.238),
`SYSTEM_PROMPT_DYNAMIC_BOUNDARY` Bedrock fix (0.3.239).

---

## Upgrade risks for a 0.3.216 → 0.3.241 bump

1. **0.3.234 removed `bypass_permissions_disabled` from `ExitReason` — NO impact.**
   `grep -rn "bypass_permissions_disabled" src/` → 0 hits; `grep -rn "ExitReason" src/` → 0
   hits (the type is never imported). Positive control in the same grep batch: `TodoWrite`
   matched 5 files, so the instrument works. No compile break.

2. **0.3.233 removed todo/task tools (`TaskCreate`/`TaskGet`/`TaskUpdate`/`TaskList`,
   `TodoWrite`) from the default tool surface on Opus 4.8 / Sonnet 5 / Fable 5 / Mythos 5
   and newer — impact: UX, not compile, and it is CLI-gated, not SDK-gated.** Orchestra
   passes no `tools`/`allowedTools` option (verified against the full options object,
   agent-sdk.ts:953–1067), and the renderer renders TodoWrite plans
   (`src/renderer/components/agent/tool-util.ts:80–87`, ToolCard.tsx, StructuredView.tsx).
   Because Orchestra spawns the **installed** `claude` binary, whether agents still get
   these tools is decided by that CLI's version today, independent of the npm pin — i.e. on
   a current CLI the todo cards may already have stopped appearing on newer models. Fix
   regardless of the bump: name the tools in `allowedTools` (or set
   `CLAUDE_CODE_ENABLE_TODO_TOOLS=1` in `buildSdkEnv`) if the todo panel should keep working.

3. **0.3.217 subagent depth cap 5 → 1 (and ≤20 concurrent) — no code impact.**
   `grep -rn "SUBAGENT" src/` → 0 hits; Orchestra sets neither
   `CLAUDE_CODE_MAX_SUBAGENT_SPAWN_DEPTH` nor the concurrency var. Orchestra's own
   fan-out is workspace-per-agent via the `orchestra` CLI, not nested SDK subagents.
   Behavioral note only: agents inside structured sessions can no longer have their
   subagents spawn sub-subagents by default — again governed by the installed CLI, not
   the npm pin.

4. **General:** since 0.3.216 the two undocumented methods Orchestra calls
   (`enableRemoteControl`, `mcpAuthenticate`) are typed locally with `typeof … ===
   'function'` guards (agent-sdk.ts:2093, 2436), so their disappearance or rename in
   0.3.241's `sdk.mjs` would degrade to the existing "not available in this Claude Code
   version" error paths, not a crash. Their continued presence in 0.3.241 was NOT verified.

---

## VERIFIED

- Installed SDK version is 0.3.216 — `node -e "require('./node_modules/@anthropic-ai/claude-agent-sdk/package.json').version"` → `0.3.216`; `package.json` pins `0.3.216`.
- Full `Options` field list (63 fields) — extracted from sdk.d.ts:1295–2036; full `Query` method list — read verbatim at sdk.d.ts:2252–2558.
- Orchestra's used option set and Query-method set — `src/main/agent-sdk.ts` read end-to-end (options object at 953–1067; each method call cited by line above); the only other SDK importer is `src/main/agent-browser-tools.ts` (`createSdkMcpServer` + `tool`, lines 7–28), confirmed by `grep -rn "claude-agent-sdk" src/` (3 files incl. a comment in types.ts:846).
- Handled message kinds — case labels enumerated from `src/shared/agent-events.ts` (lines 273–818); unhandled kinds confirmed by `grep "command_lifecycle\|hook_started\|tool_progress\|files_persisted\|tool_use_summary\|memory_recall\|prompt_suggestion\|session_state_changed\|commands_changed\|conversation_reset\|elicitation"` → 0 matches in agent-events.ts/agent-sdk.ts.
- No SDK `hooks` option, no `onUserDialog`/`onElicitation`/`includeHookEvents`/`outputFormat`/`fallbackModel`/`allowedTools` anywhere in src (grep, 0 hits, with positive controls matching in the same batches).
- `bypass_permissions_disabled` and `ExitReason`: 0 hits in src/ (positive control passed).
- `getContextUsage` unused; context figure computed from transcript JSONL at `src/main/activity.ts:523` (`computeContextTokens`), broadcast at activity.ts:620.
- `SDKContextUsage` absent from 0.3.216 d.ts (grep → 0); `still_queued` interrupt receipt and `api_error_status` present in 0.3.216 (sdk.d.ts:2262, 4266); `api_error_status` consumed at agent-events.ts:634.
- TodoWrite rendering exists at `src/renderer/components/agent/tool-util.ts:80–87` and ToolCard.tsx.
- Changelog contents for 0.3.217–0.3.241 — read from the fetched CHANGELOG.md (headers verified against version list; 9 of 25 releases are parity-only stubs).

## NOT VERIFIED

- Every claim about what a changelog entry does **at runtime** (fixes, behavior changes, which CLI version gates a feature) — sourced from changelog prose only, not executed.
- That 0.3.241 compiles cleanly against Orchestra beyond the ExitReason check — no trial bump/`tsc` was run in this audit.
- Continued existence of the undocumented `enableRemoteControl`/`mcpAuthenticate` methods in 0.3.241's `sdk.mjs`.
- Whether the installed `claude` CLI on this machine already enforces the 0.3.233 todo-tool removal / 0.3.217 depth cap (would need a live session probe).
- Effort estimates (S/M/L) are judgement, not measurement.
- The per-field sdk.d.ts line numbers in the Options table were derived from an offset listing; field **names** are verified verbatim, individual line numbers may be ±2.
