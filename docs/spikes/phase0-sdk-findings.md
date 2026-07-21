# Phase 0 Spike — Claude Agent SDK structured-agent-view feasibility

**Date:** 2026-07-21
**Branch:** `phase0-sdk-spike`
**SDK:** `@anthropic-ai/claude-agent-sdk@0.3.216`
**CLI on PATH:** `claude` 2.1.216 (`~/.local/bin/claude`) · node 22.22 · pnpm 10.9
**Model observed:** `claude-opus-4-8` (the default login's model)

---

## TOP-LINE VERDICT

**🟢 GREEN — proceed to the swarm**, with **one caveat** the swarm must design around:

- **Live "thinking" text is NOT delivered in cleartext on Opus 4.8.** `thinking_delta`
  and `thinking` content blocks arrive, but their text is empty (only the `signature`
  is populated — the reasoning is redacted/encrypted). A structured UI **cannot render
  a streaming chain-of-thought** from the SDK on the current default model. Everything
  else the plan needs is present and verified. See **(b)** below.

Two secondary notes (not blockers):
- The referenced planning docs (`docs/adr/0001-…`, `docs/plans/sdk-structured-agent-view.md`)
  **do not exist in this worktree** — per session memory they live on branch
  `sdk-structured-agent-view`. The Phase 0 task itself was fully self-specifying, so
  this did not block the spike.
- The public Anthropic API threw transient **500s** repeatedly during the run (server-side,
  documented in the error text). All findings below come from clean, non-500 turns; where a
  phase was re-run to dodge a 500 that is stated.

---

## Q1 — Build & packaging

**PASS.** `pnpm build` (`vite build && build:cli && build:daemon && electron-builder`)
exited **0** with the SDK imported into the Electron **main** bundle.

- **Externalization required?** Yes. Added `@anthropic-ai/claude-agent-sdk` to the main
  rollup `external` array in `vite.config.ts` (modeled on `simple-git`). Without it rollup
  would try to inline a heavy dep tree. With it, the emitted `dist-electron/main.js` contains:

  ```js
  require("@anthropic-ai/claude-agent-sdk")
  ```

  i.e. a runtime `require` resolved from `node_modules` — the SDK source is **not** inlined
  (confirmed: `sdk.mjs` internals absent from `main.js`).

- **Would the packaged app ship it?** **Yes.** Even though electron-builder's `files` globs
  list only `dist/**` + `dist-electron/**`, electron-builder auto-includes the *production
  `node_modules` dependencies the bundle references*. The packaged `app.asar` contains:

  ```
  /node_modules/@anthropic-ai/claude-agent-sdk/sdk.mjs           (+ package.json, bridge.mjs, …)
  /node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64/claude  ← bundled native CLI binary
  /node_modules/@anthropic-ai/claude-agent-sdk-linux-arm64-musl/claude
  ```

  The `files` globs restrict *source*, not `node_modules` — same mechanism that already
  ships `simple-git`/`node-pty`. This matches how `self-tune.ts` spawns `claude` via
  `child_process` today.

- **⚠️ Packaging nuance the swarm must know:** the SDK has **8 platform-specific optional
  native subpackages** (`…-linux-x64`, `…-linux-arm64`, `…-darwin-*`, `…-win32-*`), each
  carrying its own bundled `claude` binary. electron-builder printed:
  > *platform-specific optional dependencies not bundled … `@anthropic-ai/claude-agent-sdk-linux-x64@0.3.216`, `-darwin-*`, `-win32-*`*

  For the **arm64 Linux** target this is harmless — the matching `-linux-arm64` package **was**
  bundled (verified in the asar). But **multi-platform release builds** (the CI matrix builds
  x64 + arm64, mac, win) will need each target's optional native present at pack time. pnpm 10
  does **not** auto-install transitive platform binaries; if a target's `-<plat>` subpackage is
  missing at build time the packaged app for that platform ships without a working SDK CLI.
  **Action for the build owner:** add the needed `@anthropic-ai/claude-agent-sdk-<platform>`
  entries to `optionalDependencies`/`optionalDeps` for each release target, or verify each
  matrix arch installs its own native. Not a Phase 0 blocker (arm64 built clean); a release-time
  checklist item.

---

## Q2 — Event-stream questions (a–h)

All evidence is real JSON pulled from `scratch/spike-sdk.log` (the full event stream). The
spike script is `scratch/spike-sdk.mjs` (+ focused follow-ups `scratch/spike-*-only.mjs`).

### (a) `includePartialMessages` → token-level `text_delta` — **PASS**

The SDK wraps each raw Anthropic streaming event in a `stream_event` envelope
(`{type, event, session_id, parent_tool_use_id, uuid}`). Incremental text arrives as
`content_block_delta` / `text_delta`:

```json
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"I'll do"}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":" these three steps in order. Steps 1 and 2 are independent, so I'll run them together, then read the result."}}}
{"type":"stream_event","event":{"type":"content_block_delta","index":0,"delta":{"type":"text_delta","text":"Step"}}}
```

Stream event types observed: `message_start, content_block_start, content_block_delta,
content_block_stop, message_delta, message_stop`.

### (b) `thinking_delta` and `input_json_delta` — **PARTIAL / IMPORTANT CAVEAT**

- **`input_json_delta` (tool-input streaming) — PASS.** Tool inputs stream in incrementally
  as JSON fragments on a separate content-block index:

  ```json
  {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":""}}}
  {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"{\"command\": \"echo hi > note.txt"}}}
  {"type":"stream_event","event":{"type":"content_block_delta","index":1,"delta":{"type":"input_json_delta","partial_json":"\", \"description\": \"Write hi to note"}}}
  ```

  So the UI can show a tool call's arguments assembling live. Good.

- **`thinking_delta` — EVENTS FIRE BUT TEXT IS EMPTY (redacted on Opus 4.8).**
  With `thinking: { type: 'enabled', budgetTokens: 6000 }`, the stream **does** carry
  `content_block_start` of type `thinking`, plus `thinking_delta` and `signature_delta`
  events — but every `thinking_delta.thinking` string is `""`, and the assembled assistant
  `thinking` block has empty text with only a `signature`:

  ```json
  {"type":"thinking","thinking":"","signature":"EqgDCokBCA8YAipAvSh/RbDJixyEpUFS/s/AN5kTN3JBEBy…(base64)…"}
  ```

  Reproduced cleanly **4×** (with `text_delta` flowing fine alongside and the final answer
  correct — `173 × 241 = 41,693` — so the model *did* reason). This is **redacted/encrypted
  thinking**: the SDK relays the signed thinking block for context-continuity but the
  cleartext reasoning is not exposed to the client on this model. **A live thinking-stream
  panel is not achievable from the SDK on Opus 4.8.** The swarm should not build UI that
  depends on readable thinking text; treat "thinking in progress" as a boolean/spinner
  keyed off the `thinking` content-block start, not a text stream.
  *(Verdict recorded as observed, not assumed — text was empty in every observation.)*

### (c) `canUseTool` fires; `allow` and `deny` both work — **PASS**

`canUseTool` fired for `Bash`, `Write`, and `Read` with `(toolName, input, opts)`.
`opts` carries `toolUseID`, `requestId`, `signal`, `suggestions`, `title`, etc.

- **allow** → the tool then runs. Write allowed:
  - received: `("Write", {file_path, content}, {toolUseID:"toolu_01CP…"})`
  - result: `tool_result` "File created successfully at: …" (see (g)).
- **deny** → returning `{behavior:'deny', message}` blocks the call. First `Bash` was denied:
  ```json
  {"tool_use_id":"toolu_0172B77mpbgcyk6bF3jZhzHD","type":"tool_result","content":"SPIKE: denying this Bash call to prove the deny path.","is_error":true}
  ```
  and the terminal result's `permission_denials` recorded it:
  ```json
  {"tool_name":"Bash","tool_use_id":"toolu_0172B77mpbgcyk6bF3jZhzHD","tool_input":{"command":"echo hi > note.txt","description":"Write hi to note.txt"}}
  ```
  The model then retried the denied step and it was allowed on the second pass — so the host
  has full per-call gating, exactly what Orchestra needs to route permission prompts into
  native UI instead of scraping the terminal.

### (d) `query.interrupt()` stops an in-flight turn — **PASS**

Started a 60-second bash loop (`for i in $(seq 1 60); do echo tick-$i; sleep 1; done`) under
`bypassPermissions`, then called `interrupt()` mid-run. Timeline (ms from start):

```
bash_tool_use        t=4798    ← the 60s command begins
interrupt_sent       t=7299
interrupt_returned   t=7303    ← receipt: {"still_queued":[]}   (returned in ~4ms)
result               t=7365    ← subtype "error_during_execution", is_error:true
```

Total iterator lifetime **~8.2s** for a task that would otherwise run ≥60s → the turn was
genuinely halted. **Behavioral note the swarm must handle:** an interrupted turn surfaces as
the async iterator **throwing** (`Error: Claude Code returned an error result: [ede_diagnostic]
… stop_reason=tool_use`) and/or a terminal `result` with `subtype:"error_during_execution"`.
The host must `try/catch` the `for await` loop and treat interrupt as an expected terminal
state, not a crash. `interrupt()` itself returns a receipt `{still_queued: […]}` (the
`interrupt_receipt_v1` capability).

### (e) `settingSources:['user','project']` loads the interactive Claude environment — **PASS**

The `system/init` message reports the **full interactive Claude Code tool set**, confirming
user+project settings (skills, hooks, CLAUDE.md, custom tools) are loaded:

```
tools: Task, AskUserQuestion, Bash, CronCreate/Delete/List, DesignSync, Edit,
       EnterPlanMode, EnterWorktree, ExitPlanMode/Worktree, Monitor, NotebookEdit,
       PushNotification, Read, RemoteTrigger, ReportFindings, ScheduleWakeup, SendMessage,
       ShareOnboardingGuide, Skill, TaskCreate/Get/List/Output/Stop/Update, ToolSearch,
       WebFetch, WebSearch, Workflow, Write
```

`init` also carries `cwd, session_id, model, permissionMode, slash_commands, skills,
agents, plugins, capabilities, memory_paths, …`. `slash_commands` included the user's
custom commands (`insights, recap, goal, design, team-onboarding, …`), proving user/project
config is active. The session behaves like interactive `claude`.
*(Note: `cwd` in the init message correctly reflected the `options.cwd` temp dir. A model
writing to an absolute `/home/lmas/hello.txt` early on was the **model** inventing an absolute
path from the prompt, not the SDK ignoring `cwd` — `cwd` is honored.)*

### (f) `SDKResultMessage` contents — **PASS**

Real successful result (5-turn run):

```json
{
 "type": "result", "subtype": "success", "is_error": false, "api_error_status": null,
 "duration_ms": 19821, "duration_api_ms": 21850, "ttft_ms": 8152, "num_turns": 5,
 "result": "All three steps are done: …",
 "stop_reason": "end_turn",
 "session_id": "c577867a-5d92-4873-bb78-08ab4e3360ea",
 "total_cost_usd": 0.6326665,
 "usage": {
   "input_tokens": 8, "cache_creation_input_tokens": 54012,
   "cache_read_input_tokens": 154733, "output_tokens": 580,
   "service_tier": "standard", "iterations": [ … per-turn token breakdown … ]
 },
 "modelUsage": { "claude-opus-4-8": { "inputTokens": …, "outputTokens": …, "costUSD": …, "contextWindow": 1000000 } },
 "permission_denials": [ … ], "terminal_reason": "completed", "uuid": "818785ed-…"
}
```

Everything the plan wants is present: `subtype`, `total_cost_usd`, full `usage` (incl.
cache + per-iteration breakdown), `modelUsage` (per-model cost/context), `num_turns`,
`session_id`, `duration_ms`/`ttft_ms`, `permission_denials`, `stop_reason`, `terminal_reason`.
Error turns instead carry `is_error:true`, `api_error_status:500`, `terminal_reason:"api_error"`.

### (g) Edit/Write diff must be reconstructed from tool_use INPUT — **PASS (confirmed)**

The `tool_result` for a Write is **plain success text**, not structured diff data. The
diff/content lives in the **`tool_use` input** (`content` for Write; `old_string`/`new_string`
for Edit). Matched pair (same `tool_use_id`):

```json
// tool_use (assistant) — carries the actual content:
{"type":"tool_use","id":"toolu_01CP3qji1HUiXCr56TP48gqr","name":"Write",
 "input":{"file_path":"/home/lmas/hello.txt","content":"hi"},"caller":{"type":"direct"}}

// tool_result (user) — plain text, no diff:
{"tool_use_id":"toolu_01CP3qji1HUiXCr56TP48gqr","type":"tool_result",
 "content":"File created successfully at: /home/lmas/hello.txt (file state is current…)"}
```

**Implication for the swarm:** to render a file diff in native UI, the renderer must correlate
`tool_use.id` → `tool_result.tool_use_id` and build the diff from the tool_use **input**
(`content` / `old_string`+`new_string`), reading the on-disk file as the "before" for Edit.
The tool_result only tells you success/failure text. (Read's result is `"1\thi"` — cat -n style.)

### (h) Streaming-input multi-turn in ONE `query()` — **PASS**

Passed an **async-generator prompt** that yields a 2nd user message after the 1st turn's
`result` arrives (gated on a promise). One `query()` call handled **both turns** — the
subprocess stayed alive and the session persisted across turns:

```json
"h_multiTurn": {
  "turns": 2,
  "results": [
    {"subtype":"success","result":"7 — got it.",  "session_id":"1f3b4899-…"},
    {"subtype":"success","result":"7",             "session_id":"1f3b4899-…"}   // same session_id
  ]
}
```

Turn 1: "Remember the number 7" → "7 — got it." · Turn 2 (yielded after turn 1 finished):
"What number did I ask you to remember?" → "7". **Same `session_id` across both**, one
subprocess. Not fiddly beyond the one real requirement: **the generator must not yield turn 2
until turn 1's `result` is observed** (I gated it on a promise resolved when the first
`result` message arrives). This is the pattern Orchestra should use for a live, back-and-forth
agent session.

---

## Summary table

| Q | Topic | Verdict |
|---|-------|---------|
| 1 | Build + externalize + packaged-app ships SDK | **PASS** (multi-platform native optionals = release checklist item) |
| a | `text_delta` token streaming | **PASS** |
| b | `input_json_delta` (tool input streaming) | **PASS** |
| b | `thinking_delta` **text** | **EMPTY / redacted on Opus 4.8 — events fire, no cleartext** |
| c | `canUseTool` allow + deny | **PASS** |
| d | `query.interrupt()` stops a turn | **PASS** (surfaces as throw / `error_during_execution` — must catch) |
| e | `settingSources:['user','project']` loads skills/CLAUDE.md | **PASS** |
| f | `SDKResultMessage` fields | **PASS** |
| g | diff comes from tool_use input, not tool_result | **PASS (confirmed)** |
| h | streaming-input multi-turn, one `query()` | **PASS** |

## What the swarm must design around (carry into Phase 1)

1. **No live cleartext thinking on Opus 4.8** — model a "thinking" *indicator*, not a text
   stream. Re-check on other models before promising a thinking panel.
2. **Interrupt = the iterator throws** — wrap `for await` in `try/catch`; treat
   `error_during_execution` / `[ede_diagnostic]` as an expected interrupted state.
3. **Diffs are reconstructed** — correlate `tool_use.id` ↔ `tool_result.tool_use_id`; build
   file diffs from tool_use **input** (`content` / `old_string`+`new_string`) + on-disk before.
4. **Multi-turn** — use an async-generator prompt; gate each follow-up turn on the prior
   `result` message; the session/subprocess persist (`session_id` stable).
5. **Packaging** — for every release target arch, ensure that arch's
   `@anthropic-ai/claude-agent-sdk-<platform>` native optional is present at pack time.
6. **Transient API 500s** were frequent during the spike — the host loop needs retry/backoff
   and must render `is_error:true` result messages gracefully (they arrive as normal `result`
   messages with `api_error_status` set, not as thrown errors).

## Reproduce

```bash
pnpm add @anthropic-ai/claude-agent-sdk        # already added
unset CLAUDE_CONFIG_DIR                          # use the default login, like self-tune.ts
node scratch/spike-sdk.mjs                       # a,c,e,f,g,h  → scratch/spike-sdk.log
node scratch/spike-sdk-thinking-interrupt.mjs    # b,d
node scratch/spike-thinking-only.mjs             # focused b (retries past 500s)
node scratch/spike-interrupt-only.mjs            # focused d (retries until Bash starts)
```

Full raw event stream: `scratch/spike-sdk.log`.
