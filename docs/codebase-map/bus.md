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

## Shadow mirror (#116) — the old channel also lands in the bus

Shadow mode (ADR 0002 "coexistence until proven", #108 Q8a). The OLD peer-message
channel stays **authoritative**; the host ALSO writes each send into the bus and
records what the old channel actually did with it, so the two can be compared.
Agents change nothing. Promotion bar: 2 complete waves at 0/0/0 divergence.

### Files

| File | What |
|---|---|
| `src/shared/bus-mirror.ts` | The PURE half — outcome mapping + the divergence accumulator. No Electron imports, so it is unit- and mutation-testable directly. |
| `src/main/bus-mirror.ts` | The IMPURE half — run id, the guarded insert, the report builder. |
| `src/main/bus.ts:492` | `recordMirror` / `mirroredRowCount` (`:517`) / `mirrorRecords` (`:527`) — persistence, in the ONE schema owner. |
| `src/main/bus.ts:172` | Migration **v2**, `mirror_records`. |

### The one invariant

`mirrorDispatch()` (`src/main/bus-mirror.ts:100`) is **read-only with respect to
delivery**: it runs AFTER the old channel produced its result, returns an outcome
(never a `MessageResult`), and never throws. A bus failure LOGS and CONTINUES.

Wired as a **wrapper** — `dispatchMessageRequest` (`src/main/workspaces.ts:2826`)
calls an untouched `dispatchMessageRequestUnmirrored` and returns `res` verbatim.
Deliberately not N calls inside the body: that body has twelve `return`s, and a
per-return mirror is one that silently misses the path added next — which would
surface as a permanently non-zero `missed` nobody could attribute.

### A REFUSED send is NOT mirrored (review F1 — the wave's most serious finding)

`busSend` used to be unconditional, so all four refusal shapes (empty text,
unknown target, message-yourself, inbox write failed) landed as real
`kind='dispatch'` rows — and `bus.check` has no recipient filter, so a reader was
handed messages the **authoritative** channel explicitly refused, inside the
artifact ADR 0002 calls the source of truth. Old channel delivers 1, bus asserts 5.

It was invisible to the very instrument built to detect it: `withdrawn` is
deliberately not `missed`, so the counters read the exact **0/0/0 promotion bar**
while diverging badly. The guard is `outcome === 'withdrawn'` → skip the insert,
**fall through to `ledger.record`** (not an early `return`, which would drop the
event from the ledger). Fixing it by counting refusals as `missed` was explicitly
rejected — that breaks the promotion bar from the other side.

### Both INSERTs are ONE transaction (review F4)

A partial write left a `messages` row that `mirroredRowCount` could not see, so
the ledger scored `missed++` for a message the bus **does** hold — the counter
reporting the exact opposite of the truth, in the passing-looking direction.

### The three outcomes (`outcomeFor`, `src/shared/bus-mirror.ts:52`)

`live` (SDK turn started, PTY write, or a woken agent — `started` maps here),
`inbox` (parked durably), `withdrawn` (`ok:false`). `ok:false` is checked FIRST,
before `delivery`, so a stale field on a failed dispatch can never be recorded as
a delivery. A `withdrawn` send with no bus row is **agreement, not a miss** — the
old channel delivered nothing either.

### Divergence counters — the FROZEN inter-ticket contract (ledger #123 §Seams)

`{ mechanism, missed, duplicate, lostWake }[]`, scoped to a run, wrapped in
`BusDivergenceReport` (`src/shared/bus-mirror.ts:196`) which also carries
`busAvailable`. Three surfaces, ONE builder (`busDivergenceReport`,
`src/main/bus-mirror.ts:191`) so they cannot drift:

| Surface | Anchor |
|---|---|
| IPC `bus:divergence` | `src/main/api-handlers.ts:223` / `:476` |
| socket `/busStatus` | `src/main/hooks-server.ts:378` |
| `orchestra bus-status` | `src/cli/index.ts:1170` |

The counters live in **main-process memory, not in the bus**: D1 says `getBus()`
may be null at any moment, and the counter that must record "the bus was down for
this send" cannot itself live in the bus.

`busAvailable` is printed unconditionally, and that is load-bearing — without it
an all-zero row on a healthy run and an all-zero row taken while nothing could be
written are the same observable.

`duplicate` keys on a host-minted `send_id`, never on the body: two agents sending
identical text are two SENDS. `mirror_records` deliberately carries **no unique
index** on `send_id` — a duplicate must be RECORDABLE, not refused, or the counter
could never leave zero.

### D1 consequence (LEAD reconciliation, ledger #123)

Bus down + an authoritative mechanism → the mechanism reads **OFF for the run**
(`busAvailable: false`) **and** `missed` increments. Both halves, because either
alone is unobservable: counting without saying why, or saying why while forgetting
the sends.

### Gates

`src/main/bus-mirror.test.ts` runs the **real** `dispatchMessageRequestUnmirrored`
body, extracted from source and type-stripped, against a **real** SQLite file —
`workspaces.ts` cannot be imported under `node --test` (Electron platform seam).
The stripper is narrow and asserts what it removed; an audit confirmed all 12
`return`s, 4 `await`s, 10 `if`s and every collaborator survive stripping. A
source-binding test fails loudly if the wrapper shape changes, and has its own
must-fail arm (a body that merely *mentions* `mirrorDispatch` must not satisfy it).

```bash
node --test --experimental-strip-types src/main/bus-mirror.test.ts    # 24 pass
node --test --experimental-strip-types src/shared/bus-mirror.test.ts  #  9 pass
```

**The arms call the SHIPPED `mirrorDispatch`.** Review F2 found that every earlier
reference to it here was a STRING assertion over source text while `runDispatch`
re-implemented the wrapper by hand — so the shipped try/catch, the null-bus branch
and the ledger write never executed, and a mutant throwing on `mirrorDispatch`'s
FIRST LINE left the suite at 1389 pass while production would reject every
`orchestra message` (`workspaces.ts:2789` is a bare, unguarded call). That mutant
now reddens 10 arms.

Mutants seen RED: throw on `mirrorDispatch`'s first line (10 arms) · the F1
withdrawn guard removed (3) · `outcomeFor` moved back outside the `try` (1) · the
F4 transaction unwrapped (1) · a second `trim().slice()` reintroduced (1) · the
duplicate detector removed (3) · `outcomeFor` collapsed to one value (4, T116.3's
own stated disproof) · the v2 migration's table renamed (C11 + 9).

### Not covered here

The run LIFECYCLE (#115 owns `runs` rows; the mirror names a run from
`$ORCHESTRA_RUN_ID` or a per-boot id and never INSERTs into `runs`, which
migration v1 documents as legal). `lostWake` is exposed and tested but is
INCREMENTED by the staleness sweep #117 owns — this ticket ships the counter, not
the sweep. The pane rendering these numbers is #118.

---

# The CLI verbs (#115)

`src/cli/bus-verbs.ts` (the verb bodies) + the five `case` blocks in
`src/cli/index.ts:1252-1344`. Owner of `src/cli/*` for wave B; #116 adds only
`bus-status` there.

## Why these five bypass the socket

Every other verb in `src/cli/index.ts` is an HTTP POST over the app's Unix
socket, so "Orchestra is not running" is a legitimate refusal. These five are
not: decision #108 Q2 says a message must land while the app is **down or
restarting**, and the bus is the source of truth. So `send`/`check`/`ack`/
`ask`/`gate` open `$ORCHESTRA_HOME/bus.sqlite` themselves and write it
concurrently with the app's own connection. WAL plus the mandatory
`busy_timeout` that `bus.ts open()` (`:214`) sets on *every* connection is what
makes that safe — spike #109 measured 7–27 % silent loss without it.

| Verb | Entry | Body |
|---|---|---|
| `send --type <kind> [--to] [--thread]` | `index.ts:1252` | `verbSend` `bus-verbs.ts:160` |
| `check [--ack-previous] [--markdown] [--limit]` | `index.ts:1273` | `verbCheck` `bus-verbs.ts:253` |
| `ack <lot-id>` | `index.ts:1301` | `verbAck` `bus-verbs.ts:277` |
| `ask --to <handle> <q…>` | `index.ts:1314` | `verbAsk` `bus-verbs.ts:308` |
| `gate open … / gate resolve <id> …` | `index.ts:1330` | `verbGate` `bus-verbs.ts:334` |

All five take `--run` (`$ORCHESTRA_RUN_ID`, else `default`) and `--as`
(`$ORCHESTRA_WS_ID`, else `ORCHESTRA_WS_ID_IDENTITY`) — `resolveBusIdentity`
`bus-verbs.ts:68`, refused with a message naming both sources at
`busIdentityOrFail` `index.ts:733`.

## `check` NEVER acks — the invariant the ticket turns on

`verbCheck` (`bus-verbs.ts:253`) has exactly one call to `ack`, gated on
`--ack-previous`. Nothing acks on a reader's behalf: that is the ADR's rule and
it is what makes redelivery safe, because a consumer SIGKILLed between `check`
and `ack` gets the **byte-identical** lot back (same `deliveries.id`, same
`from_seq`/`to_seq`, so the same rows — new arrivals are deliberately not folded
in).

The subtle branch is `--ack-previous` **with no outstanding lot**
(`bus-verbs.ts:262`): `check` has just taken a *fresh* lot, and acking it would
ack messages the caller has not seen. The caller asked to close the *previous*
lot and there was none, so the fresh one is handed over unacked.

`check`'s stdout is JSON by default (`CheckOutput`, `bus-verbs.ts:184`) because
the réveil (#117) orders an agent to run `orchestra check` and parse it;
`--markdown` opts into the human render (`renderLotMarkdown` `:229`).

## `ask` writes and exits

`verbAsk` (`:308`) appends one `question` row and prints its sequence. **No
blocking wait** — an agent's Bash tool caps at 600 s, so a waiting verb would
report a false timeout. The wait is host-driven: the answer is an ordinary bus
message and #117's wake starts a turn. The kind is pinned to `question` rather
than taken from a flag, so an ask cannot be parked under a kind no reader scans.

## Runtime: the ABI seam

`openBusForVerb` (`index.ts:661`) imports `src/main/bus.ts` **dynamically, inside
the try**. Two reasons, both measured:

- A top-level import would make every `orchestra peers`/`message` pay for
  better-sqlite3 and, worse, die at *load* time on an ABI mismatch — turning a
  bus-only problem into a CLI that cannot run at all.
- `require()` is **not** an ABI gate. better-sqlite3 defers the native load to
  the first `new Database()`, so a require-only probe passes under the wrong ABI
  (spike #109's headline finding). `openBusForVerb` returns only after
  `openBus()` has really constructed and migrated.

`describeBusOpenFailure` (`bus-verbs.ts:101`) converts the native
`NODE_MODULE_VERSION` error into a sentence naming the runtime and the fix, and
**carries the original error** rather than swallowing it. Measured, system node
against the Electron-ABI binding:

```
bus: cannot open …/bus.sqlite — the better-sqlite3 native binding does not match
this runtime (node ABI 127, no electron).
  The bus verbs must run under the SAME runtime as the app: the packaged CLI is
  the Electron binary itself (Orchestra.AppImage cli …, ELECTRON_RUN_AS_NODE=1) …
```

RC 1, nothing on stdout, no stack frames. It is deliberately keyed on the error
TEXT, not on `process.versions.modules`: the mismatch is between the runtime and
whichever binding actually resolved, and only the thrown error knows which.

**Exit discipline.** Nothing in `bus-verbs.ts` calls `process.exit()` — under
Electron a bare exit after an await does not terminate in that tick (issue #59).
Refusals go through `index.ts`'s `fail()` (throws `CliFailure`), injected as a
callback (`busCtx` `index.ts:686`), which also makes every verb unit-testable
with no process at all.

`vite.cli.config.ts` sets `inlineDynamicImports: true`: the published `bin` is
`dist-electron/cli.js` and nothing else, and rollup would otherwise answer the
dynamic import with a second hashed chunk the bin entry does not name.

## `ORCHESTRA_BUS_BUSY_TIMEOUT_MS`

`busyTimeoutOverride` (`index.ts:728`) lets a caller pin the CLI's
`busy_timeout` via `$ORCHESTRA_BUS_BUSY_TIMEOUT_MS`. A non-numeric value is
refused rather than silently becoming the 5000 ms default (which would make a
control arm pass while measuring the ordinary configuration); that refusal is
what `bus-verbs.test.ts` still exercises. The T115.1 contention arms in
`scripts/verify-bus-cli-verbs.mjs` no longer read this env var — they drive the
**shipped `open()`+`send()`** (`src/main/bus.ts`) directly with `busyTimeoutMs`
as an argument, in 10 concurrent short-lived processes on the real disk, the
same shape as `scripts/verify-bus-contention.mjs`. This is because looping
`runCli()` back-to-back inside one process to force overlap is impossible: it
ends in `exitAfterFlush()` (`Promise<never>`) whose only post-drain resolution
is `process.exit`, so neutralising exit to keep the loop going makes
`await runCli` never settle — every writer hangs on its first send and the
must-FAIL control passes vacuously (both arms read 10/1000). The env override
remains for anyone who does want to pin the real binary's timeout.

---

# Pane + switches (#118) — the read-only projection and the frozen flags

Appended by #118 (ledger [#123](https://github.com/lcsmas/orchestra/issues/123)).
Wave A's sections above are untouched.

## What this adds

A **read-only** pane rendering the bus (runs → waves nested, messages in total
order, pending lots per reader, open asks/gates, liveness+phase, shadow
divergence counters), and **four per-mechanism switches** — `delivery`, `wake`,
`askGate`, `liveness` — read **at wave start** and **frozen onto the run row**.

| File | What it is |
|---|---|
| `src/shared/bus-switches.ts` | The mechanisms, the freeze, the wire-name mapping, and the startup-notice wording |
| `src/shared/bus-view.ts` | The `BusSnapshot` wire shape the pane renders |
| `src/main/bus-runs.ts` | Run rows + their frozen flags; `busSwitch()` |
| `src/main/bus-settings.ts` | The LIVE switches (store-backed) — deliberately a different module from the frozen read |
| `src/main/wave-run-id.ts` | `walkToRootId` — the pure walk-to-root that gives a workspace its wave anchor (N2), store-injected so it unit-tests |
| `src/main/bus-pane.ts` | The read-only IPC and the snapshot assembly |
| `src/renderer/components/BusPane.tsx` | The pane, incl. the bus-unavailable state |
| `src/renderer/components/BusSwitchSettings.tsx` | Flipping the live switches (a WRITE, deliberately not a pane channel) |

## The freeze — the one thing to understand

`startRun()` (`src/main/bus-runs.ts:91`) snapshots the live switches **once** and
writes them to `run_flags`. Everything that asks "is mechanism X on for this
run?" goes through `runFlags()` (`:166`) or `busSwitch()` (`:184`), which read
**the row**. A human flipping a switch mid-wave changes the store and **nothing
else**: the running run's row is untouched, and the next `startRun` picks the new
value up. Two runs with contradictory flags coexist in one DB by design.

Three details that are load-bearing, each of which was a bug in an earlier draft:

- **The freeze is ONE atomic decision, keyed on the `runs`-row existence**
  (`src/main/bus-runs.ts:94`, F1). `startRun` writes `run_flags` **only when its
  own `runs` INSERT created the row** (`info.changes === 1`). Two independent
  `INSERT OR IGNORE`s were NOT atomic: a `runs` row that existed without a
  `run_flags` row (a run made by a writer predating `run_flags` — #115's CLI
  lifecycle, an older build, a partial v2) would take the `runs` ignore but WRITE
  `run_flags` at the later call, freezing a running run at then-current live
  switches and flipping `busSwitch` ON mid-wave. Now an existing run with no flags
  reads all-OFF forever, never freezable-late.
- **`startRun` reads the row BACK** (`:146`) instead of returning what it meant
  to write. Otherwise a second call *looks* like a re-freeze to its caller while
  the row says otherwise, and the two drift silently.
- **An unknown run reads all-OFF, never live** (`:166`). A mechanism firing
  because its row was missing is indistinguishable in the field from the switch
  genuinely being on.

`freezeSwitches()` (`src/shared/bus-switches.ts:131`) also implements the LEAD's
D1 reconciliation: **bus down ⇒ every mechanism freezes OFF for that run**, and
that is recorded on the row, so the run stays self-describing about why it
behaved as unadopted.

### The contract with #117

```
busSwitch(db, runId, 'delivery' | 'wake' | 'ask_gate' | 'liveness') -> boolean
```

Note `ask_gate` (snake) on the **wire** vs `askGate` (camel) as the internal TS
key. The mapping lives in exactly one place — `mechanismFromWire` /
`mechanismToWire` (`src/shared/bus-switches.ts:174`) — because N copies is how a
wire contract and an enum drift apart. Unknown run **or** unknown mechanism
returns `false`, never a throw: false leaves the old channel authoritative.

## Read-only in v1 — enforced, not promised

`BUS_PANE_IPC_CHANNELS` (`src/main/bus-pane.ts:43`) is the enumeration, and
`registerBusPaneIpc()` (`:298`) **refuses to register** any entry marked
`writes: true`. So adding a v2 write handler requires editing the table, which
turns the test red at the same moment. The switch WRITE lives on its own
`bus:setSwitches` channel registered in `src/main/index.ts`, deliberately outside
that registrar — routing it through the pane would defeat the check.

## `getBus() === null` is normal (D1)

`busSnapshot()` (`src/main/bus-pane.ts:219`) **never throws**: a missing bus, or
a query that throws, both become `available: false` carrying the DB path and the
error. The pane renders that as a loud block (`BusUnavailable`,
`src/renderer/components/BusPane.tsx:282`).

Why `available` exists at all: a down bus and a quiet bus have *identical* empty
runs/messages/gates arrays. Without the flag the pane could not tell them apart —
and "an empty pane indistinguishable from no-messages-yet" is precisely what D1
forbids. The pane's IPC is also registered **before** the open attempt
(`src/main/index.ts`), so a failed open cannot leave `bus:snapshot` unhandled and
blank the pane.

Divergence counters come from #116 through `registerBusCounterSource()`
(`:209`) — a runtime seam rather than a static import, so #118 builds before
#116 lands. An **absent** source renders as an explicit "not publishing counters"
message, never as `0/0/0`: "#116 has not landed" and "zero divergence" are the
same empty array on the wire, and showing zeros for the first would be a
fabricated measurement.

## The startup notice

`writeBusSwitchState(worktreePath, runId)` (`src/main/workspaces.ts:4656`) writes
`.orchestra/bus-switches` on **every spawn**, and
`BUS_SWITCHES_INSTRUCTION_SCRIPT` (`:4032`) cats it on SessionStart.

**It sources from the RUN ROW, never the live switches** (`runFlags(db, runId)`,
F2). The notice's own text says "frozen at wave start — a mid-wave flip does NOT
change them", and the fleet skill BRANCHES on that claim. Reading
`getLiveSwitches()` here (the pre-F2 code) made the claim false: two agents
spawned into one run on either side of a human's flip received CONTRADICTORY
notices, each asserting the opposite — the "half a fleet reads wake=on, the other
half wake=off" split the freeze exists to prevent. `runId` is the workspace's
WAVE ANCHOR = the tree ROOT: `resolveWaveRunId(ws)` walks `parentId` up via
`store.getWorkspace` to the topmost resolvable ancestor (N2, ledger #123). Walking
a single level split a 3-deep tree — LEAD → OPS → IMPL got two ids and froze
against different rows. The pure walk is `walkToRootId` in
`src/main/wave-run-id.ts` (store-free, so it unit-tests: 3-level chain → one root,
a broken link falls back to the deepest resolvable ancestor, a cycle terminates).
An absent run row (no lifecycle yet) or a down bus (D1) reads **all-OFF**, the
coexistence-safe and STABLE default, so "frozen" holds even before a row exists.
No run row is created here — that is #115's lifecycle, not the notice's job.

The state lives in a **file, not a script constant**, for a specific reason:
`installOrchestraHooks` short-circuits on a **hash of the script bodies**, so a
value baked into a body would be written once at provision time and never
corrected.

Every mechanism prints in **both** states (`busSwitchNoticeLines`,
`src/shared/bus-switches.ts:204`), and in the **WIRE name** (`ask_gate` via
`mechanismToWire`, not the internal `askGate` — F4): `delivery=ON — the bus is
AUTHORITATIVE…` or `delivery=OFF — the OLD channel stays authoritative; the bus
only COUNTS this mechanism…`. OFF is never encoded as silence, because an agent
cannot distinguish an OFF switch from a build without switches from a truncated
notice. A missing state file makes the script a **silent no-op** rather than a
false "all off".

`scripts/verify-bus-startup-notice.mjs` (wired as `pnpm run test:bus-notice`)
opens a real bus, seeds run rows, and asserts two notices in ONE run are
BYTE-IDENTICAL across a flip while a NEW run picks the flip up — the INVERTED
freeze gate (the pre-F2 rig asserted they DIFFER, which certified the defect).

## Schema

`MIGRATIONS[2]` in `src/main/bus.ts:193` creates `run_flags` (a sidecar, because
SQLite has no `ADD COLUMN IF NOT EXISTS` and a re-run would throw
`duplicate column name`). **Wave B renumbering rule** (ledger #123 Q-B1): four
tickets each need DDL and `migrate()` applies **by version index**, so two
tickets claiming the same number means the later one's SQL is skipped forever on
a DB already stamped with it. Take the next free number and renumber at rebase.

## Wake-as-turn (#117)

**The host detects new bus rows and ORDERS the reader to check. It never checks
for an agent, and never acks on one's behalf.** Frozen on #108 comments 4-5.

| File | What it is |
|---|---|
| `src/shared/bus-wake.ts` | The wake DECISION — pure, no bus, no session, no Electron |
| `src/main/bus-wake.ts` | The effectful half: reads durable state, fires the turn |
| `src/shared/bus-wake.test.ts` | 11 policy tests; each names the clause it kills |
| `src/main/bus-wake.test.ts` | 10 tests of the pending predicate over a real SQLite bus |
| `src/main/bus-wake-sweep.test.ts` | 15 tests driving the sweep end to end (T117.1–T117.5, D1, Q1 two-run + restart) |

## Why the host watches instead of the agent polling

A turn that runs a blocking `orchestra check` burns against the **600s Bash cap**
and reads as a hang. So the waiting lives where waiting is free — the main
process — and what reaches the agent is a fixed ORDER string
(`WAKE_ORDER`, `src/shared/bus-wake.ts:139`), never the message body. The reader
then runs `orchestra check` itself and acks with its own `orchestra ack`.

## `fs.watch` is NOT the mechanism — only an accelerator

The sweep (`sweepBusWake`, `src/main/bus-wake.ts:251`) is **level-triggered over
durable state**: it reads what is pending *now* and acts on that, with no memory
of which inserts it saw. Three things drive it, and they are not equals:

| Driver | `src/main/bus-wake.ts` | Role |
|---|---|---|
| Startup sweep | `:351` | Fires wakes for inserts that landed while the app was closed |
| 60s interval (`SWEEP_MS`) | `:46`, `:353` | The guarantee — every wake is produced by this alone |
| `fs.watch` on `bus.sqlite-wal` | `:361` | Latency only (spike #109 arm 4: p50 0.23ms) |

Watching the **`-wal`** file, not `bus.sqlite`: in WAL mode the main DB file is
barely touched, so a watch on it misses nearly every insert. Debounced 150ms
(`WATCH_DEBOUNCE_MS`, `:51`) because a `check` writes a delivery row, which
itself touches the WAL — an undebounced watcher re-enters the sweep it caused.

**An edge-triggered design (watch fires → wake) reads identically in every happy
path and loses every wake that lands while the app is closed.** The failure is
invisible precisely because the mechanism that would report it is the one that
is off. `bus-wake-sweep.test.ts`'s T117.3 arm is the discriminator: it inserts
with nothing armed, then requires the first sweep to fire.

## The pending predicate — `readPendingReaders` (`src/main/bus-wake.ts:132`)

Pending = **an unread lot OR an open QUESTION message addressed to the reader**.

The lot half asks *"is there anything past the reader's durable cursor"*, **not**
*"is there an outstanding `deliveries` row"*. Those differ in the case that
matters: a reader that has never checked has **no delivery row at all**, so an
outstanding-row predicate reports the reader that most needs waking as quiet.

The cursor read is `cursors.acked_seq`, which **only `ack()` advances**. So
`check()` alone does not clear pending — a reader SIGKILLed between check and
ack is woken again. Keying on `deliveries.to_seq` instead would rebuild the lying
"Delivered" the bus exists to kill, one layer up.

**Open GATES do NOT wake — deferred to #119 (LEAD §Decisions D2, ledger #123
Q-B3).** The order a wake carries is `orchestra check`, which reads `messages`
only; a `decision_gates` row has no recipient column and there is no `gate list`
verb, so a gate can never be surfaced by the order. An earlier predicate woke on
open gates: the reader was ordered to look where the gate is invisible, acked
nothing, looped, and the shadow `counted` signal over-counted a divergence the
promotion bar reads. Gate-driven wakes move to **#119** (gates get a recipient +
a surfacing verb there). A `kind='question'` MESSAGE is different and STAYS: it
has a recipient and `check` returns it, so the order can surface it. The
must-FAIL arms (`bus-wake.test.ts` predicate + `bus-wake-sweep.test.ts` sweep)
assert an open gate → **0 pending, 0 wakes, 0 counted**, with a question message
as the same-command positive control.

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

The ledger entry is written **before** the `await` on delivery (`:287`) — a
second sweep entering during that yield would otherwise see no entry and fire a
duplicate (the #112 shape). A delivery the seam *refuses* (`sdkStartAndDeliver`
returns `false`, never throws) **withdraws** the entry so the next sweep retries;
treating a refusal as success would suppress every future wake for that lot.

## Two injected seams, and why they are not just for tests

`setWakeRoster` (`:202`) and `setWakeDeliver` (`:225`), wired at
`src/main/index.ts:412` / `:432`.

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
(`src/main/bus-wake.ts:278`), via `setWakeSwitchReader` (`:88`,
`(runId: string) => boolean`), which **defaults to OFF for every run**.
`WakeableReader.runId` (`:196`) is what carries the key.

The **freeze** is then the storage's job — #118 writes the flags onto the run row
when the run starts and never mutates them — which is where it belongs: freezing
is a property of the run's data, not of how long this process has been up. An app
restart mid-run re-reads the same row and behaves identically.

A switch accessor that **throws** is treated as OFF and counted, and does not
take the sweep down for other readers (`:279`): the two wrong answers are
opposite and unequal — defaulting ON fires real wakes on a flag nobody could
read.

The pending predicate is run-scoped for the same reason (`:136`). Unscoped, a
reader is reported pending for another run's traffic and ordered to
`orchestra check`, which — scoped to *its* run by the CLI — returns an empty lot;
nothing is acked, pending never clears, and the reader is woken on every sweep
forever.

The discriminating tests are `Q1 two runs in ONE process`, `Q1 an app RESTART …`
and `a reader is NOT woken for mail in a run it does not belong to`
(`src/main/bus-wake-sweep.test.ts`).

With the switch off `decideWake` returns `count`, **not** `skip`, and
`counters.counted` increments (`busWakeCounters`, `:109`). The distinction is the
whole point: a mechanism whose off-state is indistinguishable from the feature
being absent cannot be observed in shadow, and the switch-off gate arm would be
vacuous.

## D1 — the bus never blocks boot

`readBusDb()` returning `null` makes the sweep log nothing and return (`:254`).
Nothing is lost, because nothing was stored in an event: a bus that comes back is
reconciled by the next sweep. `startBusWake()` is deliberately **not** gated on
`initBus()` having succeeded, and `stopBusWake()` runs **before** `closeBus()`
(`src/main/index.ts:693`) so no timer can fire against a closed handle.

## The E2E — counting turns a reader's transcript would RENDER

`scripts/e2e-bus-wake.mjs` (runner: `scripts/verify-bus-wake-e2e.sh`,
`pnpm run test:bus-wake-e2e`) drives the real sweep against a real SQLite bus and
a **real structured session** through the production `sdkStartAndDeliver` path,
with a stub CLI standing in for the Claude binary. The observable is the
`user-message` AgentEvent — the transcript bubble the reader's human sees.

It is deliberately not the ledger, the predicate, or the delivery seam's return
value: all three are bookkeeping #117's own code writes, so a dedup bug moves
them together and every arm stays green. #112 burned two observables exactly this
way, both failing in the passing direction.

**Which arms discriminate** (stated, because a matrix where every arm counts as a
gate hides which ones are decoration):

| Arm | Kills |
|---|---|
| `coalesce` | the dedup guard — 3 turns instead of 1 |
| `switch_off` | the switch check — fires with the switch off |
| `fires` | a body leak — `bodyLeaks: 1` |
| `check_no_ack` | a host-side ack — 1 turn instead of 2 |
| `real_verb` | a host/CLI run-or-handle mismatch — the ONLY arm proving the order is a command that WORKS |
| `control_second` | nothing; it proves the rig CAN see turn #2, without which every "exactly 1" above would pass on a rig that renders nothing after the first |
| `ack_clears` | nothing on its own — the dedup ledger already suppresses a second wake, so it passes on a build that ignores the ack entirely |

`real_verb` obeys the order through **#115's real `verbCheck`/`verbAck`** — the
same functions the CLI binary calls — and requires the lot to carry the message
the wake was about, then the ack to clear pending *as read back through the
host's own predicate*. Identity comes from `resolveBusIdentity()` on the env
Orchestra sets, never a hand-built `{runId, handle}`: a hand-built one agrees
with the host by construction and proves nothing about whether the two meet.

Three mutants killed by it: host roster on a different run than the CLI resolves
(0 turns); host waking a handle the CLI does not resolve to
(`pendingAfterVerbAck: true`); and `check()` acking on the reader's behalf, which
surfaces as the reader's OWN ack being refused (`verbFailure` set) — the ADR's
central property, caught at the verb rather than at the predicate. Note
`check_no_ack` does **not** catch that third one: it covers a host-side ack in
the predicate, not one inside the CLI verb.

`check_no_ack` exists because a mutant reading the cursor from
`deliveries.to_seq` instead of `cursors.acked_seq` — the host treating its own
hand-off as the reader's confirmation, the exact lying "Delivered" the bus exists
to kill — **survived every other arm**. The ledger masks it everywhere else: the
reader is already marked, so "no second wake" looks identical whether pending
cleared correctly or not. That arm takes the lot, never acks, and clears the
in-memory ledger as a restart would, so durable state is what is under test.

## Running the gates (#115 CLI verbs + #117 wake)

```bash
pnpm run test                                     # includes 25 bus-verb tests; # skipped must be 0
bash scripts/e2e-contained-rig.sh node scripts/verify-bus-cli-verbs.mjs
node --test --experimental-strip-types src/shared/bus-wake.test.ts       # #117 policy
node --test --experimental-strip-types src/main/bus-wake.test.ts          # #117 predicate, real DB
node --test --experimental-strip-types src/main/bus-wake-sweep.test.ts    # #117 sweep end to end
pnpm run test:bus-wake-e2e                                                # #117 real check verb, 6 arms, contained sway rig
scripts/verify-bus-packaged-boot.sh                                       # + the #117 packaged arms
```

The cli-verbs rig is the runtime half and needs the contained sway rig: the verb
arms (T115.2–T115.6) drive **real Electron** (not `ELECTRON_RUN_AS_NODE`, which
degrades it to plain node and hides the #59 exit defect), so they need a
compositor — and no test window may reach the user's screen. Its arms: T115.1
concurrency + its must-FAIL `busy_timeout=0` control · T115.2 ack-replay across a
real SIGKILL · T115.3 app-down · T115.4 check-does-not-ack · T115.5 the ABI
matrix with its positive control · T115.6 `ask` does not block. T115.1 is the one
exception: its writers run the shipped `open()`+`send()` under plain node (ABI
127) rather than real Electron, because Electron 33 rejects
`--experimental-strip-types` and one process per `runCli()` cannot contend (see
`ORCHESTRA_BUS_BUSY_TIMEOUT_MS` above); the packaged ABI-130 runtime is proven
directly by T115.5a/b/c instead.

Each arm gets its **own** `ORCHESTRA_HOME` (`freshHome`). They shared one at
first, and T115.4's reader then took a lot of five messages in an arm that sent
two — the code claim held, but the count was being asserted over state the arm
did not control.

## Not covered here

`run_id` is still an unconstrained string: no verb creates a row in `runs`, so
`messages.run_id` carries no FK (bus.ts's migration comment), and nothing SETS
`ORCHESTRA_RUN_ID` into the agent env yet — so #117's per-run wake keying runs
with the CLI's `'default'` fallback in practice (correct, not yet exercising a
plumbed run id). `--to` is a free-form handle, unvalidated in v1.

## Running the gates (#118 pane + switches)

```bash
node --test --experimental-strip-types src/main/bus-pane.test.ts
                                              # T118.4/T118.5 IN-PROCESS (F3): bundles the real
                                              #   module to CJS, stubs ipcMain in require.cache,
                                              #   and CALLS registerBusPaneIpc()/busSnapshot() —
                                              #   a throw on either's first line goes RED here
node scripts/bus-pane-render-smoke.mjs        # T118.1 — seeded values reach the HTML;
                                              #   every assertion re-run against an EMPTY
                                              #   bus and REQUIRED to fail (vacuity detector)
pnpm run test:bus-notice                      # T118.3 — inverted freeze gate: two notices in
                                              #   ONE run BYTE-IDENTICAL across a flip; new run
                                              #   picks the flip up; ON/OFF/decoy/absent arms
RIG_WAYLAND=<marker-verified> pnpm run test:bus-pane
                                              # T118.4+T118.5 under REAL Electron: bus-down,
                                              #   seeded control arm, broken-table arm, and the
                                              #   registrar refusing a writes:true channel.
                                              #   Refuses RC=3 (not 0) without RIG_WAYLAND (F3)
RIG_WAYLAND=<marker-verified> node scripts/bus-pane-screenshot.mjs
                                              # T118.1 second half — pixels, both states
```

The two `RIG_WAYLAND` rigs **refuse to run** (RC 3) without a marker-verified
headless-sway display, and refuse if X11 `DISPLAY` is set — Electron falls back
to X11 and would reach the human's screen even with a correct `WAYLAND_DISPLAY`.

## Not covered here

Gate resolution from the UI (v2). Who calls `startRun` for a real wave — no
production caller creates runs yet; the pane renders whatever rows exist, and
the run lifecycle is #115's. Counter *production* is #116's; #118 only renders
the frozen shape.

**Run-id surface disagreement (declared, N2 tail — ledger #123).** The notice
keys on the **root workspace id** (`resolveWaveRunId`), but the CLI verbs a
spawned agent runs key on `env.ORCHESTRA_RUN_ID || 'default'` (`src/cli/bus-verbs.ts`)
and #116's mirror on `ORCHESTRA_RUN_ID || host-<ts>`. **Nothing sets
`ORCHESTRA_RUN_ID` into the agent env on master** (grep `workspaces.ts` — no
write), so the two run-id surfaces disagree until a spawn path exports
`ORCHESTRA_RUN_ID=<root>`. This is inert while every switch is OFF (COUNTED, not
fired — coexistence), and unifying them (export the root id at spawn) is a
wave-B-scope-boundary item, not #118's: it needs the run lifecycle #115 owns.

**#117 honest gaps.** The wake unit arms stop at the delivery seam — they prove
the order is handed to `sdkStartAndDeliver`, not that a turn RENDERS in the
reader's session; the E2E arm (`test:bus-wake-e2e`) closes that by counting the
rendered `user-message`, and its `real_verb` arm drives #115's real `orchestra
check`→`ack`. No human eye on the painted turn (stub CLI, not the real Claude
binary), and no live two-agent wake through a running packaged app.

## Asks + decision gates (#119) — questions and gates that wake and re-wake

Wave C, ledger #125. Adopts orca's blocking ask WITHOUT a blocking process, and
puts gate-driven wakes back into the predicate that wave-B D2 deliberately left
out (gates had no recipient and `check` could not surface them).

### Schema — `MIGRATIONS[4]`, `SCHEMA_VERSION=4` (`src/main/bus.ts`)

`ALTER TABLE decision_gates ADD COLUMN recipient TEXT` + partial index
`idx_gates_recipient(run_id, recipient) WHERE resolved_at IS NULL`. A pre-#119
gate row reads `recipient = NULL` after the backfill and wakes NOBODY (the
predicate matches an EXACT recipient) — the coexistence-safe direction.
`migrate()` applies each index exactly once (guarded by `user_version`), so the
`ADD COLUMN` never runs twice; the C11 gate seeds a faithful v<4 state by
dropping the index THEN the column (SQLite refuses to drop a column an index
references).

### Verbs (`src/main/bus.ts`, `src/cli/bus-verbs.ts`)

- `openGate(db, runId, askedBy, question, recipient=null)` — `orchestra gate open
  [--to <recipient>] <question...>`.
- `openGatesForRecipient(db, runId, recipient)` — the read behind BOTH the wake
  predicate ("is R gate-pending") and `check`'s gate surface.
- `orchestra gate resolve <id> --resolution <text>` (positional ruling still
  accepted for back-compat); re-resolve REFUSED (`WHERE resolved_at IS NULL`).
- `orchestra gate list` — open gates addressed to the caller.
- `check` output carries a `gates: [{id, asked_by, question, opened_at}]` array
  (always present, possibly empty) — the wake order is `orchestra check` and
  nothing else, so a gate-woken reader must see the gate in that one verb.

### The wake predicate — TWO switches, ONE order (`src/main/bus-wake.ts`, `src/shared/bus-wake.ts`)

`readPendingReaders` now fills a SEPARATE gate half (`gatePending` /
`gateThroughSeq`) from `openGatesForRecipient`, kept apart from the lot/question
`pending` because it rides the **`askGate`** switch, not **`wake`** — the two
mechanisms flip independently. The sweep reads both switches per reader per run
(`readWakeSwitch` + `readAskGateSwitch`, each in its own try so one throw cannot
mask the other) and passes both to `decideWake(p, session, prev, switchOn,
askGateOn)`, which stays the ONE decision site:

```
fire  iff (pending && wake) || (gatePending && askGate)
count iff (pending || gatePending) && not fire      -- COUNTED, not FIRED
throughSeq = max high-water of only the sources that JUSTIFIED the action
```

Gate ids and message sequences share no numbering, so the ON-source-only
high-water matters: an OFF source must not raise the mark or its
counted-not-fired state is masked next sweep.

### Ask re-wake-until-answered (#108 Q15)

A `question` addressed to R is pending for R while UNANSWERED — answer = a message
threaded to it (`thread_id = CAST(question.sequence AS TEXT)`, what `send --thread
<ask-id>` writes). This is answer-based, NOT cursor-based: acking without
answering does not clear it. The re-arm is the recipient's cursor ADVANCING past
`WakeLedgerEntry.cursorAtWake` (their ack), so re-wakes are bounded by ACKS, not
sweeps — no wake storm. An answered ask clears pending and prunes normally.

### `readWaitingReaders(db, readers): Set<string>` — the export #120 consumes

The SENDER/opener side (distinct from the recipient side above): a reader is
`waiting` when it SENT an unanswered `question` or OPENED an unresolved gate. #120
subtracts this set from its staleness candidates (an asker parked on an ask is
idle-by-design, never stale). Run-scoped; switch-independent (being `waiting` is
durable truth, not a fired mechanism).

### Gates / arms

`src/main/bus-asks-gates.test.ts` (sweep end-to-end) + additions to
`src/cli/bus-verbs.test.ts` and `src/shared/bus-wake.test.ts`. T119.1 ask re-wake
loop; T119.2 gate recipient/resolve/list/re-resolve + check surface; T119.3 the
must-FAIL gate-wake arm (pre-#119 predicate shows ZERO gate wakes) + counted-off;
T119.4 waiting excluded. Each shown RED under one mutation then GREEN.

### Not wired here (deferred, like #117/#118)

`setAskGateSwitchReader` (and `setWakeSwitchReader`) are NOT bound to `busSwitch`
at boot on this branch — the shipped default is OFF (counted, not fired), i.e.
shadow, matching #117/#118. Wiring the accessors to `busSwitch(getBus(), runId,
'wake'|'ask_gate')` at `index.ts` is the promotion step, not this ticket.

---

# Liveness + phase (#120) — host-derived staleness escalation and phase rows

Appended by #120 (ledger [#125](https://github.com/lcsmas/orchestra/issues/125)).
Earlier sections are untouched.

## What this adds

Two host-derived signals, both reusing EXISTING kinds (`escalation`, `status`) —
**no migration** (they were already in the `BusMessageKind` enum since #114):

- **Liveness**: a level-triggered sweep DERIVES staleness from the app's own
  activity signals (the status dot's sources) and writes an `escalation` message
  row to a silent member's COORDINATOR — once per silence, cleared on activity.
- **Phase**: every genuine `orchestra status` note CHANGE writes a `status`
  message row, with NO timer (event-driven off the note write).

| File | What it is |
|---|---|
| `src/shared/bus-liveness.ts` | The PURE policy — `decideEscalation`, `pruneEscalationLedger`, `phaseChanged`, `escalationBody`, `STALE_AFTER_MS`. No Electron/bus imports, so it is unit- and mutation-testable directly. |
| `src/main/bus-liveness.ts` | The effectful half — the sweep, the escalation/status writers, the injected roster/waiting/switch seams, the counters, D1 tolerance. |
| `src/shared/bus-liveness.test.ts` | 14 pure policy tests; each names the mutant it kills. |
| `src/main/bus-liveness.test.ts` | 13 tests over a real SQLite bus (T120.1–T120.4, C4, C5, phase). |

## The one thing to understand — bound on PROGRESS, not wall-clock (acceptance 2)

A member running an 8-minute build is ALIVE, not stale. A naive
`now - lastActivity > 10min` cannot tell a dead session from a slow one: both
look identical to a wall-clock timer once the clock ages past the bound (the
dead-vs-slow-reader trap, `~/.claude/LESSONS.md`). So `decideEscalation`
(`src/shared/bus-liveness.ts`) checks `running` (a turn IS in flight — status
`running`, no turn-end yet) BEFORE the staleness test, and skips it. The activity
clock catches the gap BETWEEN turns; the `running` flag catches an in-flight long
tool call. Guard order is load-bearing and its own test (`running is checked
BEFORE the wall-clock test`) pins it.

## The activity signal is REUSED, not a new probe (ticket boundary)

`getLastActivity(wsId)` (`src/main/hibernation-activity.ts:33`) is the same
in-memory clock the hibernation sweeper reads, fed by `noteActivity` at
`src/main/activity.ts:973` — the one funnel `applyAgentEvent` crosses for EVERY
lifecycle event, incl. tool-call START (`pretool`). The roster
(`index.ts`, wired via `setLivenessRoster`) floors an absent clock at
`getAppStartedAt()` (NOT `createdAt`, which for an old workspace reads as a stall
of days), so a just-launched app never escalates on an empty in-memory map.

## Coordinator routing

A member escalates to its `parentId`, resolved to a LIVE workspace
(`index.ts` roster; a dangling/archived parent → `coordinator: null` → never
escalated, matching `parentId`'s documented dangling semantics). Single hop, not
`walkToRootId`: a worker's coordinator is OPS, an OPS's is LEAD.

## `waiting` is CONSUMED from #119, never reimplemented (seam)

Two exclusions OR together: the app-level needs-input `waiting` WorkspaceStatus
(`ws.status === 'waiting'`, in the roster), and #119's bus-level asker `waiting`
(parked on an open ask/gate). The latter arrives through the injected
`setLivenessWaiting(fn)` seam — #120 MUST NOT reimplement `readPendingReaders`
(#119 owns it). The default returns an empty set (nobody bus-waiting), the
coexistence-safe direction: a missing/failing #119 accessor never SUPPRESSES a
real stall (the app-level `waiting` still excludes needs-input members).

## COUNTED, not FIRED — the `liveness` switch (C5)

Both halves gate on `busSwitch(db, runId, 'liveness')`, read PER SWEEP / PER
NOTE-CHANGE, keyed on the member's run (#118's frozen flags). While OFF, the
escalation sweep increments `counted` and the phase half increments
`countedPhase` but NEITHER writes a row — the old channel (the store's
`statusText` broadcast, untouched) stays authoritative. Ships OFF.

## D1 — the bus never blocks boot

`sweepBusLiveness` and `recordPhaseChange` both tolerate `getBus() === null`: they
return before touching any member (the C4 arm asserts `counted` stays 0, not just
`fired === 0` — a null-db sweep that FALLS THROUGH degrades `busSwitch` to false
and COUNTS the member, the "silent no-op" the D1 rule forbids). A failed
escalation write withdraws the dedup ledger mark so the next sweep retries.

## The phase change-guard is the zero control (acceptance 3)

`dispatchStatusRequest` (`src/main/workspaces.ts`) calls `recordPhaseChange` only
when `phaseChanged(ws.statusText ?? '', text)` — so an UNCHANGED re-set writes
zero rows (the positive control the counter reads zero on). `phaseChanged` is a
pure predicate in `src/shared/bus-liveness.ts` so the zero-control is
mutation-tested without importing `workspaces.ts` (which cannot load under the
strip-types runner).

## Running the gates (#120)

```bash
npx tsc --noEmit                                                          # C1
node --test --experimental-strip-types src/shared/bus-liveness.test.ts   # 14 pure
node --test --experimental-strip-types src/main/bus-liveness.test.ts     # 13 real-bus
pnpm run test                                                            # in the suite; # skipped must be 0
```

Each acceptance arm was shown RED under one mutation (running guard removed,
dedup removed, waiting guard removed, switch gate always-fire, D1 guard removed,
phase switch-gate removed), mutant-string verified live, then GREEN restored.

## Not covered here

`ORCHESTRA_RUN_ID` is still unplumbed on master (#118 N2 tail), so the roster's
`resolveWaveRunId` and the CLI's `'default'` fallback can disagree until a spawn
path exports the root id — inert while the switch is OFF (COUNTED, not fired). No
live packaged two-agent escalation through a running app (the sweep is driven by
a rig with a fake clock, not a real 10-min wall wait). #119's real `waiting`
export is wired at rebase (ledger #125 Q-C1).
