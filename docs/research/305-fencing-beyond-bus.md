# #305: what a stale coordinator can still do outside the Bus, and whether `dcap_` tokens get lost in the field

Compiled 2026-10-07 for [#305](https://github.com/lcsmas/orchestra/issues/305), part of the map
[#296](https://github.com/lcsmas/orchestra/issues/296). It feeds the decision ticket
[#314](https://github.com/lcsmas/orchestra/issues/314). Background I don't repeat here:
[`orca-model-lineage.md`](orca-model-lineage.md) (Kleppmann's fencing rule, orca's token removal in
stablyai/orca#23982 and #23994, and the "fence the side effects" and "re-decide `dcap_`" leads) and
[`distributed-systems-leads.md`](distributed-systems-leads.md) (the stale-identity defect class).

**Pinned.** Code was read with `git show origin/master:<path>` at `743f9ab0`, 0 commits behind
`origin/master`. Field data comes from a **copy** of `~/.orchestra/bus.sqlite` plus its `-wal`, taken
2026-10-07 12:31 local into `/tmp/r305-bus/` and opened with `mode=ro`. The newest message in the copy is
2026-10-07 10:30 UTC, `user_version` is 10, and the copy covers 27 runs and 5,562 messages from
2026-09-14 to 2026-10-07. I also downloaded 26 ledger issues with `gh issue view --comments`.

Tags: **VERIFIED** means I read or ran it this session. **UNVERIFIED** means I did not. **INFERRED** means
my reasoning, not a fact from a source.

## Answer

1. **The Bus is the only thing that checks a fence.** Spawn, delete, restart, promote and the other
   socket routes carry no generation and no caller identity. Git push, merge to master, release and
   ledger writes are run by the agent's own Bash tool, and the host never runs them. None of them
   consults `coordinator_generation`. (VERIFIED)
2. **The Bus fence has a hole: a coordinator's first incarnation is never fenced.** The generation
   env var is exported only when the generation is above 0. So after the first restart (generation
   0→1), a zombie of incarnation 0 presents no generation, and `decideFence` returns `pass`. I ran this
   on master. (VERIFIED)
3. **In the field, the fence has never caught a real zombie.** There were 39 generation bumps across
   18 runs. All 18 `fence_events` were rejections of **members**, on 2026-09-28 and 09-29. That is
   the [#222](https://github.com/lcsmas/orchestra/issues/222) bug. There have been 0 events since
   09-30, and 0 ever against a coordinator. (VERIFIED) The concrete zombie Orchestra can produce is the
   replaced incarnation's **background jobs**: a healthy restart deliberately leaves them alive. They
   keep the old environment, so their Bus writes are fenced but their `git push` or `gh pr merge` are
   not. (Code VERIFIED. Whether the CLI itself reaps them is UNVERIFIED.)
4. **`dcap_` tokens were lost or went stale often until #167, and the mechanism is now almost unused.**
   Before #167 closed (2026-09-20), 55 of 85 minted tokens were superseded. After it, 11 of 57 were. In
   canary 6, at least 3 implementers had a token that was superseded or never arrived. The
   `capability_rejections` counter stands at 127 against 78 `worker_done` messages that landed. Since
   2026-09-30, only **1** `worker_done` has been sent, against 1,695 `status` messages across 14 active runs. Members now report through
   `status`, which needs no token since [#165](https://github.com/lcsmas/orchestra/issues/165).
   (VERIFIED) The loss cause I found was supersede-on-redispatch plus relay misses, not compaction as
   in orca. The counter cannot tell the two apart. (UNVERIFIED)

---

## 1. What a "stale coordinator" concretely is in Orchestra

- **The replaced CLI itself dies.** `sdkRestart` bumps the generation first
  ([`agent-sdk.ts:5107`](../../src/main/agent-sdk.ts), past the mid-turn guard). It then runs
  `sdkStop`, then `killKeeper`, and only then `ensureSession` (`agent-sdk.ts:5224-5232`). `killKeeper`
  waits until the keeper process is actually gone
  ([`keeper-client.ts:502`](../../src/main/keeper-client.ts)). VERIFIED.
- **Its background jobs survive by design.** The comment at `keeper-client.ts:506` reads: *"A HEALTHY
  kill (restart / clear / MCP refresh) never touches the agent's background jobs: the keeper's
  descendants are only swept when the keeper had to be SIGKILLed (wedged)"*. The sweep
  (`killSurvivingDescendants`) runs only when `escalated` (`:571`). VERIFIED.
- **Tool processes are their own session leaders.** The pause-trap map
  ([`docs/codebase-map/pause-trap.md`](../codebase-map/pause-trap.md) §Destructive-act rules)
  records, as measured on CLI 2.1.284: *"each tool shell leads its own session (sid = pid) … a
  background task survives an interrupt … a job that started its own session survives everything but
  the trap's provenance rule"*. I read the doc this session (VERIFIED). I did not re-run the
  measurement (UNVERIFIED).
- **INFERRED: who the zombie is.** It is the replaced incarnation's surviving background tasks, plus
  anything they `setsid`/`nohup`, plus deferred GitHub actions such as `gh pr merge --auto`. A deferred
  GitHub action has no process left to kill. All of these inherit the **old** environment, including
  the old `ORCHESTRA_COORDINATOR_GENERATION` or none at all. Whether the CLI kills its own background
  tasks when it exits on EOF or SIGTERM is UNVERIFIED. No rig has driven a real coordinator restart
  with a live background task.

## 2. Inventory: what such a zombie can still do, and whether anything checks a fence

| Side effect | Path (origin/master) | Fence checked? | Precondition the resource itself offers |
|---|---|---|---|
| Bus `send`, `ack`, `gate resolve`, `run hold`/`run resume` | CLI `fenced()` → `fencedWrite` ([`bus-verbs.ts:343`](../../src/cli/bus-verbs.ts)); predicate [`bus-fencing.ts:56-61`](../../src/shared/bus-fencing.ts) | **Yes**, when the writer is the coordinator and presents a generation. **Hole:** with no generation presented, line 57 returns `pass` before anything else, and the env var is set only when `gen > 0` ([`agent-sdk.ts:994`](../../src/main/agent-sdk.ts), [`workspaces.ts:5311`](../../src/main/workspaces.ts)). A first-start coordinator stays at generation 0 ([`bus-run-anchor.ts:133`](../../src/main/bus-run-anchor.ts) per bus.md). So the zombie of incarnation 0 is never fenced. VERIFIED by execution (§5). | n/a |
| Bus `ask`, `gate open`, `token`, `check` | bus.md §Coordinator-only fence | No (documented) | n/a |
| `orchestra spawn` | [`hooks-server.ts:269`](../../src/main/hooks-server.ts) → [`workspaces.ts:1698`](../../src/main/workspaces.ts); `from` is supplied by the caller | **No.** INFERRED: the child gets the **current** generation from the run row ([`agent-sdk.ts:991-994`](../../src/main/agent-sdk.ts)), so a zombie's spawn launders into a fully legitimate member. | — |
| `orchestra delete <id>` | `hooks-server.ts:363` → [`workspaces.ts:1870`](../../src/main/workspaces.ts): takes only the `id`, with no caller and no generation | **No.** Any socket caller can delete any workspace. | — |
| `restart`, `promote`, `attach`/`detach`, `rename`, `set-base`, `link`, `adopt-repo`, `migrate-account`, `message` | `hooks-server.ts:204-583` | **No.** `hooks-server.ts` has 0 matches for `generation` (the 1 hit for `fenc` is "defence", `:153`). `restart` refuses only for sandbox or paused runs ([`restart-workspace.ts:63`](../../src/main/restart-workspace.ts)). | — |
| `git push` of a branch or to `master` | Agent's own Bash tool. The host runs only read-only git (`merge-base`, `git.ts:390,1208,1422,1440`). There is no `push`/`merge` exec in `src/main` (grep) | **No.** | Git refuses a non-fast-forward branch update unless forced. `--force-with-lease=<ref>:<expect>` updates only if the remote ref still equals `<expect>`. A tag update is always rejected. ([git-push PUSH RULES](https://git-scm.com/docs/git-push)) VERIFIED. |
| Merge a PR | Agent's `gh pr merge` | **No.** | `gh pr merge --match-head-commit SHA` (gh 2.87.3 `--help`). REST `PUT …/pulls/{n}/merge` `sha`: *"SHA that pull request head must match to allow merge"* → **409** on mismatch ([GitHub REST](https://docs.github.com/en/rest/pulls/pulls#merge-a-pull-request)). VERIFIED. `--auto` hands the merge to GitHub, outside any process (INFERRED). |
| Release | [`scripts/release.sh`](../../scripts/release.sh): local tag check `:331`; #78 preflight `rp_two_way_discriminator` + `rp_next_version_free` `:367-385`; `git push origin HEAD:master` `:414,484`; `push --follow-tags` `:476` | **No bus read.** The guards check version and tag freshness, which is check-then-act. | The FF-only master push and the never-updatable tag are server-side compare-and-set operations. They stop a zombie with an **older** view of master, but not one whose view is current (INFERRED). |
| Ledger writes (`gh issue comment` / edit body) | Agent's `gh` | **No.** | Whether GitHub supports conditional (`If-Match`) writes on issues: UNVERIFIED. |

**INFERRED, the shape of the gap.** Kleppmann's rule says the *resource* must check the token. It
cannot be applied literally to git or GitHub, because they cannot read Orchestra's generation. Three
levers are available instead:

- **(a) Fence by termination.** The host owns the replaced incarnation's processes. On replacement it
  could kill their tool trees by identity, reusing the Pause trap's `killToolTrees` and `CLAUDE_PID`
  provenance. This is STONITH-shaped and covers every row above at once, except deferred GitHub
  actions.
- **(b) Close the generation-0 hole.** Always export the generation, or count the first start as 1.
- **(c) Push the precondition into the resource's own compare-and-set.** Use `--force-with-lease` or
  `--match-head-commit` with the expected sha taken from a Bus fact. A generation check in
  `release.sh` right before pushing would be advisory only (TOCTOU).

The host-mediated socket acts (spawn, delete, restart) need **caller identity** before a generation
check can even mean anything.

## 3. Field data on fencing

| Measure | Value | Source |
|---|---|---|
| Runs / runs ever bumped / bumps (`sum(coordinator_generation)`; the bump is `+1`, `bus.ts` `bumpCoordinatorGeneration`) | 27 / 18 / 39 | bus copy, VERIFIED |
| `fence_events` | 18, all `fired=1` (12 `ack`, 6 `send`), runs `ef9f84d0` (09-28 13:01–16:19) and `0d4e3866` (09-29 20:25–20:33) | bus copy, VERIFIED |
| …whose actor is the run's coordinator | **0** (case-folded comparison) | bus copy, VERIFIED |
| …after 2026-09-30 (after the #222 fix) | **0** | bus copy, VERIFIED |
| Issue or ledger reporting a zombie *coordinator* side effect | none found. Searched `zombie`, `stale coordinator`, `fencing` over all issues, plus the ledger texts | `gh issue list --search`, VERIFIED (one search surface) |

Reading: every fence firing on record was a false positive against members, the #222 class, which was
reported from the 09-29 field incident on ledger #198. **What would make this misleading:**
`fence_events` only sees Bus writes that *present* a generation. A generation-0 zombie, or any git or
GitHub side effect, would leave no trace there. So "0 true positives" is an absence on an instrument
that is blind to the gap in §2, not proof that no zombie acted.

## 4. Field data on `dcap_` tokens

**What the counter measures** (VERIFIED, [`bus-verbs.ts:555-559`](../../src/cli/bus-verbs.ts)):
`capability_rejections` increments on every `worker_done` whose token is absent or not `active`,
whether the switch is ON or OFF. It increments **before** `runMutationOutcome`
(`bus-verbs.ts:585`), so a `--request-id` replay is counted again. The table is `(run_id, count)`:
there are no timestamps, and "absent" cannot be told apart from "superseded". With the switch OFF, a
counted completion still lands.

| Measure | Value |
|---|---|
| `capability_rejections` total | 127 (14 run rows, including `default` = 2) |
| `worker_done` landed | 78 (61 at or before 09-20 20:54 UTC, 17 after) |
| Runs frozen `capability:true` **at creation** (excludes `0524718f` and `36773f53`, refrozen 10-06/10-07) | refused attempts 27, accepted completions 45 |
| Tokens minted before / after #167 closed (2026-09-20T20:54Z) | 85 (55 superseded, 65 %) / 57 (11 superseded, 19 %) |
| Counter at the #198 audit ([c/5871599031](https://github.com/lcsmas/orchestra/issues/198#issuecomment-5871599031), 2026-09-28 14:07Z) | 120, then 121 after one deliberate T5 probe. So there were **≤ 6 organic rejections in the 9 days since** |
| Messages since 2026-09-30 (14 runs active) | `worker_done` **1** · `status` 1,695 · `dispatch` 30 |
| Early OFF runs with `worker_done` but **0** bus dispatches (`0a5c25bb`, `8334720c`) | 13 + 6 completions. No token could exist, because the dispatch went through another channel |

**Ledger record** (VERIFIED: `grep -i 'dcap_|--cap|capabilit'` over 26 ledgers; 9 had hits):

- **Canary 6, [#164](https://github.com/lcsmas/orchestra/issues/164)** (2026-09-20, capability ON).
  IMPL-160 had its token *"refused as superseded"*. IMPL-158 had its token *"NOT arrived in check"* and
  then *"received but REJECTED"*. IMPL-162 had its token *"superseded"*. The wave's remedy was
  untokened `question` pings (F-C6-2, *"dcap token doom-loop: every relay dispatch re-mints+supersedes
  the token it carries"*). The interim protocol needed `--cap` on every `status` until #165.
- **[#167](https://github.com/lcsmas/orchestra/issues/167)** lists two live cases: (a) a re-dispatch
  superseded a member's token, so a legitimate completion was refused; (b) a relay miss, where the
  recipient could not fetch its token. The fix added the `orchestra token` verb, which rotates the
  token when it is retrieved (bus.md §#167).
- **After #167**, the only ledger mention is a standing brief rule repeated in #234, #237 and #261:
  *"`orchestra send --type dispatch` only for a real task assignment — it supersedes the recipient's
  capability in that run. Orders, pings, FYIs = `--type status`."* No loss is reported after it.

**INFERRED.** Orchestra's documented loss modes were the token's own lifecycle (supersede and relay),
not compaction. `orchestra token` would also recover a token lost to compaction, which orca had no
equivalent for, though compaction loss itself cannot be seen in the data. Because the fleet moved
completions to `status`, the mechanism now guards a path that sees about one message a week. I found
no record of a **true positive**, that is, a late completion from a hung, superseded dispatch being
correctly rejected. The counter cannot distinguish that case from a stranded legitimate worker.

## 5. Execution check of the generation-0 hole

`git show origin/master:src/shared/bus-fencing.ts` was copied to `/tmp/r305-run/` (the file has no
imports) and run with `node --experimental-strip-types`:

```
pass    first-incarnation zombie (no env gen) after 0->1 bump      {presented:null, current:1, coordinator, ON}
reject  positive control: zombie presenting 1 after 1->2 bump      {presented:1,    current:2, coordinator, ON}
pass    live successor presenting 2
```

This proves the predicate. It does not prove that a real gen-0 zombie process exists end to end: that
rig is owed (below).

## Rigs #314 would need (the evidence rule of the #296 map)

1. **Real coordinator restart with a live background task:** keeper → real `claude` → fake API.
   Assert that the old task survives the restart, still carries the old or no generation, and that its
   `git push` to a scratch bare remote lands. This must FAIL on master, i.e. the push is accepted.
2. **Generation-0 zombie Bus write:** coordinator at gen 0 → restart → the old background job sends
   `--type dispatch`. On master it lands, with no `fence_events` row.
3. **Socket acts:** a member's `orchestra delete <coordinator-id>` succeeds on master.

## VERIFIED

- Socket routes take no generation or caller identity. Commands: `git show origin/master:src/main/hooks-server.ts | grep -c -i -E 'generation|fenc'` → 1 (the word "defence"); I read `/spawn`, `/deleteWorkspace`, `/restart` and `/promote`.
- The host runs no `git push` or `merge`: grep for `push|merge` exec over non-test `src/main/*.ts`, which shows only `merge-base`.
- `release.sh` never reads the Bus: grep for `generation|fenc|bus|coordinator` over the script; I read `:325-385`, `:405-420` and `:470-490`.
- Restart order is bump, then stop and kill, then start; a healthy kill spares background jobs (`agent-sdk.ts:5097-5232`, `keeper-client.ts:502-571`).
- `decideFence` passes when no generation is presented; the env is set only when gen > 0 (code plus the execution in §5).
- Bus figures in §3 and §4, from a read-only copy (queries above).
- Ledger quotes, from #164, #167, #198, #234, #237 and #261 as downloaded with `gh`.
- `git push` PUSH RULES and `--force-with-lease`, GitHub merge `sha` → 409, and `gh pr merge --match-head-commit` (WebFetch of git-scm and GitHub docs, which paraphrase through a small model; `gh --help` run locally).

## NOT VERIFIED

- Whether the `claude` CLI kills its own background tasks when it exits on EOF or SIGTERM during a healthy restart. This decides whether the zombie in §1 exists in practice.
- That any zombie coordinator ever performed a non-Bus side effect in the field. No instrument records one.
- How many of the 127 rejections were absent versus superseded tokens, replays, true positives, or compaction losses. The counter has no fields for these.
- The weekly `worker_done` rate before 09-14. The bus copy starts on 09-14.
- Whether GitHub supports `If-Match` conditional writes for issue comments or bodies.
- The orca PR texts (#23982, #23994). I relied on `orca-model-lineage.md` and did not re-read them.
- The pause-trap measurements of tool-session behaviour. I read the doc and did not re-run them.
