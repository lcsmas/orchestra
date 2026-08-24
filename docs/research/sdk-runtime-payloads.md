# SDK runtime payloads — empirical verification against the installed CLI

Resolves [#13](https://github.com/lcsmas/orchestra/issues/13) (child of map [#4](https://github.com/lcsmas/orchestra/issues/4)).
Verifies the changelog-only runtime claims in `docs/sdk-feature-audit.md`.

**Rig** (2026-08-24): installed CLI **2.1.234** (`claude --version`; `~/.local/bin/claude` → native binary at `~/.local/share/claude/versions/2.1.234`), SDK **`@anthropic-ai/claude-agent-sdk` 0.3.216** (the repo's `node_modules`), Node v22.22.0. Probes: throwaway node scripts in a scratch cwd (`/tmp/sdk-probe/work`), `pathToClaudeCodeExecutable` pinned to the installed binary (same as Orchestra's `agent-sdk.ts:990`), model `haiku`, `bypassPermissions`, raw JSON of every message captured. `/context` and idle-init probes cost zero API calls (`num_turns: 0`, `duration_api_ms: 0` in their `result` messages).

Every verdict below is a property of **CLI 2.1.234**; the SDK 0.3.216 type defs are noted where they diverge (runtime payloads pass through the SDK untyped).

---

## 1. `Query.getContextUsage()` — VERIFIED, works at 0.3.216 + CLI 2.1.234

Returns a rich structured breakdown (no CLI/SDK version gate hit). Observed (trimmed):

```json
{"categories":[
  {"name":"System tools","tokens":14144,"color":"inactive"},
  {"name":"MCP tools (deferred)","tokens":52191,"color":"inactive","isDeferred":true},
  {"name":"System tools (deferred)","tokens":15618,"color":"inactive","isDeferred":true},
  {"name":"Memory files","tokens":52060,"color":"claude"},
  {"name":"Skills","tokens":1993,"color":"warning"},
  {"name":"Messages","tokens":4994,"color":"purple_FOR_SUBAGENTS_ONLY"},
  {"name":"Free space","tokens":126809,"color":"promptBorder"}],
 "totalTokens":73191,"maxTokens":200000,"rawMaxTokens":200000,
 "autocompactSource":"auto","percentage":37,
 "gridRows":[[…TUI-oriented 10-per-row grid…]],
 "model":"claude-haiku-4-5-20251001",
 "memoryFiles":[{"path":"…/CLAUDE.md","type":"User","tokens":1245},…],
 "mcpTools":[{"name":"mcp__…","serverName":"…","tokens":890},…], …}
```

- Matches the 0.3.216 `SDKControlGetContextUsageResponse` type (sdk.d.ts:3034) plus extra runtime fields the type doesn't declare (e.g. `autocompactSource`).
- Callable immediately after `system/init`, before any turn — so it can replace the transcript-JSONL recompute (`activity.ts:523 computeContextTokens`) without waiting for a turn.
- Note `gridRows` is TUI presentation baggage; `categories`/`totalTokens`/`percentage` are the useful part.

## 2. `/context` structured payload — VERIFIED, and BETTER than the audit's framing

Sending `/context` as a user message (streaming input) costs **zero API calls** and yields:

- a synthetic assistant message (`message.model: "<synthetic>"`) whose text content is the human-readable markdown table, **and**
- a **top-level `context_usage` field on that same assistant message** — observed:

```json
"context_usage":{"model":"claude-haiku-4-5-20251001","total_tokens":68205,
 "raw_max_tokens":200000,"percentage":34,
 "categories":[
   {"name":"System tools","tokens":14144,"kind":"used"},
   {"name":"MCP tools (deferred)","tokens":24056,"kind":"deferred"},
   {"name":"System tools (deferred)","tokens":15618,"kind":"deferred"},
   {"name":"Memory files","tokens":52060,"kind":"used"},
   {"name":"Skills","tokens":1993,"kind":"used"},
   {"name":"Messages","tokens":8,"kind":"used"},
   {"name":"Free space","tokens":131795,"kind":"free"}],
 "mcp_tools":[{"name":"…","server_name":"…","tokens":890},…],
 "memory_files":[{"path":"/home/lmas/.claude-mc/CLAUDE.md","type":"User","tokens":1245},…],
 "agents":[],"skills":[{"name":"…","source":"userSettings","tokens":6},…]}
```

- The audit dated this "0.3.232"; **the installed CLI 2.1.234 already emits it** — SDK 0.3.216 passes it through untyped (its `SDKAssistantMessage` type doesn't declare `context_usage`; the bump to ≥0.3.232 only adds the type).
- The trailing `result` message carries only the markdown in `result` (no structured field there).
- Snake_case shapes here vs camelCase in `getContextUsage()` — two different payloads, don't conflate.

## 3. `effort` on `system/init` — VERIFIED ABSENT at CLI 2.1.234

Full observed key set of `system/init` (CLI 2.1.234, `--effort low` forwarded — SDK 0.3.216 does pass `--effort` to the CLI, verified in sdk.mjs — on **claude-sonnet-5**, which `supportedModels()` reports as `"supportsEffort":true`):

```
type, subtype, cwd, session_id, tools, mcp_servers, model, permissionMode,
slash_commands, terminal_slash_commands, apiKeySource, claude_code_version,
output_style, agents, skills, plugins, capabilities, analytics_disabled,
product_feedback_disabled, uuid, memory_paths, messaging_socket_path,
fast_mode_state, fast_mode_disabled_reason
```

- **No `effort` field**, on haiku or sonnet, with effort explicitly set. The audit's "0.3.234 adds `effort` on system/init" does **not** hold on CLI 2.1.234 — the workaround at `agent-sdk.ts:1793–1796` (renderer trusts `ws.sdkEffort`) is still required until the installed CLI moves past this.
- Bonus observed fields useful elsewhere: `capabilities:["interrupt_receipt_v1","interrupt_cancel_queued_v1","msg_lifecycle_v1"]` (feature-detection instead of version-sniffing), `claude_code_version:"2.1.234"`, `messaging_socket_path:"/run/user/1000/cc-socks/<pid>.sock"`.

## 4. `background_tasks_changed` snapshot on re-`initialize` — VERIFIED ABSENT at CLI 2.1.234

Driven over the raw stream-json protocol (spawned the installed CLI with `--input-format stream-json --output-format stream-json`, sent the `initialize` control_request twice — not reachable through the high-level SDK, which sends `initialize` once):

1. First `initialize` → success control_response.
2. One haiku turn started `sleep 90` via Bash `run_in_background` → organic `{"type":"system","subtype":"background_tasks_changed","tasks":[{"task_id":"bjc4l4ro2","task_type":"local_bash","description":"Run a 90-second sleep in the background"}]}` observed (so the emitter works and a task was live).
3. Second `initialize` while the task was still running (~85s left) → success control_response for `r2`, and **no `background_tasks_changed` in a 12 s watch window**. `SUMMARY: background_tasks_changed before-reinit=1 after-reinit=0`.

The audit's "0.3.239: snapshot after repeated initialize" does not hold at CLI 2.1.234 — consistent with the feature landing in a CLI newer than 2.1.234. Keeper-reattach designs must not rely on it until the installed CLI catches up; the 0.3.216 type docs' warning stands ("nothing is emitted at startup … reset to the empty set on process (re)start").

## 5. Cross-session SendMessage into a bypassPermissions SDK session — VERIFIED: DELIVERED IMMEDIATELY, NO HOLD, AND IT AUTO-TRIGGERS A PAID TURN

Two concurrent `query()` sessions (both haiku, both `bypassPermissions`, same machine). Key mechanics:

**Addressing is by ListAgents peer NAME, not session UUID.** Sending `{"to": "<session-uuid>"}` fails:

```json
{"success":false,"message":"No agent named '30b5a1ae-…' is reachable.\nUse ListAgents to see everyone you can message."}
```

`ListAgents` in B listed every live Claude session on the machine (including the user's real interactive sessions — note the blast-radius): `pingtarget-a-4a`, `work-3d`, plus real orchestrator sessions. Names are derived from cwd basename + a suffix; the SDK session registers on the messaging socket (`init.messaging_socket_path`, `/run/user/1000/cc-socks/<pid>.sock`).

**Send by name succeeds:**

```json
{"success":true,"message":"“ping-from-B” → pingtarget-a-4a (another Claude session on this machine)","msg_id":"d726357b-4470-4fc9-8f10-ff27ae5458d8"}
```

**Receiving side (bypassPermissions): delivered with NO approval hold, and the CLI started a model turn on its own.** A was idle (generator open, no pending prompt); on delivery its SDK stream emitted, in order:

1. `{"type":"command_lifecycle","state":"started",…}`
2. a **re-emitted `system/init`**
3. an `assistant` message — haiku answering the ping (a full turn: `total_cost_usd: 0.127`, unprompted by the SDK consumer)
4. `result` (subtype success) carrying the only structured record of the inbound message, an **`origin`** field:

```json
"origin":{"kind":"peer","from":"uds:/run/user/1000/cc-socks/202913.sock",
 "verifiedPeerPid":202913,"msg_id":"d726357b-4470-4fc9-8f10-ff27ae5458d8",
 "name":"work-3d","fromMode":"bypass","body":"ping-from-B"}
```

5. `{"type":"command_lifecycle","state":"completed",…}`

- **No `user`-type message for the inbound text ever appears in the receiver's stream** — the body rides only in `result.origin.body`. A consumer that renders user messages from the stream will show the agent "answering nobody".
- No hold/approval was observed (`crossSessionInbound` moderation from the 0.3.224 changelog is not the default behavior at CLI 2.1.234 for a bypass receiver — or requires opting in via settings; not probed further).
- No `subkind` on `origin` (audit's "peer-send-message origin subkind" not observed; fields are exactly `kind/from/verifiedPeerPid/msg_id/name/fromMode/body`).
- Implication for Orchestra: any bypass SDK session Orchestra runs is **remotely promptable by name by any other local session, and each inbound ping burns API spend without consumer consent** — adopting/guarding this is a real decision, not just a badge refinement.

---

## Version caveat

All ABSENT verdicts are pinned to CLI **2.1.234** and expire on CLI update (the binary auto-updates; re-check `claude --version` before re-using these). The npm bump to 0.3.241 changes **types only** for these behaviors — runtime tracks the installed CLI.

## Repro commands

Probe scripts preserved at `/tmp/sdk-probe/t1-context.mjs` (init + getContextUsage + /context after a turn), `t3-full.mjs` (full-fidelity key capture, /context only, zero cost), `t5-effort-sonnet.mjs` (sonnet + effort init keys, zero cost), `t2-reinit.mjs` (raw stream-json double-initialize), `t4-crosssession.mjs` (SendMessage by UUID — fails), `t6-crosssession2.mjs` (SendMessage by peer name — delivered). Each pins `pathToClaudeCodeExecutable: ~/.local/bin/claude`.
