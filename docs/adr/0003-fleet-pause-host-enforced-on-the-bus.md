---
status: accepted
date: 2026-09-30
---

# A fleet Pause is a bus state the host enforces, not a message agents obey

Pausing two waves on 2026-09-30 took ~27 min: the order hopped LEAD → OPS →
members, a message is only read at a tool-result boundary (one member sat in a
1-hour wait loop), two members died on a session limit before confirming, and
"who has paused" was checked by hand. We make **Pause** a durable state of a
run on the bus (extending `runs.held_at`), propagated to descendant runs and
**imposed by the host**: no réveil, no new turn, no spawn into the run, liveness
silenced. A *pause douce* lets members save their own work for up to 3 min; past
that, or on a *pause dure*, the host snapshots each worktree to a pause ref,
records what was running, interrupts the turn and kills the tool process trees —
never the session. **Reprise** is top-down (coordinators first, OPS
re-dispatches each member with a Consigne de reprise); killed commands are
listed, never re-run. Decided with the user on 2026-09-30 (grilling session).

## Considered options

- **Pause as a message agents obey** (what we did) — rejected: a stuck,
  quota-less or blocked agent cannot obey, and nothing proves who complied.
- **Grace turn for the agent to save its work before a hard stop** — rejected:
  costs tokens and fails exactly when needed (usage limit, wedged turn). The
  host-side snapshot needs neither.
- **Auto re-run killed commands on resume** — rejected: an interrupted rig may
  have left dirty state; the agent decides.

## Consequences

- A schema migration (a new `MIGRATIONS[n]` slot), and every entry point that
  starts a turn or a session (réveil, spawn, usage-limit auto-resume, boot
  reattach) must consult the pause state — a single missed path leaks the pause.
- Ships behind a frozen per-run bus switch `pause`, default OFF, and a canary
  (dummy fleet drills, then one real wave) before default ON.
