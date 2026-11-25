// #589 (I4, switch seatRecords=on) — the reviewer RECORDS its verdict and findings; `gate` and `deliver` read nothing else. Pure; the verb is src/cli/fanout-record.ts.
// Every refusal is a FanoutStateError whose message STARTS with its name in brackets. Who the caller is = `resolveCaller` (#588, src/shared/fanout-caller.ts) — this file never judges identity itself.
import { FanoutStateError, SeatRefusal, applyTicketPatchCore, blockingMinors, findingClosed, sameContent, seatRecordsOn, switchesOf, type FanoutState, type FindingRecord, type ReviewEntry, type TicketState } from './fanout-state.ts';
import type { FileOnHead } from './fanout-demonstration.ts';

const FINDING_ID = /^[A-Za-z0-9][A-Za-z0-9._#:-]{0,63}$/;
const CTRL = /[\x00-\x08\x0b-\x1f\x7f]/;
const sameSha = (a: string, b: string): boolean => a.startsWith(b) || b.startsWith(a);
const recordRefuse = (name: string, msg: string): never => { throw new SeatRefusal(name, msg); };

/** The command a reviewer ends with — printed by every refusal that sends it here. */
export const recordCommand = (ticket: string, head: string): string => `orchestra fanout record ${ticket} --head ${head} --verdict approve|changes-requested --json <file|->`;

// ── the --json of `fanout record` ──────────────────────────────────────────────────────────────────────────────
export interface RecordInput { findings: Record<string, Record<string, unknown>>; fixed: string[] }
const INPUT_FINDING_KEYS = new Set(['severity', 'evidence', 'text', 'demonstration', 'report', 'specSentence', 'kind']);

/** `{"findings":{"<id>":{severity, evidence, text, demonstration?, report?, specSentence?, kind?}},"fixed":["<id>",…]}` — shape only; the finding rules (severity, report, specSentence, demonstration) are the state's own, applied by `recordReview`. */
export function parseRecordJson(text: string): RecordInput {
  let raw: unknown;
  try { raw = JSON.parse(text); } catch { return recordRefuse('record-json', 'the --json is not valid JSON'); }
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) return recordRefuse('record-json', 'the --json must be {"findings":{<id>:{…}},"fixed":[<id>,…]}');
  const o = raw as Record<string, unknown>;
  for (const k of Object.keys(o)) if (k !== 'findings' && k !== 'fixed') recordRefuse('record-json', `unknown key "${k}" (only findings and fixed)`);
  const findings: RecordInput['findings'] = {};
  if (o.findings !== undefined) {
    if (typeof o.findings !== 'object' || o.findings === null || Array.isArray(o.findings)) recordRefuse('record-json', '"findings" must be an object {<id>: {severity, evidence, text, …}}');
    for (const [id, f] of Object.entries(o.findings as Record<string, unknown>)) {
      if (!FINDING_ID.test(id)) recordRefuse('record-json', `unsafe finding id ${JSON.stringify(id)}`);
      if (typeof f !== 'object' || f === null || Array.isArray(f)) recordRefuse('record-json', `finding ${id} must be an object {severity, evidence, text, …}`);
      const rec = f as Record<string, unknown>;
      for (const k of Object.keys(rec)) if (!INPUT_FINDING_KEYS.has(k)) recordRefuse('record-json', `finding ${id}: unknown field "${k}" (${[...INPUT_FINDING_KEYS].join(', ')})`);
      if (rec.evidence !== 'measured' && rec.evidence !== 'argued') recordRefuse('record-json', `finding ${id}: evidence must be "measured" or "argued" — a finding says how it was established`);
      if (typeof rec.text !== 'string' || !rec.text.trim() || rec.text.length > 2000 || CTRL.test(rec.text)) recordRefuse('record-json', `finding ${id}: text must be the finding in printable words (non-empty, at most 2000 characters)`);
      findings[id] = rec;
    }
  }
  let fixed: string[] = [];
  if (o.fixed !== undefined) {
    if (!Array.isArray(o.fixed) || o.fixed.some((d) => typeof d !== 'string' || !FINDING_ID.test(d))) recordRefuse('record-json', '"fixed" must be an array of finding ids');
    fixed = [...new Set(o.fixed as string[])];
  }
  return { findings, fixed };
}

// ── derived counts ─────────────────────────────────────────────────────────────────────────────────────────────
export interface ReviewCounts { blocking: number; major: number; minor: number; /** ids of the findings still open, in recorded order */ open: string[] }
/** The reviewers of a ticket: the recorded one, the ones its briefs went to, the ones that recorded. */
export function reviewersOf(t: TicketState): Set<string> {
  const out = new Set<string>();
  if (t.review?.reviewer?.id) out.add(t.review.reviewer.id);
  for (const b of t.review?.briefs ?? []) if (b.reviewer) out.add(b.reviewer);
  for (const r of t.reviews ?? []) out.add(r.reviewer);
  return out;
}
/** Counts as of review number `n` (every review up to it): raised − closed by a reviewer − decided. A finding the coordinator never typed cannot be in here. */
export function countsThrough(t: TicketState, n: number): ReviewCounts {
  const raised: string[] = [];
  const closed = new Set<string>();
  for (const r of (t.reviews ?? []).filter((x) => x.n <= n)) { for (const id of r.findings) if (!raised.includes(id)) raised.push(id); for (const id of r.closed) closed.add(id); }
  const open = raised.filter((id) => t.findings[id] && !closed.has(id) && !t.findings[id].decision); // as of review n: only a reviewer's "fixed" up to it closes (a later one must not rewrite what an earlier verdict said); a decision always closes
  const sev = (s: string): number => open.filter((id) => t.findings[id].severity === s).length;
  return { blocking: sev('BLOCKING'), major: sev('MAJOR'), minor: sev('MINOR'), open };
}
/** The frozen name of I4: the counts the verdict of `head` carries, DERIVED from the findings (never stored typed). `head` = the latest review on it (sha); none ⇒ every review. */
export function reviewCounts(t: TicketState, head?: string | null): ReviewCounts {
  const rs = t.reviews ?? [];
  const at = head ? [...rs].reverse().find((r) => sameSha(r.head, head)) : undefined;
  return countsThrough(t, at ? at.n : rs.length);
}
/** The latest review that speaks about this CONTENT: same sha, or the same git tree (a rebase keeps the verdict, #512). */
export function reviewOn(t: TicketState, head: string, tree?: string | null): ReviewEntry | null {
  return [...(t.reviews ?? [])].reverse().find((r) => sameContent(r.head, r.tree, head, tree)) ?? null;
}
/** The head the recorded reviewer was told to read: its latest brief, else the review's head, else the ticket's. */
export function reviewHeadOf(t: TicketState): string | null {
  const b = t.review?.briefs ?? [];
  return b.length ? b[b.length - 1].head : t.review?.head ?? t.head ?? null;
}

// ── the record ─────────────────────────────────────────────────────────────────────────────────────────────────
export interface RecordArgs {
  head: string;
  verdict: string;
  input: RecordInput;
  /** `resolveCaller(state, env, identity).id` — null = the caller could not be named. */
  callerId: string | null;
  /** `isVouched(resolveCaller(…))` — the HOST verified {id, session key} (#588): an id read from the env alone is forgeable and records nothing. Absent = not vouched. */
  callerVouched?: boolean;
  tree: string | null;
  now: string;
  fileOnHead?: FileOnHead;
}

/** `orchestra fanout record <ticket>`: the recorded reviewer's verdict + findings on the exact head it read. Pure: returns the new state or throws a named refusal. */
export function recordReview(state: FanoutState, ticketId: string, a: RecordArgs): FanoutState {
  if (!seatRecordsOn(state)) return recordRefuse('record-off', `seatRecords is off for run ${state.run} — nothing is recorded; the coordinator's verdict file (deliver --review-verdict) stays the way`);
  const t = state.tickets[ticketId];
  const reviewer = t?.review?.reviewer?.id ?? null;
  if (!t || !reviewer) {
    return recordRefuse('record-wrong-ticket', `${ticketId} ${t ? 'has no recorded reviewer' : 'is not in the state of run ' + state.run} (tickets with a reviewer: ${Object.entries(state.tickets).filter(([, x]) => x.review?.reviewer?.id).map(([k]) => k).join(', ') || 'none'}) — a verdict is recorded on the ticket its reviewer was spawned for (\`orchestra fanout review <ticket>\`)`);
  }
  if (a.callerId === null || a.callerId !== reviewer || a.callerVouched !== true) {
    if (a.callerId === reviewer && a.callerVouched !== true) return recordRefuse('record-not-reviewer', `the host could not vouch that you are ${t.review!.reviewer!.name} (${reviewer}): an id read from the environment is forgeable, so it records nothing — run this from the reviewer's own session (is Orchestra running, and is this its live session?)`);
    return recordRefuse('record-not-reviewer', `only ${ticketId}'s recorded reviewer (${t.review!.reviewer!.name}, ${reviewer}) records its verdict — you are ${a.callerId ?? 'not identified'}${state.tickets[ticketId] && Object.entries(state.tickets).some(([k, x]) => k !== ticketId && x.review?.reviewer?.id === a.callerId) ? ', the recorded reviewer of another ticket' : ''}. A verdict typed by anyone else is not read by gate or deliver`);
  }
  const expected = reviewHeadOf(t);
  if (!expected) return recordRefuse('record-head-mismatch', `${ticketId} has no head the reviewer was briefed on — nothing to record against`);
  if (!/^[0-9a-f]{7,40}$/.test(a.head) || !sameSha(expected, a.head)) {
    return recordRefuse('record-head-mismatch', `--head ${a.head.slice(0, 12)} is not the head you were briefed to read (${expected.slice(0, 12)}): a verdict speaks about the exact head it read — read ${expected.slice(0, 12)} (or ask the coordinator to wake you on the new head: \`orchestra fanout review ${ticketId}\`), then record`);
  }
  const head = expected.length >= a.head.length ? expected : a.head; // the longer of the two spellings of one sha
  if (a.verdict !== 'approve' && a.verdict !== 'changes-requested') return recordRefuse('record-verdict', `--verdict must be approve or changes-requested (got ${JSON.stringify(a.verdict)}) — the counts are derived from your findings, not typed`);

  // findings: new ids only; `fixed` ids must be open findings that a reviewer of this ticket raised, on ANOTHER head than this one
  const ids = Object.keys(a.input.findings);
  for (const id of ids) if (t.findings[id]) recordRefuse('finding-exists', `finding ${id} is already recorded on ${ticketId} (${t.findings[id].severity}): a recorded finding is not rewritten — close it with "fixed" on a later head, or give the new problem a new id`);
  const reviewers = reviewersOf(t);
  for (const id of a.input.fixed) {
    const f = t.findings[id];
    if (!f) recordRefuse('fixed-not-open', `"fixed" names ${id}, which is not recorded on ${ticketId} (recorded: ${Object.keys(t.findings).join(', ') || 'none'})`);
    if (findingClosed(f) || (t.reviews ?? []).some((r) => r.closed.includes(id))) recordRefuse('fixed-not-open', `"fixed" names ${id}, which is already closed (${f.settled ? 'settled' : f.decision ? 'decided: ' + f.decision.text.slice(0, 80) : 'fixed'})`);
    if (!f.by || !reviewers.has(f.by)) recordRefuse('fixed-by-non-reviewer', `${id} was not raised by a reviewer of ${ticketId} (by: ${f.by ?? 'nobody — typed state'}): only a reviewer's own finding is closed by a reviewer's record; the coordinator's way is \`state set ${ticketId} --decide ${id}=<reason>\` (listed by \`fanout closeout\`)`);
    if (f.raisedOn && sameSha(f.raisedOn, head)) recordRefuse('fixed-same-head', `${id} was raised on ${head.slice(0, 12)}, the head you are recording: "fixed" is a later head that you READ with the fix in it`);
  }

  // the reviewer's findings go through the state's own transition (severity / report / specSentence / demonstration rules), as the head THEY read
  const patch: Record<string, unknown> = {};
  if (ids.length) patch.findings = Object.fromEntries(ids.map((id) => [id, { ...a.input.findings[id], by: a.callerId, raisedOn: head }]));
  if (a.input.fixed.length) patch.settle = Object.fromEntries(a.input.fixed.map((id) => [id, t.findings[id].kind === 'process' ? { how: 'pr-body', ref: `read by the reviewer on ${head}` } : { how: 'fixed', ref: head }]));
  let next = state;
  if (ids.length || a.input.fixed.length) {
    const view: FanoutState = { ...state, tickets: { ...state.tickets, [ticketId]: { ...t, head } } }; // demonstrations are classified against the head the reviewer read
    next = applyTicketPatchCore(view, ticketId, patch, a.now, { fileOnHead: a.fileOnHead });
    next = { ...next, tickets: { ...next.tickets, [ticketId]: { ...next.tickets[ticketId], head: t.head } } };
  }
  const nt0 = next.tickets[ticketId];
  const findings: Record<string, FindingRecord> = { ...nt0.findings };
  for (const id of a.input.fixed) findings[id] = { ...findings[id], fixedBy: { by: a.callerId, head, at: a.now } };
  const entry: ReviewEntry = { n: (t.reviews?.length ?? 0) + 1, reviewer, head, tree: a.tree, verdict: a.verdict, findings: ids, closed: a.input.fixed, at: a.now };
  const nt: TicketState = { ...nt0, findings, reviews: [...(t.reviews ?? []), entry], ...(t.head && sameSha(head, t.head) ? { verdict: a.verdict } : {}), updatedAt: a.now };
  const out: FanoutState = { ...next, tickets: { ...next.tickets, [ticketId]: nt }, updatedAt: a.now };

  // approve = nothing BLOCKING / MAJOR (nor, under minorPolicy spec|demonstrated, a blocking MINOR) is left open; changes-requested says what
  const c = countsThrough(nt, entry.n);
  const heldIds = [...new Set([...c.open.filter((id) => nt.findings[id].severity !== 'MINOR'), ...blockingMinors(out, ticketId).filter((id) => c.open.includes(id))])];
  if (a.verdict === 'approve' && heldIds.length) recordRefuse('approve-open-finding', `approve with ${heldIds.length} open finding(s) that block the merge (${heldIds.map((id) => `${id} ${nt.findings[id].severity}`).join(', ')}) — record changes-requested, or close them with "fixed" if you read their fix on this head (policy: minorPolicy=${switchesOf(state).minorPolicy})`);
  if (a.verdict === 'changes-requested' && heldIds.length === 0) recordRefuse('changes-no-finding', 'changes-requested with no open BLOCKING / MAJOR finding (nor a blocking MINOR under this run\'s minorPolicy): list the finding that stops the merge in "findings", or record approve');
  return out;
}

// ── what gate and deliver read ─────────────────────────────────────────────────────────────────────────────────
export interface RecordedVerdict { round: number; blocking: number; major: number; minor: number; head: string; reviewer: string; verdict: ReviewEntry['verdict']; open: string[] }
export type RecordedRead = { ok: true; recorded: RecordedVerdict } | { ok: false; reason: 'record-missing'; detail: string };
/** The verdict of `ticket` on this content, from the recorded reviews only. No review on it ⇒ `record-missing` naming the reviewer to wake / replace. The counts are the OPEN findings (a decided / closed one is not counted): what blocks is what they say, not the word the reviewer recorded. */
export function recordedVerdictOf(state: FanoutState, ticketId: string, head: string, tree?: string | null): RecordedRead {
  const t = state.tickets[ticketId];
  if (!t) return { ok: false, reason: 'record-missing', detail: `${ticketId} is not in the state of run ${state.run}` };
  const r = reviewOn(t, head, tree);
  if (!r) {
    const who = t.review?.reviewer;
    const has = (t.reviews ?? []).length;
    return { ok: false, reason: 'record-missing', detail: who?.id
      ? `[record-missing] ${ticketId}: no recorded verdict on ${head.slice(0, 12)}${has ? ` (recorded: ${(t.reviews ?? []).map((x) => x.head.slice(0, 8)).join(', ')})` : ''} — reviewer ${who.name} (${who.id}) has not recorded it: wake it (\`orchestra fanout review ${ticketId}\`; it is replaced there when it is dead or deleted) — its worker_done is refused until it records. A verdict typed by the coordinator is not read`
      : `[record-missing] ${ticketId}: no reviewer is recorded and no verdict is recorded on ${head.slice(0, 12)} — spawn it: \`orchestra fanout review ${ticketId}\`` };
  }
  const c = countsThrough(t, r.n);
  const recorded: RecordedVerdict = { round: r.n, blocking: c.blocking, major: c.major, minor: c.minor, head: sameSha(r.head, head) ? head : r.head, reviewer: r.reviewer, verdict: r.verdict, open: c.open };
  return { ok: true, recorded };
}

/** The bus-side refusal: a recorded reviewer's `worker_done` is refused until its head's verdict is recorded. null = nothing to refuse (switch off, not a reviewer, recorded). */
export function reviewerDoneRefusal(state: FanoutState, senderId: string): string | null {
  if (!seatRecordsOn(state) || !senderId) return null;
  for (const [id, t] of Object.entries(state.tickets)) {
    if (t.review?.reviewer?.id !== senderId || t.status === 'merged' || t.status === 'dropped') continue;
    const head = reviewHeadOf(t);
    if (!head || (t.reviews ?? []).some((r) => r.reviewer === senderId && sameSha(r.head, head))) continue;
    return `[record-missing] orchestra send: worker_done refused — you are the reviewer of ${id} and no verdict of yours is recorded on ${head.slice(0, 12)}. run: ${recordCommand(id, head)}\nthen send worker_done again. Nothing was sent.`;
  }
  return null;
}

/** `resume`: every reviewer that has not recorded its head's verdict (alive or dead — the coordinator cannot tell from the state), with the one verb that wakes or replaces it. */
export function unrecordedReviewers(state: FanoutState): Array<{ ticket: string; reviewer: string; name: string; head: string; line: string }> {
  if (!seatRecordsOn(state)) return [];
  const out: Array<{ ticket: string; reviewer: string; name: string; head: string; line: string }> = [];
  for (const [id, t] of Object.entries(state.tickets)) {
    const r = t.review?.reviewer;
    if (!r?.id || t.status === 'merged' || t.status === 'dropped') continue;
    const head = reviewHeadOf(t);
    if (!head || (t.reviews ?? []).some((x) => x.reviewer === r.id && sameSha(x.head, head))) continue;
    out.push({ ticket: id, reviewer: r.id, name: r.name, head, line: `${id}: reviewer ${r.name} (${r.id}) has recorded no verdict on ${head.slice(0, 12)} — wake it, or replace it if it died: \`orchestra fanout review ${id}\` (its worker_done is refused until it records; no verdict is typed instead)` });
  }
  return out;
}

/** `state set --decide` under seatRecords=on is the COORDINATOR's, proven by the host (an implementer / another agent cannot lift a reviewer's finding; a forged `by` in a --json patch is overwritten with the vouched id). */
export function assertDecideCaller(state: FanoutState, caller: { id: string | null; role: string; proof: string }): void {
  if (caller.role !== 'coordinator') recordRefuse('decide-caller', `only the run's coordinator (${state.run}) records "not fixed" with a reason (\`state set <ticket> --decide <finding>=<reason>\`); the caller is ${caller.id ?? 'unidentified'} (${caller.role})`);
  if (caller.proof !== 'host-vouched') recordRefuse('decide-caller', `the host did not vouch for ${caller.id}: ${caller.proof} — run it from the coordinator's own live session (a forged ORCHESTRA_WS_ID proves nothing)`);
}
