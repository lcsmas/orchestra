---
status: accepted
date: 2026-10-16
---

# A session's bus identity is resolved by the host on every CLI call, not frozen in its environment

Today `orchestra` reads its run (`ORCHESTRA_RUN_ID`) and coordinator generation from env vars baked when the session starts (`buildSdkEnv`). Promoting a working agent (`orchestra promote`) creates its new run, but the live session keeps the old one: sends are refused behind a `bus-run-stale` marker until a restart the host refuses mid-turn ([#171](https://github.com/lcsmas/orchestra/issues/171)). Every new OPS hit this: spawned, promoted, then unable to talk until its first turn ended. We make the host the authority instead: each session gets a unique session key at start; on every bus call the CLI sends its workspace id + session key and the host answers with the current run and generation — but only to the live session of that workspace, so a superseded session is still fenced (#128). A promotion therefore takes effect on the agent's next CLI call, in the same turn. Decided with the maintainer in a grilling session (2026-10-16).

## Considered options

- **`orchestra spawn --orchestrator`** (the #171 alternative: anchor the run before the session starts) — rejected: it fixes only the spawn-then-promote case, adds a CLI flag, and leaves live promotion broken.
- **Look up only the run per call, keep the generation from env** — rejected: mixing a live value with a frozen one recreates the stale-state class; the session key gives both from one rule.
- **Auto-restart the promoted agent at its next turn boundary** — rejected: still a window where the agent acts on the wrong run.

## Consequences

- While the host is unreachable (today: app quit while detached keepers live), the CLI falls back to the env values, refuses sends when the `bus-run-stale` marker exists, and always allows `check`/`ack`. This fallback is transitional: with the fleet host extracted into a daemon ([#136](https://github.com/lcsmas/orchestra/issues/136)) the host answers whenever sessions live, and the fallback goes. The identity lookup is a host service to list in the seam inventory ([#137](https://github.com/lcsmas/orchestra/issues/137)).
- The `bus-run-stale` marker survives only as the fallback's guard.
- `memory_cap` joins `dockerRelay` on the allow-list of switches a paused vague may re-freeze explicitly (`orchestra run refreeze --only memory_cap`); vague runs are otherwise still never re-frozen.
