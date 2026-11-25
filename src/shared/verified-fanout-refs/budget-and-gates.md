# Ledger, budget and gate rhythm: the grounds

(Read before the first gate, and when a cap or a gate rule looks arbitrary (SKILL.md §0, §0b). Long form of what SKILL.md carries as one-line rules; the § numbers are SKILL.md's.)

## 0. Open the ledger before spawning

The bus (§0c) carries messages in total order; the **ledger** — one durable
artifact (tracking issue) — is the sole home of mutable state: spec
decisions, freeze definitions, merge candidates, verdicts, dispositions and
every destructive order (revert/reset/force-push). A message points at the
ledger; it never carries state the ledger doesn't. (ADR 0002 makes the bus
the source of truth and the ledger a projection of it; that projection is
not built — lcsmas/orchestra#260 open — so the hand-written ledger stays the
home of mutable state until it ships.)

- **Freeze contested spec axes before dispatching.** A mid-flight ruling moves
  every tip (measured: four rulings on one axis = one superseded
  implementation, tests rewritten twice, ~10 tip moves). When a ruling must
  change anyway: state it as **behaviour-in-words** (an agent can check code
  against a sentence; a version label drifts), version-stamp it, write it in
  the ledger. Rule on an axis only when you hold — or have verified in
  source — its evidence; otherwise route the question to the evidence-holder.

<!--sw earlyGate=on-->
- **A stack's order is the verbs' answer** (`fanout gate --ticket`, `fanout resume`, `deliver`):
  a dependent is gated on its upstream's candidate and re-gates when that moves (measured:
  eight rebases of a dependent, six changing only the parent sha); merge base follow-ups
  first when a drive would read differently on each side of the pair.
<!--/sw-->
<!--sw earlyGate=off-->
- **A stack's order is the verbs' answer** (`fanout resume`, `deliver`): a dependent is nominated and
  gated only after its upstream is merged (`earlyGate=off`); merge base follow-ups first when a drive
  would read differently on each side of the pair.
<!--/sw-->

- **Edit a ledger table row with `scripts/ledger-set`, never ad-hoc `str.replace`** (27 hand edits on one wave pasted Tickets rows into Seams and Roster): `ledger-set [--add-row] REPO ISSUE SECTION KEY ROW` — one row, refuses on absent/duplicate key, absent section, or a body changed since its read; tests `scripts/test_ledger_set.py`.

Churn, not preload, is where a fleet burns tokens and wall-clock (measured:
~10 tip moves × full re-gates, 500-word reports per round, ack loops). Caps,
carried in every brief:

<!--sw seatRecords=off-->
- **Every report, verdict and blocking question lands as a LEDGER COMMENT.**
  Issue comments are ordered and durable; the message channel is neither — so
  the message channel carries ONE thing: the ping "new comment on ledger". A
  crossing then costs a pull, not a re-litigation. **The FINAL report's ping is
  `orchestra send --type worker_done --cap "$(orchestra token)"`, never
  `status`**, in the SAME turn as the final act: the host counts a dispatched task
  finished ONLY on its `worker_done` (#160); a status-only close leaves it
  unreleased, so every idle child raises a liveness escalation and the vague is
  declared asleep.
- **Fixed report format, ≤15 lines:** `STATE: <tip via ls-remote>` · each gate
  as `command → exact counts/RC` side by side · findings · NOT VERIFIED.
  Reports carry only the **delta since the last report** — the ledger holds
  history, so restating prior rounds is duplication. The format is what makes a
  report worth more than its commit: the diff shows what landed, the report
  carries the reasoning, the retractions and the NOT VERIFIED list.
- **One ping per event** — checkpoint landed, gate verdict, blocking
  question. Silence otherwise, and a closed loop stays closed: "Closed 👍"
  ends an exchange; replying to it reopens it.
<!--/sw-->
- **Peer-to-peer for facts** (ledger as authority); the coordinator handles
  decisions only. A fact relayed through the coordinator pays twice and can
  arrive stale.

Gate rhythm:

- **Write the full gate checklist into the ledger before the first gate** —
  each axis discovered mid-run costs one full cycle. Its review line is the §4
  merge rule's verbatim sentence, copied whole.
<!--sw verifier=on seatRecords=off-->
- **The full suite and the build run on the verifier's seat, once per
  candidate — unless the target has PR CI** (`orchestra fanout gate` derives it;
  the verifier then waits for CI green on its head). An implementer's self-gate,
<!--/sw-->
<!--sw verifier=off seatRecords=off-->
- **The PR's CI is the build and the full suite; nobody re-runs it by hand**
  (`deliver` refuses no CI, a red CI and a check that ran nothing). An implementer's self-gate,
<!--/sw-->
<!--sw seatRecords=off-->
  in the first round AND every fix round, is the typecheck, the test files its
  diff touches and its own rig arms; a red run is reported with the failing
  test names. N full suites share one host (measured, ledger orchestra#423:
  load 17–20, timing failures in files no diff touched, six runs for one green;
  a vague that re-ran a 15-min suite locally per candidate and per fix round,
  beside a CI running the same one, lost ~130 min, `orchestra#495`/`#497`).
<!--/sw-->
<!--sw verifier=on seatRecords=on-->
- **The full suite and the build run on the verifier's seat, once per
  candidate — unless the target has PR CI** (`orchestra fanout gate` derives it;
  the verifier then waits for CI green on its head).
<!--/sw-->
<!--sw verifier=off seatRecords=on-->
- **The PR's CI is the build and the full suite; nobody re-runs it by hand**
  (`deliver` refuses no CI, a red CI and a check that ran nothing).
<!--/sw-->
<!--sw seatRecords=off-->
- **Self-gate BEFORE nominating — the implementer runs the adversarial
  checklist on their own candidate first.** Six of six first submissions
  across two waves arrived all-green with every green NON-LOAD-BEARING
  (review caught them; each cost a full rework cycle). Before nominating,
  the implementer answers in their nomination comment: for each headline
  claim, what observation would DIFFER on a broken build; did the unfixed
  arm actually FAIL through the same rig; does any test assert the thing the
  ticket promises (not four true things beside it). A nomination without
  these answers is not a nomination. **Then a fresh-context PRE-REVIEW:** the
  implementer runs ONE in-process reviewer subagent (Agent tool, not an
  `orchestra spawn`) on its diff + the ticket, told to flag only correctness
  and ticket-promise gaps; BLOCKING/MAJOR are fixed before nominating, the rest
  listed in the nomination. The §3b reviewer still runs — this moves defects
  ahead of the round (audit 2026-09-30: median 3 rounds × 40–60 min per track).
  And when a review exposes a coverage
  gap, do NOT add cases at the layer you already test — that yields more
  green and the same bugs. Ask whether your tests are STRUCTURALLY CAPABLE
  of reaching the defect's layer (wave-8 #90: the policy tests could not
  reach any of the three review findings by construction); if not, the fix
  is DRIVING the module, never more coverage.
<!--/sw-->
<!--sw verifier=on-->
- **Gate merge candidates, not pushes.** Implementers push checkpoints
  freely; the verifier gates when the coordinator names a candidate ref.
<!--/sw-->
<!--sw verifier=off-->
- **Review merge candidates, not pushes.** Implementers push checkpoints
  freely; the reviewer reads when the coordinator names a candidate ref.
<!--/sw-->
<!--sw seatRecords=off-->
  **Rebase onto current master BEFORE nominating** (measured: stale-based
  candidates cost gate-merged two-steps), and a nominated ref's NAME is
  frozen (a rename+delete hands everyone a dead pointer).
<!--/sw-->
- **Carry verdicts by TREE IDENTITY across clean rebases** (the rebased tip's
  tree object byte-equals the gated merged tree); the carry is VOID across
  any conflict resolution, squash-with-edits, or cherry-pick — and patch-id
  equality is UNAVAILABLE across a resolution (context lines change by
  construction): prove equivalence by per-file numstat identity + byte-equal
  added/removed line sets instead.
- **Scope re-gates to the delta.** Name the changed files; a docs/comment-only
  delta carries the previous verdict forward when the built artifact hashes
  byte-identical (measured: an E2E verdict carried across an 11-line comment
  amend by bundle md5).
<!--sw seatRecords=off-->
- **Mutation runs: FULL set at the first nomination and at the final merge
  gate; intermediate rounds mutate only the clauses the delta changed.** A
  sequential in-place harness costs 10–47 min per pass (audit 2026-09-30:
  18.7 h of agent wait across 4 waves); the final full pass is what catches a
  fix that silently de-covered an earlier arm.
<!--/sw-->
