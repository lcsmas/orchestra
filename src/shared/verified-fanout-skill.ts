/**
 * The bundled `verified-fanout` v2 skill (#470, verified-fanout v2 ledger #471): the v1 method with the rules that moved to code
 * (#465 roles, #466 handoff, #467 deliver, #468 role guard, #469 state/resume) stated ONCE, as one line each: the rule + its verb/guard + what to do on a refusal (#472; v1's prose of an enforced rule is gone).
 * Installed into every worktree as `.claude/skills/verified-fanout/SKILL.md` by `installOrchestraHooks` (src/main/workspaces.ts).
 * Pure text; `verified-fanout-skill.test.ts` holds every `orchestra <verb>` it names to the CLI's own help.
 * #474: the ALWAYS-READ text stays under 4,000 words (budget test); situational sections live in `references/*.md` (sources
 * `src/shared/verified-fanout-refs/`, embedded by `scripts/gen-verified-fanout-files.mjs`), each reached by a "read when …" pointer here.
 *
 * Written with `String.raw`; `¤` stands for a backtick (the text is full of them). v1 is FROZEN (tag `verified-fanout-v1-prose`);
 * `docs/evidence/470-v1-vs-v2.diff` is the full-context `diff -u` of v1 against this text.
 */
export const VERIFIED_FANOUT_SKILL_NAME = 'verified-fanout';

/** Substring of the generated-file marker line in the text: the installer overwrites a SKILL.md only if it carries it (a repo's own skill never does). */
export const VERIFIED_FANOUT_MARKER = 'orchestra-generated: bundled verified-fanout v2';

export const VERIFIED_FANOUT_SKILL = String.raw`---
name: verified-fanout
description: Mechanics of running a verified fan-out — N implementation agents in isolated worktrees plus one verifier that gates every branch on a real build before merge. Use once the decision to fan out is made, for MORE THAN ONE code subtask, and when re-spawning or growing a fan-out already running — even if verification is never mentioned. Deciding WHETHER to fan out → delegate-or-do first. One self-contained task → orchestra-spawn.
---
<!-- orchestra-generated: bundled verified-fanout v2 (#470) — Orchestra rewrites this file; never edit it in place -->

# Verified fan-out

> **Decide before you spawn.** This skill is the *mechanics* of fanning out;
> ¤delegate-or-do¤ decides *whether* to. A fan-out briefed on guesses turns one
> spec bug into N implementation bugs.

Three roles. N **implementers** work in fresh worktrees — which have no
¤node_modules¤, so they cannot prove their own work builds. One **verifier**
owns the fleet's only fully-installed environment; nothing merges until it
reports green. You are the **coordinator**: you split, brief, relay, and
enforce the gate — implementation belongs to the fleet.

> **v2.** A rule code enforces is ONE line: rule, verb or guard, what to do on a refusal.
> Situational detail lives in ¤references/¤, each pointer saying WHEN.

## Roles are typed — the name is the role (v2)

The role is the ¤--name¤ prefix the spawner gave (§1): ¤ops-¤ coordinator,
¤impl-¤ implementer, ¤verif-¤ verifier, ¤review-¤ reviewer, ¤explo-¤ explorer,
¤scribe-¤ mechanical steps. The one table is ¤roleSpec()¤ in
¤src/shared/fleet-roles.ts¤ — read it, never trust a summary of it.

- **Model and effort per role** — ¤roleSpec()¤; strong roles pin nothing (the Settings
  default applies), ¤scribe-¤ pins the cheap model at low effort; ¤--model¤ / ¤--effort¤
  on ¤orchestra spawn¤ win; ¤<ORCHESTRA_HOME>/fleet-roles.json¤ overrides (¤orchestra help spawn¤;
  an unknown key or role is refused). A ¤scribe-¤ gets only judgement-free steps; gating, review and design stay strong.
- **A scribe only for steps that need turns BETWEEN them (poll, retry, read-then-act) with NO judgement** — e.g. waiting on a
  rig or on CI beyond what ¤fanout deliver¤ absorbs. A batch one Bash call can run (for / &&) or a single call you run yourself:
  spawn + ¤worker_done¤ + delete cost more turns than they save. #476: the OPS holds 35% of cache-read, scribe-able turns are a
  ~6.4% ceiling, ≥49% is the static prefix: keep this file small, ¤orchestra handoff¤ late, §0a. Shape: ¤orchestra spawn --name
  scribe-<object> --task "<body text or absolute path, run id, fixed commands, ledger #N>"¤; it ends with ¤worker_done --cap¤, then
  you delete it. A scribe's ¤state set¤ never carries ¤--accept-merged¤, ¤--json¤ or ¤mergedAccepted¤ (guard-denied).
- **Tool limits — the PreToolUse role guard** (exit 2, ¤[orchestra] BLOCKED (role: …): <reason>¤)
  denies ¤AskUserQuestion¤ to every role, even as a probe; Edit/Write to the coordinator,
  reviewer, explorer and scribe (the verifier edits scratch only, an implementer its own
  worktree); push to the verifier, reviewer, explorer and scribe, and commit, merge,
  rebase and reset outside a scratch clone; a push of master/main to an implementer;
  ¤gh pr merge¤ and workspace delete/archive to every role but the coordinator. It keys on
  ¤.orchestra/role¤ (no file ⇒ inert: the LEAD, human sessions and role-less agents are never
  guarded). ¤orchestra fanout deliver|open¤ and ¤fanout state init|set¤ to every role but the
  coordinator (¤state show¤ and ¤resume¤ stay open); a ¤scribe-¤ may ¤state set¤. A BLOCKED is the answer, never to be routed around: report the branch ref to the
  coordinator (ledger comment + one ping), or hand the change to the role that may make it.


## 0a. Two tiers when a human sits on the orchestrator: LEAD and OPS

Run ¤orchestra whoami¤ first (role and run). A **mission** is the run of a top-level agent (the **LEAD**: no parent, talks to the human); a **vague** is
the run of an **OPS** (has a parent, spawned its own: one batch of tickets). Roles follow position.

- **A vague is never coordinated by a LEAD directly (operator ruling, 2026-09-21, ADR 0012):**
  a multi-ticket vague goes through an OPS (¤orchestra spawn¤ one with the vague as its task),
  or inline/plain-spawn. An OPS fans out directly under itself — no third level. ONE
  self-contained task → plain ¤orchestra spawn¤.
- **LEAD**: quiet, freezes specs with the human before the wave, gets only MILESTONE digests, answers by
  PULLING the ledger; **its report to the human is a TEAM LEAD'S SYNTHESIS**: ~5 lines, links not shas, done / next / needs their call (format: the reference below). **OPS**: opens the ledger, absorbs ALL fleet pings, merges on the §4 rule, runs the
  close-out, keeps the ledger's NEXT current. **Ops→lead digests are ≤5 headline lines**; the body is a ledger comment.
- **A decision you cannot make yourself**: take the REVERSIBLE default, apply it and write it in your ledger
  comment (¤AskUserQuestion¤ is denied, see Roles). Only a spec-axis change, an irreversible act or anything
  outside the repo is a ledger **§Open-questions entry** + ONE-LINE ping (¤orchestra ask¤ UP one level);
  ask ONCE, **poll §Decisions** before any re-ask, never address the human; meanwhile WORK ON WHAT DOESN'T DEPEND ON IT.
- **Ops dies mid-wave** → respawn ops pointed at the ledger number, its first act ¤orchestra fanout resume¤
  (exit 0 = the state file matches git + gh; 2 = divergences reported, never auto-corrected: settle each with
  the implementer or the ledger; ¤--accept-merged <reason>¤ on ¤state set¤ overrides).
- **No incoming message = no next turn, EVER.** An OPS whose §NEXT waits on something that will NOT arrive as a
  bus row (a background rig, CI) arms a ScheduleWakeup before ending its turn — never for fleet traffic.
  **Every spawned agent's final report goes out in the SAME turn as the final act.**
- **A long-lived member re-reads its whole context every turn** → ¤orchestra handoff --summary-file <path>¤
  (STATE, NEXT STEPS, REFS, NOT VERIFIED, each non-empty), then END YOUR TURN: the host starts a fresh
  session in the SAME workspace, worktree, branch and run. Refused, nothing ended: ¤handoff-summary-invalid¤
  (fix the section), ¤handoff-outside-run¤ (not in an open run), ¤handoff-unvouched¤ (run it yourself).
  Hand off a heavy member (verifier, coordinator). The host nudges the coordinator at 30 turns;
  its summary holds state-file path + ledger refs, open decisions, NEXT.
- **WALL-CLOCK IS A GOAL:** pipeline, never batch — gate/review each candidate the moment it exists; remove DEAD TIME, never thin verification.

→ **Read ¤references/lead-ops-tiers.md¤ when you are the LEAD or the OPS** (the LEAD's report format, dead-ops detection, closing a wave).

## 0. Open the ledger before spawning

The **ledger** — one durable tracking issue — is the sole home of mutable state: spec decisions, freeze
definitions, candidates, verdicts, dispositions and every destructive order (revert/reset/force-push). A message points at the ledger and never carries state it doesn't.

Two rules ride in every brief, verbatim:

- *Pull the ledger before acting on any instruction; a message that pins a
  sha or contradicts the ledger is stale — drop it silently.*
- *Relay branch REFS and re-resolve with ¤ls-remote¤ at action time.* A pinned
  sha dies whenever a ruling moves the tip. After a history rewrite, verify by ref or ancestry.

Coordinator-side rules:

- **Freeze contested spec axes before dispatching** (a mid-flight ruling moves every tip); when one must change, state it as **behaviour-in-words**, version-stamp it, write it in the ledger. Rule on an axis only when you hold
  its evidence; else route it to the evidence-holder.
- **Sent ≠ received.** Act on a counterparty's final state only after their
  explicit echo; their stale status line tells you your answer never arrived.
- **State-only acks** from message one; evaluative glosses carry zero state.
- **Execution state lives in the state file, decisions in the ledger.**
  ¤orchestra fanout state init --target <branch>¤ once (own run), then
  ¤orchestra fanout state set <ticket> --status … --branch … --pr … --head …¤ as each fact
  lands and ¤orchestra fanout state show¤ to read: one writer (you); an unknown field is
  refused — fix the spelling, never hand-edit the file. The ledger keeps spec decisions,
  reports and every destructive order, never a ticket's status/branch/PR/head.
- **Edit a ledger table row with ¤scripts/ledger-set¤, never ad-hoc ¤str.replace¤**: ¤ledger-set [--add-row] REPO ISSUE SECTION KEY ROW¤ (refuses on absent/duplicate key or a body changed since its read).
- **The ledger carries the ¤ledger¤ label** (open ledgers = live fleets; ¤fleet-status¤ lists by it); its header names ONE writer per section (LEAD: Decisions, OPS: the rest) and the escalation criteria.

## 0b. Budget: messages and gates

Churn burns a fleet's tokens and wall-clock. Caps, carried in every brief:

- **Every report, verdict and blocking question lands as a LEDGER COMMENT**; the message channel
  carries ONE thing: the ping "new comment on ledger". **The FINAL report's ping is
  ¤orchestra send --type worker_done --cap "$(orchestra token)"¤, never ¤status¤**, in the SAME turn as the
  final act: the host counts a dispatched task finished ONLY on its ¤worker_done¤ (#160); a status-only close leaves it unreleased.
- **Fixed report format, ≤15 lines:** ¤STATE: <tip via ls-remote>¤ · each gate
  as ¤command → exact counts/RC¤ side by side · findings · NOT VERIFIED. Only the **delta since the last report**.
- **One ping per event** — checkpoint, gate verdict, blocking question.
- **Peer-to-peer for facts**; the coordinator decides.

Gate rhythm:

- **Write the full gate checklist into the ledger before the first gate** — each axis discovered
  mid-run costs one full cycle. Its review line is the §4 merge rule's verbatim sentence.
- **The full suite and the build run on the verifier's seat, once per candidate, unless the target has PR CI:**
  ¤orchestra fanout gate --branch <b> --into <target> --head <sha>¤ derives it (¤fullSuite: ci¤ ⇒ skip what CI runs, wait for
  ¤ciGreenOnHead¤ — the suite check is derived or pinned with ¤--require-check¤; a moved head's CI is never accepted).
- **An implementer's self-gate — and every fix round — is the typecheck, its diff's test files and its own rig arms; never the full suite (CI runs the rest).**
- **Self-gate BEFORE nominating — the implementer runs the adversarial checklist on their own candidate first**
  and answers in the nomination comment: for each headline claim, what observation would DIFFER on a broken
  build; did the unfixed arm actually FAIL through the same rig; does any test assert the thing the ticket
  promises. No answers, no nomination. **Then a fresh-context PRE-REVIEW:** ONE in-process reviewer
  subagent (Agent tool, not an ¤orchestra spawn¤) on its diff + the ticket, flagging only correctness/ticket-promise gaps; BLOCKING/MAJOR fixed before nominating, the rest listed in the nomination.
- **Gate merge candidates, not pushes.** The verifier gates when the coordinator names a candidate ref.
  **Rebase onto current master BEFORE nominating**; a nominated ref's NAME is frozen.
- **Carry verdicts by TREE IDENTITY across clean rebases** (the rebased tip's tree object byte-equals the
  gated merged tree); the carry is VOID across any conflict resolution, squash-with-edits, or cherry-pick.
- **Scope re-gates to the delta**; a docs/comment-only delta carries the verdict.
- **A review that exposes a coverage gap**: do NOT add cases at the layer you already test — drive the module that can reach the defect.
- **Mutation runs: FULL set at the first nomination and at the final merge gate; intermediate rounds mutate only the clauses the delta changed.**

→ **Read ¤references/budget-and-gates.md¤ before the first gate** (the grounds for each cap).

## 0c. The fleet bus (every live run is all-ON)

Every run is all-ON (six switches; mail cannot be switched off). Mail: ¤orchestra send --type <kind> [--to <handle>] [--thread <id>] <body>¤ (a long body:
¤--body-file <path>¤; an unknown ¤--option¤ is refused, never sent as text); pull with ¤orchestra check¤, confirm with
¤orchestra ack <lot-id>¤ (only the reader acks) or ¤orchestra check --ack-previous¤. ¤orchestra message¤ is refused for every target (except ¤--emergency <id> <text>¤); agents with no common ancestry may
send each other ¤status¤ and ¤ask¤ only. **Only a real task assignment is ¤--type dispatch¤: it mints a
capability and SUPERSEDES the recipient's previous one** — orders, pings and FYIs are ¤status¤; the one final
report of a dispatched task is ¤worker_done --cap¤ (§0b). A worker sends gate failures, decision asks and ONE
final report, nothing per phase. On a ¤lot pending¤ wake, run EXACTLY the ¤orchestra check --run <id>¤ lines it names, then ack each lot. A coordinator waits for a verdict with ¤orchestra check --run <your run id>¤, never by counting ledger comments.

→ **Read ¤references/fleet-bus.md¤ when a message does not arrive, before ¤orchestra ask¤ / ¤gate¤ / ¤token¤, or on a ¤=OFF¤ notice line.**

## 1. Split and brief

Break the feature into 2–4 self-contained subtasks, disjoint files where possible. Each brief is standalone:
goal, files/areas, definition of done, ledger pointer. The COMMON CONTRACT (the two pull-first rules, the §0b report format and self-gate + pre-review, "reports are ledger comments + ping <your-ws-id>; the final one
pings with ¤worker_done --cap "$(orchestra token)"¤", "outward actions — merge, master push, release, PR — stay with the coordinator") lives ONCE in the ledger's **Briefing** section; every spawn prompt says "the contract is
the Briefing section of ledger #N — pull it first".

**A dependent track starts at dispatch and is gated on its upstream's candidate, not its merge.** Freeze the interface in the ledger; it builds against a stub. ¤orchestra fanout state set <ticket> --depends-on
<upstream> --frozen-interface <ref>¤ lets it go ¤--status started¤. Once the upstream has a verified candidate, rebase on its head, ¤--built-on <upstream>=<head>¤, nominate: ¤fanout gate --ticket <id>¤ / ¤resume¤ say wait or re-gate; ¤deliver¤ enforces order and content. An upstream changing the frozen interface posts one "what changed" line to its dependents.

**The spawner names the child at spawn** — ¤orchestra spawn --name <rôle>-<object>-<ticket>¤
(required; the ¤orchestra-spawn¤ skill and Orchestra ¤CONTEXT.md¤ **Nom d'espace**) — the prefix IS the
role. The child never renames itself — you rename it when its scope grows (¤orchestra rename <ws-id> <name>¤);
say in every brief "your name is set by your parent". A fleet nests under the coordinator; ¤--detached¤ is for one-offs.

**Done when:** every brief names your literal workspace id and its file set, shared files marked as seams (§4).

## 2. Spawn the implementers

One ¤orchestra spawn --name <rôle>-<object>-<ticket> --task "<brief>"¤ per subtask (flags: ¤orchestra-spawn¤
skill); record each printed workspace id + branch in the ledger.

## 3. Spawn the verifier

One agent whose only job is verification. Its brief:

- ¤pnpm install¤ (or the repo's equivalent) once — this worktree is the fleet's only fully-installed environment.
- Per branch named by the coordinator: ¤git fetch origin <branch> && git checkout --detach FETCH_HEAD¤.
  **A detached HEAD never follows the ref** — after any rebase or new push, re-fetch and re-checkout, or you gate an orphan.
- Run the real gate: typecheck, tests (§0b), an actual build — and for a user-facing surface, drive the changed flow end-to-end.
- Run the FULL gate checklist from the ledger per candidate — one report per candidate, AS A LEDGER COMMENT
  in the §0b format, PASS/FAIL **with the exact failing output or observed behaviour**, plus an explicit NOT
  VERIFIED list; then ping. Failures route back to the implementer; the verifier's hands stay off the code (the role guard: scratch only).
- **Prove the rig before trusting it**: one mutation per gate class, seen to FAIL.
- **Audit the rig before filing any defect**; probes come from the repo's fixture library, never hand-written payloads.

**A second verifier seat when a 2nd candidate waits behind a gate** (own worktree and rig dirs).

→ **Read ¤references/verifier-and-review.md¤ when you write the verifier's or a reviewer's brief** (rig audit, fixtures, the account pin).

## 3b. Adversarial review: one fresh spawn per merge candidate

Gates verify BEHAVIOUR; review attacks the CODE, with a fresh party. When the coordinator records a merge candidate, spawn ONE short-lived reviewer —
**nested under the coordinator, never ¤--detached¤** (a detached reviewer is orphaned from the close-out sweep).
It reads the diff, the ledger spec and ¤references/traps.md¤, tries to BREAK the change, reports findings as a
ledger comment with a per-finding measured/argued label, and dies. **It reports only BLOCKING, MAJOR, and MINOR
that touch correctness or a ticket promise — never NITs.**

**Severity scale** (BLOCKING / MAJOR / MINOR / NIT — the §4 merge rule keys on it; a red CI is the candidate's only if the same check is green on the base head): ¤references/verifier-and-review.md¤, read when you grade a finding.

**No spawned reviewer when the candidate's diff touches no production code** (tests, comments, docs, rigs
only): the implementer's pre-review + the verifier's delta gate suffice. Any production-code line → spawned
review, follow-ups included. The coordinator NEVER reviews (it wrote the specs); the findings go through the §4 merge rule.

## 4. Coordinate and gate

- Implementer reports done → send the verifier the branch **ref**; FAIL → relay its exact output to the implementer.
- **At nomination, parallel with the gate: ¤orchestra fanout open --branch <b> --into <target> --ticket <id>¤** (idempotent, never merges): CI runs while the verifier gates; ¤deliver¤ reuses the PR, a later push ⇒ ¤head-moved¤.
- PASS → apply the **merge rule** below, through ¤orchestra fanout deliver¤ (one PR per
  ticket: it opens or reuses ¤<branch> → <target>¤ and merges it). Record the outcome with
  ¤orchestra fanout state set <ticket> --pr <n> --head <sha> --status merged¤ and the PR url
  beside the implementer's workspace id in the ledger roster.

**The merge rule — apply it the moment a review comment lands, before any order to the implementer** (it rides verbatim in the ledger's gate checklist):

*A review round with 0 BLOCKING and 0 MAJOR merges on its current gate; a
MINOR that touches correctness or a ticket promise goes to the candidate's ONE
follow-up branch, every other finding is ¤noted¤.*

The count, the head and the CI are code: write the round's counts to a verdict file
¤{"round":1,"blocking":0,"major":0,"minor":2,"head":"<40-hex>"}¤ and run
¤orchestra fanout deliver --branch <b> --into <target> --ticket <id> --review-verdict <file>
--verified-head <sha>¤ — one call checks and merges with ¤gh pr merge --match-head-commit¤.
ALWAYS pass ¤--review-verdict¤: without it ¤deliver¤ refuses (¤no-verdict¤); ¤--no-review-gate¤
is the explicit ungated merge (¤reviewGated:false¤), never your default. A refusal (exit 2, JSON ¤reason¤: ¤no-verdict¤, ¤review-blocking¤, ¤head-moved¤,
¤ci-red¤, ¤no-checks¤, ¤zero-steps¤, ¤merge-conflict¤…) is the answer: a MAJOR/BLOCKING or a
conflict goes to the implementer, a moved head or ¤verdict-head-mismatch¤ back to the verifier
for a re-gate, ¤wrong-base¤ / ¤pr-closed¤ to the ledger, red CI to its owner, ¤no-checks¤ or
¤zero-steps¤ to whoever owns the CI (external CI: ¤--require-check¤). Exit 1 (¤timeout¤,
¤gh-failed¤, ¤merge-failed¤, ¤bad-verdict¤, ¤no-verified-head¤) is "could not check", not a
refusal: inspect and retry. Never merge around either with ¤gh¤. A MINOR never refuses: its disposition stays yours.

- **BLOCKING/MAJOR → ONE fix round**: the implementer fixes and re-nominates once, the verifier gates the delta
  (§0b); correctness MINORs may ride in it; upgrading a MINOR to MAJOR takes naming the ticket promise it breaks.
- **At most ONE follow-up branch per candidate**; only a BLOCKING/MAJOR in its own diff reopens it.

MERGE-ELIGIBLE = a DISPOSITION in the ledger for EVERY review finding: ¤fixed¤ (re-gated), ¤refuted¤ (with the
measurement), ¤accepted-gap¤ (rides in the PR body's NOT VERIFIED), ¤follow-up¤ or ¤noted¤ (MINOR/NIT only).

**Serialize merges that touch a shared seam.** Same-file branches merge one at a time in dependency order,
each remaining agent rebasing onto the new tip. Re-verify each **merged tip**, not just each branch:
¤deliver¤ prints ¤combinedSuite¤, the command to run on the target after N merges.

**Composed features need a composed gate.** When one flow spans two branches each half's E2E can pass while the user path is broken: gate the *whole flow* on the merged tree.

## 5. Close-out sweep

"Agent reported done" and "work **landed**" are two different events. At every milestone boundary and
before releasing any agent, run for **every** agent branch:

¤¤¤bash
git log <integration-branch>..<agent-branch>     # must print nothing
git -C <agent-worktree> status --porcelain       # must print nothing
¤¤¤

The first catches stranded commits (run it against the **tip**, resolved fresh: ¤merge-base --is-ancestor
<named-sha>¤ passes while later commits sit stranded); the second, work that never became a commit.

**Deleting a workspace requires the agent to be FINISHED, not merely landed.** Delete only an agent that
has ACKed release (or is provably stopped), and RE-TAKE the range+porcelain sweep in the same sitting as the delete. Check and act are TWO
calls, never one: the role guard denies a check (¤verify-landed¤, ¤gh pr checks¤,
¤rev-list¤…) chained with a destructive act (delete, force-push, merge, ¤branch -D¤,
¤worktree remove¤) in ONE command — run the check, read it, THEN act in a second call (the LEAD, role-less, is unguarded: its discipline).

**Gate a delete on BOTH checks, not on ¤verify-landed¤ alone.** ¤orchestra verify-landed <ws> --into <integration>¤ (the default target is YOUR branch) exits ¤0¤ landed /
¤2¤ not-landed / ¤1¤ could-not-check — gate on ¤$? == 0¤ (an older installed build exits 0 on NOT LANDED: if unsure, gate on the textual verdict). Porcelain is never literally empty in Orchestra worktrees: filter the generated
noise (¤.claude/skills/orchestra-*¤, ¤.claude/skills/verified-fanout¤), judge every other line; rescue an orphan
by committing it to the agent's own branch and verify **by content**.

Then confirm each deliverable **file** exists on the integration branch, and re-derive merge status at close
rather than inheriting it from the agent's first report (¤orchestra fanout resume¤ re-derives it for every
ticket of the state file). When your check contradicts a specific claim, run a second check with a different reference before speaking.

**A wave is closed only when the LEAD has itself gated and deleted the OPS workspace and ¤orchestra peers¤ greps ZERO wave workspaces (plus one grep for a workspace that must still exist); then close the ledger.**

**Done when:** both commands print nothing, every deliverable file resolves on the integration tip, and each agent's name still describes what it does.

→ **Read ¤references/closeout-and-gates.md¤ before you delete a workspace whose ¤verify-landed¤ reads
not-landed, and before you write a gate** (delete-gate traps; falsifiable gates, visual claims).

## 6. Report

One consolidated status: per subtask branch, verdict, what remains, plus the fleet-level NOT VERIFIED list — each line actionable by a reader of none of the conversation.

## Specify gates that can fail

A verdict is worth the precision of the ask: name the property, the observation that would disprove it,
and where to look — "verify this branch" yields "looks good"; every gate must print something different on a broken build.

## Deep references — pull on demand

These files ship WITH this skill (¤references/¤, ¤scripts/ledger-set¤); v1's four are byte-identical to v1.

- **references/lead-ops-tiers.md** — read when you are the LEAD or the OPS of a vague.
- **references/budget-and-gates.md** — read before the first gate (§0/§0b grounds, delta re-gates, coverage gaps).
- **references/fleet-bus.md** — read when a message does not arrive, or before ¤ask¤ / ¤gate¤ / ¤token¤.
- **references/verifier-and-review.md** — read when briefing the verifier or a reviewer (§3/§3b detail).
- **references/closeout-and-gates.md** — read before a delete the sweep doubts, and when writing a gate (§5 traps, §Specify gates).
- **references/traps.md** — the confident-wrong-answer catalogue: read the rung matching your evidence — *stale artifacts / off-target checks* (L23–117) when a gate is green off an artifact you did not build this run; *visual and capture rigs* (L118–394) when writing a gate that reads pixels; *controls, empty results, instruments* (L395–559) when a check passes first try or returns nothing; *multi-party evidence and close-out claims* (L560–723) when two agents agree or you write a close-out.
- **references/prose.md** — read before writing any durable artifact: banned filler, numbers over adjectives.
- **references/working-with-agents.md** — read before briefing a fleet and before writing or accepting any close-out.
- **references/meta-rules.md** — read when adding rules to this skill.

## Which copy is this? Install and precedence (v2)

- **This is the bundled v2**, rewritten into every worktree's ¤.claude/skills/verified-fanout/¤ on spawn; a repo's own copy without the generated marker line is never overwritten.
- **A personal-level copy shadows it** (measured on Claude Code 2.1.325 only; ¤scripts/skill-precedence/measure-skill-precedence.mjs¤, re-run after a CLI update).
- **VPS install:** an AppImage release containing this skill; no personal copy there ⇒ nothing shadows it.
`.replaceAll('¤', '`');
