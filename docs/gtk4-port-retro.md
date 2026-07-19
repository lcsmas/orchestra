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
