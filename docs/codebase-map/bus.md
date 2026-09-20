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
| `src/main/native-pin.ts` | **(#126)** The ONE generic pinned-native resolver — every `.node` loads from `app.asar.unpacked`, refusing the in-asar duplicate |
| `src/main/bus-binding.ts` | better-sqlite3-specific layer: composes `native-pin.ts` + the wrong-ABI construct gate |
| `src/main/native-pin.test.ts` | **(#126)** 7 tests: packaged path logic + the resolution-contrast must-FAIL (bare require = in-asar, pinned = refuses) |
| `src/main/better-sqlite3.d.ts` | Minimal ambient types (the package ships none) |
| `src/main/bus.test.ts` | 18 tests over a real SQLite file; each names the clause it kills |
| `scripts/build-bus-abi.mjs` | Builds both ABIs; gates each by CONSTRUCTION |
| `scripts/verify-bus-contention.mjs` | Spike #109 arm 1 + its must-FAIL control |
| `scripts/verify-native-manifest.mjs` | **(#126)** afterPack enumeration gate + its add/remove must-FAIL arms |
| `scripts/after-pack-check.cjs` | Packaged-binary gate: enumerates EVERY `.node` vs a manifest, constructs each loadable one |

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

### 4. Packaging — the `.node` must leave the asar (generalised to EVERY native module, #126)

A native `.node` cannot be `dlopen`'d from inside `app.asar`. So
`package.json` `build.asarUnpack` carries a glob **per native module**
(`**/node_modules/better-sqlite3/build/Release/*.node` AND
`**/node_modules/node-pty/build/Release/*.node`), and `vite.config.ts` keeps both
**external** so they stay runtime `require`s.

**The pin (`src/main/native-pin.ts`, #126).** `asarUnpack` COPIES rather than
moves, so a packaged app carries each `.node` (and its JS) in BOTH `app.asar` and
`app.asar.unpacked`. A BARE `require` can silently resolve the in-archive copy —
"correct only by coincidence". `requirePinnedNative(module, probeRel)` loads a
module from its UNPACKED package dir and REFUSES loudly if the pinned binary is
absent, never falling back. `bus-binding.ts` composes it for better-sqlite3;
`transport/local-pty.ts` routes node-pty through it.

**Per-module ABI (measured #126, do not re-derive):** better-sqlite3 is a raw V8
addon (`node_register_module_v127`), NODE_MODULE_VERSION-pinned, and DEFERS its
native load — so `require()` is a false green under the wrong ABI; only
CONSTRUCTING a DB proves it. node-pty@1.1.0 is **N-API** (`napi_*`), ABI-stable,
and loads its native at IMPORT time — a successful require IS its proof, and it
has no wrong-ABI to refuse. So #126's core gate is RESOLUTION (pin vs in-asar),
not ABI, for BOTH modules.

`scripts/after-pack-check.cjs` gates this — it **enumerates EVERY shipped `.node`
and asserts the set exactly equals a manifest** (`EXPECTED_NATIVE`), then
**CONSTRUCTS/loads each module that runs on this platform under the packaged
Electron runtime**, not merely checks presence. A count-only check is not enough
(two wrong sets can share a count), so the diff names both directions; an
unexpected `.node` is a new native dep nobody pinned. `scripts/verify-native-manifest.mjs`
proves the add/remove must-FAIL arms; `native-pin.test.ts` proves the
resolution-contrast arm; `verify-bus-packaged-boot.sh` §7 asserts node-pty
constructs in the real packaged AppImage.

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
pnpm run test                 # bus + native-pin tests among the suite; # skipped must be 0
pnpm run test:bus-contention  # 10×100 with its must-FAIL busy_timeout=0 control
pnpm run test:native-manifest # (#126) afterPack enumeration + add/remove must-FAIL arms
npx tsc --noEmit              # the static gate (pnpm run lint is unrunnable here)
# (#126) packaged boot gate — asserts bus AND node-pty CONSTRUCT in the AppImage:
bash scripts/verify-bus-packaged-boot.sh   # needs a fresh `pnpm run build` first
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
`kind='dispatch'` rows — and at the time `bus.check` had no recipient filter, so a
reader was handed messages the **authoritative** channel explicitly refused,
inside the artifact ADR 0002 calls the source of truth. Old channel delivers 1,
bus asserts 5. (**#144** later added the recipient filter to `check` — see the
#144 section below; a REFUSED send is still not mirrored, and now even a mirrored
one is only handed to its actual recipient.)

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

The run LIFECYCLE — **#134 now creates the `runs` row at the wave anchor** (see
the #134 section below); the mirror still names a run from `$ORCHESTRA_RUN_ID`
(plumbed by #134 in the agent env) or a per-boot `host-…` id in the MAIN process,
and never INSERTs into `runs` itself. `lostWake` is exposed and tested but is
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
run ANCHOR = its NEAREST ORCHESTRATOR (LEAD ruling D1, ledger #135 — this
OVERTURNED the earlier tree-root model of #118 N2): `resolveWaveRunId(ws)` calls
`nearestOrchestratorId(ws, store.getWorkspace)`, which returns `ws` if it
`canOrchestrate` else the first `canOrchestrate` ancestor (an OPS is a promoted
worktree carrying the flag — NOT `kind==='orchestrator'` alone), else `ws` (a
plain standalone spawn is its own run). The pure walk lives in
`src/main/wave-run-id.ts` (store-free, unit-tested: member→OPS not LEAD, a
capability-flag promoted worktree is the anchor, standalone→self, broken link,
cycle). `walkToRootId` is retained there for any tree-root caller but is NOT the
run anchor. `parentOrchestratorId` gives the nested `parent_run_id`. **#134 now
CREATES the run row here-adjacent** (see the #134 section); an absent run row or a
down bus (D1) still reads **all-OFF**, the coexistence-safe STABLE default, so
"frozen" holds even before a row exists.

The state lives in a **file, not a script constant**, for a specific reason:
`installOrchestraHooks` short-circuits on a **hash of the script bodies**, so a
value baked into a body would be written once at provision time and never
corrected.

**#142 — a re-parent re-derives the run and REWRITES this notice.** The run anchor
is derived at creation, but `attach`/`detach`/`adopt`/`demote` move the tree. On
any such op, `reconcileRunAfterReparent` (`workspaces.ts`) re-derives the anchor
and calls `writeBusSwitchState(worktreePath, newRunId)` for the new run, then
restarts the session conversation-preserving (#111) so its `$ORCHESTRA_RUN_ID` env
is re-read — or, with `--no-restart`, marks the workspace 'stale run' (the
`busRunStale` store flag + a `.orchestra/bus-run-stale` marker) and the store-less
CLI `send` refuses from it until restart. See `docs/codebase-map/workspaces.md`
§"Re-parenting re-derives the bus run (#142)". The pane lists stale workspaces via
`BusSnapshot.staleRunWorkspaces` (`registerStaleRunSource` seam).

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

### Who consumes the notice: the fleet protocol skill (#121)

The one reader of these notice lines is the **`verified-fanout` fleet-protocol
skill** (`~/.claude/skills/verified-fanout/SKILL.md`, canonical, git-tracked in
the user's dotfiles repo — NOT restated here; that file is the source of truth
for how a fleet coordinates). The skill has one section per mechanism, each
CONDITIONED on the switch state this notice announces, so a spawned agent obeys
**exactly one channel** per mechanism:

| Wire name (`busSwitchNoticeLines`) | `=OFF` → old channel authoritative | `=ON` → bus authoritative |
|---|---|---|
| `delivery` | ledger/`orchestra message` (unordered, pull-first) | `send` / `check` / `ack` |
| `wake` | self-wakeup rule (`ScheduleWakeup`) + lead ~15-min cron | host wake (Réveil); self-wakeup retired |
| `ask_gate` | ledger §Open-questions + one-line ping | `ask` / decision gates (`gate open`/`resolve`) |
| `liveness` | lead 15-min heartbeat cron | host-derived escalation |

The lead's ~15-min cron serves BOTH `wake=OFF` (waking a sleeping fleet) and
`liveness=OFF` (staleness detection), so it is retired only when **both** `wake`
and `liveness` are ON; with exactly one ON it stays, narrowed to the OFF one.

The switch is READ, never guessed: the skill greps the notice for the literal
`- bus switch <wire>=ON …` / `=OFF …` strings this file emits. The wire names
(`ask_gate`, not the internal `askGate`) are the contract — see `F4` above and
`mechanismToWire` in `src/shared/bus-switches.ts`. Channel-INDEPENDENT rules
(delete gate, verify-landed, adversarial review, the close-out sweep, prose
rules) are unaffected by any switch and live unconditionally in the skill.

The `=ON` CLI surfaces shipped with #119/#120 and the skill names them: `send`
(`--type`/`--to`/`--thread`) / `check` / `ack` for delivery; `ask --to`, the
threaded `send --thread <ask-id>` answer, and `gate open --to` / `gate resolve
--resolution` / `gate list` for ask_gate; app-derived `escalation`/`status` rows
(no agent-side verb) for liveness. Every anchor resolves against the BUILT CLI
(`node dist-electron/cli.js --help`), not the stale installed binary. The v1
default notice still prints `=OFF` for every switch, so an agent routes to the
old channel until a run's switch is flipped — the safe coexistence default.

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
process — and what reaches the agent is an ORDER, never the message body. The
order NAMES the run(s) to check (#134 D2): `buildWakeOrder` emits a header + one
`orchestra check --run <r>` line per run with pending mail for the reader
(`src/shared/bus-wake.ts`). The reader runs exactly those checks itself and acks
each with its own `orchestra ack`.

**#162 — coalesce UNSTARTED queued wake orders at DELIVERY time.** During a long
turn an ack mid-turn re-arms the ack-based re-wake (T117.2) while new mail fires a
fresh, individually-justified wake order — so identical orders pile up behind the
running turn (canary-5 '2 queued'). The fix lives in the queue enqueue path
(`sdkSend`, `src/main/agent-sdk.ts`): a fresh wake order MERGES into an unstarted
wake-order turn already queued (union of named runs) instead of appending a second
turn. Every entry in `session.queue` is unstarted by construction (the running
turn was `shift()`ed off in `promptStream`), so a STARTED turn is never touched.
The decision is the pure `coalesceWakeOrderInto(incomingText, queuedTexts)`
(`src/shared/bus-wake.ts`) — keyed on `isWakeOrder` for both sides, so ordinary
prompts and #112's duplicate-prompt guard are unaffected. This governs QUEUEING;
the engine-side ledger dedup in the sweep (which governs FIRING) is unchanged.

## `fs.watch` is NOT the mechanism — only an accelerator

The sweep (`sweepBusWake`, `src/main/bus-wake.ts:470`) is **level-triggered over
durable state**: it reads what is pending *now* and acts on that, with no memory
of which inserts it saw. Three things drive it, and they are not equals:

| Driver | `src/main/bus-wake.ts` | Role |
|---|---|---|
| Startup sweep | `startBusWake()` → `sweepBusWake()` | Fires wakes for inserts that landed while the app was closed |
| 60s interval (`SWEEP_MS`) | `SWEEP_MS` const + `setInterval` in `startBusWake()` | The guarantee — every wake is produced by this alone |
| `fs.watch` accelerator | `armBusWalWatcher()` | Latency only (spike #109 arm 4: p50 0.23ms) |

**#149 — watch the DIRECTORY, filter by the `-wal` basename** (`armBusWalWatcher()`,
`src/main/bus-wake.ts`). The accelerator targets `bus.sqlite-wal` (not
`bus.sqlite`: in WAL mode the main file is barely touched and a watch on it misses
nearly every insert), but it arms `fs.watch` on the **parent directory** and
filters events to the `bus.sqlite-wal` filename — NOT `fs.watch` on the `-wal`
file itself. An inode-pinned watch dies **silently** when SQLite recycles the WAL:
measured on btrfs (ledger #151 STEP 1, `scripts/diag-149-wal-watch.mjs`), the
`-wal` is unlinked on the last WAL-mode connection's close and recreated at a NEW
inode on the next write (32138494 → 32138511), after which an inode watch delivers
0/10 cross-process inserts while a directory watch delivers 10/10 — and the
`FSWatcher` never emits `'error'`, so a fallback-on-throw could never fire.
`wal_checkpoint(TRUNCATE)` alone does NOT recycle the inode (it truncates in
place); the trigger is any lifecycle that DELETES `-wal`. The **proven**
silent-detach path is boot-time: after a clean quit `closeBus` checkpoints `-wal`
away, so an inode `fs.watch` armed at the next boot can `ENOENT` (or bind a
stale/soon-recycled inode) and the whole session then rides the 60s sweep. Whether
the canary-3 58.84s live-session worst case was ALSO a recycle is **UNCONFIRMED** —
review-149 measured the inode stable across 2nd-connection churn (×50), 2000
inserts and every checkpoint mode while ONE persistent connection is held open, as
the app does mid-session; the app only closes the bus at quit. So the fix is
strictly safer and closes a real boot-time case, but the exact live-session
trigger is not pinned to the recycle. A directory watch is immune to all of these
because the parent directory's inode is stable. Debounced 150ms
(`WATCH_DEBOUNCE_MS`) because a `check` writes a delivery row, which itself touches
the WAL — an undebounced watcher re-enters the sweep it caused. A `null` filename
(platform-dependent) is treated as a match: a spurious idempotent sweep is cheaper
than a missed wake. Gates: `bus-wake-watcher.test.ts` (drives `armBusWalWatcher()`
end-to-end on btrfs — the recycle arm reddens if reverted to an inode watch;
`__setWatcherEnabledForTests(false)` is the must-FAIL control) + the packaged-app
latency rig (`scripts/verify-149-wake-latency.mjs`, measuring send→watcher-trigger
latency p95=274ms; the DELIVERED wake is ≈ +150ms debounce + deliver, still ≪2s).

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

## Dedup: TWO AXES, each re-armed by its own signal (#150 F1 + D-H1)

`decideWake` (`src/shared/bus-wake.ts:307`) tracks the LOT and GATE high-waters
**separately** on the ledger entry (`WakeLedgerEntry.wokeLotSeq` / `.wokeGateSeq`),
because they re-arm on different signals and their numbers are not comparable — a
`messages.sequence` and a gate id share no numbering. A reader is suppressed
(`skip 'already-woken'`) only when NEITHER axis is active; either axis being active
issues ONE coalesced order. Each axis records its own mark, and the inactive axis's
mark is **carried forward** so a lot re-arm never resets the gate mark (or gates
would spuriously re-fire).

- **LOT axis** — `lotAxisReArmed` (`:253`): re-arms when the reader's cursor **in
  the woken run** reaches `wokeLotSeq` (it obeyed the order). PER-RUN: `wokeLotSeq`
  is a global seq recorded against `wokeRunId`, cursors are per-run, so it is only
  comparable to the cursor of that same run. `readPendingReaders` supplies
  `cursorByRun` for every RELATED run (`src/main/bus-wake.ts:316`) because the woken
  run may no longer be newest-pending this sweep. Ask readers
  (`reWakeUntilAnswered`) are excluded — they keep their effectful `cursorAtWake`
  re-arm (`src/main/bus-wake.ts:549`).
- **GATE axis** — `gateAxisReArmed` (`:281`): re-arms when the max OPEN gate id
  (`gateThroughSeq`) EXCEEDS `wokeGateSeq` — a genuinely new gate opened. NEVER the
  message cursor. A plain `>` is safe here (unlike lots) because `gateThroughSeq` is
  the max of currently-open gates, so it rises only on a new gate and a resolved
  gate drops out — no rising-before-ack shape.

**Recorded disproof (three, do not re-derive):** (1) a raw high-water
(`wokeThroughSeq >= pendingThroughSeq`, or a bare `>`) on the LOT axis: three
inserts mid-turn arrive at rising seqs (5,6,7) with the cursor UNMOVED, each passes
→ **three** wakes (T117.2). The lot re-arm keys on the CURSOR, not pending rising.
(2) The pre-#150 pure `if (previous) skip`: a reader that acked through N but held
OLDER unacked mail kept a non-empty pending set, so `pruneWakeLedger` never dropped
the entry and mail N+1 never woke it (live repro 3 msgs / 14 min, #147 C5).
(3) A SINGLE-RUN cursor compare (review-150 F1): `cursorSeq` is the cursor in the
CURRENT sweep's newest-mail run, but the recorded seq belongs to a possibly-
DIFFERENT run — acking woken run A while new mail is newest in run B reads B's
cursor (0) against A's seq and skips forever. Closed by `wokeRunId` + `cursorByRun`.
And the GATE version of the SAME class (D-H1): folding the gate into the lot's
cursor re-arm (or excluding gates entirely) starves a new gate that opens while an
earlier one is read-not-resolved — the gate axis fixes it, and its OFF-state count
is now taken (the pre-fix `skip` preceded the count branch → undercounted re-armed
gates; the rider fix makes a re-armed gate under `askGate=OFF` COUNT). Every re-arm
arm (pure + real-bus `bus-wake-sweep.test.ts`) reddens on the single-axis presence
dedup.

`pruneWakeLedger` (`src/shared/bus-wake.ts:383`) still drops the entry when the
pending set EMPTIES (the whole-set re-arm); the per-axis re-arms above cover the
case where OTHER pending keeps the set non-empty. Known bound: with `wake=ON` and
`askGate=OFF` a single coalesced `fire` action does not separately COUNT a
simultaneously-counted gate axis; this wave runs both switches together so the case
is not reachable (the promotion plan flips both at once).

## Two dedup ledgers: a COUNT must not arm the FIRE dedup (#153)

The sweep keeps **two** ledgers, not one (`src/main/bus-wake.ts`): `ledger` (the
FIRE dedup — only a delivered `fire` writes it, mark-before-await #112) and
`countLedger` (the COUNT dedup — only a switch-OFF `count` writes it). `decideWake`
takes BOTH prior entries (`previousFire`, `previousCount`) and each axis dedups
against the ledger it would WRITE this sweep: the FIRE ledger when its switch is ON,
the COUNT ledger when OFF (`lotPrev`/`gatePrev`, selected per axis because the two
switches flip independently).

**Why (canary-4 F-C4-1, ledger #152).** Pre-fix `ledger.set(...)` ran BEFORE the
`action.kind === 'count'` branch, so a counted (never-delivered) would-have-woken
recorded `wokeLotSeq` exactly like a real fire. But `lotAxisReArmed` re-arms only
when the reader's cursor reaches `wokeLotSeq`, and a **counted reader was never
woken → never acked → its cursor never reaches the mark**. So after a mid-process
OFF→ON flip every ON-sweep skipped it `already-woken` — the C5 eternal-sleep shape
(#150) reintroduced by the SHADOW path. With separate ledgers a counted reader has
an EMPTY fire ledger, so the first ON-sweep after new mail fires the full pending;
counts still dedup against counts, so the shadow counter measures WAKES, not 60
sweep-ticks a minute. Not a steady-state defect (an always-ON boot fires, an
always-OFF boot only counts) — every canary/tick cycle crosses the transition.

Gates (`bus-wake-sweep.test.ts`): `#153 acceptance 1` (counted under OFF, flip ON +
NEW mail → FIRES the full pending — the live repro; reddens under the pre-fix mutant
that writes the count into the fire ledger), `acceptance 2` (steady-state ON dedup
intact), `acceptance 3` (counting still counts once across N sweeps and delivers
nothing — counts dedup vs counts).

The FIRE ledger entry is written **before** the `await` on delivery (`src/main/bus-wake.ts:597`) — a
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
`(runId: string) => boolean`). It defaults to `() => false` (every run OFF) and
is **wired in production by #134** (`src/main/index.ts`, beside `startBusWake()`)
to `(runId) => { const db = getBus(); return db ? busSwitch(db, runId, 'wake') : false; }`
— reading the flag frozen on the run row, tolerating a null bus (D1).
`setAskGateSwitchReader` is wired the same way to `busSwitch(db, runId, 'ask_gate')`.
Before #134 these stayed the `() => false` default (never wired), so **even a run
frozen wake=ON was counted, never fired** — the defect #134 closes.
`WakeableReader.runId` (`:196`) is what carries the key; #134 sets it to
`resolveWaveRunId(ws)` (was hardcoded `'default'`).

The **freeze** is then the storage's job — the run row's flags are written **once,
at the anchor, by `startRun` (#134 — see below)** and never mutated — which is
where it belongs: freezing is a property of the run's data, not of how long this
process has been up. An app restart mid-run re-reads the same row and behaves
identically.

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

Gate resolution from the UI (v2). Who calls `startRun` for a real wave — **#134
now does** (`maybeStartRunAtAnchor` at the nearest-orchestrator anchor + `/promote`);
before it, no production caller created runs. Counter *production* is #116's; #118
only renders the frozen shape.

**Run-id surface disagreement — CLOSED by #134 (was the N2 tail, ledger #123).**
The notice keys on `resolveWaveRunId` (now the nearest-orchestrator anchor, D1),
the CLI verbs on `env.ORCHESTRA_RUN_ID || 'default'`, and #116's mirror on
`ORCHESTRA_RUN_ID || host-<ts>`. #134 sets `ORCHESTRA_RUN_ID = anchor.anchorId`
into the agent env (`workspaces.ts` `extraEnv`), so all three surfaces now agree
on the wave run. The store-less CLI still writes mail with the SENDER's run
(D1a-bis/D2, rules OQ2/OQ3): the innermost-run decision is wake-side — the sweep
widens to related runs and reads the switch on the deeper of (mail,reader) run,
and the wake order NAMES each run to check — so a LEAD↔OPS message is governed and
retrieved on the OPS's (innermost) run without a send-side change. See the #134
section.

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

### Wiring (WAS deferred #117/#118/#119 — now done by #134)

`setAskGateSwitchReader` and `setWakeSwitchReader` are bound to `busSwitch` at
boot **by #134** (`src/main/index.ts`, beside `startBusWake()`):
`(runId) => { const db = getBus(); return db ? busSwitch(db, runId, 'wake'|'ask_gate') : false; }`.
Until #134 they stayed the `() => false` default, so the switches could never
fire in production even with a frozen-ON run row — see the #134 section below.

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

---

# Fencing — coordinator generation (#128)

Appended by #128 (ledger [#131](https://github.com/lcsmas/orchestra/issues/131),
wave D). Earlier sections are untouched.

## What this adds

Every run carries a monotone `coordinator_generation`. An OPS respawn BUMPS it,
and a write (`send` / `ack` / `gate resolve`) carrying an OLDER generation is
stale — the writer is a superseded coordinator, and its write is rejected with a
TYPED error. This formalizes the manual OPS-B → OPS-B2 recovery of waves B/C
(which relied on the old coordinator *choosing* to stop writing).

Behind the same coexistence rule as v1: a NEW `fencing` switch (the FIFTH
mechanism), **COUNTED not FIRED while OFF** — a stale write still lands and the
would-have-fenced event is recorded, so the OFF state is observable. Ships OFF.

| File | What |
|---|---|
| `src/shared/bus-fencing.ts` | The PURE `decideFence` predicate (`pass`/`count`/`reject`). No SQLite/Electron. |
| `src/main/bus.ts` | `coordinatorGeneration` / `bumpCoordinatorGeneration` / `assertCoordinatorGeneration` / `fencedWrite` / `recordFenceEvent` / `fenceEvents` / `fenceEventCounts` / `StaleGenerationError`; migration `MIGRATIONS[5]` (`runs.coordinator_generation` + `fence_events`). |
| `src/main/bus-runs.ts` | `BusRunRow.coordinator_generation` threaded through `getRun`/`listRuns`/`toRunRow`. |
| `src/shared/bus-switches.ts` | The `fencing` mechanism added to the enum/labels/wire map. |
| `src/cli/bus-verbs.ts` + `src/cli/index.ts` | `fenced(ctx, verb, write)` runs the send/ack/gate-resolve write THROUGH `fencedWrite` (one IMMEDIATE tx, F1); `--generation` / `$ORCHESTRA_COORDINATOR_GENERATION`; `busSwitch(db,runId,'fencing')` read at the boundary. |
| `src/renderer/components/BusPane.tsx` | `data-run-generation` per run. |

## Schema — `MIGRATIONS[5]`, `SCHEMA_VERSION 4 → 5`

`ALTER TABLE runs ADD COLUMN coordinator_generation INTEGER NOT NULL DEFAULT 0`
(a constant DEFAULT is legal for `ADD COLUMN`; every existing run backfills to 0)
plus the `fence_events` shadow-trail table. Next free slot after master's 4; the
schema trio #128 → #129 → #130 serializes on `MIGRATIONS`, renumbering at rebase
— never editing a merged migration (the Q-B1 index-collision trap). The C11 gate
(bus-mirror.test.ts) seeds a faithful `from<5` DB by dropping the fence_events
index+table THEN the column, or the re-run throws `duplicate column name`.

## The three-way decision (why `count` ≠ `reject`)

`decideFence(presented, current, fencingOn)`:
- **no generation presented** → `pass` in EITHER state (the v1 unfenced channel —
  every existing caller — must keep working: coexistence).
- **presented ≥ current** → `pass` (equal = the live coordinator; above is
  impossible without a bump it performed).
- **presented < current, switch ON** → `reject` (StaleGenerationError).
- **presented < current, switch OFF** → `count` (record a `fence_events` row with
  `fired=0`, and let the write proceed — old channel authoritative).

The count/reject split is the whole point of shadow: a mechanism whose OFF-state
is indistinguishable from the feature being absent cannot be observed before
promotion.

## Atomicity — the fence and the write are ONE transaction (review F1)

`fencedWrite(db, input, write)` takes the write as a CLOSURE and runs
read-decide-write inside one `db.transaction(...).immediate()`. Without this, a
separate fence-check then a separate write is a TOCTOU window: `fencedWrite` reads
generation G, a respawn bumps to G+1, the write then lands under the stale gen.
IMMEDIATE takes the write lock up front so no other connection can bump between
the read and the write; the inner `send`/`ack`/`resolveGate` open their own
IMMEDIATE tx (nested as a SAVEPOINT). A rejection throws INSIDE the tx (rolling it
back), so the FIRED `fence_events` row is re-recorded in an autonomous statement
in the catch — the shadow trail survives the rollback. A caller with no
enclosing write (the direct-call unit tests, the read-only pane) omits `write`
and fences-only. This window is INERT on master (nothing bumps generation, switch
OFF) but the atomic form is correct regardless of when bumping ships.

## Why the shadow counter is a bus TABLE, not main memory

#116/#117 keep their counters in main-process memory because those events happen
in-process. A fenced write happens in the CLI's OWN bus connection (the five
verbs write the DB directly), so the only place a CLI-side count survives to the
pane is the bus itself — hence `fence_events`, read by `fenceEventCounts`.

## The typed error

`StaleGenerationError` (name discriminant `'StaleGenerationError'`, carries
`runId`/`presented`/`current`). Fields are assigned explicitly, NOT via
constructor parameter properties — the `node --test --experimental-strip-types`
runner rejects those, and every bus test imports this file. The CLI's `fenced()`
wrapper catches it (via `err.name`, which survives an IPC boundary the prototype
chain does not) and routes it through `fail()` (CliFailure), so a refusal exits
cleanly under Electron (issue #59); any other error is re-thrown.

## D1 — the bus never blocks boot

The fencing read runs on an already-opened `db`: if the bus cannot open,
`openBusForVerb` fails first with a diagnosable ABI sentence, not a stack trace.
`coordinatorGeneration` on an unknown run returns 0 (never throws); a switch read
that throws is treated as OFF (counted, not fired). The pane's generation read is
inside `busSnapshot`'s existing try, so a down/broken bus renders the unavailable
state, not a crash.

## Gates (#128)

```bash
npx tsc --noEmit                                                         # C1
node --test --experimental-strip-types src/shared/bus-fencing.test.ts    #  5 pure
node --test --experimental-strip-types src/main/bus-fencing.test.ts      # 10 real-bus (primitive + fencedWrite)
node --test --experimental-strip-types src/cli/bus-verbs.test.ts         # +5 VERB-path arms (F2): verbSend/Ack/Gate → fenced → fencedWrite
node scripts/bus-pane-render-smoke.mjs                                   # T128.2 generation visible
pnpm run test                                                            # in the suite; # skipped must be 0
```

The verb-path arms (F2) drive the SHIPPED verbs, not `fencedWrite` directly, so
they cover the fence-before-write ordering, the `err.name`→`ctx.fail` routing
(issue #59), and the atomic tx (F1). The `bus-verbs.test.ts` ctx builder carries
real `generation`/`fencingOn` — omitting them (a TS2322 invisible because
`.test.ts` is tsc-excluded) made fencing run as a no-op.

Each acceptance arm was shown RED under one mutation (decideFence → always
`pass`; `recordFenceEvent` removed; the ADD COLUMN removed; the error `name`
discriminant broken; the verb-path fence bypassed → the 5 verb arms redden; the
on-rollback fence-event re-record removed → the verbSend `fired=1` assertion
reddens), mutant-string verified live, then GREEN restored.

## Not covered here

No production caller BUMPS generation yet — an OPS respawn calling
`bumpCoordinatorGeneration` is the promotion step, not this ticket (like
`ORCHESTRA_RUN_ID` still being unplumbed on master, #118 N2 tail). The fleet
skill does not yet branch on the `fencing=OFF` notice line (inert while OFF). No
live packaged two-generation refusal through a running app.

---

## Dispatch capability tokens (#129) — a stale completion cannot mask a hung retry

Wave D, bus v2. Each `dispatch` mints a `dcap_<32B>` token; a worker's
`worker_done`/`status` completion carries it back, and a completion whose token
belongs to a **superseded or failed** dispatch is rejected — so a hung worker's
late answer cannot mask the retry that replaced it.

### Files / symbols (all in `src/main/bus.ts`, `## Dispatch capability tokens` section)

- Migration `MIGRATIONS[6]` (renumbered from 5 at rebase onto #128, which took 5
  for fencing) + `SCHEMA_VERSION` 5→6. Two tables:
  - `dispatch_capabilities(run_id, dispatch_seq PK, token_hash, recipient, state, minted_at, resolved_at)`
    — `state` ∈ `active | superseded | failed`; **only `active` verifies**.
  - `capability_rejections(run_id PK, count)` — the durable shadow counter (C5).
- `hashCapabilityToken` (sha256 hex), `generateCapabilityToken` (`dcap_`+32B),
  `mintCapability` (supersedes the prior active cap for the SAME recipient in the
  same tx, returns the CLEAR token), `verifyCapability` (pure predicate),
  `failCapability`, `supersedeCapabilities`, `countCapabilityReject`,
  `capabilityRejectCount`, `getCapabilityByToken`.

### The token is NEVER stored/logged/rendered in clear (T129.2)

Only the sha256 **hash** is persisted. The clear token is returned to the
dispatcher's stdout once (`send --type dispatch` prints it on line 2) and travels
back on the completion. `--cap` is extracted BEFORE the body join in
`src/cli/index.ts` so it never lands in `messages.body` — which is what the pane
renders verbatim (`bus-pane.ts toMessage`). There is no column that could carry
the clear token, so the grep-for-a-literal check holds by construction.

### COUNTED-not-FIRED (T129.3, C5) rides the `capability` switch (RULING D1)

The bus-v2 write-path mechanisms gate on their OWN switch (ledger #131 RULING D1: one per mechanism); #129 rides `capability` (OFF in shadow). `verbSend` (`src/cli/bus-verbs.ts`)
verifies a completion's token; an invalid token is **COUNTED always**
(`countCapabilityReject`) but **REJECTED only when `busSwitch(db, runId, 'capability')` is ON**. OFF ⇒ the completion lands as v1, old channel authoritative.
The seam is injected into `BusVerbCtx` as `capabilityEnabled` /
`countCapabilityReject` (index.ts wires them from `busRuns.busSwitch` and
`bus.countCapabilityReject`) so the unit suite drives both ON and OFF.

**FAIL-CLOSED (review F1):** the gate is on the KIND, not on `--cap` presence —
a completion (`worker_done`/`status`) with NO token is as invalid as one with a
stale token (both COUNTED, both REJECTED when ON). Gating on `if (cap && …)`
would let a hung worker bypass the whole mechanism by omitting the flag, which
is the exact threat #129 exists to stop.

**Single-outstanding invariant + neutral message (review F2):** supersede-on-
redispatch enforces ≤1 `active` capability per (run, recipient), so a SECOND
concurrent dispatch to one recipient invalidates the first — including a
legitimate still-running job. Acceptable only under the wave-D "≤1 outstanding
dispatch per recipient" assumption (documented at `mintCapability`); a fan-out of
N concurrent jobs to one recipient is out of scope. The refusal is worded
neutrally ("superseded by a newer dispatch … or marked failed"), not "stale/hung".

**Failed-path caveat (review F3, LEAD ruling pending):** `failCapability` /
`supersedeCapabilities` exist and are unit-tested but have no shipped PRODUCER
yet — the "failed dispatch" half is unwired; supersede-via-redispatch is the live
path. Do not wire a new producer until the §Open-questions Q3 ruling.

### The `capability` switch + pane listing (RULING D1)

`capability` is a 5th `BusMechanism` in `src/shared/bus-switches.ts` (camel key ==
snake wire, no remap), appended to `BUS_MECHANISMS` / `DEFAULT_BUS_SWITCHES` /
`BUS_MECHANISM_LABEL` / the wire map. Growing the enum is additive/store-safe
(`run_flags.flags` is JSON read back by builds that know more mechanisms). It
auto-appears in the startup notice (`busSwitchNoticeLines` iterates the list) and
the settings toggles (`BusSwitchSettings` iterates the list). It is NOT wired into
`orchestra bus-status` switch-STATE (ledger #131 Q2: the shared
`BusDivergenceReport` is touched by #128/#129/#130 and must not be edited by
three tickets concurrently — one coordinated owner if the LEAD wants it there).
The capability REJECTION tally is surfaced in the PANE via `BusSnapshot`'s
additive `capabilityRejections` field (read directly from `capability_rejections`
in `bus-pane.ts busSnapshot`, rendered under "Shadow divergence") — the pane
listing that satisfies D1 without touching #116's frozen report.

### Gates

```bash
npx tsc --noEmit                                                    # C1
node --test --experimental-strip-types src/main/bus.test.ts        # helper + migration-from-4
node --test --experimental-strip-types src/cli/bus-verbs.test.ts   # CLI seam + COUNTED-not-FIRED
```

Mutation arms shown RED live: `verbSend` reject clause forced off (T129.1
must-FAIL goes red), `verifyCapability` `state==='active'` → `!=null` (supersede
test red), `countCapabilityReject` call dropped (T129.3 counter red).

---

# Liveness v2 — the PROGRESS bound (#127, hung mid-tool-call)

Appended by #127 (ledger [#131](https://github.com/lcsmas/orchestra/issues/131)),
wave D. Earlier sections untouched. **No migration** — reuses the `escalation`
kind and `send`, exactly like #120.

## The gap it closes

#120's `running` guard skips a member with a turn in flight UNCONDITIONALLY — the
anti-trap that keeps an 8-min build alive. But a session HUNG mid-tool-call
(a `pretool` fired, no `posttool`/`stop` ever follows) is `running: true` FOREVER
with its activity clock frozen at the call start, so #120 skips it too: the exact
#90 wedge class (process alive, status stuck running, no result, no exit) is
invisible to the staleness bound. #127 adds a **per-tool-class progress ceiling**
INSIDE the `running` guard: a running member whose in-flight tool call has blown
its ceiling with ZERO progress escalates like any other stall.

## Bound on PROGRESS, not elapsed (wave-8 lesson) — the dead-vs-slow trap

`hungCall` (`src/shared/bus-liveness.ts`) scans a member's `inFlightTools` LIST
and returns the MOST-OVERDUE call — one whose `now - startedAt >=` its
per-tool-class ceiling — or `null` when every in-flight call is under its ceiling
(alive). Progress is PER-CALL via **list membership**, not the shared activity
clock: a call is removed from the list only by ITS OWN `posttool` (keyed on
`toolUseId`), so a call still in the list has provably made no progress. This is
the review-127 F1 fix (see below) — the earlier single-slot design read the
global `lastActivityAt`, which a fast parallel call's posttool advances, and so
masked a hung sibling.

`toolClassCeilingMs(tool)`: `Bash` → `BASH_TOOL_CEILING_MS` (600s, matching the
Bash tool's OWN `timeout` cap enforced by the `claude` binary — a healthy Bash
call always produces a result at/before 600s); everything else (MCP `mcp__*`,
browser, WebFetch/WebSearch, custom, unknown/legacy-null) → `UNCAPPED_TOOL_CEILING_MS`
(30 min, a conservative UNBASELINED floor — these have no built-in cap and may
legitimately run long). Naming Bash explicitly keeps a NEW tool safe by default.
Each call is judged against ITS OWN class ceiling, so a hung Bash and a
legitimately-long MCP call are separated correctly side by side.

## review-127 F1 — PARALLEL tool calls (the load-bearing correctness fix)

An assistant turn issues N `tool_use` blocks at once. The first cut tracked ONE
in-flight call per workspace (`Map<wsId, InFlightTool>`), so a fast Bash call's
`posttool` cleared the whole slot and a hung MCP call beside it went untracked →
never escalated = the exact #90 wedge #127 exists to catch. The fix: a LIST keyed
by `toolUseId`. `noteToolEnd(wsId, toolUseId)` removes exactly the matching call
(an id-less legacy-hook posttool falls back to FIFO over the id-less cohort only);
a hung sibling stays. `toolUseId` is threaded end to end: the SDK path passes
`ev.toolUseId` (on both `tool-use`/`tool-result` AgentEvents); the spool hook
mines `tool_use_id` from the PreToolUse/PostToolUse payload into the jsonl line,
and `events-spool.ts` reads it. A turn-end (`stop`/`stopfail`/`notify`/`session`)
`clearInFlightTools` drops all calls (an interrupt/error can end a turn with calls
still notionally in flight).

## The two existing bounds this complements (MEASURED, not assumed)

- **#90 turn-gate watchdog** (`session-watchdog.ts` `TICK_MS = 60_000`;
  `session-wedge.ts` `GATE_SILENCE_RELEASE_MS = 10min`): a 60s-poll, 10-min
  SDK-stream progress bound that RELEASES a stranded gate (or recycles the
  session). Covers structured sessions with `turnGate` held AND `queuedCount > 0`.
  It self-heals; it does NOT escalate to a coordinator, and a hung call with an
  EMPTY queue (`queuedCount <= 0`) is refused. #127 fills both gaps: a
  coordinator-visible escalation, keyed on a per-tool ceiling, with no queue
  requirement.
- **Bash 600s cap** (the SDK Bash TOOL's own `timeout` max, external): a Bash call
  self-terminates ≤600s → a posttool = progress, so it can't masquerade as hung
  past its cap. `agent-sdk.ts:2696 BASH_TIMEOUT_MS = 5min` is a DIFFERENT bound
  (the composer's `!command` bash-MODE cap), not the agent's Bash tool.

## How the in-flight calls are tracked — REUSED chokepoint, no new probe

`hibernation-activity.ts` (the dependency-free leaf that already holds
`lastActivity`) gains a `Map<wsId, InFlightTool[]>` + `noteToolStart`/
`noteToolEnd`/`clearInFlightTools`/`getInFlightTools`. Fed from the SAME
`applyAgentEvent` switch (`activity.ts`): `pretool` → `noteToolStart(id, tool,
toolUseId)` (appends), `posttool` → `noteToolEnd(id, toolUseId, tool)` (removes
exactly that call by id; when the path carries no id — the REMOTE/sandbox wire
and the legacy hook — the tool NAME scopes an id-less FIFO so a fast call cannot
clear a hung call of a DIFFERENT tool, review-127 F3), and
`stop`/`stopfail`/`notify`/`session` → `clearInFlightTools`. The roster
(`index.ts`) reads `getInFlightTools(ws.id)` into `LivenessMember.inFlightTools`.

| File | #127 change |
|---|---|
| `src/main/hibernation-activity.ts` | `InFlightTool[]` tracker keyed by toolUseId + `noteToolStart`/`noteToolEnd`/`clearInFlightTools`/`getInFlightTools`; `forgetHibernationActivity` clears it. |
| `src/main/agent-sdk.ts` | `driveStatusFromEvent` threads `ev.toolUseId` for tool-use/tool-result. |
| `src/main/events-spool.ts` + hook (`workspaces.ts`) | hook mines `tool_use_id` into the jsonl; spool reads `toolUseId` and passes it to `applyAgentEvent`. |
| `src/main/activity.ts` | `applyAgentEvent` calls start/end at the pretool/posttool/turn-end cases. |
| `src/shared/bus-liveness.ts` | `toolClassCeilingMs`, `hungCallForMs`, `resolveStall` (shared dedup/switch, extracted so the staleness & hung paths keep ONE copy), `hungCallEscalationBody`, `InFlightToolState`; `decideEscalation`'s `running` guard now checks the progress bound. |
| `src/main/bus-liveness.ts` | roster carries `inFlightTools` (list); the hung-call body + log wording; `writeEscalation` takes the hung tool. |
| `src/shared/bus-liveness.test.ts` | pure tests: ceiling, hung, build-alive, **F1 parallel-hang + most-overdue**, boundary `>=`, switch-OFF count, dedup, body. |
| `src/main/bus-liveness.test.ts` | real-bus tests: T127.1 both arms, **F1 parallel-hang end-to-end**, T127.3 counted-not-fired. |
| `src/main/hibernation-activity.test.ts` | **NEW — tracker-level (review-127 F2)**: the produce-from-events seam; F1 regression (fast sibling posttool does not clear a hung parallel call), **F3 remote id-less cross-tool masking**, tool-name FIFO, no-op-match, clear-all. |

## COUNTED-not-FIRED while `liveness=OFF` (T127.3, C5)

The hung-call escalation flows through the SAME switch gate as #120's staleness
escalation (`resolveStall`): switch OFF → `count` (shadow counter increments, no
row reaches the coordinator); the old channels stay authoritative. Its test asserts
BOTH zero rows AND `counters.counted >= 1`.

## Not covered here (NOT-VERIFIED)

- No live packaged run drives a REAL hung MCP/browser call through a running app;
  the rig injects `inFlightTools` + a fake clock (same posture as #120's sweep rig).
  C6 (packaged boot) is verifier-owned; #127 adds no schema, so boot risk is nil.
- The MCP/browser ceiling (30 min) is UNBASELINED — no fleet distribution of
  longest legitimate uncapped-tool durations — chosen as a conservative floor.
- Commit-as-progress is NOT read (a git call per member per sweep is a cost); a
  real tool call emits a `posttool` (progress) so the activity clock already
  covers it. A tool that silently makes git progress while emitting no lifecycle
  event would only be caught at the ceiling — acceptable, and the safe direction.
- **REMOTE/sandbox path (review-127 F3): the wire (`EventFrame`) carries a tool
  NAME but no tool_use_id**, so remote calls use the id-less tool-name-scoped
  FIFO. This closes the CROSS-tool masking (a fast Bash cannot clear a hung MCP
  call). **Precise residual (review-127 F3-sharpened): on the REMOTE (id-less)
  path, a SAME-TOOL parallel hang masks the HUNG call specifically.** The id-less
  posttool removes the OLDEST same-tool call, and a hung call IS the oldest
  (longest in-flight), so a fast sibling's posttool drops the hung call's OWN
  escalation while the fast one lingers. Remote-only, same-tool-only; cross-tool
  is closed; NOT a regression (no pre-#127 hang detection existed). The honest fix
  is a tool_use_id on the sandbox wire — a protocol change out of #127 scope,
  **deferred to [#132](https://github.com/lcsmas/orchestra/issues/132)** (LEAD
  ruling D3(a), ledger #131 §Decisions): "Sandbox wire: carry toolUseId on remote
  tool events so progress-liveness can attribute a hung call". Remote agents are
  shadow/OFF in this wave, so it is COUNTED-not-fired regardless.

---

## Mutation receipts (#130, bus v2) — `src/main/bus-receipts.ts`

Per-message idempotency for the CLI mutations `send` / `ack` / `gate resolve`,
keyed on `(run_id, caller_fingerprint, request_id)`. v1's ack is BATCH-granular
(one ack closes a whole lot), so a retried mutation had no per-message idempotency
key — a re-run shell one-liner, a keeper replay or a network blip could
double-send or double-resolve. The receipt makes a retry a NO-OP returning the
ORIGINAL receipt.

- **Table `mutation_receipts`** — `bus.ts` migration **index 7** (after #128's
  fencing=5 and #129's capability=6; `migrate()` applies BY INDEX, so a reused
  number silently skips this SQL — the wave-B trap). Composite
  `PRIMARY KEY (run_id, caller_fingerprint, request_id)` is the whole correctness
  primitive: a retry hits the PK (`INSERT OR IGNORE`), so at most one row per
  (run, caller, request). **`run_id` is IN the key** (review #130 F1): the
  fingerprint is the caller's stable ws-id, so a key without run_id would collide
  across runs — the same handle + request_id in a different run would short-circuit
  to the wrong run's receipt. `mutation` (`send|ack|gate_resolve`) + `receipt`
  (JSON of the original return) + `created_at`.
- **`withReceipt(db, {callerFingerprint, requestId, mutation, runId, switchOn}, exec)`**
  — one transaction: lookup by the full key → a cross-verb reuse REFUSES (shape
  mismatch) BEFORE counting (so a rollback leaves no counter skew, review #130 F3);
  else COUNT the retry; if `switchOn`, return the stored receipt and DON'T run
  `exec` (FIRED); if `!switchOn`, run `exec` (v1); if absent, run `exec`, store,
  `recorded++`. Nested `.immediate()` inside `ack`/`resolveGate`/`fencedWrite`'s
  own transaction is savepoint-safe (measured, better-sqlite3@11.10.0).
- **COUNTED-not-FIRED (coexistence):** while the `receipts` switch is OFF the row
  is still RECORDED (the shadow count) but the short-circuit does NOT fire — the
  mutation re-executes, two identical `--request-id` sends → two rows (v1). Only
  ON does a replay short-circuit. Same choice `mirror_records` makes.
- **CLI wiring** (`bus-verbs.ts`): `send`/`ack`/`gate resolve` take `--request-id`;
  `runMutation()`/`runMutationOutcome()` engage the receipt ONLY when a key is
  supplied (absent = v1, byte-identical to pre-#130). Gated on the dedicated
  **`receipts`** switch (`RECEIPT_SWITCH`, ledger #131 ruling **D1** — a per-feature
  switch, NOT `delivery`), read off the run's FROZEN flags via `busSwitch`. On a
  dispatch REPLAY the send is composed OUTERMOST around #128's `fenced` and #129's
  mint is SKIPPED (`!sent.replayed`) so it does not re-hit the capability PK.
- **Counters** `busReceiptCounters()` = `{recorded, countedReplays, firedReplays}`
  for the shadow-observation deliverable (module-global, like bus-liveness).

Gates: `src/main/bus-receipts.test.ts` (core, incl. the F1 two-run arm + T130.4
from-6→v7 migration in `bus.test.ts`) + the `#130` block in
`src/cli/bus-verbs.test.ts` (CLI path, both switch arms + the dispatch-replay
seam). Each acceptance arm shown RED under one mutation (short-circuit re-runs
exec; PK drops request_id; PK drops run_id → cross-run collision; switch gate
always-fires; runMutation ignores request-id; migration index collision;
drop `!sent.replayed` → re-mint PK throw), then GREEN restored.

---

# Run lifecycle at the NEAREST-ORCHESTRATOR anchor + `ORCHESTRA_RUN_ID` (#134)

Appended by #134 (ledger [#135](https://github.com/lcsmas/orchestra/issues/135),
LEAD ruling **D1/D1a/D1b**). This is the ticket that made the #118 switch/freeze
machinery **actually reach production** — before it, `startRun` had zero callers,
so no `runs` row was ever created, every `busSwitch(runId, …)` read all-OFF, and
the freeze was vacuous.

## The gap it closed (the reproduced defect at `ba3da60`)

- `startRun` had NO production caller — only `scripts/*` rigs.
- `ORCHESTRA_RUN_ID` appeared only in `workspaces.ts` **comments**, never in
  `extraEnv`; the CLI's `resolveBusIdentity` resolved `default` for every member,
  and the mirror fell back to a per-boot `host-…`.
- `setWakeRoster` hardcoded `runId:'default'`; `setWakeSwitchReader` /
  `setAskGateSwitchReader` were never wired → `() => false` for every run.

## The anchor is the NEAREST ORCHESTRATOR (D1 — NOT the tree root)

The topology is LEAD (long-lived orchestrator) → OPS (promoted worktree, one per
wave) → members. If the anchor were the tree root, every wave would freeze on the
LEAD's lifetime run — no per-wave flip. So `resolveWaveRunId(ws)` =
`nearestOrchestratorId(ws, store.getWorkspace)` (`src/main/wave-run-id.ts`, pure):
`ws` if it `canOrchestrate` (kind `'orchestrator'` OR the capability flag — an OPS
is a *promoted worktree*, so NEVER key on kind alone), else the first
`canOrchestrate` ancestor, else `ws` (a plain standalone spawn is its own run).
`parentOrchestratorId` gives the OPS's `parent_run_id` = the LEAD's run → **nested
LEAD→OPS = two run rows.** `walkToRootId` is retained for tree-root callers but is
NOT the run anchor.

## Where the run starts — `maybeStartRunAtAnchor` (`src/main/bus-run-anchor.ts`)

`startAgentPty` resolves `resolveAnchorInfo(ws)` = `{ anchorId, anchorIsOrchestrator,
parentRunId }` ONCE and calls `maybeStartRunAtAnchor(deps, anchor)`:

- **Fires when a workspace BECOMES an orchestrator** (spawn-as-orchestrator: the
  anchor is itself) AND **lazily** when a MEMBER launches under a pre-existing
  orchestrator whose row is missing (a LEAD/OPS promoted before this shipped). A
  plain standalone workspace (`anchorId===ws.id` but NOT `canOrchestrate`) gets NO
  row.
- **`/promote`** (`dispatchPromoteRequest`) also calls it via `startRunForPromoted`
  in BOTH success branches — a promote does not relaunch the pty, so the OPS's own
  row is created at that wave boundary.
- **Idempotent, freeze-once (F1):** `startRun` is INSERT-OR-IGNORE on the `runs`
  row existence; a `getRun` short-circuit skips the INSERT when the row exists.
- **`kind`** = `'mission'` for a top-level orchestrator (parentRunId null),
  `'vague'` for a nested one — the discriminator `refreezeRun` gates on.
- **D1b mission re-freeze:** when a NEW nested (OPS) run is created,
  `refreezeRun(db, parentRunId, live)` UPDATEs the parent **mission** row's flags
  to the current live switches (SQL WHERE `kind='mission'` — the guard, so an
  OPS/member row is NEVER re-frozen). Wave-boundary only (new-nested-run), never on
  a member spawn that merely reads an existing OPS row. Keeps the LEAD's own plain
  children tracking the latest flip while preserving F1 for OPS/member rows.
- **D1 — never blocks a spawn:** `getBus()` null / `startRun` throw are caught,
  logged, return null; the spawn proceeds all-OFF.

## The FLAT-mission gap and the admin refreeze (`orchestra run refreeze`, #156)

D1b re-freezes a mission ONLY at a wave boundary — a NEW nested (OPS) run created
under it. A **FLAT orchestrator** (plain children only, never a promoted sub-OPS)
crosses that boundary NEVER, so its mission stays frozen at its first anchor
forever and can never pick up a later switch flip (live: the bloc2 orchestrator
`36773f53` froze all-OFF and could not adopt promoted delivery+wake). #156 adds the
explicit operator path:

- **CLI:** `orchestra run refreeze [--run <id>]` — resolves the run (`--run` >
  `$ORCHESTRA_RUN_ID` > `default`, same as `bus-status`) and hits the `/runRefreeze`
  socket route. Refrozen → prints the flag table + exit 0; every refusal exits
  non-zero with a diagnosable line (no stack). (`src/cli/index.ts` `case 'run'`;
  arg/outcome contract in `src/cli/run-refreeze-args.test.ts`.)
- **Store side (`dispatchRunRefreezeRequest`, `src/main/workspaces.ts`):** lives in
  main, NOT the store-less CLI, because the live-child gate needs the store's
  liveness probes — the bus cannot see a plain child's turn state. The mission run
  id **is** its coordinator ws id, so its children are `collectWorkspaceTree(runId)`
  minus the root; `hasLiveChild = anyChildLive(childIds, isRunning, sdkSessionLive)`
  — the disjunction covers BOTH surfaces (PTY + structured/SDK). `isRunning` alone
  is the #111 restart blind spot (its `sessions` map is PTY-only), and the DEFAULT
  spawn is structured, so it would miss a live SDK child (REVIEW-156 HIGH). The
  disjunction lives in the platform-free **`anyChildLive`
  (`src/shared/refreeze-liveness.ts`)** so a test drives the REAL predicate — a
  literal-into-the-pure-fn arm can't (REVIEW-156 MED, gate 4): the STRUCTURED-child
  arm reddens the instant the `sdkSessionLive` disjunct is dropped while the PTY arm
  stays green (`src/shared/refreeze-liveness.test.ts`).
- **The gate (`refreezeMissionRun`, `src/main/bus-runs.ts`):** a typed outcome —
  `no-run` | `not-mission` (re-asserts `refreezeRun`'s `kind='mission'` guard with a
  reason) | `live-child` (refused mid-turn, the freeze invariant) | `refrozen` |
  `no-flags`. It calls **only** `refreezeRun` (a pure UPDATE), so **#134 F1 holds —
  never a late insert**; a mission with no `run_flags` row is `no-flags`, not a late
  freeze (reads all-OFF, coexistence-safe).
- **Gates:** `bus-runs.test.ts` T156.1–T156.4 drive the shipped `refreezeMissionRun`
  with mutation-proven must-fail twins (each arm reddens under its own mutation);
  `refreeze-liveness.test.ts` drives the REAL `anyChildLive` predicate (the
  live-child WIRING) — a structured no-PTY child reddens when the `sdkSessionLive`
  disjunct is dropped while the PTY arm stays green; `bus-run-anchor.test.ts` `#156`
  documents the flat-mission gap D1b leaves and that the refreeze closes it.

## The plumbing (`src/main/index.ts`, beside `startBusWake()`)

- `extraEnv.ORCHESTRA_RUN_ID = anchor.anchorId` (the nearest-orchestrator run).
- `setWakeRoster` maps `runId: resolveWaveRunId(ws)` — each reader keyed on its
  **innermost** run (D1a roster side; was `'default'`). The liveness roster
  already used `resolveWaveRunId`.
- `setWakeSwitchReader` / `setAskGateSwitchReader` →
  `(runId) => { const db = getBus(); return db ? busSwitch(db, runId, 'wake'|'ask_gate') : false; }`.

## `orchestra bus-status` (#134 addition, read-only)

`/busStatus` accepts the CLI's resolved `runId` and returns `displayRunId` +
`frozenFlags` (`runFlags(db, runId)`) + `liveFlags` (`getLiveSwitches()`),
serialized JSON. The CLI prints the run it resolved (`--run` > `$ORCHESTRA_RUN_ID`
> `default`), **never** the main process's `host-…` mirror id, plus a
frozen-vs-live flag table (WIRE names). No write path.

## D1a-bis BIDIRECTIONAL innermost-run wake routing (OQ2 ruling A, wake-side)

The store-less CLI writes mail with the SENDER's run (unchanged; a socket
round-trip was rejected). The innermost-run decision lives in the wake sweep
(main, store-aware), and is BIDIRECTIONAL (D1a-bis):

- **`readPendingReaders` widens to RELATED runs** (`getRelatedRunIds`, bus-runs.ts
  — own ∪ every ANCESTOR up `parent_run_id` ∪ every DESCENDANT down, with a depth
  map): a reader is pending for mail addressed EXACTLY to it (never a null
  broadcast) in its own run OR any related run. An OPS→LEAD digest sits in the OPS
  DESCENDANT run; a LEAD→OPS ruling sits in the LEAD ANCESTOR run — both are now
  seen. A null-recipient broadcast stays own-run only (never pulled across).
- **The wake switch is read for the GOVERNING run = the INNERMOST = the DEEPER of
  (mail run, reader run)** (`ReaderPendingState.switchRunId`, by the depth map):
  upward mail (OPS→LEAD) → the mail's (OPS) run governs; downward mail (LEAD→OPS)
  → the reader's (OPS) run governs. `pendingRunId` separately carries the run the
  mail SITS in (the retrieval + ack run). Gates (askGate) are own-run only.
- **The wake ORDER names the runs (D2, rules OQ3):** `buildWakeOrder(runIds)`
  (`src/shared/bus-wake.ts`) emits the header + one `orchestra check --run <r>`
  line per run with pending mail for the reader (`ReaderPendingState.pendingRunIds`,
  the full own∪related set). `isWakeOrder`/`wakeOrderRuns` recognize/extract the
  shape. `deliverWake(reader, order)` carries it. The reader runs EXACTLY those
  checks and acks each; `check`/`ack`/cursor stay per-run (one lot = one run), a
  plain `check` = own run. Without the `--run` a reader woken for cross-run mail
  would check its own run, find nothing, and loop forever (the OQ3 defect). The
  fleet-skill `wake=ON` wording lives in `~/.claude` (LEAD owns it), not this repo.

Mutation-verified (`src/main/bus-wake-run-switch.test.ts`): a switch read pinned
to the reader's run reddens the UPWARD fire arms; pinned to the mail's run reddens
the DOWNWARD fire arms; dropping the widening reddens "woken at all"; and the
ROUND-TRIP arm drives fire→check(mail run)→ack→pending-clears→not-re-woken, with
an own-run-retrieval must-FAIL that shows the permanent loop as RED.

## Gates

- `src/main/wave-run-id.test.ts` — `nearestOrchestratorId` (member→OPS not LEAD;
  capability-flag anchor; standalone→self; broken link; cycle) + `parentOrchestratorId`
  (OPS→LEAD; LEAD→null; skip-plain-wrapper). A tree-root mutant reddens 4 arms.
- `src/main/bus-run-anchor.test.ts` — G3 row-created-at-anchor (+ must-FAIL noop
  `startRun` → ABSENT), G5 member anchors on OPS + lazy-creates it (+ nearest≠tree-root
  control), G4-D1 member anchored on OPS not LEAD, **G4b** mission re-freeze at wave
  boundary (+ no-refreeze control ⇒ stale) and OPS-row byte-identity across a member
  spawn (F1), standalone → no row, D1 null/throwing bus, idempotence.
- `src/main/bus-wake-run-switch.test.ts` — G7 the REAL accessor fires a frozen-ON
  run, COUNTS a frozen-OFF run, unwired-accessor arm reproduces the master defect.
- `src/main/wave-run-anchor-wiring.test.ts` — source guards for the un-importable
  seams; `resolveWaveRunId` uses `nearestOrchestratorId` not `walkToRootId`; both
  promote branches call `startRunForPromoted`; roster mutant `'default'` reddens.
- `scripts/verify-bus-status-cli.mjs` — REAL built CLI over a fake socket: G8 wave
  run id not `host-…` (+ must-FAIL) + frozen-vs-live table.
- **G4a (D1a-bis bidirectional wake routing)** — `src/main/bus-wake-run-switch.test.ts`:
  UPWARD (OPS→LEAD digest) fired/counted; DOWNWARD (LEAD→OPS ruling) fired/counted;
  a reader's-run-switch mutant reddens the upward fire arms, a mail's-run-switch
  mutant reddens the downward ones, drop-widening reddens woken-at-all; and the
  ROUND-TRIP arm (fire→check mail run→ack→not-re-woken) with an own-run-retrieval
  must-FAIL showing the loop. All verified live.
- **G9** packaged boot + spawn-notice under real Electron — owned by VERIFY-F.

`workspaces.ts` is un-importable under `node --test` (its `./platform`
dir-import), so the seam decision is pure exports (`nearestOrchestratorId` /
`parentOrchestratorId`, wave-run-id.ts) and the effect is a platform-free function
(`maybeStartRunAtAnchor`) the integration test drives for real — never a
re-implementation.

---

# Delivery core: recipient canonicalization + the shared predicate (#144)

The first canary with `delivery=ON`/`wake=ON` (ledger #143 §Canary) found three
delivery defects. All three are fixed here; none rewrites existing rows (canary
data), and `bus-status` now FLAGS the bad rows so an operator can see them.

## 1. `send` canonicalizes `--to` to a FULL workspace id

The fleet types the 8-char handle (`orchestra send --to 0a5c25bb …`). Pre-#144
the bus stored `recipient='0a5c25bb'`, but the wake predicate and `check` compare
against the reader's **full uuid**, so the row never matched and the OPS was never
woken (rows 444–448). Full-uuid probes (443, 450) woke it in ~40 s — the path
worked only with full ids.

`send` now resolves `--to` (full id / 8-char prefix / workspace **name**) to the
full id BEFORE any row is written. **The bus never stores a short handle.**

| Piece | Where |
|---|---|
| Pure resolver (rules, ambiguity/unknown refusals) | `src/cli/resolve-handle.ts` `resolveHandle()` |
| Candidate fetch — socket up | `src/main/hooks-server.ts` `/resolveHandle` → `dispatchResolveHandleRequest` (`src/main/workspaces.ts`) |
| Candidate fetch — app DOWN | `src/cli/index.ts` `offlineHandleCandidates()` reads `<ORCHESTRA_HOME>/userData/orchestra/store.json` |
| Wired into the verb | `src/cli/index.ts` `send` case → `canonicalizeRecipientOrFail()` before `verbSend` |

**The offline-path trap:** the app relocates userData to `<HOME>/userData` via
`app.setPath` ONLY when NOT in CLI mode (`src/main/index.ts`), so
`app.getPath('userData')` is the WRONG source from inside the CLI. The offline
reader derives the home-relative path itself (`cliOrchestraHome()`), matching
what the running app writes. An unreadable store yields `[]` → the send is
REFUSED (never a silent short-handle land).

Resolution precedence (most specific first): exact id → exact name → id prefix.
Ambiguous (two ids share a prefix, or two workspaces share a name) or unknown →
`fail()` (rc≠0) naming the candidates. A full id wins even when it is a prefix of
a longer id.

**Known adjacent gap (follow-up, NOT fixed here):** `orchestra message <handle>`
has the SAME short-handle miss (`message 0524718f` fails, the full id works) —
#144's scope is `send`/`check`/mirror/`bus-status`, so the message path is left
for a follow-up. The resolver is reusable there.

## 2. `check` is recipient-scoped by ONE shared predicate

Pre-#144 `check()` (`src/main/bus.ts`) built the lot from EVERY message in the run
above the reader's cursor with **no recipient filter**, so any reader could
consume any run's mail. It now filters by `ownRunRecipientSql()` — the reader's
own run: `recipient = reader OR recipient IS NULL` (a broadcast still reaches
everyone). Applied to BOTH the fresh-take query and the replay query, so a
redelivered lot stays byte-identical.

**The predicate is ONE function, referenced at both call sites** — the classic
guard/consumer drift bug is that `check`'s scope and the wake predicate's scope
diverge. `ownRunRecipientSql(alias?)` / `relatedRunRecipientSql(alias?)` live in
`src/main/bus.ts`; `check()` uses `ownRunRecipientSql()`, and
`readPendingReaders` (`src/main/bus-wake.ts`) uses `ownRunRecipientSql('m')` +
`relatedRunRecipientSql('m')`. There is no second copy of the clause. A
source-binding test (`bus.test.ts`) reddens if either file re-inlines it.

## 3. The mirror lands in the parties' resolved run

`mirrorDispatch` (`src/main/bus-mirror.ts`) took its run id from the MAIN
process's env (`ORCHESTRA_RUN_ID`, absent → per-boot `host-…`), so every mirrored
row went to `host-…` (row 451), invisible to any party's `check`. It now accepts
an optional `runId` — the PARTIES' resolved run — set by the caller
(`dispatchMessageRequest` in `workspaces.ts` resolves the RECIPIENT's wave run via
`resolveWaveRunId`). Absent → the `host-…` fallback, unchanged. **Only the ROW's
run moves; the divergence ledger stays keyed on `mirrorRunId()`** (its frozen
#123 contract) — this redirects where a party's `check` finds the row, not the
aggregate counters.

## 4. `bus-status` flags short/invalid recipients

`badRecipientRows(db)` (`src/main/bus.ts`) returns every message whose recipient
is non-null and NOT a full workspace id (`isFullWorkspaceId`,
`src/shared/types.ts` — a v4 UUID test). `/busStatus` returns `badRecipientCount`
+ a capped `badRecipients` sample; `orchestra bus-status` prints a WARNING block
when the count is > 0 (`printBadRecipients`, `src/cli/index.ts`), quiet on a clean
bus. No existing row is rewritten — the canary rows are left as evidence.

## Gates (#144)

- **G3** canonicalize — `src/cli/resolve-handle.test.ts` (8-char→full, name→full,
  ambiguous/unknown refused) + `src/cli/canonicalize-recipient.test.ts` (the
  offline store path). must-FAIL: dropping a resolver tier refuses / lands raw.
- **G4** shared predicate — `bus.test.ts` #144 arms (check recipient-scoped;
  replay byte-identical; the ONE-shared-function source binding). must-FAIL:
  dropping the filter folds another reader's mail into the lot.
- **G5** mirror — `bus-mirror.test.ts` #144 G5 (supplied runId → parties' run;
  absent → host fallback). must-FAIL: ignore `input.runId` → row lands `host-…`.
- **G6** CANARY REPLAY (packaged app) — owned with VERIFY-G: a member `send --to
  <8-char-OPS>` wakes its reader within one sweep; unfixed build never wakes.
- **G7** bus-status — `bus.test.ts` `badRecipientRows` flags a seeded short row,
  quiet on a clean bus. must-FAIL: invert the id test → the short row is missed.
- **The CANARY at the predicate layer** — `bus-wake.test.ts` #144: a short-handle
  recipient never wakes the full-id reader; the full id does (same command,
  positive + negative arm).

---

# `send` refuses an UNANCHORED run (#155)

The first canary with `delivery=ON`/`wake=ON` also produced ledger #152 F-C4-2b:
a ship agent sent with `$ORCHESTRA_RUN_ID=<its own ws id>` (a brief env error),
the CLI ACCEPTED it, and seq 793 landed under a `run_id` with **no row in
`runs`**. That mail is ORPHANED: `busSwitch(<unknown run>, 'wake')` safe-defaults
OFF (#123 F1), so the recipient is never woken, and the row is invisible to every
run-scoped `check` — only a reader who already knows the phantom id can retrieve
it. The v1 schema comment (`bus.ts` `MIGRATIONS[1]`) predicted this exact
"parallel universe of messages no reader is checking".

## The gate

`orchestra send` now REFUSES a `run_id` absent from `runs`, in the `send` case of
`src/cli/index.ts` — **after** `openBusForVerb()` (it needs the db) and **before**
`verbSend`, so no row is ever written on refusal. It reads existence via
`runExists` (surfaced from `openBusForVerb`, backed by `bus-runs.ts` `getRun`
returning null for an unknown run) and fails with `unknownRunRefusalMessage`
(`src/cli/bus-verbs.ts`), which **names the remedy**: `orchestra restart` to
re-derive the anchor, or correct/unset `$ORCHESTRA_RUN_ID` / pass `--run`.

**The `default` sentinel is EXEMPTED** (`id.runId !== DEFAULT_RUN_ID` guards the
check). `default` never gets a `runs` row — rows are created only at orchestrator
anchors (#134 `maybeStartRunAtAnchor`), and a plain standalone workspace
deliberately gets none either. `default` is the documented fallback for a manual /
standalone send, so refusing it would break every unanchored send. The gate is
only for a run id that LOOKS anchored (a uuid) but has no row — the F-C4-2b shape.

## Two INDEPENDENT pre-send gates, no clobber

This is a NEW gate, distinct from #142's stale-marker refusal. They run in order
and neither clobbers the other:

| Gate | Fires from | When | Message |
|---|---|---|---|
| #142 `refuseIfStaleRun()` | the `.orchestra/bus-run-stale` marker FILE, **before any bus opens** | this workspace was re-parented with `--no-restart` | `staleRunRefusalMessage` |
| #155 run-existence | the opened bus (`runExists`), after openBusForVerb | `run_id` (≠ `default`) has no `runs` row | `unknownRunRefusalMessage` |

The #142 marker gate short-circuits first, so a stale + unanchored workspace sees
#142's message, never #155's.

## Gates (#155)

`src/cli/send-unknown-run.test.ts` drives the BUILT `dist-electron/cli.js send`
end-to-end against a REAL bus in an isolated `ORCHESTRA_HOME`+`HOME`, and reads
`messages` back to prove no row landed on refusal (the gate is wired in
`index.ts`, not `verbSend`, so the `bus-verbs.test.ts` unit rig — which stubs
`busSwitch` and never opens a real bus — cannot reach it). No skip under
`pnpm run test`: node_modules better-sqlite3 loads at the runner's system-node
ABI. Arms:
- **must-FAIL** — unknown uuid run → refused, remedy named, 0 rows. Mutation-
  proven: removing the gate makes it rc 0 with 1 orphaned row (reddens ONLY this
  arm).
- valid anchored run (seeded via the shipped `startRun`) → accepted, 1 row.
- `default` (env unset) and explicit `--run default` → exempt, accepted.
- #142 stale-marker still refuses first (its message, not #155's) even with a
  valid run → 0 rows.
