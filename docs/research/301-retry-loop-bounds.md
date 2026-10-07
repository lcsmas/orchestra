# Retry, re-wake and restart loops: what bounds each one (#301)

Written 2026-10-07 for [#301 — which retry / re-wake / restart loops exist, and what bounds each one?](https://github.com/lcsmas/orchestra/issues/301), part of map [#296 — runtime reliability from distributed-systems research](https://github.com/lcsmas/orchestra/issues/296). Code anchors are `path:line` on **`origin/master` @ `743f9ab0`**, read with `git show origin/master:<path>`.

Not repeated here, only referenced:
- [`distributed-systems-leads.md`](distributed-systems-leads.md): pain inventory, and lead 5 (metastability guards) with the SRE, Brooker, SEDA and PSI quotes.
- [`orca-model-lineage.md`](orca-model-lineage.md): the poison-lot bound (SQS `maxReceiveCount`), OTP restart intensity, and the circuit breaker.

Memory admission is out of scope here (the memory-guard design covers it).

Tags: **VERIFIED** = read or run this session. **UNVERIFIED** = not read. **INFERRED** = my reasoning from code, not a measurement of the running app.

## Question

Which loops re-try work with no human involved? For each one: what triggers it, what bounds it (count, time, or nothing), whether it backs off and jitters, and whether N agents can fall into step and storm together. Map each to the storm/heal-loop issues and to the sustaining effects of Bronson et al. (HotOS 2021) and Huang et al. (OSDI 2022).

## Short answer

1. **There is no jitter anywhere.** The only `Math.random()` uses in non-test backend code pick names and file ids (`git grep` this session). There is no fleet-wide wake or restart budget either. The only fleet-wide limit is the usage-limit auto-resume: 3 resumes per 20-s tick (`src/main/prompt-queue.ts:52`). VERIFIED.
2. **Two loops lock N agents into the same tick. Measured on master's own pure decision functions:**
   - **Bounded re-wake.** Readers that never ack fire at the same instant every 5 min: 5 readers first woken 5-45 s apart → 1 distinct instant per round from the second round on; 5 readers pending at app start → 1 instant from the first round.
   - **Boot-wedge heal.** 5 sessions spawned within one 60-s tick are recycled together 3 times, then escalated in the same tick (1 instant per round).
   - Control arms spread to 5 distinct instants in both rigs. VERIFIED (rig below).
3. **Bounds differ widely between loops:**
   - Bounded by count: boot heal (3 consecutive fresh starts, then 1 escalation), recycle (3 per hour with 2- and 4-min backoff), sandbox reconnect (gives up after 3 min), keeper connect (50 tries).
   - Bounded by time only, forever: re-wake (every 5 min), pause-trap retry (5→60 s), auto-Reprise (5→60 min), usage-limit resume retry (every 20 s), per-account usage refetch on error (every 30 s).
   - Not bounded by Orchestra at all: `orchestra restart` driven by an agent, and the CLI's own API retries (default 10, never set by Orchestra). VERIFIED.
4. **The heal loop is a Bronson sustaining effect** (INFERRED): a burst of CLI boots is what wedged #174's sessions, and a lock-step heal replays that same burst 3 more times (4N boots in about 14 min). The re-wake does the same with turns: a reader that never acks turns into a session boot (after hibernation) plus a turn every 5 min, forever.
5. **Cheapest must-FAIL candidates for #296:**
   - (a) Full jitter on `REWAKE_BOUND_MS` and on the recycle backoff. The two rigs below are the must-FAIL arms, and both already FAIL (lock-step) on master.
   - (b) An admission limit of K concurrent boots, shared by the startup sweep, the watchdog and wake delivery.
   - (c) Count `orchestra restart` on a never-started session into the same `bootRestartLedger`.
   - (d) Keep a failing auto-resume from spending the 3-per-tick budget, which today blocks every workspace behind it.

## Inventory

"Lock-step" means N workspaces hit by one shared trigger act in the same tick. Anchors were re-read this session.

| # | Loop | Trigger | Bound | Backoff / jitter | Lock-step / storm potential | Issues |
|---|---|---|---|---|---|---|
| L1 | **Bus bounded re-wake** (#183 D1) | Reader latched `already-woken`, lot still un-acked | **Time only: every `REWAKE_BOUND_MS` = 5 min, forever** ([`src/shared/bus-wake.ts:260`](../../src/shared/bus-wake.ts), [`:432`](../../src/shared/bus-wake.ts)). Since #185 it re-fires only while something is un-acked ([`:574`](../../src/shared/bus-wake.ts)). No count cap (poison lot, see lineage doc) | Fixed interval, no jitter. Fire times are quantised to the 60-s sweep ([`src/main/bus-wake.ts:58`](../../src/main/bus-wake.ts)) | **YES, measured.** Rig arms A and C. At app start the startup sweep ([`src/main/bus-wake.ts:986`](../../src/main/bus-wake.ts)) fires every pending reader in one pass | #183 #185 #187 |
| L2 | **Bus wake: failed delivery** | `deliverWake` returns false or throws → ledger entry deleted ([`src/main/bus-wake.ts:850`](../../src/main/bus-wake.ts)) | Retried on the next sweep (60 s, or 150 ms after any WAL write). Stopped by `startKeepsFailing` when the last 3 failures within 10 min have the identical message ([`src/shared/opening-task.ts:27`](../../src/shared/opening-task.ts), [`:30`](../../src/shared/opening-task.ts), [`:36`](../../src/shared/opening-task.ts); used at [`src/main/wake-roster.ts:25`](../../src/main/wake-roster.ts)) | None. INFERRED steady state: once failures age out of the 10-min window the reader becomes wakeable again, so a permanent failure costs about 3 failed starts per ~10 min forever. Varying error messages never trip the streak | Yes, whenever one cause fails many readers at once (INFERRED) | #227 |
| L3 | **Wake = lazy session start** | A wake for a reader with no live session (cold, hibernated) | Starts a session via `sdkWake` → `sdkSend` ([`src/main/agent-sdk.ts:3473`](../../src/main/agent-sdk.ts), wired at [`src/main/index.ts:531`](../../src/main/index.ts)) | No admission limit. Single-flight per workspace only (leads doc row 5) | **YES**: startup sweep or a broadcast → N boots in one sweep. This is the #174 burst shape (INFERRED: the boot overlap was not measured) | #174 #176 |
| L4 | **Hibernation ↔ re-wake cycle** | Idle 5 min → `sdkStopIfLive(…hibernate)` ([`src/main/hibernation.ts:181`](../../src/main/hibernation.ts); `DEFAULT_HIBERNATE_AFTER_MS` [`src/shared/hibernation.ts:29`](../../src/shared/hibernation.ts)). A hibernated reader is still wakeable ([`src/main/wake-roster.ts:20-25`](../../src/main/wake-roster.ts)) | None of its own | Combined with L1, an un-acked lot gives a full resume-boot plus one turn every ~5-10 min, forever (INFERRED) | Same lock-step as L1 | — |
| L5 | **Wake-order coalescing** (#162) | A new order while an unstarted one is queued | Merged into the queued turn ([`src/shared/bus-wake.ts:731`](../../src/shared/bus-wake.ts)) | — | Damps L1 for a busy reader | #162 (fixed) |
| L6 | **Watchdog stall recycle** (#90/#97) | Parked mail with no turn start, plus 10 min with no stream output | **3 per rolling hour per workspace** ([`src/shared/session-wedge.ts:224`](../../src/shared/session-wedge.ts)). Then `flap-limit` with one toast | Exponential 2 → 4 min (cap 15 min, unreachable at 3/h) ([`:269-275`](../../src/shared/session-wedge.ts)). **No jitter** | Yes: one 60-s tick for all workspaces ([`src/main/session-watchdog.ts:134`](../../src/main/session-watchdog.ts)). The stall clock is floored to app start (`observableSince`, [`:145`](../../src/main/session-watchdog.ts), [`:824`](../../src/main/session-watchdog.ts)). The ledger is in memory ([`:152`](../../src/main/session-watchdog.ts)), so each app restart grants 3 more recycles | #90 #97 |
| L7 | **Watchdog boot-wedge heal** (#174/#180/#197) | Turn armed, no stream message ever, 3 min of silence ([`src/shared/session-wedge.ts:104`](../../src/shared/session-wedge.ts)) | **3 consecutive failed fresh starts, then stop + one bus escalation** ([`:620`](../../src/shared/session-wedge.ts); [`src/main/session-watchdog.ts:733-806`](../../src/main/session-watchdog.ts)). Counter is in memory ([`:181`](../../src/main/session-watchdog.ts)) and also resets on app restart (INFERRED) | Inherits L6's 2 → 4-min backoff. No jitter | **YES, measured** (rig arm A2): a burst within one tick → 3 lock-step recycles plus N escalations in one tick (about 4N boots in ~14 min) | #174 #180 #197 |
| L8 | **`orchestra restart` / never-started restart** (#179 D2) | Socket `/restart` ([`src/main/hooks-server.ts:230`](../../src/main/hooks-server.ts)) → `sdkRestart` `fresh` guard ([`src/main/agent-sdk.ts:5164`](../../src/main/agent-sdk.ts)) | **None in Orchestra.** The caller (often an LLM coordinator) decides. It does not feed L7's `bootRestartLedger`, which is private to the watchdog | None | The #197 field loop ran every ~75 s, with app-wide counts of 45 "no proof of life", 34 never-started restarts and 37 unanswered interrupts. That cadence is not the watchdog's (60-s tick, 3-min window), so an external restarter is plausible. UNVERIFIED who issued it | #179 #197 |
| L9 | **Reparent restart** (#171/#179) | Promote/attach/demote changes a member's anchor | **One attempt.** A refusal is downgraded to `mark-stale` ([`src/main/workspaces.ts:2058-2075`](../../src/main/workspaces.ts)) | — | Loops over the moved subtree sequentially | #171 #179 (fixed) |
| L10 | **Usage-limit auto-resume** (#74) | `lastStopReason === 'usage_limit'` and the reset time passed or fresh usage shows recovery | **Fleet-wide 3 resumes per 20-s tick** ([`src/main/prompt-queue.ts:44`](../../src/main/prompt-queue.ts), [`:52`](../../src/main/prompt-queue.ts)), coordinators first. A failed wake is re-marked and retried next tick ([`:315`](../../src/main/prompt-queue.ts)), with no count cap | None. **But the budget is spent before the wake is attempted** ([`:263`](../../src/main/prompt-queue.ts)): 3 permanently failing coordinators, always sorted first, block every other resume forever (INFERRED) | It is the one deliberate ramp in the codebase (de-synchronises the resume) | — |
| L11 | **Fleet-pause auto-Reprise** (#256) | Quota back after a usage-limit pause | Streak window 2 h ([`src/shared/pause-auto.ts:35`](../../src/shared/pause-auto.ts)); no count cap | Exponential 5 → 60 min ([`:36-41`](../../src/shared/pause-auto.ts)). No jitter | INFERRED: runs paused on the same account become eligible on the same reset | — |
| L12 | **Pause-trap retry** (#252) | Incomplete or deferred trap | Forever | Exponential 5 → 60 s ([`src/main/pause-trap.ts:720-724`](../../src/main/pause-trap.ts)); interrupt deferrals capped at 3 ([`:728`](../../src/main/pause-trap.ts)). No jitter | Per carrier | — |
| L13 | **Sandbox reconnect** | Shim socket drop | **Gives up after 3 min** | Exponential 1 → 30 s ([`src/main/transport/reconnect-policy.ts:24-35`](../../src/main/transport/reconnect-policy.ts)). No jitter. Sandbox agents are paused (#226) | — | — |
| L14 | **Keeper launch / reattach** | Session start | Connect: 50 × (≤500 ms + 100 ms) ([`src/main/keeper-client.ts:662`](../../src/main/keeper-client.ts)). Reattach: **one attempt**; a dropped socket becomes exit −1, never a reconnect (`s.on('close')` in `makeKeeperSpawn`) | Fixed | Per workspace (single-flight) | #124 #202 |
| L15 | **Usage pollers** | Timer | Global poller: 60 s, exponential backoff on 429 up to 10 min ([`src/main/usage.ts:174-180`](../../src/main/usage.ts)). Per-account poller: a non-ok status is never "fresh", so a failing account is refetched every 30 s ([`src/main/account-usage.ts:43`](../../src/main/account-usage.ts), freshness test at `:296`/`:347`) | Per-account: none | One request per account per 30 s, so low | — |
| L16 | **PTY submit retry** (legacy terminal path) | `\r` not confirmed | 4 attempts × 2 typing rounds ([`src/main/workspaces.ts:1494`](../../src/main/workspaces.ts), [`:1501`](../../src/main/workspaces.ts)) | Fixed | — | — |
| L17 | **Claude CLI API retries** (outside Orchestra) | API error / 429 / 529 | `CLAUDE_CODE_MAX_RETRIES` default 10; `CLAUDE_CODE_RETRY_WATCHDOG=1` retries 429/529 indefinitely ([Claude Code env vars](https://code.claude.com/docs/en/env-vars), VERIFIED via WebFetch). Orchestra sets neither (`git grep` empty) | The CLI's own; its backoff and jitter are UNVERIFIED | N CLIs on one account retry against the same limit independently | — |
| — | Liveness escalation (#120) | Silent member | One escalation per silence; the dedup ledger is in memory ([`src/main/bus-liveness.ts:271`](../../src/main/bus-liveness.ts)), so INFERRED one more per silent member after an app restart | — | Not a retry loop | #160 #199 |
| — | Release (`scripts/release.sh`) | — | **No automatic retry**: the gate refuses and the human re-runs. No retry/backoff in `release*.sh` or `.github` (`git grep` empty) | — | — | #78 |

## Measured: lock-step on master's own decision functions

The rigs import `src/shared/bus-wake.ts` and `src/shared/session-wedge.ts` copied byte-for-byte from `origin/master@743f9ab0` and run under `node --experimental-strip-types`. They use an injected clock: no app, bus or CLI.

- Rig 1 drives `decideWake` the way `sweepBusWake` does: a 60-s timer sweep, plus one WAL-triggered sweep at each mail arrival.
- Rig 2 replays `watchdogTick`'s decision chain: `decideBootWedge` → `decideSessionRecycle` → `decideBootHeal`, with every fresh start wedging again (the #197 shape).

Each rig has a control arm that must come out SPREAD, which proves the instrument can say "not synchronised".

```
Rig 1  bounded re-wake, 5 readers that never ack
A  arrivals 5,15,25,35,45 s   fires r0..r4: 5|15|25|35|45, then all 360 660 960 1260 1560
   distinct instants per round: 5 1 1 1 1 1 -> LOCKSTEP
B  control, arrivals 70 s apart   distinct per round: 5 5 5 5 5 5 -> SPREAD
C  all pending at the startup sweep   all fire 0 300 600 … 1800 -> LOCKSTEP (1 per round)

Rig 2  boot-wedge heal, 5 sessions, each fresh start wedges again
A2 burst spawn at 10..14 s   ws0..ws4 recycles: 240 420 660 s; escalated: 840 s
   distinct per round: 1 1 1; escalation instants 1 -> LOCKSTEP
A  burst at 0..4 s (straddles a tick)   2 instants per round (ws0 alone, ws1-4 together)
B  control, spawns 70 s apart   5 5 5; escalations 5 -> SPREAD
```

**Mutant check.** I swapped `boundedReArmed`'s fixed `>= REWAKE_BOUND_MS` for a deterministic per-reader offset (`+ ((wokeLotSeq*37)%5)·60 s`, a stand-in for jitter) in a copy. Rig 1 then reports A `5 5 5 5`, C `1 5 5 5` → SPREAD. So the rig distinguishes "fixed interval" from "per-reader interval", and the lock-step comes from the constant itself.

Rig 2's exact line for A2: every workspace recycles at 240, 420 and 660 s and escalates at 840 s. That is 4 boots per workspace (the original plus 3 fresh) and 3 recycle bursts. In `watchdogTick` the recycles of one tick are awaited one after another ([`src/main/session-watchdog.ts:810`](../../src/main/session-watchdog.ts)), so each burst is N back-to-back stop+boot cycles seconds apart (INFERRED from the `await` in the loop; not timed).

**Why the lock-step happens.** Every interval is a fixed constant on a shared tick. A reader's next re-wake is `lastWakeAt + 5 min`, rounded up to the next sweep, so readers first woken within one sweep window share every later sweep. A random term per reader is what breaks this. That is Brooker's point: with backoff alone "there are still clusters of calls … we've just introduced times when no client is competing", and "Full Jitter" (`sleep = random(0, min(cap, base·2^attempt))`) wins his simulation (VERIFIED via WebFetch, which paraphrases).

## Mapping to the issues and to sustaining effects

Huang et al. distinguish two trigger kinds: a **load-spike trigger** and a **capacity-decreasing trigger**. Their sustaining effect is "a feedback loop that keeps the system in an overloaded state … even after the trigger is removed". Retries are "by far, the most common sustaining effect … affecting more than 50% of the studied incidents" (VERIFIED, pypdf).

Bronson et al.: the root cause is "the sustaining feedback loop, rather than the trigger". The remedies are to "disable failover and retries or set a retry budget", with the caveat that "a major challenge with adaptive policies is coordination, as retry and failover decisions are made by each client" (VERIFIED, pypdf).

For Orchestra I map the terms as follows (INFERRED):
- **Capacity** is one host's CPU/RAM, CLI init throughput, and one account's rate limit.
- **Load** is concurrent session boots and turns.
- The **clients** are the 17 loops above, each deciding alone.

| Issue | Trigger (Huang type) | Sustaining effect / amplification | Bound shipped | Residual on master |
|---|---|---|---|---|
| [#174 — 5/6 burst spawns never start their first turn](https://github.com/lcsmas/orchestra/issues/174) | Burst of 6 boots (load spike) | Wake latch plus a "still live" refusal: the session stays dead, a capacity loss, not amplification | L7 heal | No boot admission (L3); the heal itself re-bursts (rig 2) |
| [#176 — root-cause the metarepo init hang](https://github.com/lcsmas/orchestra/issues/176) | Same | Root cause = the startup `getContextUsage()` seed, fixed v0.5.290 (per the leads doc; not re-read) | Cure | Burst sensitivity of CLI init is not re-measured |
| [#197 — boot-wedge self-heal loops forever](https://github.com/lcsmas/orchestra/issues/197) | Heavy init (16.5 MB transcript) wedges every fresh CLI (capacity decrease) | **Workload amplification**: heal → fresh boot → wedge → heal, every ~75 s, "recovered ONLY by deleting the workspace" | 3 fresh starts, then escalate (L7) | Watchdog path only. L8 external restarts are uncounted; the counter resets on app restart |
| [#97 — watchdog anti-flap limit has no surface and no backoff](https://github.com/lcsmas/orchestra/issues/97) | Session re-wedges on recycle | Budget spent in 3 consecutive ticks ("burst limiter that front-loads the damage") | 2 → 4-min backoff + one toast (L6) | No jitter; per workspace only |
| [#179 — endless "agent is working" refusal loop on a never-started session](https://github.com/lcsmas/orchestra/issues/179) | Promote on a boot-wedged session | Refusal retried every ~27 s; its kills pushed the session out of the heal path (two healers fighting) | `fresh` guard + one-shot reparent (L8/L9) | "One owner per wedge" holds for reparent, not for `orchestra restart` |
| [#162 — identical wake orders pile up behind a long turn](https://github.com/lcsmas/orchestra/issues/162) | Ack mid-turn + new mail | Duplicate queued turns | Coalescing (L5) | — |
| [#168 — a sender's own broadcast wakes itself, forever](https://github.com/lcsmas/orchestra/issues/168) | Agent protocol "status after each wake" | **Self-loop**: own broadcast → wake → status → broadcast, ≥ 8 cycles | Predicate fix (sender excluded) | No per-reader wake budget would catch a new loop of the same shape |
| [#185 — stale dead-run mail causes a permanent 5-min wake storm](https://github.com/lcsmas/orchestra/issues/185) | Dead-run mail | **Retry forever**: 5-min re-wake that no check could clear — Bronson's retry shape exactly | Re-fire only while un-acked (L1) | An un-acked lot whose reader never acks is still re-woken every 5 min forever (lineage: poison lot) |
| [#187 — deleting the asker must expire its open asks and gates](https://github.com/lcsmas/orchestra/issues/187) | Asker deleted | Eternal pending: the seed of #185 | Expire on delete | — |

Recurrence count of the class (evidence rule): the 9 issues above were filed between 2026-08-25 and 2026-09-28. Four are storms (#162 #168 #185 #187) and five are heal/burst loops (#97 #174 #176 #179 #197). Every one was found in the field, none by a test (source: the leads doc's pain inventory, re-read). Each fix added a bound **to one loop**. Nothing bounds the loops together, which is the gap Bronson's "coordination" point names. Google SRE gives the layered version: "If multiple layers retried, we'd have a combinatorial explosion" (VERIFIED via WebFetch). Orchestra stacks four retry layers: the CLI's API retries (L17), the watchdog (L6/L7), the re-wake (L1), and LLM agents re-sending or restarting (L8). INFERRED.

## Candidate GO specs for #296 (each with its must-FAIL arm)

1. **Full jitter on the fixed intervals** (L1 `REWAKE_BOUND_MS`, L6/L7 backoff, L11, L12). S.
   - Must-FAIL: rig 1 arms A/C and rig 2 arm A2 must report SPREAD. They report LOCKSTEP on master today.
   - Must-PASS: rig 1 arm B stays SPREAD, and a reader that acks is never double-fired within the bound (the existing healthy-cycle arm).
2. **Fleet boot admission**: at most K concurrent session boots, shared by the startup sweep (L1/L3), the watchdog (L6/L7) and spawns. S–M.
   - Must-FAIL: with N pending cold readers at app start, count the concurrent CLI boots. INFERRED to be N on master; not measured.
   - K comes from the boot distribution in [`issue-176-init-hang.md`](issue-176-init-hang.md).
3. **One boot-restart ledger for all restarters** (L8 feeds L7's counter, persisted, so an app restart does not reset it). S.
   - Must-FAIL: call `/restart` N+1 times on a never-started session → N+1 fresh starts and no escalation on master (code read; not run).
4. **Auto-resume failure must not block the queue** (L10): a failed wake gets per-workspace backoff and does not spend the 3-per-tick budget. S.
   - Must-FAIL: 3 coordinators whose wake always fails plus 1 member → the member is never resumed on master (INFERRED from `prompt-queue.ts:263`; not run).
5. **A fleet-wide token bucket** over wake fires and restarts, escalating once when empty (leads doc lead 5). M. This is the general form of 1-4. Decide it after 1-3 show how much is left.

## VERIFIED

- **Code**, on `origin/master@743f9ab0` (`git rev-list --count HEAD..origin/master` = 0 at start), via `git show`/`git grep`. Every table anchor was re-read this session:
  - `session-wedge.ts` 104/224/269-275/367-427/531-563/620-648
  - `session-watchdog.ts` 134/145/152/181/541-827
  - `bus-wake.ts` (shared) 213-260/432-435/496-638/731
  - `bus-wake.ts` (main) 58/63/234/243/651-862/968-990
  - `wake-roster.ts` 12-35; `opening-task.ts` 20-44
  - `sdk-delivery.ts` 148-172; `agent-sdk.ts` 533-547/3473-3480/5141-5196/6047
  - `restart-workspace.ts` 63-133; `hooks-server.ts` 230-245; `workspaces.ts` 1485-1530/2000-2075
  - `prompt-queue.ts` 30-52/210-320; `usage-resume.ts` 154-176; `pause-trap.ts` 717-728; `pause-auto.ts` 30-45
  - `reconnect-policy.ts` 12-45; `keeper-client.ts` 646-668 and 803-860
  - `usage.ts` 160-200; `account-usage.ts` 36-43/280-350
  - `hibernation.ts` 135-198; `bus-liveness.ts` 44/271; `index.ts` 529-531
- **No jitter / no CLI retry env.** `git grep` for `Math.random|randomInt|crypto.random` (non-test `src`) and for `CLAUDE_CODE_MAX_RETRIES|CLAUDE_CODE_RETRY_WATCHDOG|API_TIMEOUT_MS` (`src`, `scripts`). No retry/backoff in `scripts/release*.sh` or `.github`.
- **Both lock-step rigs**, run this session under node v22.22.0 on byte copies of master's pure modules. Each has a control arm that reports SPREAD. A per-reader-offset mutant of `boundedReArmed` flips rig 1 to SPREAD. Output is quoted above, and the appendix source was re-run as published.
- **Issue bodies** of #97 #162 #168 #174 #176 #179 #185 #187 #197, via `gh issue list --json` (274 issues).
- **Papers**, PDFs extracted with pypdf and grepped for the quoted sentences: Bronson et al. HotOS'21 (definition, §2.1 retry case, §3 "Trigger vs. Root Cause" and "Change of Policy during Overload"); Huang et al. OSDI'22 (§2 "more than 50%" retries, §3.2 Definition 1, Definitions 3-4).
- **Web pages via WebFetch** (paraphrases through a small model, so quotes are near-verbatim): Brooker "Exponential Backoff And Jitter"; Google SRE "Handling Overload" (retry budgets, single-layer retry); Claude Code env-vars page (`CLAUDE_CODE_MAX_RETRIES` default 10, `CLAUDE_CODE_RETRY_WATCHDOG`).

## NOT VERIFIED

- **Nothing was run in the real app.** Both rigs replay pure decisions on an injected clock. Not measured:
  - concurrent CLI boots at the startup sweep (L3);
  - the back-to-back recycle burst inside one watchdog tick;
  - the hibernation ↔ re-wake cycle (L4).
- **Who drove the #197 ~75-s loop** (a coordinator's `orchestra restart`, or something else). The issue body does not name the caller.
- **L2's steady state** (about 3 failed starts per ~10 min) and **L10's head-of-line block**: inferred from code, no arm run.
- **That counters reset on app restart and grant fresh budgets** (L6/L7, liveness): inferred from the in-memory `Map`s, not exercised.
- **The Claude CLI's own retry backoff and jitter**, and whether CLI retries ever ran in the field incidents.
- **#176's fix** (v0.5.290 `getContextUsage` seed): cited from the leads doc, not re-read.
- **Cost estimates S/M** are judgement.
- **Brooker's decorrelated-jitter formula**: WebFetch returned a garbled version, so only Full Jitter is quoted.

## Appendix: rig 1 source (rig 2 is the same harness over `session-wedge.ts`)

```ts
// node --experimental-strip-types wake-sync.ts, next to ./src/bus-wake.ts = git show origin/master:src/shared/bus-wake.ts
import { decideWake, type WakeLedgerEntry } from './src/bus-wake.ts';
const SWEEP_MS = 60_000, HORIZON = 30 * 60_000;
function run(label: string, arrivalsMs: number[]): void {
  const ledger = new Map<string, WakeLedgerEntry>(), fires = new Map<string, number[]>();
  const readers = arrivalsMs.map((_, i) => `r${i}`), sweeps = new Set<number>(arrivalsMs);
  for (let t = 0; t <= HORIZON; t += SWEEP_MS) sweeps.add(t);
  for (const now of [...sweeps].sort((x, y) => x - y)) readers.forEach((reader, i) => {
    if (now < arrivalsMs[i]) return;
    const p = { reader, pending: true, pendingThroughSeq: 10 + i, unackedThroughSeq: 10 + i, pendingRunId: 'run', cursorSeq: 0 } as any;
    const a = decideWake(p, { wakeable: true }, ledger.get(reader), true, false, undefined, now);
    if (a.kind !== 'fire') return;
    ledger.set(reader, { wokeLotSeq: a.lotSeq, wokeGateSeq: a.gateSeq, wokeRunId: a.wokeRunId, lastWakeAt: a.lastWakeAt, wokeGeneration: a.wokeGeneration });
    (fires.get(reader) ?? fires.set(reader, []).get(reader)!).push(now / 1000);
  });
  const rounds = Math.min(...[...fires.values()].map((f) => f.length));
  const d = Array.from({ length: rounds }, (_, k) => new Set([...fires.values()].map((f) => f[k])).size);
  console.log(label, d.join(' '), d[d.length - 1] === 1 ? 'LOCKSTEP' : 'SPREAD');
}
run('A', [5e3, 15e3, 25e3, 35e3, 45e3]); run('B control', [5e3, 75e3, 145e3, 215e3, 285e3]); run('C startup', [0, 0, 0, 0, 0]);
```

Rig 2 loops `now` over 60-s ticks. On each tick, for each workspace, it calls:
1. `decideBootWedge({sessionLive:true, firstMessageSeen:false, turnInFlight:true, pendingPromptCount:1, lastStreamAt, now, silenceMs:BOOT_SILENCE_MS})`;
2. `decideSessionRecycle({…, stalled: bootWedge, silenceMs: BOOT_SILENCE_MS, recentRecycles: ledger})`;
3. `decideBootHeal({consecutiveFreshStarts})`.

On `recycle` it pushes `now` to the ledger, increments the counter, and sets `lastStreamAt = now`. This is the order used by `src/main/session-watchdog.ts:669-806`.
