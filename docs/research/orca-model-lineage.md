# Where orca's orchestration model comes from, and what its ancestors say we still lack

Compiled 2026-10-05. Companion to [`sota-multi-agent-orchestration.md`](sota-multi-agent-orchestration.md)
(the SOTA survey). Anything already covered there (Anthropic, Cognition, Magentic-One, MAST, Gas Town's
Refinery/Witness, Cursor, merge queues) is referenced, not repeated. Orca's MECHANISMS are documented in
[ADR 0002](../adr/0002-fleet-bus-sqlite-source-of-truth.md) and issues
[#104](https://github.com/lcsmas/orchestra/issues/104) (orca substrate inventory),
[#106](https://github.com/lcsmas/orchestra/issues/106) (round-2: wake, preamble, schema),
[#110](https://github.com/lcsmas/orchestra/issues/110) (adoption set v1),
[#267](https://github.com/lcsmas/orchestra/issues/267) (nomination acceptance) and
[#268](https://github.com/lcsmas/orchestra/issues/268) (task DAG dispatch). This note covers only LINEAGE.

**Pinned shas** (all read this session):

| Repo | sha | date of tip |
|---|---|---|
| [stablyai/orca](https://github.com/stablyai/orca) | `e2460907c3331be8c81c09752224278c7e4aa672` | 2026-10-04 |
| orca founding orchestration commit (PR #1188) | `c9391e203f701937438615eba9d4a0d64fdb7dc7` | 2026-04-28 |
| orca primitives commit (PR #9925) | `cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99` | 2026-07-27 |
| [jayminwest/overstory](https://github.com/jayminwest/overstory) | `ff38f3f76f084abcc34f519bcaa69580f6e53cf1` | 2026-05-28 |
| [gastownhall/gastown](https://github.com/gastownhall/gastown) (`steveyegge/gastown` redirects here) | `649b832b7672bc7a2dbef26f5983aba6198b819b` | 2026-07-23 |
| [apache/kafka](https://github.com/apache/kafka) `docs/design/design.md` | `28093d8215b69aa629031673325752484a84b0f3` | trunk |
| Orchestra (this repo) | `6ddecfd0deb3495fa45cace2628fb28254f504f4` | 0 commits behind `origin/master` |

Tags: **VERIFIED** = I fetched or read it this session. **UNVERIFIED** = not read this session. **CITED** =
orca's own sources name it. **INFERRED** = a structural resemblance I see; orca does not name it.

---

## Question

Which systems is orca's fleet-coordination model built on, according to orca's own sources? Which first-party
sources define each ancestor? Which failure modes and fixes from those ancestors apply to an orca-style bus,
and which does Orchestra already have?

## Short answer

1. Orca's bus comes from a chain of 2026 coding-agent tools, not from the literature. Gas Town's mail protocol and `gt sling` led to Overstory's SQLite WAL mail with typed `worker_done`/`merge_ready`/`dispatch`/`escalation`. Orca's spec ([discussion #681](https://github.com/stablyai/orca/discussions/681)) cites Augment Intent, Overstory and Gas Town by name. Its founding PR says "sling pattern", and its first `messages` table is almost the same as Overstory's.
2. Across every surface I searched, orca cites no distributed-systems or academic source. Its later delivery lots, consumer-generation fencing and mutation receipts are unattributed reinventions of Kafka offset commits, SQS FIFO in-flight groups, fencing tokens and idempotency keys.
3. Orca's authors have since ruled out "dead-letter/poison-message" handling and "automatic retry ... based on silence". On 2026-09-30 they **deleted dispatch capability tokens** because agents lost them on compaction, and they rejected a disk outbox in favor of a bounded retry.
4. Open leads for Orchestra: a poison-lot bound (an unacked lot is re-woken every 5 min with no limit), fencing for git/merge side effects and not only bus writes, a fresh decision on `dcap_` tokens, and byte quotas on bodies and lots.
5. Orchestra already has: the cursor advances only on ack, idempotency receipts, coordinator fencing on bus writes, OTP-style restart intensity, and host-derived liveness.

## Lineage table

| Ancestor | Cited or inferred | Evidence (orca side) | Primary source of the pattern |
|---|---|---|---|
| **Gas Town** (Steve Yegge) — mail protocol, `gt sling`, sling-context beads, heartbeats, ZFC | **CITED** (#681 table; "sling pattern" in PR #1188; named again in PRs #22582/#23475/#23765). Also cited by Overstory's plan | [discussion #681](https://github.com/stablyai/orca/discussions/681), [PR #1188](https://github.com/stablyai/orca/pull/1188) | [gastown `docs/design/mail-protocol.md`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/mail-protocol.md), [`docs/design/scheduler.md#L96-L98`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/scheduler.md#L96-L98), [yegge.ai/gastown](https://yegge.ai/gastown) — VERIFIED |
| **Overstory** (Jaymin West) — SQLite WAL "mail", typed protocol messages, group addresses, `ov sling` | **CITED** by name in #681 ("SQLite mailbox + tmux"). The schema copy is **INFERRED** from a DDL diff (below) | #681; orca `db.ts` @c9391e20 vs Overstory `src/mail/store.ts` @f4b410b3 | [overstory README#L197](https://github.com/jayminwest/overstory/blob/ff38f3f76f084abcc34f519bcaa69580f6e53cf1/README.md#L197), [`src/types.ts#L270-L307`](https://github.com/jayminwest/overstory/blob/ff38f3f76f084abcc34f519bcaa69580f6e53cf1/src/types.ts#L270-L307) — VERIFIED |
| **Augment Intent** — coordinator → specialist agents, living spec | **CITED** as "pioneered by" in #681 | #681 body | [intentapp.dev](https://www.intentapp.dev/) (augmentcode.com/product/intent 308-redirects here) — VERIFIED |
| **Multica** — task board + daemon | **CITED** in the #681 landscape table only | #681 | [multica-ai/multica README](https://github.com/multica-ai/multica) @`b4ca5b4a` — VERIFIED |
| **Beads** (Yegge) — git/Dolt-backed dependency-graph tracker | **INFERRED** for orca: the DAG resembles it, and orca's only Beads mention is a feature request ([#7268](https://github.com/stablyai/orca/issues/7268)). Overstory and Gas Town are built on it | — | [steveyegge/beads README](https://github.com/steveyegge/beads) @`a93498c8` — VERIFIED |
| **Claude Code agent teams** — JSON mailbox, task list with file-locked claims | **INFERRED**, weak. Orca *integrates* agent teams (`orca claude-teams`, [supported.mdx#L28](https://github.com/stablyai/orca/blob/e2460907c3331be8c81c09752224278c7e4aa672/docs/site/content/docs/agents/supported.mdx#L28)) but never names them as a model for its bus | — | [code.claude.com/docs/en/agent-teams](https://code.claude.com/docs/en/agent-teams) — VERIFIED |
| **Kafka consumer offsets** (cursor saved after processing = at-least-once) | **INFERRED** | `deliveries` + cursor, "Replay until `--ack`" ([orchestration.mdx#L116](https://github.com/stablyai/orca/blob/e2460907c3331be8c81c09752224278c7e4aa672/docs/site/content/docs/cli/orchestration.mdx#L116)) | [Kafka design.md "Message Delivery Semantics"](https://github.com/apache/kafka/blob/28093d8215b69aa629031673325752484a84b0f3/docs/design/design.md) — VERIFIED |
| **SQS FIFO message groups / visibility timeout / DLQ redrive** | **INFERRED** | one outstanding lot per reader, but no timeout and no DLQ | [SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), [SQS DLQ](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html) — VERIFIED |
| **Fencing tokens** (Kleppmann) / Chubby sequencers | **INFERRED**. Orca says "consumer generation" / "fence" but cites nothing | checklist @cd05f2ff L106-L107, L128 | [Kleppmann 2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html) — VERIFIED; [Burrows, Chubby, OSDI 2006](https://research.google/pubs/the-chubby-lock-service-for-loosely-coupled-distributed-systems/) — VERIFIED (abstract page only; sequencer text not read) |
| **Idempotency keys** (Stripe) / **Idempotent Receiver** (Hohpe & Woolf) | **INFERRED** | `mutation_receipts (caller_fingerprint, request_id)` (#104 item 5), [PR #23984](https://github.com/stablyai/orca/pull/23984) | [Brandur Leach, Stripe, 2017-02-22](https://stripe.com/blog/idempotency); [EIP Idempotent Receiver](https://www.enterpriseintegrationpatterns.com/patterns/messaging/IdempotentReceiver.html) — VERIFIED |
| **Transactional outbox** | **Term used, no citation**: "relay outbox" (checklist L895); a "durable disk outbox" was considered and rejected in #23984 | [PR #23984](https://github.com/stablyai/orca/pull/23984) | [Chris Richardson, microservices.io](https://microservices.io/patterns/data/transactional-outbox.html) — VERIFIED |
| **Circuit breaker** (Nygard) | **INFERRED**. Orca uses the name, cites nothing | `DISPATCH_CIRCUIT_BREAK_FAILURES = 3` | Nygard, *Release It!* (book) — UNVERIFIED; [Fowler bliki 2014](https://martinfowler.com/bliki/CircuitBreaker.html) — VERIFIED |
| **Actor model / Erlang mailboxes + supervision** | **INFERRED**, and orca's design *rejects* the supervisor half ("No automatic retry or replacement based on silence") | checklist L47, L55 | [Hewitt, Bishop, Steiger, IJCAI 1973](https://www.ijcai.org/Proceedings/73/Papers/027B.pdf); [Armstrong thesis 2003](https://erlang.org/download/armstrong_thesis_2003.pdf); [OTP supervisor principles](https://www.erlang.org/doc/system/sup_princ.html) — VERIFIED |
| **Leases** (Gray & Cheriton) | **INFERRED** (5-min agent heartbeat / 10-min stale) | #104 item 4 | [Gray & Cheriton, SOSP 1989 (Stanford TR)](http://i.stanford.edu/pub/cstr/reports/cs/tr/90/1298/CS-TR-90-1298.pdf) — VERIFIED (OCR-garbled abstract) |
| **Lamport total order** | **INFERRED** (`sequence AUTOINCREMENT` = one global order) | #106 item 3 | [Lamport, CACM 1978](https://www.microsoft.com/en-us/research/publication/time-clocks-ordering-events-distributed-system/) — VERIFIED (landing page) |
| **Durable execution** (Temporal) | **INFERRED**, partial. "Make multi-agent workflows durable" ([PR #16904](https://github.com/stablyai/orca/pull/16904)); open issue [#9228](https://github.com/stablyai/orca/issues/9228) wants restart-reconstruction | — | [Temporal docs: Workflow Execution](https://docs.temporal.io/workflow-execution) — VERIFIED |
| **Blackboard architecture** (Hearsay-II) | **INFERRED**, weak, and a contrast: orca is addressed mailboxes, not a shared board | — | [Nii, AI Magazine 1986](https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/537) — VERIFIED (abstract only) |
| **Magentic-One ledgers**, **MetaGPT/ChatDev SOPs** | **No evidence** in orca. Covered in SOTA §5 and §9 | — | see SOTA survey |

### Surfaces searched for orca citations (negative claims rest on these only)

- Repo at `e2460907`: `git grep` over `src/main/runtime/orchestration/**`, `src/cli/**orchestration*`, `skills/orchestration`,
  `skill-guides/orchestration*`, `docs/` (incl. `docs/site`, `docs/reference`, `docs/audits`) for
  `gas town|gastown|overstory|beads|sling|erlang|actor model|kafka|sqs|visibility timeout|temporal|outbox|blackboard|magentic|metagpt|chatdev|kleppmann|chubby|lamport|dead letter|poison|inspired by|modeled on|borrowed|adapted from|https?://`.
  The only orchestration hits were incidental words such as "draft". There are no outbound URLs in orchestration source.
- All 12,700 commit messages (full history, `--filter=blob:none`) for the same terms, scoped to orchestration commits.
- Founding PR [#1188](https://github.com/stablyai/orca/pull/1188) body and its 10 commits. The design doc it links,
  `docs/inter-agent-orchestration-design.md`, **was never committed**: absent from history and 404 on the PR branch. Orca has no ADR directory.
- PRs [#1227](https://github.com/stablyai/orca/pull/1227), [#1403](https://github.com/stablyai/orca/pull/1403), [#9925](https://github.com/stablyai/orca/pull/9925), [#16904](https://github.com/stablyai/orca/pull/16904), [#22582](https://github.com/stablyai/orca/pull/22582), [#23475](https://github.com/stablyai/orca/pull/23475), [#23765](https://github.com/stablyai/orca/pull/23765), [#23982](https://github.com/stablyai/orca/pull/23982), [#23984](https://github.com/stablyai/orca/pull/23984), [#23994](https://github.com/stablyai/orca/pull/23994).
  `ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md` (1,787 lines) was read at `cd05f2ff`; it was deleted from HEAD by [#11890](https://github.com/stablyai/orca/pull/11890).
- GitHub search of issues/PRs in `stablyai/orca` for each term above. Discussions [#681](https://github.com/stablyai/orca/discussions/681) (all comments) and [#6201](https://github.com/stablyai/orca/discussions/6201); issue [#9228](https://github.com/stablyai/orca/issues/9228).
- Web search for Stably AI / Orca orchestration blog posts or talks: the results were only orca's docs site and third-party posts. I found no Stably-authored post on the design. I did not search YouTube or podcasts (NOT VERIFIED).

---

## Per-ancestor sections

### 1. Gas Town → Overstory → orca: the actual chain (CITED + INFERRED)

**Dates order the chain.** Gas Town was open-sourced 2026-01-01 ([yegge.ai/gastown](https://yegge.ai/gastown), VERIFIED).
Its `mail-protocol.md` already listed `POLECAT_DONE`, `MERGE_READY`, `MERGED`, `MERGE_FAILED`, `HELP` and `HANDOFF` at
[`88f784a9`](https://github.com/gastownhall/gastown/blob/88f784a9aaa4a3151362b4b52a5646bec14fe25f/docs/design/mail-protocol.md) (2026-01-12).
Overstory's first commit is 2026-02-12. Its implementation plan says it was
"Revised after alignment sessions covering orchestrator model, messaging, hierarchy, **Gas Town patterns**"
([`overstory-implementation-plan.md#L3-L5` @62f5e50](https://github.com/jayminwest/overstory/blob/62f5e50/overstory-implementation-plan.md#L3-L5), VERIFIED).
The same day it got its SQLite mail store ([`f4b410b3`](https://github.com/jayminwest/overstory/commit/f4b410b31c82630b5833e9736e4a9127800c7333): `journal_mode = WAL`, `busy_timeout = 5000`) and
the protocol types `worker_done | merge_ready | merged | merge_failed | escalation | health_check | dispatch | assign` ([`ff4b9fb3`](https://github.com/jayminwest/overstory/commit/ff4b9fb3d99be5fa89ef37ba8b996d29abf531dd)).
`@all` group addressing followed on 2026-02-16 ([`f3fb889f`](https://github.com/jayminwest/overstory/commit/f3fb889f9deff38678524733e13da0f24dd6f4f0)) and `decision_gate` on 2026-03-11 ([`6d60636d`](https://github.com/jayminwest/overstory/commit/6d60636d61d693189b8b4cd4b1e301224ff651ac)).
Orca discussion [#681](https://github.com/stablyai/orca/discussions/681) (2026-04-15, by contributor `heyramzi`) lists
"[Overstory] | SQLite mailbox + tmux | Automatic via messages" and "[Gas Town] | Mail system + roles | Automatic via inbox", and
says the coordinator pattern was "pioneered by Augment Intent". The founding PR [#1188](https://github.com/stablyai/orca/pull/1188)
(Jinwoo Hong, merged 2026-04-28) says it "Implements the inter-agent orchestration system described in the design doc and
discussion #681". It also says "Dispatch contexts (**sling pattern**) — scheduling state separated from tasks". All VERIFIED.

**What "sling pattern" points at.** Gas Town: "Scheduling state is stored on **separate ephemeral beads** called sling contexts. The work bead is never modified by the scheduler"
([`scheduler.md#L96-L98`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/design/scheduler.md#L96-L98), VERIFIED).
Orca's `dispatch_contexts` table holds one attempt's state apart from `tasks`. That is the same idea, now in a SQLite row instead of a bead.

**Schema diff (INFERRED copy, VERIFIED text).** Orca's founding `messages` DDL
([`db.ts#L49-L71` @c9391e20](https://github.com/stablyai/orca/blob/c9391e203f701937438615eba9d4a0d64fdb7dc7/src/main/runtime/orchestration/db.ts#L49-L71)) against Overstory's
([`src/mail/store.ts#L36-L53` @f4b410b3](https://github.com/jayminwest/overstory/blob/f4b410b31c82630b5833e9736e4a9127800c7333/src/mail/store.ts#L36-L53)):

- **Identical:** column set `id, from_*, to_*, subject, body, type DEFAULT 'status', priority DEFAULT 'normal', thread_id, read INTEGER DEFAULT 0, created_at DEFAULT (datetime('now'))`; index names `idx_inbox (to, read)` and `idx_thread (thread_id)`; WAL + `busy_timeout = 5000`; the type names `status`, `dispatch`, `worker_done`, `merge_ready`, `escalation`; and `decision_gate`, which Overstory added 6 weeks earlier. `handoff` is Gas Town's `HANDOFF`.
- **Orca added:** `sequence INTEGER PRIMARY KEY AUTOINCREMENT` (a global order), `payload`, `CHECK` constraints, the task DAG, and the 3-failure circuit breaker ([`db.ts#L373-L374`](https://github.com/stablyai/orca/blob/c9391e203f701937438615eba9d4a0d64fdb7dc7/src/main/runtime/orchestration/db.ts#L373-L374)).
  Delivery lots, consumer generations, mutation receipts and Runs came later, in [#9925](https://github.com/stablyai/orca/pull/9925) (2026-07-27), with no attribution.
- **Different from Gas Town:** Gas Town mail is beads in a git/Dolt store with typed **subject-line prefixes**. Overstory moved mail out of beads because beads was "too slow for high-frequency polling"
  ([overstory `CLAUDE.md#L87`](https://github.com/jayminwest/overstory/blob/ff38f3f76f084abcc34f519bcaa69580f6e53cf1/CLAUDE.md#L87), VERIFIED). Orca inherited that split.

**Where orca diverged from its ancestors on purpose.** In PR #22582, orca's authors list the tools they surveyed ("gastown, overstory, firstmate, paperclip") and
explain why orca pastes briefs into live terminals instead of passing them at launch:
"Orca also dispatches into already-running idle workers and into workers on remote hosts" ([PR #22582](https://github.com/stablyai/orca/pull/22582), VERIFIED).

**ZFC: an inferred philosophical ancestor.** Yegge's Zero Framework Cognition is "Keep the smarts out of the client side!".
The orchestrator does plumbing, schema checks and budget caps, never "anything that ranks, routes, or judges"
([yegge.ai/listings/zero-framework-cognition](https://yegge.ai/listings/zero-framework-cognition), Oct 2025, VERIFIED; Gas Town restates it at
[`agent-provider-integration.md#L619-L622`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/agent-provider-integration.md#L619-L622)).
Orca's scope invariants read like ZFC: "Agents choose decomposition, topology, placement, parallelism, and recovery strategy" and "No scheduler, automatic placement, capacity allocator"
([checklist#L42, L54 @cd05f2ff](https://github.com/stablyai/orca/blob/cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99/ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md#L42)). It also retired its autonomous scheduler (#104 item 4).
**INFERRED**: orca never uses the term ZFC.

### 2. Augment Intent and Multica (CITED as landscape, not as mechanism source)

Intent: "Coordinator agent writes a spec for every task, so each agent in a workspace works from the same plan". The spec is a
"running record of what was decided and why", and tasks are "held" until upstream work completes ([intentapp.dev](https://www.intentapp.dev/), VERIFIED via fetch summary).
That matches #681's phases (decompose → parallel specialists → merge → living spec). Orca built Phases 1–3, but not the living spec.
Nothing in Intent's public page describes a bus or delivery semantics. Multica is an issue board where agents are assignees, plus a local daemon
([README](https://github.com/multica-ai/multica), VERIFIED). It is a task-source ancestor, not a messaging one.

### 3. Message-queue semantics: Kafka offsets and SQS (INFERRED)

- **Kafka**, option 2: "read the messages, process the messages, and finally save its position … This corresponds to the 'at-least-once' semantics"
  ([design.md](https://github.com/apache/kafka/blob/28093d8215b69aa629031673325752484a84b0f3/docs/design/design.md), VERIFIED).
  **Same** as orca/Orchestra: the cursor advances only on `ack` (Orchestra [`bus.ts#L210-L216`](../../src/main/bus.ts), [`ack` `bus.ts:764`](../../src/main/bus.ts)).
  **Different:** a Kafka consumer group shares partitions among competing consumers. Here every mailbox has exactly one reader.
- **SQS FIFO**: "When a message with a message group ID is in-flight, subsequent messages in that group are not made available until the in-flight message is either deleted or the visibility timeout expires"
  ([SQS visibility timeout](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html), VERIFIED).
  This is the closest published analogue of "one outstanding lot per reader" ([`bus.ts#L204-L208`](../../src/main/bus.ts), the unique partial index).
  **Different:** SQS has a visibility timeout (12 h max) and a `maxReceiveCount` redrive to a DLQ. Orca and Orchestra have neither, so a lot stays outstanding until its reader acks it.

### 4. Fencing tokens (INFERRED)

Kleppmann: a fencing token is "a number that increases … every time a client acquires the lock". The **storage server** checks it:
it "remembers that it has already processed a write with a higher token number (34), and so it rejects the request with token 33". And "timeouts are just a guess"
([Kleppmann 2016](https://martin.kleppmann.com/2016/02/08/how-to-do-distributed-locking.html), VERIFIED).
Orca's "Store one active mailbox consumer generation per Run … Rebinding fences the old consumer" and "Bind Delivery acknowledgment to the current consumer generation"
([checklist#L106-L107, L128](https://github.com/stablyai/orca/blob/cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99/ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md#L106)) is that pattern, applied with the bus as the storage server.
Orchestra's coordinator generation ([`bus.ts:1171` `assertCoordinatorGeneration`](../../src/main/bus.ts), [`bus.ts:1299` `fencedWrite`](../../src/main/bus.ts)) works the same way.

### 5. Idempotency keys, outbox, bounded retry (INFERRED; orca's reasoning VERIFIED)

Stripe: the client sends a unique key, "the server simply replies with a cached result of the successful operation"; add "jitter"
([Leach 2017](https://stripe.com/blog/idempotency), VERIFIED). Orca's `mutation_receipts` and Orchestra's [`bus-receipts.ts`](../../src/main/bus-receipts.ts) (`withReceipt`, L132) implement this.
Outbox: "The Message relay might publish a message more than once … a message consumer must be idempotent"
([microservices.io](https://microservices.io/patterns/data/transactional-outbox.html), VERIFIED).
Orca **rejected** a CLI disk outbox for `worker_done` because it "adds a spool file, cross-process claims, a drain trigger, and a new place state can go stale".
It chose a 2-minute retry under one request id instead ([PR #23984](https://github.com/stablyai/orca/pull/23984), VERIFIED). That retry uses fixed backoff (1, 2, 4, 8, then every 15 s), with no jitter mentioned.
Orchestra doesn't have this failure mode: its CLI writes the database directly, so a down app loses nothing (ADR 0002).

### 6. Actor model, Erlang supervision, leases (INFERRED; orca rejects the supervisor half)

Actors are "conceptually based on a single kind of object: actors" ([Hewitt et al. 1973](https://www.ijcai.org/Proceedings/73/Papers/027B.pdf), VERIFIED).
Armstrong: "Processes share no state, but communicate by message passing"; "let it crash"; and a strategy "based on the idea of 'Supervision trees'"
([thesis 2003](https://erlang.org/download/armstrong_thesis_2003.pdf), VERIFIED).
OTP: "if more than MaxR number of restarts occur in the last MaxT seconds, the supervisor terminates all the child processes and then itself"
([OTP supervisor principles](https://www.erlang.org/doc/system/sup_princ.html), VERIFIED).
Orca keeps the mailbox (per-reader mail, no shared state between agents) and **rejects** automatic supervision:
"Silence alone never proves worker death or triggers replacement" / "No automatic retry or replacement based on silence" ([checklist#L47, L55](https://github.com/stablyai/orca/blob/cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99/ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md#L47)).
Orchestra does have OTP-like restart intensity ([`session-wedge.ts:224` `MAX_RECYCLES_PER_HOUR = 3`](../../src/shared/session-wedge.ts), [`:620` `MAX_BOOT_RESTARTS = 3`](../../src/shared/session-wedge.ts), then escalate).
Leases: "Non-Byzantine failures affect performance, not correctness, with their effect minimized by short leases"
([Gray & Cheriton](http://i.stanford.edu/pub/cstr/reports/cs/tr/90/1298/CS-TR-90-1298.pdf), VERIFIED, OCR-garbled).
Orca's agent heartbeat (5 min, stale at 10) is a lease that grants nothing: staleness only logs ([PR #1403](https://github.com/stablyai/orca/pull/1403): "emit one log per stale dispatched row — no auto-fail").
Both orca ([PR #16904](https://github.com/stablyai/orca/pull/16904): "Liveness is `live` / `unverifiable` / `exited` only, from execution-host evidence") and Orchestra (ADR 0002) later moved liveness to host evidence.
Gas Town's docs disagree with each other on this: "observed, not self-reported" ([`agent-provider-integration.md#L615-L616`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/agent-provider-integration.md#L615-L616)) versus the Witness reading "the self-reported state" ([`heartbeats.md#L24-L27`](https://github.com/gastownhall/gastown/blob/649b832b7672bc7a2dbef26f5983aba6198b819b/docs/concepts/heartbeats.md#L24-L27)).

### 7. Durable execution, blackboard, total order (INFERRED, weak)

- **Temporal**: "the Workflow Execution picks up where the last recorded event occurred in the Event History", with replay checked against history ([docs](https://docs.temporal.io/workflow-execution), VERIFIED).
  Orca's open [#9228](https://github.com/stablyai/orca/issues/9228) asks the same of its coordinator: "a restarted coordinator should reconstruct its complete campaign state from the orchestration database".
  **Different:** the coordinator is an LLM, so there is no deterministic replay. Only its *inputs* can be replayed.
- **Blackboard** ([Nii 1986](https://ojs.aaai.org/aimagazine/index.php/aimagazine/article/view/537), VERIFIED abstract only; Hearsay-II 1971–76): independent knowledge sources act opportunistically on a shared board, chosen by a control component.
  Orca and Orchestra are *addressed mailboxes*. The GitHub ledger and decision gates are the nearest board-like parts.
- **Lamport 1978** ([landing page](https://www.microsoft.com/en-us/research/publication/time-clocks-ordering-events-distributed-system/), VERIFIED): one SQLite `AUTOINCREMENT` gives a trivial total order (Orchestra [`bus.ts#L179-L184`](../../src/main/bus.ts)).
  Orca's federation loses that global order across servers (#106 item 4) and keeps only per-stream contiguity: "Acknowledge only the highest contiguous committed sequence" ([checklist#L323](https://github.com/stablyai/orca/blob/cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99/ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md#L323)). That is a TCP-style cumulative ack (INFERRED).

### 8. Orca authors' own later corrections (VERIFIED; not in #104/#106/#110)

- **Capability tokens removed (2026-09-30).** [#23982](https://github.com/stablyai/orca/pull/23982): "The token's only property is 'the caller has read this conversation', which is exactly what breaks on compaction, truncation, re-rendering and secret scanners."
  The replacement is the existing exact-process check plus a **caller-pane fence**: the host resolves the calling terminal from `ORCA_PANE_KEY` and refuses when it is a *different* orchestration party.
  [#23994](https://github.com/stablyai/orca/pull/23994) stopped minting tokens altogether. Orchestra adopted these tokens in [#129](https://github.com/lcsmas/orchestra/issues/129) and still has them.
- **Explicit non-goals** ([checklist#L51-L60](https://github.com/stablyai/orca/blob/cd05f2ff93b52c4b9b4b39e1c65d1a16bb93da99/ORCHESTRATION_IMPLEMENTATION_CHECKLIST.md#L51)): no scheduler; no automatic retry on silence; no replicated Run DB / leader election; "No dead-letter/poison-message workflow".
  Federation is quota-bounded instead ("Return `relay_quota_exceeded`; do not add a dead-letter system", L328; 256 items / 1 MiB per dispatch at
  [`federation-relay-enqueue.ts#L91`](https://github.com/stablyai/orca/blob/e2460907c3331be8c81c09752224278c7e4aa672/src/main/runtime/orchestration/db/federation/federation-relay-enqueue.ts#L91)).
  Long polls are capped at 16 ([`runtime-rpc-long-poll.ts#L6`](https://github.com/stablyai/orca/blob/e2460907c3331be8c81c09752224278c7e4aa672/src/main/runtime/runtime-rpc/runtime-rpc-long-poll.ts#L6)).
- **Coordinator still not restart-durable**: [#9228](https://github.com/stablyai/orca/issues/9228) is OPEN.

---

## Improvement leads

"Already in Orchestra?" was checked by grep/read of `src/main/bus*.ts`, `src/shared/bus*.ts` and `src/cli/bus-verbs.ts` at `6ddecfd0`. Absence claims cover those files only.

| Lead | Source | Already in Orchestra? (file:line) | Value |
|---|---|---|---|
| **Poison-lot bound**: count replays per lot; after N, park it and escalate to the coordinator or human instead of replaying forever | SQS redrive `maxReceiveCount` ([DLQ doc](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-dead-letter-queues.html)); [EIP Dead Letter Channel](https://www.enterpriseintegrationpatterns.com/patterns/messaging/DeadLetterChannel.html). Orca explicitly declines it | **No.** `deliveries` has no replay counter ([`bus.ts#L195-L208`](../../src/main/bus.ts)); `check` replays the outstanding lot unconditionally ([`bus.ts:708`](../../src/main/bus.ts)); the bounded re-wake fires every `REWAKE_BOUND_MS = 5 min` ([`src/shared/bus-wake.ts:260`](../../src/shared/bus-wake.ts)) with no cap | **High.** A lot that kills or wedges its reader (oversized body, a crashing turn) re-wakes that reader indefinitely. SQS warns a DLQ breaks FIFO order, so park and escalate; don't skip |
| **Fence the side effects, not just the bus**: zombie-coordinator protection on git push / merge / release | Kleppmann: the *resource* must check the token | **Partial.** Bus writes by the coordinator are fenced ([`bus.ts:1171`](../../src/main/bus.ts), [`bus.ts:1299`](../../src/main/bus.ts); scope table in [`docs/codebase-map/bus.md` §Coordinator-only fence](../codebase-map/bus.md)). Nothing in the bus files gates git/merge on generation | **High** for destructive acts: the merge is the irreversible step |
| **Re-decide `dcap_` capability tokens** in light of orca removing them; consider a caller-identity fence from process ancestry | [orca #23982](https://github.com/stablyai/orca/pull/23982), [#23994](https://github.com/stablyai/orca/pull/23994) | **Tokens present** ([`bus.ts:1493-1724`](../../src/main/bus.ts)), with rotate-on-retrieve `orchestra token` (bus.md §#167) that softens compaction loss. A process-ancestry caller check already exists for pause ([`pause-trap.ts:264`](../../src/main/pause-trap.ts)) | **Medium.** Removes a class of stranded `worker_done`; `--as` is still a claim (bus.md) |
| **Byte quotas** on message bodies and lots (backpressure) | SQS in-flight limits ([visibility doc](https://docs.aws.amazon.com/AWSSimpleQueueService/latest/SQSDeveloperGuide/sqs-visibility-timeout.html)); orca relay quota 256 / 1 MiB | **No.** `send` validates kind/run/sender only ([`bus.ts:609-632`](../../src/main/bus.ts)); a lot is capped at 100 *rows*, not bytes ([`bus.ts:708`](../../src/main/bus.ts)). There is no message retention either | **Medium.** A lot lands in an LLM context, so bytes are the real budget, and this feeds the poison-lot case |
| Idempotency receipts on retried mutations | Stripe idempotency keys; EIP Idempotent Receiver | **Yes:** `mutation_receipts` (`bus.ts:450`), `withReceipt` ([`bus-receipts.ts:132`](../../src/main/bus-receipts.ts)) | Done. Gap: no retry-with-jitter guidance (Stripe), low value because the CLI writes locally |
| At-least-once via a cursor advanced only on ack, one outstanding lot per reader | Kafka option 2; SQS FIFO group in-flight | **Yes** ([`bus.ts#L204-L216`](../../src/main/bus.ts), `ack` [`bus.ts:764`](../../src/main/bus.ts)) | Done. A **visibility timeout is not needed** while each mailbox has one reader (no competing consumers) |
| Restart intensity, then escalate | OTP MaxR/MaxT | **Yes** at session level ([`session-wedge.ts:224`](../../src/shared/session-wedge.ts), [`:620`](../../src/shared/session-wedge.ts)) | Done. UNVERIFIED: whether a wedged *coordinator* escalates one level up (OTP propagates to the parent supervisor) |
| **Circuit breaker with half-open** probe, if a task DAG is adopted | Nygard via [Fowler](https://martinfowler.com/bliki/CircuitBreaker.html) (closed/open/half-open) | **No DAG** (deferred in [#110](https://github.com/lcsmas/orchestra/issues/110)). Orca's breaker is terminal after 3 failures, with no half-open ([`dispatch-completion.ts#L158`](https://github.com/stablyai/orca/blob/e2460907c3331be8c81c09752224278c7e4aa672/src/main/runtime/orchestration/db/dispatch-context/dispatch-completion.ts#L158)) | **Low–medium.** Only matters with automatic dispatch |
| **Coordinator state reconstruction** from the bus on restart (open gates, unacked lots, last `worker_done` per member as one digest) | Temporal event-history replay; orca's own open [#9228](https://github.com/stablyai/orca/issues/9228) | **Partial.** Read-only `orchestra bus-status` / `run status` exist (bus.md §#134, pause-trap map). A restart digest was not found | **Medium.** Fleet comms already say "state lives in the ledger"; a bus-derived digest would make that mechanical |
| Idempotent ledger projection (bus → GitHub) | Outbox: "the relay might publish a message more than once" | **Not found.** ADR 0002 says the ledger "becomes a projection rendered by the app"; grep found no projection code in `src/main` | Applies when it is built |

---

## VERIFIED (read or fetched this session)

- orca repo at `e2460907` (full commit history, blob-less), founding commit `c9391e20` `db.ts`, checklist at `cd05f2ff`; PR bodies #1188, #1227, #1403, #9925, #16904, #22582, #23475, #23765, #23982, #23984, #23994; discussions #681, #6201; issue #9228. Fetched with `gh`.
- Overstory at `ff38f3f7` plus commits `62f5e50`, `f4b410b3`, `ff4b9fb3`, `f3fb889f`, `6d60636d`; Gas Town at `649b832b` and `mail-protocol.md` at `88f784a9`; Beads and Multica READMEs.
- Orchestra file:line anchors above: read at `6ddecfd0`, 0 commits behind `origin/master`.
- Web (WebFetch, which paraphrases through a small model, so quotes are near-verbatim): intentapp.dev, yegge.ai/gastown, yegge.ai ZFC listing, SQS visibility + DLQ docs, Kleppmann 2016, EIP Dead Letter Channel + Idempotent Receiver, microservices.io outbox, Stripe idempotency, OTP supervisor docs, Fowler circuit breaker, Temporal docs, Claude Code agent-teams docs, Nii 1986 abstract, Lamport landing page, Chubby abstract page, Addy Osmani "Code Agent Orchestra".
- PDFs read locally with pypdf: Hewitt 1973 (first page), Armstrong 2003 thesis, Gray & Cheriton TR (OCR-garbled).
- Kafka delivery semantics from `docs/design/design.md` at `28093d82`, fetched with `gh api`.

## NOT VERIFIED

- **Orca's design doc** `docs/inter-agent-orchestration-design.md` (linked from #1188): never committed; the lineage it might state is unknown. Also unread: the "check-wait design doc", `DESIGN_DOC_STALE_BASE_FIX.md` and `ORCHESTRATOR_FEEDBACK` cited in #1403 (not in history), and Linear STA-8833 (#23984: "the dispatch-capability removal design", which is private).
- Talks, podcasts or social posts by Stably/Lovecast staff: not searched beyond one web search.
- Yegge's Medium launch post (403 again) and ZFC Medium post (only the yegge.ai listing was read).
- Whether orca's authors read Overstory's code rather than reinventing a matching schema: the DDL match is strong but stays INFERRED.
- Nygard's *Release It!*, the Chubby paper body (sequencers), the Hearsay-II paper (Erman et al. 1980), the Kafka docs site (rendered pages returned only navigation; the repo source was used instead).
- Whether any non-bus Orchestra path (ship skill, release script, merge helpers) checks coordinator generation: only the bus files were searched.
- Whether a wedged Orchestra coordinator's escalation reaches the LEAD or human.
