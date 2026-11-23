# The verifier brief and adversarial review: the grounds

(Read when you write the verifier's or a reviewer's brief (SKILL.md §3, §3b). Long form of what SKILL.md carries as one-line rules; the § numbers are SKILL.md's.)

One more agent whose only job is verification. Its brief:

- `pnpm install` (or the repo's equivalent) once — this worktree is the
  fleet's only fully-installed environment.
- Per branch named by the coordinator: `git fetch origin <branch> && git
  checkout --detach FETCH_HEAD` (works while the branch is checked out
  elsewhere). **A detached HEAD never follows the ref** — after any rebase
  or new push, re-fetch and re-checkout; a gater sitting on its old detached
  commit gates an orphan and reports green about the wrong tree (stranded
  two gaters in one wave).
- Run the real gate: typecheck, test suite (not the full one when `orchestra
  fanout gate --branch <b> --into <target> --head <sha>` says `fullSuite: ci`: CI
  runs it, you wait for `ciGreenOnHead`), an actual build — and for any
  user-facing surface, drive the changed flow end-to-end; build+tests alone
  pass a broken UI.
- Run the FULL gate checklist from the ledger per candidate — one report per
  candidate, AS A LEDGER COMMENT in the §0b format, PASS/FAIL **with the exact
  failing output or observed behaviour**, plus an explicit NOT VERIFIED list;
  then ping. Failures route back to the implementer; the verifier's hands stay
  off the code (the role guard: scratch only).
- **Prove the rig before trusting it**: one mutation per gate class, seen to
  FAIL, mutant-string verified live — a rig nobody has watched fail returns
  greens that mean nothing.
- **Audit the rig before filing any defect** — re-check your own
  payload/fixture against the producer contract first (measured across three
  fleets: 12 of 12 apparent defects were rig-side, zero were code).
- **Build probes from the repo's fixture library if one exists** (real
  captures + validating builders — e.g. `scripts/fixtures/`), never
  hand-written payloads: a hand-built fixture encodes its author's
  assumptions and can only confirm them.
- The rig PINS AN ACCOUNT before any live drive, **derived from the invoking
  agent's own login** — seed `accounts:[{id,label,configDir:
  $CLAUDE_CONFIG_DIR ?? ~/.claude}]` + `ws.accountId`, never a hardcoded
  machine account: the rig then runs as whoever runs it. Grounds: the
  default login can be expired machine-wide, and that failure mode
  impersonates the feature under test (measured twice: keeper harness,
  wave-2 live gate).

Give the coordinator the same toolchain on day one (linter/formatter), or
merge-assembly artifacts reach the verifier and cost a round-trip.

**A second verifier seat as soon as a 2nd candidate waits behind a gate in
progress** (own worktree, own rig dirs — two gaters never share a tree). One
seat is a queue: wave C's single verifier ran 91–100 % busy for 2.5 h and a
candidate waited 2 h 47 from nomination to verdict; bloc2's 2nd seat cut
nomination→verdict from 79–265 min to 17–46 min.

Gates verify BEHAVIOUR; adversarial review attacks the CODE (correctness,
design, security) — different job, opposite staffing. The verifier's
accumulated rig capital is exactly why it should NOT review: a party trading
one method with the fleet all day converges on the fleet's priors and misses
the same things with it. Review lives on freshness.

When the coordinator records a merge candidate, spawn ONE short-lived
reviewer per candidate — **nested under the coordinator like every fleet
member, never `--detached`**: a detached reviewer is sidebar noise for the
human and, worse, orphaned from the close-out sweep (nobody deletes what
the roster does not own). Ephemeral ≠ detached. It: it reads the diff, the ledger spec, and
`references/traps.md`, tries to BREAK the change (invent the input that
produces the wrong output), reports findings as a ledger comment with a
per-finding measured/argued label, and dies. **It reports only BLOCKING,
MAJOR, and MINOR that touch correctness or a ticket promise — never NITs**
(a reviewer asked for gaps always finds some; cosmetics cost a disposition
each and change nothing).

**Severity scale (the §4 merge rule keys on it):**
- **BLOCKING** — must not merge as is (red CI/build, data loss, security hole).
  **A red CI is the candidate's only if the same check is green on the base
  head** — run it there first; red on the base too ⇒ not a finding on the
  candidate, route it to the base's owner (bloc2 2026-10-04: a time-of-day
  bug in develop cost a 42-min fix round on an innocent PR).
- **MAJOR** — wrong behaviour on a real input, or a ticket promise not kept.
- **MINOR** — a real defect with limited reach (rare input, unlikely race, a
  test that lets a mutant survive).
- **NIT** — cosmetic (comment, doc, naming) — not reported by the spawned reviewer.

**A MINOR that breaks a sentence of the ticket (#552, `minorPolicy: spec`).** A finding may carry
`specSentence` — text quoted from the ticket's spec — and `kind: process` when the sentence is about how
the work is REPORTED ("write the list in the pull request"). Record it with
`state set <ticket> --finding-json '{"<id>":{"severity":"MINOR","specSentence":"<verbatim>"}}'` (add `"evidence":"measured","report":{"input":…,"happens":…,"where":…,"proof":…}` when you measured it: a measured code MINOR is refused without its report)
(the spec text is captured by `state set --spec <file>`, or `--spec-text <file|->` for a URL / ledger spec).
Code accepts the sentence only if it is a literal substring of that captured text (no trim, no
case-fold; empty refused). An accepted, unsettled MINOR blocks `gate` + `deliver` (`finding-unsettled`)
until `state set <ticket> --settle <id>=fixed:<head>` (code) / `--settle <id>=pr-body:<what the PR body
says now>` (process) or the coordinator records `--decide <id>=<text>`; it may be named in `--fixes`
(a process finding never: its fix is the PR-body edit). **Limit: code checks the sentence is IN the spec,
not that it is really broken — judging that stays with the reviewer.** A MINOR with no sentence stays `noted`.

**No spawned reviewer when the candidate's diff touches no production code**
(tests, comments, docs, rigs only): the implementer's pre-review + the
verifier's delta gate suffice. Any production-code line in the diff → spawned
review, follow-ups included.

The coordinator NEVER reviews (it wrote the specs — a stake; and
coordinator+verifier reading the same artifact is one review counted twice).
What it does with the findings is the §4 merge rule.

**Done when:** the reviewer's comment is on the ledger — findings or an
explicit "none found, here is what I attacked" (an empty report must name its
attack surface, or it is indistinguishable from a shallow pass).
