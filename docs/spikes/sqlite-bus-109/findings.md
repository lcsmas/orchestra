# Spike #109 — better-sqlite3 WAL as a fleet message bus

> **VERDICT: GO-WITH-CONDITIONS.** On our stack (linux/arm64, Node 22.22.0, SQLite
> 3.49.2, better-sqlite3 11.10.0, DB on btrfs), one WAL database shared by a
> long-lived process and 10 concurrent short-lived CLI writers lost **0 of 1000
> inserts with 0 SQLITE_BUSY, 5 runs out of 5**, replayed a SIGKILLed consumer's
> batch **identically**, and recovered **50/50 committed rows** from a double
> SIGKILL mid-transaction. The four conditions are in
> [Conditions](#conditions-what-go-is-contingent-on) — the load-bearing ones are
> `busy_timeout` (without it we lose 7–27% of inserts) and the fact that the
> ~70 ms cross-process wake floor is **node process spawn, not the bus**.

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
| DB filesystem | btrfs on `/dev/nvme0n1p6` (**not** tmpfs — checked with `df -T`) |
| PRAGMAs | `journal_mode=WAL`, `synchronous=NORMAL`, `busy_timeout=5000` |
| Long-lived process | separate node process holding the DB open, reading continuously (Electron-main stand-in) |
| CLI clients | separate short-lived `node writer-cli.js` / `consumer-cli.js` processes — real spawn, real exit |

Every arm has a **must-PASS** and a **must-FAIL** control. A rig that cannot
fail is decoration; `controlValid: true` in each JSON is the assertion that the
must-FAIL arm actually failed. All six arms: `verdict PASS, controlValid true`.

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

# every arm writes out/<arm>.json; check BOTH fields:
node -e "for(const a of['arm1','arm2','arm2b','arm3','arm4','arm4b']){
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

## NOT VERIFIED

- **Anything under Electron.** Every process here is plain `node`. better-sqlite3
  is a native module and Electron uses a **different ABI** — it will need
  `electron-rebuild`, and that is a real integration risk this spike did not
  touch. The Electron main process is *simulated* by a long-lived node process.
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
