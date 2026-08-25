# forkSession: verified SDK behavior

Spike notes for **"Resume from here"** (issue #18) — forking a conversation into
a NEW Orchestra workspace. Sibling of `rewind-sdk-findings.md`, which covers the
DESTRUCTIVE in-place rewind; read that one first if you are touching
`sdkRewind`.

All claims below were **observed against the live binary** on **2026-08-25**.

**Rig**: node v22.22.0, `@anthropic-ai/claude-agent-sdk` as vendored in this
repo's `node_modules`, `CLAUDE_CONFIG_DIR=/home/lmas/.claude-mc`, probe scripts
run from the repo worktree (so package resolution finds the SDK), captures under
`~/.cache/impl18-probe/`. See NOT VERIFIED at the bottom for what was not.

## The primitive

| Primitive | Where | What it does |
|---|---|---|
| `forkSession(sessionId, {dir?, upToMessageId?, title?})` | `sdk.d.ts:711-733` | Copies transcript messages into a NEW session file, remapping every uuid and preserving the parentUuid chain. Returns `{sessionId}`. |

Contrast with rewind's two primitives: forking touches **nothing** about the
source session — no teardown, no truncation, no file restore. The original
transcript stays on disk and the original session keeps running. That is exactly
why #18 uses it and `sdkRewind` does not.

## Fact 1 — `upToMessageId` is INCLUSIVE (boundary bracketed, not interpolated)

The doc comment says "inclusive", and the source agrees (`JW()` in `sdk.mjs`
slices `o.slice(0, f+1)` after `findIndex`). **A vendor sentence is a claim about
a program, not the program**, so it was measured.

Probe: a 3-turn session with caller-supplied user uuids whose replies were the
codewords ALPHA / BETA / GAMMA (the technique from `rewind-sdk-findings.md`).
Fork at each **assistant** uuid, resume the fork, and ask the model to list every
codeword it has said:

| `upToMessageId` | recalled | reading |
|---|---|---|
| assistant turn 1 | `ALPHA` | keeps turn 1 |
| assistant turn 2 | `ALPHA, BETA` | keeps turns 1..2 |
| assistant turn 3 | `ALPHA, BETA, GAMMA` | keeps turns 1..3 |

**Every sample point was driven — there is no unsampled gap between them**, and
the strictly increasing recall is itself the discriminating control (the
instrument responds to the variable rather than returning a constant).

**Negative control**: `forkSession(session, {upToMessageId: <uuid never sent>})`
**throws** `Message <uuid> not found in session <id>`. So a fork that resolves is
a fork that found its target.

## Fact 2 — forking at a USER message cuts MID-TURN (the trap #18 had to route around)

This is the consequence that drives `forkTargetId()` in
`src/shared/fork-session.ts`, and it is **not** what the natural reading of
"fork at the message's `rewindId`" suggests.

Because the cut is inclusive, forking at a **user** message copies that user
message **without its assistant reply**. Measured: forking at user message 2 of
the ALPHA/BETA/GAMMA session produced an 11-line transcript whose last entry is
user message 2, and the resumed fork recalled only `ALPHA` — BETA's reply is
absent because it was never copied.

Worse, the resumed fork then **answers the dangling user message as its first
act**: with fork-at-user-1, the model's reply to the probe question was `ALPHA`
not `NONE`, because it had literally just been told to say ALPHA and had not yet
answered. *(That reading cost one wrong measurement before the transcript dump
explained it — the codeword instrument is contaminated by a dangling unanswered
turn, which is why Fact 1 forks at ASSISTANT uuids.)*

So "resume from **here**" cuts at the **PREDECESSOR** user message.
`forkTargetId()` owns that rule and its off-by-one is pinned by tests in
`src/shared/fork-session.test.ts`.

### Correction (measured in the built app, 2026-08-25) — the fork NEVER ends on a complete exchange

An earlier draft of this doc and of `fork-session.ts` claimed the predecessor cut
makes the fork "end on a complete exchange". **That is wrong**, and the e2e drive
disproved it. Only USER messages carry an Orchestra-minted `rewindId` — assistant
uuids exist on disk but are never surfaced to the renderer (verified by dumping
every rendered `.av-message`: `HAS-FORK` appears on user rows only). So the cut
point is always a user message, and the fork always ends on one **without its
reply**.

Observed on the real drive — forking from the BETA bubble of an
ALPHA/BETA/GAMMA session produced a 3-line fork containing exactly:

```
user | Reply with exactly: ALPHA        ← and NOT its "ALPHA" reply
```

Forking from message N therefore yields turns 1..N−2 complete, plus user message
N−1 unanswered, which the resumed fork re-answers as its first act. That IS the
intended behaviour (branch off before the clicked message, re-attempt the prior
prompt); cutting at the target itself would be strictly worse, since the fork
would re-answer the very message the user is moving past and be
indistinguishable from the original. The finding stands; only the rationale
attached to it was wrong, and it is corrected here rather than left in place.

Note this is a DIFFERENT boundary rule from rewind's, for a different reason:

| | target | rule |
|---|---|---|
| `resumeSessionAt` (rewind) | keeps turns 1..N **including N's reply** | cut at N−1 to DROP turn N |
| `forkSession` (fork) | copies up to and including the targeted MESSAGE | cut at N−1 to branch off BEFORE turn N (ends on N−1's unanswered prompt) |

They coincide in the id they compute and differ in why — hence
`previousRewindId()` and `forkTargetId()` are deliberately kept as separate
functions rather than shared.

## Fact 3 — the fork lands in the SOURCE project dir, and that is FINE

`forkSession` writes the new `.jsonl` into the **source session's**
`projectDir` (`sdk.mjs` `ZW()` → `cf(xa(o.projectDir, ...))`), and the copied
entries keep the **source `cwd`** verbatim (`{...m, ...}` spread — `cwd` is not
rewritten).

That looked fatal for #18: a new workspace has a different worktree, hence a
different project dir, so a fork written into the SOURCE's dir should be
invisible to it. **It is not** — `--resume <uuid>` resolves by searching all
project directories, not by cwd.

Measured, through **Orchestra's own option set** (`settingSources:
['user','project','local']`, `bypassPermissions`,
`allowDangerouslySkipPermissions`, `enableFileCheckpointing`,
`includePartialMessages`, `agentProgressSummaries`) — this closes the gap
`rewind-sdk-findings.md` explicitly left open ("the probes ran standalone, NOT
through Orchestra's own `query()`"):

| arm | cwd | resume | result |
|---|---|---|---|
| A (positive control) | source dir | the fork | `ALPHA` — resumes |
| **B (the question)** | **a DIFFERENT dir** | **the fork** | **`ALPHA` — resumes** |
| C (negative control) | a different dir | a bogus uuid | `error_during_execution`, no `init` |
| D (positive control) | a different dir | the SOURCE session | `ALPHA, BETA, GAMMA` |

Arm C proves the probe **can fail**; arm D proves it **can see more** than arm B
reported, so B's truncated recall is a real property of the fork and not a
limitation of reading across directories.

## Fact 4 — file checkpoints ARE discarded (directly observed)

The doc says "Forked sessions start without undo history (file-history snapshots
are not copied)". Observed rather than assumed:

```
source session                    : 4  file-history-snapshot lines   (positive control: > 0)
fresh fork, never resumed         : 0  file-history-snapshot lines
  (that same fork file has 15 lines total, so the file is real, not empty)
```

The count must be taken on a **never-resumed** fork: resuming one writes a
snapshot of its own, which reads as a copied checkpoint if you measure after
driving it (the first pass here did exactly that and read `1`).

This is the caveat accepted and declared as Q1b on ledger #77. It is immaterial
for #18 because the forked workspace has its own git worktree as the safety net —
but it is stated in the UI affordance copy and here, never silently.

## Fact 5 — every uuid is REMAPPED, so `rewindId`s do not survive

Copied entries get fresh uuids plus a `forkedFrom: {sessionId, messageUuid}`
back-reference. Measured on three forks: **0** source user uuids survive
verbatim; 8 / 13 / 16 entries carry `forkedFrom`.

Consequence for Orchestra: the forked workspace's backfilled history carries **no
Orchestra-minted `rewindId`s**, so its historical bubbles render **without**
rewind or fork affordances until the user sends a new turn (which mints one).
This is the pre-existing behaviour for un-idd history — `RewindControl` renders
nothing without an id — so it degrades gracefully rather than breaking, but it is
a real v1 gap.

## What #18 builds on this

- `src/shared/fork-session.ts` — `forkTargetId()` (the Fact-2 off-by-one),
  `canForkFrom()` (hide the affordance where the fork would be empty; the SDK
  rejects an empty slice with `Session <id> has no messages to fork`), and
  `forkBranchName()`.
- `sdkFork()` in `src/main/agent-sdk.ts` — pins the account config dir (the SDK
  reads `process.env.CLAUDE_CONFIG_DIR`, see `withAccountConfigDir`), forks,
  creates the new workspace off the ORIGINAL branch's tip, and seeds
  `sdkSessionId` with the fork.
- `ForkControl.tsx` — the affordance, deliberately NOT disabled mid-turn.

## Mutation matrix for `src/shared/fork-session.test.ts`

Each mutant applied ONE at a time, verified live in the file (`grep -c` in the
same command) before running, and the file restored and `diff`-confirmed
identical afterwards:

| mutant | pass/fail | verdict |
|---|---|---|
| walk seeded at `idx` instead of `idx - 1` (the off-by-one) | 6 / 6 | killed |
| drop the `if (id)` guard in the walk | 7 / 5 | killed |
| drop the post-slice trailing-hyphen strip | 11 / 1 | killed |
| `SLUG_MAX` 32 → 64 | 10 / 2 | killed |
| fallback `'fork'` → `'fork-'` | 11 / 1 | killed |
| `canForkFrom` always `true` | 11 / 1 | killed |
| **remove `if (idx < 0) return undefined`** | **12 / 0** | **SURVIVED** |

The surviving mutant is **reported, not buried**: with `idx === -1` the walk
starts at `-2`, never executes, and falls through to the same `undefined`, so the
guard is behaviourally redundant and **no input can distinguish the two**. It is
kept as an explicit statement of the not-found case and labelled as
non-load-bearing at the site, rather than having a test written that would only
appear to pin it.

## NOT VERIFIED

- **Forking a session with a COMPACT boundary in it** — untested here, and also
  left open by `rewind-sdk-findings.md`. Unknown whether the fork's slice
  interacts correctly with a compact summary entry.
- **Forking a LIVE/running session.** Every probe forked a torn-down session.
  The UI can reach the affordance mid-turn (the control is deliberately not
  disabled), so the interaction between an in-flight turn appending to the source
  transcript and a concurrent fork read is **not measured**.
- **Image / multi-block user turns** — probes sent plain string content only, not
  the base64-image block array `sdkSend` builds.
- **A per-account config dir other than `~/.claude-mc`.** Only my own account was
  driven; the `withAccountConfigDir` pin is applied by construction (and is the
  same mechanism `listSessions` needs) but was not exercised across two accounts.
- **The `title` option's effect on any Orchestra surface.** It is passed and it
  lands as a `custom-title` entry in the fork file, but nothing in Orchestra reads
  a session's SDK title back, so its user-visible effect is untested.
- **`dir` scoping.** Never passed; every call relies on the all-projects search.
- Whether repeated forks of the SAME message collide in any way beyond the branch
  name (which `freeBranchName` dedupes).
