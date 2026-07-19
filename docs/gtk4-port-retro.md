# GTK4 port — what could have been done better

Working notes for the end-of-swarm retrospective. Recorded as things happen so
the honest items survive; reconstructing this at the end would sand off the
specifics. **This is the "what went wrong" document** — successes are covered
by the plan and the audit.

## Coordinator mistakes (mine)

1. **Called a milestone done without checking the output was merged.** I
   released the M3 auditor and declared M3 complete while its entire 581-line
   deliverable sat on an unmerged branch. Found only because the user asked an
   unrelated question about that workspace. Root cause: I gated every *code*
   merge through a verifier but let a *docs* deliverable through ungated,
   because nothing downstream fails when a doc is missing. Silent failure modes
   need the check most, not least — and that is the same lesson the audit
   itself surfaced about permissive mocks, which I had not applied to my own
   process.

2. **Left a swarm agent's name stale for the whole port.** The verifier was
   spawned in M1 to check two workstreams (`verify-a1a2`) and kept that name
   while verifying all six M2 workstreams, every merged tip, and the M3 fix
   wave. Reusing the agent was right — it accumulated the harnesses, traps and
   invariants that made its verdicts trustworthy. Not renaming it was not. The
   user caught it. Same shape as (1): the work was right, the pointer to it
   wasn't.

3. **Spawned the M3 auditor detached, orphaning it from the coordinator tree.**
   Applied a standing "parentless spawns" preference mechanically, when for a
   swarm the user is watching, an orphaned agent is harder to follow. Attaching
   it later required promoting this workspace to an orchestrator — a visible
   reclassification I should have chosen deliberately at spawn time.

4. **Dispatched a fix on an unverified premise.** I told B4 "migrate failures
   are silent"; `fire_and_forget` actually surfaces errors and the handler
   throws. B4 had already started building against it. Caught only because the
   auditor re-checked its own earlier briefing. I applied "verify before
   relaying" to every agent's claims and not to my own.

5. **Pre-framed a result before it existed.** I asked B6 to report "the
   observed re-attach time", assuming recovery worked and only latency was in
   question. It did not recover. The framing invited a number that would have
   been fiction; B6 pushed back with UNVERIFIED instead.

6. **Wrote a lesson that collapsed three defects into one.** My
   "measurement not aligned to the event" reads as a single problem whose
   obvious remedy — sample more often — fixes only one of the three shapes. B6
   decomposed it correctly; I corrected mine to match.

7. **Told an agent to defer a live hazard for scope discipline.** B6 overrode
   me and fixed a `pkill -f` pattern-kill sitting in a committed script, with
   28 sibling agents running. It was a two-line change. Scope discipline should
   not outrank "don't leave a loaded gun in the repo".

## Process gaps

8. **The parity ledger was wrong twice** (`§5.6` persistence keys, the Run-tab
   rule) and six agents coded against it. Auditing the *spec* against the
   source of truth was not in the audit's original scope; the auditor widened
   it correctly on its own. Should have been scoped that way from the start.

9. **A user-facing flow was split across two branches with no composed gate**
   until B2 noticed. Both halves passed their own E2E by driving programmatically
   past the other's gap — two green reports, broken user path. Cross-branch
   feature composition needs an explicit owner and gate, not an emergent catch.

10. **The mock was permissive enough to hide live-only bugs** for the whole of
    M2. Three contract bugs (`getWorkspaceAccounts` shape, `listBranches` key
    type, the self-tune envelopes) were untestable by construction. The
    mock-strictness rule arrived in M3; it should have been a M1 convention.

11. **Verification tooling was unevenly distributed.** I could not run
    `clippy`/`rustfmt` as coordinator until late in M2, so a merge-assembly fmt
    artifact reached a verifier gate. Extracting the toolchain took one command
    once I bothered.

12. **The stale-binary trap fired twice and nearly shipped two false verdicts.**
    Once in an A/B across commits where only one arm was rebuilt ("the B4 fix
    broke pane activation"), once driving an E2E against a binary rebuilt for
    `cargo test` but not before the drive ("the deps:status P0 doesn't fire",
    reproducible 3/3 in isolation). Both were caught by accident — the second
    only because adding instrumentation forced a rebuild. `cargo test` does not
    refresh `target/debug/<bin>`, so **rebuild before any drive that execs the
    binary**, and treat "reproduces in isolation" as *zero* evidence of a real
    defect when the artifact's provenance is unchecked: reproducibility is what
    a stale artifact does best. This should have been a standing pre-drive step
    from M1, not a lesson learned twice.

13. **A stale comment licensed a race.** `orchestra-rpc/tests/client.rs:444`
    said "this test is the only one touching these vars" — true when written,
    false the moment a new test touched them, and it made the resulting ~11%
    flake look sanctioned. Comments asserting exclusivity or invariants rot
    silently and are worse than no comment, because they suppress the check.
    (Same pattern as the `listBranches` comment documenting the *sibling*
    method's contract.) Fix the comment with the code, every time.

## Agent self-assessment (B6, volunteered)

Recorded because an agent's own account of where it wasted effort is worth more
than the coordinator's guess, and because two of these trace back to me.

14. **Half the M3 effort went into the instrument, not the product** — stale
    wayland sockets, leaked processes, a process-group kill that silently killed
    the runner, a fake backend that hung once the app *attached* rather than
    probed. All real bugs, all discovered reactively one failed run at a time. A
    ten-minute harness audit before trusting its first negative would have found
    most of them together.

15. **Tested inside a framing instead of against the code.** The audit said "P2,
    one-line fix, ~3 min latency", so the first window was 60s — inside a 180s
    backoff — then widened reactively to 120s and 220s. Reading `BackoffPolicy`
    takes one grep. *This one is substantially mine*: I relayed the audit's
    framing as the brief without questioning it, and later compounded it by
    asking for "the observed re-attach time" as though recovery were established.

16. **Fixed an instance and called it a class.** The env-leak flake was the same
    defect already hit and fixed on the orchestra-gtk side earlier in the wave;
    nobody asked "where else does this shape exist" until the verifier found it
    in `orchestra-rpc`. The class audit took two minutes when finally run.

17. **The first fix for that regression made it worse** — setting an env var in
    a threaded suite broke two more tests. Right instinct (smallest change),
    wrong not to ask whether the mechanism being used carried the same hazard as
    the bug being fixed.

B6's own through-line: *reactive where a cheap upfront read would have been
decisive — audit the instrument, read the policy, grep the class.* That
generalizes past this agent and past this port.

## The through-line

Every false verdict this swarm nearly shipped came from **evidence that looked
more convincing than a real failure would have**: a vacuous assertion that
could not fail, an A/B with one arm stale, a negative from an unaudited
instrument, a timing-misaligned sample, a green half-E2E that drove past the
other half's gap, and a stale binary reproducing perfectly in isolation. None
of these fail loudly. They fabricate plausible, actionable, wrong answers — and
a plausible answer gets acted on where a loud failure gets investigated. The
single highest-value habit across the whole port was asking, before believing
any result: *what would have to be true for this evidence to be misleading?*

## To carry into the next swarm

- Name agents for their **role**, not their first task; rename when scope grows.
- At every milestone boundary: does each agent's name still fit, and is each
  agent's output actually **merged**? Run `git log <integration>..<branch>` per
  agent rather than trusting "done" reports.
- Scope the auditor to check the **spec** as well as the code.
- Decide the parent/tree shape at spawn time, deliberately.
- Give the coordinator the same gates the verifier has, on day one.
- Establish mock-strictness (validate keys, match wire shapes) as a convention
  before any frontend code is written, not after it has hidden three bugs.
