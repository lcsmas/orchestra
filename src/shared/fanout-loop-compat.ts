// #605 (ledger #613, FROZEN NAMES v1) — the #603 (state) and #604 (plan) names the loop builds on while those branches are unmerged. SAME names and signatures as the freeze; the fields the freeze puts in `state.json`
// (`parked`, `choices`, `pause`, `rounds`, `loopPlan`) live in a sidecar `<run>/loop.json` here, because `parseState` refuses unknown fields. When #603/#604 land: delete this file, import the same names from
// fanout-state.ts / fanout-plan.ts, and `readLoopState` / `updateLoopState` become `readState` / `updateState` (grep `fanout-loop-compat`).
import fs from 'node:fs';
import path from 'node:path';
import { applyTicketPatch, readState, SeatRefusal, setPlan, sha256Hex, stateFile, updateState, type FanoutState } from './fanout-state.ts';

export const PARK_CAUSES = ['question', 'situation', 'ci', 'upstream'] as const;
export type ParkCause = (typeof PARK_CAUSES)[number];
export interface ParkInfo { cause: ParkCause; reason: string; at: string; blockedBy?: string }
export interface Choice { n: number; ticket: string; question: string; rule: 'reversible-default' | 'no-safe-option'; answer: string; at: string }
export interface PauseInfo { at: string; reason: string; check: string | null; prs: number[] }
export interface LoopSide {
  parked: Record<string, ParkInfo>;
  rounds: Record<string, Array<{ n: number; fingerprint: string; at: string }>>;
  choices: Choice[];
  pause: PauseInfo | null;
  /** #605-only (not in the freeze): upstream → the head the author was asked to connect to, per dependent. Asked once per (dependent, upstream, head). */
  asked: Record<string, Record<string, string>>;
  /** #605-only: dependent → upstream → the IMPLEMENTER workspace id the ask went to (a replaced author is asked again). */
  askedTo: Record<string, Record<string, string>>;
  /** #605-only: tickets whose implementer said it nominated, read from the mail but not yet turned into a head in the state (mail is consumed on read: this makes the hand-off from `mail` to `nominations` survive a kill). */
  signalled: Record<string, true>;
  /** #605-only: mail seq → `listed` (a question's choice is written, its answer not yet sent) | `done`. Pruned past each ack. */
  handled: Record<string, 'listed' | 'done'>;
  /** #605-only: head → the check names the last poll saw (the "identical on two polls" guard of decideDelivery). */
  checksSeen: Record<string, string>;
  /** #605-only: tickets whose start Admission held (reported once by `fleet.start()`); busy for the stall clock until the ticket shows a head. */
  held: Record<string, true>;
  /** #605-only: wait key (`held:T`, `review:T:head`, `ci:T:head`) → when the loop first waited on it; a wait counts as progress only for a bounded time. */
  busySince: Record<string, string>;
}
/** `FanoutState` + the sidecar. The frozen helpers below take and return this. */
export type LoopState = FanoutState & { loop: LoopSide };

const emptySide = (): LoopSide => ({ parked: {}, rounds: {}, choices: [], pause: null, asked: {}, askedTo: {}, signalled: {}, handled: {}, checksSeen: {}, held: {}, busySince: {} });
const sideFile = (home: string, run: string): string => path.join(path.dirname(stateFile(home, run)), 'loop.json');

function readSide(file: string): LoopSide {
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Partial<LoopSide>;
    return { ...emptySide(), ...raw };
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === 'ENOENT') return emptySide();
    throw new SeatRefusal('loop-side-unreadable', `${file} is not readable JSON: refusing to run on a half-known state`);
  }
}
function writeSide(file: string, side: LoopSide): void {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(tmp, `${JSON.stringify(side, null, 2)}\n`, { mode: 0o600 });
  fs.renameSync(tmp, file);
}
const strip = (s: LoopState): FanoutState => { const { loop: _l, ...rest } = s; return rest; };

export function readLoopState(home: string, run: string): LoopState | null {
  const st = readState(stateFile(home, run));
  return st ? { ...st, loop: readSide(sideFile(home, run)) } : null;
}
/** Read-modify-write of the state AND its sidecar under the state's lock. `mutate(null)` = no state yet. */
export function updateLoopState(home: string, run: string, mutate: (cur: LoopState | null) => LoopState): LoopState {
  let out!: LoopState;
  updateState(stateFile(home, run), (cur) => {
    const next = mutate(cur ? { ...cur, loop: readSide(sideFile(home, run)) } : null);
    writeSide(sideFile(home, run), next.loop);
    out = next;
    return strip(next);
  });
  return out;
}
export const withLoop = (s: FanoutState, loop: LoopSide = emptySide()): LoopState => ({ ...s, loop });

// ── #603 ─────────────────────────────────────────────────────────────────────────────────────────────────────
export const parkedTickets = (s: LoopState): Array<{ ticket: string } & ParkInfo> => Object.entries(s.loop.parked).map(([ticket, p]) => ({ ticket, ...p }));
export const pausedOf = (s: LoopState): PauseInfo | null => s.loop.pause;

/** Tickets that depend on `id`, directly or not (never `id` itself). */
function dependentsOf(s: FanoutState, id: string): string[] {
  const out = new Set<string>();
  const visit = (x: string): void => { for (const [k, t] of Object.entries(s.tickets)) if (t.dependsOn.includes(x) && !out.has(k)) { out.add(k); visit(k); } };
  visit(id);
  return [...out];
}
/** Park `id` and, transitively, its dependents (cause `upstream`, `blockedBy` = the ticket, reason `blocked by <ticket>`). A merged ticket is never parked; an already parked one keeps its first cause. */
export function parkTicket(s: LoopState, id: string, p: { cause: ParkCause; reason: string }, now: string): LoopState {
  if (!s.tickets[id]) throw new SeatRefusal('park-unknown-ticket', `${id} is not a ticket of run ${s.run}`);
  if (!p.reason.trim()) throw new SeatRefusal('park-no-reason', `parking ${id} needs a reason`);
  if (!(PARK_CAUSES as readonly string[]).includes(p.cause)) throw new SeatRefusal('park-bad-cause', `park cause must be ${PARK_CAUSES.join('|')}`);
  if (s.tickets[id].status === 'merged') throw new SeatRefusal('park-merged', `${id} is merged: it cannot be parked`);
  const parked = { ...s.loop.parked };
  if (!parked[id]) parked[id] = { cause: p.cause, reason: p.reason, at: now };
  for (const d of dependentsOf(s, id)) if (!parked[d] && s.tickets[d].status !== 'merged') parked[d] = { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: id };
  return { ...s, loop: { ...s.loop, parked }, updatedAt: now };
}
export function pauseRun(s: LoopState, p: { reason: string; check: string | null; prs: number[] }, now: string): LoopState {
  if (!p.reason.trim()) throw new SeatRefusal('pause-no-reason', 'a pause needs a reason');
  return { ...s, loop: { ...s.loop, pause: { at: now, reason: p.reason, check: p.check, prs: p.prs } }, updatedAt: now };
}
export const resumeRun = (s: LoopState, now: string): LoopState => ({ ...s, loop: { ...s.loop, pause: null }, updatedAt: now });
export function recordChoice(s: LoopState, e: Omit<Choice, 'n' | 'at'> & Partial<Pick<Choice, 'n' | 'at'>>, now: string): LoopState {
  if (!e.ticket || !e.question.trim() || e.question.length > 2000 || !e.answer.trim() || (e.rule !== 'reversible-default' && e.rule !== 'no-safe-option')) throw new SeatRefusal('choice-bad', 'a choice needs a ticket, a question (≤ 2000 chars), an answer and a rule');
  return { ...s, loop: { ...s.loop, choices: [...s.loop.choices, { n: s.loop.choices.length + 1, ticket: e.ticket, question: e.question, rule: e.rule, answer: e.answer, at: now }] }, updatedAt: now };
}
export const situationFingerprint = (i: { openFindings: string[]; tree: string }): string => sha256Hex(`findings:${[...i.openFindings].sort().join(',')}\ntree:${i.tree}`);
/** `repeat` = the SAME fingerprint is already recorded (its second sighting). */
export function recordRound(s: LoopState, id: string, fp: string, now: string): { state: LoopState; repeat: boolean } {
  const rounds = s.loop.rounds[id] ?? [];
  const repeat = rounds.some((r) => r.fingerprint === fp);
  return { state: { ...s, loop: { ...s.loop, rounds: { ...s.loop.rounds, [id]: [...rounds, { n: rounds.length + 1, fingerprint: fp, at: now }] } }, updatedAt: now }, repeat };
}

// ── #604 ─────────────────────────────────────────────────────────────────────────────────────────────────────
export interface Plan { version: 1; tickets: Array<{ id: string; title: string; spec: string; dependsOn: string[] }>; interfaces: Record<string, string> }
/** The #604 plan JSON → state. The REAL `parsePlan` / `checkPlan` (refusals) come with #604; this applies a plan the dummy scenario or `--plan` hands over, refusing only what it cannot write. */
export function applyPlan(s: FanoutState, plan: Plan, now: string): FanoutState {
  let st = setPlan(s, plan.tickets.map((t) => t.id), 'declare', now);
  for (const t of plan.tickets) {
    const patch: Record<string, unknown> = { dependsOn: t.dependsOn, spec: t.spec };
    if (plan.interfaces[t.id]) patch.interface = plan.interfaces[t.id];
    st = applyTicketPatch(st, t.id, patch, now);
  }
  return st;
}
