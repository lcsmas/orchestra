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
session in its own cgroup v2 scope with a hard level (`MemoryMax`, default 6 GB, `MemorySwapMax=0`) and a
soft level (default 3 GB) that the keeper watches and only reports; everything the member starts inherits it. The keeper and the CLI are made the
least likely OOM victims so the kernel kills the runaway tool process, not the session; the keeper watches
`memory.events` and the host reports each kill to the member's view and to its coordinator. Containers run
under dockerd, outside the scope, so the keeper's Docker relay (ADR 0004) holds their creation under the
Admission threshold instead. Decided with the user on 2026-10-07 (grilling session).

**Amended 2026-10-09 (wave H Q9, ticket #332).** The scope is still ONE per member, but shaped as a delegated parent cgroup with two leaves: the keeper AND the CLI in `k` (no limit of their own), the tool commands in `w` (each Bash command's shell moves itself in through the existing tool wrapper), which carries the hard level. A flat scope loses the SESSION to back-to-back tool kills: the keeper's reaction to a kill allocates at the limit while the killed tool's pages are still charged, and with no tool left to kill the kernel takes the keeper, then the CLI (measured: 10/10 lost). The CLI must stay out of the limited cgroup too: a busy CLI inside it lost the session 4/8; with keeper + CLI in `k` and only the tools in `w`, 8/8 survived (ledger #329 c/6078715647 and c/6079188380). So the hard level now caps the Bash commands — the incident's culprit — not the CLI, its MCP servers or hooks; the scope itself keeps a backstop limit above the hard level (`hard + 1 GiB` of room for the keeper, the CLI and its servers) so `w` always trips first.

## Considered options

- **`orchestra rig` — a voluntary lock heavy scripts take** — rejected: only scripts that call it are
  limited; an agent's improvised command is not, and no test can see those.
- **Kernel cap on the whole fleet / one scope per run** — rejected: one runaway would throttle every member
  of its fleet; per-workspace isolates the culprit.
- **Kernel soft level (`MemoryHigh`) as a throttle** — rejected 2026-10-08 (wave H Q2, measured on a zram host):
  with swap the hog parks in zram and is never killed; without swap it crawls at the soft level for hours,
  the CLI included, and the hard level never fires. The soft level is a warning to the member and its
  coordinator instead.
- **Soft only** — rejected: a throttle alone leaves a stuck member nobody is told about.
- **One flat scope for keeper + CLI + tools** — rejected 2026-10-09 (Q9): the keeper shares the cgroup that reaches its limit, so its own reaction to a kill can open the episode that kills it. A sacrificial adj-1000 sentinel only postpones that (consumed at ≈0.12 per kill).
- **Keeper alone outside the limit, CLI + tools inside** — rejected 2026-10-09 (Q9 addendum): a busy CLI is itself an adj-0 allocator in the window (lost the session 4/8).

## Consequences

- Applies at a member's next session start (restart, réveil from Veille); running sessions are not migrated.
- Ships behind a Settings toggle in the Garde mémoire window, OFF by default, ON after a canary on a dummy
  fleet proves a runaway test is killed and reported while the session survives.
- Values from 48 k monitor samples (2026-10-05→07): running member p99 3.1 GB, max 6.3 GB.
