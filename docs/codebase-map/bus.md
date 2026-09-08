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
| `src/main/bus-pane.ts` | The read-only IPC and the snapshot assembly |
| `src/renderer/components/BusPane.tsx` | The pane, incl. the bus-unavailable state |
| `src/renderer/components/BusSwitchSettings.tsx` | Flipping the live switches (a WRITE, deliberately not a pane channel) |

## The freeze — the one thing to understand

`startRun()` (`src/main/bus-runs.ts:83`) snapshots the live switches **once** and
writes them to `run_flags`. Everything that asks "is mechanism X on for this
run?" goes through `runFlags()` (`:151`) or `busSwitch()` (`:169`), which read
**the row**. A human flipping a switch mid-wave changes the store and **nothing
else**: the running run's row is untouched, and the next `startRun` picks the new
value up. Two runs with contradictory flags coexist in one DB by design.

Three details that are load-bearing, each of which was a bug in an earlier draft:

- **`INSERT OR IGNORE`, never `REPLACE`** (`:112`). A resume path calling
  `startRun` again must be a no-op, not a re-freeze — a re-freeze is exactly the
  mid-wave mutation the feature forbids, arriving through the most innocent path
  there is.
- **`startRun` reads the row BACK** (`:124`) instead of returning what it meant
  to write. Otherwise a second call *looks* like a re-freeze to its caller while
  the row says otherwise, and the two drift silently.
- **An unknown run reads all-OFF, never live** (`:151`). A mechanism firing
  because its row was missing is indistinguishable in the field from the switch
  genuinely being on.

`freezeSwitches()` (`src/shared/bus-switches.ts:122`) also implements the LEAD's
D1 reconciliation: **bus down ⇒ every mechanism freezes OFF for that run**, and
that is recorded on the row, so the run stays self-describing about why it
behaved as unadopted.

### The contract with #117

```
busSwitch(db, runId, 'delivery' | 'wake' | 'ask_gate' | 'liveness') -> boolean
```

Note `ask_gate` (snake) on the **wire** vs `askGate` (camel) as the internal TS
key. The mapping lives in exactly one place — `mechanismFromWire` /
`mechanismToWire` (`src/shared/bus-switches.ts:155`) — because N copies is how a
wire contract and an enum drift apart. Unknown run **or** unknown mechanism
returns `false`, never a throw: false leaves the old channel authoritative.

## Read-only in v1 — enforced, not promised

`BUS_PANE_IPC_CHANNELS` (`src/main/bus-pane.ts:43`) is the enumeration, and
`registerBusPaneIpc()` (`:278`) **refuses to register** any entry marked
`writes: true`. So adding a v2 write handler requires editing the table, which
turns the test red at the same moment. The switch WRITE lives on its own
`bus:setSwitches` channel registered in `src/main/index.ts`, deliberately outside
that registrar — routing it through the pane would defeat the check.

## `getBus() === null` is normal (D1)

`busSnapshot()` (`src/main/bus-pane.ts:201`) **never throws**: a missing bus, or
a query that throws, both become `available: false` carrying the DB path and the
error. The pane renders that as a loud block (`BusUnavailable`,
`src/renderer/components/BusPane.tsx:252`).

Why `available` exists at all: a down bus and a quiet bus have *identical* empty
runs/messages/gates arrays. Without the flag the pane could not tell them apart —
and "an empty pane indistinguishable from no-messages-yet" is precisely what D1
forbids. The pane's IPC is also registered **before** the open attempt
(`src/main/index.ts`), so a failed open cannot leave `bus:snapshot` unhandled and
blank the pane.

Divergence counters come from #116 through `registerBusCounterSource()`
(`:193`) — a runtime seam rather than a static import, so #118 builds before
#116 lands. An **absent** source renders as an explicit "not publishing counters"
message, never as `0/0/0`: "#116 has not landed" and "zero divergence" are the
same empty array on the wire, and showing zeros for the first would be a
fabricated measurement.

## The startup notice

`writeBusSwitchState()` (`src/main/workspaces.ts:4506`) writes
`.orchestra/bus-switches` on **every spawn**, and
`BUS_SWITCHES_INSTRUCTION_SCRIPT` (`:3931`) cats it on SessionStart.

The state lives in a **file, not a script constant**, for a specific reason:
`installOrchestraHooks` short-circuits on a **hash of the script bodies**, so a
value baked into a body would be written once at provision time and never
corrected — the notice would confidently report last month's switch states
forever.

Every mechanism prints in **both** states (`busSwitchNoticeLines`,
`src/shared/bus-switches.ts:195`): `delivery=ON — the bus is AUTHORITATIVE…` or
`delivery=OFF — the OLD channel stays authoritative; the bus only COUNTS this
mechanism…`. OFF is never encoded as silence, because an agent cannot distinguish
an OFF switch from a build without switches from a truncated notice. A missing
state file makes the script a **silent no-op** rather than a false "all off".

## Schema

`MIGRATIONS[2]` in `src/main/bus.ts:185` creates `run_flags` (a sidecar, because
SQLite has no `ADD COLUMN IF NOT EXISTS` and a re-run would throw
`duplicate column name`). **Wave B renumbering rule** (ledger #123 Q-B1): four
tickets each need DDL and `migrate()` applies **by version index**, so two
tickets claiming the same number means the later one's SQL is skipped forever on
a DB already stamped with it. Take the next free number and renumber at rebase.

## Running the gates

```bash
node scripts/bus-pane-render-smoke.mjs        # T118.1 — seeded values reach the HTML;
                                              #   every assertion re-run against an EMPTY
                                              #   bus and REQUIRED to fail (vacuity detector)
node scripts/verify-bus-startup-notice.mjs    # T118.3 — 4 arms: ON / OFF / must-FAIL decoy /
                                              #   absent state file
RIG_WAYLAND=<marker-verified> node scripts/verify-bus-pane.mjs
                                              # T118.4+T118.5 under REAL Electron: bus-down,
                                              #   seeded control arm, broken-table arm, and the
                                              #   registrar refusing a writes:true channel
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
