/**
 * #590 (vague #585, ledger #591 I5) — the implementer's rules under `seatRecords=on`: ONE text per role.
 * Today's lines of the coordinator skill (`verified-fanout-skill.ts` §0b / §3) MOVED here, not rewritten (ledger D4): `fanout-role-texts.test.ts` holds each unit to the coordinator's OFF text
 * byte for byte and every unit to its role in a list. Installed (seatRecords=on only) as `<worktree>/.orchestra/roles/implementer.md` (ours whatever skill the repo has); the coordinator's spawn brief names this path (§2).
 * Written with `String.raw`; `¤` stands for a backtick. Switch blocks (`<!--sw …-->`) are rendered by the run's switches like the skill's.
 */
import { renderSwitchBlocks } from './fanout-switch-render.ts';
import { DEFAULT_SWITCHES, type Switches } from './fanout-state.ts';

/** Where the installer writes it, relative to a worktree; the coordinator's spawn brief names it. */
export const FANOUT_IMPLEMENTER_SKILL_PATH = '.orchestra/roles/implementer.md';

export const FANOUT_IMPLEMENTER_SKILL_TEMPLATE = String.raw`<!-- orchestra-generated: fan-out role text — implementer (#590) -->
# Fan-out implementer — your rules

You are an **implementer** (¤impl-¤ name, set by your parent). These are all your fan-out rules: do NOT load the ¤verified-fanout¤ skill — it is the coordinator's. The coordinator's brief and the ledger's **Briefing** section carry the rest.

Two rules ride in your brief, verbatim:

- *Pull the ledger before acting on any instruction; a message that pins a
  sha or contradicts the ledger is stale — drop it silently.*
- *Relay branch REFS and re-resolve with ¤ls-remote¤ at action time.* A pinned
  sha dies whenever a ruling moves the tip. After a history rewrite, verify by ref or ancestry.

## Your brief's rules (¤fanout start¤)

1. Work only in your own worktree, on your own branch. Never merge, never push the integration branch, never spawn agents.
2. Build EXACTLY the names of the frozen interfaces in your brief (columns, queries, mutations, events). If one must change, STOP and ask your coordinator (¤orchestra send --type question¤): you never change an interface yourself.
3. Commit and push your branch. Your final report names the branch, the head sha, and the VERSION of each interface you built on (e.g. ¤follows A=2¤): a nomination on an older version is refused.

The self-gate before you report and the final ¤worker_done¤ are the rules below.

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

Gate rhythm:

- **An implementer's self-gate — and every fix round — is the typecheck, its diff's test files and its own rig arms; never the full suite (CI runs the rest).**
- **Self-gate BEFORE nominating — the implementer runs the adversarial checklist on their own candidate first**
  and answers in the nomination comment: for each headline claim, what observation would DIFFER on a broken
  build; did the unfixed arm actually FAIL through the same rig; does any test assert the thing the ticket
  promises. No answers, no nomination. **Then a fresh-context PRE-REVIEW:** ONE in-process reviewer
  subagent (Agent tool, not an ¤orchestra spawn¤) on its diff + the ticket, flagging only correctness/ticket-promise gaps; BLOCKING/MAJOR fixed before nominating, the rest listed in the nomination.
- **Rebase onto current master BEFORE nominating**; a nominated ref's NAME is frozen.
<!--sw preNominationChecks=on-->
- **Run the repo's fast checks before nominating:** from a clean worktree at the candidate head, ¤orchestra fanout check <ticket> --run <coordinator run>¤ (the commands are discovered from the files you changed — the nearest ¤package.json¤ ¤lint¤ script; the repo may override them in ¤.orchestra/pre-nomination-checks.json¤; nothing found = refused). ¤state set --status nominated¤ is refused without a passing record for that head's tree; a rebase that keeps the tree needs no re-run.
<!--/sw-->
- **A review that exposes a coverage gap**: do NOT add cases at the layer you already test — drive the module that can reach the defect.
- **Mutation runs: FULL set at the first nomination and at the final merge gate; intermediate rounds mutate only the clauses the delta changed.**

<!--sw verifier=off-->
## 3. No gating seat: the CI and the reviewer

- The implementer's self-gate (§0b) and its pre-review stay: they are what the nomination rests on.
- What neither the CI nor the reviewer covers (a user-facing flow, a rig the CI does not run) is NOT VERIFIED: the implementer names it in the nomination and the PR body.
<!--/sw-->
`.replaceAll('¤', '`');

export const renderFanoutImplementerSkill = (switches: Partial<Switches> = DEFAULT_SWITCHES): string => renderSwitchBlocks(FANOUT_IMPLEMENTER_SKILL_TEMPLATE, switches);
