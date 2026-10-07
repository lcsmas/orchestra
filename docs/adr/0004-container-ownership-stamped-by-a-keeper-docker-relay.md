---
status: accepted
date: 2026-10-07
---

# Container ownership is stamped on the container by a per-keeper Docker relay

On 2026-10-06 a 30-member vague ran five Docker test stacks (~1.9 GB) that no
part of Orchestra could see or stop: containers run under dockerd, outside every
keeper's process tree, so the resource monitor could not attribute them and a
Pause dure left them running. The host crashed twice that night under memory
pressure. We make each workspace's **keeper** host a small Docker relay: the
member's environment points `DOCKER_HOST` at it, it forwards every call to the
real Docker socket and stamps `orchestra.ws` / `orchestra.run` labels on every
container it creates. **Ownership lives on the container** (the label is written
by Docker atomically with the creation); **the bus records only what the host
did** — the Bilan de pause lists the containers a Pause dure stopped, and the
Reprise restarts exactly those. Decided with the user on 2026-10-07 (grilling
session).

## Considered options

- **Agents add `--label` themselves** (skill prose) — rejected: discipline, not
  a guarantee; one forgotten flag and the container is invisible.
- **A `docker` wrapper on the member's PATH** — rejected: bypassed by an
  absolute `/usr/bin/docker`, by compose and by Docker client libraries; the
  relay is honoured by all of them through `DOCKER_HOST`.
- **One relay in the app's main process** — rejected: it must guess which
  workspace is calling, and it dies on every app restart while sessions keep
  running (two restarts on 2026-10-07 alone). A keeper outlives the app and
  knows its workspace.
- **An ownership table on the bus** — rejected despite ADR 0002 (bus as source
  of truth): it drifts the first time someone runs `docker rm` outside the app.
  The label cannot diverge from the container it describes.

## Consequences

- A container created around the relay (hard-coded socket path, a PTY session
  with no keeper — out of scope, PTY agents are being retired) is unattributed:
  counted and reported, never stopped.
- A broken relay never breaks a rig: the keeper restarts a relay that dies; one
  that cannot start leaves `DOCKER_HOST` unset, so the member uses the real
  socket and its containers count as unattributed.
- Every Pause dure — manual or automatic — stops (never removes) its members'
  attributed containers; the resource monitor adds their memory to the owning
  workspace.
- Ships behind a frozen per-run switch, default OFF, enabled on the bloc2 fleet
  first: a broken relay would break every rig of a vague.
