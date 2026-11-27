// #588 (I3) — `orchestra fanout review`: the pure decisions on the STATE (refusals, spawn/wake/replace/noop, the brief input, the claim/settle of the reviewer slot).
// The CLI half is src/cli/fanout-review.ts; the host half (spawn / wake) is src/shared/fanout-review-host.ts. Every refusal message STARTS with its bracketed name.
import { FANOUT_REVIEWER_SKILL_PATH } from './fanout-reviewer-skill.ts';
import { briefHash, renderReviewerBrief, type BriefFinding, type BriefInput, type BriefKind } from './fanout-review-brief.ts';
import { renderPointsForReviewer } from './fanout-open-point.ts';
import { renderDecisions, renderInterfaces, renderSwitchesLine, renderTicketChoices } from './fanout-brief-common.ts';
import { isVouched, type Caller } from './fanout-caller.ts';
import { claimIsStale } from './fanout-acceptance.ts';
import {
  FanoutStateError, SeatRefusal, freezeAtFirstSpawn, interfaceOf, planMissing, seatRecordsOn, stampDefaults, switchesOf,
  type FanoutState, type ReviewBrief, type ReviewRecord, type TicketState,
} from './fanout-state.ts';

/** A `[review-…]` refusal: a SeatRefusal (message starts with its bracketed name; the CLI exits 2). */
export class ReviewRefusal extends SeatRefusal {}
const reviewRefuse = (name: string, detail: string): never => { throw new ReviewRefusal(name, detail); };

/** `review-<ticket slug>`: the `review-` prefix IS the reviewer role (fleet-roles.ts `ROLE_PREFIX`), so the role table pins its tools; `n` = the nth reviewer of the ticket (a replacement is `-r2`…). */
export function reviewerName(ticket: string, n = 1): string {
  const slug = ticket.normalize('NFD').replace(/\p{M}+/gu, '').replace(/[^A-Za-z0-9._-]+/g, '-').replace(/^[-.]+|[-.]+$/g, '').replace(/\.{2,}/g, '.').slice(0, 56);
  return `review-${slug || 'ticket'}${n > 1 ? `-r${n}` : ''}`;
}

const hadReviewer = (t: TicketState): boolean => !!t.review?.briefs.some((b) => b.reviewer !== null);
const reviewSameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);

/** The refusals that need only the state (the caller proof is checked by {@link assertReviewCaller}, `--print` skips it). Returns the ticket. */
export function assertReviewable(state: FanoutState, ticket: string): TicketState {
  if (!seatRecordsOn(state)) reviewRefuse('review-off', 'seatRecords is OFF for this run (state show prints the switches): no reviewer is rendered, spawned or recorded by code; spawn the reviewer by hand, or start a run with `--switch seatRecords=on`');
  const t = state.tickets[ticket];
  if (!t) throw new FanoutStateError(`ticket ${ticket} is not in the fanout state of run ${state.run}`);
  if (!t.head) reviewRefuse('review-no-head', `${ticket} has no recorded head: nominate it first (\`orchestra fanout state set ${ticket} --head <sha> --status nominated\`) — the brief names the exact head and base`);
  const missing = planMissing(state);
  if (missing.length) reviewRefuse('review-plan', `the run's plan is incomplete: ${missing.join('; ')}`);
  return t;
}

/** Only the run's coordinator, proven by the HOST, may have a reviewer rendered into the run (or add a run decision, `what` = `decision-caller`): a forged `ORCHESTRA_WS_ID` is not a proof (fanout-caller.ts). */
export function assertReviewCaller(state: FanoutState, caller: Caller, name: 'review-caller' | 'decision-caller' = 'review-caller'): void {
  const verb = name === 'review-caller' ? '`fanout review`' : '`state set --run-decision`';
  if (caller.role !== 'coordinator') reviewRefuse(name, `only the run's coordinator (${state.run}) may run ${verb}; the caller is ${caller.id ?? 'unidentified'} (${caller.role})`);
  if (!isVouched(caller)) reviewRefuse(name, `the host did not vouch for ${caller.id}: ${caller.proof} — run it from the coordinator's own live session (a forged ORCHESTRA_WS_ID proves nothing)`);
}

/** The recorded reviewer may be neither the ticket's implementer nor the coordinator (nor its verifier); checked on the RECORDED id and on a freshly spawned one. */
export function assertReviewerRole(state: FanoutState, t: TicketState, reviewerId: string | null): void {
  if (!reviewerId) return;
  if (reviewerId === state.run) reviewRefuse('review-role', `the reviewer ${reviewerId} is the run's coordinator`);
  if (reviewerId === t.implementer) reviewRefuse('review-role', `the reviewer ${reviewerId} is the ticket's implementer`);
  if (reviewerId === t.verifier) reviewRefuse('review-role', `the reviewer ${reviewerId} is the ticket's verifier`);
}

export type ReviewAction = { action: 'spawn' | 'replace'; kind: BriefKind } | { action: 'wake'; kind: 'wake' } | { action: 'noop'; why: string; id: string | null };

/** What a call does for `head` given who is recorded and whether they are alive: no reviewer / a failed or stale claim ⇒ spawn; the SAME live reviewer on the SAME head ⇒ nothing; on a NEW head ⇒ wake it;
 *  a recorded reviewer that is gone ⇒ replace. `isLive` is the host's knowledge (a deleted / archived workspace is not live). */
export function decideReview(t: TicketState, head: string, nowIso: string, isLive: (id: string) => boolean): ReviewAction {
  const rv = t.review?.reviewer ?? null;
  // a (re)spawn is a REPLACEMENT as soon as ANY earlier brief reached a reviewer: a failed replace or a stale claim retried must still carry the open findings
  const again: ReviewAction = hadReviewer(t) ? { action: 'replace', kind: 'replace' } : { action: 'spawn', kind: 'spawn' };
  if (!rv || rv.error) return again;
  if (rv.id === null) return claimIsStale(rv, nowIso) ? again : { action: 'noop', why: 'a reviewer spawn is already in flight', id: null };
  if (!isLive(rv.id)) return { action: 'replace', kind: 'replace' };
  if (t.review?.head && reviewSameSha(t.review.head, head)) return { action: 'noop', why: `${rv.name} (${rv.id}) is already briefed on this head`, id: rv.id };
  return { action: 'wake', kind: 'wake' };
}

const openFindingsOf = (t: TicketState): BriefFinding[] =>
  Object.entries(t.findings).filter(([, f]) => !f.settled && !f.decision && f.onChoice === undefined).map(([id, f]) => {
    const x = f as { text?: string; raisedOn?: string }; // I4 (#589) adds text / raisedOn
    return { id, severity: f.severity, text: x.text ?? null, raisedOn: x.raisedOn ?? null };
  });

/** The upstream heads `t` was built on while those upstreams are NOT merged (a merged upstream is already in the target: nothing to exclude). */
const builtOnOpen = (state: FanoutState, t: TicketState): Array<{ id: string; sha: string }> =>
  Object.entries(t.builtOn).filter(([up]) => state.tickets[up]?.status !== 'merged').map(([id, sha]) => ({ id, sha }));
/** #588 (review r1 MINOR-1) — the base of a STACKED ticket = the one upstream head it was built on (the review reads only what is above it); null = not stacked on exactly one (the CLI then uses merge-base with the target). */
export function stackedBase(state: FanoutState, ticket: string): string | null {
  const open = builtOnOpen(state, state.tickets[ticket]);
  return open.length === 1 ? open[0].sha : null;
}

/** The brief's input from the state alone (+ the base the CLI computed). The same state + head + base + kind ⇒ the same input ⇒ the same text. */
export function briefInputOf(state: FanoutState, ticket: string, o: { kind: BriefKind; head: string; base: string | null; reviewerSkillPath?: string | null }): BriefInput {
  const t = state.tickets[ticket];
  const own = interfaceOf(state, ticket);
  const follows = t.follows ?? {};
  return {
    run: state.run, coordinator: state.run, ticket, kind: o.kind,
    ticketText: t.specText, ticketRef: t.spec, target: state.target, head: o.head, base: o.base,
    prevHead: o.kind === 'wake' ? t.review?.head ?? null : null, branch: t.branch, pr: t.pr,
    interfacesText: renderInterfaces(state, [...(own ? [ticket] : []), ...t.dependsOn]),
    decisionsText: renderDecisions(state),
    choicesText: renderTicketChoices(state, ticket),
    pointsText: renderPointsForReviewer(state, ticket),
    switchesLine: renderSwitchesLine(state),
    follows: t.dependsOn.flatMap((id) => { const i = interfaceOf(state, id); return i ? [{ id, current: i.version, followed: follows[id] ?? null }] : []; }),
    switches: switchesOf(state),
    builtOn: builtOnOpen(state, t),
    openFindings: o.kind === 'spawn' ? [] : openFindingsOf(t),
    reviewerSkillPath: o.reviewerSkillPath !== undefined ? o.reviewerSkillPath : FANOUT_REVIEWER_SKILL_PATH, // #590 (I5): the brief names the reviewer's role file
  };
}

export const renderBriefOf = (state: FanoutState, ticket: string, o: Parameters<typeof briefInputOf>[2]): { text: string; hash: string } => {
  const text = renderReviewerBrief(briefInputOf(state, ticket, o));
  return { text, hash: briefHash(text) };
};

const withReview = (state: FanoutState, ticket: string, review: ReviewRecord, now: string): FanoutState =>
  ({ ...state, tickets: { ...state.tickets, [ticket]: { ...state.tickets[ticket], review, updatedAt: now } }, updatedAt: now });
const reviewOf = (t: TicketState): ReviewRecord => t.review ?? { reviewer: null, head: null, base: null, briefs: [] };

/** Claim the reviewer slot for a (re)spawn: the new reviewer is `id: null` (in flight) and the brief is stored with its hash. The run is frozen at its first spawn (#554), as for a writer. */
export function claimReviewer(state0: FanoutState, ticket: string, o: { kind: 'spawn' | 'replace'; name: string; head: string; base: string | null; text: string; now: string }): FanoutState {
  const state = stampDefaults(state0);
  const t = state.tickets[ticket];
  const r = reviewOf(t);
  // a retry of a spawn that never produced a reviewer (failed / stale claim) replaces ITS unsent brief instead of piling up another
  const kept = r.reviewer && (r.reviewer.error || r.reviewer.id === null) ? r.briefs.filter((b, i) => !(i === r.briefs.length - 1 && b.reviewer === null)) : r.briefs;
  const brief: ReviewBrief = { n: kept.length + 1, kind: o.kind, head: o.head, base: o.base, hash: briefHash(o.text), text: o.text, reviewer: null, at: o.now };
  return freezeAtFirstSpawn(withReview(state, ticket, { reviewer: { id: null, name: o.name, at: o.now }, head: r.head, base: r.base, briefs: [...kept, brief] }, o.now), o.now);
}
/** Record the spawn's outcome: the reviewer's id (the head/base it was briefed on become the record's), or the error (the slot stays retryable). */
export function settleReviewer(state: FanoutState, ticket: string, r: { id: string } | { error: string }, now: string): FanoutState {
  const t = state.tickets[ticket];
  const rec = t?.review;
  if (!t || !rec?.reviewer) return state;
  const last = rec.briefs[rec.briefs.length - 1];
  if ('error' in r) return withReview(state, ticket, { ...rec, reviewer: { id: null, name: rec.reviewer.name, at: rec.reviewer.at, error: r.error.slice(0, 500) } }, now);
  const briefs = rec.briefs.map((b, i) => (i === rec.briefs.length - 1 ? { ...b, reviewer: r.id } : b));
  return withReview(state, ticket, { reviewer: { id: r.id, name: rec.reviewer.name, at: now }, head: last.head, base: last.base, briefs }, now);
}
/** Record a wake: the SAME reviewer, a new brief (the delta) and the new head. */
export function recordWake(state: FanoutState, ticket: string, o: { head: string; base: string | null; text: string; now: string }): FanoutState {
  const t = state.tickets[ticket];
  const r = reviewOf(t);
  const brief: ReviewBrief = { n: r.briefs.length + 1, kind: 'wake', head: o.head, base: o.base, hash: briefHash(o.text), text: o.text, reviewer: r.reviewer?.id ?? null, at: o.now };
  return withReview(state, ticket, { ...r, head: o.head, base: o.base, briefs: [...r.briefs, brief] }, o.now);
}
/** Undo {@link recordWake} (the wake message could not be delivered): the brief and the head go back to what they were. */
export function undoWake(state: FanoutState, ticket: string, prev: ReviewRecord | undefined, now: string): FanoutState {
  if (!prev) return state;
  return withReview(state, ticket, prev, now);
}
/** The ordinal of the NEXT reviewer of the ticket: spawned ones (a brief that reached a reviewer, not a wake) + 1. */
export const nthReviewer = (t: TicketState): number => (t.review?.briefs.filter((b) => b.kind !== 'wake' && b.reviewer !== null).length ?? 0) + 1;
