# Acceptance tests: written blind, frozen, copied unchanged

(Read when you write the test writer's brief, freeze its tests, or amend them (SKILL.md §1b). The commands carry the rules: `orchestra help fanout` is the truth, this file only says WHEN to call what.)

## Why a separate writer

An implementer who writes its own tests proves the code it wrote. The writer reads ONLY the spec and the ticket, so its tests encode the promise, not the implementation. The model pin is on the spawn line (`--model claude-opus-5-5`, the repo's wire-id pattern; the role stays `impl-`, `roleSpec()` is untouched).

## The sequence

1. **At dispatch**, with the implementers: spawn the writer, `orchestra spawn --name impl-tests-<ticket> --model claude-opus-5-5 --task "<brief>"`. Its brief: the spec path, the ticket, the repo-relative path the tests go under, the ONE command that runs them (`--run-cmd`: a direct runner call naming a frozen file, no shell), the tests self-contained (no helper outside the frozen files), "never read an implementer's branch", the common contract (ledger Briefing). It commits the tests to its own branch and reports the ref.
2. **Freeze** (you, once the writer's ref exists): `orchestra fanout acceptance freeze <ticket> --files <p1,p2> --run-cmd "<cmd>" --from <writer-ref>`. It records each path's sha256 and the command in the state file; a second freeze is refused (use amend). Read it back with `orchestra fanout acceptance show <ticket>` (open to every role).
3. **Implementers copy** the frozen files UNCHANGED into their branch (`git checkout <writer-ref> -- <paths>`) and make them pass. The tests are RED before the code, so they land WITH each candidate, never alone.
4. **Gate**: the verifier runs `orchestra fanout gate --branch <b> --into <target> --head <sha> --ticket <id> --cwd <checkout>`. The checkout must be at `--head`; every frozen path is hashed, then the stored command is run there. Refusals: `frozen-test-changed`, `frozen-test-failed`, `acceptance-unproven` (no `--cwd`), `acceptance-stale-checkout`. A ticket without acceptance tests gates exactly as before.
5. **Deliver**: save the gate's `acceptance.receipt` to a file; `orchestra fanout deliver … --acceptance <receipt.json>` checks it against the PR head and the state hash and re-reads every frozen path from GitHub at that head. A forged receipt does not survive the byte re-read.

## What the freeze does not cover

The runner allowlist and the residue are in `orchestra help fanout` (read `fanout acceptance`): a runner config file or a non-frozen helper the tests import is still the candidate's and is NOT hashed. Review any change to such a file in the candidate's diff, and brief the writer to keep the tests self-contained.

## What a refusal means

- `frozen-test-changed` / `frozen-test-failed`: the implementer's code is wrong, or it touched a frozen file. Route it back; never "fix" the test in the candidate.
- `acceptance-unproven` / `acceptance-stale-checkout` (gate) and `acceptance-stale` (deliver: a receipt for another head or frozen set, e.g. after an amend): the verifier ran nothing, the wrong checkout or an old set: re-gate.

## Amend: yours alone, with a decision

A test that contradicts the spec is amended, never worked around: write the decision in the ledger (the spec sentence the test now follows), then `orchestra fanout acceptance amend <ticket> --decision <ledger comment url> --spec-sentence "<text>" --files <p1,p2> [--from <ref>] [--run-cmd "<cmd>"]`: one decision authorises ONE amendment; `--run-cmd` replaces the stored command and must name a frozen file. The amend reads the decision through `gh` and fails closed when the sentence is not in it. Freeze and amend are coordinator-only (a guarded verb); every implementer then re-copies from the new ref.

## Routing rule

A gap found in an upstream is fixed by a follow-up ON the upstream, never by changing the dependent's spec interface (the interface the dependent was specified and tested against; its acceptance tests encode it, and a test amended to fit an upstream's bug freezes the bug). A follow-up that must change that frozen interface is a ledger decision first, then an amend: the upstream never moves it alone.
