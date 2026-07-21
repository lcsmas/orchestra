# ADR 0001 — SDK-driven structured agent view (Strategy 1)

Status: Accepted (2026-07-21) · Supersedes the implicit "embed the TUI forever" default

## Context

Today Orchestra runs the real `claude` **TUI** in a `node-pty` PTY and screen-scrapes
its ANSI output into an xterm.js canvas (`src/main/pty.ts` → `pty:data` →
`src/renderer/components/Terminal.tsx`). Because the stream is opaque bytes, agent
**status** is reconstructed out-of-band from a hook JSONL spool
(`events-spool.ts` → `activity.ts`), and **context tokens** are recovered by
re-reading the transcript tail (`computeContextTokens`). Every hard rendering bug in
the app's history — ?2026 tearing, xterm rescale squish, DA1/XTVERSION reply-injection
scramble, SIGWINCH repaint bounce, WebGL texture-atlas soup, ~10s `term.write`
dot-latency — is a direct cost of embedding a terminal that was never designed to be an
embedding target.

The **Claude Agent SDK** (`@anthropic-ai/claude-agent-sdk`, TypeScript) drives the same
agent loop as a subprocess and yields **typed, structured events** (assistant/tool/result
messages, token-level deltas with `includePartialMessages`, `canUseTool` permission
callbacks, `query.interrupt()`). Orchestra's main process is TypeScript, so the SDK is a
first-class fit — no transport to hand-roll.

## Decision

Build a **structured agent view** that renders a Claude Code session from the TS Agent
SDK as native React components (streaming markdown, collapsible tool cards, real diffs,
native permission dialogs, thinking blocks, a cost/token turn footer) — **not** a
terminal.

### Why Electron, not the GTK/Rust rewrite

The GTK rewrite's sole justification was *native terminal rendering performance*. This
decision **deletes the terminal** from the agent view, so that justification evaporates:
rendering a chat log of message bubbles + tool cards + diffs is not a workload where
native beats Chromium in any human-perceptible way. Electron additionally keeps the SDK
for free (TS), iterates the large UI surface far faster (React + HMR), and reuses the
entire existing app (sidebar, store, diffs, dialogs). The **incoherent middle** — a full
Rust rewrite *and* going structured — is explicitly rejected: it pays the full cost of a
native rewrite for a workload that doesn't need native. GTK/VTE is kept only for genuine
terminals (Run-script pane, `nvim`, login OAuth).

### Coexistence & rollout (resolves the scope/coexistence tension)

The user chose both "opt-in, terminal stays default" (scope) and "SDK replaces PTY,
terminal demoted to fallback" (coexistence endpoint). These are reconciled by **phasing**,
not by picking one:

- **Phases 1–5 are additive and opt-in.** The terminal PTY is untouched and remains the
  default tab. The structured view is a NEW `'structured'` tab that lazily spawns its own
  SDK session. Zero regression risk to the working terminal. During this window a
  workspace may have two `claude` processes (mitigated by lazy-start — the SDK session
  spawns only when the structured tab is first opened).
- **Phase 6 flips the default** (SDK becomes primary, terminal demoted to a "Raw" fallback
  tab) behind a settings flag, only after the structured view is trusted end-to-end. This
  is the "SDK replaces PTY" endpoint, reached by a one-line default change rather than a
  big-bang cutover. `activity.ts`/`events-spool.ts` status derivation is only retired in
  this phase (and only its *status/context* role — the spool still drives rename/spawn/
  orchestrator hooks and cannot be fully removed).

## Consequences

- **Deletes a whole bug class by construction**: no terminal ⇒ none of the tearing/
  scramble/repaint/atlas/latency bugs, and the entire `term-write-queue.ts` + pty.ts
  coalescing machinery is irrelevant to this view.
- **Deletes the status side-channel (Phase 6)**: SDK messages carry status + usage in-band,
  making the hook→spool→`applyAgentEvent` status derivation and `computeContextTokens`
  transcript re-reads redundant for the structured view.
- **We now own the agent-view UI forever** and must render each Claude Code block type as
  it ships. This is the accepted, permanent cost. If it ever becomes unacceptable, the
  fallback is "keep embedding the terminal in Electron" (status quo), NOT GTK.
- **Fidelity risk**: our reconstruction can drift from the exact TUI rendering. Phases 1–5
  being opt-in-alongside-terminal is the mitigation — users compare directly.

See `docs/plans/sdk-structured-agent-view.md` for the phased implementation plan and the
verified-fanout work breakdown.
