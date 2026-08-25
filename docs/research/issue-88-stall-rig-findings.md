# Issue #88 — queue-stall alert: what the rig measured, and the traps that cost the most

Measured 2026-08-25 on this machine (btrfs under `~/.orchestra`, tmpfs on `/tmp`).
Rig: `scripts/e2e-stall-alert-rig.sh`. Every figure here has that rig behind it;
anything unmeasured is marked UNBASELINED rather than estimated.

## Why this doc exists

The findings below are not reconstructible from the diff. Three of them are
properties of the RIG rather than of the product, and each one produced a green
run that measured nothing — which is the failure mode that ships.

---

## 1. After the `observableSince` fix, a stall can no longer be SEEDED

The stall age is floored at app/renderer start (`observableSince` in
`src/shared/queue-stall.ts`), because `lastTurnStartAt` persists across a restart
while the `running` status it pairs with is floored to `idle` by `store.load()`.
Without the floor, a healthy agent's age included the entire time the app was
closed.

**Consequence for any future rig:** seeding an old `lastTurnStartAt` and cold-booting
does NOT produce a stall — the floor discards it. The app must actually OBSERVE the
silence, so a true-positive arm has to wait the threshold out in real time
(~16 min at the shipped `QUEUE_STALL_THRESHOLD_MS`).

This invalidated the original headline evidence: an arm seeding a 40-minute-old
stamp on a cold boot was itself an instance of the R1 defect, so the flagship
true-positive was measuring the bug it was meant to validate.

**Measured, same rig, identical preconditions** (`minutesSinceTurnStart: 840`,
`parkedInboxCount: 2`, cold boot):

| build | alpha row |
|---|---|
| pre-fix (`observableSince: 0`) | `badge:true`, `"stalled 14h"` |
| shipped | `badge:false` |

## 2. Seeding a COUNT does not seed an inbox

`parkedInboxCount` is re-derived from disk at startup by `reconcileParkedCounts()`
(that is what it is for — a shell hook drains inbox files while the app is closed).
A rig that seeds the field into `store.json` and boots reads back **0**.

The first version of the rig did exactly this, and its "no badge" arm passed for
the WRONG REASON: nothing was parked at all. Visible only because the rig prints
the PRECONDITIONS beside every verdict. Seed real delimited blocks into
`$HOME/.orchestra/inbox/<id>.txt` instead — which also drives the real producer.

## 3. `Page.reload` resets the clock the feature depends on

`OBSERVABLE_SINCE` is renderer module-eval time. The narrow-sidebar arm applied its
width via `localStorage` + `Page.reload` — restarting the 15-minute clock and
guaranteeing there was no badge left to measure. **The arm exited 0 having measured
nothing.**

Two fixes, the second more important:
- resize without reloading (drive the grid column / sidebar width directly);
- take a CONTROL reading at the default width FIRST, which must show a badge.
  `overflowsSidebar: null` means "no badge", not "no overflow", and those are
  indistinguishable in a pass/fail reading. The control converts that ambiguity
  into a failure.

Result once fixed: at `SIDEBAR_WIDTH_MIN` (240px) both badges sit at `right`
164/172 — contained. Note the containment assertion is against the SIDEBAR's rect,
not the window's: the #35 defect was an element inside its viewport but outside its
container, so a window-relative assertion is blind to exactly that bug.

## 4. The stall clock must measure CONSUMPTION, not ARRIVAL

Ageing from the newest arrival (`queuedAt`, or the newest parked block) is the
tempting simplification and it is wrong in the direction that hides the bug: an
arrival clock RESETS every time another peer pings the wedged agent, so the more
people notice it is stuck, the younger it looks.

**Measured on a real incident (2026-08-25)** — the #88 implementer's own workspace
wedged with 3 deliveries parked and 3 turns withdrawn unstarted, session alive,
status idle; a human was the detector. The same stall read **41.4 min** on a
first-arrival clock and **6.0 min** on a last-arrival clock. At the 15-minute
threshold those give OPPOSITE verdicts, and the last-arrival one — the more natural
reading, since it answers "how long has the newest message waited" — stays SILENT.

Guarded structurally by `queue-stall.test.ts`'s "QueueStallInput carries no arrival
timestamp", which reads the interface out of the source. **Two earlier versions of
that guard were vacuous** and only mutation testing found them: one asserted the
policy uses the number it is handed (a mutant reading a NEW input field survives,
since no fixture sets it); one asserted `Object.keys()` of the test's own fixture
literal (a constant the test controls — it tested the test).

## 5. Concurrent-append framing: real, but LATENT (issue #93)

`parkedInboxCount` is `parseInboxBlocks(file).length`, and `O_APPEND` atomicity holds
per WRITE CHUNK, not per `appendFile` call. Two concurrent appends of a block over
~448KB splice one block inside another; the real parser then reports **19 blocks for
10 messages**, so the badge would OVER-count.

**Unreachable through the only caller.** `dispatchMessageRequest` truncates to
`MESSAGE_MAX_CHARS = 8000` before building the body (`workspaces.ts:2777`), and all
three `queueInbox` call sites (`:2825`, `:2862`, `:2872`) pass that body:

| quantity | value |
|---|---|
| largest block `queueInbox` can write | **8276 bytes** |
| clean ceiling measured | 458752 bytes |
| headroom | **55x** |
| 30 concurrent max-size REAL messages | parse to exactly 30 |

The 1 MiB cap at `hooks-server.ts:166` bounds the HTTP REQUEST, not the block —
**reading that cap as the block size is the mistake that made this look live.**

It becomes reachable if `MESSAGE_MAX_CHARS` is raised toward 448KB, or a second
`queueInbox` caller appears that does not truncate. Fix belongs at the write
boundary (#93), not in the badge.

Boundary bracketed by ADJACENT samples (458752 clean / 524288 wrong); no threshold
is claimed inside that gap. Filesystems other than btrfs: UNMEASURED.

### The diagnosis that was nearly wrong

First reading looked like interleaving: all 10 writers "split" at 524241 of 524288.
But `totalBytesExact=true`, all delimiters present, and every writer split at the
IDENTICAL offset — and `524288 − 524241 = 47` is exactly the block header length.
Too regular for random interleaving. The control that settled it: **one writer, no
concurrency** → 524288/524288 clean, so the instrument was fine and the effect was
genuinely concurrency-related. The byte-level look then showed writer 1's COMPLETE
header landing inside writer 0's payload.

Also: the first sweep ran on `/tmp`, which is **tmpfs** — the wrong filesystem. The
inbox lives under `$HOME` on btrfs. A stale `(tmpfs on this host)` label in the
evidence dump is how that nearly went unnoticed twice.

## 6. C2 (#86) concurrent broadcast × `parkedInboxCount`: holds

The count is a PROJECTION of a file, recomputed from scratch on any signal — not an
accumulator fed by events. So concurrency can reorder, coalesce or duplicate the
signals without changing the answer.

- 8 concurrent appends to distinct files: 8/8 intact. 12 to the same file: 12/12.
- The directory watcher **coalesces** (12 appends → 2 events on one run). Harmless
  because the handler re-reads and counts from scratch; an edge-triggered counter
  would have lost 10 of 12. Quoted as evidence that coalescing HAPPENS, not as a
  ratio to rely on.
- No lost-update window: `readFileSync → getWorkspace → spread → upsertWorkspace`,
  and `upsertWorkspace` mutates in memory BEFORE its first `await`.
- 3 concurrent broadcasts × 5 overlapping targets → count converged on every target.

Note the un-deduped case, which per-broadcast dedup does NOT cover: two different
AGENTS broadcasting to an overlapping target at the same instant.

**Both harnesses are mutation-tested** — a green from a harness nobody has seen fail
is worth nothing. Stale-count injection → 5/5 targets WRONG; atomic `appendFile` →
non-atomic read-modify-write → 7/7 size rows flip to TORN.

## Still UNMEASURED

- No genuinely wedged AGENT in a rig. The arms observe real elapsed silence, but on
  an app whose agents were never alive. The only real one is the incident in §4,
  observed in production.
- `QUEUE_STALL_THRESHOLD_MS = 15 min` is reasoned, not measured. The turn-duration
  distribution across a fleet is UNBASELINED. Its safety rests on the `running`
  guard (a long turn holds `running` and cannot trip the badge), not on the number.
- Long branch names vs. the pill's fixed width, and non-default zoom: untested.
  Widths below 240px are unreachable through the UI (`SIDEBAR_WIDTH_MIN`).
- `reconcileParkedCounts()`'s app-closed-drain case is exercised only implicitly.
