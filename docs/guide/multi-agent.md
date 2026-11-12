# Multi-agent orchestration

The headline feature: **agents can spawn other agents.** Every Orchestra agent learns, at session start, that it can delegate self-contained work to a brand-new sibling workspace — and the agents it spawns get the same capability.

## Spawning

Any agent (or you, from a shell) can run:

```bash
orchestra spawn --name impl-politique-nommage-381 --task "full self-contained instructions for the new agent"
```

Orchestra cuts a fresh branch from the base, creates the worktree, starts a new agent, hands it the task, and nests it under the spawner in the sidebar. Flags: `--name <name>` (required) names the child, `--repo <path>` targets another registered repo, `--base <branch>` picks the base, `--detached` makes it a top-level workspace instead of nesting.

**Naming.** The spawner names its child: `<rôle>-<objet en mots humains>[-<ticket>] — rôle ∈ ops | impl | verif | review | explo (ex. impl-politique-nommage-381)`. The name is the child's branch and its sidebar name, so write the object in the human's own words (no wave codes like `h1` or `q9`) and end with the ticket number when there is one. A spawn without `--name`, or with a name that does not start with a rôle, is refused and nothing is created; a name already taken is suffixed and the final branch is printed. The child is never asked to rename itself, and its spawner can change the name later (`orchestra rename`). Workspaces you create yourself keep naming themselves, and so do the ones started from a pinned Linear ticket or the mobile access.

**Use cases:**

- *Parallelize a refactor* — "split this migration across the four services, one agent each."
- *Fan out independent tasks* — hand an agent your TODO list and let it delegate each item.
- *Keep your session clean* — spawn a side-quest (a flaky test, a doc fix) instead of derailing the current conversation.

The spawned agent shares **no context** with the spawner — the task text must stand alone. That constraint is what makes the fan-out safe.

**Who may rename a spawned agent (human > parent > child).** A spawned agent is named by its parent, so it cannot rename itself: `orchestra rename` on its own workspace is refused with "named by your parent (<name>) — ask them to run `orchestra rename`". The parent can rename its child at any time (`orchestra rename <child-id> <name>`) and the name sticks. A name you type in the sidebar over a parent's name is final: neither the parent nor the agent can change it ("named by the human"; even for an older agent nobody named, its parent can no longer rename it once you have). Workspaces you create yourself keep naming themselves.

## Peer communication

Agents in sibling workspaces can coordinate:

```bash
orchestra peers                        # who else is running (id, branch, repo, status; `ex-<old name>` beside a renamed one)
orchestra send --type status --to <id> <text...>   # message a peer on the bus (durable, ack'd)
orchestra message <id> <text...>       # REFUSED — the bus is the only channel (see below)
```

Every agent has a run and the **bus** is the only channel between agents (`orchestra send`): messages are durable, ack'd and re-driven, so they survive the peer being stopped, mid-turn or restarted.

`orchestra message` is **refused for every target** and prints the equivalent `orchestra send`. Only `orchestra message --emergency <id> <text...>` survives, as an out-of-band poke that pushes text into the session of a peer whose bus reader no longer reads its mail (live/woken/inbox delivery semantics apply to it; the recipient sees who sent it and replies with `orchestra send`).

**Use cases:** a spawner checking on delegated work (`peers`), follow-up instructions after review (`message`), an agent asking the workspace that owns a subsystem to make a change instead of touching it cross-worktree.

## Orchestrators

An **orchestrator** is a session whose whole job is coordination. Create one from the sidebar (🌿); any agent that spawns agents of its own becomes one by position — there is no promote (`orchestra whoami` prints your role). Orchestrators:

- get a standing brief to **delegate, not implement** — re-asserted at every session start so it survives context compaction;
- are **hard-blocked** (by a PreToolUse hook) from editing files that belong to a child workspace — the block message re-teaches delegation at the exact moment of the violation;
- **group their fleet**: every workspace they spawn nests beneath them in the sidebar, so a whole project reads as one tree.

**Use case:** "Build feature X across these three repos." The orchestrator plans, spawns one agent per repo, tracks them with `peers`/`read`, reviews their diffs, sends follow-ups, and reports to you — while each child works in its own isolated worktree.

## Attach / detach

Fleets don't have to be born, they can be assembled:

```bash
orchestra attach <workspace-id> <orchestrator-id>   # nest an existing workspace under an orchestrator
orchestra detach <workspace-id>                     # pop it back out to its own repo section
```

Use attach to pull a branch you created earlier (or another agent created) under the orchestrator that now owns that effort.

## How agents know all this

Orchestra installs a set of `orchestra-*` Claude Code **skills** into every worktree (spawn, comms, rename, attach, repos, migrate-account). Only each skill's one-line description sits in the agent's context; the full instructions load on demand. Reminder hooks re-surface the relevant capability exactly when it matters (e.g. the comms reminder only fires while sibling agents actually exist).
