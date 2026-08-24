# SDK payload fixtures — read this BEFORE hand-writing a payload

**If you are about to write an SDK payload literal in a probe, harness, verify
script or unit test: don't. Import it from here instead.**

## Why this exists

Across two fleet retrospectives, **10 of 10 apparent defects were rig-side.**
Not one was a bug in the app. Every one was a hand-built payload that encoded
the *author's* assumptions instead of what the runtime actually sends:

| The rig-side defect | What it cost |
|---|---|
| a category row missing `kind` | a full investigation cycle against working code |
| an invented `turn-error` event type | same |
| an `undefined` `at` stamp | same |
| `ws.model` passed as a context field instead of positionally | same |

A hand-built fixture is **a second encoding of your own assumptions** — it
confirms your hypothesis rather than the code's behaviour, and it is most
convincing exactly when the hypothesis is wrong. The failure mode is not a loud
error; it is a *plausible defect report* filed against somebody else's correct
code. Plausible reports get acted on.

So the fix here is structural, not advisory. Every builder in `index.mjs` runs
its output through **the same `src/shared` normalizer the app uses** and throws
a `FixtureError` when the result violates the producer contract. A malformed
fixture therefore fails **loudly, at build time, in your own harness** — not
silently, downstream, as a phantom defect.

## Usage

```js
import { liveContextUsage, contextCommandUsage, toolResultMetaTrio,
         backgroundTasksSequence } from './fixtures/index.mjs';

const usage   = liveContextUsage();          // validated ContextUsage, source:'live'
const cmd     = contextCommandUsage();       // validated, source:'context-command'
const denied  = toolResultMetaTrio().denied; // a validated SDK `user` message
const frames  = backgroundTasksSequence();   // 4 validated replace-semantics frames
```

Every builder takes an optional `overrides` object, so you can vary **one**
field while the rest stays real — and validation still runs, so an override
that breaks the contract fails here too:

```js
liveContextUsage({ totalTokens: 190_000 });        // fine: still a valid reading
liveContextUsage({ mcpTools: [{ name: 'x' }] });   // throws: no serverName
```

Need the **raw wire payload** (because the thing under test *is* an adapter)?
Use `rawLiveContextUsagePayload()` / `rawContextCommandPayload()`. For anything
else, prefer the normalized builders.

## What's in here, and where each capture came from

Every file under `payloads/` is a **real capture**. None was authored by hand.

| Payload | Provenance |
|---|---|
| `get-context-usage.live.json` | `Query.getContextUsage()`, CLI 2.1.234 / SDK 0.3.216 — `docs/research/sdk-runtime-payloads.md` §1 (commit `db9507d`). |
| `context-command.usage.json` | the snake_case `context_usage` field the CLI stamps on the synthetic `/context` assistant message — same doc, §2. |
| `tool-result-meta.trio.json` | the `denied` / `interrupted` / `cancelled` `tool_result_meta` sidecar, shipped by PR #46 (#26). |
| `background-tasks-changed.sequence.json` | 4-frame replace-semantics sequence; frame 1 is the organic capture from the same doc, §4. |

### The two context shapes are DIFFERENT — never conflate them

This is the trap that produced several of the rig-side defects:

|  | `getContextUsage()` | `/context` `context_usage` |
|---|---|---|
| casing | camelCase (`totalTokens`) | snake_case (`total_tokens`) |
| categories classified by | `isDeferred` boolean + `color` | a `kind` enum on the wire |
| `skills` | **nested object** — `{totalSkills, includedSkills, tokens, skillFrontmatter[]}` | **flat array** of rows |

Both normalize to the same `ContextUsage`, which is *why* they are both kept:
a fixture that only covers one shape cannot catch an adapter that broke the other.

### Runtime superset — the d.ts is not the contract

`tool_result_meta` has **0 occurrences in `sdk.d.ts` at SDK 0.3.241** and **3 in
the CLI 2.1.241 binary** (verified with `strings`, with a positive and a negative
control). `pluginName` on a skill row is the same story. **Verify shapes against
a live capture or the research doc, never against the type definitions** — the
runtime is a superset, and the fields the d.ts omits are often the load-bearing
ones.

## Running the gate

```
node scripts/fixtures/self-test.mjs     # or: pnpm run test:fixtures
```

Two arms, and the second is the one that matters:

- **Arm 1 (positive)** — every real capture builds and validates. Proves the
  library is usable and that the adapters still read today's captures.
- **Arm 2 (negative)** — 11 deliberately malformed fixtures must each be
  **rejected**. A validator nobody has watched fail is indistinguishable from
  one that *cannot* fail, so every validator here is watched failing on a
  mutation of a real capture.

The harness is itself falsifiable — measured: dropping `kind` from one real row
in `context-command.usage.json` flips it RC 0 → 1.

## Adding a fixture

1. **Capture it — do not write it.** Drive a live session (pinning an account)
   or lift it verbatim from `docs/research/sdk-runtime-payloads.md`.
2. Drop the JSON in `payloads/` and record its provenance in the table above
   *and* in the `index.mjs` header — CLI + SDK version included, since every
   absence verdict expires on CLI update.
3. Add a builder that **normalizes through `src/shared`** and asserts the
   contract. Ask: *what would a wrong-but-plausible version of this payload look
   like?* — then add that as an Arm 2 rejection case.
4. **Put the validator on a surface where it can actually fire.** Measured
   example: a `kind` check placed *after* normalization is vacuous, because both
   adapters coerce an unknown `kind` to `'used'`
   (`src/shared/context-usage.ts:267`). The check has to read the **raw** payload
   — that is what `validateRawCategoryKinds()` does and why it is separate.
