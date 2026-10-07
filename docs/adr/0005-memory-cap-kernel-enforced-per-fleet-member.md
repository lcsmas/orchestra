---
status: accepted
date: 2026-10-07
---

# Each fleet member runs under a kernel-enforced Plafond mémoire, not a voluntary heavy-rig lock

The memory guard (#284) reacts to the host's available memory, but it samples at most every 10 s and only
governs process STARTS — a test an agent launches mid-turn (a packaged app, a mutation sweep, an ad-hoc
script) can still drain memory between two samples, which is how the 2026-10-06 night went down. Wave G
held the line with a heavy-rig "token" written in its ledger: a convention nothing enforces, blind to any
command an agent improvises. We make the limit structural instead: the keeper starts each fleet member's
session in its own cgroup v2 scope with a soft level (`MemoryHigh`, default 3 GB) and a hard level
(`MemoryMax`, default 6 GB); everything the member starts inherits it. The keeper and the CLI are made the
least likely OOM victims so the kernel kills the runaway tool process, not the session; the keeper watches
`memory.events` and the host reports each kill to the member's view and to its coordinator. Containers run
under dockerd, outside the scope, so the keeper's Docker relay (ADR 0004) holds their creation under the
Admission threshold instead. Decided with the user on 2026-10-07 (grilling session).

## Considered options

- **`orchestra rig` — a voluntary lock heavy scripts take** — rejected: only scripts that call it are
  limited; an agent's improvised command is not, and no test can see those.
- **Kernel cap on the whole fleet / one scope per run** — rejected: one runaway would throttle every member
  of its fleet; per-workspace isolates the culprit.
- **Hard limit only, or soft only** — rejected: soft-only can still exhaust the host; hard-only kills where a
  slowdown would have sufficed.

## Consequences

- Applies at a member's next session start (restart, réveil from Veille); running sessions are not migrated.
- Ships behind a Settings toggle in the Garde mémoire window, OFF by default, ON after a canary on a dummy
  fleet proves a runaway test is killed and reported while the session survives.
- Values from 48 k monitor samples (2026-10-05→07): running member p99 3.1 GB, max 6.3 GB.
