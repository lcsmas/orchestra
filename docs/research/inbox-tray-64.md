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
   the hook uses `cat` + `rm -f`, and the tray rewrites it. Every tray mutation
   is a read-modify-write that re-reads immediately before writing, so a stale
   snapshot cannot resurrect blocks the hook already handed to the agent. This is
   a narrowed race, not an eliminated one; a genuine fix would need the hook to
   take a lock (see "Not done" below).

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
