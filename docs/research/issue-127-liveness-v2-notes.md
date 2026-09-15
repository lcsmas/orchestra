# Issue #127 — liveness v2 (progress bound) — verified facts + design

Branch `liveness-progress-127` off master `1e6a3db` (v0.5.269). SHADOW wave D, `liveness=OFF`.

## The gap #127 fills (VERIFIED by reading src/shared/bus-liveness.ts:126-162)

`decideEscalation` guard 3: `if (m.running) return skip 'running'`. A session HUNG
mid-tool-call has `running: true` FOREVER (a `pretool` fired, no `posttool`/`stop`
ever follows), so it is skipped unconditionally — the #90 wedge class is invisible
to the existing staleness bound. The existing bound catches the gap BETWEEN turns
(activity clock); it CANNOT catch an in-flight-forever tool call.

Activity mechanics (src/main/activity.ts:949-1070, applyAgentEvent):
- `pretool` → `noteActivity(id)` (stamps lastActivityAt), `emitTool(id, tool)`, status→running.
- `posttool` → `noteActivity(id)` (stamps AGAIN), still running.
- `stop`/`stopfail`/`notify` → clears running.
- So a healthy tool call: pretool stamps, tool returns, posttool stamps → lastActivityAt
  ADVANCES. A hung tool call: pretool stamps once, NOTHING follows → lastActivityAt frozen
  at pretool time, running stuck true.

## T127.2 — the two existing bounds, MEASURED (not assumed)

### #90 turn-gate watchdog
- `src/main/session-watchdog.ts:70` `TICK_MS = 60_000` — the watchdog TICK is 60s
  (this is the "60s" the ticket refers to; it is the poll cadence, not a bound).
- `src/shared/session-wedge.ts:86` `GATE_SILENCE_RELEASE_MS = 10*60*1000` — the actual
  silence bound is 10 MINUTES, and it is itself a PROGRESS bound (reset by every SDK
  stream message; header lines 52-86).
- COVERS: structured (SDK) sessions only, where `session.turnGate` held (a turn in flight)
  AND `queuedCount > 0` (something waiting behind it) — `decideGateRelease` guards 1-2
  (session-wedge.ts:137-138). ACTION: release the gate non-destructively (layer 1) or
  recycle the session (layer 2). It does NOT write an escalation to a coordinator.
- BLIND SPOTS #127 fills:
  1. `queuedCount <= 0` → refused (guard 2). A hung tool call with NOTHING queued behind
     it is never released and never surfaced.
  2. It is a SELF-HEAL (release/recycle), producing ZERO coordinator-visible signal — the
     human/OPS learns nothing. #127 ESCALATES to the coordinator (an actionable row).
  3. It keys on SDK stream silence, blind to per-tool-CLASS ceilings.

### Bash 600s cap
- The SDK Bash TOOL's own `timeout` param maxes at 600000ms (600s), enforced by the
  `claude` binary (EXTERNAL to this repo). This is the "Bash caps at 600s" the ticket names.
- `src/main/agent-sdk.ts:2696` `BASH_TIMEOUT_MS = 5*60_000` (300s) is a DIFFERENT bound:
  it caps `!command` bash-MODE runs in the structured composer, NOT the agent's Bash tool.
- COVERS: a single Bash tool call self-terminates at ≤600s → it emits a tool result
  (posttool) → progress. So a Bash call cannot itself masquerade as a hung session past
  its own cap.
- BLIND SPOT #127 fills: tools with NO such cap — MCP / browser / custom SDK tools can
  hang indefinitely, process alive, status stuck `running`, no result, no exit. That is
  exactly the per-tool-class ceiling this ticket adds (Bash → 600s ceiling; MCP/browser →
  a higher/uncapped ceiling since they legitimately may run long).

## Design

Add a per-member IN-FLIGHT TOOL CALL tracker in `src/main/bus-liveness.ts` (I OWN it),
fed from the SAME chokepoint the roster already reads (activity.ts pretool/posttool),
WITHOUT a new probe (ticket boundary: consume existing signals).

Pure policy in `src/shared/bus-liveness.ts` (mutation-testable):
- `toolClassCeilingMs(tool)` → per-class ceiling. Bash → 600_000 (matches the tool's own
  cap); MCP/browser (mcp__*, browser, WebFetch) → a larger ceiling (they may legitimately
  run long, e.g. a headless E2E); default/unknown → the same conservative ceiling as Bash's
  max. Ceiling is chosen so a LEGITIMATE long call never trips (dead-vs-slow-reader trap).
- `decideToolProgress(state, now)` → escalate | count | skip('progress'|'fresh'|'no-call'|...).
  A member is HUNG iff: running, a tool call is in flight, elapsed-in-call > ceiling, AND
  ZERO progress since the call started (lastActivityAt has NOT advanced past callStartedAt,
  AND no commit/status change since — commits/status are the extra progress evidence).

Progress evidence (bound on PROGRESS not elapsed — wave-8 lesson):
1. lastActivityAt advanced past callStartedAt → a posttool/new pretool arrived → progress.
2. status changed since call start → progress.
3. (a new commit on the member's branch — OPTIONAL, only if cheap; see NOT-VERIFIED).

The in-flight tracker: on `pretool` note (tool, startedAt); on `posttool`/`stop`/`notify`
clear it. bus-liveness records this via a new seam fed from activity.ts (or the roster
carries `inFlightTool`/`toolStartedAt`). Escalation is switch-gated (liveness) → COUNTED
not FIRED while OFF (T127.3), reuses the `escalation` kind + `send` (NO migration).

## review-127 F1/F2 fix (post-nomination, CONFIRMED defect)

Fresh reviewer found the single-slot `Map<wsId, InFlightTool>` collapses PARALLEL
tool calls: `noteToolEnd` cleared the whole entry, so a hung MCP call beside a
fast Bash went untracked → never escalated = the exact #90 wedge. CONFIRMED by
running the shipped fns. Parallel tool_use is the common case.

FIX: `Map<wsId, InFlightTool[]>` keyed by `toolUseId`.
- Progress is now PER-CALL via list membership (a call leaves the list only via
  its OWN posttool), NOT the global `lastActivityAt` (the masking bug).
- `toolUseId` threaded end to end: SDK path `ev.toolUseId`; spool hook mines
  `tool_use_id` into the jsonl; events-spool reads it. Id-less posttool → FIFO
  over the id-less cohort only. Turn-end → `clearInFlightTools`.
- `hungCall` returns the MOST-OVERDUE call (worst offender), each judged against
  its own class ceiling.
F2: added `src/main/hibernation-activity.test.ts` — the tracker seam the pure
tests couldn't reach (where F1 lived). Mutation-proven live: revert to
global-clock progress → F1 arms RED; single-slot clear-all → tracker F1 arm RED.

## review-127 F3 (ARGUED, LOW) — remote path id-less, FIXED cheaply

The sandbox `EventFrame` wire carries a tool NAME but no tool_use_id, so REMOTE
agents track id-less. Pre-fix that meant plain oldest-id-less FIFO = the F1
cross-tool masking, confined to remote. Disposition (A): scope the id-less FIFO
in `noteToolEnd` to the same TOOL NAME (the wire has the name) — no wire/protocol
change, no synthesized id. A fast Bash posttool can no longer clear a hung MCP
call. Mutation-proven: drop the `c.tool === tool` scope → the F3 regression arm RED.

PRECISE residual (review-127 F3-sharpened — my first wording ">=1 survives" was
misleadingly benign): on the REMOTE (id-less) path with a SAME-TOOL parallel
hang, the id-less posttool removes the OLDEST same-tool call, and a hung call IS
the oldest (longest in-flight) — so a fast sibling's posttool drops the HUNG
call's own escalation while the fast one lingers. Remote-only, same-tool-only;
cross-tool is closed; NOT a regression (no pre-#127 hang detection). Honest fix =
a tool_use_id on the sandbox wire — DEFERRED to #132 (LEAD ruling D3(a)).

## NOT-VERIFIED (residual blind spots — T127.4)
- REMOTE (id-less wire) + SAME-TOOL parallel hang: the hung call is the oldest, so
  its own escalation is dropped while the fast sibling lingers — remote-only,
  same-tool-only; cross-tool is closed; not a regression (no pre-#127 hang
  detection); honest fix needs a remote tool_use_id on the sandbox wire —
  DEFERRED to #132 (LEAD ruling D3(a): "Sandbox wire: carry toolUseId on remote
  tool events so progress-liveness can attribute a hung call"). Remote is
  shadow/OFF this wave, so COUNTED-not-fired regardless.
- No live packaged run drives a REAL hung MCP tool call through a running app; rig uses a
  fake clock + injected in-flight state (same shape as #120's sweep rig).
- Commit-as-progress evidence: reading git per member per sweep is a cost; if not included,
  a tool call that is silently making git progress but emits no lifecycle event is still
  (correctly) caught only by the ceiling — acceptable since a real tool call emits posttool.
- The ceiling values for MCP/browser are UNBASELINED (no fleet distribution of longest
  legitimate MCP-call durations) — chosen as conservative floors, same posture as
  GATE_SILENCE_RELEASE_MS.
