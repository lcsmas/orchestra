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

**But the hang RATE cannot be attributed to any build, and neither can the claim
that this branch regressed it.** Measured block-wise (all runs of one bundle,
then the other), the same *unchanged master bytes* produced 0/10, 6/10 (the
reviewer's independent run), 8/10 and 10/10 within one session. Run
**interleaved with alternating order**, which cancels machine-state drift:

| protocol | MASTER | this branch |
|---|---|---|
| block, early | 0/10 | 8/10 |
| block, later | 10/10 | 10/10 |
| **interleaved, 10 pairs** | **0/10** | **1/10** |
| **interleaved, 25 pairs** | **0/25** | **0/25** |

So the "8/10 vs 0/10 regression" and the later "0/10, fixed" were **both
artifacts of block structure**, not properties of the code. The honest statement
is: the hang is real and machine-state-dependent; no measurement here separates
master from this branch; the code-level defect is fixed on its merits.

The gate therefore **reports** this rate and fails only on a TOTAL hang (every
run), which drift does not produce. Asserting `hung === 0` would fail honest
builds at random — a flaky gate teaches people to ignore it.

## Rig containment (LEAD order, ledger #70)

These rigs spawn hundreds of Electron processes and inherit `{...process.env}`,
which in an agent workspace carries the human's real `WAYLAND_DISPLAY`/`DISPLAY`.
Nothing on the CLI path opens a window, but that is luck rather than
containment. `verify-cli-pipe-flush.mjs` now blanks both display handles and
pins a throwaway `--user-data-dir`, so a window cannot reach the user's screen
and `~/.config/Electron` is never touched.
