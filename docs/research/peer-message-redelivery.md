# Inter-agent message redelivery & delivery honesty — measured mechanisms

Findings behind [#57](https://github.com/lcsmas/orchestra/issues/57) (peer
messages re-delivered after a quit; `Delivered (live)` reported for messages
that were silently dropped). Companion to
[`cross-session-inbound.md`](cross-session-inbound.md), which covers the *other*
peer channel — the CLI's own `{kind:'peer'}` origin. **This doc is about
Orchestra's own channel** (`dispatchMessageRequest` → `sdkDeliver` → `sdkSend`),
which is a different code path; see the header note in
`src/shared/peer-messages.ts`.

Recorded because each verdict below cost a measurement, and the expensive part
is not the fix but knowing **which candidate mechanism was real**. Three were
proposed for fault (a); one was the cause, one was a precondition, and one was
refuted — a later reader who assumes all three would fix the wrong thing.

---

## Fault (a) — a consumed prompt is re-enqueued on every restart

**Symptom:** the owner observed the same message queued **3×**.

### The three candidate mechanisms, and which actually fired

| # | Candidate | Verdict | Measurement |
|---|---|---|---|
| i | `recoverPendingPrompts`' text predicate never matches a peer envelope | **CONFIRMED — the cause** | envelope 421 chars → backfill-rendered 255 chars; `missing = 1` for an already-consumed message |
| ii | The turn's `result` never fires (quit), so `consume()` never clears | **precondition only** | quit path (`index.ts`) runs no bookkeeping, so the entry survives — but alone this yields ONE recovery then a clear, never a recurrence |
| iii | Read-modify-write race in the `sdkSend` persist duplicates entries | **REFUTED as the cause** | two concurrent sends → `sdkPendingPrompts = ["B"]`. The race **LOSES** an entry; it does not duplicate. Real bug, opposite direction — fixed under fault (b)'s family |

**(i) in full.** `sdkSend` persists the raw `formatPeerMessage` envelope:

```
[message from agent 'X' (id)]\n<body>\n\nReply with: orchestra message id "<reply>"
```

The backfill that produces the comparison text (`agent-transcript.ts`
`pushUserText`) runs `recognizeFormattedPeerMessage` and stores only `<body>` —
header and reply footer stripped, so the message renders as an issue-#56 compact
peer row. The stored string is therefore strictly **longer** than anything on
disk, and

```js
const missing = pending.filter((p) => !userTexts.some((t) => t.includes(p)));
```

is false **by construction** — not by accident of whitespace or truncation. The
entry reads "never ran" on *every* structured-view reopen, forever. That is the
3×: not one duplicated send, but one consumed message resurrected once per
restart.

### Field confirmation (the strongest evidence, and it is not a rig)

Observed on the **unfixed installed build v0.5.257** (renderer UA at
`orchestra.log:33717`), verbatim from `~/.orchestra/logs/orchestra.log:33826`:

```
2026-08-25T10:04:19.940Z [INFO] agent-sdk: re-sending 26 pending prompt(s) lost to a quit for eadee48c-05dd-48b1-b9f6-21e45db5fdd8
```

The live store (`~/.config/orchestra/orchestra/store.json` — the copy under
`~/.orchestra/userData` is a stale stub, disambiguate by mtime) then showed the
accumulation signature, and running **both** predicates over those real entries
through the real backfill:

| | value |
|---|---|
| pending entries fleet-wide that are peer envelopes | **21 of 25** |
| the coordinator's own entries | **17, all 17 peer envelopes** |
| LEGACY predicate would re-send | **17 / 17** |
| FIXED predicate would re-send | **0 / 17** |

Captured as `scripts/fixtures/payloads/pending-prompts.field-capture.json` and
gated permanently by `scripts/verify-peer-redelivery.mjs`.

> **Two things this evidence does NOT say.** The log line fires for *any*
> pending prompt, so the 26 are not necessarily all peer messages; and `26 ≠ 17`
> because the store reading is post-recovery and post-new-traffic. They are two
> measurements of one fault, not one number. The *recurrence* signature is
> workspace `36773f53` re-sending at 09:45 and again at 09:56.

### Why identity, not a better text predicate

Any text predicate is a guess about what a renderer did to the body, and the
renderer is free to change — it already did, for peer rows. So entries carry a
stable key (`src/shared/pending-prompts.ts`) and consumption is decided by key
membership. The key is derived from the *body* rather than minted randomly
because the transcript line was written by the CLI in a previous app run while
the store entry was written by this one: a random id would never appear on disk.

**`key` is a transcript-matching key, NOT an identity.** Entries also carry a
per-send `id`, and consumption is counted as a **multiset**. Deciding it by set
membership dropped messages:

```
2 senders post the same body, 1 turn ran before the quit
  set membership -> recovered 0   <-- the second sender's message is LOST
  multiset       -> recovered 1
```

A drop is the direction the issue explicitly forbids (*a duplicated order is
idempotent against a ledger; a dropped one is silent*).

---

## Fault (b) — `Delivered (live)` for a message that never ran

`dispatchMessageRequest` reported `delivery: 'live'` — printed by the CLI as
`Delivered (live).` — the instant the turn was **pushed onto the session
queue**. A queue push is not a delivery. Four paths discard a queued turn
without running it: `interruptCancellingQueued` (the target pressed Escape),
`consume()`'s `finally` (session ended), `sdkQueueRemove` (tray cancel), and
`sdkStop`. In all four the sender had already been told `live` and was never
corrected.

Only a turn that actually **started** may be reported `live`; everything else
falls back to the durable inbox (the one branch that proves a file write) and is
reported `inbox`. Decision table: `src/shared/delivery-status.ts`.

### Two traps found in the *first* fix, both worth not repeating

**A module-global registrar across a suspension point.** The delivery watcher
was first armed by writing a module-level `pendingWatcherResolve`, read back
inside `sdkSend` **across `await ensureSession`**. `/message` is served
per-connection with no mutex, so two concurrent senders interleave:

```
A arms -> B clobbers during A's suspension -> A's uuid registers B's resolver
       -> A's finally nulls the slot -> B's uuid registers nothing

CONTROL sequential            -> A=started            (instrument discriminates)
CONCURRENT, A ran / B Escaped -> A=inbox, B=**live**  <-- B was DROPPED
```

The fault the mechanism existed to prevent, reachable *through* it. Worse,
awaiting the outcome widened the collision window from microseconds to
`DELIVERY_START_TIMEOUT_MS` (10 s) — normal fleet messaging cadence. Fixed by
passing the registrar as a **parameter** (`sdkSend`'s `onTurnQueued`).

**A timeout that withdrew the watcher but not the turn.** Deleting only the
watcher left the entry on `session.queue`, so it still ran — while the caller,
seeing `timeout`, *also* wrote the inbox. One live turn plus one inbox drain:
fault (a) reintroduced by fault (b)'s fix. `workspaces.ts` already guards this
same race on the wake path. Fixed with `dequeueUnstartedTurn`, safe by
construction because `promptStream` shifts before yielding, so anything still
queued provably has not started.

---

## Rig lesson: a model that omits the suspension point fails in the passing direction

`scripts/verify-peer-delivery-honesty.mjs` originally modelled the watcher as
registered **directly, synchronously, keyed to its own uuid** — no module
global, no `await`. The real path had neither property. The model therefore
could not express either trap above, and it returned

```
all checks passed (fault eliminated)   RC=0
```

**while the headline fault was live.** A green in the direction nobody
investigates.

The durable fix is not "rewrite the model" — it is that nothing was *checking*
that the model still matched. The rig now carries a **source-binding guard**: it
greps `agent-sdk.ts` (comments stripped, so prose about the old design cannot
satisfy a code check) for the structural properties the model assumes, and
**exits 2 refusing a verdict** if any stops holding. It has been watched to fire:
reinstating the module global in real source produces `MODEL DRIFT`, not a pass.

Verified again after two rebases onto moved masters, including one where a
sibling added +95 lines to `agent-sdk.ts` — disjoint subsystem, guard 5/5, and
the guard re-proved live on the rebased file by mutating it.

---

## Gates

| Gate | What it covers |
|---|---|
| `scripts/verify-peer-redelivery.mjs` | fault (a); real backfill over a real captured envelope + the field capture. `--expect-broken` reproduces the legacy predicate |
| `scripts/verify-peer-delivery-honesty.mjs` | fault (b) + F1/F2/F3, driven **concurrently**; source-binding drift guard. `--expect-broken` reproduces all three |
| `src/shared/pending-prompts.test.ts` | key/multiset/ordering contract, incl. the LEAD's resend-shape ruling |
| `src/shared/delivery-status.test.ts` | the honest-status decision table |

Both rigs carry positive controls (a genuinely lost prompt is still recovered; a
genuinely started message is still reported `live`) — without them, "never
redeliver anything" and "never report live" would pass while destroying the
features.
