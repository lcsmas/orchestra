// #605 (ledger #613, FROZEN NAMES v1) — the three ports of the Boucle: the fleet (agents + the run's mail), the forge (pull requests + CI) and git. Types only: `runLoop` (fanout-loop.ts) never touches the world except through them,
// so the same loop runs on the dummy fleet (fanout-loop-dummy.ts) and, later, on the real one.
import type { StartResult } from './fanout-start.ts';

/** One message of the run's mail. `ticket` = the ticket the host could attribute it to (null = unknown: the loop then maps the sender through the state). */
export interface LoopMail { seq: number; kind: string; sender: string; ticket: string | null; body: string }

export interface FleetPort {
  /** The shipped `startRun` WITH `loop: true` (the briefs carry the loop section whether or not the plan came from #604): one implementer per ticket that has none live. A start held by Admission comes back in `waiting` — a wait, never a fault. */
  start(): Promise<StartResult>;
  live(ws: string): boolean;
  /** idle-rule — ms since the agent's session went idle / last wrote (the host's idle clock); null = running, or unknown. Absent = unknown for every agent: the idle rule (`fanout-loop-idle.ts`) never fires. */
  idleFor?(ws: string): number | null;
  /** Start a turn of an agent with `text` (the loop's ask to connect to an upstream). */
  wake(ws: string, text: string): Promise<void>;
  /** Mail to an agent (`answer` = the fixed answer to a question). */
  send(to: string, text: string, kind: 'status' | 'answer'): Promise<void>;
  /** The run's unread mail. The loop is the ONLY reader (one call per pass, in `stepMail`). */
  mail(): Promise<LoopMail[]>;
  /** MAJOR-1 (review 605 r1): `mail()` leaves a message unread until it is acked — the loop acks `upToSeq` (inclusive) only AFTER the batch is processed, so a kill mid-batch loses nothing. */
  ack(upToSeq: number): Promise<void>;
  /** The shipped `review` verb's host op: spawn the ticket's reviewer on `head`, or wake the live one on a new head, or replace a dead one; a no-op when it is already briefed on this head. */
  spawnReviewer(ticket: string, head: string): Promise<{ id: string }>;
  costOf(ticket: string): Promise<{ tokens: number } | null>;
  /** The HOST's pause of this run (hard or douce, an ancestor's included), or null = not paused. Absent = never paused. While it lasts every member is frozen (turns interrupted, tool trees killed, messages parked), so the loop acts on nothing: no stall clock, no order counted, no decision, no replacement, no spawn. A failed read THROWS (unknown is never "not paused"). */
  runPause?(): Promise<{ by: string | null; since: number; resuming: boolean } | null>;
  /** #628 — end the ticket's implementer ON PURPOSE (its branch stays): the next `start()` puts a fresh one on the same branch. */
  replace(ticket: string): Promise<void>;
  /** idle-rule — end the ticket's recorded REVIEWER on purpose (a silent one that is alive): the next `spawnReviewer` finds it gone and replaces it, as for a dead one. Absent = a port that cannot. */
  replaceReviewer?(ticket: string): Promise<void>;
}

export interface ForgeCheck { name: string; status: 'pending' | 'green' | 'red'; /** Interface log v1.1: MUST change on a re-run (#607's one-re-run-per-ticket rule reads it) */ jobId?: string; /** MAJOR-2: job step count when the forge knows it; 0 = a green that ran nothing (refused), absent = unknown (refused too: nothing proves it ran) */ steps?: number; logExtract?: string; /** additive: ISO time the check reached its status (the loop's readiness order reads it) */ at?: string }

export interface ForgePort {
  /** Idempotent per branch: a second call for the same branch answers the same number. */
  openPr(i: { branch: string; base: string; title: string }): Promise<{ n: number }>;
  /** `mergeable` = GitHub's word (UNKNOWN while it computes). Absent = a port that cannot tell (read as MERGEABLE); a CONFLICTING PR gets no merge ref, so NO Actions run starts on its head (#689). */
  prState(n: number): Promise<{ state: 'open' | 'merged' | 'closed'; head: string; mergeable?: 'MERGEABLE' | 'CONFLICTING' | 'UNKNOWN' }>;
  checks(n: number, head: string): Promise<ForgeCheck[]>;
  rerun(n: number, names: string[]): Promise<void>;
  /** A MERGE COMMIT bound to `matchHead` (refused with `reason: 'head-moved'` when the PR head is another). */
  merge(n: number, matchHead: string, method: 'merge' | 'squash' | 'rebase'): Promise<{ ok: boolean; reason?: string; detail?: string }>;
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
  /** #683 — the remote branch that is `branch` under other separators (`impl/X` for `impl-X`), null = none. Absent = no adoption (a port that cannot list the remote). */
  twin?(branch: string): Promise<string | null>;
}
