# The durable inbox as a UI surface — measurements behind issue #64

Recorded while implementing the composer inbox tray (fix-wave-6, base `2ebd3fb`
/ v0.5.260). Kept because three of these facts are not derivable from the
ticket, and one of them changes the design.

Verify anchors against live source before relying on them — line numbers drift.

## 1. The on-disk format, verified from BOTH ends

`queueInbox` (`src/main/workspaces.ts`) appends, per message:

```
\n========================================\n<body>\n========================================\n
```

40 `=` on their own line, before and after. `<body>` is what `formatPeerMessage`
produced:

```
[message from agent '<branch>' (<from-id>)]
<text>

Reply with: orchestra message <from-id> "<reply>"
```

Because it APPENDS, a file holds N such blocks in arrival order.

Confirmed two independent ways, which is the control: read out of the writer,
and read with `cat -A` off a live file in `~/.orchestra/inbox/`. The parser's
test fixture is a byte-for-byte copy of that captured block rather than a
hand-authored string — a fixture I invent only re-encodes my own assumptions.

## 2. THE FINDING THAT CHANGES THE DESIGN: the file is shared with a shell hook

`HOOK_INBOX_DELIVER_CMD` (`src/main/workspaces.ts`) runs
`.orchestra/inbox-instruction.sh`, whose body is
`[ -s "$f" ] || exit 0; cat "$f"; rm -f "$f"`.

It is registered on **BOTH** hook events:

| Event | Registration site |
|---|---|
| `UserPromptSubmit` | `workspaces.ts`, `upsertHookCommand(submitList, HOOK_INBOX_DELIVER_CMD)` |
| `SessionStart` | `workspaces.ts`, `upsertHookCommand(sessionStartList, HOOK_INBOX_DELIVER_CMD)` |

So **an ordinary user turn drains and DELETES the whole file**, with no main-process
involvement at all. Three consequences, all load-bearing:

1. A block can vanish between the tray rendering it and the human clicking it.
   Therefore blocks are addressed by their exact **TEXT**, never by index — an
   index would silently address a *different* message. A miss returns
   `{ok:false, reason:'gone'}`, which is a NORMAL outcome, not an error.
2. The tray must retract on a drain it never initiated. Hence main watches the
   inbox **directory** (not each file: files are created and deleted, and a watch
   on a deleted path dies with it) and pushes `inbox:update`.
3. There is **no lock anywhere** on this file — `queueInbox` uses `appendFile`,
   the hook uses `cat` + `rm -f`, and the tray rewrites it. Both tray mutations
   (`releaseInboxBlock` and `refuseInboxBlock`) re-read the file immediately
   before writing, so a stale snapshot cannot resurrect blocks the hook already
   handed to the agent, nor clobber a `queueInbox` append that lands mid-window.
   This is a narrowed race, not an eliminated one; a genuine fix would need the
   hook to take a lock (see "Not done" below).

   > **CORRECTION (adversarial review, R2).** An earlier version of this
   > paragraph claimed "*every* tray mutation" already did this. **That was false
   > as written**: `refuseInboxBlock` read once and wrote the whole file, so a
   > peer message appended during the match-and-log window was measurably lost
   > (reproduced: `gamma`'s message gone from disk). Release was guarded; refuse
   > was not — an oversight, not an accepted risk. Now fixed, with a both-arms
   > regression test and a source-binding guard
   > (`src/main/inbox-tray-rmw.test.ts`) that fails if either mutator stops
   > re-reading. Recorded rather than silently edited because I wrote the
   > invariant I *intended* instead of the one I had shipped, and that is the
   > failure mode a research doc most needs to warn its next reader about.

## 3. Release does not need new delivery machinery

The envelope inside a parked block is exactly what `recognizeFormattedPeerMessage`
(`src/shared/peer-messages.ts`) already recognizes for the #56 compact peer row,
and it returns the structural `PeerOrigin`. So:

- the parser owns only the OUTER framing and delegates the envelope — one
  definition of the envelope, not two that must agree;
- release passes that recovered origin to `sdkDeliverConfirmed`
  (`src/main/sdk-delivery.ts`), so the released turn renders as a #56 compact row
  with no renderer change at all;
- `sdkDeliverConfirmed` returns `'none' | 'started' | 'dropped' | 'timeout'` and
  **only `'started'` means the message really became the session's turn** — the
  honesty bar issue #57 established. Release removes the block ONLY on
  `'started'`; every other result leaves it parked, because losing a message is
  strictly worse than showing it twice.

An unrecognized envelope (hand-written block, future format) is delivered
**untagged** rather than with a fabricated origin — attributing a message to an
agent that never sent it would be worse than an uncollapsed row.

## 4. Scope: this is NOT issue #42

#42 is the Claude CLI's `crossSessionInbound: 'hold'` buffer. fix-wave-5 measured
it as **heap-only, 100-cap FIFO, ~5-minute expiry, no API handle and no dialog
event** — unreachable from Orchestra, so #42 is blocked upstream and stays open as
an honest record (`docs/research/cross-session-inbound.md`).

#64 reuses only the *UX* the user chose there (variant A). The channel underneath
is Orchestra's own durable file. **Nothing in this change fixes #42**, and the
tray must never be presented as doing so.

## 5. Rig defects found while gating this (kept: they recur)

- **A mutant that never applied.** My first mutation pass used `sed` with a
  pattern that silently did not match; the run went green against *unmutated*
  code and read as "the guard holds". Fixed by asserting the mutant string is
  LIVE in the file (read back after write) before running — that assertion is
  what caught it.
- **A vacuous guard of my own.** The "a delimiter-like run inside a body must not
  split the block" test used `====` (4 chars) while the real delimiter is 40, so
  the fixture could not reach the clause it claimed to protect: the test PASSED
  with the regex's `^…$` anchors deleted. Repaired to use a real 40-char run
  mid-line, plus a control asserting the same run on its OWN line *does* split —
  so the fixture is proven discriminating rather than merely unmatched.
- **A grep that could not see the subject.** Checking the feature was compiled
  into the built AppImage, `grep -r` over `resources/` returned 0 for every
  pattern — including a negative control, which is what exposed it: the payload
  is a binary `app.asar`. Re-run with `grep -a` plus pre-existing positive
  controls (`av-composer-field`, `av-queue-row`) in the same command.

- **A guard whose *consequence* I never traced (the worst of these).** My own
  test asserted the 40-`=` own-line split as *deliberate* — I fixed the regex's
  anchor clause, watched a mutant fail, and stopped. What I never asked was what
  happens when a human ACTS on the rows that split produces. Because removal
  re-serializes the file from the parse, refusing a phantom row rewrote the file
  around a mis-parse and destroyed a neighbouring real message — the exact
  failure direction this feature's design section claims to exclude. A passing
  mutation test on clause A is no evidence at all about consequence B; the
  question "what does the rest of the system do with this output?" is the one a
  local guard cannot answer. Found by an adversarial reviewer, not by me.
- **A void verdict from a shell variable.** Re-running the mutation matrix I put
  the test command in a shell variable and invoked it as `$T`; both arms printed
  `RC=127` (command not found) having executed nothing. Two "results" that were
  neither pass nor fail. Only reading the RC caught it — a habit worth keeping
  precisely because the output *looked* like a completed run.

## 6. E2E evidence (built app, own headless sway)

Driven against `release/linux-arm64-unpacked/orchestra` (the packaged build, CDP
target URL asserted to point at this worktree, version read back = `0.5.260` =
the version built). Compositor identity proven by the magenta marker:
`wayland-6` measured **100.00%** `(255,0,255)` while four sibling `HEADLESS-1`
candidates measured **0.00%** — name and emptiness are not identity.

Seeded a real inbox file for the workspace and asserted its bytes were identical
to canonical `queueInbox` framing before driving (so the fixture is a real inbox
file, not an approximation).

| Assertion | Result |
|---|---|
| chip renders with correct N | `✉2 messages held`, N matches the 2 blocks on disk |
| chip is amber | `rgb(255, 200, 87)` = `--av-warn` |
| chip/rows fully inside the viewport | chip `l=360 r=490`, rows `371..1565` of `vw=1596` |
| expanded list: one row per block | 2 rows, each with sender + preview + both actions |
| reply-footer absent from previews | clean |
| **Refuse discards** | block gone from file, **614 → 302 bytes**; row count 2 → 1; header became `1 message held`; logged `inbox-tray: REFUSED … discarded by the human, not delivered` |
| **Release with NO live session** | reports `not-delivered`, file **unchanged** — the block stays parked (logged `block left parked`) |
| **Release with a LIVE session** | `{ok:true, remaining:0}`, file **301 → 0 bytes**, chip retracted |
| released turn renders as a #56 PEER row | `› Message from ops-fix-wave-6`, collapsed — not a user bubble (a human turn in the same shot IS a bubble) |
| released body actually reached the transcript | expanded the row: `RELEASE-PROOF-64` present |
| chip re-appears from the fs watcher | re-seeding the file surfaced the chip with **no reload** |

Screenshots: `01-booted`, `02-chip-collapsed`, `03-expanded-list`,
`04-after-refuse`, `06-released-peer-row`, `07-peer-row-expanded`.

Two honest notes on that evidence:

- The test instance's account could not authenticate (isolated `ORCHESTRA_HOME`
  has no login), so the released turn ends in an `OAuth session expired` error
  row. This does **not** weaken the delivery claim: `sdkDeliverConfirmed`
  returned `'started'`, which is by definition "the message became the session's
  turn". The model's failure is strictly downstream of delivery.
- The delivered text keeps the full envelope **including** the
  `Reply with: orchestra message …` footer. That is deliberate and matches the
  pre-existing hook, which `cat`s the whole file into context. The footer is
  stripped only from the tray PREVIEW (unit-tested).

**The hook race was observed live, not just reasoned about**: mid-drive a real
structured session started in the worktree and its `inbox-instruction.sh` hook
drained the seeded file out from under the tray. The content-addressed design
absorbed it (no crash, no wrong-message delivery) — which is the scenario
invariant (a) exists for.

## 7. Delimiter injection (R1) — the one that could invert a message

Found by adversarial review, reproduced here before fixing. `parseInboxBlocks`
splits on `^={40,}$`, and `dispatchMessageRequest` only trims + length-caps, so
nothing stopped a delimiter-shaped LINE inside a message body from reaching the
file. Measured consequences, with an honest-2-block positive control passing in
the same harness:

| Input | Rendered | Acting on it |
|---|---|---|
| msg1 body contains a 40-`=` rule; msg2 unrelated | **3 rows** (one with `from:""`) | refusing the orphan **destroyed `"All gates green."`** from msg1 |
| body `APPROVED: merge it` / 40-`=` / `NOT APPROVED: hold` | **2 rows** | **Release delivered `"APPROVED: merge it"` alone**, peer-tagged and attributed to the real sender |

The second is worse than data loss: the message arrives **inverted in meaning**,
with the qualifier demoted to a row the human can refuse.

Mechanism: `removeBlock` → `serializeInboxBlocks` re-frames the WHOLE file from
the parse rather than splicing, so any mis-parse is written back as the new
truth and compounds.

**Fixed at WRITE time** (`sanitizeInboxBody`, called from `queueInbox`), not in
the parser: after a delimiter line is on disk it is genuinely
indistinguishable from real framing, so the information needed to act correctly
is already gone. The transform is minimal — a leading space on a
`^={40,}$` line, so it still reads as a rule to human and agent but can no
longer frame — and the on-disk grammar the shell hook `cat`s is unchanged.

Reachability was low but adversary-independent: a markdown rule or setext
underline of 40+ chars is routine in agent-authored reports, which is this
channel's entire traffic. 39 `=` was always safe; ≥40 split.

### RESIDUAL (declared, not fixed): a PRE-EXISTING file keeps the hazard

The guard is at WRITE time, so it cannot retroactively repair a file that was
appended to before the fix shipped. Measured on a reproduction of such a file:

```
pre-existing (unsanitized) file -> 3 rows, senders ["impl-62", "", "ops"]
refusing the sender-less orphan  -> "All gates green." destroyed  (still true)
```

**This is a residual, not a fix.** Anyone reading "R1 fixed" should read it as
"no NEW park can carry the hazard", not "no inbox file can".

**Why no migration is shipped.** Enumerated every live inbox file on this
machine at the time of writing (6 files), counting delimiter lines and
sender-less blocks, with a synthetic hazardous file as a positive control that
correctly reported 1 orphan:

| file | delimiter lines | blocks | orphans |
|---|---|---|---|
| 6 live files | exactly 2 x blocks in every case | 1–7 | **0** |

So the hazard has **zero present instances**. A repair-on-read would mean
rewriting the user's actual parked mail — a destructive operation on the one
durable copy — to fix a condition that does not currently exist anywhere. The
cost/benefit is wrong, and the failure mode of a buggy migration (silently
mangling real messages) is exactly the failure class this ticket is about.

If a migration is ever wanted, the honest shape is: detect a sender-less block
whose predecessor parses cleanly, and REFUSE TO ACT on that file in the tray
(surface "this file looks mis-framed") rather than rewriting it. Declining to
act is safe; rewriting is not.

## 8. Accepted gap: CRLF drops peer attribution (R3)

If an inbox file's newlines become CRLF, block counting still works but
`PEER_HEADER` in `peer-messages.ts` is `\n`-anchored, so `from` resolves to `""`
for every block, the envelope leaks into the preview, and `originFor()` returns
`undefined` — the released turn is delivered **untagged**, losing the #56 compact
row. It fails SOFT (the message is still delivered, in full) and reachability is
genuinely low: `appendFile` writes `\n` literally on every platform, so this
needs an external editor to rewrite the file.

**Recorded as an accepted gap, deliberately not fixed here.** The honest fix is
to make the peer-header recognizer newline-agnostic, which touches the #56
backfill path shared with `agent-transcript.ts` — a wider blast radius than this
ticket's remit, and normalizing CRLF at the tray boundary instead would leave
the same bug live for the shell hook's own `cat`.

## 9. G6 RE-DRIVEN under the hardened rig (the evidence that counts)

The first E2E run happened under a rig that inherited `DISPLAY=:0` and whose
pre-flight assert was tautological, so its provenance was disowned rather than
carried. Re-driven end to end at tip `894dffe` via
`scripts/e2e-contained-rig.sh`, which enforces containment before the app
starts. Production files are byte-identical to the earlier tip (11/11 sha256
SAME, with a changed test file as the control that the comparison discriminates)
— but the point of the re-drive was the RIG, not the code.

Containment asserted from INSIDE the child, not just by the launcher:
```
DISPLAY absent in this process                 -> undefined
WAYLAND_DISPLAY == the rig-verified socket     -> wayland-7 (and != wayland-1)
HOME is isolated                               -> /tmp/e2e64c-*/home
marker #FFC0AC: wayland-2..6 = 0.00%, wayland-7 = 100.00%, 0.00% after reset
```

| Assertion | Result |
|---|---|
| artifact identity (CDP url + version) | my worktree build, `0.5.260` |
| seeded file canonically framed | writer-identical |
| chip counts N=2 (**no phantom row**) | `✉2 messages held` |
| R1: 2 rows, every one has a real sender | `["impl-62-cli-flush","ops2-fix-wave-6-recovery"]` |
| Refuse removes the addressed message | 492 -> 230 bytes |
| **R1: the NEIGHBOUR survives intact** | `MERGE BLOCKED…` still on disk |
| R1: file canonically framed, no orphan | senders `["ops2-fix-wave-6-recovery"]` |
| R2/watcher: concurrent append surfaces, nothing clobbered | `["ops2…","gamma"]` |

**14/14 PASS.** Screenshots under the rig dir's `shots/`. Teardown verified with
bracketed patterns and controls (positive `[c]laude`=26, negative=0); the
human's compositor held 3 windows, all theirs; the real `~/.orchestra/inbox/`
contained **zero** G6 payload.

## Not done / not verified

- **The hook still does not lock the file.** The tray's races are narrowed by
  re-reading before write, not closed. Closing them means teaching
  `INBOX_INSTRUCTION_SCRIPT` to `flock` (the spool hook already does this for
  `<wsid>.seq`, so there is a pattern to copy).
- **Refuse is logged to the app log only.** The spec's "the sender-side result
  should reflect it if the transport allows" is NOT implemented: by the time a
  message is parked, the sending CLI has long since returned `delivery:'inbox'`
  and there is no channel back to it. Recording that here so the gap is not
  mistaken for an oversight.
- Multi-window behaviour (two Orchestra windows on one inbox) is reasoned about
  via the content-addressed mutations, not measured.
