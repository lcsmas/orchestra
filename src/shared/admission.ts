// Admission — the PURE half (#286, wave G ledger #295, epic #284; CONTEXT.md "Admission"; contract = ledger FI-2).
// Impure half (queue, release loop, timers): src/main/admission.ts. The guard that says "held" is src/shared/memory-guard.ts —
// nothing here decides memory, only WHICH starts wait and in WHAT ORDER they go out.
//
// An AUTOMATIC start of a FLEET MEMBER (a workspace with a coordinator) is held while the guard holds Admission; a human-initiated start
// and a turn sent to an already-running member are never a held start. Held starts are released coordinators first, then in arrival
// order, ONE at a time, each release preceded by a fresh reading (`mayReleaseOneStart`). Kinds held here: spawn (its brief stays owed),
// restart, and (#287) WAKE — every automatic start of a SLEEPING fleet member (bus réveil, parked-prompt flush, usage-limit auto-resume,
// a peer message to a stopped member, a view-open recovery): its durable pending state is untouched, the site skips it, the queue releases it.

import type { MemoryGuardSnapshot } from './memory-guard.ts';

export type HeldStartKind = 'spawn' | 'restart' | 'wake';

/** A held SPAWN/RESTART is a real start and subsumes a held WAKE of the same member (the start brings the member up; whatever the wake was
 *  for is then delivered to a RUNNING member as a plain turn): when two requests meet in one slot the higher rank wins. */
export function kindRank(kind: HeldStartKind): number {
  return kind === 'wake' ? 1 : 2;
}
export type StartOrigin = 'auto' | 'human';

export interface HeldStart {
  wsId: string;
  kind: HeldStartKind;
  /** Arrival order (1, 2, 3…) — the tie-break after "coordinators first". */
  seq: number;
  /** Epoch ms the start was first held. */
  since: number;
  /** The workspace itself coordinates (sub-OPS / orchestrator): released before any worker. */
  coordinator: boolean;
}

/** A person (composer, toolbar Restart, Send now…) started this — never a held start. Kept as a helper so src/main carries no new literal `'human'`
 *  (pause-gates-wiring's ENUMERATION counts those: a new origin-`human` PASS site is a new pause bypass; this site only READS the origin). */
export function isHumanOrigin(origin: StartOrigin): boolean {
  return origin === 'human';
}

/** A fleet member = a workspace with a coordinator (a parent). A top-level / detached workspace is never held. */
export function isFleetMember(ws: { parentId?: string } | null | undefined): boolean {
  return !!ws && typeof ws.parentId === 'string' && ws.parentId.length > 0;
}

/** Must this start wait? Only an AUTOMATIC start of a fleet member, and only while memory holds Admission — or while earlier held starts are
 *  still queued (a newcomer joins the line, it never jumps it: arrival order). A human act and a non-member always pass. */
export function mustHoldStart(args: { ws: { parentId?: string } | null | undefined; origin: StartOrigin; holding: boolean; queued: boolean }): boolean {
  return args.origin === 'auto' && isFleetMember(args.ws) && (args.holding || args.queued);
}

/** The next held start to release: coordinators first, then arrival order. */
export function nextToRelease(held: readonly HeldStart[]): HeldStart | null {
  let best: HeldStart | null = null;
  for (const h of held) {
    if (best === null || (h.coordinator && !best.coordinator) || (h.coordinator === best.coordinator && h.seq < best.seq)) best = h;
  }
  return best;
}

export type ReleaseStep =
  | { action: 'release'; entry: HeldStart }
  | { action: 'wait'; reason: 'empty' | 'unmeasured' | 'memory' };

/** One release decision from a FRESH snapshot. The toggle OFF holds nothing, so queued starts go out at once; otherwise a release needs
 *  `mayReleaseOneStart` (false under a dead meter — never release blind — and below threshold + margin). */
export function planRelease(held: readonly HeldStart[], snap: Pick<MemoryGuardSnapshot, 'admissionEnabled' | 'measured' | 'mayReleaseOneStart'>): ReleaseStep {
  const entry = nextToRelease(held);
  if (entry === null) return { action: 'wait', reason: 'empty' };
  if (!snap.admissionEnabled) return { action: 'release', entry };
  if (!snap.measured) return { action: 'wait', reason: 'unmeasured' };
  if (!snap.mayReleaseOneStart) return { action: 'wait', reason: 'memory' };
  return { action: 'release', entry };
}

/** What the OPS reads in `orchestra peers` / the spawn + restart reply: one phrase, with since-when. */
export function heldPhrase(kind: HeldStartKind, sinceMs: number): string {
  const what = kind === 'wake' ? 'it is woken' : 'it starts';
  return `${kind} held for memory since ${new Date(sinceMs).toISOString()} — ${what} when memory recovers (Admission)`;
}

/** What the COORDINATOR reads when a held start that was released then did not start: the "accepted, held" reply promised it would, so a failure
 *  must not stay a log line only (review F4). `reason` = the failed release's error, or the timeout. */
export function releaseFailureBody(kind: HeldStartKind, wsId: string, sinceMs: number, reason: string): string {
  return (
    `Admission: the ${kind} of ${wsId} that was HELD for memory since ${new Date(sinceMs).toISOString()} was released but did NOT start — ${reason}. ` +
    `It is not queued any more: retry it with \`orchestra restart ${wsId}\`.`
  );
}

/** What the COORDINATOR reads when a released start has not CONFIRMED within the bound: it may well still be starting (a slow first turn), so the text says
 *  "check first" — never "did NOT start" (review r2 T1: a >90 s success used to be reported as a failure and the coordinator told to retry a live start). */
export function releaseTimeoutBody(kind: HeldStartKind, wsId: string, sinceMs: number, seconds: number): string {
  return (
    `Admission: the ${kind} of ${wsId} that was HELD for memory since ${new Date(sinceMs).toISOString()} was released but is not CONFIRMED within ${seconds} s — ` +
    `it may still be starting. Check \`orchestra peers\` first; only if ${wsId} is still stopped retry it with \`orchestra restart ${wsId}\`.`
  );
}

/** What a failed release does with its report (pure so every branch has a test — seat 2 F2): tell the live coordinator over the bus, or say why not. */
export type AdmissionReportDecision = { action: 'send' } | { action: 'skip'; why: 'no-coordinator' | 'no-bus' | 'switch-off' };
export function decideAdmissionReport(a: { hasMember: boolean; coordinatorLive: boolean; hasBus: boolean; switchOn: boolean }): AdmissionReportDecision {
  if (!a.hasMember || !a.coordinatorLive) return { action: 'skip', why: 'no-coordinator' };
  if (!a.hasBus) return { action: 'skip', why: 'no-bus' };
  if (!a.switchOn) return { action: 'skip', why: 'switch-off' };
  return { action: 'send' };
}

/** The label a held start carries in `bus-status` (seat 2 F3): the workspace's name, else its branch, else its id (a deleted workspace). */
export function heldStartLabel(w: { name?: string; branch?: string } | null | undefined, wsId: string): string {
  return w ? (w.name ?? w.branch ?? wsId) : wsId;
}

/** The line `orchestra restart <id>` prints when the restart was ACCEPTED but HELD for low memory (seat 2 F1: without it a held restart printed the normal
 *  "Restarted … conversation preserved" line). `note` is `heldPhrase('restart', since)` from the reply. */
export function formatRestartHeldReply(target: string, note: string): string {
  return `Restart of ${target} accepted — ${note}`;
}

/** A row of `/busStatus` `heldStarts`. */
export interface HeldStartView {
  wsId: string;
  label: string;
  kind: HeldStartKind;
  since: number;
  coordinator: boolean;
  seq: number;
}

/** The `held starts:` line of `orchestra bus-status`; null when nothing is held (output unchanged then). Release order, oldest first. */
export function formatHeldStartsLine(rows: readonly HeldStartView[]): string | null {
  if (rows.length === 0) return null;
  const order = [...rows].sort((a, b) => Number(b.coordinator) - Number(a.coordinator) || a.seq - b.seq);
  const items = order.map((r) => `${r.label} (${r.kind}${r.coordinator ? ', coordinator' : ''}, since ${new Date(r.since).toISOString()})`);
  return `held starts: ${rows.length} held for memory, release order — ${items.join(' → ')}`;
}
