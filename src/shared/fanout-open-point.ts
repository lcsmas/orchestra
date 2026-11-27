// #676 — an OPEN POINT is run state: `orchestra fanout open-point <ticket> --about <other> --text "<t>"` writes `openPoints[]` instead of a prose line nobody reads. It blocks BOTH tickets
// (`gate`, `deliver`, the loop's approvals: `[open-point-unsettled]`) until it settles — a new head of the `about` ticket that ITS reviewer approves with the point listed as `addressed`, or a recorded
// decision (the loop's fixed rule, or the coordinator's). When `about` is already merged the loop opens a follow-up ticket (`followUpOf` set) that carries it. Pure; the verb is src/cli/fanout-open-point.ts.
import { OPEN_POINTS_MAX, OPEN_POINT_TEXT_MAX, SeatRefusal, applyTicketPatchCore, sameContent, seatRecordsOn, setPlan, type FanoutState, type FollowUpRefusal, type OpenPoint, type TicketState } from './fanout-state.ts';

const OP_CTRL = /[\x00-\x08\x0b-\x1f\x7f]/;
const openPointRefuse = (name: string, msg: string): never => { throw new SeatRefusal(name, msg); };

/** The fixed rule the loop applies to a point nobody addressed (decision 5: the reversible option; the loop never waits for a person). */
export const OPEN_POINT_FIXED_RULE = 'fixed rule of the loop (reversible option): the ticket the point is about stays as recorded';

export const openPointsOf = (state: FanoutState): OpenPoint[] => state.openPoints ?? [];
export const openPointsOpen = (state: FanoutState): OpenPoint[] => openPointsOf(state).filter((p) => p.status === 'open');
/** The ids a follow-up chain covers: the ticket itself, the ticket it follows up, and so on (a follow-up of a follow-up). */
export function followChain(state: FanoutState, id: string): string[] {
  const out = [id];
  for (let up = state.tickets[id]?.followUpOf ?? null; up && !out.includes(up) && out.length < 9; up = state.tickets[up]?.followUpOf ?? null) out.push(up);
  return out;
}
/** The follow-up ticket id the loop gives point `n`: `<about>-op<n>`. */
export const followUpIdOf = (p: Pick<OpenPoint, 'about' | 'id'>): string => `${p.about.slice(0, 50)}-op${p.id}`;
/** `op-<n>` in a follow-up's `fixes`: the open point it carries (the loop writes it). */
export const openPointRef = (n: number): string => `op-${n}`;
export const parseOpenPointRef = (s: string): number | null => { const m = /^op-([1-9][0-9]*)$/.exec(s); return m ? Number(m[1]) : null; };

/** `fanout open-point <from> --about <about> --text <t>`. Under seatRecords=on only `from`'s own implementer or recorded reviewer, vouched by the host, raises it (an implementer / reviewer of ANOTHER ticket, the coordinator: `[open-point-caller]`). Same point twice = the same number (idempotent). */
export function recordOpenPoint(state: FanoutState, from: string, a: { about: string; text: string; callerId: string | null; callerVouched?: boolean; now: string }): { state: FanoutState; point: OpenPoint; fresh: boolean } {
  const t = state.tickets[from];
  if (!t) return openPointRefuse('open-point-unknown-ticket', `${from} is not in the state of run ${state.run} (tickets: ${Object.keys(state.tickets).join(', ') || 'none'})`);
  const about = state.tickets[a.about];
  if (!about) return openPointRefuse('open-point-unknown-ticket', `--about ${a.about} is not in the state of run ${state.run} (tickets: ${Object.keys(state.tickets).join(', ') || 'none'})`);
  if (a.about === from) return openPointRefuse('open-point-self', `a point is about ANOTHER ticket (${from} is both): what your own ticket still needs, you do`);
  if (t.status === 'merged' || t.status === 'dropped') return openPointRefuse('open-point-closed', `${from} is ${t.status}: an open point is raised while the ticket is open`);
  if (about.status === 'dropped') return openPointRefuse('open-point-closed', `${a.about} is dropped: nothing can address a point about it`);
  const text = a.text.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > OPEN_POINT_TEXT_MAX || OP_CTRL.test(text)) return openPointRefuse('open-point-bad', `the text must be the point in printable words (non-blank, at most ${OPEN_POINT_TEXT_MAX} characters)`);
  if (seatRecordsOn(state)) {
    if (a.callerVouched !== true) return openPointRefuse('open-point-caller', `the host could not vouch for ${a.callerId ?? 'this session'}: only ${from}'s implementer or reviewer, from its live session, raises an open point`);
    const mine = !!a.callerId && (t.implementer === a.callerId || t.review?.reviewer?.id === a.callerId);
    if (!mine) return openPointRefuse('open-point-caller', `only ${from}'s implementer (${t.implementer ?? 'none recorded'}) or recorded reviewer (${t.review?.reviewer?.id ?? 'none recorded'}) raises an open point on it; you are ${a.callerId ?? 'not identified'}`);
  }
  const list = openPointsOf(state);
  const same = list.find((p) => p.status === 'open' && p.from === from && p.about === a.about && p.text === text);
  if (same) return { state, point: same, fresh: false };
  if (list.length >= OPEN_POINTS_MAX) return openPointRefuse('open-point-bad', `the run already holds ${list.length} open points (at most ${OPEN_POINTS_MAX})`);
  const point: OpenPoint = { id: list.length + 1, from, about: a.about, text, at: a.now, status: 'open', aboutHead: about.head ?? null, aboutTree: about.tree ?? null };
  return { state: { ...state, openPoints: [...list, point], updatedAt: a.now }, point, fresh: true };
}

/** The refusal of `gate` / `deliver` / the loop's approval for ticket `id`: an unsettled point it raised, is about, or carries (as a follow-up). A merged / dropped ticket is not judged (nothing left to deliver). null = free. */
export function openPointRefusal(state: FanoutState, id: string): FollowUpRefusal | null {
  const t = state.tickets[id];
  if (!t || t.status === 'merged' || t.status === 'dropped') return null;
  const mine = openPointsOpen(state).filter((p) => p.from === id || p.about === id || p.followUp === id);
  if (!mine.length) return null;
  const line = (p: OpenPoint): string => `#${p.id} ${p.from} → ${p.about}${p.followUp ? ` (carried by ${p.followUp})` : ''}: “${p.text.replace(/\s+/g, ' ').slice(0, 120)}”`;
  return { reason: 'open-point-unsettled', detail: `${id}: ${mine.length} open point(s) block it — ${mine.map(line).join('; ')} — settled when the reviewer of ${[...new Set(mine.map((p) => p.followUp ?? p.about))].join(' / ')} approves a NEW head with the point listed in "addressed" (\`fanout record\`), or by a recorded decision (\`orchestra fanout open-point --decide <n>=<reason>\`, listed in the report)` };
}
export const openPointBlocked = (state: FanoutState, id: string): boolean => openPointRefusal(state, id) !== null;

/** The points `ticket`'s reviewer can address: open, about this ticket (or the ticket this follow-up follows). */
export function addressablePoints(state: FanoutState, ticket: string): OpenPoint[] {
  const chain = followChain(state, ticket);
  return openPointsOpen(state).filter((p) => chain.includes(p.about) && (p.followUp === undefined || p.followUp === ticket));
}

/** `fanout record … {"addressed":[n,…]}`: the reviewer of the `about` ticket (or of its follow-up) says the head it APPROVES addresses the point. Pure check + transition; throws `[addressed-*]`. */
export function settleAddressed(state: FanoutState, ticketId: string, ids: number[], a: { head: string; tree: string | null; verdict: string; by: string; now: string }): FanoutState {
  if (!ids.length) return state;
  if (a.verdict !== 'approve') openPointRefuse('addressed-not-approved', `"addressed" is part of an APPROVAL: you record changes-requested, so no point is addressed (name them again on the head you approve)`);
  const list = openPointsOf(state);
  const next = list.map((p) => ({ ...p }));
  for (const n of ids) {
    const p = list.find((x) => x.id === n);
    if (!p) return openPointRefuse('addressed-unknown', `"addressed" names open point ${n}, which does not exist (points: ${list.map((x) => x.id).join(', ') || 'none'})`);
    if (p.status !== 'open') return openPointRefuse('addressed-unknown', `open point ${n} is already settled (${p.settled?.how})`);
    if (!followChain(state, ticketId).includes(p.about)) return openPointRefuse('addressed-wrong-ticket', `open point ${n} is about ${p.about}: it is addressed by ${p.about}'s reviewer (or its follow-up's), not ${ticketId}'s`);
    if (p.followUp !== undefined && p.followUp !== ticketId) return openPointRefuse('addressed-wrong-ticket', `open point ${n} is carried by the follow-up ${p.followUp}: its reviewer addresses it`);
    if (ticketId === p.about && p.aboutHead && (p.aboutHead.startsWith(a.head) || a.head.startsWith(p.aboutHead) || sameContent(p.aboutHead, p.aboutTree, a.head, a.tree))) {
      return openPointRefuse('addressed-same-head', `open point ${n} was raised when ${p.about} was at ${p.aboutHead.slice(0, 12)}, the head you read: only a NEW head of ${p.about} can address it (the loop orders its implementer; you are woken on the new head)`);
    }
    const i = next.findIndex((x) => x.id === n);
    next[i] = { ...next[i], status: 'settled', settled: { how: 'addressed', at: a.now, by: a.by, ticket: ticketId, head: a.head } };
  }
  return { ...state, openPoints: next, updatedAt: a.now };
}

/** A decision on point `n`: the loop's fixed rule, or the coordinator's reason. Listed in the closing report. */
export function decideOpenPoint(state: FanoutState, n: number, a: { by: string; text: string; now: string }): FanoutState {
  const list = openPointsOf(state);
  const p = list.find((x) => x.id === n);
  if (!p) return openPointRefuse('open-point-unknown', `open point ${n} does not exist (points: ${list.map((x) => x.id).join(', ') || 'none'})`);
  if (p.status !== 'open') return openPointRefuse('open-point-unknown', `open point ${n} is already settled (${p.settled?.how})`);
  const text = a.text.replace(/\r\n/g, '\n').trim();
  if (!text || text.length > OPEN_POINT_TEXT_MAX || OP_CTRL.test(text)) return openPointRefuse('open-point-reason-blank', `--decide ${n} needs a written reason in printable words (the report lists each decision with it)`);
  return { ...state, openPoints: list.map((x) => (x.id === n ? { ...x, status: 'settled' as const, settled: { how: 'decided' as const, at: a.now, by: a.by, text } } : x)), updatedAt: a.now };
}

/** `about` is merged and the point has no follow-up yet: ticket `<about>-op<n>` (todo, `followUpOf` = about, `fixes` = [op-n], in the plan) carries it; `start` gives it an implementer. Idempotent. */
export function openFollowUp(state: FanoutState, n: number, now: string): FanoutState {
  const p = openPointsOf(state).find((x) => x.id === n);
  if (!p || p.status !== 'open' || p.followUp) return state;
  const id = followUpIdOf(p);
  let s = state;
  if (!s.tickets[id]) {
    const base = s.tickets[p.about];
    const text = [
      `Follow-up of ${p.about} (already merged) — open point ${n}, raised by ${p.from}:`,
      '',
      p.text,
      '',
      `Address it in code on this branch (cut from ${s.target}); ${p.from} stays blocked until your reviewer approves with the point listed as addressed.`,
      ...(base?.specText ? ['', `The text of ${p.about}, for context:`, base.specText.trim()] : base?.spec ? ['', `Spec of ${p.about}: ${base.spec}`] : []),
    ].join('\n');
    s = applyTicketPatchCore(s, id, { spec: `open point ${n} of ${p.from} about ${p.about}`.slice(0, 200), status: 'todo', dependsOn: [], followUpOf: p.about, fixes: [openPointRef(n)] }, now, { specText: text.slice(0, 20_000) });
  }
  if (s.plan && !s.plan.tickets.includes(id)) s = setPlan(s, [id], 'add', now);
  return { ...s, openPoints: openPointsOf(s).map((x) => (x.id === n ? { ...x, followUp: id } : x)), updatedAt: now };
}

// ── what the seats read ────────────────────────────────────────────────────────────────────────────────────────
/** The reviewer's brief section: the points it can address (ids to cite in `"addressed"`). '' when there are none (the brief stays byte-identical). */
export function renderPointsForReviewer(state: FanoutState, ticket: string): string {
  const ps = addressablePoints(state, ticket);
  if (!ps.length) return '';
  return [`## Open points about this ticket (raised by other tickets — they block them until you settle them)`,
    ...ps.map((p) => `- point ${p.id}, from ${p.from}: ${p.text.replace(/\s+/g, ' ')}`),
    'When you APPROVE a head that addresses one of them (a NEW head: not the one the point was raised on), list its number in the record\'s "addressed":[n,…]; a point the code still does not address is a finding.'].join('\n');
}
/** The order the loop sends the `about` ticket's implementer. */
export function renderPointOrder(state: FanoutState, p: OpenPoint, n: number): string {
  return [
    `OPEN POINT ${p.id} — ${p.from} left a point about your ticket ${p.about}${n > 1 ? ` (order ${n}: your head has not moved since)` : ''}:`,
    p.text,
    `Address it in code on your branch, push, then send a status. Your reviewer reads the new head and approves with the point listed as addressed; ${p.from} and ${p.about} stay blocked until then. If the point is wrong, say so in a status — the loop's fixed rule (the reversible option) closes it after two orders.`,
  ].join('\n');
}
/** The closing report's lines: every point, how it settled. */
export function reportPointLine(p: OpenPoint): string {
  const how = p.status === 'open' ? 'STILL OPEN' : p.settled!.how === 'addressed' ? `addressed on ${p.settled!.ticket} at ${(p.settled!.head ?? '').slice(0, 12)}` : `decided by ${p.settled!.by}: ${(p.settled!.text ?? '').replace(/\s+/g, ' ').slice(0, 200)}`;
  return `  #${p.id} ${p.from} → ${p.about}${p.followUp ? ` (follow-up ${p.followUp})` : ''}: ${p.text.replace(/\s+/g, ' ').slice(0, 200)} — ${how}`;
}

export type { TicketState };
