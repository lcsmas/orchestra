# Fleet bus — SQLite source of truth

One SQLite database per `ORCHESTRA_HOME` at `<home>/bus.sqlite` holding every
fleet message in total order. **The bus is the source of truth; the GitHub
ledger is a projection** — see `docs/adr/0002-fleet-bus-sqlite-source-of-truth.md`.
Vocabulary (Mission / Vague / Lot / Relève / Accusé / Réveil / Ruling / Digest)
is `CONTEXT.md`; ruling Q13 on #108 puts **English in code and CLI**, French in
prose/UI, so the verbs are `send / check / ack / openGate / resolveGate`.

Schema and delivery model are lifted from [stablyai/orca](https://github.com/stablyai/orca)
(MIT), attributed at `src/main/bus.ts:6`.

**Scope as shipped (#114): the module and a boot-time open, nothing else.** No
CLI verbs, no wake, no UI pane, no shadow mirror — those are #115–#121. Nothing
reads or writes the bus yet, and nothing changes for any agent.

## Files

| File | What it is |
|---|---|
| `src/main/bus.ts` | Schema, migrations, `open()`, and the five verbs |
| `src/main/bus-binding.ts` | Which native `.node` to load, and the ABI trap it exists for |
| `src/main/better-sqlite3.d.ts` | Minimal ambient types (the package ships none) |
| `src/main/bus.test.ts` | 18 tests over a real SQLite file; each names the clause it kills |
| `scripts/build-bus-abi.mjs` | Builds both ABIs; gates each by CONSTRUCTION |
| `scripts/verify-bus-contention.mjs` | Spike #109 arm 1 + its must-FAIL control |
| `scripts/after-pack-check.cjs` | Packaged-binary gate (constructs a DB, does not just look) |

## Schema (`src/main/bus.ts:99`, migration v1)

| Table | Role |
|---|---|
| `runs` | A Mission or a Vague. `parent_run_id` carries nested runs (a vague inside a mission) — our extension, not orca's. |
| `messages` | Every message. `sequence INTEGER PRIMARY KEY AUTOINCREMENT` is the **total order**. Typed `kind`, plus `run_id`, `thread_id`, `sender`, `recipient`. |
| `deliveries` | One lot handed to one reader. `acked_at IS NULL` means outstanding. |
| `cursors` | Per `(run_id, reader)` durable position. Advanced **only** by `ack()`. |
| `decision_gates` | A question parked on the bus awaiting a Ruling. |

Schema version lives in `PRAGMA user_version`; `SCHEMA_VERSION` is at
`src/main/bus.ts:91` and `migrate()` (`:228`) applies forward-only migrations. A
DB written by a **newer** Orchestra is refused rather than run against an older
schema's expectations (`:230`).

## The four non-obvious decisions

### 1. `busy_timeout` lives in the ONE `open()` helper — `src/main/bus.ts:201`

Set on **every** connection, read-only ones included, deliberately *outside* the
`if (!opts.readonly)` block. Spike #109 condition 1: without it, 10 concurrent
writers **lose 7–27% of inserts** with no error any caller would notice. Putting
it at call sites is how one connection eventually misses it.

`scripts/verify-bus-contention.mjs` re-measures this on every run, and its
`busy_timeout=0` control **must lose inserts** — a clean control fails the
script, because it would mean the rig created no contention and the passing arm
proved nothing. Measured on btrfs: must-PASS `1000/1000, 0 BUSY, 0 missing bodies` in 4/4
runs; control lost 62–397 (6–40%).

**A vacuity trap worth knowing:** better-sqlite3's constructor *already* defaults
`timeout: 5000` and applies it. So asserting `busy_timeout === 5000` passes even
with the pragma deleted. `bus.test.ts` asserts a **non-default** value (1234) on
a read-only connection instead — the only shape that can actually fail.

### 2. The unique partial index is the primitive — NOT a cursor at take time

```sql
CREATE UNIQUE INDEX idx_deliveries_outstanding
  ON deliveries(run_id, reader) WHERE acked_at IS NULL;
```

At most **one outstanding lot per (run, reader)**. `check()` (`:312`) replays an
outstanding lot from its **frozen** `from_seq`/`to_seq`, so a redelivered lot is
byte-identical and does *not* fold in messages that arrived meanwhile — that is
what makes redelivery safe (spike arm 2).

`check()` writes **no cursor**. Advancing at take time is the naive design the
spike's must-FAIL control used, and it permanently loses a SIGKILLed reader's
lot. Spike arm 2b probed the index directly and found it load-bearing, so
`bus.test.ts` probes it directly too (raw insert must throw
`SQLITE_CONSTRAINT_UNIQUE`, plus two positive controls proving it does not
refuse *everything*).

**The ack belongs to the reader** (#108 round-4 hardening 1): `ack()` (`:361`)
keys on `AND run_id=? AND reader=?`, so nothing can ack on a reader's behalf —
that would rebuild the lying "Delivered" the bus exists to kill.

*Known and deliberate:* the `MAX(acked_seq, excluded.acked_seq)` in `ack()`'s
cursor upsert is **unreachable** through the public API — `ack()`'s idempotence
guard and the unique index both block the only routes to a rewind. It is
defence-in-depth for a future caller (#115's CLI) reaching the upsert another
way, and `bus.test.ts` says so rather than claiming coverage it does not have.

### 3. The ABI trap — `require()` is NEVER the gate (`src/main/bus-binding.ts`)

better-sqlite3 **defers loading its native binding until the first
`new Database()`**. So `require('better-sqlite3')` **succeeds under the wrong
ABI** and returns a plausible false pass. Measured on this repo:

```
node   -e "require('better-sqlite3')"                   → prints OK
node   -e "new (require('better-sqlite3'))(':memory:')"  → NODE_MODULE_VERSION 130 … requires 127
ELECTRON_RUN_AS_NODE=1 electron -e "…new Database…"      → abi 130, construct OK
```

**Every ABI check in this repo constructs a DB** — the boot gate (`initBus()`,
`:452`), `scripts/build-bus-abi.mjs`, and the afterPack hook.

**Two builds exist in a tree that ships one.** node is ABI 127, Electron 33.4.11
is ABI 130, and the binaries are mutually unusable. The AppImage ships **only**
the ABI-130 build — main and the packaged CLI both use it, because
`ELECTRON_RUN_AS_NODE` is *also* 130 (spike condition 5). The ABI-127 copy in
`build/bus-abi/` (gitignored) is a **dev/test artifact**: `pnpm run test` runs on
system node, and Electron-as-node cannot host the suite instead — it bundles node
20.18.3, which has no `--experimental-strip-types`. Without it the bus unit tests
could not construct a real database at all.

`pnpm run build:bus-abi` produces both and asserts a 4-arm matrix (each runtime
constructs with its own binding, **refuses** the other's) plus the require-trap
itself.

### 4. Packaging — the `.node` must leave the asar

A native `.node` cannot be `dlopen`'d from inside `app.asar`. So
`package.json` `build.asarUnpack` carries
`**/node_modules/better-sqlite3/build/Release/*.node`, and `vite.config.ts` keeps
`better-sqlite3` **external** so it stays a runtime `require`.

`scripts/after-pack-check.cjs` gates this — and it **constructs a database with
the packaged binary under the packaged Electron runtime**, not merely checks the
file is present. A build shipping a node-ABI binary would pass a presence check
*and* a require check, then die on the user's machine.

## Boot

`src/main/index.ts:341` calls `initBus()` inside `createMainWindow()` — **after
`new BrowserWindow` (`:308`), not before** — and logs:

```
bus: opened /home/<user>/.orchestra/bus.sqlite (schema v1)
```

The line is emitted **after a real `new Database()` + `migrate()`** — that is the
boot gate; a `require()` would print it under the wrong ABI too.

### THE BUS NEVER BLOCKS BOOT (LEAD ruling D1, ledger #122)

The window opens **first**; the bus opens **after**; a failure is logged loudly
and broadcast on `bus:unavailable` (`:348`) for the UI to surface (#118 renders
it properly), and boot **continues**. An unread subsystem may not brick a working
app — agents, keepers and PTYs stay reachable with no bus at all. Do not "fix"
this back to a fatal pre-window open.

Reconciliation with ADR 0002: "source of truth" means messages are never
*silently* dropped, not that the app dies without the bus.

**The ordering is load-bearing, not incidental.** `initBus()` now runs alongside
a live renderer that can start agent PTYs, so when a later ticket (#115–#121)
makes a subsystem *read* the bus, that reader must tolerate `getBus() === null`.

**Gating this needs four assertions, and a window count is not enough.** Measured:
a mutant restoring `throw e` **passed** a two-arm gate that only counted
toplevels, because the window object is constructed *before* `initBus()` and
lingers as an empty shell after the throw aborts startup. The discriminator is
the `main window ready` line, logged only after the full startup sequence. So
`scripts/verify-bus-packaged-boot.sh` asserts, per arm:

| arm | window | startup | bus |
|---|---|---|---|
| binding intact | present | `main window ready` | `bus: opened … schema v1` |
| binding broken | present | `main window ready`, no `startup failed` | `bus: FAILED to open …` |

Verified in both directions: RC 0 on the fix, **RC 1 on the D1-violating mutant**.

`closeBus()` runs last in `shutdownSubsystems()`; a clean close checkpoints the
WAL back into the main file and truncates it (a crash leaves ~600 KB behind —
spike arm 3), which is hygiene, not durability.

`busPath()` (`:190`) follows `$ORCHESTRA_HOME`, so a dev instance never writes
into the real home's bus (#108 ruling Q3: one DB per home, `run_id` isolates).

## Running the gates

```bash
pnpm run build:bus-abi        # both ABIs + the 4-arm construct matrix
pnpm run test                 # 15 bus tests among the suite; # skipped must be 0
pnpm run test:bus-contention  # 10×100 with its must-FAIL busy_timeout=0 control
npx tsc --noEmit              # the static gate (pnpm run lint is unrunnable here)
```

## Not covered here

Everything past the substrate: wake/`fs.watch` (#108's réveil), the CLI verbs,
the read-only pane, shadow-mode dual-write and its promotion bar, heartbeat
staleness and escalation, fencing/generation bumps. The spike's own NOT VERIFIED
list still stands for scale (aged DB, millions of rows, retention), non-linux
platforms, network filesystems, and `synchronous=NORMAL` under host power loss.

---

# Wake-as-turn (#117)

**The host detects new bus rows and ORDERS the reader to check. It never checks
for an agent, and never acks on one's behalf.** Frozen on #108 comments 4-5.

| File | What it is |
|---|---|
| `src/shared/bus-wake.ts` | The wake DECISION — pure, no bus, no session, no Electron |
| `src/main/bus-wake.ts` | The effectful half: reads durable state, fires the turn |
| `src/shared/bus-wake.test.ts` | 11 policy tests; each names the clause it kills |
| `src/main/bus-wake.test.ts` | 9 tests of the pending predicate over a real SQLite bus |
| `src/main/bus-wake-sweep.test.ts` | 11 tests driving the sweep end to end (T117.1–T117.5, D1) |

## Why the host watches instead of the agent polling

A turn that runs a blocking `orchestra check` burns against the **600s Bash cap**
and reads as a hang. So the waiting lives where waiting is free — the main
process — and what reaches the agent is a fixed ORDER string
(`WAKE_ORDER`, `src/shared/bus-wake.ts:139`), never the message body. The reader
then runs `orchestra check` itself and acks with its own `orchestra ack`.

## `fs.watch` is NOT the mechanism — only an accelerator

The sweep (`sweepBusWake`, `src/main/bus-wake.ts:219`) is **level-triggered over
durable state**: it reads what is pending *now* and acts on that, with no memory
of which inserts it saw. Three things drive it, and they are not equals:

| Driver | `src/main/bus-wake.ts` | Role |
|---|---|---|
| Startup sweep | `:290` | Fires wakes for inserts that landed while the app was closed |
| 60s interval (`SWEEP_MS`) | `:46`, `:292` | The guarantee — every wake is produced by this alone |
| `fs.watch` on `bus.sqlite-wal` | `:299` | Latency only (spike #109 arm 4: p50 0.23ms) |

Watching the **`-wal`** file, not `bus.sqlite`: in WAL mode the main DB file is
barely touched, so a watch on it misses nearly every insert. Debounced 150ms
(`WATCH_DEBOUNCE_MS`, `:51`) because a `check` writes a delivery row, which
itself touches the WAL — an undebounced watcher re-enters the sweep it caused.

**An edge-triggered design (watch fires → wake) reads identically in every happy
path and loses every wake that lands while the app is closed.** The failure is
invisible precisely because the mechanism that would report it is the one that
is off. `bus-wake-sweep.test.ts`'s T117.3 arm is the discriminator: it inserts
with nothing armed, then requires the first sweep to fire.

## The pending predicate — `readPendingReaders` (`src/main/bus-wake.ts:113`)

Pending = **an unread lot OR an open ask/gate addressed to the reader** (#108 Q15).

The lot half asks *"is there anything past the reader's durable cursor"*, **not**
*"is there an outstanding `deliveries` row"*. Those differ in the case that
matters: a reader that has never checked has **no delivery row at all**, so an
outstanding-row predicate reports the reader that most needs waking as quiet.

The cursor read is `cursors.acked_seq`, which **only `ack()` advances**. So
`check()` alone does not clear pending — a reader SIGKILLed between check and
ack is woken again. Keying on `deliveries.to_seq` instead would rebuild the lying
"Delivered" the bus exists to kill, one layer up.

`asked_by <> ?` excludes the asker's own gate: otherwise a reader that opens a
gate wakes itself forever, since answering is someone else's act.

## Dedup: ledger PRESENCE, not a sequence comparison

`decideWake` (`src/shared/bus-wake.ts:98`) suppresses when the reader already has
a ledger entry. **Recorded disproof:** this first compared a high-water sequence
(`wokeThroughSeq >= pendingThroughSeq`). Three inserts arriving while the reader
is mid-turn come in at *rising* sequences (5, 6, 7), each passes that test, and
the reader is woken **three** times — the exact failure T117.2 exists to catch,
shipped by the guard meant to prevent it.

The only re-arm is `pruneWakeLedger` (`src/shared/bus-wake.ts:123`) dropping the
entry once the reader's own ack clears its pending state. That is the right
shape: one order to `orchestra check` covers everything outstanding when the
reader obeys it.

The ledger entry is written **before** the `await` on delivery (`:250`) — a
second sweep entering during that yield would otherwise see no entry and fire a
duplicate (the #112 shape). A delivery the seam *refuses* (`sdkStartAndDeliver`
returns `false`, never throws) **withdraws** the entry so the next sweep retries;
treating a refusal as success would suppress every future wake for that lot.

## Two injected seams, and why they are not just for tests

`setWakeRoster` (`:170`) and `setWakeDeliver` (`:193`), wired at
`src/main/index.ts:412` / `:423`.

Mechanically: `store.ts` and `sdk-delivery.ts` both reach imports through
extensionless paths that node's `--experimental-strip-types` runner cannot
resolve, so importing them here would make the whole module — and the pending
predicate with it — untestable under `pnpm run test`.

But the delivery seam is also **where the gate counts turns**. Counting the dedup
ledger or the pending predicate instead would count bookkeeping this module's own
code writes, so a dedup bug would move them together and every arm would stay
green (the #112 lesson: count the observable the bug does not also touch).

## The switch — COUNTED, not FIRED, and frozen PER RUN

**"The run" is a bus `run_id`, not the app process.** This distinction is the
entire content of ledger #123 Q1, and getting it wrong is invisible to every
gate in this ticket.

An earlier version cached one boolean in `startBusWake()` and reused it for every
sweep. That is correct for a single run and *cannot* be right for two: run A
frozen OFF and run B frozen ON are the normal steady state of a fleet mid-wave,
and one process-wide boolean must answer the same for both. The defect is not in
any clause a mutant could delete — it is in **which event the value binds to** —
so all 17 mutants and all of C1–C10 passed on it, and the switch-off gate arm
(`wakes == 0 && counted == 1`, within one run) was correct and blind.

So the switch is read **per sweep, keyed on the run the reader belongs to**
(`src/main/bus-wake.ts:265`), via `setWakeSwitchReader` (`:70`,
`(runId: string) => boolean`), which **defaults to OFF for every run**.
`WakeableReader.runId` (`:170`) is what carries the key.

The **freeze** is then the storage's job — #118 writes the flags onto the run row
when the run starts and never mutates them — which is where it belongs: freezing
is a property of the run's data, not of how long this process has been up. An app
restart mid-run re-reads the same row and behaves identically.

A switch accessor that **throws** is treated as OFF and counted, and does not
take the sweep down for other readers (`:266`): the two wrong answers are
opposite and unequal — defaulting ON fires real wakes on a flag nobody could
read.

The pending predicate is run-scoped for the same reason (`:120`). Unscoped, a
reader is reported pending for another run's traffic and ordered to
`orchestra check`, which — scoped to *its* run by the CLI — returns an empty lot;
nothing is acked, pending never clears, and the reader is woken on every sweep
forever.

The discriminating tests are `Q1 two runs in ONE process`, `Q1 an app RESTART …`
and `a reader is NOT woken for mail in a run it does not belong to`
(`src/main/bus-wake-sweep.test.ts`).

With the switch off `decideWake` returns `count`, **not** `skip`, and
`counters.counted` increments (`busWakeCounters`, `:90`). The distinction is the
whole point: a mechanism whose off-state is indistinguishable from the feature
being absent cannot be observed in shadow, and the switch-off gate arm would be
vacuous.

## D1 — the bus never blocks boot

`readBusDb()` returning `null` makes the sweep log nothing and return (`:221`).
Nothing is lost, because nothing was stored in an event: a bus that comes back is
reconciled by the next sweep. `startBusWake()` is deliberately **not** gated on
`initBus()` having succeeded, and `stopBusWake()` runs **before** `closeBus()`
(`src/main/index.ts:684`) so no timer can fire against a closed handle.

## Running the gates

```bash
node --test --experimental-strip-types src/shared/bus-wake.test.ts       # policy
node --test --experimental-strip-types src/main/bus-wake.test.ts          # predicate, real DB
node --test --experimental-strip-types src/main/bus-wake-sweep.test.ts    # sweep end to end
```

## Not covered here

The switch STORAGE and its pane (#118), the CLI verbs the order names (#115),
and the shadow mirror's counters (#116). Honest gap: the unit arms stop at the
delivery seam — they prove the order is handed to `sdkStartAndDeliver`, not that
a turn RENDERS in the reader's session.
