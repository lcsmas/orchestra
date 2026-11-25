// #607 — STUBS of the frozen names of ledger #613 (FROZEN NAMES v1) that live in #603 / #605 and are not on this branch yet.
// ONE module so the swap is one edit: when #603 (fanout-state.ts) and #605 (fanout-loop-ports.ts) are connected, delete this file
// and point the imports of fanout-loop-ci.ts at them. Everything here copies the frozen text; nothing is invented except where marked.
import crypto from 'node:crypto';
import type { FanoutState, TicketState } from './fanout-state.ts';

// ── #605 ports (types only, verbatim from the ledger) ───────────────────────────────────────────────────────────
export interface LoopMail { seq: number; kind: string; sender: string; ticket: string | null; body: string }
export interface FleetPort {
  start(): Promise<unknown>;
  live(ws: string): boolean;
  wake(ws: string, text: string): Promise<void>;
  send(to: string, text: string, kind: 'status' | 'answer'): Promise<void>;
  mail(): Promise<LoopMail[]>;
  spawnReviewer(ticket: string, head: string): Promise<{ id: string }>;
  costOf(ticket: string): Promise<{ tokens: number } | null>;
}
export interface CheckInfo { name: string; status: 'pending' | 'green' | 'red'; jobId?: string; logExtract?: string }
export interface ForgePort {
  openPr(i: { branch: string; base: string; title: string }): Promise<{ n: number }>;
  prState(n: number): Promise<{ state: 'open' | 'merged' | 'closed'; head: string }>;
  checks(n: number, head: string): Promise<CheckInfo[]>;
  rerun(n: number, names: string[]): Promise<void>;
  merge(n: number, matchHead: string): Promise<{ ok: boolean; reason?: string }>;
  close(n: number): Promise<void>;
}
export interface GitPort {
  head(branch: string): Promise<string | null>;
  tree(sha: string): Promise<string | null>;
  isMerged(branch: string, base: string): Promise<boolean>;
}

// ── #603 state additions (frozen text) ──────────────────────────────────────────────────────────────────────────
export const PARK_CAUSES = ['question', 'situation', 'ci', 'upstream'] as const;
export type ParkCause = (typeof PARK_CAUSES)[number];
export interface Parked { cause: ParkCause; reason: string; at: string; blockedBy?: string }
export interface PauseInfo { at: string; reason: string; check: string | null; prs: number[] }
export type CiTicket = Omit<TicketState, 'status'> & { status: TicketState['status'] | 'parked'; parked?: Parked; rounds?: Array<{ n: number; fingerprint: string; at: string }> };
export type CiState = Omit<FanoutState, 'tickets'> & { tickets: Record<string, CiTicket>; pause?: PauseInfo };

export function situationFingerprint(i: { openFindings: string[]; tree: string }): string {
  return crypto.createHash('sha256').update(`findings:${[...i.openFindings].sort().join(',')}\ntree:${i.tree}`).digest('hex');
}
export function recordRound(state: CiState, id: string, fp: string, now: string): { state: CiState; repeat: boolean } {
  const t = state.tickets[id];
  const rounds = t.rounds ?? [];
  const repeat = rounds.some((r) => r.fingerprint === fp);
  return { state: { ...state, tickets: { ...state.tickets, [id]: { ...t, rounds: [...rounds, { n: rounds.length + 1, fingerprint: fp, at: now }] } } }, repeat };
}
/** Parks `id` and every transitive dependent (cause `upstream`, `blockedBy: id`). A merged ticket is refused (`park-merged`). */
export function parkTicket(state: CiState, id: string, p: { cause: ParkCause; reason: string }, now: string): CiState {
  const t = state.tickets[id];
  if (!t) throw new Error(`[park-unknown-ticket] ${id}`);
  if (t.status === 'merged') throw new Error(`[park-merged] ${id}`);
  const tickets = { ...state.tickets, [id]: { ...t, status: 'parked' as const, parked: { cause: p.cause, reason: p.reason, at: now } } };
  const down = new Set<string>();
  const walk = (up: string): void => { for (const [k, v] of Object.entries(state.tickets)) if (v.dependsOn.includes(up) && !down.has(k)) { down.add(k); walk(k); } };
  walk(id);
  for (const k of down) {
    const d = tickets[k];
    if (d.status === 'merged' || d.parked) continue;
    tickets[k] = { ...d, status: 'parked', parked: { cause: 'upstream', reason: `blocked by ${id}`, at: now, blockedBy: id } };
  }
  return { ...state, tickets };
}
export const pausedOf = (state: CiState): PauseInfo | null => state.pause ?? null;
export function pauseRun(state: CiState, p: { reason: string; check: string | null; prs: number[] }, now: string): CiState {
  if (!p.reason.trim()) throw new Error('[pause-no-reason]');
  return { ...state, pause: { at: now, reason: p.reason, check: p.check, prs: p.prs } };
}
export function resumeRun(state: CiState, now: string): CiState {
  const { pause: _p, ...rest } = state;
  return { ...rest, updatedAt: now };
}
