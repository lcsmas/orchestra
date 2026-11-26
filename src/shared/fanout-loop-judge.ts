// #605 (ledger #613) — the INSTRUMENT: reads the dummy fleet's event log and names every rule of #601 the run broke. Pure. Each rule has a must-pass scenario and a must-fail one in the rig, and the loop mutants must turn it red
// (a judge that never fails measures nothing). `startAt` = each ticket's `start.at` from the state (decision 3's measurement point).
import { FIXED_ANSWER } from './fanout-loop.ts';

export interface Ev { t: number; ev: string; ticket?: string; [k: string]: unknown }
export interface Violation { rule: string; ticket?: string; detail: string }
export interface JudgeInput { events: Ev[]; deps: Record<string, string[]>; tickets: string[]; startAt: Record<string, number | null> }

export const RULES = [
  'start-all-before-first-merge', 'implementer-waited', 'duplicate-agent', 'connected-before-approval', 'connected-after-merge', 'connect-asked-twice',
  'merge-no-approval', 'merge-ci-not-green', 'merge-upstream-unmerged', 'merge-order', 'question-unanswered', 'mail-read-by-other',
] as const;

const judgeSameSha = (a: unknown, b: unknown): boolean => typeof a === 'string' && typeof b === 'string' && (a.startsWith(b) || b.startsWith(a));

export function judgeRun(i: JudgeInput): Violation[] {
  const out: Violation[] = [];
  const v = (rule: string, detail: string, ticket?: string): void => { out.push({ rule, detail, ...(ticket ? { ticket } : {}) }); };
  const idx = (e: Ev): number => i.events.indexOf(e);
  const merges = i.events.filter((e) => e.ev === 'merge');
  const mergeOf = (tk: string): Ev | undefined => merges.find((e) => e.ticket === tk);

  // decision 3 — every implementer started (recorded) and coding on the frozen names while its upstream is unmerged
  const first = merges[0];
  if (first) for (const tk of i.tickets) {
    const at = i.startAt[tk];
    if (at === null || at === undefined || at > first.t) v('start-all-before-first-merge', `${tk} had no recorded start before the first merge (${at === null || at === undefined ? 'never' : `${at - first.t} ms after`})`, tk);
  }
  for (const tk of i.tickets) for (const up of i.deps[tk] ?? []) {
    const m = mergeOf(up);
    if (!m || i.events.some((e) => e.ev === 'ask' && e.ticket === tk && e.kind === 'no-safe-option')) continue; // a ticket that declared "no safe option" is parked, not waiting
    const coded = i.events.some((e) => e.ev === 'code' && e.ticket === tk && idx(e) < idx(m) && e.t <= m.t);
    if (!coded) v('implementer-waited', `${tk} wrote no code before its upstream ${up} merged`, tk);
  }
  // decision 12 — never a second agent / PR for a ticket
  for (const tk of i.tickets) {
    const spawns = i.events.filter((e) => e.ev === 'spawn' && e.ticket === tk).length;
    const died = i.events.filter((e) => e.ev === 'impl-died' && e.ticket === tk).length; // a DEAD implementer is replaced (decision 12 forbids a second agent beside a live one, not after a death)
    if (spawns > 1 + died) v('duplicate-agent', `${tk}: ${spawns} implementers were started (${died} died)`, tk);
    const prs = i.events.filter((e) => e.ev === 'pr-open' && e.ticket === tk).length;
    if (prs > 1) v('duplicate-agent', `${tk}: ${prs} pull requests were opened`, tk);
  }
  // decision 4 — asked to connect once the upstream's reviewer approved it, never before, never after the merge
  for (const e of i.events.filter((x) => x.ev === 'connect-ask')) {
    const up = String(e.up);
    const approved = i.events.some((x) => x.ev === 'review-record' && x.ticket === up && x.verdict === 'approve' && judgeSameSha(x.head, e.head) && idx(x) < idx(e));
    if (!approved) v('connected-before-approval', `${e.ticket} was asked to connect to ${up} at ${String(e.head).slice(0, 12)} before any approval of it`, e.ticket);
    const m = mergeOf(up);
    if (m && idx(m) < idx(e)) v('connected-after-merge', `${e.ticket} was asked to connect to ${up} after ${up} merged`, e.ticket);
  }
  const askKeys = new Set<string>();
  for (const e of i.events.filter((x) => x.ev === 'connect-ask')) {
    const k = `${String(e.ticket)}|${String(e.up)}|${String(e.head)}`;
    if (askKeys.has(k)) v('connect-asked-twice', `${e.ticket} was asked twice to connect to ${String(e.up)} at ${String(e.head).slice(0, 12)}`, e.ticket);
    askKeys.add(k);
  }
  // decision 10 — merge = recorded approval on the head + green CI on the head + upstreams merged, in readiness order
  const readiness: Array<{ tk: string; at: number; i: number }> = [];
  for (const m of merges) {
    const tk = String(m.ticket);
    const records = i.events.filter((x) => x.ev === 'review-record' && x.ticket === tk && (judgeSameSha(x.head, m.head) || (typeof x.tree === 'string' && x.tree === m.tree)) && idx(x) < idx(m)); // #512: a verdict covers a head by sha OR by git tree
    const approvals = records.length && records[records.length - 1].verdict === 'approve' ? records.filter((x) => x.verdict === 'approve') : []; // the LAST record on this head decides: a later changes-requested voids an earlier approve
    if (!approvals.length) v('merge-no-approval', `${tk} merged at ${String(m.head).slice(0, 12)} with no recorded approval on that head`, tk);
    if (m.ci !== 'green') v('merge-ci-not-green', `${tk} merged with its CI at "${String(m.ci)}"`, tk);
    for (const up of i.deps[tk] ?? []) { const um = mergeOf(up); if (!um || idx(um) > idx(m)) v('merge-upstream-unmerged', `${tk} merged before its upstream ${up}`, tk); }
    const ci = [...i.events].reverse().find((x) => x.ev === 'ci-start' && x.ticket === tk && judgeSameSha(x.head, m.head));
    const upAt = Math.max(0, ...(i.deps[tk] ?? []).map((up) => mergeOf(up)?.t ?? 0));
    readiness.push({ tk, at: Math.max(approvals.length ? Math.min(...approvals.map((a) => a.t)) : 0, typeof ci?.doneAt === 'number' ? ci.doneAt : 0, upAt), i: idx(m) });
  }
  for (let a = 0; a < readiness.length; a++) for (let b = a + 1; b < readiness.length; b++) {
    if (readiness[b].at < readiness[a].at) v('merge-order', `${readiness[b].tk} was ready ${readiness[a].at - readiness[b].at} ms before ${readiness[a].tk} but merged after it`, readiness[b].tk);
  }
  // decision 5 — a question gets the fixed answer
  for (const e of i.events.filter((x) => x.ev === 'ask' && x.kind === 'question')) {
    const ok = i.events.some((x) => x.ev === 'send' && x.kind === 'answer' && x.to === e.ws && x.text === FIXED_ANSWER && idx(x) > idx(e));
    if (!ok) v('question-unanswered', `${e.ticket}'s question never got the fixed answer`, e.ticket);
  }
  // the loop is the only reader of the run's mail
  for (const e of i.events.filter((x) => x.ev === 'mail-read' && x.reader !== 'loop')) v('mail-read-by-other', `message #${String(e.seq)} (${String(e.kind)}) was read by ${String(e.reader)}`, e.ticket);
  return out;
}
