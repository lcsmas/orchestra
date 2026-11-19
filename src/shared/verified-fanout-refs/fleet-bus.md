# The fleet bus in full

(Read when a message does not arrive, before `orchestra ask` / `gate` / `token`, or when a SessionStart notice line says `=OFF` (SKILL.md §0c). Long form of what SKILL.md carries as one-line rules; the § numbers are SKILL.md's.)

Orchestra coordinates the fleet on a **bus** (one SQLite database, total
order; `docs/codebase-map/bus.md`). Six switches — `wake`,
`ask_gate`, `liveness`, `fencing`, `capability`, `receipts` — are frozen on each
run at start (mail is not a switch: since ADR 0012 bus mail cannot be turned off) and printed in your SessionStart notice. **Every run active
since 2026-09-28 is all-ON (bus audit 2026-09-30), so this section is ON-only.**
A notice line `=OFF` means a legacy run: its OFF channel is in
`git -C ~/.claude show e07d1e4:skills/verified-fanout/SKILL.md` §0c — read it
there, and never run both channels for one mechanism.

- **mail** (always on) — `orchestra send --type <kind> [--to <handle>] [--thread <id>]
  <body>` (a long body: `--body-file <path>`; an unknown `--option` is refused, never sent as text); pull with `orchestra check`, confirm with
  `orchestra ack <lot-id>` (only the reader acks; an unacked lot replays) — or
  `orchestra check --ack-previous` closes the handled lot and takes the next in ONE
  call. `orchestra message` is refused for every target (only `--emergency <id> <text>`,
  for a reader that no longer reads its mail); agents with no common ancestry may send
  each other `status` and `ask` only — a `dispatch` or a gate across unrelated runs is
  refused with the reason. **Only a real task assignment is `--type dispatch`: it mints
  a capability and SUPERSEDES the recipient's previous one in that run** — orders,
  pings and FYIs are `status`; the one final report of a dispatched task is
  `worker_done --cap` (§0b). Quiet-until-done: every addressed row wakes its
  recipient; a worker sends gate failures, decision asks and ONE final report,
  nothing per phase.
- **wake** — the host orders a turn: `lot pending — run the check command(s)
  below`; run EXACTLY those `orchestra check --run <id>` lines, then ack each
  lot. Self-arm a wakeup only for what the host cannot see (CI, a rig).
- **ask_gate** — `orchestra ask --to <handle> <question>` parks a question and
  exits; the answer is `orchestra send --thread <ask-id>`. A ruling is
  `orchestra gate open --to <recipient> <question>`, resolved once by
  `orchestra gate resolve <id> --resolution <text>`; `--to human` is the LEAD's
  only (it renders in the app's Asks tray).
- **liveness** — the host escalates a stalled member to its coordinator
  (`escalation` row); askers in `waiting` are excluded. Blind spot (#108 Q16):
  a session hung mid-tool-call keeps `running`. No LEAD cron.
- **fencing / capability / receipts** — a replaced coordinator's writes are
  refused (`StaleGenerationError`); a `worker_done` carries `--cap <token>`
  (`orchestra token` re-fetches the active one — after any re-dispatch); pass
  `--request-id` on a mutation you might retry.
