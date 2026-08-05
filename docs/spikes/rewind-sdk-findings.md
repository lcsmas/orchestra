# Rewind: verified SDK behavior

Spike notes for the structured-view "rewind a message" feature.
SDK `@anthropic-ai/claude-agent-sdk` **0.3.216** (vendored CLI 2.1.216; installed
CLI on this machine 2.1.220). All claims below were **observed in this repo's
node_modules / against the live binary** on 2026-08-05 — see NOT VERIFIED at the
bottom for what was not.

## The three primitives

| Primitive | Where | What it does |
|---|---|---|
| `options.enableFileCheckpointing: true` | `sdk.d.ts:1450-1457` | Opt-in. Makes the CLI snapshot tracked files per user message. Required by `rewindFiles`. |
| `query.rewindFiles(userMessageId, {dryRun})` | `sdk.d.ts:2452-2461` (PUBLIC) | Restores tracked files to their state at that **user** message. Returns `RewindFilesResult` (`sdk.d.ts:2664-2678`): `{canRewind, error?, filesChanged?, insertions?, deletions?, skippedLinks?}`. Control subtype `rewind_files`. |
| `options.resumeSessionAt: <uuid>` | `sdk.d.ts:1783-1788` | With `resume`, truncates the resumed conversation. |

`forkSession(sessionId, {upToMessageId})` also exists (`sdk.d.ts:667-688`) but is
NOT used here: it **discards file checkpoints** ("Forked sessions start without
undo history"), and `resumeSessionAt` achieves the same truncation
non-destructively (the original transcript stays on disk as a safety net).

## Fact 1 — the caller supplies the user message uuid (verified by experiment)

`SDKUserMessage.uuid` is **optional input** (`sdk.d.ts:4574`), not output-only.
`sdk.mjs`'s send path (`Query.streamInput`) writes the message through
`JSON.stringify` verbatim — **no uuid injection, mutation or defaulting**.

Live probe against the real binary:
- Sent `uuid:'aaaaaaaa-bbbb-4ccc-8ddd-eeeeeeeeeeee'` → the on-disk JSONL user
  line carried exactly that uuid.
- **Negative control**: omitting `uuid` → the CLI minted its own; the sentinel
  was absent from the file.

So Orchestra mints the uuid in `sdkSend` and knows the rewind target
*synchronously, before sending* — no JSONL read-back race.

There is **no stream path** to learn a CLI-assigned user uuid: the SDK never
echoes user messages back, and no output message carries a back-reference
(`SDKAssistantMessage` has `parent_tool_use_id`/`request_id`/`supersedes`, no
`parentUuid`). Reading it back off disk would be racy and requires resolving the
account's config dir. Hence: **mint it client-side.**

## Fact 2 — `rewindFiles` restores files (verified, with mutation control)

With `enableFileCheckpointing:true`, sending a self-minted uuid then calling
`rewindFiles(MY_UUID)`:

```
file after turn:   "MUTATED"
rewindFiles(...) => {"canRewind":true,"skippedLinks":0}
file after rewind: "ORIGINAL\n"
```

**Mutation control**: a bogus uuid throws `Error: No file checkpoint found for
this message.` — so the pass is discriminating, not vacuous.

## Fact 3 — `resumeSessionAt` truncation is INCLUSIVE of the target turn

This is the fact the API docs get wrong for our use: the `resumeSessionAt`
docstring says "The message ID should be from `SDKAssistantMessage.uuid`", but a
**user** uuid works fine and is what `rewindFiles` wants — so one id serves both.

Probe: a 3-turn session with caller-supplied uuids U1/U2/U3, whose replies were
the codewords ALPHA / BETA / GAMMA. Resuming with
`resume: <session>, resumeSessionAt: <uuid>` and asking the model to list every
codeword it has said:

| `resumeSessionAt` | recalled | reading |
|---|---|---|
| `U2` (user msg of turn 2) | `ALPHA, BETA` | keeps turns 1..2, drops turn 3 |
| `U1` (user msg of turn 1) | `ALPHA` | keeps turn 1, drops turns 2..3 |

**So `resumeSessionAt: <user uuid N>` keeps turns 1..N inclusive.**

### Consequence for the UI semantics

"Rewind to message N" in the edit-and-retry sense means *undo* message N — N
leaves the transcript and returns to the composer. So the session must be
truncated to keep only turns **1..N−1**:

- target `resumeSessionAt` = the uuid of the **PREVIOUS** user message (N−1);
- rewinding the FIRST user message ⇒ no `resume` at all (fresh session);
- but `rewindFiles` targets message **N** itself (restore files to how they were
  when N was submitted).

Two different ids in the same operation. Getting this off by one silently keeps
or drops an extra turn, so it is asserted in tests.

## Ordering constraint (enforced by the transport, not just by convention)

`rewindFiles` must be called on the **live query object, before** it is torn down
and restarted with `resumeSessionAt` — file checkpoints are session-scoped.
Sequence: `rewindFiles(N)` → stop session → restart with
`resume: sessionId, resumeSessionAt: uuid(N-1)`.

This is not advisory: `rewindFiles` is a **control request**, so it needs the
subprocess transport OPEN. Calling it after the session ends throws
`Error: ProcessTransport is not ready for writing` (hit while building the e2e
harness — `break`ing out of the `for await` loop closes the transport, and the
next `rewindFiles` failed immediately). `sdkRewind` therefore does files FIRST
and only then sets `session.cleared` + `sdkStop`.

## End-to-end proof of the whole contract

`docs/spikes/` harness run 2026-08-05, sequencing exactly as `sdkRewind` does,
against the real binary:

```
1. file after agent edit     : "MUTATED"
2. dryRun preview            : {"canRewind":true,"files":["/tmp/rwe2e/target.txt"],"ins":1,"del":1}
3. rewindFiles(U2)           : {"canRewind":true}
4. file after rewind         : "ORIGINAL"
5. recalled after truncation : "ALPHA … The only codeword I have said in this conversation: - ALPHA"

files restored : true      (MUTATED → ORIGINAL)
convo truncated: true      (ALPHA survives; the Write turn is gone from context)
RESULT: PASS
```

Turn 1 said ALPHA; turn 2 wrote the file. Rewinding turn 2 restored the file AND
removed that turn from the model's context — both halves, one operation.

## NOT VERIFIED

- Duplicate/malformed uuids: only well-formed unique v4s were sent. Whether the
  CLI validates format or rejects a repeat is unknown (Orchestra always mints a
  fresh `crypto.randomUUID()`, so no path resends one).
- Image/multi-block user turns: probes sent plain string content only, not the
  base64-image block array `sdkSend` builds.
- The probes ran standalone against the same binary, NOT through Orchestra's own
  `query()` (which adds `settingSources`, hooks, MCP servers, `canUseTool`).
- `skippedLinks` semantics (symlink/hard-link refusals) were never triggered.
- Behavior after a compact boundary, and whether checkpoints survive it.
