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
