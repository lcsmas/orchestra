// Admission — the PURE half (#286, wave G ledger #295, epic #284; CONTEXT.md "Admission"; contract = ledger FI-2).
// Impure half (queue, release loop, timers): src/main/admission.ts. The guard that says "held" is src/shared/memory-guard.ts —
// nothing here decides memory, only WHICH starts wait and in WHAT ORDER they go out.
//
// An AUTOMATIC start of a FLEET MEMBER (a workspace with a coordinator) is held while the guard holds Admission; a human-initiated start
// and a turn sent to an already-running member are never a held start. Held starts are released coordinators first, then in arrival
// order, ONE at a time, each release preceded by a fresh reading (`mayReleaseOneStart`). Kinds held here: spawn (its brief stays owed)
// and restart. A réveil (bus wake) is NOT held by this track — it stays pending with a "held for memory" reason in #287.

import type { MemoryGuardSnapshot } from './memory-guard.ts';

export type HeldStartKind = 'spawn' | 'restart';
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
  return `${kind} held for memory since ${new Date(sinceMs).toISOString()} — it starts when memory recovers (Admission)`;
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
