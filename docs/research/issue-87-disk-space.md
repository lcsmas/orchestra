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
| `BUILD_PACKAGE_REQUIRED_BYTES` | **3 GiB** (was 2 GiB) | **Measured, and the first value was WRONG.** I derived 2 GiB from the 1.32 GiB *final* size plus "unmeasured staging headroom". Reviewer C3-F1 then sampled the real build at 1 s, 40 gapless samples: peak `release/` = `2262392` KiB = **2.158 GiB** (unpacked tree and AppImage coexist), settling to 1.215 GiB after cleanup. **My guess was 161 MiB BELOW the real peak** — the guard would pass and the build would then ENOSPC, i.e. the exact failure this ticket exists to eliminate. The instinct (peak > final) was right; the number was not, and only sampling found it. 3 GiB = peak + ~39% margin; **that margin is UNBASELINED** (peak is N=1 on one machine). |
| `E2E_RIG_REQUIRED_BYTES` | 256 MiB | **UNBASELINED.** Largest observed rig dir is 176 KiB, but a rig boots Electron, which writes caches and can dump a core. Conservative floor. |
| `WARN_FREE_BYTES` | 1 GiB | **UNBASELINED as "developer slack".** Nothing measured says 1 GiB specifically. Chosen so the warning arrives with room to spare before a packaging build's 3 GiB requirement. Applied only to volumes ≥ `SMALL_VOLUME_FACTOR`x the floor — see C3-F5 below. |
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

## Review round C3 — seven findings, all confirmed against live source

The reviewer's findings were verified independently before fixing, not relayed.
Three of them (F1, F2, F3) let the guard say OK and the build die on ENOSPC
anyway — the precise failure #87 exists to eliminate.

### F3 was the worst, and it was self-inflicted

`sampleVolumes()` (the UI half) probed `os.tmpdir()` correctly from the start.
The **guard** half was wired `--path .` — the repo. On this machine those are
different devices (cwd dev **45**, tmpdir dev **46**), and esbuild
(`esbuild/lib/main.js:2096`) plus electron-builder's `temp-file`
(`temp-file/out/main.js:24`) stage into the temp filesystem. So **the two halves
of one feature disagreed about which filesystem mattered**, and the half that
gates builds was pointed at the wrong one.

Before/after in one namespace, precondition printed beside each arm:

```
PRECONDITION: os.tmpdir()=/tmp/f3mnt avail=0
UNFIXED (probes cwd only, as nominated):
  disk-guard OK: <repo> free 465.2 GB of 550.0 GB, required 3.00 GB     RC=0   ← waved through
FIXED (probes cwd + tmp):
  ORCHESTRA_DISK_FULL: ... on /tmp/f3mnt ... free 0 B of 8.00 MB,
    required 3.00 GB (short by 3.00 GB)                                  RC=17
```

**Lesson recorded:** a guard's probe target is part of its predicate. I verified
the guard *fired correctly*, on a filesystem I chose, and never asked whether it
was the filesystem the guarded operation actually writes to. A rig that fills a
mount *of its own choosing* validates the mechanism and says nothing about the
aim.

### F2 — the same shape as my own surviving arm 3, one layer down

`scripts/disk-guard.cjs` is a second implementation of the decision. My parity
test checked constants and message *format* — never the comparison. Inverting
`freeBytes < requiredBytes` **survived the entire suite** (23 pass, RC=0) while
totally inverting behaviour: it refused builds on a 465 GB-free machine and
waved through a 909 TB requirement, even printing an incoherent "short by 0 B".

I had already found and published exactly this shape (arm 3, `bavail`→`bfree`)
and still shipped another instance of it in the same change. The fix extracts
the decision as an exported `isShort()` and asserts it directly in both
directions, plus a cross-implementation agreement test against the TS half.

### Findings and disposition

| # | Finding | Disposition |
|---|---|---|
| F1 | 2 GiB constant below the 2.158 GiB measured peak | **fixed** — 3 GiB, margin declared UNBASELINED |
| F2 | `.cjs` comparison untested; inversion survives the suite | **fixed** — `isShort()` extracted + tested both directions + parity vs TS |
| F3 | guard probed the repo; builds stage into tmpdir | **fixed** — presets carry a probe set covering both |
| F4 | CI calls electron-builder directly, bypassing the guard | **fixed** — explicit preflight in `release.yml` + a test pinning it before the packaging step |
| F5 | small volumes could never read `ok` (permanent warning) | **fixed** — byte floor applies only above `SMALL_VOLUME_FACTOR`x |
| F6 | `nearestExisting` walked to `/`, reporting OK for an absent path | **fixed** — refuses the root fallback; a real not-yet-created subdir still resolves |
| F7 | dead `fsType` field; undefined `--warning`/`--danger` CSS vars | **fixed** — field removed, vars switched to the repo's real `--yellow`/`--red` |

All seven fixes are mutation-defended: each mutant was verified live in the file,
run individually, and killed (F2 → 2 fail, F3 → 1 fail, F4 → 1 fail, F5 → 3 fail,
F6 → 1 fail).

**What the reviewer attacked and could not break:** the no-cleanup scope limit,
verified independently across the whole diff with per-pattern counts and a
positive control. That constraint held.
