// #588 (I3) — the reviewer's brief, rendered by CODE from the run state: no free text from the coordinator (the coordinator's words reach it only as the run's decisions, `state set --run-decision`).
// Pure and deterministic: the same BriefInput renders the same text (no clock, no random); `briefHash` is its sha256. Rules text = REVIEWER_RULES (#590 later moves it to its own file).
import { SWITCH_NAMES, type Switches } from './fanout-state.ts';
import { briefHash } from './fanout-brief-common.ts'; // the pieces shared with the implementer's brief (#587 PR A): decisions / switches line / interfaces are rendered by `briefInputOf` through them

export { briefHash };

export type BriefKind = 'spawn' | 'wake' | 'replace';
export interface BriefFinding { id: string; severity: string; text: string | null; raisedOn: string | null }
/** What a dependent follows of an upstream's interface: `followed` null = it records none. */
export interface BriefFollow { id: string; current: number; followed: number | null }
export interface BriefInput {
  run: string;
  coordinator: string;
  ticket: string;
  kind: BriefKind;
  /** The ticket's spec text (captured), else its spec reference, else null. */
  ticketText: string | null;
  ticketRef: string | null;
  target: string;
  head: string;
  base: string | null;
  /** wake only: the head the reviewer last read (the delta is `prevHead..head`). */
  prevHead: string | null;
  branch: string | null;
  pr: number | null;
  /** `renderInterfaces(state, [own, …upstreams])`, `renderDecisions(state)`, `renderSwitchesLine(state)` of fanout-brief-common.ts (computed by `briefInputOf`). */
  interfacesText: string;
  decisionsText: string;
  switchesLine: string;
  /** The upstream interface versions this ticket follows vs the current ones (a STALE one is said). */
  follows: BriefFollow[];
  /** The switch values (the per-switch sentences key on them). */
  switches: Switches;
  /** The upstream heads this ticket was built on (`builtOn`) while they are not merged: the review reads what is above them. */
  builtOn: Array<{ id: string; sha: string }>;
  /** Findings still open on this ticket (wake / replace carry them). */
  openFindings: BriefFinding[];
  /** I5 — path of the reviewer's role file, when one exists. */
  reviewerSkillPath?: string | null;
}

/** The reviewer's rules — what it reports, how it grades, the merge rule it works under. A fixed constant: it never varies with the coordinator's words. */
export const REVIEWER_RULES = [
  'You are the reviewer of ONE merge candidate. You read; you do not edit, commit, push or merge.',
  'Read the diff of the head below against its base, the ticket text, the frozen interfaces and the run decisions; try to BREAK the change (invent the input that produces the wrong output).',
  'Report only BLOCKING, MAJOR, and MINOR that touches correctness or a ticket promise — never NITs. Label every finding measured (you ran it / traced it) or argued (reasoning only).',
  'Severity: BLOCKING = must not merge as is (red CI/build on a base that is green, data loss, security hole). MAJOR = wrong behaviour on a real input, or a ticket promise not kept. MINOR = a real defect with limited reach.',
  'A red check is the candidate\'s only if the same check is green on the base head: run it there first.',
].join('\n');

/** The merge rule the reviewer works under, per `minorPolicy` — the SAME wording as the verified-fanout skill's per-policy variants (verified-fanout-skill.ts, §4); rendered from the policy, never a constant. */
export const MERGE_RULES: Readonly<Record<Switches['minorPolicy'], string>> = {
  spec: 'Merge rule you work under: a review round with 0 BLOCKING, 0 MAJOR and no unsettled spec-sentence MINOR merges on its current gate; every other MINOR is `noted` — no follow-up PR.',
  refuse: 'Merge rule you work under: a review round with 0 BLOCKING and 0 MAJOR merges on its current gate; every MINOR is `noted` — no follow-up PR.',
  legacy: "Merge rule you work under: a review round with 0 BLOCKING and 0 MAJOR merges on its current gate; a MINOR that touches correctness or a ticket promise goes to the candidate's ONE follow-up branch, every other finding is `noted`.",
  demonstrated: 'Merge rule you work under: a review round with 0 BLOCKING, 0 MAJOR and no unsettled demonstrated finding merges on its current gate; a MINOR that touches correctness or a ticket promise goes to the ONE follow-up branch, every other finding is `noted`.',
};

/** One sentence per switch VALUE that changes what the reviewer must do. A switch in any other value adds nothing: no sentence of its own. Keyed `<name>=<value>`. */
export const SWITCH_SENTENCES: Readonly<Record<string, string>> = {
  'acceptance=on': 'Frozen acceptance tests: this run freezes the ticket\'s acceptance tests before the code; check the head still satisfies them and that none was weakened (an amend is a coordinator decision, listed below if any).',
  'minorPolicy=refuse': 'minorPolicy=refuse: a MINOR-only follow-up is refused — report a MINOR only when it breaks the ticket.',
  'minorPolicy=spec': 'minorPolicy=spec: a MINOR that breaks a sentence of the ticket carries `specSentence` — a LITERAL substring of the ticket text (no trim, no case-fold); a process sentence ("write the list in the PR") is `kind: process`.',
  'minorPolicy=demonstrated': 'minorPolicy=demonstrated: for every finding about product behaviour give `input` (the concrete situation), `observed` (what the code does, with a product `file:line`) and `expected` (what the ticket asks, or why the result is wrong for the user) — or say plainly that you cannot; never invent an input you did not trace.',
  'preNominationChecks=on': 'preNominationChecks=on: the candidate carries a passing `orchestra fanout check` record for its tree; do not repeat what it covers, attack what it cannot.',
};

export const switchSentencesOf = (sw: Switches): string[] =>
  SWITCH_NAMES.map((n) => SWITCH_SENTENCES[`${n}=${sw[n]}`]).filter((x): x is string => !!x);

const short = (s: string | null): string => (s ? s.slice(0, 12) : 'unknown');
const indent = (s: string): string => s.trimEnd().split('\n').map((l) => `  ${l}`).join('\n'); // the ticket text only; interfaces / decisions use the shared renderers

/** The brief. Sections in a fixed order; an absent optional part prints nothing (never "none" for a switch). */
export function renderReviewerBrief(i: BriefInput): string {
  const out: string[] = [];
  const kindLine = i.kind === 'spawn' ? 'You are a NEW reviewer for this ticket.'
    : i.kind === 'wake' ? `You are the SAME reviewer, woken because the ticket has a new head: read the delta ${short(i.prevHead)}..${short(i.head)} first, then re-check your open findings below.`
    : 'You REPLACE the earlier reviewer of this ticket (it is gone): read the whole candidate; the findings it left open are below.';
  out.push(`# Review brief — ticket ${i.ticket} (run ${i.run})`, '', kindLine, '');
  out.push('## Candidate',
    `ticket: ${i.ticket}`,
    `branch: ${i.branch ?? 'unknown'}${i.pr ? ` (PR #${i.pr})` : ''}`,
    `target: ${i.target}`,
    `head: ${i.head}`,
    `base: ${i.base ?? 'unknown (merge-base not computed)'}${i.builtOn.length ? ' (the head this ticket was built on)' : ''}`,
    ...i.builtOn.map((b) => `built on: ${b.id}@${b.sha} (read only what is ABOVE it: its diff is the upstream's)`),
    ...(i.kind === 'wake' && i.prevHead ? [`previous head: ${i.prevHead}`] : []),
    `coordinator: ${i.coordinator} (report to it)`, '');
  out.push('## Ticket text', i.ticketText ? indent(i.ticketText) : i.ticketRef ? `(no text captured; spec reference: ${i.ticketRef})` : '(no spec recorded for this ticket)', '');
  out.push('## Frozen interfaces', i.interfacesText);
  for (const f of i.follows) out.push(f.followed === null ? `- ${f.id}: this ticket records no followed version (current v${f.current})` : f.followed === f.current ? `- ${f.id}: followed v${f.followed} = current` : `- ${f.id}: this ticket follows v${f.followed} but the current is v${f.current}: STALE`);
  out.push('', '## Run decisions', i.decisionsText, '');
  out.push('## Switches in force', i.switchesLine);
  const sentences = switchSentencesOf(i.switches);
  for (const s of sentences) out.push(`- ${s}`);
  out.push('');
  if (i.kind !== 'spawn') {
    out.push('## Open findings carried over');
    if (i.openFindings.length === 0) out.push('(none open)');
    for (const f of i.openFindings) out.push(`- ${f.id} [${f.severity}]${f.raisedOn ? ` raised on ${short(f.raisedOn)}` : ''}${f.text ? `: ${f.text}` : ''}`);
    out.push('');
  }
  out.push('## Rules', REVIEWER_RULES, MERGE_RULES[i.switches.minorPolicy], '');
  if (i.reviewerSkillPath) out.push(`Your role file: ${i.reviewerSkillPath}`, '');
  out.push('## How to end',
    `Write your findings (id, severity, measured|argued, the evidence) and your verdict (approve | changes-requested) on the head ${i.head}, then end with: orchestra send --type worker_done --to ${i.coordinator} --cap "$(orchestra token)" "<verdict + findings>".`,
    'Review this head only; if the ticket moves, the coordinator wakes you with the delta.');
  return `${out.join('\n')}\n`;
}

