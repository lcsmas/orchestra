# Orchestra — fleet coordination

Vocabulary for coordinating parallel Claude agents (a LEAD, an OPS per wave,
workers) over the fleet bus. Terms settled with the user on issue #108
(2026-09-07); this file is a glossary, never a spec.

## Language

### Runs

**Mission**:
The enclosing run coordinated by the LEAD; its sole worker is an OPS.
_Avoid_: parent run, outer run

**Vague** (wave):
A run coordinated by an OPS: the set of workers and verifier delivering one
batch of tickets.
_Avoid_: run, sprint, batch

**LEAD**:
The agent that answers to the human and coordinates missions.
_Avoid_: coordinator, orchestrator (both ambiguous: an OPS also coordinates)

**OPS**:
The agent that coordinates one vague; the only member that talks to the LEAD.
_Avoid_: ops-agent, wave lead, supervisor

**Worker**:
An agent doing one ticket of a vague in its own worktree (implementer,
verifier, reviewer).
_Avoid_: child, sub-agent, impl

### Bus

**Bus**:
The single SQLite database holding every fleet message in total order; the
source of truth for what was said and delivered.
_Avoid_: queue, inbox, channel, ledger (see below)

**Lot** (batch):
The set of unread messages handed to one reader in one relève; at most one
lot per reader awaits its accusé.
_Avoid_: delivery, page, chunk

**Relève** (check):
A reader pulling its pending lot from the bus. CLI verb: `check`.
_Avoid_: poll, fetch, check-in

**Accusé** (ack):
The reader's confirmation that a lot was read; only the reader can give it. CLI verb: `ack`.
_Avoid_: receipt, delivered, confirmation

**Réveil** (wake):
The host-triggered session turn that orders a reader to do a relève; it
carries no content.
_Avoid_: push, bell, notification, ping

**Ruling**:
A decision by the human that binds the fleet, recorded on the bus by the LEAD as the resolution of a decision gate. CLI verb: `gate`.
_Avoid_: answer, feedback, verdict

**Ask**:
A question one agent parks on the bus for another and waits on without a running process; answered by a message, never by a timeout. CLI verb: `ask`.
_Avoid_: blocking call, prompt, request

**Digest**:
An OPS's synthesis of a vague's state for the LEAD (and the human).
_Avoid_: report, status update, recap

**Ledger**:
The human-readable projection of a mission or vague built from the bus;
not a source of truth.
_Avoid_: issue, ticket (the GitHub-issue form is one rendering of it)

### Pause

**Pause**:
A run and all its descendant runs frozen by the host: no réveil, no new turn,
no liveness escalation, until a Reprise. Has two modes that end in the same
state. The whole fleet is paused by pausing each root run.
_Avoid_: hold (today: liveness-only silence, now one effect of a Pause), stop, freeze

**Pause douce** (soft pause):
A Pause where each member finishes its running command, saves its own work,
then stops; turns into a Pause dure when it overruns its deadline.
_Avoid_: graceful stop

**Accusé de pause** (pause accusé):
In a Pause douce, a member's confirmation that its running command is finished
and its work committed and pushed (`orchestra run confirm pause`); the host
confirms for a member with no turn running, and the trap for a straggler it took.
Counted "N/M en pause" — the Pause douce ends (escalates) when all N confirmed or at the deadline.
_Avoid_: ack (a bus `ack` closes a mail lot, a different thing)

**Pause dure** (hard pause):
A Pause the host imposes at once: it snapshots every worktree to a pause ref,
records what was running, interrupts the turn and kills the tool process
trees — never the session itself, which stays resumable.
_Avoid_: kill, sigkill, abort

**Bilan de pause** (pause record):
What the host recorded for each member when the Pause took effect: what it
was doing, its snapshot ref, whether its tree was dirty, which commands it killed.
_Avoid_: pause report, state dump

**Pause automatique** (auto Pause):
A Pause dure the host imposes when a structured member stops on its account's
usage limit (`runs.pause_auto` = who and which account); lifted by an automatic
Reprise once the accounts those members are pinned to have quota again — at the
reset, on a fresh usage reading, after an account switch or a re-login. A manual
Pause is never lifted this way.
_Avoid_: auto-resume (that is the per-session usage-limit nudge, #74)

**Reprise** (resume):
Lifting a Pause top-down: the host releases coordinators first, each OPS
re-dispatches its members with a Consigne de reprise; nobody restarts on their own.
_Avoid_: unpause, restart, relaunch

**Consigne de reprise** (resume brief):
The message an OPS sends one member at a Reprise, built from the member's
Bilan de pause. Killed commands are listed, never re-run automatically.
_Avoid_: resume nudge (that is the generic usage-limit auto-resume text)

**Libération** (release):
During a Reprise, the act that lets one member start again: the host releases
the coordinators; a coordinator releases its workers with `orchestra run release`,
which also sends each its Consigne de reprise. A member not yet released stays blocked.
_Avoid_: unblock, wake (a release opens the gate; it does not start anything)

**Reprise accusé** (resume acknowledgement):
A member's confirmation (`orchestra run confirm reprise`) that it read its Consigne
and is back on its feet. Tracking only — it gates nothing; `bus-status` shows "N/M repris".

### Quality

**Nomination**:
A worker's claim that a named branch ref is ready to be gated for merge.
_Avoid_: submission, done report, PR

**Candidate**:
The frozen ref a nomination names; every stage judges exactly this ref.
_Avoid_: branch, tip (both move)

**Stage**:
One quality check a candidate passes through: pre-review, verifier gate,
adversarial review, or post-merge use.
_Avoid_: gate (only the verifier's stage), check

**Escaped defect**:
A defect found after its candidate merged, attributed to the ticket or merge
that introduced it.
_Avoid_: regression, bug (too broad)

### Workspaces

**Spawned agent**:
A workspace created by an agent through `orchestra spawn`. A workspace created
by a human click is not a spawned agent, even when the click goes through the
same spawn path (e.g. spawning from a pinned Linear ticket).
_Avoid_: child (only meaningful under an orchestrator), worker (a fleet role)

**Default model**:
The model a new workspace is pinned to when nobody names one. There are two:
the *workspace default model* (human-created workspaces) and the *spawned-agent
default model*. It is copied onto the workspace at creation, so changing it
never moves an existing workspace. An explicit pick always wins.
_Avoid_: account default (that is Claude Code's own fallback, one of the choices)

**Default effort**:
The reasoning effort a new workspace is pinned to (`Workspace.sdkEffort`) when
nobody names one — same two kinds as the default model (human-created / spawned
agent), same freeze-at-creation rule. *Model default* pins nothing (the model's
own effort). Unlike the model, a workspace with no pinned effort never follows
the setting later.

### Agent view

**Tâche de fond** (background task):
Work an agent starts and does not wait for — a sub-agent, a backgrounded
shell command, or a Monitor. It outlives the turn that started it.
_Avoid_: job, background process

**Avis de tâche** (task notice):
The message the Claude Code CLI injects into a session when a tâche de fond
finishes, fails, is found orphaned after a restart, or (Monitor) emits an
event. It starts a turn by itself. Not a réveil: a réveil comes from the
fleet bus and carries no content; an avis de tâche comes from the CLI and
reports on one task.
_Avoid_: notification (blurs it with a réveil), alert
