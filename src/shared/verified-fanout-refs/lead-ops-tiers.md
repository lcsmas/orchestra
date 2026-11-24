# LEAD and OPS: the two tiers in full

(Read when you are the LEAD or the OPS of a vague (SKILL.md §0a). Long form of what SKILL.md carries as one-line rules; the § numbers are SKILL.md's.)

**Nested runs — the two shapes.** A coordinated run comes in two nested forms
(vocabulary settled with the user, Orchestra `CONTEXT.md`):

- A **mission** is the run of a top-level agent, born with it; the **LEAD**
  coordinates it and answers to the human. Its members are workers, OPS, or both.
- A **vague** (wave) is the run of an **OPS** — an agent that has a parent and has
<!--sw verifier=on-->
  spawned agents of its own: the set of workers and the verifier delivering one
<!--/sw-->
<!--sw verifier=off-->
  spawned agents of its own: the set of workers delivering one
<!--/sw-->
  batch of tickets. This is our extension — orca (the reference model) documents
  the single-coordinator run but not the nested mission/vague split.

An OPS is therefore both a worker (of its mission) and a coordinator (of its
vague); a mission can run several vagues in sequence, each dying with its OPS.
**Which tier coordinates (the rules live HERE; `delegate-or-do` only points
at this section).** Run `orchestra whoami` first — it names your role and run:
- **LEAD** (no parent, talks to the human): a multi-ticket vague goes through
  an OPS — `orchestra spawn` one with the vague as its task; it becomes the OPS
  by spawning its first agent and coordinates the vague per this skill.
  **A vague is never coordinated by a LEAD directly (operator ruling, Lucas
  2026-09-21, narrowed by ADR 0012): through an OPS, or inline/plain-spawn.**
  There is no promote step: roles follow position, whoever owns a run
  coordinates it.
- **OPS** (has a parent): fan out directly under yourself; do not add a third
  level. Tree depth and the OPS rule are conduct, the host enforces neither.
- Either tier, ONE self-contained task → plain `orchestra spawn`, no fan-out
  machinery.
The bus records the nesting on the run row (`parent_run_id`), so a vague's run
row points at its mission's. Everything below is written for the OPS coordinating
a vague; the LEAD/OPS split exists because —

A coordinator that both talks to the human and absorbs the fleet's traffic
floods the human's pane (measured: ~50 ping/report turns landing in the
user's conversation in one day). When the human sits on the orchestrating
workspace, split the role:

- **LEAD** (this workspace, quiet): talks to the human, freezes specs with
  them BEFORE the wave, receives only MILESTONE digests (wave spawned /
  candidates gated / merged / blocked-on-human-decision), reports.
  **The lead's reports to the human are a TEAM LEAD'S SYNTHESIS, not a
  micro-manager's log** (user correction, twice: "je ne comprends rien",
  then "tu t'adresses à un humain qui a besoin d'une synthèse d'un chef
  d'équipe"). The test for every line: does the human need it to FEEL the
  progress or MAKE a decision? Keep only: what got done (in product terms —
  what it changes for them), what's next, what needs their call. Drop by
  default: shas, PR/gate/rig names, instrument stories, how the sausage was
  made — that detail lives in the ledger for whoever asks. One short
  paragraph or a 3-4 line table beats every detailed account — and CONCISE
  means concise (user, third correction): ~5 lines max, a TABLE whenever ≥2
  items share a shape, no anecdotes, no colour commentary, no "ce que
  j'apprécie" — the reaction is the reader's job. FORMAT
  matters (user request): bullet lists, a concise summary line first, and
  clickable **URL links** for anything the human might want to open — the
  PR, the ticket, an artifact — instead of raw ids/shas in prose ("la
  release est en ligne ([v0.5.261](https://github.com/...))" beats "tag
  561e3e9"). Zoom in ONLY when the human asks a "pourquoi/comment"
  question — then detail is the answer, not the default.
  The lead answers fleet questions by PULLING the ledger — never from its
  own memory of digests, which goes stale by design.
- **OPS** (spawned per wave, dies with it): opens the ledger, spawns the
  fleet, absorbs ALL fleet pings, records candidates/verdicts/dispositions,
  routes findings, merges on the mechanical rule (§4), runs the close-out
  sweeps, keeps the ledger's NEXT section current so a respawned ops can
  resume cold. **Ops→lead digests are ≤5 headline lines** — the human SEES
  raw inter-agent messages in the lead's pane, so a digest IS user-visible
  surface; the technical body goes in a ledger comment, the message carries
  only the milestone and the pointer.

Known failure modes, each with its counter:
- *Two writers race on the ledger* → one writer per section, stated in the
  ledger header: LEAD writes Decisions (specs/rulings), OPS writes
  everything else.
- *Ops under- or over-escalates* → the escalation criteria are WRITTEN in
  the ledger (spec-axis changes, destructive/irreversible acts, budget,
  anything the human asked to see); a human-blocking question is a ledger
  comment tagged QUESTION + one ping to the lead.
- *Ops question walls read as addressed to the HUMAN* → the human sees every
  ops→lead message in the lead's pane, and a "DECISION NEEDED — reply A/B/C"
  wall reads as a question to THEM (user complaint, fix-wave-5). Rules:
  a ruling request is a **§Open-questions entry in the ledger** plus a
  ONE-LINE ping ("ruling needed, see ledger Q3") — options, evidence and
  reply format live in the ledger, never in the message; ask ONCE, then
  **poll §Decisions** — before composing ANY digest or re-ask, pull
  §Decisions and drop every question already answered there (ops re-asked
  two answered rulings across three digests; each re-ask reads to the human
  as "the fleet is blocked on me"); never address the human, never say
  "waiting on you" in a message — blocked state is a ledger field.

- *Ops dies mid-wave* → the ledger IS the recovery (roster + NEXT section): respawn
  ops pointed at the ledger number, its first act `orchestra fanout resume` (exit 0 =
  the state file matches git + gh, 2 = divergences reported, never auto-corrected: settle
  each with the implementer or the ledger; `--accept-merged <reason>` on `state set` is the one override). The
  detector is the host's liveness escalation (§0c) or ~30 min with no ops ledger write;
  the lead PULLS — `orchestra peers` (status + notes) and the app log for the ops id
  (`grep <ops-id> orchestra.log | tail`): 'live delivery timeout — parked in inbox' on
  repeat = dead-or-zombie, every message to it lands in an inbox nobody reads and is
  gone until a restart — re-issue its content in the RECOVERY BRIEF.
- *The fleet SLEEPS with work pending* → agents are event-driven: no
  incoming message = no next turn, EVER. A wave went to sleep overnight two
  merges from done because the ops ended its turn planning to "continue
  next turn" — and no event ever came (zero log lines for 7 hours; not a
  stall, just silence). The host wakes you on every bus row (§0c); **an OPS
  whose §NEXT waits on something that will NOT arrive as a bus row (a
  background rig, CI, a slow build) arms a ScheduleWakeup before ending its
  turn** — never for fleet traffic (double-fire).
  Corollary for EVERY spawned agent, ship agents included: **the final
  report goes out in the SAME turn as the final act** — a ship completed
  its release then ended its turn planning to report "next turn"; no event
  came, and the lead learned of the release from the tag, not the agent.
  Reporting is part of the task, never a next-turn nicety.

- **WALL-CLOCK IS A GOAL (user ruling): waves run as fast as correctness
  allows.** Waiting for a ping is never a plan when a pull answers now.
  Pipeline, never
  batch: gate/review each candidate the moment it exists, spawn reviewers
<!--sw verifier=on-->
  as soon as a candidate is nominated (not after the verifier finishes),
<!--/sw-->
<!--sw verifier=off-->
  as soon as a candidate is nominated (not after the CI finishes),
<!--/sw-->
  and run independent gates concurrently. The quality bars are untouched —
  speed comes from removing DEAD TIME between steps, never from thinner
  verification.
- *The human loses the merge checkpoint* → default: ops merges when a
  candidate is disposition-complete and the lead announces; the human can
  set "hold merges for my OK" in the ledger header.

**Ledgers carry the `ledger` label** — `gh issue list --label ledger
--state open` lists the active fleets; a wave close CLOSES its ledger, so
open-ledger = live fleet. **The invariant runs BOTH ways and the LEAD owns
the second half: closed ledger ⇒ zero wave workspaces alive.** A wave is
closed only when the LEAD has (1) gated and deleted the OPS workspace itself
(verify-landed `--into <integration>` textual verdict + filtered porcelain —
the ops is a child like any other and "I'll delete it after verifying" is an
intention, not an artifact: one ops survived a full day because that
intention lived only in the lead's head), and (2) run the positive
terminator: `orchestra peers` greps ZERO for every wave-role workspace
(ops-*, ship-*, the wave's implementers) **plus one grep for a workspace
that must still exist**, proving the instrument discriminates. Do this in
the same sitting as the ledger close, never "later".
