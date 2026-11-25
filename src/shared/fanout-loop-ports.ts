// #605 (ledger #613, FROZEN NAMES v1) — the three ports of the Boucle: the fleet (agents + the run's mail), the forge (pull requests + CI) and git. Types only: `runLoop` (fanout-loop.ts) never touches the world except through them,
// so the same loop runs on the dummy fleet (fanout-loop-dummy.ts) and, later, on the real one.
import type { StartResult } from './fanout-start.ts';

/** One message of the run's mail. `ticket` = the ticket the host could attribute it to (null = unknown: the loop then maps the sender through the state). */
export interface LoopMail { seq: number; kind: string; sender: string; ticket: string | null; body: string }

export interface FleetPort {
  /** The shipped `startRun`: one implementer per ticket that has none live. A start held by Admission comes back in `waiting` — a wait, never a fault. */
  start(): Promise<StartResult>;
  live(ws: string): boolean;
  /** Start a turn of an agent with `text` (the loop's ask to connect to an upstream). */
  wake(ws: string, text: string): Promise<void>;
  /** Mail to an agent (`answer` = the fixed answer to a question). */
  send(to: string, text: string, kind: 'status' | 'answer'): Promise<void>;
  /** The run's unread mail. The loop is the ONLY reader (one call per pass, in `stepMail`). */
  mail(): Promise<LoopMail[]>;
  /** The shipped `review` verb's host op: spawn the ticket's reviewer on `head`, or wake the live one on a new head, or replace a dead one; a no-op when it is already briefed on this head. */
  spawnReviewer(ticket: string, head: string): Promise<{ id: string }>;
  costOf(ticket: string): Promise<{ tokens: number } | null>;
}

export interface ForgeCheck { name: string; status: 'pending' | 'green' | 'red'; /** Interface log v1.1: MUST change on a re-run (#607's one-re-run-per-ticket rule reads it) */ jobId?: string; logExtract?: string; /** additive: ISO time the check reached its status (the loop's readiness order reads it) */ at?: string }

export interface ForgePort {
  /** Idempotent per branch: a second call for the same branch answers the same number. */
  openPr(i: { branch: string; base: string; title: string }): Promise<{ n: number }>;
  prState(n: number): Promise<{ state: 'open' | 'merged' | 'closed'; head: string }>;
  checks(n: number, head: string): Promise<ForgeCheck[]>;
  rerun(n: number, names: string[]): Promise<void>;
  /** A MERGE COMMIT bound to `matchHead` (refused with `reason: 'head-moved'` when the PR head is another). */
  merge(n: number, matchHead: string): Promise<{ ok: boolean; reason?: string }>;
  close(n: number): Promise<void>;
}

export interface GitPort {
  head(branch: string): Promise<string | null>;
  tree(sha: string): Promise<string | null>;
  /** Is `branch` (a ref or a sha) an ancestor of `base` — i.e. contained in it. */
  isMerged(branch: string, base: string): Promise<boolean>;
  /** Interface log v1.1 (#607's start check): a branch holding nothing over `base`. */
  emptyBranch(branch: string, base: string): Promise<{ head: string }>;
  deleteBranch(branch: string): Promise<void>;
}
