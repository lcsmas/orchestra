// #606 (spec #601 stories 12–15, decisions 6–7) — `stepCorrections` of the Boucle (`orchestra fanout run`): findings to the SAME author in ONE batch, the SAME reviewer on the new head,
// a fresh author only when the author is dead, and the situation (open findings + candidate tree) seen twice parks the ticket. No counters, nothing in memory between passes: the state file is the memory.
// Built on the FROZEN NAMES v1 of ledger #613 (LoopDeps / FleetPort / GitPort, #603's rounds + parkTicket): the narrow `CorrectionsDeps` below is a structural SUBSET of LoopDeps, so the real LoopCtx assigns to it.
import crypto from 'node:crypto';
import { countsThrough, reviewOn } from './fanout-record.ts';
import {
  blockingMinors, readState, sameContent, stateFile, switchesOf, updateState,
  type FanoutState, type FindingRecord, type ReviewEntry, type TicketState,
} from './fanout-state.ts';

// ── #603 names (frozen v1). STUBS with the frozen semantics, local until #603 merges: then DELETE this block and import them from ./fanout-state.ts. ────────────────────────────────────
type Round = { n: number; fingerprint: string; at: string };
type ParkCause = 'question' | 'situation' | 'ci' | 'upstream';
type T3 = TicketState & { rounds?: Round[]; parked?: { cause: ParkCause; reason: string; at: string; blockedBy?: string } };
/** sha256 hex of `"findings:" + sorted ids joined "," + "\ntree:" + tree` (frozen). */
export function situationFingerprint(i: { openFindings: string[]; tree: string }): string {
  return crypto.createHash('sha256').update(`findings:${[...i.openFindings].sort().join(',')}\ntree:${i.tree}`).digest('hex');
}
/** `repeat` = the SAME fingerprint is already in `rounds` (second sighting). */
export function recordRound(state: FanoutState, id: string, fp: string, now: string): { state: FanoutState; repeat: boolean } {
  const t = state.tickets[id] as T3;
  const rounds = t.rounds ?? [];
  const repeat = rounds.some((r) => r.fingerprint === fp);
  const nt: T3 = { ...t, rounds: [...rounds, { n: rounds.length + 1, fingerprint: fp, at: now }], updatedAt: now };
  return { state: { ...state, tickets: { ...state.tickets, [id]: nt }, updatedAt: now }, repeat };
}
/** Parks `id` and, transitively, its dependents (`cause: 'upstream'`, `blockedBy`). */
export function parkTicket(state: FanoutState, id: string, p: { cause: ParkCause; reason: string }, now: string): FanoutState {
  const tickets = { ...state.tickets };
  const park = (k: string, parked: NonNullable<T3['parked']>): void => { tickets[k] = { ...tickets[k], status: 'parked' as TicketState['status'], parked, updatedAt: now } as T3; };
  park(id, { ...p, at: now });
  for (let grew = true; grew;) {
    grew = false;
    for (const [k, t] of Object.entries(tickets)) {
      if (t.status === 'merged' || (t as T3).parked) continue;
      const up = t.dependsOn.find((d) => (tickets[d] as T3 | undefined)?.parked);
      if (up) { park(k, { cause: 'upstream', reason: `blocked by ${up}`, blockedBy: up, at: now }); grew = true; }
    }
  }
  return { ...state, tickets, updatedAt: now };
}
// ── end of the #603 block ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────

/** The subset of LoopDeps (ledger #613 FROZEN NAMES v1) this step reads; `home`/`run` locate the state file. */
export interface CorrectionsDeps {
  home: string;
  run: string;
  now(): string;
  log(line: string): void;
  fleet: {
    live(ws: string): boolean;
    wake(ws: string, text: string): Promise<void>;
    /** the shipped `startRun`: respawns the implementer of a ticket that has none LIVE (never a second one for a live one). */
    start(): Promise<unknown>;
    /** the shipped `review` verb's host op: wakes the SAME live reviewer on a new head, replaces it only when dead, noop when already briefed on the head. */
    spawnReviewer(ticket: string, head: string): Promise<{ id: string }>;
  };
  git: { head(branch: string): Promise<string | null>; tree(sha: string): Promise<string | null> };
}
/** Where the state lives: the file under `home` by default; a test hands an in-memory one. */
export interface CorrectionsStore { read(): FanoutState | null; update(fn: (s: FanoutState) => FanoutState): FanoutState }
export interface CorrectionsCtx { deps: CorrectionsDeps; store?: CorrectionsStore }

export type CorrectionsOutcome =
  | { ticket: string; action: 'sent'; to: string; round: number; findings: string[]; noted: string[]; replaced: boolean }
  | { ticket: string; action: 'parked'; why: 'same-situation' | 'same-tree'; findings: string[] }
  | { ticket: string; action: 'reviewer-woken'; head: string; reviewer: string }
  | { ticket: string; action: 'reviewer-changed'; expected: string; got: string }
  | { ticket: string; action: 'blocked'; why: string };

const short = (s: string): string => s.slice(0, 12);
const isDone = (t: TicketState): boolean => t.status === 'merged' || t.status === 'dropped' || (t.status as string) === 'parked' || !!(t as T3).parked;

export function diskStore(deps: Pick<CorrectionsDeps, 'home' | 'run'>): CorrectionsStore {
  const file = stateFile(deps.home, deps.run);
  return { read: () => readState(file), update: (fn) => updateState(file, (cur) => { if (!cur) throw new Error(`no state for run ${deps.run}`); return fn(cur); }) };
}

/** What the author must fix as of review `r`: the findings still open then, BLOCKING / MAJOR, plus the MINORs the run's `minorPolicy` blocks the merge on (`blockingMinors`: none under legacy / refuse). */
export function mustFixOf(state: FanoutState, ticket: string, r: Pick<ReviewEntry, 'n'>): { fix: string[]; noted: string[] } {
  const t = state.tickets[ticket];
  const open = countsThrough(t, r.n).open;
  const minors = new Set(blockingMinors(state, ticket));
  const fix = open.filter((id) => t.findings[id].severity !== 'MINOR' || minors.has(id));
  return { fix, noted: open.filter((id) => !fix.includes(id)) };
}
/** The reviews that sent the author back: `changes-requested` with something to fix. */
const changingReviews = (state: FanoutState, ticket: string): Array<{ r: ReviewEntry; fix: string[]; noted: string[] }> =>
  (state.tickets[ticket].reviews ?? []).filter((r) => r.verdict === 'changes-requested').map((r) => ({ r, ...mustFixOf(state, ticket, r) })).filter((x) => x.fix.length > 0);

const demoOf = (f: FindingRecord): string => (f.demonstration ? `\n   demonstrated — input: ${f.demonstration.input} | observed: ${f.demonstration.observed} | expected: ${f.demonstration.expected}` : '');
/** ONE message for the whole round (never one per finding); a plain MINOR is not in it. */
export function renderBatch(state: FanoutState, ticket: string, c: { r: ReviewEntry; fix: string[] }, round: number, fresh: boolean): string {
  const t = state.tickets[ticket];
  const lines = c.fix.map((id, i) => { const f = t.findings[id]; return `${i + 1}. ${id} ${f.severity}${f.kind === 'process' ? ' (process: edit the PR body)' : ''} — ${f.text ?? '(the reviewer gave no text: read its review)'}${f.raisedOn ? ` [raised on ${short(f.raisedOn)}]` : ''}${demoOf(f)}`; });
  return [
    `Corrections for ${ticket}, round ${round} — the reviewer read ${short(c.r.head)} and asked for changes.`,
    ...(fresh ? ['You replace the previous author of this ticket: the branch already holds its work — read it before changing anything.'] : []),
    `Fix ALL ${c.fix.length} in ONE push to ${t.branch ?? 'your branch'}, then stop; your reviewer reads the fix. Do not message anyone and do not record a verdict.`,
    ...lines,
  ].join('\n');
}

/** The pass: for every ticket in review that is not merged / dropped / parked — (1) a review that asked for changes and whose round is not recorded yet is a round: the same situation (or the same tree) seen before parks the ticket,
 *  else the batch goes to the live author (a dead one is replaced through `start`, which never doubles a live one) and the round is recorded AFTER the send (a crash resends, never loses); (2) a head the reviewer has not read since the batch
 *  wakes the recorded reviewer (`spawnReviewer`: same one while live). */
export async function runCorrections(ctx: CorrectionsCtx): Promise<CorrectionsOutcome[]> {
  const { deps } = ctx;
  const store = ctx.store ?? diskStore(deps);
  const out: CorrectionsOutcome[] = [];
  const first = store.read();
  if (!first) return out;
  for (const id of Object.keys(first.tickets)) {
    const state = store.read()!;
    const t = state.tickets[id] as T3 | undefined;
    if (!t || isDone(t) || !t.branch || !(t.reviews ?? []).length) continue;
    const head = await deps.git.head(t.branch);
    if (!head) continue;
    const tree = await deps.git.tree(head);
    const changing = changingReviews(state, id);
    const fpOf = (x: (typeof changing)[number]): string => situationFingerprint({ openFindings: x.fix, tree: x.r.tree ?? x.r.head });
    // the round of review n is recorded under n = the review's number (n shared with #607's CI rounds: asked in the report); read from the CURRENT state each time
    const done = (s: FanoutState, x: (typeof changing)[number]): boolean => ((s.tickets[id] as T3).rounds ?? []).some((q) => q.n === x.r.n && q.fingerprint === fpOf(x));
    let cur = state;
    let stop = false;
    for (const x of changing.filter((c) => !done(state, c))) {
      const fp = fpOf(x);
      const seenFp = (cur.tickets[id] as T3).rounds?.some((q) => q.fingerprint === fp) ?? false;
      // a finding id is never reused (`finding-exists`), so an undo cycle shows up as the same CONTENT rejected again: the earlier changing review that read this tree
      const seenTree = !!x.r.tree && changing.some((o) => o.r.n < x.r.n && o.r.tree === x.r.tree);
      const keep = (s: FanoutState): FanoutState => {
        const rr = recordRound(s, id, fp, deps.now());
        const rs = (rr.state.tickets[id] as T3).rounds!;
        return { ...rr.state, tickets: { ...rr.state.tickets, [id]: { ...rr.state.tickets[id], rounds: [...rs.slice(0, -1), { ...rs[rs.length - 1], n: x.r.n }] } as T3 } };
      };
      if (seenFp || seenTree) {
        const why = seenFp ? 'same-situation' : 'same-tree';
        cur = store.update((s) => parkTicket(keep(s), id, { cause: 'situation', reason: `${why === 'same-situation' ? 'the same open findings on the same tree' : 'the same tree again'} (${x.fix.join(', ')} on ${short(x.r.tree ?? x.r.head)}) — seen twice` }, deps.now()));
        deps.log(`corrections: ${id} parked — ${why} (${x.fix.join(', ')})`);
        out.push({ ticket: id, action: 'parked', why, findings: x.fix });
        stop = true;
        break;
      }
      const onCurrent = sameContent(x.r.head, x.r.tree, head, tree);
      if (!onCurrent || x !== changing[changing.length - 1]) { cur = store.update(keep); continue; } // a round already overtaken by a newer head / review: recorded, nothing to send
      const a = await sendBatch(ctx, cur, id, x, ((cur.tickets[id] as T3).rounds?.length ?? 0) + 1);
      if (a.kind === 'blocked') { out.push({ ticket: id, action: 'blocked', why: a.why }); stop = true; break; }
      cur = store.update(keep);
      out.push({ ticket: id, action: 'sent', to: a.to, round: x.r.n, findings: x.fix, noted: x.noted, replaced: a.replaced });
    }
    if (stop) continue;
    // (2) the author pushed: the recorded reviewer reads the fix (host op: same live reviewer, a replacement only for a dead one, noop when already briefed on this head)
    const t2 = store.read()!.tickets[id] as T3;
    const last = changing[changing.length - 1];
    if (last && done(store.read()!, last) && !reviewOn(t2, head, tree) && t2.review?.reviewer?.id) {
      const want = t2.review.reviewer.id;
      const live = deps.fleet.live(want);
      const got = await deps.fleet.spawnReviewer(id, head);
      if (live && got.id !== want) { deps.log(`corrections: ${id} — a second reviewer ${got.id} for the live ${want}: its verdict is not the one that read the findings`); out.push({ ticket: id, action: 'reviewer-changed', expected: want, got: got.id }); continue; }
      out.push({ ticket: id, action: 'reviewer-woken', head, reviewer: got.id });
    }
  }
  return out;
}

async function sendBatch(ctx: CorrectionsCtx, state: FanoutState, id: string, x: { r: ReviewEntry; fix: string[]; noted: string[] }, round: number): Promise<{ kind: 'sent'; to: string; replaced: boolean } | { kind: 'blocked'; why: string }> {
  const { deps } = ctx;
  const store = ctx.store ?? diskStore(deps);
  let author = state.tickets[id].implementer;
  let replaced = false;
  if (!author || !deps.fleet.live(author)) {
    await deps.fleet.start(); // only a ticket with NO live implementer is (re)started there
    const again = store.read()!.tickets[id].implementer;
    if (!again || !deps.fleet.live(again)) { deps.log(`corrections: ${id} — no live author yet (${author ?? 'none recorded'}); the batch waits for the next pass`); return { kind: 'blocked', why: 'no-live-author' }; }
    replaced = again !== author;
    author = again;
  }
  const text = renderBatch(store.read()!, id, x, round, replaced);
  try { await deps.fleet.wake(author, text); } catch (e) { deps.log(`corrections: ${id} — wake of ${author} failed (${(e as Error).message}); retried on the next pass`); return { kind: 'blocked', why: 'wake-failed' }; }
  deps.log(`corrections: ${id} — one batch of ${x.fix.length} to ${author}${x.noted.length ? `; noted, not sent: ${x.noted.join(', ')}` : ''}`);
  return { kind: 'sent', to: author, replaced };
}

/** The named step of `LOOP_STEPS` (ledger #613 FROZEN NAMES v1): `stepCorrections(ctx)`. */
export async function stepCorrections(ctx: CorrectionsCtx): Promise<void> { await runCorrections(ctx); }
