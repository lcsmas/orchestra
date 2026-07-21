# Implementation plan — SDK-driven structured agent view

Companion to `docs/adr/0001-sdk-structured-agent-view.md`. This is the phased build and
the verified-fanout work breakdown. Every `file:line` below was verified against live
source during recon (v0.5.96) — re-verify before editing, line numbers drift.

## Goal (one line)

A new opt-in **`structured`** agent tab that renders a live Claude Code session from
`@anthropic-ai/claude-agent-sdk` as beautiful, snappy native React UI — streaming text,
collapsible tool cards, real diffs, native permission dialogs, a cost/token turn footer —
with the terminal untouched and default until Phase 6 flips it.

## Phase 0 findings (VERIFIED — these override any doc-derived assumption below)

The spike (`docs/spikes/phase0-sdk-findings.md`, branch `phase0-sdk-spike`) proved the SDK
carries everything and **bundles into the packaged app.asar**. GREEN. Five constraints the
spike observed that the swarm MUST design around (they correct the plan):

1. **NO live cleartext thinking on Opus 4.8.** `thinking_delta` events fire but `.thinking`
   text is `""` (redacted — only a signature). Reproduced 4×. ⇒ Model "thinking" as a
   **boolean indicator / spinner** keyed off the `thinking` content-block *start*, NOT a
   streamed text panel. (Re-check on other models before ever promising a text panel.)
2. **`interrupt()` surfaces as the `for await` iterator THROWING** (`error_during_execution`
   / `[ede_diagnostic]`). ⇒ Wrap the consume loop in `try/catch`; treat interrupt as an
   expected terminal state, not a crash. `interrupt()` returns receipt `{still_queued:[]}`.
3. **Diffs are reconstructed from tool_use INPUT**, not tool_result (which is plain success
   text). ⇒ Correlate `tool_use.id` ↔ `tool_result.tool_use_id`; build the diff from the
   input (`content` for Write; `old_string`+`new_string` for Edit) + the on-disk file as
   "before".
4. **Transient API 500s are frequent** and arrive as **normal `result` messages** with
   `is_error:true` / `api_error_status:500` (NOT thrown). ⇒ Host loop needs retry/backoff;
   the UI must render an error result gracefully.
5. **Packaging**: externalize the SDK in vite main rollup `external` (done in the spike,
   like `simple-git`). `app.asar` ships the base SDK + the arch's native `-linux-arm64/claude`
   binary automatically. **Release checklist:** every CI target arch needs its
   `@anthropic-ai/claude-agent-sdk-<platform>` optional present at pack time (pnpm 10 won't
   auto-install transitive platform binaries).

## Non-negotiable quality bars

- **Real-time / max FPS streaming.** Token deltas must render without jank. Reuse the RAF
  discipline already proven in `term-write-queue.ts`: coalesce SDK deltas per animation
  frame, never one `setState` per token. Virtualize the message list so a 500-message
  session stays at 60fps (windowed render; only visible bubbles mount).
- **Crisp & beautiful.** One coherent design system, theme-aware (light/dark), reuse
  `TERM_THEME`/app-chrome tokens so it matches the rest of Orchestra. Use the
  `frontend-design` skill for aesthetic direction before building components.
- **No regression.** Terminal PTY path (`pty.ts`, `Terminal.tsx`, `App.tsx` terminal tab)
  is not modified in Phases 1–5. Structured session is a separate spawn.
- **Pure logic is testable.** All SDK-event normalization lives in `src/shared/` as pure
  functions with `node:test` coverage (no `electron` import — the runner crashes on it).

## Architecture (the data path)

```
main:  @anthropic-ai/claude-agent-sdk query()  (new: src/main/agent-sdk.ts)
         │  yields SDKMessage / stream_event
         ▼
       normalizeSdkMessage()  (pure: src/shared/agent-events.ts)  → AgentEvent[]
         │
         ▼
       platform.broadcast('agent:event', wsId, AgentEvent)   ← seam: platform/index.ts:51
         │                                                     Electron win + ui-rpc sink
         ▼
preload: window.orchestra.onAgentEvent(cb)   ← copy onAgentContext (preload:183-187)
         ▼
store:  agentEvents: Record<wsId, AgentSession>   ← copy onAgentContext sub (store:558-574)
         ▼
renderer: <StructuredView workspaceId>  → virtualized message list of typed components
```

**Reverse path (user → agent):** the structured view sends turns and control via new
IPC invoke handlers that call into the live `query` object held in main:
`agent:sdkSend(wsId, text|blocks)`, `agent:sdkInterrupt(wsId)`,
`agent:sdkPermissionReply(wsId, requestId, result)`, `agent:sdkSetModel`,
`agent:sdkSetPermissionMode`. Multi-turn uses the **streaming-input pattern** (one
long-lived `query()` per session with an async-generator prompt fed by user turns) — NOT
resume-per-turn, so the subprocess stays warm and `canUseTool` fires in-loop.

## Domain types (add to `src/shared/types.ts`, after :238)

A discriminated `AgentEvent` union is the contract both frontends deserialize. Model it on
the SDK message types but OWN it (don't leak the SDK's volatile shape to the renderer —
normalize once in main). Sketch:

```ts
export type AgentEvent =
  | { kind: 'session';   sessionId: string; model: string; tools: string[]; mcp: Record<string,{connected:boolean;error?:string}> }
  | { kind: 'text-delta';    blockId: string; text: string }         // streaming token(s)
  | { kind: 'thinking-delta'; blockId: string; text: string }
  | { kind: 'tool-input-delta'; blockId: string; partialJson: string }
  | { kind: 'block-start';   blockId: string; type: 'text'|'thinking'|'tool_use'; toolName?: string }
  | { kind: 'block-stop';    blockId: string }
  | { kind: 'tool-use';      id: string; name: string; input: unknown }   // finalized block
  | { kind: 'tool-result';   toolUseId: string; content: string; isError?: boolean }
  | { kind: 'permission-request'; requestId: string; toolName: string; input: unknown; suggestions?: unknown[] }
  | { kind: 'turn-end';      subtype: string; costUsd: number; usage: TokenUsage; numTurns: number; stopReason: string|null }
  | { kind: 'error';         message: string };
```

`AgentSession` (renderer store) = `{ sessionId?, model?, messages: RenderMessage[],
pendingPermission?, streaming: boolean, lastResult?: {...} }` where `RenderMessage` folds
deltas into coherent bubbles/cards (the folding is pure logic — `agent-events.ts` —
testable).

## Phased build

### Phase 0 — Spike (gate, do NOT skip)
Prove the stream carries everything BEFORE the expensive work. In a throwaway branch:
spawn `query()` in main against a real workspace worktree, broadcast raw events, dump into
an unstyled `<pre>`. **Confirm with your eyes:** (a) `includePartialMessages` gives real
token-level `text_delta`s; (b) `canUseTool` fires and a renderer round-trip can resolve it;
(c) `query.interrupt()` stops a turn; (d) `settingSources:['user','project','global']`
loads the user's skills/hooks/CLAUDE.md so parity is real; (e) the packaged-app bundling
works (SDK spawns `claude` — needs it on PATH like `pty.ts:285-286`, and the dep may need
adding to vite `external`, model on `self-tune.ts:200-216`). **If any of these fail, the
plan changes — surface it before proceeding.**

### Phase 1 — Backend channel (A1)
- `pnpm add @anthropic-ai/claude-agent-sdk`; handle vite `external` + electron-builder
  `files`/asar so it ships (verify it lands in the AppImage — same class as `simple-git`).
- `src/main/agent-sdk.ts`: per-workspace session manager. Owns the `query` object, the
  async-generator prompt queue (streaming input), the `canUseTool` callback (bridges to a
  renderer round-trip via a pending-request map keyed by `requestId`), and lifecycle
  (start lazily, stop, interrupt). Reuse env plumbing: `resolveRepoAgentEnv(ws)`
  (`workspaces.ts:2906`), hook install, account inheritance, `CLAUDE_CONFIG_DIR`.
- `src/shared/agent-events.ts` (+ `.test.ts`): pure `normalizeSdkMessage(msg) → AgentEvent[]`
  and `foldEvents(session, event) → session`. This is the tested core.
- Wire the channel: `agent:event` broadcast (`platform.broadcast`), add
  `'agent:event':'agentEvent'` to `WIRE_EVENT_CHANNELS`
  (`src/shared/ui-rpc-protocol.ts:164-188`) so GTK clients get it too, add `onAgentEvent`
  to `OrchestraAPI` (`src/shared/ipc.ts` events block) + preload closure
  (`preload:183-187`). Add the reverse invoke handlers (`agent:sdkSend`, `…Interrupt`,
  `…PermissionReply`, `…SetModel`, `…SetPermissionMode`) in `api-handlers.ts`.

### Phase 2 — Store + streaming renderer skeleton (A2)
- Store: `agentEvents: Record<wsId, AgentSession>`, seed `{}` in factory (`store.ts:145`),
  subscribe modeled on `onAgentContext` (`store:558-574`) — **guard before setState** (this
  is the hottest channel; token deltas). Prune in `onWorkspaceRemoved`/`onWorkspacesRemoved`.
- Add `'structured'` to the `view` union (`store:96,105,174`), a tab button
  (`App.tsx:456-460`), and mount `<StructuredView>` in the pane block (`App.tsx:632-652`).
  **Keep it always-mounted per workspace** (like `TerminalView`, `App.tsx:632-638`) so the
  session/scroll survives tab switches.
- `StructuredView.tsx`: virtualized message list + RAF-batched delta application (model the
  batching on `term-write-queue.ts` — accumulate deltas, flush per frame, budget-bounded).
  A composer input at the bottom to send turns.

### Phase 3 — Message & tool-card components (A3)
- Streaming **markdown** bubble (add a lightweight md renderer; syntax highlighting via the
  already-present Monaco or a small highlighter — do NOT add a heavy dep without cause).
- **Tool cards**: collapsible, per-tool affordance. `Edit`/`Write` → **real diff** (reuse
  `@monaco-editor/react` diff editor, already a dep) reconstructed from `old_string`/
  `new_string`/`content` in the tool_use *input* (SDK returns tool_result as plain text —
  the diff must come from the input, confirmed in recon). `Bash` → command + monospace
  output, collapsible. `Read`/`Grep`/`Glob` → compact summary + expand. `TodoWrite` →
  checklist. `Task` → nested subagent affordance.
- **Thinking blocks**: foldable, dim styling, streamed.

### Phase 4 — Permissions, interrupt, controls (A4)
- Native **approve/deny dialog** driven by `permission-request` events; resolves the main
  pending-request map via `agent:sdkPermissionReply` returning the SDK `PermissionResult`
  (`allow{updatedInput?}` / `deny{message}`), including a "remember" path
  (`updatedPermissions`). Handle `AskUserQuestion` (fires through `canUseTool`) as a
  first-class question UI.
- **Interrupt** button → `query.interrupt()`. Model switch / permission-mode switch
  controls (`setModel`, `setPermissionMode`). Turn footer: cost / tokens / duration from
  `turn-end`.

### Phase 5 — Design pass (A5)
- One coherent, theme-aware design system across all components (use `frontend-design`
  skill first). Crisp typography, motion that respects reduced-motion, empty/loading
  states, the streaming cursor, syntax theme matching `TERM_THEME`. Verify at 60fps with a
  long session (perf trace).

### Phase 6 — Flip default (separate, later; NOT in the swarm)
Behind a settings flag, make `structured` the default agent view and demote terminal to a
"Raw" tab. Retire the status/context role of `activity.ts`/`events-spool.ts` for structured
workspaces (SDK carries it in-band). Keep the PTY-exit reconciliation *concept* as a
backstop. This phase is gated on Phases 1–5 being trusted in real use — do it as its own
task, not now.

## Verified-fanout work breakdown

5 implementation agents in isolated worktrees + 1 verifier that owns a fully-installed
env and gates every branch on real `pnpm build` + `pnpm test` before merge. Dependency
order matters — A1 defines the event contract everyone else consumes, so **A1 lands first**;
A2 depends on A1's types; A3/A4 depend on A2's component tree; A5 is last.

| Agent | Owns | Depends on | Key files |
|---|---|---|---|
| **A1** backend | SDK session mgr, `agent:event` channel, reverse IPC, pure normalize/fold + tests | — | `src/main/agent-sdk.ts` (new), `src/shared/agent-events.ts` (+test), `src/shared/types.ts`, `ipc.ts`, `preload/index.ts`, `ui-rpc-protocol.ts`, `api-handlers.ts` |
| **A2** renderer core | store slice, `'structured'` tab/view, `StructuredView` skeleton, RAF delta batching, composer | A1 types | `src/renderer/store.ts`, `App.tsx`, `components/StructuredView.tsx` (new), a `structured-write-queue.ts` (new, pure, tested) |
| **A3** components | markdown bubble, tool cards, Monaco diff, thinking blocks | A2 tree | `components/agent/*.tsx` (new) |
| **A4** interaction | permission dialog, AskUserQuestion UI, interrupt/model/mode controls, turn footer | A2 tree | `components/agent/PermissionDialog.tsx`, controls |
| **A5** design | design system, theme, motion, 60fps perf pass | A3+A4 | `styles.css`, component polish |
| **V** verifier | installs deps, real build+tests, exercises structured tab end-to-end (headless-sway + CDP), gates merges | — | — |

**Coordination rule (from my global instructions):** "agent reported done" ≠ "work
landed". At close-out I re-derive each deliverable against the integration branch tip
(`git log <integration>..<branch>` empty + `git show <tip>:<path>` grep), not against a
named SHA, because agents commit after reporting.

## Risks / unknowns to close in Phase 0
1. Bundling the SDK in the packaged Electron app (native bits? PATH resolution for `claude`).
2. Permission round-trip latency (renderer must resolve `canUseTool` fast enough).
3. Streaming granularity actually token-level (docs say yes; verify).
4. Parity: does `settingSources` load the user's skills/hooks so the structured session
   behaves like interactive `claude`? (Load-bearing for "all features Claude Code enables".)
5. Login OAuth — stays a terminal flow (structured view does not replace it).
