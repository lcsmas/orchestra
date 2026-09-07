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
| `src/main/bus.test.ts` | 15 tests over a real SQLite file; each names the clause it kills |
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
`src/main/bus.ts:91` and `migrate()` (`:219`) applies forward-only migrations. A
DB written by a **newer** Orchestra is refused rather than run against an older
schema's expectations (`:221`).

## The four non-obvious decisions

### 1. `busy_timeout` lives in the ONE `open()` helper — `src/main/bus.ts:192`

Set on **every** connection, read-only ones included, deliberately *outside* the
`if (!opts.readonly)` block. Spike #109 condition 1: without it, 10 concurrent
writers **lose 7–27% of inserts** with no error any caller would notice. Putting
it at call sites is how one connection eventually misses it.

`scripts/verify-bus-contention.mjs` re-measures this on every run, and its
`busy_timeout=0` control **must lose inserts** — a clean control fails the
script, because it would mean the rig created no contention and the passing arm
proved nothing. Measured on btrfs: must-PASS `1000/1000, 0 BUSY, 0 gaps` in 4/4
runs; control lost 193–397 (19–40%).

**A vacuity trap worth knowing:** better-sqlite3's constructor *already* defaults
`timeout: 5000` and applies it. So asserting `busy_timeout === 5000` passes even
with the pragma deleted. `bus.test.ts` asserts a **non-default** value (1234) on
a read-only connection instead — the only shape that can actually fail.

### 2. The unique partial index is the primitive — NOT a cursor at take time

```sql
CREATE UNIQUE INDEX idx_deliveries_outstanding
  ON deliveries(run_id, reader) WHERE acked_at IS NULL;
```

At most **one outstanding lot per (run, reader)**. `check()` (`:301`) replays an
outstanding lot from its **frozen** `from_seq`/`to_seq`, so a redelivered lot is
byte-identical and does *not* fold in messages that arrived meanwhile — that is
what makes redelivery safe (spike arm 2).

`check()` writes **no cursor**. Advancing at take time is the naive design the
spike's must-FAIL control used, and it permanently loses a SIGKILLed reader's
lot. Spike arm 2b probed the index directly and found it load-bearing, so
`bus.test.ts` probes it directly too (raw insert must throw
`SQLITE_CONSTRAINT_UNIQUE`, plus two positive controls proving it does not
refuse *everything*).

**The ack belongs to the reader** (#108 round-4 hardening 1): `ack()` (`:350`)
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
`:441`), `scripts/build-bus-abi.mjs`, and the afterPack hook.

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

`src/main/index.ts:322` calls `initBus()` inside `createMainWindow()`, right
after `ensureRoot()`, and logs:

```
bus: opened /home/<user>/.orchestra/bus.sqlite (schema v1)
```

The line is emitted **after a real `new Database()` + `migrate()`** — that is the
boot gate. Failure is **fatal and loud** (`index.ts:325`), unlike the
best-effort subsystems around it: the app is usable without usage polling, but a
silently absent bus would let agents coordinate against a source of truth that is
not there. `closeBus()` runs last in `shutdownSubsystems()` (`:657`); a clean
close checkpoints the WAL back into the main file and truncates it (a crash
leaves ~600 KB behind — spike arm 3), which is hygiene, not durability.

`busPath()` (`:181`) follows `$ORCHESTRA_HOME`, so a dev instance never writes
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
