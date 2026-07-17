# Multi-agent orchestration

The headline feature: **agents can spawn other agents.** Every Orchestra agent learns, at session start, that it can delegate self-contained work to a brand-new sibling workspace — and the agents it spawns get the same capability.

## Spawning

Any agent (or you, from a shell) can run:

```bash
orchestra spawn --task "full self-contained instructions for the new agent"
```

Orchestra cuts a fresh branch from the base, creates the worktree, starts a new agent, hands it the task, and nests it under the spawner in the sidebar. Flags: `--repo <path>` targets another registered repo, `--base <branch>` picks the base, `--detached` makes it a top-level workspace instead of nesting.

**Use cases:**

- *Parallelize a refactor* — "split this migration across the four services, one agent each."
- *Fan out independent tasks* — hand an agent your TODO list and let it delegate each item.
- *Keep your session clean* — spawn a side-quest (a flaky test, a doc fix) instead of derailing the current conversation.

The spawned agent shares **no context** with the spawner — the task text must stand alone. That constraint is what makes the fan-out safe.

## Peer communication

Agents in sibling workspaces can coordinate:

```bash
orchestra peers                    # who else is running (id, branch, repo, status)
orchestra read <id> [--lines N]    # read a peer's recent transcript
orchestra message <id> <text...>   # hand a peer a prompt
```

Messages to a running agent are delivered live; a stopped agent is woken to handle the message; if it can't be, the message queues in an inbox delivered at its next session start. The recipient sees who sent it and can reply back.

**Use cases:** a spawner checking on delegated work (`read`), follow-up instructions after review (`message`), an agent asking the workspace that owns a subsystem to make a change instead of touching it cross-worktree.

## Orchestrators

An **orchestrator** is a session whose whole job is coordination. Create one from the sidebar (🌿), or promote an existing scratch session (`orchestra promote`). Orchestrators:

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

Orchestra installs a set of `orchestra-*` Claude Code **skills** into every worktree (spawn, comms, rename, promote, attach, repos, migrate-account). Only each skill's one-line description sits in the agent's context; the full instructions load on demand. Reminder hooks re-surface the relevant capability exactly when it matters (e.g. the comms reminder only fires while sibling agents actually exist).
