# Close-out traps and gates that can fail

(Read before you delete a workspace whose `verify-landed` reads not-landed, and when you write a gate (SKILL.md §5, §Specify gates). Long form of what SKILL.md carries as one-line rules; the § numbers are SKILL.md's.)

The two close-out checks are `git log <integration-branch>..<agent-branch>` and `git -C <agent-worktree> status --porcelain`, each of which must print nothing. The first catches stranded commits (run it against the **tip**, resolved
fresh — `merge-base --is-ancestor <named-sha>` answers "did the commit I
named land", which passes while five later commits sit stranded). The second
catches work that never became a commit — an agent's last act routinely
leaves regenerated artifacts unstaged after its final commit (measured: 65
uncommitted lines on a branch reading 0 unmerged; 14 reference captures dead
with their worktree). Silent artifact types — docs, audits, harnesses — need
this most: nothing downstream fails when they are missing.

**Deleting a workspace is gated on BOTH checks, not on `verify-landed` alone.**
"LANDED" covers only commits; measured 2 of 7 LANDED workspaces carrying a
unique uncommitted deliverable that deletion would have silently destroyed.
Three traps: (0) **after a REBASE, `verify-landed` reads a FALSE not-landed** — the child's pre-rebase shas are dead by construction (wave B, 2026-09-14: every rebased candidate read NOT LANDED while its tip was master's HEAD); land by ANCESTRY of the current tip (`git merge-base --is-ancestor <tip> origin/master`) or by content, and a REVIEWER worktree parked on a superseded candidate sha is review-only (it authored nothing: porcelain 0, HEAD = a sha the ledger nominated) — delete it on that evidence, not on verify-landed. (1) `orchestra verify-landed` **now** exits `0` landed / `2` not-landed
/ `1` could-not-check (orchestra#59, fixed 2026-08-25) — so gate on `$? == 0`,
and **never treat a bare non-zero as "not landed"**: `2` is a verdict, `1` means
the check never ran (unknown id, no branch, different repos). Older *installed*
builds exit 0 on NOT LANDED, and the CLI is whatever binary is installed, not
your checkout — if you cannot confirm the installed build has the fix, gate on
the **textual verdict** instead; (2) in Orchestra worktrees
porcelain is never literally empty — filter the known generated noise
(untracked `.claude/skills/orchestra-*` and `.claude/skills/verified-fanout`, submodule pointer drift), then judge
every remaining line. Rescue an orphan by committing it to the agent's own
branch, or copy it out and verify **by content** (hash both sides), not by
"the file exists".

Then confirm each deliverable **file** exists on the integration branch, and
re-derive merge status at close rather than inheriting it from the agent's
first report — agents keep committing after they report, and the claim
expires silently (`orchestra fanout resume` re-derives it for every ticket of the
state file). When your check contradicts a specific claim, run a second
check with a different reference before speaking (a check aimed at the wrong
reference returns a clean, specific, wrong answer). The close-out *writing*
disciplines — auditable form, ratios, denominators — live in
`references/working-with-agents.md`.
Prose-level editing rules for every durable artifact (PR bodies, tickets,
ledger comments, docs) — banned filler, mandatory substitutions, numbers
over adjectives — live in `references/prose.md`.

## A measured MINOR is never lost (#553)

<!--sw seatRecords=off-->
Record a MINOR you **measured** on product code with its report: `state set <ticket> --json '{"findings":{"<id>":{"severity":"MINOR","evidence":"measured","report":{"input":…,"happens":…,"where":…,"proof":…}}}}'` — a part missing is refused at recording. At close, `orchestra fanout closeout` (read-only) prints one ready-to-file ticket text per such finding: paste the list into the closing report. An *argued* MINOR and a `kind: process` finding create nothing. A MINOR a merged follow-up fixed (`--fixes`) still gets its text until you settle it: `state set <ticket> --settle <id>=fixed:<ref>` once the follow-up has landed (only a recorded settle drops a text). Filing in a tracker is `--file`, off by default, never waited on — the OPS decides.
<!--/sw-->
<!--sw seatRecords=on-->
A MINOR the reviewer **measured** on product code is recorded with its report (`fanout record`, the reviewer's own file): a part missing is refused at recording. At close, `orchestra fanout closeout` (read-only) prints one ready-to-file ticket text per such finding: paste the list into the closing report. An *argued* MINOR and a `kind: process` finding create nothing. Filing in a tracker is `--file`, off by default, never waited on — the OPS decides.
<!--/sw-->

## Specify gates that can fail

A verdict is worth the precision of the ask: "verify this branch" yields
"looks good"; a falsifiable gate yields evidence. Name the property, the
observation that would disprove it, and where to look:

- *wrap-not-touch*: the new flow adds ZERO stream consumers — grep still
  shows exactly one `.events()` / `.pty_data()` consumer.
- *mutual exclusion both directions*: widget A present AND B absent for one
  case, exactly inverted for the other — a one-directional check passes when
  the wrong thing is merely replaced.
- *none-dark*: one mutation, N surfaces, every one re-rendered — a stolen
  stream fails as one surface going quiet, never as an error.

Route findings to the owning agent — routed findings get *fixed*, absorbed
ones get *noted*. Visual claims need the strictest gates ("looks right"
cannot fail): a before/after/reference triptych on the same seeded state,
state verified by the invariant parts of the frame, reference captured fresh
(committed yardsticks go stale), values diffed against the source rule, and
element names diffed *before* re-running drives — a rename during restyling
fails exactly like a behavioural regression.

**Done when:** every gate in the checklist names the observation that would
disprove it, and each one has an answer to "what would this print on a broken
build?" that differs from what it prints on a green one.
