# CLI verdict truncation on a pipe (issue #62)

Measured 2026-08-25 against master `2ebd3fb` (v0.5.260), on the built
`dist-electron/cli.js` running inside a real Electron main process with stdout
on a pipe. Gate: `scripts/verify-cli-pipe-flush.mjs`.

## The defect

`process.stdout.write()` to a PIPE is asynchronous — libuv buffers whatever the
pipe will not accept immediately and flushes it on later ticks. `process.exit()`
called in the **same tick** as a large write abandons the remainder. The reader
gets a truncated prefix and **no error on any stream**, so the caller cannot
tell. A 3000-commit `verify-landed` NOT-LANDED verdict is 181945 bytes; the
surviving prefix was 146496 bytes. **No mechanism is asserted for that exact
figure.** An earlier version of this doc called it `143 * 1024`; that is wrong
(`143 * 1024 = 146432`, 64 bytes short) and the "portion libuv had handed to the
kernel" gloss attached to it was invented. It is an observation.

## It is a RACE, not a threshold — this is the load-bearing finding

The same bundle, same input, repeated runs:

| bundle | truncated |
|---|---|
| unfixed (`2ebd3fb`) | **4/20** |
| drain neutered (mutant) | **9/20** |
| fixed | **0/20** |

A single run of the *unfixed* build passes most of the time. Consequences:

- **Any one-shot check here is a dice roll that reads as a measurement.** During
  this investigation FIVE separate live-verified mutants of the fix each passed
  a one-run both-arms gate — not because the fix was redundant, but because they
  won the race on that run. The mutants only separated under repeated runs.
- The gate therefore asserts on the **rate** (`--runs`, default 20) and the
  fixed arm must be 0/N, not merely "better".
- `--expect-broken` refuses to pass when it sees no truncation, and says so:
  either the bundle is fixed or N runs is too few for this race.

## The cause is NOT what issue #62 proposed

#62 blamed "the exit-in-socket-callback context" and reported that the same blob
written *outside* that context flushed completely (298890/298890).

**That did not reproduce.** With the same payload and no socket anywhere:

All rows below come from the **STEP-1 ad-hoc discriminator rig**, whose payload
is a bare commit list of **181890** bytes. The committed gate
(`verify-cli-pipe-flush.mjs`) uses the full verdict — header plus zero-padded
shas — which is **181945** bytes. Two different payloads, hence two totals; both
are correct for their own rig. Recomputed from each rig's own generator.

| arm (STEP-1 rig, 181890-byte payload) | RC | bytes |
|---|---|---|
| `write(P); process.exit(2)` (Electron) | 2 | **146496/181890 truncated** |
| `write(P); exitCode=2; app.quit()` | **0** | 181890 complete, but RC is wrong |
| `await write-cb; process.exit(2)` | 2 | 181890/181890 complete |
| `write(P); setImmediate(()=>exit(2))` | 2 | 181890/181890 complete |
| **plain `node`** `write(P); exit(2)` | 2 | **146496/181890 truncated** |

Plain Node truncates at the identical byte count, so the defect is neither
socket-specific nor Electron-specific. The real axis is **same-tick exit vs
flushed exit**.

## Rejected fix candidate

`process.exitCode = n; app.quit()` flushed correctly but returned **RC=0**,
silently destroying the `0`/`1`/`2` exit-code contract that issue #59 exists to
protect. Do not use it.

## The fix

`exitAfterFlush(code)` in `src/cli/index.ts` awaits a `write('', cb)` on stdout
and stderr, then exits. `exitWith()` and `fail()` no longer call `process.exit`
themselves — they set `process.exitCode` and throw their sentinel, and `runCli`'s
catch does the flush-then-exit. #59's load-bearing throw is preserved, and
`scripts/verify-verify-landed-exit.mjs` still passes 8/8.

A first cut left a `throw` after `process.exit()` inside `exitAfterFlush`; under
Electron it was reachable and escaped `runCli` as an
`UnhandledPromiseRejectionWarning` **printed on stderr** — the very stream a
caller parses. The gate's "stderr quiet" control now covers that.

## UNEXPLAINED — left open honestly

- Issue #62 reports master truncating at **292992** bytes. Every master run here
  truncated at **146496**, never 292992. Not diagnosed.
- #62's own open item — why the fix-wave-5 candidate's surviving prefix was
  *smaller* than master's — is **not re-measured and remains UNEXPLAINED**. Given
  the race demonstrated above, prefix-size comparisons drawn from 3 runs per arm
  should be treated as unreliable rather than as a finding to explain.

## The broken-pipe hang (#62 R2) — and why its rate is NOT attributable

`orchestra verify-landed | head -1` closes the reader mid-write. The first cut of
`exitAfterFlush` tested `destroyed || writableEnded` **once, before**
`write('', cb)`, so when the reader hung up microseconds later the callback never
fired, `Promise.all` never settled, and a deliberate never-resolving tail promise
meant nothing could end the process.

The code defect is real and is fixed: the drain now resolves on the write
callback **or** `'error'`/`'close'` **or** a bounded timer. Those timers are
deliberately **not** `unref()`d — an unref'd timer does not hold the loop open,
so in exactly the case it guards it may never fire (measured: with `unref()`, 2/4
broken-pipe runs still hung, one taking 8.8s).

**⚠️ EVERY HANG-RATE FIGURE I MEASURED IS UNCONTAINED AND THEREFORE UNVERIFIED.**
All of my runs below predate the LEAD's containment quarantine and inherited the
human's real `WAYLAND_DISPLAY`/`DISPLAY`. Per the quarantine ruling they do not
count as evidence. They are kept only to record *why the numbers swung*, not as
measurements anyone may cite:

| protocol (UNCONTAINED — do not cite) | MASTER | this branch |
|---|---|---|
| block, early | 0/10 | 8/10 |
| block, later | 10/10 | 10/10 |
| interleaved, 10 pairs | 0/10 | 1/10 |
| interleaved, 25 pairs | 0/25 | 0/25 |

The one lesson that survives: **block-structured A/B on this axis is worthless.**
The same unchanged master bytes gave 0/10 and 10/10 in one session, so any
"master vs candidate" hang comparison run as two blocks measures drift.
Interleaving with alternating order is the minimum honest protocol.

**The only CONTAINED reading on the ledger is the reviewer's: MASTER 8/10 hung.**
An earlier version of this doc, and a shipped source comment, asserted "0/10 on
master" from an uncontained run. That claim is **retracted** — it contradicted
the only contained measurement, and it was load-bearing for a
"regression-not-inherited" framing it could not support.

The gate **reports** the rate and fails only on a TOTAL hang, which drift does
not produce. Asserting `hung === 0` on a noisy uncontained box would fail honest
builds at random; under proper containment a stricter bound is appropriate.

## Rig containment (LEAD order, ledger #70)

These rigs spawn hundreds of Electron processes and inherit `{...process.env}`,
which in an agent workspace carries the human's real `WAYLAND_DISPLAY`/`DISPLAY`.
Nothing on the CLI path opens a window, but that is luck rather than
containment. `verify-cli-pipe-flush.mjs` now blanks both display handles and
pins a throwaway `--user-data-dir`, so a window cannot reach the user's screen
and `~/.config/Electron` is never touched.

## NEW-1 — a fixed wall-clock bound truncates a SLOW reader (and how it was fixed)

The first bounded drain used a fixed 2000 ms deadline. A reviewer measured it
against a reader that was **alive and consuming**, just slowly (one chunk per
2500 ms), through one rig, three bundles:

| bundle | slow reader @2500 ms/chunk |
|---|---|
| `2ebd3fb` master (no flush) | 4/4 TRUNCATED @146496 B |
| `16b96bf` (UNBOUNDED flush) | 0/4 — 181945/181945 B complete, 5266 ms |
| `a8baa2a` (bounded 2000 ms) | **4/4 TRUNCATED @146496 B, RC=2** |

Bracketed: @150 ms/chunk 0/5, @900 ms/chunk 0/4 (landing at 2050–2132 ms, right
at the boundary), @2500 ms/chunk 4/4. **The cliff is the timeout itself.**

That is #62's exact failure reintroduced — and worse than the original, because
it exits **RC=2**, a successful-looking NOT-LANDED verdict that is silently
incomplete. The docblock's justification, *"exiting is always preferable to
hanging"*, is **false for this verb**: a hang is visible and gets investigated; a
short commit list that exits 2 gets acted on. `verify-landed`'s contract IS the
complete list.

**Root cause of the design error: a slow reader and a dead reader are
indistinguishable to a wall-clock timer.** The fix is to bound on *progress*
instead of elapsed time — the deadline is pushed out every time the stream
actually accepts bytes (`'drain'`, or a completed write callback). A live-but-slow
reader keeps extending it no matter how long the transfer takes; a dead reader
makes no progress by definition and trips it once. `'error'`/`'close'` still
cover the dead reader promptly; the timer is only the backstop for a stall that
reports neither.

## R2's real root cause: a listener attached too late (contained measurements)

The broken-pipe hang was NOT a stalled drain. Instrumenting the real bundle
under a hung-up reader:

```
[probe 55ms] write returned true writableLength=0
[probe 1057ms] t+1s destroyed=false ended=false len=0
[probe 3056ms] t+3s destroyed=false ended=false len=0
```

`write()` reports success, nothing is buffered, and the stream keeps reporting
`destroyed=false`/`writableEnded=false` **indefinitely**. So every flag-based
guard is blind here, and `process.exit()` itself works fine under a hung-up pipe
(four variants, all RC=2 in <1.3 s).

The discriminator, isolated by one variable:

| child main script | broken-pipe hang |
|---|---|
| plain | **5/5 HUNG** |
| `process.stderr.write(...)` first | 5/5 HUNG |
| **stdout `'error'`/`'close'` listeners attached BEFORE the write** | **0/5, RC=2 ~280 ms** |

**EPIPE is delivered as the write happens.** Listeners attached later — i.e.
inside `exitAfterFlush`, which runs after the verdict is written — wait for an
event that has already fired and been dropped. The fix installs them once at
module startup (`outputHungUp`), and the drain consults that flag, because the
stream's own flags never reflect the hang-up.

A late listener is indistinguishable from a correct one by reading the code:
both look like "we handle EPIPE". Only the measurement separates them.

### Contained gate results (final)

| arm | master `2ebd3fb` | this branch |
|---|---|---|
| big verdict truncated | **7/12** | **0/12** |
| slow live reader @2500 ms/chunk | **3/3 @146496 B** | **0/3, 181945 B** |
| broken pipe `\| head -1` hung | **5/6** | **0/6** |
| gate verdict | **RC=1 FAIL** | **RC=0 PASS** |

Master fails all three axes through the identical rig, so none of these arms
could pass on both builds.

### An earlier retraction that stands

Every hang figure I measured UNCONTAINED is void, including a "master 0/10" that
briefly reached a shipped source comment and contradicted the only contained
reading. Contained, master hangs 9/12 on this axis. Block-structured A/B here is
worthless — interleave, or contain, or both.
