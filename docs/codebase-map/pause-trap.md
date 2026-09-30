# Fleet Pause — the host trap (#252 D1b)

The **host's reaction** when a run becomes HARD-paused. Design: `docs/adr/0003-fleet-pause-host-enforced-on-the-bus.md` +
`CONTEXT.md` §Pause. The state, the switch, the verbs and every entry-point GATE are D1a's (`src/main/bus-pause.ts`,
`src/main/pause-gate.ts`, schema = `MIGRATIONS[9]` in `src/main/bus.ts`); this doc is what happens to the **members' worktrees
and processes** once `runs.paused_at` is set. Wave D ledger #261 (D4 = the destructive-act rules below).

## What it does, in order (per member of the paused run and every descendant run)

`trapMember` (`src/main/pause-trap.ts:123`; members run in parallel, bounded by `deps.concurrency`, default 3) — every step records its own failure in the Bilan and the trap moves on:

1. **Read what it is doing** (`activityOf`): surface (structured/pty/none), turn running, in-flight tool calls, background tasks — BEFORE anything is interrupted.
2. **Snapshot** the worktree to `refs/orchestra/pause/<run>/<ws>/<ms>` (`snapshotWorktree`, `src/main/pause-snapshot.ts:180`): a
   TEMPORARY index (`GIT_INDEX_FILE`, seeded from a copy of the real one, rebuilt from HEAD if the copy is torn) → `git add -A` into it →
   `write-tree` → `commit-tree -p HEAD` → `update-ref`. The worktree, the REAL index, HEAD and every branch are byte-identical
   before/after (D4; every git call runs `GIT_OPTIONAL_LOCKS=0`, none reads-then-rewrites the real index). Captures tracked edits,
   staged work and untracked non-ignored files; untracked files > 25 MB are left out and REPORTED; ONE unreadable file does not abort the snapshot (`git add --ignore-errors`: the rest is captured, the file is named in
   `snapshotWarnings`); checked-out submodules (`.git` FILE) are snapshotted in their own repo (`submodules[]`); a nested standalone repository (`.git` directory) is left untouched and reported. Untracked/ignored semantics = plain `git add -A`.
3. **Bilan de pause row** (`pause_records`, `src/main/bus-pause-records.ts:94`) written BEFORE any process is touched, so the snapshot
   ref is durable even if the app dies next; `killed_json` stays NULL until step 5 (NULL = "owed", so a boot drain finishes it without a 2nd snapshot).
4. **Arm + interrupt**. `arm` attaches the member's idle detached keeper (only a live, started, not-shutting-down one — `sdkAttachIfDetached` would KILL a
   never-started keeper, which D4 forbids) so its CLI-started turns are observed. `sdkInterruptForPause` (`src/main/agent-sdk.ts:3989`) then interrupts the running
   turn with a PLAIN interrupt: **the queue is never dropped** (queued AUTO prompts stay parked by `promptStream`'s pause hold and run after the lift; a HUMAN
   prompt still runs first). PTY agents get ESC. Never stops the CLI session or the keeper. A turn running in a DETACHED keeper this app run never attached to
   is attached first (attaching starts no turn). An idle session (no running or CLI-started turn) is left alone.
5. **Kill the tool process trees** (`killToolTrees`, `src/main/pause-kill.ts:149`) under a CLI whose identity was proven (keeper argv + the CLI is the
   keeper's child). Result → `killed_json`. The killer re-checks the pause before EVERY round and signal (`stillPaused`, review F8) and only reaches processes older than a HUMAN turn
   that began after the PAUSE (`startedBeforeMs`, a getter re-read at every signal, D9; process start = `now − (uptime − ticks/CLK_TCK)`, `startWallMs` — the floored `btime` read ~0.4 s early and killed a human turn's first processes): a human prompt sent while the trap runs — even one queued behind other members — is neither interrupted nor has its tools killed.
   A lift landing while the trap arms / probes the CLI stops it BEFORE the interrupt; a lift mid-kill still records what was killed.
6. **UNKNOWN is not NONE (review F4/F10).** A tracked keeper that is alive but did not answer the probe, an unprovable CLI, a failed/timed-out interrupt, ZERO members or a store not
   loaded from disk leave the member's `killed_json` NULL and the trap UNSTAMPED: retried by the sweep (≥5 s apart); the last attempt's error stays visible in `run status` until the retry's
   own write; a retry keeps the FIRST attempt's was-doing, snapshot facts and interrupt (a fresh read says "idle"); a `cliOf` error defers the interrupt to the retry (the pauser is only recognisable through a proven CLI — a probe flake must never interrupt it). `arm` has a 15 s deadline (a hang is unknown ⇒ retried; a rejection is only
   recorded); an alive keeper with an unreadable argv is 'unknown', never "no keeper". Only a proven member is complete.

Then `runs.pause_trap_at` is stamped (guarded on `paused_at`, so a trap that outlived a resume + re-pause cannot stamp the NEW pause) — only when EVERY member is complete. A lift mid-trap
stops the trap before the next process is touched. The snapshot runs with `core.hooksPath=/dev/null` (the repo's hooks never fire, review F6). **The pauser (review F5) is keyed on PROCESS ANCESTRY, never the `--as` handle.** The CLI records the `orchestra run pause` process chain at pause time
(`src/main/pause-origin.ts`, stored as a reserved `pause_records` row `__pause_origin__` — no schema change; a recent pause waits ≤3 s for it). The member whose CLI (pid + /proc
start-time re-verified against the live CLI) is an ancestor is the pauser: its turn is NOT interrupted and ONLY the tool tree that holds the call (`spareRoots`) is spared — its other
trees (a background task…) are killed; it is still snapshotted, armed and recorded (`exempt: pauser`). A human typing `--as <coordinator>` in a plain shell exempts NOBODY. No origin /
a recycled CLI pid in the chain ⇒ nobody is spared.
A CLI-started turn on the pauser is a new turn and IS trapped (rows 29/30).

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
- **Another session's supervisor is never a tool (review F1, pre-review M1/M2)**: an env-/session-proven orphan that is, has a descendant or has an ANCESTOR that is `keeper.js`, a `claude` CLI or the
  Orchestra/Electron main process is REFUSED and listed as `spared` (planner + signal-time ppid-chain re-read, an unreadable hop refuses; `supervisorAncestorOf`). `Orchestra.AppImage cli <verb>` (the `orchestra`
  CLI client) is NOT a supervisor. Real-pid arm: a daemonized app → another ws's keeper → its CLI → its MCP-like child, all carrying this CLAUDE_PID, survive. A dead prior root's recycled pid cannot vouch for an unrelated
  session (the root's planned start-time is required, review F9).
- **Orphans (LEAD ruling D11)**: a process that left the CLI's tree is killed only with provenance re-read AT SIGNAL TIME, fail-closed — `CLAUDE_PID` must name THIS member CLI's IDENTITY (pid + /proc
  start-time, re-verified just before the signal), never the bare pid, AND the process must have started after that CLI. Every killed process is listed in the Bilan with pid, cmdline, **cwd** (read before
  the signal) and **the reason matched** (`killed[].evidence` = the planner's reason + what the re-read proved; `run status` prints each orphan's line, every recorded string stripped of control characters). Real-pid must-FAIL arms
  (`scripts/pause-trap/provenance-inner.mjs`, pid namespace + `ns_last_pid`): (a) another member's orphan (its CLAUDE_PID names another CLI, even one started AFTER this CLI) survives; (b)/(c) a process whose
  CLAUDE_PID names a RECYCLED pid (the pid is now this CLI's) and that started BEFORE the CLI survives; control: the member's own daemonized orphan IS killed. Mutants `env-pid-not-matched` /
  `env-start-time-ignored` (each edits planner AND re-read — two layers cover each other) redden (a) / (b,c).
- **Known limits (NOT covered)**: a process that escaped BOTH the tree and the env marker (`env -i … &` after its shell died); containers (`docker run -d`); remote/sandbox members (recorded as not applicable); a pid recycled between the re-read and the `kill()` syscall (microseconds; no `pidfd` in Node); the turn observer's own kill (`onTurnStart`) has no human-turn cutoff; with the store loaded but 0 live members the trap is retried every 5 s and `run status` reads NOT FINISHED; an app restart after a FINISHED trap re-arms a pauser whose exempt turn is still running and the observer may then interrupt it.

## Detection (`src/main/pause-trap.ts`)

`startPauseTrap` (`src/main/pause-trap.ts:437`, called from `src/main/index.ts:564`, stopped at `:870`): a boot drain, a 15 s sweep, and a **directory** watch on the bus dir (the `-wal` inode is recycled —
same reason as `armBusWalWatcher`). `sweepPauseTrap` (`src/main/pause-trap.ts:403`) reads D1a's `runsOwingPauseTrap` (carrier paused, frozen `pause` switch ON, `pause_trap_at` NULL); concurrent sweeps trap a carrier once.
Members = non-archived workspaces with a worktree that the gate would call paused by this carrier: the carrier's anchor is self-or-ancestor on the LIVE store `parentId` chain
(`liveChainIncludes`, the same scope as D1a's `pausedCarrierForWorkspace`; `runSubtreeIds(carrier)` only as the fallback when the chain dangles — `parent_run_id` is write-once).
Every sweep also RE-ARMS (`armPausedMembers`, `src/main/pause-trap.ts:364`) each member of every ACTIVE pause, finished trap or not, so an idle keeper's CLI-started turn is observed after an app restart. **Switch OFF ⇒ `runsOwingPauseTrap` is empty ⇒ nothing happens.**
A pause that landed while the app was DOWN is drained at the next boot: the detached keepers kept running their tools meanwhile; the trap attaches, interrupts and kills.

## Rows 29 / 30 — a turn that starts on a paused member

`onTurnStart` (`src/main/pause-trap.ts:305`): a **CLI-started turn** (model output with no app-yielded turn in flight — `src/main/agent-sdk.ts:1411`; also the `submit` chokepoint, `src/main/activity.ts:957`;
e.g. `/loop`, cron, the task-notification a killed background task triggers) on a paused member (the observer asks the gate's own `pausedCarrierForWorkspace`) is interrupted, its tool trees killed, and the Bilan notes it; starts that land while the handler runs are coalesced into one re-run (none dropped); the start fired by the member trap's OWN `arm` attach is ignored (`trapArming`: the trap handles that member itself, pauser-aware, pre-review M9). A HUMAN turn is allowed and un-pauses nothing — exactly, without a timer: `sdkHumanTurnInFlight` (`session.gateTurnHuman`, set with the gate, cleared at both release sites; `humanTurns` itself is pruned at `emitQueueUpdate` before the gate opens) lets a human turn through however late the CLI's hook lands (a cold-started member; only a turn yielded AFTER the pause — one in flight at the pause is trapped), and the yield-time mark below stays as the fallback for a turn that already ended
(`markPauseHumanTurn`, `src/main/pause-trap.ts`: marked by `promptStream` (`src/main/agent-sdk.ts`) at the YIELD of a turn that contains a human prompt — the turn's real start, so a parked or second prompt is allowed when IT starts (review F2); one single-use mark per turn, 30 s TTL; a mark older than the PAUSE admits nothing). PTY agents — and a structured member with a live Raw terminal — are not observed (their human keystrokes also fire `submit`).

## Reading it

`orchestra run status [--run <id>] [--json]` (`src/cli/run-status.ts`, store-less; after the lift it still prints the LAST pause's Bilan — `pause_records` outlives `run resume`): paused by/since, the carrier (an inherited pause names the ancestor run to lift — resolved by the ONE exported `coverFor` in `src/cli/index.ts`, the live-tree walk `run resume` uses too, so a run re-parented after creation reads the same in both), trap done/owed, and per member: dirty tree, snapshot ref
(`git diff <head> <ref>` = the uncommitted work), what it was doing, interrupt outcome, commands killed, survivors, refused, spared, notes, error. Reprise is NOT automatic: nothing restarts on its own.

## Gates

| Gate | Command |
|---|---|
| Unit (real git, real bus, real processes, structural wiring) | `pnpm run test` — `pause-snapshot.test.ts`, `pause-kill.test.ts`, `pause-trap.test.ts`, `pause-trap-wiring.test.ts`, `shared/pause-procs.test.ts`, `cli/run-status.test.ts` |
| Real keeper → real `claude` CLI → real Bash-tool processes, pid+net namespaces, scripted fake API (zero tokens), the pause written by the REAL built `orchestra run pause --hard` | `pnpm run test:pause-trap` (`scripts/pause-trap/run.mjs`; refuses to run at load > 20 / MemAvailable < 6 GB; the rig's app stand-in has NO trigger of its own — detection is only `startPauseTrap`, so the `no-trap` mutant is honest): arms `blocking · foreground · background · app-restart · app-restart-bg · app-restart-idle · turn-while-paused · pauser-human · pauser-self · keeper-stopped · queue-kept` must PASS (checks: tool procs present BEFORE, 0 after, CLI+keeper alive with the same start-time, pause ref holds the uncommitted+untracked work, worktree+REAL index byte-identical, Bilan content, session resumable + a human prompt allowed, nothing restarts); load-time mutants `kill-cli · kill-keeper · snapshot-touches-index · skip-kill · skip-snapshot · no-turn-observer · no-arm · no-pauser-exemption · exempt-by-handle · stamp-on-unknown · drop-queue-on-pause-interrupt` (+ `unfixed:no-trap` = master) must each redden their named check. `--arm probe-interrupt` = what a plain interrupt leaves alive (the gap the kill exists for) |
| Real pid recycle (`ns_last_pid` in a user+pid namespace; the inner rigs REFUSE to run outside their own pid namespace — `pidns-guard.mjs`, tested by `pause-rig-guard.test.ts` — and kill only tagged pids) | `pnpm run test:pause-trap-recycle`: the innocent that inherits a planned pid survives (identity re-read removed ⇒ killed); D11 provenance arms (a)/(b)/(c) + the F1 supervisor arm + the foreign CLI's MCP-like child (ancestor rule, mutant `supervisor-ancestor-removed`) above, with their mutants |
| In-place unit mutants (byte-exact backup + `cmp`, clean control before/after, anchors match once) | `pnpm run test:pause-trap-mutants` — 123 mutants over every clause (snapshot no-touch, identity/lineage/fail-closed, kill ladder, orchestrator order/lift/dedupe, the DB stamp guard, the boot/stream/submit wiring) |
