# Bus protocol invariants: delivery, Réveil, Accusé, gates, fencing

Written 2026-10-07 for [#297](https://github.com/lcsmas/orchestra/issues/297) (map [#296](https://github.com/lcsmas/orchestra/issues/296)). Code anchors are `path:line` on **`origin/master` @ `743f9ab0`** (0 commits behind at writing time).

Not repeated here, only referenced:
- [`distributed-systems-leads.md`](distributed-systems-leads.md): the 18-issue Bus defect inventory (rows 1, 2 and 5 of its pain table), the level-triggered Réveil lead (lead 3), the model-checking lead (lead 4) and the monotonic-clock lead (lead 1).
- [`orca-model-lineage.md`](orca-model-lineage.md): the Kafka/SQS analogues of the cursor and the single outstanding Lot, Kleppmann fencing tokens, the poison-lot bound, side-effect fencing and the `dcap_` token question.

Tags: **VERIFIED** means read or run in this session. **UNVERIFIED** means not read or not run. **INFERRED** marks my reasoning from code or data. It is never a citation.

## Question

Write the protocol's safety and liveness invariants as checkable statements, using the 18 Bus defect issues and the code in `src/main/bus.ts`, `src/main/bus-wake.ts` and `src/shared/bus-wake.ts`. For each invariant, name the historical issue that violated it and the state it depends on today (durable or in-memory).

## Short answer

1. **There are 25 invariants in 3 groups.** Delivery: D1–D8. Réveil: W1–W10 plus W5a. Identity and fencing: I1–I6. The headline liveness invariant is W5: *a wakeable reader with an un-acked message in its related runs, under a governing `wake=ON`, gets a fire within `REWAKE_BOUND_MS + SWEEP_MS` (≈ 6 min) of its last fire.* Today it holds only through the #183 backstop, and that backstop is timed on the wall clock.
2. **The Delivery invariants rest on durable SQLite primitives and held in the field.** These primitives are the unique partial index, the `MAX()` cursor, append-only `messages` and the shared recipient predicate. A read-only census of the live bus found 0 violations of D1, D2 and I5. The defects in this group were scope disagreements (#144, #158, #185), not primitive failures.
3. **Every Réveil invariant depends on in-memory state.** That state is two `Map` ledgers, the session queue, the `Date.now()` stamps and the roster. That is where all 13 starvation and storm issues sit. Each fix added one re-arm rule, and there are now 5 of them: cursor, gate id, orphaned run, generation and bound. The durable-Réveil lead would turn W1–W5 and W9 into SQL predicates.
4. **Fencing (I1) has open gaps on master** (INFERRED from code, no rig yet):
   - A coordinator at generation 0 presents no generation, so it is never fenced.
   - `check --ack-previous` acks without the fence. The zombie shares the successor's reader handle and cursor, so it can consume the successor's Lot.
   - Live data: all **18** fence rejections ever recorded hit a *member*. That is the #222 false-positive class. **None** hit a zombie coordinator.
5. **Six more candidate violations on master need must-FAIL rigs** (§Open gaps):
   - Open gates re-fire every 5 min with no cap.
   - A pending reader that is not wakeable is never escalated.
   - A member's session restart latches the reader until the bound.
   - A live reader has **65** exact-addressed un-acked messages in runs outside its related set.
   - 40 orphaned outstanding Lots belong to deleted readers.
   - App restart can double-fire into a keeper-surviving turn.

## Framing: which invariants a rig can check

Alpern & Schneider (IPL 21, 1985): "a safety property stipulates that some 'bad thing' does not happen during execution", and the bad thing "must be irremediable … there is an identifiable point at which it happens". A liveness property "stipulates that a 'good thing' happens during execution", and "no partial execution is irremediable". VERIFIED (PDF extracted this session).

Consequence (INFERRED): a *bounded* liveness statement ("served within X") is a **safety** property. Its bad prefix is the deadline passing with no fire, so a finite rig trace on a fake clock can refute it. An *unbounded* one ("eventually served or escalated") cannot be refuted by any finite trace. It needs a model checker with fairness (leads doc, lead 4, step 2). This is why every W invariant below is stated with a bound wherever the code has one.

## The state the protocol runs on

| State | Where | Durable? | Read by |
|---|---|---|---|
| `messages` (total order, `AUTOINCREMENT`) | [`bus.ts:185-199`](../../src/main/bus.ts) | Durable. No `DELETE FROM messages` anywhere in non-test `src/` (git grep, 0 hits) | Pending predicate, `check` |
| `deliveries` + unique partial index (one outstanding Lot) | [`bus.ts:201-214`](../../src/main/bus.ts) | Durable | `check`, `ack` |
| `cursors` (advanced only by `ack`) | [`bus.ts:217-222`](../../src/main/bus.ts), [`:797-800`](../../src/main/bus.ts) | Durable | Pending predicate, lot re-arm |
| `decision_gates` (+ `recipient`, MIGRATIONS[4]) | [`bus.ts:224-235`](../../src/main/bus.ts), [`:310-314`](../../src/main/bus.ts) | Durable | Gate axis |
| `runs.parent_run_id` (topology), `runs.coordinator`, `runs.coordinator_generation` | [`bus.ts:175-183`](../../src/main/bus.ts), [`:334-335`](../../src/main/bus.ts) | Durable | Related-run set, fence, #200 re-arm |
| `run_flags` (switches frozen per run) | [`bus.ts:280-289`](../../src/main/bus.ts) | Durable | Every switch read |
| `dispatch_capabilities`, `mutation_receipts`, `fence_events` | [`bus.ts:386-414`](../../src/main/bus.ts), [`:455-464`](../../src/main/bus.ts), [`:348-358`](../../src/main/bus.ts) | Durable | Completion check, retries, shadow trail |
| **FIRE ledger** `Map<reader, WakeLedgerEntry>` | [`bus-wake.ts:234`](../../src/main/bus-wake.ts) | **In-memory**, process-global, lost on app restart, kept across a *session* restart | `decideWake` dedup |
| **COUNT ledger** | [`bus-wake.ts:243`](../../src/main/bus-wake.ts) | **In-memory** | Shadow (switch-OFF) dedup |
| `skipState` (transition log) | [`bus-wake.ts:259`](../../src/main/bus-wake.ts) | **In-memory** | #159 observability |
| `lastWakeAt` stamps | [`shared/bus-wake.ts:226`](../../src/shared/bus-wake.ts), clock [`bus-wake.ts:634`](../../src/main/bus-wake.ts) | **In-memory**, wall clock (`Date.now()`) | #183 bound |
| Session prompt queue (unstarted turns) | `agent-sdk.ts` (coalesce at [`:3079`](../../src/main/agent-sdk.ts)) | **In-memory**, app process | #162 coalescing, #172 rollback |
| Roster: `wakeable`, reader `runId` = `resolveWaveRunId(ws)` | [`wake-roster.ts:12-37`](../../src/main/wake-roster.ts) | Derived from `store.json` (a durable file outside the bus) plus live session state (in-memory) | Every sweep |
| CLI identity: `$ORCHESTRA_RUN_ID`, `$ORCHESTRA_COORDINATOR_GENERATION`, `--as` | [`agent-sdk.ts:984-994`](../../src/main/agent-sdk.ts), [`workspaces.ts:5300-5312`](../../src/main/workspaces.ts), [`cli/index.ts:988-1015`](../../src/cli/index.ts) | **Process env, frozen at session spawn** | Every CLI write/ack, fence |

## Invariants

Columns: **Kind** S = safety, bL = bounded liveness (a safety property, rig-checkable), L = unbounded liveness (needs a model checker). **Violated by** = the historical issue whose field incident broke it. **Depends on** = the state from the table above. **Master** = whether it holds on `743f9ab0` by code-read (INFERRED unless a census or test is cited).

### D: Delivery (Lot, Relève, Accusé)

| ID | Checkable statement | Kind | Violated by | Depends on | Master |
|---|---|---|---|---|---|
| D1 | For every `(run, reader)`, at most one `deliveries` row has `acked_at IS NULL`. | S | None in the tracker (spike #109 arm 2b measured it load-bearing) | Durable: unique partial index [`bus.ts:213`](../../src/main/bus.ts) | **Holds.** Live census: 0 pairs with > 1 outstanding (VERIFIED) |
| D2 | `cursors.acked_seq` never decreases, and never exceeds `MAX(messages.sequence)`. | S | None | Durable: `MAX()` upsert [`bus.ts:799`](../../src/main/bus.ts) | **Holds.** Census: 0 cursors above max seq (VERIFIED) |
| D3 | A replayed Lot returns exactly the messages of its first take (same `from_seq`/`to_seq`, same predicate). | S | None | Durable: frozen bounds [`bus.ts:756-765`](../../src/main/bus.ts); messages append-only; single writer + `AUTOINCREMENT` | **Holds** while there is no retention/DELETE. A future retention job would break it |
| D4 | Only `ack` by the Lot's reader advances its cursor. Neither take nor the host acks. | S | Pre-bus channel #57 ("lying Delivered"); spike must-FAIL arm | Durable (`ack` [`bus.ts:792-812`](../../src/main/bus.ts)), but "reader" is the `--as`/env **claim** | **Holds for the host** (0 `ack(` call sites in non-test `src/main` outside bus.ts, git grep). Identity is a claim: any process can `--as` another reader |
| D5 | **Pending ⊆ retrievable:** every message the wake predicate counts for R sits in a run the wake order names, and `check --run <that run>` returns it. | S | #144 (short handle never matched), #158 (cross-run gate had no check surface), #185 (pending saw runs check could not surface → storm) | Durable predicate shared by both sides (`ownRunRecipientSql` [`bus.ts:690`](../../src/main/bus.ts), used by [`check` `:746-749`](../../src/main/bus.ts) and [`readPendingReaders` `bus-wake.ts:345-346`](../../src/main/bus-wake.ts)); order = `pendingRunIds ∪ gateRunIds` [`bus-wake.ts:825-831`](../../src/main/bus-wake.ts) | **Holds by construction** (INFERRED): related-run pending is exact-recipient, and `check --run r` uses the own-run predicate (exact ∪ broadcast), a superset |
| D6 | **Addressed ⇒ eventually pending:** a message whose `recipient` is a live reader is pending for it (in its related-run set) until acked. | L (a write-time guard makes it S for new writes) | #144, #155 (unknown run_id), #175 (send outside the run delivers to nobody) | CLI write guard `assertRecipientReachable` ([`bus-verbs.ts:539`](../../src/cli/bus-verbs.ts), `:823`, `:920`); topology is durable but **mutable after the write** | **Does not hold for old rows or after a topology change.** Census: one live reader (`0524718f`) has **65** exact-addressed un-acked messages in 5 runs outside its related set: 63 dispatches in `host-*` runs from 2026-09-14/16 and 2 escalations (§Census). Host writers (`bus-liveness.ts:479`, `session-watchdog.ts:285`, `pause-auto.ts:407`) call `send()` without the CLI reachability guard |
| D7 | A NULL-recipient broadcast never pends for its own sender. A directed self-note still does. | S | #168 (self-wake loop, ≥ 8 cycles) | Durable predicate [`bus.ts:690-694`](../../src/main/bus.ts) | **Holds** (one predicate, both sites) |
| D8 | A gate resolves at most once. A question counts as answered only by a reply from its recipient, threaded to it, back to the asker, in the same run. | S | #119 review F1 (third-party reply cleared an ask) | Durable: `WHERE resolved_at IS NULL` [`bus.ts:851-857`](../../src/main/bus.ts); answer predicate [`bus-wake.ts:359-371`](../../src/main/bus-wake.ts) | **Holds** |

### W: Réveil (wake engine)

| ID | Checkable statement | Kind | Violated by | Depends on | Master |
|---|---|---|---|---|---|
| W1 | **Dedup:** while R has a fired wake whose Lot it has not acked (cursor in `wokeRunId` < `wokeLotSeq`), N new inserts produce **no** extra fire before `REWAKE_BOUND_MS` (T117.2: 3 inserts mid-turn = 1 wake). | S | The disproved `>=` design recorded at [`shared/bus-wake.ts:293-303`](../../src/shared/bus-wake.ts) | **In-memory** FIRE ledger | **Holds** (unit arm kept as regression) |
| W2 | At most one **unstarted** wake-order turn per reader queue. A **started** turn is never mutated. | S | #162 (identical orders piled behind a long turn) | **In-memory** session queue; pure merge [`shared/bus-wake.ts:731-743`](../../src/shared/bus-wake.ts) | **Holds within one app process.** Across an app restart with a keeper-surviving turn: UNVERIFIED (see W9) |
| W3 | **Woken means started:** if a wake order is withdrawn unstarted, or delivery returns false, R's FIRE entry is gone before the next sweep. | S | #172 (withdrawn wake still marked → 15 min starvation); #57 lesson | **In-memory** ledger + queue. `deliverWake` resolves on the **queue push**, not the turn start ([`sdk-delivery.ts:39-45`](../../src/main/sdk-delivery.ts)). Rollback: [`bus-wake.ts:193-230`](../../src/main/bus-wake.ts), [`:850`](../../src/main/bus-wake.ts) | **Holds if** every discard site in `agent-sdk.ts` calls `rollbackWakeForWithdrawnTurn` (3 call sites found: `:2906`, `:3321`, `:4390`). The code says that coverage is manual ([`bus-wake.ts:224-226`](../../src/main/bus-wake.ts)). A turn that **started** and then died (CLI crash) is not rolled back; it falls to W5's bound |
| W4 | A counted (switch-OFF) would-wake never suppresses a later fire after an OFF→ON flip. | S | #153 (canary-4 LEAD never woken) | **In-memory**, two ledgers [`bus-wake.ts:234`, `:243`](../../src/main/bus-wake.ts); per-axis selection [`shared/bus-wake.ts:518-519`](../../src/shared/bus-wake.ts) | **Holds** |
| W5 | **Bounded service (headline):** if R is wakeable, its governing run has `wake=ON`, and R has `unackedThroughSeq > 0`, then R is fired (a) within one sweep tick if it has no FIRE entry or its cursor reached `wokeLotSeq`, and (b) otherwise within `REWAKE_BOUND_MS + SWEEP_MS` = 5 + 1 min of its last fire. | bL | #150 (14 min), #159 (19 min), #183 (4 h / 6 h / 14 h), #200 (~2 min after restart), #172 (15 min) | **In-memory** ledger and `lastWakeAt` on **`Date.now()`** ([`shared/bus-wake.ts:432-435`](../../src/shared/bus-wake.ts)); sweep timer [`bus-wake.ts:58`, `:988`](../../src/main/bus-wake.ts); durable cursors and messages | **Holds except under a clock step.** A backward step of Δ delays (b) by Δ (leads doc, lead 1). The field step was +2 h. An entry with no stamp is not bounded until a stamp exists ([`:433`](../../src/shared/bus-wake.ts)) |
| W5a | **Fast path:** a lone message to an idle reader with no FIRE entry fires within `WATCH_DEBOUNCE_MS` (150 ms) plus sweep time. The worst case falls back to `SWEEP_MS` (60 s). | bL | #149 (58.84 s worst case: the inode watch detached) | In-memory watcher on the **directory** [`bus-wake.ts:922-963`](../../src/main/bus-wake.ts) | **Holds** per #149's gate (not re-run here) |
| W6 | **Gate service:** an open gate addressed to a wakeable R with `askGate=ON` fires within one tick when it opens (gate id above `wokeGateSeq`), and again within the W5 bound while it stays open. | bL | #158 (no wake, ≥ 8 sweeps), #183 (gate axis did not re-wake) | **In-memory** ledger; durable gates | **Holds**, but see W7: no upper limit on repeats |
| W7 | **No storm:** fires to R are bounded by (number of R's acks) + (number of new gates) + (number of generation bumps) + one per `REWAKE_BOUND_MS`. A bounded re-fire only happens when a re-check can change state. | S (rate) | #168 (self-loop), #185 (5-min storm on an ask already acked), #187 (orphaned asks seeded it), #162 | **In-memory** ledger; `unackedThroughSeq` revalidation [`shared/bus-wake.ts:574-575`](../../src/shared/bus-wake.ts) | **Holds for the lot axis.** **Not for gates:** the bound path fires `gatePending && askGateOn` with no revalidation and no cap ([`shared/bus-wake.ts:579`](../../src/shared/bus-wake.ts)), so an unresolved agent-addressed gate re-wakes every 5 min forever. **Not for poison Lots:** there is no replay counter (lineage doc) |
| W8 | **Pending ⇒ served or escalated:** a reader with pending state is eventually fired, or someone (coordinator or human) is told. | L | #159 (silent; liveness rescued it only because the reader had a task) | **In-memory** roster `wakeable` ([`wake-roster.ts:20-25`](../../src/main/wake-roster.ts)) | **Does not hold for `not-wakeable` readers.** The only signal is one `log.warn` per transition ([`bus-wake.ts:277-281`](../../src/main/bus-wake.ts)). Liveness is deliberately decoupled from mail state ([`bus-liveness.ts:144-148`](../../src/main/bus-liveness.ts)). Pause (#226/#252) is a legitimate exemption; `startKeepsFailing` and archived are not obviously so |
| W9 | **Restart-independence:** the wake decision for R after an app or session restart equals the decision without it, up to at-least-once duplicates. | S | #159 (orphaned `wokeRunId`), #200 (stale entry across a coordinator session restart) | Re-arm on durable facts: orphaned run ([`shared/bus-wake.ts:381-383`](../../src/shared/bus-wake.ts)), generation ([`:469-474`](../../src/shared/bus-wake.ts)) | **Partial.** App restart: ledger empty → immediate re-fire (a duplicate if a keeper-held turn is still running; INFERRED). **Member** session restart: no generation bump, so the stale entry latches until the W5 bound (INFERRED) |
| W10 | **No silent skip:** a pending reader skipped for any reason other than `no-pending` produces one log line per transition. | S | #159 (19 min diagnosable only by elimination) | **In-memory** `skipState` | **Holds** |

### I: Identity and fencing

| ID | Checkable statement | Kind | Violated by | Depends on | Master |
|---|---|---|---|---|---|
| I1 | **Zombie coordinator cannot write:** once `bumpCoordinatorGeneration(run)` returns g and `fencing=ON`, no mutation by the run's coordinator from a process launched before the bump commits. Mutations: send, ack, gate-resolve, run-*, **and Lot consumption**. | S | #166 (never bumped, so the fence was a field no-op); #128 review F1 (TOCTOU, fixed by one IMMEDIATE tx [`bus.ts:1369-1371`](../../src/main/bus.ts)) | Durable generation; **process-env** presented generation | **Does not hold in 3 places** (INFERRED, §Open gaps G1–G3): (a) generation 0 is never presented (`if (gen > 0)` [`agent-sdk.ts:994`](../../src/main/agent-sdk.ts), [`workspaces.ts:5311`](../../src/main/workspaces.ts)), so the first replaced coordinator is unfenced; (b) `check --ack-previous` acks unfenced ([`bus-verbs.ts:748-751`](../../src/cli/bus-verbs.ts)), and `check` takes unfenced; (c) `gate open`/`ask` are unfenced ([`bus-verbs.ts:921`](../../src/cli/bus-verbs.ts)) |
| I2 | **Members are never fenced:** a write by a non-coordinator is not rejected by coordinator generation. | S | #222 (members locked out after a coordinator restart) | Pure `decideFence` [`shared/bus-fencing.ts:57-62`](../../src/shared/bus-fencing.ts), actor read inside the tx [`bus.ts:1339`](../../src/main/bus.ts) | **Holds.** Census: all 18 recorded `fired=1` events (2026-09-28/29) had a non-coordinator actor (VERIFIED). These are the pre-fix #222 false positives |
| I3 | Every coordinator replacement bumps exactly once. A member relaunch or a first start never bumps. | S | #166, #134 core risk | Durable run row; gate [`bus-run-anchor.ts:133`](../../src/main/bus-run-anchor.ts); call sites [`workspaces.ts:5262`](../../src/main/workspaces.ts), [`agent-sdk.ts:5109`](../../src/main/agent-sdk.ts) | Two chokepoints found. That they are **all** the replacement paths: UNVERIFIED |
| I4 | **One run per reader:** the run a session's CLI writes and acks under (`$ORCHESTRA_RUN_ID`) equals the run the engine reads for it (`resolveWaveRunId` from the store). The same holds for the generation. | S | #142 (re-parent keeps a stale run id), #171 (promote does not propagate the run id or generation; 4 occurrences) | **Process env frozen at spawn** vs a store-derived value | Holds only if every topology change restarts the session. Whether all re-parent paths do: UNVERIFIED |
| I5 | At most one `active` capability per `(run, recipient)`. A completion is accepted only with that capability's current token. | S | #167 (re-dispatch superseded a legitimate token; no retrieval path) | Durable, but enforced **by transaction only**: `idx_dcap_active` is not UNIQUE ([`bus.ts:400-401`](../../src/main/bus.ts)), supersede-on-mint [`:1572-1588`](../../src/main/bus.ts). The clear token lives only in agent context | **Holds.** Census: 0 pairs with > 1 active (VERIFIED) |
| I6 | A mutation retried with the same `(run, caller, request_id)` takes effect once. | S | None (pre-#130 batch-ack only) | Durable PK [`bus.ts:456-464`](../../src/main/bus.ts) | Holds **only** when `receipts=ON` **and** the caller passes `--request-id` ([`bus-verbs.ts:403`](../../src/cli/bus-verbs.ts)) |

### Mapping the 18 issues

| Issue | Invariant(s) | Issue | Invariant(s) |
|---|---|---|---|
| #144 | D5, D6 | #162 | W2, W7 |
| #149 | W5a | #168 | D7, W7 |
| #150 | W5 (lot re-arm) | #185 | D5, W7 |
| #153 | W4 | #187 | W7 (seed), D8 lifecycle |
| #158 | D5, W6 | #142 | I4 |
| #159 | W5, W9, W10 | #166 | I1, I3 |
| #172 | W3, W5 | #167 | I5 |
| #183 | W5, W6 | #171 | I4 |
| #200 | W9, W5 | #222 | I2 |

Reading (INFERRED): 13 of the 18 issues broke a W invariant, and every W invariant depends on in-memory state. Of the 5 that broke a D invariant, 4 were scope disagreements between two durable predicates (D5/D6), not failures of a primitive. The 5 identity issues (I1–I5) all come from a process env frozen at spawn diverging from a durable row.

## Census of the live bus (read-only)

I copied `~/.orchestra/bus.sqlite{,-wal,-shm}` and `store.json` to `/tmp`, opened the copy with `mode=ro`, and ran 2026-10-07 ~12:33Z. Schema v10, 5,562 messages, 27 runs, 5,183 deliveries.

- **D1/D2/I5:** 0 violations (see the tables).
- **Switches:** 25/27 runs `wake=ON`, 22/27 `askGate=ON`, 21/27 `fencing=ON`. 18 runs have `coordinator_generation > 0` (max 11), and all 18 have fencing ON.
- **Fencing:** 18 `fence_events`, all `fired=1`, all with a **non-coordinator** actor, all between 2026-09-28 13:01 and 2026-09-29 20:33. The mechanism has never been observed rejecting a coordinator.
- **Orphaned mailboxes:** 40 outstanding Lots, all older than 1 h (the oldest is 526 h). **0** of their readers are in the store, so these are durable garbage from deleted workspaces. They are not woken (not in the roster) and they are never cleared.
- **D6:** of 101 recipients with exact-addressed un-acked mail, 4 are live, non-archived workspaces. One of them (`0524718f`, which is itself a run anchor) has 65 such messages in 5 runs that its related set does not contain: 63 dispatches in `host-*` runs from 2026-09-14/16 and 2 escalations in run `36773f53`. The related set was computed by my own re-implementation of `getRelatedRunIds`, not the shipped function, so this count is approximate (INFERRED).

## Open gaps on master (candidates for must-FAIL rigs)

All INFERRED from code. None has a rig yet, and the map's evidence rule requires one before any GO.

| # | Gap | Invariant | Rig shape (must-FAIL on master) |
|---|---|---|---|
| G1 | A generation-0 coordinator presents no generation. After its first replacement (0→1) the zombie is unfenced. The code calls gen 0 "indistinguishable from v1 for fencing" ([`workspaces.ts:5301-5304`](../../src/main/workspaces.ts)) | I1 | Start coordinator A (gen 0), replace it with B (gen 1), have A's env `send` with `fencing=ON` → the write commits |
| G2 | `check --ack-previous` and the `check` take are unfenced. Zombie and successor share the reader handle and cursor | I1 | Same setup; A runs `check --ack-previous` → B's next `check` misses those messages |
| G3 | Open gates re-fire every `REWAKE_BOUND_MS` forever (no revalidation, no cap) | W7 | Gate to a wakeable reader, never resolved, fake clock +60 min → 12 fires |
| G4 | Pending ∧ not-wakeable (`startKeepsFailing`, archived, no worktree) has no escalation | W8 | A not-wakeable reader with mail for 1 h → 0 escalation rows, 1 log line |
| G5 | A member session restart keeps the stale FIRE entry (no generation bump) | W9, W5 | Fire, restart the member session, new mail → no fire until the 5-min bound |
| G6 | App restart empties the ledger while a keeper-held wake turn is still running | W2, W9 | Restart the app mid-wake-turn → a second wake-order turn queues |
| G7 | Mail addressed to a live reader in a run that later becomes unrelated stays un-acked and invisible; deleted readers leave outstanding Lots | D6 | Reparent or delete the run after a send → no pending, no surface |

## How to check them

- **Delivery (D1–D8) and I2/I5 are SQL predicates over durable tables.** Each can run as a post-condition after every step of a model-based test, or against a read-only copy of the live bus as above.
- **W1–W7 and W9 are trace predicates over (fires, acks, inserts, clock).** The seams already exist: pure `decideWake` with an injected `now`, `__setNowForTests` ([`bus-wake.ts:637`](../../src/main/bus-wake.ts)), `__peekWakeLedgerForTests` ([`:1036`](../../src/main/bus-wake.ts)) and an injected `deliverWake` recorder. The fast-check command set in leads doc lead 4 covers them. Add `reparent`, `deleteReader` and `restartMemberSession` so the runs cover G5 and G7.
- **W8 and D6 are unbounded liveness.** They need either a bound chosen first (making them bL) or the TLA+ step with fairness.
- **If the Réveil moves to the bus (lead 3), W1–W5 and W9 become SQL** over a `wake_attempts` table, and in-memory state only accelerates the sweep. That is the structural fix for the 13-issue cluster (INFERRED).

## VERIFIED (read or run this session)

- Code on `origin/master` @ `743f9ab0` (worktree HEAD == origin/master, `git rev-parse`): `src/shared/bus-wake.ts` (full), `src/main/bus-wake.ts` (full), `src/main/bus.ts` lines 1–1790, `src/shared/bus-fencing.ts` (full), `src/cli/bus-verbs.ts:160-420, 725-800, 915-930`, `src/cli/index.ts:975-1015`, `src/main/agent-sdk.ts:975-1010`, `src/main/workspaces.ts:5290-5320, 5490-5545`, `src/main/wake-roster.ts`, `src/main/sdk-delivery.ts:20-60, 140-180`, `src/main/index.ts:505-535`, `src/shared/bus-liveness.ts:1-90`, `src/main/bus-liveness.ts:140-150, 468-492`, `src/main/session-watchdog.ts:280-295`, `src/shared/opening-task.ts:36-44`.
- Greps on master: no `DELETE FROM messages|deliveries|cursors|decision_gates` in non-test `src/`; no host `ack(` call in non-test `src/main` outside bus.ts; 3 `rollbackWakeForWithdrawnTurn` call sites in agent-sdk.ts; the 2 `maybeBumpCoordinatorOnReplacement` call sites; the `fenced(ctx, …)` verbs (send, ack, gate-resolve, run-hold/resume, run-pause, run-release); `ORCHESTRA_COORDINATOR_GENERATION` set only when `gen > 0`.
- Issues: the bodies of all 18 Bus issues plus #175, #155, #57, #128–#130, #117 and #119 (titles and dates), from `gh issue list --json`.
- Live-bus census: the queries above, on a `/tmp` copy opened `mode=ro`. The live files were only read by `cp`.
- Primary texts: Alpern & Schneider, "Defining Liveness", IPL 21 (1985) (Cornell PDF, extracted with pypdf); SQLite [autoinc.html](https://www.sqlite.org/autoinc.html) ("guaranteed to be monotonically increasing", "ROWID values that were rolled back are ignored and can be reused"); SQLite [wal.html](https://www.sqlite.org/wal.html) ("there can only be one writer at a time").

## NOT VERIFIED

- **Every "Master: holds / does not hold" verdict is a code-read inference.** No rig was run for any invariant, including G1–G7. None of the 18 fixes was re-tested against its pre-fix binary.
- The D6 census count (65) uses my approximation of `getRelatedRunIds` and of the reader's anchor run, not the shipped functions. The anchor lookup returned none for 2 of the 4 live readers, so their rows are not interpreted.
- Whether all coordinator-replacement paths bump (I3), and whether all re-parent/promote paths restart the session (I4).
- Whether `agent-sdk.ts` has discard sites for unstarted turns beyond the 3 that call the rollback (W3).
- G6 (duplicate wake into a keeper-held turn after an app restart): it depends on how the keeper reattach rebuilds the queue, which I did not read.
- The W5 bound under a clock step was not reproduced (inherited caveat from leads doc lead 1).
- `src/main/bus-runs.ts` `getRelatedRunIds` and the `busSwitch` bodies were read only in part (lines 418–443).
- `docs/codebase-map/bus.md` was scanned for headings and existing "invariant" sections only, not read in full.
