---
status: accepted
date: 2026-11-19
---

# The fleet host runs in a windowless daemon, and resource control is a standalone service any swarm can call

Today every fleet mechanism of the host (réveil, liveness, Relance, Pause, Admission, Veille, the memory guard, the socket verbs) runs in the Electron main process. Close the app and the fleet stops coordinating; each keeper then ends its session 15 min after the turn ends (`lingerMs`, `src/shared/keeper-protocol.ts`). The team's two swarm skills (`/autonomous-swarm`, the Reclaim `/swarm`) do not run Orchestra, so they have none of its resource control: no Admission across runs, no cleanup after a crashed run, no owner label on containers. A disk-full incident (Reclaim, 2026-11-15) and swap on a developer machine show the need. Research #137, #138, #404 and prototype #139 resolved most of the map #136; this ADR records the decisions of #140, taken with the user on 2026-11-19 (grilling session).

We split the work in two layers, built in parallel:

1. **A standalone resource service.** A separate package in this repo, with its own binary and version and no import of Orchestra code (a test enforces it). It controls one machine, Linux first. Its unit is a **run**: an id the caller chooses, not a bus run. A run lives as long as its coordinator process (pid and start time), with no timer to renew. After that process dies, a 15-minute grace lets a resume re-adopt the run (`run start` with the same id); then the service removes the run's containers and kills its processes. An optional maximum lifetime covers a session that hangs forever. Verbs: `admit` (wait for free memory and disk), `run start` / `run end`, `exec --run <id> [--mem 6G] -- <cmd>` (a systemd scope with a hard memory level when systemd exists, else a process group), `docker-env --run <id>` (a per-run Docker relay that stamps the run id on each container), `status`. Defaults: 6 GB free memory, 10 GiB free disk, both set by environment variables; a waiting caller prints what it waits for and since when.
2. **The fleet host in a daemon (`orchestra-hostd`).** The same Electron binary started with no window (`ORCHESTRA_ROLE=hostd`), as #139 ran it. Then Orchestra moves its own Admission, Docker relay and Reliquat cleanup onto the resource service.

Rules of the host daemon:
- **One host at a time.** The app and the daemon are exclusive alternates behind one file lock; the loser becomes a client or exits. The lock holder owns the keepers. No shadow host runs in parallel: #138 found no precedent, and the keeper `hello` is last-wins.
- **Launch.** A systemd user unit with linger ON by default, so a fleet survives logout. The CLI starts the unit when no host answers. The daemon can also run in the foreground as a container's main command.
- **The app is a client** on one local socket (the #139 NDJSON transport). Host methods and frontend-only methods are split. The 6 `ipcMain` registrars move onto the transport. The client reconnects on its own.
- **With no client attached:** a permission prompt becomes a parked question on the bus; notifications queue until a client attaches; the agent browser and an account login fail with a clear message; the `hasAttachedUi()` spool gate goes (#137 §4.6, #139 claim 6).
- **The socket path never changes** across a handover, so a keeper's frozen `ORCHESTRA_SOCK` stays valid. A stale socket is unlinked only after a liveness probe fails.
- **Only the lock holder migrates the bus schema.** The CLI never migrates: it refuses against a newer schema and asks the host otherwise. The keeper sends a version integer in its handshake, and a host refuses a keeper it cannot serve.
- **Interactive PTYs stay in the app** (Run script, nvim, account login).
- **Fast switch.** Promotion needs the #139 rig passing (packaged app in a headless sway, fake API, zero tokens: réveil, Pause, keepers surviving, app attaching) and one real wave on the daemon. Rollback is to stop the unit. The in-app host code is removed two waves after promotion. Inside the daemon each mechanism still ships behind its switch.

## Considered options

- **One daemon holding both layers** — rejected: the team's swarms would have to adopt all of Orchestra to get resource control.
- **A Node `orcad`-style daemon for the host** — deferred: it needs a second build of the bus native module, a pinned Node, the `secret-tool` reader and an own lock. `ELECTRON_RUN_AS_NODE` (about 70 MB against 168 MB, #404) stays an optional later ticket.
- **A renewed lease (heartbeat) for a run** — rejected: a coordinator busy on a long task would miss renewals and lose its run.
- **A shadow host beside the in-app host** — rejected: no precedent, and two hosts would steal keeper slots.
- **The two-waves-with-zero-divergence promotion of ADR 0002** — replaced here by the rig plus one real wave, because the switch is urgent.
- **macOS support now** — deferred: Ground zero agents will run on Linux images.

## Consequences

- Finding the coordinator process from a command the agent runs (the nearest `claude` ancestor of the shell) is an assumption; an acceptance test on a real session must prove it.
- The resource service is the part the team can adopt without Orchestra; it can move to a team repository later.
- The ADR 0008 fallback (CLI reading frozen env values when no host answers) goes once the CLI can start the daemon.
- The map #136 hands off to a spec, then to the extraction backlog #141.
