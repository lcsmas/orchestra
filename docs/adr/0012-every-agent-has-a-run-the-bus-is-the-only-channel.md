---
status: accepted
date: 2026-11-12
---

# Every agent has a run, the right to coordinate follows position, and the bus is the only channel between agents

Today a run row exists only at an anchor holding the orchestrator capability (`orchestra promote`, or the `orchestrator` kind). A plain workspace and its plain children have no run, so `orchestra send` refuses them and they fall back to `orchestra message`, the pre-bus channel that drops and duplicates. They also escape Pause, the memory cap and the liveness escalation.

We decide: a top-level agent's run (a mission) is born with it; an agent that has a parent gets a run (a vague) when it spawns its first agent. Whoever owns a run coordinates it — `orchestra promote` and the capability flag go. Every run freezes the same switches as a fleet's; the `delivery` switch goes and bus mail cannot be turned off. `orchestra spawn --task` records the task as the parent's `dispatch`. Agents with no common ancestry may send each other `status` and `ask` only. `orchestra message` survives only as `--emergency`, for a reader that no longer reads its mail.

## Considered options

- **Mail without a run** (a mailbox per workspace, runs kept for fleets) — rejected: it keeps two models, and plain spawns stay outside Pause, memory cap and liveness.
- **A light run** (delivery and wake only, no coordinator) — rejected: a third kind of run to explain everywhere; a mechanism that hurts small runs gets fixed for all runs instead.
- **Keep `promote` as an explicit "this is an OPS" mark** — rejected: two notions of coordinator side by side; a parent owning a run would be classed a member of it during a Pause.

## Consequences

- The rule "full LEAD → OPS → workers architecture, or nothing" narrows to: a multi-ticket vague goes through an OPS, never coordinated by a LEAD directly. It is a `verified-fanout` conduct rule, as is tree depth — the host enforces neither.
- A child's liveness escalations land on its parent, often the human's pane.
- A run closes when its coordinator is archived or deleted; mail to a closed run is refused.
- Attach and detach change an agent's run; its unread mail follows it. Any agent can receive an attach.
- At app start, every existing workspace without a run gets one; delivery-OFF runs become ordinary runs. There is no setting to fall back to the old channel.
- The `default` run sentinel and the "anchors no run (standalone)" notice go.
- Out of scope: sandbox agents (no workspace directory in the container), the human's own prompts.
