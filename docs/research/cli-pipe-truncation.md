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
surviving prefix was 146496 bytes (= 143 * 1024).

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

| arm | RC | bytes |
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
