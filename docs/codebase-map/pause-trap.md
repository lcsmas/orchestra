# Fleet Pause — the host trap (#252 D1b)

The **host's reaction** when a run becomes HARD-paused. Design: `docs/adr/0003-fleet-pause-host-enforced-on-the-bus.md` +
`CONTEXT.md` §Pause. The state, the switch, the verbs and every entry-point GATE are D1a's (`src/main/bus-pause.ts`,
`src/main/pause-gate.ts`, schema = `MIGRATIONS[9]` in `src/main/bus.ts`); this doc is what happens to the **members' worktrees
and processes** once `runs.paused_at` is set. Wave D ledger #261 (D4 = the destructive-act rules below).

## What it does, in order (per member of the paused run and every descendant run)

`trapMember` (`src/main/pause-trap.ts:89`) — every step records its own failure in the Bilan and the trap moves on:

1. **Read what it is doing** (`activityOf`): surface (structured/pty/none), turn running, in-flight tool calls, background tasks — BEFORE anything is interrupted.
2. **Snapshot** the worktree to `refs/orchestra/pause/<run>/<ws>/<ms>` (`snapshotWorktree`, `src/main/pause-snapshot.ts:172`): a
   TEMPORARY index (`GIT_INDEX_FILE`, seeded from a copy of the real one, rebuilt from HEAD if the copy is torn) → `git add -A` into it →
   `write-tree` → `commit-tree -p HEAD` → `update-ref`. The worktree, the REAL index, HEAD and every branch are byte-identical
   before/after (D4; every git call runs `GIT_OPTIONAL_LOCKS=0`, none reads-then-rewrites the real index). Captures tracked edits,
   staged work and untracked non-ignored files; untracked files > 25 MB are left out and REPORTED; checked-out submodules are
   snapshotted in their own repo (`submodules[]`). Untracked/ignored semantics = plain `git add -A`.
3. **Bilan de pause row** (`pause_records`, `src/main/bus-pause-records.ts:94`) written BEFORE any process is touched, so the snapshot
   ref is durable even if the app dies next; `killed_json` stays NULL until step 5 (NULL = "owed", so a boot drain finishes it without a 2nd snapshot).
4. **Interrupt** the running turn (`sdkInterruptForPause`, `src/main/agent-sdk.ts:3915`; PTY agents get ESC). Never stops the CLI session or the
   keeper. A turn running in a DETACHED keeper this app run never attached to is attached first (attaching starts no turn). An idle session is left alone.
5. **Kill the tool process trees** (`killToolTrees`, `src/main/pause-kill.ts:149`) under a CLI whose identity was proven (keeper argv + the CLI is the
   keeper's child). Result → `killed_json`; the row is complete.

Then `runs.pause_trap_at` is stamped (guarded on `paused_at`, so a trap that outlived a resume + re-pause cannot stamp the NEW pause). A lift mid-trap
stops the trap before the next process is touched. **The pauser is exempt from 4 and 5** (`paused_by` == the member's ws id): a coordinator that pauses its
own run keeps its turn (otherwise it would kill the rest of its own `orchestra run pause … && …` chain and could not resume — réveils to a paused run are refused); it is still snapshotted and recorded (`exempt: pauser`).

## Destructive-act rules (D4) — `src/shared/pause-procs.ts`

- **What is a tool**: a direct child of the CLI that is a shell run with `-c` (how the CLI runs Bash-tool commands, background tasks and hooks) + its ppid
  tree (`planToolTrees`, `:116`). MCP servers and other non-shell children are **spared and listed** (`spared`). Measured on CLI 2.1.284: each tool shell
  leads its own session (sid = pid) and exports `CLAUDE_PID=<cli pid>`; a foreground tool's abort kills its whole session, a **background task survives an
  interrupt** (only the trap kills it), and a job that started its own session (`start_new_session`) survives everything but the trap's provenance rule.
- **Identity re-read AT SIGNAL TIME** (`verifyAtSignal`, `:209`): fresh `/proc/<pid>/stat` read immediately before EVERY signal (SIGTERM, then again before SIGKILL):
  start-time equals the planned one, not a zombie, the CLI is still the same process, and a lineage proof — root ⇒ still a child of the CLI; member ⇒ ppid chain
  hop by hop, else same session as its root, else env provenance (`CLAUDE_PID == this CLI` AND started after it, re-read now). **Unreadable ⇒ refused
  (fail closed)**; the CLI, the keeper, the app and pid ≤ 1 are refused by a separate check even from a forged plan. Non-Linux: no start-time identity → nothing is killed.
- Kill order: deepest first, roots last; SIGTERM, ≤2 s grace, SIGKILL for the same-identity survivors; ≤3 re-plan rounds (a tool started while killing is caught); survivors are reported, never hidden.
- **Known limits (NOT covered)**: a process that escaped BOTH the tree and the env marker (`env -i … &` after its shell died); containers (`docker run -d`); remote/sandbox members (recorded as not applicable); a pid recycled between the re-read and the `kill()` syscall (microseconds; no `pidfd` in Node).

## Detection (`src/main/pause-trap.ts`)

`startPauseTrap` (`:328`, called from `src/main/index.ts:578`, stopped at `:884`): a boot drain, a 15 s sweep, and a **directory** watch on the bus dir (the `-wal` inode is recycled —
same reason as `armBusWalWatcher`). `sweepPauseTrap` (`:300`) reads D1a's `runsOwingPauseTrap` (carrier paused, frozen `pause` switch ON, `pause_trap_at` NULL); concurrent sweeps trap a carrier once.
Members = non-archived workspaces with a worktree whose `nearestOrchestratorId` ∈ `runSubtreeIds(carrier)` (resolved at TRAP time from the live store). **Switch OFF ⇒ `runsOwingPauseTrap` is empty ⇒ nothing happens.**
A pause that landed while the app was DOWN is drained at the next boot: the detached keepers kept running their tools meanwhile; the trap attaches, interrupts and kills.

## Rows 29 / 30 — a turn that starts on a paused member

`onTurnStart` (`:252`): a **CLI-started turn** (model output with no app-yielded turn in flight — `src/main/agent-sdk.ts:1380`; also the `submit` chokepoint, `src/main/activity.ts:957`;
e.g. `/loop`, cron, the task-notification a killed background task triggers) on a paused member is interrupted, its tool trees killed, and the Bilan notes it. A HUMAN send is allowed and un-pauses nothing
(`markPauseHumanTurn`, `src/main/pause-trap.ts:228`, registered as D1a's `setPauseHumanTurnObserver` seam in `src/main/pause-gate.ts` — `sdkSend(origin 'human')` marks once per human send; single-use, 10 s TTL). PTY agents are not observed (their human keystrokes also fire `submit`).

## Reading it

`orchestra run status [--run <id>] [--json]` (`src/cli/run-status.ts`, store-less): paused by/since, the carrier (an inherited pause names the ancestor run to lift), trap done/owed, and per member: dirty tree, snapshot ref
(`git diff <head> <ref>` = the uncommitted work), what it was doing, interrupt outcome, commands killed, survivors, refused, spared, notes, error. Reprise is NOT automatic: nothing restarts on its own.

## Gates

| Gate | Command |
|---|---|
| Unit (real git, real bus, real processes) | `pnpm run test` — `pause-snapshot.test.ts`, `pause-kill.test.ts`, `pause-trap.test.ts`, `shared/pause-procs.test.ts`, `cli/run-status.test.ts` |
| Real CLI + keeper + tool processes, pid+net namespaces, fake API | `pnpm run test:pause-trap` (`scripts/pause-trap/run.mjs`): arms `blocking · foreground · background · app-restart · turn-while-paused` must PASS; load-time mutants `kill-cli · kill-keeper · snapshot-touches-index · skip-kill · skip-snapshot · no-turn-observer` must each redden their named check |
| Recycled-pid (real pid reuse in a pid namespace) | `pnpm run test:pause-trap-recycle` |
