# Distributed-systems results that would concretely improve Orchestra

Written 2026-10-05. Code anchors are `path:line` on **`origin/master` @ `e7aedd79`**. This branch is 55 commits behind that, so the relative links open the file but the line numbers come from origin/master.

Not repeated here, only referenced:
- [`sota-multi-agent-orchestration.md`](sota-multi-agent-orchestration.md): LLM multi-agent literature, LLM reviewers, mutation testing, and merge queues (§8: GitHub merge queue, bors, TAP, SubmitQueue).
- [`orca-model-lineage.md`](orca-model-lineage.md): poison-lot bound, side-effect fencing, `dcap_` tokens, byte quotas, idempotency, OTP restart intensity, circuit breaker, coordinator state reconstruction (Temporal), outbox projection, and Gray & Cheriton leases.

Tags: **VERIFIED** means the primary text was fetched and read this session (PDFs extracted with `pypdf`, then grepped). **UNVERIFIED** means it was not read. **INFERRED** marks my reasoning, never a citation.

## Question

Which results from distributed-systems research and industrial literature would concretely improve Orchestra? Each one is mapped to defects Orchestra has actually hit.

## Short answer

1. **The wake/ack/fencing protocol is the top defect generator**: 18 issues across wake starvation, wake storms and stale identity. Two fixes target it. First, move the wake engine's in-memory dedup ledgers into the bus, so the sweep is truly level-triggered (Kubernetes controller pattern, epoll(7), Saltzer's end-to-end argument). Second, model-check the protocol with TLA+, or start with fast-check model-based tests (AWS, CACM 2015).
2. **Crash- and alias-consistent file updates** (Pillai et al., OSDI 2014; rename(2)) target 9 file/store issues, some of which destroyed user data. A dev+inode helper already exists (`same-dir.ts`), yet `moveWorkspaceTranscripts` still compares strings on master, so #240 is still live.
3. **Measure every elapsed-time decision on a monotonic clock, and detect clock steps and suspend**: clock_gettime(2), Node `hrtime`, Electron `powerMonitor`. All timers today run on `Date.now()`. The machine stepped its clock by 2 h twice in September. This is the cheapest lead.

## Pain inventory

Source: `gh issue list -R lcsmas/orchestra --state all --limit 300` (243 issues), titles and bodies read. Only DEFECT issues are counted; ledgers, features and research tickets are excluded. Each issue is in exactly one class (62 issues).

| Defect class | Issues | Count | First → last filed | Still open |
|---|---|---|---|---|
| Wake starvation: a pending reader is never woken, or woken once then latched | [#144](https://github.com/lcsmas/orchestra/issues/144) short-handle mail never wakes · [#149](https://github.com/lcsmas/orchestra/issues/149) WAL watch rarely fires · [#150](https://github.com/lcsmas/orchestra/issues/150) woken-once for newer mail · [#153](https://github.com/lcsmas/orchestra/issues/153) OFF-sweep arms the real dedup ledger · [#158](https://github.com/lcsmas/orchestra/issues/158) cross-run gate never wakes · [#159](https://github.com/lcsmas/orchestra/issues/159) non-wakeable 19 min after restart · [#172](https://github.com/lcsmas/orchestra/issues/172) withdrawn wake still marked woken · [#183](https://github.com/lcsmas/orchestra/issues/183) latch held 4 h · [#200](https://github.com/lcsmas/orchestra/issues/200) stale cross-run ledger after restart | **9** | 09-15 → 09-28 | — |
| Wake/turn amplification (storms, self-loops) | [#162](https://github.com/lcsmas/orchestra/issues/162) identical wake orders pile up · [#168](https://github.com/lcsmas/orchestra/issues/168) own broadcast self-wake loop · [#185](https://github.com/lcsmas/orchestra/issues/185) permanent 5-min wake storm · [#187](https://github.com/lcsmas/orchestra/issues/187) orphaned asks seed the storm | **4** | 09-18 → 09-22 | — |
| Session/boot wedge and non-converging heal loops | [#90](https://github.com/lcsmas/orchestra/issues/90) turn-stall 35 min · [#97](https://github.com/lcsmas/orchestra/issues/97) watchdog anti-flap has no surface or backoff · [#174](https://github.com/lcsmas/orchestra/issues/174) 5/6 burst spawns never start · [#176](https://github.com/lcsmas/orchestra/issues/176) init hang under burst spawn · [#178](https://github.com/lcsmas/orchestra/issues/178) restart resumes a phantom conversation · [#179](https://github.com/lcsmas/orchestra/issues/179) endless "agent is working" refusal loop · [#180](https://github.com/lcsmas/orchestra/issues/180) boot-silence window sizing · [#197](https://github.com/lcsmas/orchestra/issues/197) boot-wedge self-heal loops forever · [#227](https://github.com/lcsmas/orchestra/issues/227) failed SDK start masked | **9** (+2 field incidents in operator notes, 2026-09-23 and 2026-09-28) | 08-25 → 09-29 | — |
| False liveness verdicts | [#160](https://github.com/lcsmas/orchestra/issues/160) finished member escalated · [#199](https://github.com/lcsmas/orchestra/issues/199) false "hung mid-call", 7× in one wave · [#204](https://github.com/lcsmas/orchestra/issues/204) promoted OPS never released · [#236](https://github.com/lcsmas/orchestra/issues/236) fresh spawn "silent since app start" | **4** | 09-18 → 09-30 | — |
| Stale identity/epoch across restart, reparent, promote | [#142](https://github.com/lcsmas/orchestra/issues/142) re-parented workspace keeps stale run id · [#166](https://github.com/lcsmas/orchestra/issues/166) generation never bumped · [#167](https://github.com/lcsmas/orchestra/issues/167) re-dispatch supersedes the token mid-task (the #164 "doom loop") · [#171](https://github.com/lcsmas/orchestra/issues/171) promote does not propagate run id · [#222](https://github.com/lcsmas/orchestra/issues/222) fencing locks members out after coordinator restart | **5** | 09-15 → 09-29 | — |
| Silent acceptance: rc 0 or a missing row read as a default, doing nothing | [#59](https://github.com/lcsmas/orchestra/issues/59) verify-landed exits 0 on NOT LANDED · [#134](https://github.com/lcsmas/orchestra/issues/134) no run row, so every switch reads OFF · [#155](https://github.com/lcsmas/orchestra/issues/155) send accepts an unknown run_id · [#175](https://github.com/lcsmas/orchestra/issues/175) send outside the run delivers to nobody · [#182](https://github.com/lcsmas/orchestra/issues/182) "frozen" all-OFF for a run-less workspace · [#206](https://github.com/lcsmas/orchestra/issues/206) missing row read as OFF · [#277](https://github.com/lcsmas/orchestra/issues/277) unknown `--option` sent as message text | **7** | 08-25 → 10-04 | — |
| Message loss/duplication on the pre-bus channel | [#57](https://github.com/lcsmas/orchestra/issues/57) redelivers consumed prompts AND drops others · [#91](https://github.com/lcsmas/orchestra/issues/91) delivered messages shown as held · [#112](https://github.com/lcsmas/orchestra/issues/112) spawn prompt "lost to a quit" | **3** (moved to the bus by [#108](https://github.com/lcsmas/orchestra/issues/108) — local SQLite bus vs GitHub ledger) | 08-24 → 09-07 | — |
| File and store consistency (torn reads/appends, aliasing, lost update) | [#28](https://github.com/lcsmas/orchestra/issues/28) + [#37](https://github.com/lcsmas/orchestra/issues/37) spool torn appends (flaky) · [#93](https://github.com/lcsmas/orchestra/issues/93) concurrent inbox appends splice · [#205](https://github.com/lcsmas/orchestra/issues/205) deleted workspace resurrected · [#235](https://github.com/lcsmas/orchestra/issues/235) sync strips a live config dir · [#238](https://github.com/lcsmas/orchestra/issues/238) torn read rewrites `.claude.json` as `{}` · [#239](https://github.com/lcsmas/orchestra/issues/239) settings self-loop · [#240](https://github.com/lcsmas/orchestra/issues/240) migration deletes transcripts on an aliased dir · [#241](https://github.com/lcsmas/orchestra/issues/241) unlink through an aliased entry | **9** | 08-24 → 09-30 | #240 |
| Process lifecycle/orphans | [#124](https://github.com/lcsmas/orchestra/issues/124) keeper stop→restart seam · [#201](https://github.com/lcsmas/orchestra/issues/201) delete must stop CLI + keeper · [#202](https://github.com/lcsmas/orchestra/issues/202) one keeper per workspace · [#203](https://github.com/lcsmas/orchestra/issues/203) reap orphaned keepers · [#242](https://github.com/lcsmas/orchestra/issues/242) double-forked MCP survives delete | **5** | 09-14 → 09-30 | #242 |
| Resource exhaustion/blocking | [#87](https://github.com/lcsmas/orchestra/issues/87) /tmp ENOSPC looked like a code defect · [#96](https://github.com/lcsmas/orchestra/issues/96) sync `statfs` on the main process · [#215](https://github.com/lcsmas/orchestra/issues/215) idle panes do per-frame work | **3** (+ 2026-09-28 machine freeze, probable RAM exhaustion, unproven, operator notes) | 08-25 → 09-29 | #215 |
| Integration: green alone, red on master, release race | [#71](https://github.com/lcsmas/orchestra/issues/71) smoke check red on master · [#78](https://github.com/lcsmas/orchestra/issues/78) tag-vs-master race, 3 consecutive ships · [#101](https://github.com/lcsmas/orchestra/issues/101) 5 merged features never driven together · [#223](https://github.com/lcsmas/orchestra/issues/223) rig rot on master | **4** (+ open process issues [#263](https://github.com/lcsmas/orchestra/issues/263) scripted parallel gate queue and [#265](https://github.com/lcsmas/orchestra/issues/265) gate calibration report) | 08-25 → 09-29 | #101 |
| Wall-clock steps | none in the tracker | **0 issues**, 2 field incidents (operator notes: 2026-09-23 bloc2 wedge, 2026-09-28 post-reboot; RTC read as local time, so the clock was +2 h and chrony then stepped it back) | — | — |

Reading the table: the bus protocol (rows 1, 2 and 5) produced **18** issues in **15 days** (09-15 → 09-29). Each was found in the field after a canary, and each needed its own fix wave. The pattern is a state machine whose invariants nobody had written down.

## Leads, ranked by value / cost

Cost: S ≤ 2 days, M ≈ 1–2 weeks, L > 2 weeks (INFERRED estimates). "Would have prevented" is INFERRED from the issue mechanism; none of these was tested against the old binaries.

| # | Lead | Defect class | Primary source | In Orchestra? (origin/master) | Cost | Why it would have prevented which issue |
|---|---|---|---|---|---|---|
| 1 | **Monotonic clock for every elapsed-time decision, plus step and suspend detection** | Clock steps; latent in every timer | [clock_gettime(2)](https://man7.org/linux/man-pages/man2/clock_gettime.2.html), [Node `process.hrtime`](https://nodejs.org/api/process.html), [Electron powerMonitor](https://www.electronjs.org/docs/latest/api/power-monitor) — VERIFIED | **NO.** All timers use `Date.now()`. The choice is deliberate: [`src/shared/bus-wake.ts:213`](../../src/shared/bus-wake.ts) "Wall-clock, not a strict monotonic source". The only clamp is one field: [`src/main/idle-clock.ts:12`](../../src/main/idle-clock.ts). No `powerMonitor` use | S | A stamp taken during the +2 h window reads as "future" after chrony steps back. Every `now − stamp` (re-wake bound, liveness silence, keeper linger/wedge [`src/keeper/index.ts:317`](../../src/keeper/index.ts)) then stays negative for up to 2 h. That is the #183 latch shape, caused by the clock (INFERRED from code) |
| 2 | **Crash- and alias-consistent file protocol**: one atomic-write helper (tmp, fsync, rename, dir fsync); identity by dev+inode; compare-and-set on store records | File/store (9) | [Pillai et al., OSDI 2014](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-pillai.pdf), [rename(2)](https://man7.org/linux/man-pages/man2/rename.2.html) — VERIFIED | **PARTIAL.** tmp+rename for `store.json` ([`src/main/store.ts:199`](../../src/main/store.ts), no fsync) and `.claude.json` (fsync + rename, [`src/main/account-inherit.ts:472`](../../src/main/account-inherit.ts), [`:499`](../../src/main/account-inherit.ts)). Written in place: bus-switches ([`workspaces.ts:5622`](../../src/main/workspaces.ts)), account manifest ([`account-inherit.ts:118`](../../src/main/account-inherit.ts)), inbox tray, usage, secrets. No directory fsync anywhere. The dev+inode helper exists ([`src/main/same-dir.ts:19`](../../src/main/same-dir.ts)), but [`workspaces.ts:2847`](../../src/main/workspaces.ts) still does `if (srcConfigDir === dstConfigDir)`. Store: no record version; tombstones are per-run in memory ([`store.ts:263`](../../src/main/store.ts)) | S | One helper used everywhere closes #238 (torn read → `{}`), #240 (string compare → transcripts deleted; fix branch `migrate-transcripts-same-dir-c13` @`cba1416b` is NOT an ancestor of master), #241 and #239 (aliases), and #205 (CAS rejects a stale whole-record upsert) |
| 3 | **Make the wake engine truly level-triggered**: derive "already served" from durable bus facts (cursor + a persisted wake attempt with `turn_started_at`), never from in-memory ledgers | Wake starvation (9), storms (4) | [Kubernetes controller pattern](https://kubernetes.io/docs/concepts/architecture/controller/), [epoll(7) ET vs LT](https://man7.org/linux/man-pages/man7/epoll.7.html), [Saltzer, Reed, Clark 1984](https://web.mit.edu/Saltzer/www/publications/endtoend/endtoend.pdf) — VERIFIED | **PARTIAL.** The sweep reads durable state ([`src/main/bus-wake.ts:13`](../../src/main/bus-wake.ts) "LEVEL-TRIGGERED over durable state"), but the dedup ledgers are in-memory `Map`s ([`bus-wake.ts:234`](../../src/main/bus-wake.ts) fire, [`:243`](../../src/main/bus-wake.ts) count). They carry `wokeThroughSeq`/`wokeRunId`/`lastWakeAt`, and the backstop is a fixed 5-min re-fire ([`src/shared/bus-wake.ts:434`](../../src/shared/bus-wake.ts)). The bus has no wake table ([`bus.ts:175-508`](../../src/main/bus.ts)). Pending and lot reads now share one predicate ([`bus.ts:690`](../../src/main/bus.ts) `ownRunRecipientSql`, from #185) | M | #150, #153, #159, #172, #183 and #200 are each a ledger entry that outlived the fact that justified it, or was lost on restart. A served-state derived from cursor + turn-started removes the class |
| 4 | **Model-check the delivery/wake/ack/gate/fencing protocol**: TLA+, or fast-check model-based tests as step 1 | Starvation, storms, identity (18) | [Newcombe et al., "How AWS uses formal methods", CACM 2015](https://lamport.azurewebsites.net/tla/formal-methods-amazon.pdf), [fast-check model-based testing](https://fast-check.dev/docs/advanced/model-based-testing/) — VERIFIED. [Brooker & Desai, CACM 2025 (P language)](https://dl.acm.org/doi/10.1145/3729175) — UNVERIFIED (403) | **NO.** No `*.tla`/`*.p`/`*.als` in the tree; no fast-check in `package.json`. Good seams exist: `decideWake` is pure with injected `now`, `__setNowForTests` ([`bus-wake.ts:637`](../../src/main/bus-wake.ts)), `fakeClock` ([`bus-wake-sweep.test.ts:764`](../../src/main/bus-wake-sweep.test.ts)) | M | Each issue is a short counterexample to a property nobody stated. Some examples: "own broadcast never pends for its sender" (#168); "a wake names a check that returns its rows" (#185); "a member write is never fenced by the coordinator generation" (#222); "pending ⇒ eventually turn-started or escalated" (#150/#172/#183/#174) |
| 5 | **Metastability guards**: fleet-wide retry/wake budget, jitter, burst-spawn admission, memory-pressure gate | Storms (4), heal loops (#97 #179 #197), burst wedge (#174 #176), RAM freeze | [Bronson et al., HotOS 2021](https://sigops.org/s/conferences/hotos/2021/papers/hotos21-s11-bronson.pdf), [Huang et al., OSDI 2022](https://www.usenix.org/system/files/osdi22-huang-lexiang.pdf), [Google SRE "Handling Overload"](https://sre.google/sre-book/handling-overload/), [Brooker, backoff + jitter](https://aws.amazon.com/blogs/architecture/exponential-backoff-and-jitter/), [SEDA, SOSP 2001](https://www.sosp.org/2001/papers/welsh.pdf), [PSI](https://docs.kernel.org/accounting/psi.html) — VERIFIED | **PARTIAL.** Per-workspace exponential recycle backoff ([`src/shared/session-wedge.ts:281`](../../src/shared/session-wedge.ts), 3/h at [`:224`](../../src/shared/session-wedge.ts)). `MAX_BOOT_RESTARTS = 3` with no backoff ([`:620`](../../src/shared/session-wedge.ts)). Fixed `REWAKE_BOUND_MS` ([`bus-wake.ts:260`](../../src/shared/bus-wake.ts)). No jitter anywhere. The only fleet-wide cap is auto-resume ([`prompt-queue.ts:52`](../../src/main/prompt-queue.ts)). Spawn is single-flight per workspace only ([`keeper-client.ts:277`](../../src/main/keeper-client.ts)). Memory is logged, never gated ([`resource-monitor.ts:124`](../../src/main/resource-monitor.ts)); no PSI | S–M | A fleet budget turns #185's 5-min-forever storm, #197's 45/34/37-per-day restart loop and #179's 27-s retry loop into one escalation. A boot admission limit addresses #174's 5/6 burst deaths (residual risk only: #176's root cause, the `getContextUsage` seed, is fixed) |
| 6 | **Two-stage failure detection**: suspect on a timeout, then confirm with a definitive host probe (or kill the smallest unit) before escalating | False liveness (4); gray failure #90 | [Falcon, SOSP 2011](https://www.cs.utexas.edu/~mwalfish/papers/falcon-sosp11.pdf), [SWIM, DSN 2002](https://www.cs.cornell.edu/projects/Quicksilver/public_pdfs/SWIM.pdf), [φ accrual (JAIST TR, 2004)](https://dspace.jaist.ac.jp/dspace/bitstream/10119/4784/1/IS-RR-2004-010.pdf), [Chandra & Toueg, JACM 1996](https://www.cs.utexas.edu/~lorenzo/corsi/cs380d/papers/p225-chandra.pdf), [Gray failure, HotOS 2017](https://www.microsoft.com/en-us/research/wp-content/uploads/2017/06/paper-1.pdf) — VERIFIED | **PARTIAL.** Verdicts are gated on progress, not just idle time ([`src/shared/bus-liveness.ts:27`](../../src/shared/bus-liveness.ts)), but thresholds are fixed ([`:37`](../../src/shared/bus-liveness.ts) 10 min, [`:81`](../../src/shared/bus-liveness.ts) 600 s Bash). The liveness verdict "adds NO new probe" ([`src/main/bus-liveness.ts:12`](../../src/main/bus-liveness.ts)), while keeper code already has identity probes (`/proc/<pid>/stat`, [`keeper-client.ts:341`](../../src/main/keeper-client.ts), `kill(pid,0)` [`:638`](../../src/main/keeper-client.ts)) | M | #199: a `/proc` check that the Bash child still exists would have refuted "hung mid-call" (the member reported done 5 s later). #160/#204/#236: the confirm stage is task state or `createdAt`, not silence |
| 7 | **Audit error handlers for the "simple testing" patterns** (empty or log-only catch; a missing row read as a default) | Silent acceptance (7) | [Yuan et al., OSDI 2014](https://www.usenix.org/system/files/conference/osdi14/osdi14-paper-yuan.pdf) — VERIFIED | **Not done.** Of 528 `catch` blocks in non-test `src/{main,shared,keeper,cli}`, 125 are empty or comment-only and 58 only log (my scan this session). That count says the pattern exists, not that it causes harm: many are legitimate best-effort cleanup | S | #134/#206/#182 (missing row read as OFF) and #155/#175/#277 (accepted, did nothing) are exactly Yuan's "error handled by ignoring it" class |
| 8 | **One correlation id per message**, logged at send, wake, turn, check and ack | Diagnosis cost of every bus defect | [Dapper, Google TR 2010](https://static.googleusercontent.com/media/research.google.com/en//archive/papers/dapper-2010-1.pdf) — VERIFIED | **PARTIAL.** Per-session logs exist (#177, [`src/main/session-debug-log-fs.ts:29`](../../src/main/session-debug-log-fs.ts)); the wake log carries only a per-reader high-water seq ([`bus-wake.ts:840`](../../src/main/bus-wake.ts)); there is no trace id | S–M | #200's misleading "through seq 15", and the #172 credit ("2 log greps instead of 40 minutes"), show what tracing buys. A per-message id makes that the default |
| 9 | **Crash-only session lifecycle and cgroup containment**: stop = kill the tree by identity; start = recover from the transcript; one cgroup per workspace, killed via `cgroup.kill` | Process lifecycle (5); #178 #179; unbounded `interrupt()` teardown | [Candea & Fox, HotOS 2003](https://www.usenix.org/legacy/events/hotos03/tech/full_papers/candea/candea.pdf), [cgroup v2 `cgroup.kill`](https://docs.kernel.org/admin-guide/cgroup-v2.html) — VERIFIED | **PARTIAL.** Single-flight keeper, reaper and identity kills exist (#201-#203). No cgroup or `systemd-run` anywhere in `src/` (grep); keepers are spawned `detached: true` ([`keeper-client.ts:656`](../../src/main/keeper-client.ts)) | M | #242: a double-forked MCP reparented to init escapes a ppid sweep but cannot leave its cgroup. #179's refusal ("agent is working — interrupt first") cannot exist when stop = crash |
| 10 | **Deterministic simulation of the fleet host**: seeded scheduler, clock, bus, fake CLI, fault injection, invariant checkers | Cross-feature interactions (#174 double lock, #179 vs heal path, #101) | [FoundationDB, SIGMOD 2021](https://www.foundationdb.org/files/fdb-paper.pdf), [FDB testing docs](https://apple.github.io/foundationdb/testing.html), [TigerBeetle VOPR](https://github.com/tigerbeetle/tigerbeetle/blob/main/docs/internals/vopr.md), checker: [Elle, arXiv 2020](https://arxiv.org/abs/2003.10554) — VERIFIED | **PARTIAL seams.** Pure shared modules with injected `now`; scenario rigs (`scripts/verify-bus-contention.mjs`, `scripts/wedge90-rigs/`); local fake API ([`session-budget.md`](../codebase-map/session-budget.md)). No seeded scheduler or random fault schedule | L | #174 needed boot wedge + wake latch + recovery refusal together. Random fault schedules over one deterministic host find such conjunctions; scenario rigs only test the ones someone already imagined |
| 11 | Test the **combined tip** of candidates (merge queue) | Integration (4) | See SOTA §8 (SubmitQueue, bors, TAP) | **NO** combined-tip or bisect script in `scripts/` (grep). The release gate refuses red ([`scripts/release.sh:402`](../../scripts/release.sh)) | M | #101 and #223; already scoped in [#263](https://github.com/lcsmas/orchestra/issues/263) — scripted parallel gate queue |
| 12 | Durable-execution recovery of a coordinator | Wedge recovery | See orca-model-lineage (Temporal) | Partial (see that doc) | L | Not re-argued here |

Considered and dropped (no matching defect in the inventory): **CRDTs/local-first** (no shared-UI-state divergence issue was filed); **hedged/tied requests** ([The Tail at Scale, CACM 2013](https://www.barroso.org/publications/TheTailAtScale.pdf), VERIFIED) — the one latency defect, #149, was a broken watcher, not a tail, and hedging a session start would double token spend.

## Top-5 leads

### 1. Monotonic elapsed time and clock-step detection (S)

**Source.** clock_gettime(2): `CLOCK_REALTIME` "is affected by discontinuous jumps in the system time". `CLOCK_MONOTONIC` "is not affected by discontinuous jumps … This clock does not count time that the system is suspended". `CLOCK_BOOTTIME` is "identical to CLOCK_MONOTONIC, except that it also includes any time that the system is suspended". Node `process.hrtime` times "are relative to an arbitrary time in the past, and not related to the time of day and therefore not subject to clock drift". Electron `powerMonitor` emits `suspend`/`resume`. Gray & Cheriton's lease analysis carries an explicit "allowance ε for clock skew" term (VERIFIED, OCR-garbled TR). All VERIFIED.

**Orchestra today.** Wall clock everywhere. The agent counted `Date.now()` uses: keeper 7, session-watchdog 5, hibernation-activity 5, bus-wake main 3, and so on. The comment at [`src/shared/bus-wake.ts:213`](../../src/shared/bus-wake.ts) argues that a backward jump "merely DELAYS a re-wake … self-correcting". With the field's 2 h step, the delay is 2 h, and the 4 h latch was filed as a P1 (#183). The keeper's lock-staleness test compares wall clock with a file mtime ([`src/keeper/index.ts:436`](../../src/keeper/index.ts)): after a backward step a dead holder's lock reads as fresh, and after a forward step a live one reads as stale (INFERRED).

**Do.** Keep wall-clock stamps for display and persistence. Compute every *decision* from in-process monotonic deltas. Once per tick, compare the `Date.now()` delta with the `hrtime` delta; on a step (or a powerMonitor `resume`), log it once and re-base the in-memory "since" stamps. `hrtime` origins are per process, so never compare monotonic values across the app/keeper/CLI boundary (INFERRED from the Node doc's "arbitrary time in the past").

**Caveat.** The 2026-09-23 notes say the *CLI* hung after the step and the cause is UNEXPLAINED. Orchestra's own exposure is a code-read inference; no arm reproduced it.

### 2. Crash- and alias-consistent file protocol (S)

**Source.** Pillai et al. analysed 11 widely used systems and found "a total of 60 vulnerabilities". Correctness depends on "the atomicity of operations (e.g., does the file system ensure that rename() is atomic?)" and on ordering. For 7 of 11 applications, expected durability is not met, "often due to directory operations not being flushed". rename(2): an existing newpath "will be atomically replaced, so that there is no point at which another process attempting to access newpath will find it missing". VERIFIED.

**Two different properties** (INFERRED synthesis):
- **Visibility atomicity** against concurrent readers needs only tmp + rename. This is what #238 needed: the CLI writes `.claude.json` by tmp+rename, so a reader never sees a torn file if *every* writer renames.
- **Crash durability** additionally needs fsync of the file before rename and fsync of the directory after.

**Orchestra today.** See row 2: the helpers exist but are applied per call site. The #240 fix is still unmerged (`git merge-base --is-ancestor origin/migrate-transcripts-same-dir-c13 origin/master` → not an ancestor), and master still compares strings at [`workspaces.ts:2847`](../../src/main/workspaces.ts). #205's tombstone set lives in memory for one run ([`store.ts:263`](../../src/main/store.ts)). That holds only while every racing writer is in the same process (INFERRED).

**Do.**
- Add one `atomicWriteFile(path, bytes, {durable})` and route every persisted file through it (grep for `writeFile(` in `src/main`).
- Add one `sameEntity(a, b)` (dev+inode, the existing `same-dir.ts`) and use it for every same-dir decision before a destructive act.
- Add a `rev` field on workspace records, so `upsertWorkspace` refuses a patch built from an older rev. This is optimistic concurrency (INFERRED design).

### 3. A truly level-triggered wake engine (M)

**Source.**
- epoll(7) describes an edge-triggered reader that "will probably hang despite the available data still present in the file input buffer". That is the #150 shape exactly: "woken-once … the eternal-sleep case #117 was built to kill, reintroduced one layer up".
- Kubernetes: a controller "tries to move the current cluster state closer to the desired state", recomputed from the objects, not from remembered events.
- Saltzer, Reed, Clark: delivery acknowledgement "can completely and correctly be implemented only with the knowledge and help of the application standing at the end points".

All VERIFIED.

**Orchestra today.** The engine reads the bus each sweep, but the decision to skip comes from in-memory ledgers (`already-woken`). Six of the nine starvation issues are ledger lifetime bugs:
- #150: the entry survives new mail.
- #153: the OFF sweep writes the real ledger.
- #159 / #200: lost or stale across restart.
- #172: marked at fire, not at turn start; this is the end-to-end violation the #57 lesson already named.
- #183: held for 4 h.

The fixes added patches (rollback on withdrawal, a 5-min bound, generation re-arm). Each patch is another ledger rule.

**Do.**
- Persist one row per wake attempt (`reader, run, through_seq, fired_at, turn_started_at`) in the bus.
- Define "served through N" as a *durable* fact: the cursor advanced past N, or a wake whose turn started is still within its bound.
- Each sweep computes `pending ∧ ¬served` from SQL alone, so a restart changes nothing.
- The re-wake bound becomes "turn started and cursor did not move", measured on the monotonic clock (lead 1).

### 4. Model-check the bus protocol (M)

**Source.** Newcombe et al.: "we still find that subtle bugs can hide in complex concurrent fault-tolerant systems". TLA+ was used "on 10 large complex real-world systems. In every case TLA+ has added significant value, either finding subtle bugs that we are sure we would not have found by other means…". DynamoDB: "Found 3 bugs, some requiring traces of 35 steps". Engineers "learn TLA+ from scratch and get useful results in 2 to 3 weeks". fast-check's model-based testing defines "a set of commands that can be seen as potential actions" and compares the real system against a model. VERIFIED.

**Orchestra today.** No spec, no property-based library. The pure modules (`src/shared/bus-wake.ts`, `bus-liveness.ts`, `session-wedge.ts`) already take `now` as a parameter, which is the seam a model-based test needs.

**Do.** Step 1 (S): a fast-check command model over the pure `decideWake` + ledger, with these commands:
- `send` (own run, broadcast, cross-run)
- `sweep`
- `turnStart`, `withdraw`
- `ack`
- `restartApp`, `restartCoordinator`
- `reparent`
- clock advance

Then assert the invariants listed in row 4 after every step. Step 2 (M): a TLA+ spec of the same state, checked for liveness under fairness ("pending ⇒ ◇ turn-started ∨ escalated"), which example tests cannot express. The 18 field issues are the regression corpus: each must be a counterexample on its pre-fix rule.

### 5. Metastability guards (S–M)

**Source.**
- Bronson et al.: metastable failures occur when "a trigger causes the system to enter a bad state that persists even when the trigger is removed", with "a sustaining effect—often involving work amplification". An outage "is initially blamed on the trigger, but the true root cause is the sustaining effect". Remedies include "disable failover and retries or set a retry budget", "switch to LIFO", "shed load", and circuit breakers.
- Huang et al. studied 22 incidents in 11 organisations and name "retry storms" and "death spirals" as instances.
- SRE book: "a per-request retry budget of up to three attempts" and "a per-client retry budget … retried as long as this ratio is below 10%", which "reduces the growth to just 1.1x".
- Brooker: "The solution isn't to remove backoff. It's to add jitter."
- SEDA: bounded stages "preventing resources from being overcommitted when demand exceeds service capacity".
- PSI: `/proc/pressure/memory` with poll()-able triggers.

All VERIFIED.

**Orchestra today.** The sustaining effects are in the issues:
- #185: dead-run mail kept the wake pending, so a wake every 5 min forever.
- #168: own broadcast → wake → status → own broadcast.
- #197: a fresh CLI wedges again → restart, repeated (45 "no proof of life" / 34 restarts / 37 unanswered interrupts in one day).
- #179: a 27-s refusal loop.

Budgets and backoff exist per workspace only (row 5 anchors). There is no fleet-wide budget, no jitter, no boot admission, and no memory gate.

**Do.**
- A fleet-wide token bucket shared by wake fires and restarts; exhaustion parks the actor and sends ONE escalation, the #197 shape generalised.
- Jitter on `REWAKE_BOUND_MS` and on restart delays.
- At most K concurrent session boots, with K sized from the measured boot distribution in [`issue-176-init-hang.md`](issue-176-init-hang.md).
- Refuse or queue new spawns while PSI `memory some avg10` is over a threshold.

The thresholds are unmeasured; calibrate them on the load campaign of [#212](https://github.com/lcsmas/orchestra/issues/212) (N concurrent sessions on the fake API).

## VERIFIED (read this session)

- **Issue data:** all 243 issues (title, state, body) via `gh issue list --json`; classified by hand. Counts and dates were computed from that JSON.
- **Primary texts, downloaded PDFs extracted with pypdf and grepped for the quoted sentences:**
  - Bronson HotOS'21; Huang OSDI'22; Newcombe et al. CACM'15
  - Pillai OSDI'14; Candea & Fox HotOS'03; Yuan OSDI'14
  - φ accrual JAIST TR IS-RR-2004-010; SWIM DSN'02; Chandra & Toueg JACM'96 (course-site mirror of the JACM PDF); Falcon SOSP'11 (author's page); Gray failure HotOS'17 (Microsoft PDF)
  - Dapper TR'10; FoundationDB SIGMOD'21; Elle arXiv:2003.10554; SEDA SOSP'01; Tail at Scale (author's site); Saltzer/Reed/Clark 1984
  - Gray & Cheriton TR (OCR-garbled; only the clock-skew term was legible)
- **Pages fetched as HTML and grepped:**
  - man7 clock_gettime(2), epoll(7), rename(2)
  - kernel.org PSI and cgroup-v2 (`cgroup.kill`)
  - Kubernetes controller doc; Google SRE "Handling Overload"; Brooker "Exponential Backoff And Jitter"
  - Node process / perf_hooks docs; Electron powerMonitor
  - FoundationDB testing doc; TigerBeetle `vopr.md` (raw GitHub); fast-check model-based testing
- **Code claims:** made on `origin/master` @e7aedd79 via `git grep` / `git show`. A sub-agent did the first pass; I re-read 24 of its anchors myself (bus-wake 13/234/243/213/260/434, workspaces 2847/5622, store 199/263, session-wedge 224/281/620, bus-liveness 37/81, idle-clock 12, account-inherit 472/499, prompt-queue 52, keeper-client 277, bus-liveness main 12, resource-monitor 124, release.sh 402, keeper 317/436).
- **#240 fix branch not merged:** `git merge-base --is-ancestor origin/migrate-transcripts-same-dir-c13 origin/master` → false.
- **Catch-block counts (528 / 125 empty / 58 log-only):** my own scan of 195 non-test `.ts` files on origin/master. The regex treats a comment-only body as empty.

## NOT VERIFIED

- Brooker & Desai, "Systems Correctness Practices at AWS" (CACM 2025, P language): ACM returned 403; I only saw a search snippet.
- Antithesis: named only through TigerBeetle's doc; not fetched.
- SubmitQueue, TAP and Temporal: not re-read; they are cited through the two prior docs.
- Huang OSDI'22's two trigger types and two amplification types were not extracted verbatim.
- Every "would have prevented" claim, and the clock-step effect on Orchestra's own timers, are inferences from code and issue text. No arm was run against a pre-fix binary, and the clock step was not reproduced.
- Clock-step incidents come from operator memory notes, not the tracker. Their link to Orchestra decisions (as opposed to the CLI) is unproven.
- Cost estimates S/M/L are judgement, not measured.
- Pain classes are my hand classification. Borderline issues (e.g. #144 addressing vs starvation, #227 boot vs silent acceptance) could move between rows; that changes per-class counts by about ±1.
- Agent-reported anchors I did not re-read: the per-file `Date.now()` counts, and the in-place writes for inbox-tray, usage, secrets and settings.json. All other anchors in this doc were re-read on origin/master.
