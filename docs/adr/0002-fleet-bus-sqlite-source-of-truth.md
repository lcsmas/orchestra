---
status: accepted
date: 2026-09-07
---

# The fleet bus is a local SQLite database, and it is the source of truth

Fleet coordination (LEAD → OPS → workers) ran on three channels — GitHub-issue
ledgers, a per-workspace inbox file and direct `orchestra message` delivery —
and lost or duplicated messages in every wave (26-replay storm, lost ship
report, read-but-unactioned inbox). We adopt the delivery model of
[stablyai/orca](https://github.com/stablyai/orca) (MIT): one SQLite database
per `ORCHESTRA_HOME` (WAL, `busy_timeout` on every connection) holding every
message in total order, one outstanding lot per reader replayed until the
reader acks, durable asks and decision gates. **The bus is the source of
truth; the GitHub ledger becomes a projection rendered by the app.** The CLI
writes the database directly (N concurrent writers), so messages land while
the app is down; the app never acks on a reader's behalf. Decided with the
user on [#108](https://github.com/lcsmas/orchestra/issues/108); numbers in the
[#109 spike](https://github.com/lcsmas/orchestra/issues/109).

## Considered options

- **Ledger stays truth, bus is transport** — rejected by the user: no reason
  to depend on GitHub, structured rows beat an issue body.
- **Single writer (CLI via the app socket)** — rejected: an app restart would
  again lose messages silently, the very defect the bus exists to kill.
- **Blocking `check --wait` inside an agent turn (orca's coordinator loop)** —
  unavailable: the agents' Bash tool caps at 600 s. Every consumer is woken by
  a host-triggered session turn instead (wake-as-turn, level-triggered from
  durable state, no content in the wake).
- **Agent-emitted heartbeats (orca)** — rejected for liveness: orca's runtime
  cannot observe agent activity, ours can; liveness is host-derived, the
  agent's status note supplies the phase.

## Consequences

- Coexistence until proven: the old channels stay authoritative while the app
  mirrors every message into the bus (shadow); each mechanism flips through a
  settings switch after two complete waves with zero divergence, read at wave
  start; the old channel is removed two waves after promotion.
- One native build: better-sqlite3 built for the Electron ABI serves both the
  main process and the packaged CLI; a system-node CLI would need a second
  build. `require()` passes under the wrong ABI — only `new Database()` proves
  it.
- Vocabulary in `CONTEXT.md`.
