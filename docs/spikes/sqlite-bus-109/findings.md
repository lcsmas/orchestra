# Spike #109 — better-sqlite3 WAL as a fleet message bus

> **VERDICT: GO-WITH-CONDITIONS.** On our stack (linux/arm64, Node 22.22.0, SQLite
> 3.49.2, better-sqlite3 11.10.0, DB on btrfs), one WAL database shared by a
> long-lived process and 10 concurrent short-lived CLI writers lost **0 of 1000
> inserts with 0 SQLITE_BUSY, 5 runs out of 5**, replayed a SIGKILLed consumer's
> batch **identically**, and recovered **50/50 committed rows** from a double
> SIGKILL mid-transaction. **Arm 5 re-ran contention and ack-replay with the REAL
> Electron main (33.4.11, windowless) as the long-lived process — same results:
> 1000/1000, 0 BUSY, identical replay.** The Electron ABI risk flagged in the
> first pass is now **measured and closed**: node ABI 127 vs Electron ABI 130,
> **two builds required**, but `ELECTRON_RUN_AS_NODE` is also ABI 130, so **one
> Electron build serves both main and the packaged CLI**. Conditions in
> [Conditions](#conditions-what-go-is-contingent-on) — the load-bearing ones are
> `busy_timeout` (without it we lose 7–27% of inserts) and the fact that the
> ~70 ms cross-process wake floor is **node process spawn, not the bus**.

> **⚠ CARRY THIS INTO THE IMPLEMENTATION — the most useful finding here.**
> **`require('better-sqlite3')` SUCCEEDS under the WRONG ABI.** The native binding
> load is deferred to the first `new Database()`, so a bare `require` proves
> nothing and returns a plausible pass under both runtimes. This produced a
> **false "node can load it"** result in this very spike, caught only by loading
> the same bytes by absolute path. **Any ABI check — in a build gate, a preflight,
> or a test — must CONSTRUCT a DB, never just require the module.**

Issue: [#109 — Spike: better-sqlite3 WAL bus shared by app main process + concurrent CLI writers](https://github.com/lcsmas/orchestra/issues/109)
(child of the wayfinder map [#104](https://github.com/lcsmas/orchestra/issues/104); constraints from
[#108 — wake-as-turn, level-triggered re-wake, batch+ack](https://github.com/lcsmas/orchestra/issues/108)).

**This is a throwaway spike. INTENTIONALLY UNMERGED. Nothing here is production
code and nothing in `src/` was touched.** Reference model: [stablyai/orca](https://github.com/stablyai/orca) (MIT).

---

## Rig (identical for every number below)

| | |
|---|---|
| Date | 2026-09-07 |
| Host | linux/arm64, 10 CPUs |
| Node | v22.22.0 |
| SQLite | 3.49.2 (via better-sqlite3 11.10.0, built from source — no arm64 prebuild) |
| ABIs | node **127** vs Electron 33.4.11 **130** — two builds, kept in `abi/` |
| DB filesystem | btrfs on `/dev/nvme0n1p6` (**not** tmpfs — checked with `df -T`) |
| PRAGMAs | `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` |
| Long-lived process | arms 1–4: node stand-in. **Arm 5: the REAL Electron 33.4.11 main**, windowless, `env -i`, no `DISPLAY`/`WAYLAND_DISPLAY` |
| CLI clients | separate short-lived `node writer-cli.js` / `consumer-cli.js` processes — real spawn, real exit |

Every arm has a **must-PASS** and a **must-FAIL** control. A rig that cannot
fail is decoration; `controlValid: true` in each JSON is the assertion that the
must-FAIL arm actually failed. All **seven** arms: `verdict PASS, controlValid true`
(arm 5 additionally asserts `rigValid: true` — a real, windowless Electron main was attached).

---

## Numbers

### 1. Write contention — 10 CLI writers × 100 inserts, live reader attached

| | must-PASS (`busy_timeout=5000`) | must-FAIL control (`busy_timeout=0`) |
|---|---|---|
| Expected inserts | 1000 | 1000 |
| Committed | **1000** | 705–872 |
| Lost inserts | **0** | **128–295** |
| SQLITE_BUSY | **0** | **70–268** |
| Sequence gaps | **0** | 0 |
| p50 insert | **0.013 ms** | 0.013 ms |
| p99 insert | **0.18–1.46 ms** | 0.12–0.29 ms |
| max insert | 3.5–20.2 ms | 4.3–6.5 ms |
| Throughput | ~7 600 inserts/s | — |
| Reader during run | 452–492 reads, **0 read-BUSY**, saw all 1000 rows | — |

Repeated **5×** (this axis is noisy — the control's loss count swings 70→268):
must-PASS was `busy=0 lost=0 gaps=0` in **5/5** runs; the control lost inserts in
**5/5**. WAL readers never block on writers (0 read-BUSY), as WAL promises.

> The `busy_timeout=0` control is the whole reason this is GO rather than a
> guess: **without it we silently lose 7–27% of messages** — no exception the
> caller would notice beyond the `SQLITE_BUSY` it must handle.

### 2. Ack-replay across a SIGKILLed consumer

Sequence: seed 5 → consumer takes batch → **real SIGKILL before ack** → 3 more
messages arrive while the batch is outstanding → next check → ack → next check.

| | must-PASS (`deliveries` + unique partial index) | must-FAIL control (naive cursor) |
|---|---|---|
| Kill signal observed | `SIGKILL` | `SIGKILL` |
| Batch taken, then killed | `[1,2,3,4,5]` | `[1,2,3,4,5]` |
| Check after crash | **`[1,2,3,4,5]` (replay, identical)** | `[6,7,8]` ← **skipped past** |
| `replay` flag | `true` | n/a |
| Check after ack | **`[6,7,8]` (only newer)** | `[]` |
| Outstanding at end | 0 | 0 |
| **Messages lost** | **none** | **`[1,2,3,4,5]`** |

Replay does **not** fold in the 3 messages that arrived while the batch was
outstanding — the batch is byte-identical, which is what makes redelivery safe.

**2b — is the unique partial index actually load-bearing?** Probed directly,
because arm 2 could have been correct for another reason:

| | with index | without index |
|---|---|---|
| 2nd outstanding batch, same consumer | **REFUSED — `SQLITE_CONSTRAINT_UNIQUE`** | accepted |
| Different consumer | allowed | allowed |
| Same consumer after ack | allowed | allowed |
| Outstanding rows at end | 1 | 2 |

The index refuses the double-take *without* refusing everything (a constraint
that rejected all inserts would also have produced "refused" — the two positive
controls rule that out).

### 3. Crash recovery — keeper + CLI writer both SIGKILLed mid-transaction

Writer commits 50 rows, opens `BEGIN IMMEDIATE`, writes 10 more, parks; then
**both** the long-lived keeper and the writer are SIGKILLed; a fresh process reopens.

| | must-PASS | must-FAIL control (`-wal` deleted) |
|---|---|---|
| Committed rows lost | **0 / 50** | **50 / 50** |
| Uncommitted rows surviving | **0 / 10** | 0 / 10 |
| Rows after reopen | 50 | 0 |
| `PRAGMA integrity_check` | **ok** | ok |

**Checkpoint behaviour / file sizes:**

| | main `.db` | `-wal` | `-shm` |
|---|---|---|---|
| At crash (50 committed + 10 dirty) | 32 768 B | **618 032 B** | 32 768 B |
| After both SIGKILLs | 32 768 B | 618 032 B | 32 768 B |
| After clean reopen + close | 32 768 B | **0** | 0 |

The main DB file never grew: **every committed row lived only in the WAL** until
the reopen checkpointed it. That is exactly why the WAL-deleted control loses all
50 — and it is the proof the recovery is genuinely reading the WAL rather than an
already-checkpointed main file. A crash leaves a ~600 KB `-wal` behind; a clean
close truncates it to 0.

### 4. Wake latency — 100 samples per primitive

Measured **end to end on the waiter's side**: `t0` immediately before commit,
`t1` when the waiter has *queried and actually seen the row*. A notification that
arrives before the row is visible does not count as a wake.

| Primitive | p50 | p95 | p99 | max | timeouts | extra moving parts |
|---|---|---|---|---|---|---|
| **`fs.watch` on `-wal`** | **0.234 ms** | 0.644 ms | 1.48 ms | 2.01 ms | 0/100 | none |
| unix-socket bell | 0.767 ms | 2.119 ms | 3.043 ms | 3.82 ms | 0/100 | a listening socket to babysit |
| 250 ms poll | 244.9 ms | 246.3 ms | 247.0 ms | 248.1 ms | 0/100 | none |
| *must-FAIL: watcher on a file nobody writes* | — | — | — | — | **100/100** | control valid |

**`fs.watch` is ~1000× better than 250 ms polling and ~3× better than a socket
bell, with the fewest moving parts.**

**4b — cross-process sanity check**, because arm 4 armed the watcher in the same
process that inserted. Writer is a genuinely separate short-lived CLI process:

| | p50 | p99 | samples | timeouts |
|---|---|---|---|---|
| cross-process `fs.watch` | 70.7 ms | 104.7 ms | **100/100** | 0 |
| *control: writer inserts into a **different** DB* | — | — | **0/100** | 100 |

> **Read this number correctly.** The ~70 ms is dominated by **node process spawn**
> (~65 ms), *not* by the wake — arm 4's 0.23 ms is the true wake cost. `fs.watch`
> fires reliably across processes (100/100) and does not fire for an unrelated DB
> (0/100). The practical consequence is the opposite of a bus problem: **if a wake
> must spawn a process, process startup is the floor, and it dwarfs everything
> SQLite does.**

---

### 5. Real Electron main as the long-lived process (closes the #1 open risk)

Arms 1 and 2 rerun with the **actual Electron 33.4.11 main process** from this
repo's `node_modules` holding the DB open — not a node stand-in. No
`BrowserWindow` is ever created; Electron is launched under an `env -i`
allowlist with **`DISPLAY` and `WAYLAND_DISPLAY` absent**, and the main process
aborts with exit 97 if either is present. Each run records
`browserWindowsCreated: 0` and `hadDisplayEnv: false` **from inside the process**.

**ABI — the packaging answer:**

| | value |
|---|---|
| node ABI (`process.versions.modules`) | **127** |
| Electron 33.4.11 ABI | **130** |
| Same binary serves both? | **NO** |
| `ELECTRON_RUN_AS_NODE` ABI | **130** (Electron's V8, *not* system node) |
| Electron's bundled node | 20.18.3 |

A `.node` built for one runtime is **unusable** under the other
(`NODE_MODULE_VERSION 130` vs required 127), so the spike keeps **two builds** in
`abi/` and loads the right one per runtime via `nativeBinding`.

> **Which runtime do the CLI clients run under? — this decides packaging.**
> `ELECTRON_RUN_AS_NODE` reports **ABI 130**, so the packaged `orchestra` CLI
> (which is the Electron binary in as-node mode, per `src/main/keeper-client.ts`)
> needs the **same Electron-ABI build as main — one build ships, not two.**
> The `#!/usr/bin/env node` shebang path is the exception: a CLI invoked through
> **system node** would need the ABI-127 build. So: **ship the Electron build and
> ensure the CLI always runs on the bundled Electron binary.**

**Results (must-PASS / must-FAIL per sub-arm, `rigValid: true`):**

| | must-PASS (`busy_timeout=5000`) | must-FAIL (`busy_timeout=0`) |
|---|---|---|
| Committed / expected | **1000 / 1000** | 777 / 1000 |
| Lost inserts | **0** | **223** |
| SQLITE_BUSY | **0** | **223** |
| Sequence gaps | **0** | 0 |
| p50 / p99 insert | **0.013 / 0.342 ms** | 0.014 / 0.371 ms |
| Electron main reads | 105 121 @ **0 read-BUSY** | 107 325 @ 0 read-BUSY |
| BrowserWindows created | **0** | **0** |

Ack-replay under a live Electron main: batch replays **`[1,2,3,4,5]`** identically
after SIGKILL, then **`[6,7,8]`** only after ack; the naive control again loses
`[1,2,3,4,5]`. Both `controlValid: true`.

> **One number in `arm5.json` must NOT be read as a bus result:**
> `throughputInsertsPerSec` (~8/s) is a **harness artifact** — this arm waits for
> writer exit with a 20 ms poll per writer, inflating `wallMs` to 120 s. The 1000
> inserts represent only **~65 ms** of actual SQLite work. Arm 1's ~7 600 ins/s
> is the throughput figure; arm 5's latency and correctness numbers are unaffected.

---

## Conditions (what GO is contingent on)

1. **`busy_timeout` is mandatory, on every connection, including read-only ones.**
   Without it we lose 7–27% of inserts under 10-writer contention. It must be set
   in the one shared `open()` helper, never per call site.
2. **Wake with `fs.watch` on the `-wal` file, and keep it level-triggered from
   durable state** as [#108](https://github.com/lcsmas/orchestra/issues/108) requires. The measurement supports #108's design rather than
   replacing it: `fs.watch` is cheap enough that re-arming on startup + a periodic
   sweep costs nothing, and a lost/duplicated inotify event is then harmless.
   *(Not measured: inotify behaviour on macOS/Windows — see NOT VERIFIED.)*
3. **The ack belongs to the reader, and the outstanding-batch index is the
   primitive.** Arm 2b shows the unique partial index is what makes redelivery
   safe; the naive alternative silently loses a killed consumer's batch. Do not
   advance a cursor at take time.
4. **Budget the wake path for process spawn, not for SQLite.** At ~65 ms per node
   spawn, a design that spawns per message is bounded by spawn cost; the bus
   itself is ~0.01 ms per insert.

5. **Ship the Electron-ABI build, and keep the CLI on the bundled Electron
   binary.** node and Electron ABIs differ (127 vs 130) and the binaries are
   mutually unusable; `ELECTRON_RUN_AS_NODE` is ABI 130, so one build covers main
   *and* the packaged CLI. A CLI run through **system node** would need a second
   build — avoid that path, or ship both. Add `@electron/rebuild` to the build.

**Coexistence** ([#108](https://github.com/lcsmas/orchestra/issues/108)'s standing constraint) is unaffected by anything measured
here: the bus is a plain file with its own tables, so shadow-mode dual-writing
needs no cutover. **Not measured** — the shadow-mode comparison itself.

---

## Reproduce

```bash
cd docs/spikes/sqlite-bus-109
pnpm install --ignore-workspace
# no arm64 prebuild exists; build the native binding from source:
(cd node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3 \
   && npx --yes node-gyp@10 rebuild --release)

node arm1-contention.js          # write contention + no-busy_timeout control
node arm2-ack-replay.js          # SIGKILL replay + naive-consumer control
node arm2b-index-primitive.js    # is the unique partial index load-bearing?
node arm3-restart-recovery.js    # double SIGKILL mid-txn + wal-deleted control
node arm4-wake-latency.js        # fswatch vs socket vs poll + dead-watcher control
node arm4b-crossproc-fswatch.js  # fswatch across real processes + other-db control

# ARM 5 — real Electron main. Needs BOTH ABI builds in abi/ (gitignored, ~4 MB;
# regenerate them, do not commit them):
mkdir -p abi
cp node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   abi/better_sqlite3-node-abi127.node            # the node-ABI build from above
npx @electron/rebuild@3.7.1 -v 33.4.11 -m . -f -w better-sqlite3
cp node_modules/.pnpm/better-sqlite3@11.10.0/node_modules/better-sqlite3/build/Release/better_sqlite3.node \
   abi/better_sqlite3-electron-abi130.node        # now the Electron-ABI build
node arm5-electron.js            # contention + ack-replay under Electron 33.4.11
# bus.js picks the right one per runtime; it never mutates the installed copy.

# every arm writes out/<arm>.json; check BOTH fields:
node -e "for(const a of['arm1','arm2','arm2b','arm3','arm4','arm4b','arm5']){
  const r=require('./out/'+a+'.json');console.log(a,r.verdict,'controlValid',r.controlValid)}"
```

`WRITERS`, `INSERTS` and `SAMPLES` are env-overridable.

---

## VERIFIED (claim + the literal command that produced it)

- **better-sqlite3 is NOT a dependency of this repo** (root or otherwise), so the
  spike vendored its own — `pnpm ls better-sqlite3` (empty) and
  `ls node_modules/better-sqlite3` → *No such file or directory*.
- **No arm64 prebuild exists; the binding builds from source and loads** —
  `npx node-gyp@10 rebuild --release` → `gyp info ok`; then
  `node -e "require('better-sqlite3')"` → `sqlite_version 3.49.2`.
- **DB is on btrfs, not tmpfs** (so the contention numbers are not a tmpfs
  artifact) — `df -T out/` → `/dev/nvme0n1p6 btrfs`, recorded in `arm1.json.rig.dbOn`.
- **1000/1000 inserts commit, 0 BUSY, 0 gaps, in 5/5 runs** —
  `for i in 1 2 3 4 5; do node arm1-contention.js > out/arm1-run$i.json; done`.
- **Without `busy_timeout` the same rig loses 70–268 inserts every run** — same
  command, `mustFail` branch of each `out/arm1-run$i.json`.
- **The long-lived reader was genuinely attached during contention** (452–492
  reads, `lastSeen.c == 1000`) — `arm1.json.mustPass.readerReport`. *This started
  as `null` (kill and read in the same tick) and was fixed to await the reader's
  exit; the first run's contention claim was unproven until then.*
- **A SIGKILLed consumer's batch replays with identical ids, and only newer rows
  follow the ack** — `node arm2-ack-replay.js` → `checkAfterCrash [1,2,3,4,5]`,
  `checkAfterAck [6,7,8]`, `killWasReal true`.
- **The naive consumer permanently loses the killed batch** — same command,
  `mustFail.lostMessages [1,2,3,4,5]`.
- **The unique partial index refuses a second outstanding batch with
  `SQLITE_CONSTRAINT_UNIQUE`, while still allowing another consumer and
  re-allowing after ack** — `node arm2b-index-primitive.js`.
- **50/50 committed rows survive a double SIGKILL mid-transaction; all 10
  uncommitted roll back; `integrity_check` ok** — `node arm3-restart-recovery.js`.
- **Committed rows live in the `-wal` (618 032 B) with the main file unchanged at
  32 768 B, and a clean close truncates the WAL to 0** — `arm3.json.fileSizes`.
- **Deleting the `-wal` loses all 50 rows** (proof the reopen reads the WAL) —
  same command, `mustFailControl`.
- **`fs.watch` on `-wal`: p50 0.234 ms / p99 1.48 ms over 100 samples, vs socket
  0.767/3.04 and poll 244.9/247.0** — `node arm4-wake-latency.js`.
- **A watcher on a file nobody writes records 0 wakes and times out 100/100** —
  same command, `mustFailControl`.
- **`fs.watch` fires cross-process 100/100 and never for an unrelated DB (0/100)** —
  `node arm4b-crossproc-fswatch.js`.

- **Electron 33.4.11 ABI is 130, node's is 127, and the binaries are mutually
  unusable** — `electron -e "process.versions.modules"` → `130` vs `node -p` →
  `127`; loading each `.node` under the other runtime → `NODE_MODULE_VERSION 130.
  This version of Node.js requires ... 127`.
- **`ELECTRON_RUN_AS_NODE` is still ABI 130** (so the packaged CLI needs the
  Electron build, not a node build) — `ELECTRON_RUN_AS_NODE=1 electron -e
  "process.versions.modules"` → `130`, and it loads the ABI-130 binary while
  refusing the ABI-127 one.
- **`require('better-sqlite3')` SUCCEEDS under the wrong ABI and only
  `new Database()` fails** — the native load is deferred. My first ABI probe
  reported "node CAN load current build" and was a **false pass**; constructing a
  DB gave `require OK but UNUSABLE`. Every ABI claim here constructs a DB.
- **Electron direct-loads its own binary and does not mutate the installed one** —
  installed the *wrong* (ABI-127) binary as a trap, ran Electron: it succeeded and
  the installed file's sha was unchanged (`5eb30f31…` before and after).
- **1000/1000 inserts, 0 BUSY, 0 gaps with a REAL Electron main attached** (which
  did 105 121 reads at 0 read-BUSY, `browserWindowsCreated: 0`,
  `hadDisplayEnv: false`) — `node arm5-electron.js`, `out/arm5.json`.
- **Same rig without `busy_timeout` loses 223 inserts** — same file, `contention.mustFail`.
- **Ack-replay is identical under Electron**: `[1,2,3,4,5]` replayed then `[6,7,8]`
  after ack; naive control loses `[1,2,3,4,5]` — `out/arm5.json.ackReplay`.

## NOT VERIFIED

- **~~Anything under Electron~~ — CLOSED by arm 5.** Contention and ack-replay now
  run against the real Electron 33.4.11 main. Still untested *under Electron*:
  arms 3 (crash recovery) and 4 (wake latency) — both were run only with the node
  stand-in, and `fs.watch` inside Electron's main event loop is **not** measured.
- **A packaged/asar build.** Arm 5 runs Electron from `node_modules`, not a built
  AppImage; native-module resolution inside `app.asar` is a known separate trap
  and was not exercised.
- **Arm 5's `throughputInsertsPerSec` (~8/s) is a HARNESS ARTIFACT, not a
  measurement** — the writer-exit poll inflates `wallMs` to 120 s for ~65 ms of
  real SQLite work. Use arm 1's ~7 600 ins/s.
- **Any platform except linux/arm64.** No macOS, no Windows, no x64. Notably
  `fs.watch` is inotify here; macOS FSEvents and Windows have different
  coalescing and latency, and condition 2 rests on this.
- **Network/remote filesystems.** WAL is documented to be unsafe over NFS; not
  probed. Only a local btrfs volume was measured.
- **Real Orchestra traffic shapes.** Message bodies are short synthetic strings;
  no real digests, no large payloads, no realistic arrival distribution. The
  bus was empty at the start of every arm — **no measurement at scale** (aged DB,
  millions of rows, index growth, retention/vacuum).
- **More than 10 concurrent writers**, and any run longer than ~130 ms. Sustained
  load, WAL growth under continuous write, and `wal_autocheckpoint` behaviour over
  time are unmeasured.
- **The `deliveries`/fencing model against the LEAD → OPS → workers topology**
  ([#108](https://github.com/lcsmas/orchestra/issues/108)): nested runs, generation bump on OPS death, and heartbeat escalation
  are **not** exercised — this spike measured the substrate, not the topology.
- **Wake-as-turn**, the actual [#108](https://github.com/lcsmas/orchestra/issues/108) requirement: I measured that a wake *signal*
  arrives in 0.23 ms. That the app can turn that signal into a **session turn**,
  and what that costs, is untested.
- **Shadow-mode dual-write** and the promotion bar from [#108](https://github.com/lcsmas/orchestra/issues/108)'s coexistence
  constraint.
- **`synchronous=NORMAL` under power loss.** The arms kill *processes*
  (SIGKILL), which WAL survives by design. `NORMAL` can lose recent commits on
  **OS/host** crash; that is a different failure mode and was not tested.
- **Multi-consumer concurrency**: two consumers of the *same* run checking
  simultaneously. Arm 2b shows the index permits distinct consumers, but no
  concurrent-consumer race was run.
