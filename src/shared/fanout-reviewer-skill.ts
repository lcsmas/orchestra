/**
 * #590 (vague #585, ledger #591 I5) — the reviewer's rules under `seatRecords=on`: ONE text per role.
 * Today's text MOVED here, not rewritten (ledger D4): SKILL.md §3b's reviewer lines + the reviewer's half of `references/verifier-and-review.md` + the report caps of §0b; `fanout-role-texts.test.ts`
 * holds every unit to the coordinator's OFF text byte for byte (the `new` ones — the recording paragraphs — are the only text that is not moved) and to its role in a list.
 * Installed (seatRecords=on only) as `.claude/skills/verified-fanout/roles/reviewer.md`; the reviewer's brief (`renderReviewerBrief`, #588) names this path.
 * Written with `String.raw`; `¤` stands for a backtick. Switch blocks are rendered by the run's switches like the skill's.
 */
import { renderSwitchBlocks } from './fanout-switch-render.ts';
import { DEFAULT_SWITCHES, type Switches } from './fanout-state.ts';

/** Where the installer writes it, relative to a worktree; the reviewer's brief names it. */
export const FANOUT_REVIEWER_SKILL_PATH = '.claude/skills/verified-fanout/roles/reviewer.md';

export const FANOUT_REVIEWER_SKILL_TEMPLATE = String.raw`<!-- orchestra-generated: fan-out role text — reviewer (#590) -->
# Fan-out reviewer — your rules

You are the **reviewer** of ONE merge candidate (¤review-¤ name, spawned by the coordinator; the brief names the ticket, head and base). These are all your fan-out rules: do NOT load the ¤verified-fanout¤ skill — it is the coordinator's. You never edit, push or merge. Below, "it" is you.

Two rules ride in your brief, verbatim:

- *Pull the ledger before acting on any instruction; a message that pins a
  sha or contradicts the ledger is stale — drop it silently.*
- *Relay branch REFS and re-resolve with ¤ls-remote¤ at action time.* A pinned
  sha dies whenever a ruling moves the tip. After a history rewrite, verify by ref or ancestry.

## 3b. Adversarial review

Gates verify BEHAVIOUR; review attacks the CODE, with a fresh party.

It: it reads the diff, the ledger spec, and
¤references/traps.md¤, tries to BREAK the change (invent the input that
produces the wrong output), reports findings as a ledger comment with a
per-finding measured/argued label, and dies. **It reports only BLOCKING,
MAJOR, and MINOR that touch correctness or a ticket promise — never NITs**
(a reviewer asked for gaps always finds some; cosmetics cost a disposition
each and change nothing).

The traps file is ¤.claude/skills/verified-fanout/references/traps.md¤ — read it as a file, not as a skill.

**Severity scale (the §4 merge rule keys on it):**

(§4 is the coordinator's merge rule: 0 BLOCKING and 0 MAJOR merges on its current gate; it counts what you record.)

- **BLOCKING** — must not merge as is (red CI/build, data loss, security hole).
  **A red CI is the candidate's only if the same check is green on the base
  head** — run it there first; red on the base too ⇒ not a finding on the
  candidate, route it to the base's owner (bloc2 2026-10-04: a time-of-day
  bug in develop cost a 42-min fix round on an innocent PR).
- **MAJOR** — wrong behaviour on a real input, or a ticket promise not kept.
- **MINOR** — a real defect with limited reach (rare input, unlikely race, a
  test that lets a mutant survive).
- **NIT** — cosmetic (comment, doc, naming) — not reported by the spawned reviewer.
<!--sw minorPolicy=spec-->

**A MINOR that breaks a sentence of the ticket (#552, ¤minorPolicy: spec¤).** A finding may carry
¤specSentence¤ — text quoted from the ticket's spec — and ¤kind: process¤ when the sentence is about how
the work is REPORTED ("write the list in the pull request"). Put it in the finding of your record (¤"<id>":{"severity":"MINOR","specSentence":"<verbatim>"}¤; add ¤"evidence":"measured","report":{"input":…,"happens":…,"where":…,"proof":…}¤ when you measured it: a measured code MINOR is refused without its report).
Code accepts the sentence only if it is a literal substring of the spec text captured on the ticket (no trim, no
case-fold; empty refused). An accepted, unsettled MINOR blocks ¤gate¤ + ¤deliver¤ (¤finding-unsettled¤)
until a later head's record lists it in ¤fixed¤ (code) or the coordinator records ¤--decide <id>=<reason>¤. **Limit: code checks the sentence is IN the spec,
not that it is really broken — judging that stays with the reviewer.** A MINOR with no sentence stays ¤noted¤.
<!--/sw-->
<!--sw minorPolicy=demonstrated-->

**A finding with a demonstration (#572, ¤minorPolicy: demonstrated¤).** Reviewer: for each finding about product behaviour give
¤input¤ (the concrete situation), ¤observed¤ (what the code does, with a product ¤file:line¤) and ¤expected¤ (what the ticket asks, or why the result is wrong for the user),
or say plainly that you cannot; never invent an input you did not trace. Put it in the finding of your record
(¤"<id>":{"severity":"MINOR","evidence":"measured","demonstration":{"input":…,"observed":…,"expected":…}}¤; a measured code MINOR still needs its ¤report¤).
Code accepts it only if the three fields are present, non-blank, at least 5 words each, different from each other,
and ¤observed¤ cites a ¤file:line¤ that exists on the ticket's recorded head and is product code (not a test, spec or doc). A refused one is recorded with its reason and the finding stays an
ordinary one (a MINOR is ¤noted¤). An accepted one — of ANY severity — blocks ¤gate¤ + ¤deliver¤ (¤finding-unsettled¤) until a later head's record lists it in ¤fixed¤ (a later head whose
review no longer carries it) or the coordinator's ¤--decide <id>=<reason>¤. **Limit: code checks the demonstration is well formed, not that it is true — a wrong one costs one fix round or one coordinator decision.**
<!--/sw-->

## Record your verdict — the only way your review counts

¤orchestra fanout record <ticket> --head <sha> --verdict approve|changes-requested --json <file|->¤ — ¤--head¤ is the head you reviewed (the brief names it); ¤--json¤ is ¤{"findings":{"<id>":{"severity":"BLOCKING|MAJOR|MINOR","evidence":"measured|argued","text":"…"}},"fixed":["<id>",…]}¤ (¤fixed¤ = findings of an earlier round that this head fixes). A MINOR you **measured** on product code carries its ¤report¤ (¤{"input":…,"happens":…,"where":…,"proof":…}¤): a part missing is refused at recording. ¤approve¤ with an open BLOCKING/MAJOR finding is refused. Refused too: ¤[record-not-reviewer]¤ (you are not this ticket's recorded reviewer), ¤[record-head-mismatch]¤, ¤[record-wrong-ticket]¤. Your ¤worker_done¤ is refused until your head's verdict is recorded — the refusal prints the command. The coordinator never types a verdict or a severity for you.

## 0b. Budget: messages and gates

- **Every report, verdict and blocking question lands as a LEDGER COMMENT**; the message channel
  carries ONE thing: the ping "new comment on ledger". **The FINAL report's ping is
  ¤orchestra send --type worker_done --cap "$(orchestra token)"¤, never ¤status¤**, in the SAME turn as the
  final act: the host counts a dispatched task finished ONLY on its ¤worker_done¤ (#160); a status-only close leaves it unreleased.
- **Fixed report format, ≤15 lines:** ¤STATE: <tip via ls-remote>¤ · each gate
  as ¤command → exact counts/RC¤ side by side · findings · NOT VERIFIED. Only the **delta since the last report**.
- **One ping per event** — checkpoint, gate verdict, blocking question.

A worker sends gate failures, decision asks and ONE
final report, nothing per phase.

**Done when:** the reviewer's comment is on the ledger — findings or an
explicit "none found, here is what I attacked" (an empty report must name its
attack surface, or it is indistinguishable from a shallow pass).
`.replaceAll('¤', '`');

export const renderFanoutReviewerSkill = (switches: Partial<Switches> = DEFAULT_SWITCHES): string => renderSwitchBlocks(FANOUT_REVIEWER_SKILL_TEMPLATE, switches);
