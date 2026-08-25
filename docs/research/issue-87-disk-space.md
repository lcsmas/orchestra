# Issue #87 — disk-space guard: what was measured

All figures below were taken **2026-08-25** on the dev machine, in the
`impl-disk-guard-87` worktree, with the command that produced them beside each.
Anything not measured is labelled **UNBASELINED** rather than given a number.

## The machine's actual mount layout (this is the whole point)

```
$ df -h /tmp $HOME /
Filesystem      Size  Used Avail Use% Mounted on
tmpfs            16G  681M   15G   5% /tmp
/dev/nvme0n1p6  551G   81G  466G  15% /home
/dev/nvme0n1p6  551G   81G  466G  15% /

$ findmnt -no TARGET,FSTYPE,SIZE,AVAIL /tmp
/tmp tmpfs 15.5G 14.8G
```

`/tmp` is a **separate 16 GiB tmpfs**, not part of `$HOME`'s 551 GiB
filesystem. During wave 6 it reached 100% while `$HOME` still had ~466 GiB
free. **A guard that read only `$HOME`'s filesystem would have reported
"plenty of room" throughout the incident.** This is why `sampleVolumes()`
probes three paths and de-duplicates by `st_dev` rather than by path.

## There was no free-space primitive at all before this change

```
$ grep -rn "statfs" src scripts | wc -l                      → 0
$ grep -rn "checkDiskSpace|freeBytes|availBytes|bavail" …     → 0
$ grep -rn "df -" src scripts | wc -l                        → 0
$ grep -rn "sampleResources" src scripts | wc -l             → 7   (positive control)
```

The positive control matters: three zeros from an unaudited grep would look
identical to three zeros from a broken grep.

## The slow-fill mechanism (the field observation nobody had written down)

```
$ ls -d /tmp/e2e* | wc -l
56
$ du -sk /tmp/e2e64c-* | sort -rn | head -2
176   /tmp/e2e64c-100331
160   /tmp/e2e64c-100459
```

**56** rig directories were already resident in `/tmp`. `scripts/e2e-contained-rig.sh`
*deliberately* leaves them for post-mortem inspection (see its teardown). Each is
trivial — the largest is 176 KiB — but nothing bounds the aggregate and nothing
may delete them (they can belong to a live sibling agent). So the failure mode is
not "one process wrote a huge file"; it is **slow accretion by many well-behaved
processes**, which is why the fix has to be a *warning surface* plus a *named
refusal*, and cannot be a cleanup.

## Where the threshold numbers come from

| Constant | Value | Basis |
|---|---|---|
| `BUILD_BUNDLES_REQUIRED_BYTES` | 64 MiB | **Measured.** `pnpm run build:bundles` (RC=0), then `du -sk dist dist-electron` → `5204` + `648` KiB ≈ **5.7 MiB** emitted. Rounded up an order of magnitude to cover vite temp files and sourcemaps, which were **not** measured separately. |
| `BUILD_PACKAGE_REQUIRED_BYTES` | 2 GiB | **Measured.** `du -sk /home/lmas/Applications/orchestra/release/` → `1379824` KiB ≈ **1.32 GiB** final output; the AppImage alone is 280.9 MB. electron-builder stages an unpacked app tree *and then* writes the AppImage, so peak transient use exceeds the final size — hence 2 GiB, not 1.32. The staging peak itself is **UNBASELINED**. |
| `E2E_RIG_REQUIRED_BYTES` | 256 MiB | **UNBASELINED.** Largest observed rig dir is 176 KiB, but a rig boots Electron, which writes caches and can dump a core. Conservative floor. |
| `WARN_FREE_BYTES` | 1 GiB | **UNBASELINED as "developer slack".** Nothing measured says 1 GiB specifically. Chosen so the warning arrives while a 2 GiB packaging build would still succeed. |
| `CRITICAL_FREE_BYTES` | 256 MiB | UNBASELINED, same reasoning one step tighter. |
| `WARN_FREE_PCT` / `CRITICAL_FREE_PCT` | 10% / 3% | Shape, not magnitude: they exist so a very large disk warns before it is millimetres from full. |

**The rule is the more conservative of the two arms** (warn if the byte floor
*or* the percentage breaches). A bare percentage is wrong at both ends: 5% of a
16 GiB tmpfs is 800 MiB (plenty), 5% of a 2 TiB disk is 100 GiB (absurdly
early).

## `bavail`, not `bfree`

`bfree` counts blocks reserved for root, which an agent process cannot write
into — on a default ext4 that is ~5% of total, so `bfree` over-reports usable
headroom. `df --output=avail` reports `bavail`, and is used in
`src/main/disk-space.test.ts` as an independent cross-check.

This was **not** enforced by anything at first: mutation arm 3 below survived.

## What the rigs proved

### `scripts/verify-disk-guard.mjs` — the named error vs. the ENOSPC shape

Mounts a **16 MiB tmpfs** — the same *filesystem type* that failed, at 1/1000th
the size — inside a private user+mount namespace (`unshare -rm`), fills it, and
runs both arms on that one mount at `avail_bytes=0`. **It never touches the
host's `/tmp`**: filling that is the incident itself and would break every
sibling agent.

```
RIG_FSTYPE=tmpfs
RIG_FILLED avail_bytes=0

UNFIXED_ERR code=ENOSPC errno=-28 msg=ENOSPC: no space left on device, write

ORCHESTRA_DISK_FULL: not enough free space on <mnt> for write payload.bin —
  free 0 B of 16.0 MB, required 8.00 MB (short by 8.00 MB).
  Orchestra does NOT auto-delete: another agent's rig may live on this mount.
RIG_ARM_FIXED_RC=17

disk-guard OK: <repo> free 465.3 GB of 550.0 GB, required 8.00 MB   ← CONTROL, rc=0
```

The **control arm is load-bearing**: without it, a guard hard-wired to always
fail would score identically on every other claim in the rig.

### `scripts/verify-disk-guard-ui.mjs` — both UI arms

Renders the real `FreeSpaceSection` twice, differing **only** in the volumes
passed, and screenshots each inside its own headless sway. One screenshot
cannot distinguish "renders the warning" from "always renders the warning", so
the normal arm asserting the *absence* of the badge is the load-bearing half.

`FreeSpaceSection` was extracted from `ResourcesView` precisely so this is
possible: `ResourcesView` takes no props and builds its world from the store
plus an IPC sample, so any warning-state assertion against it would have been
an assertion against my own stub.

## Mutation results (G5) — including the two that initially SURVIVED

One fix reverted per arm, each mutant verified live in the file before the run.

| Arm | Mutation | First result | After |
|---|---|---|---|
| 1 | drop the byte floor from the `critical` clause | **died** (16→15 pass, RC=1) | — |
| 2 | drop `\|\| pct < WARN_FREE_PCT` from the `warn` clause | **SURVIVED** (16 pass, RC=0) | dies, after adding a warn-percentage test |
| 3 | `st.bavail` → `st.bfree` | **SURVIVED** (tsc clean) | dies, after adding `src/main/disk-space.test.ts` |
| 4 | delete the warning badge from the UI | **died** (UI rig FAIL, RC=1) | — |

**Arms 2 and 3 are the finding worth recording.** Both were *documented in a
comment* and enforced by nothing:

- Arm 2: the *critical* percentage arm had a test; the *warn* percentage arm did
  not. Two clauses that look symmetrical in the source were not symmetrically
  covered, and reading the test file did not reveal that — only mutating did.
- Arm 3: `bavail`-vs-`bfree` is a pure semantics choice that typechecks either
  way, so `npx tsc --noEmit` is structurally incapable of catching it. Before
  the new test, the only thing defending it was a code comment — the
  highest-rot artifact there is.

## Refuted / rejected along the way

- **Loopback ext4 for the rig — rejected, and it is not merely a workaround.**
  `mount -o loop` needs privileges that `unshare -r`'s userns root does not
  confer (`/dev/loop*` control is host-global), so it failed. tmpfs mounts fine
  in the same namespace **and is the filesystem type from the actual incident**,
  so the substitution made the fixture more faithful, not less.
- **`chromium` for screenshots — rejected.** On this box `chromium` is a *shell
  function*, invisible to `spawnSync`, which returned `rc=null` — indistinguishable
  from a hung browser until probed with `type chromium`. Electron is a real
  binary in `node_modules` and is the runtime Orchestra actually renders in.
- **`BrowserWindow({ show: false })` — rejected.** `capturePage()` on a
  frame-less window returns an empty image: it wrote a **0-byte PNG at rc=0**, a
  silent no-op that reads as a rendering bug. This is the documented
  "frame-less windows silently no-op" gotcha, and it is the concrete reason the
  rig owns a real compositor instead of using a concealment trick.
- **Folding free space into `DiskStats` — rejected.** `DiskStats` answers
  "how much is Orchestra using" (via `du`, cached 60 s); free space answers
  "how much room is left" (via `statfs`, one syscall, uncached). Same units,
  different questions, different refresh economics.
- **`require.main === module` guard on `scripts/disk-guard.cjs`.** Without it,
  the parity test's `require()` executed `main()`, which set
  `process.exitCode = 1` and failed the **whole test file while every subtest
  reported `ok`** — a failure with no `not ok` line pointing at it.
