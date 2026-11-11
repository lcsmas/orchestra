// Relance (#427, spec #426) — the effectful half: a level-triggered sweep that reads each fleet member's Reliquats, notices which ENDED, and hands the member ONE Relance turn
// (shared/relance.ts: decision + wording) through the same delivery a Réveil uses — so a member in Veille is brought back, Admission holds the start under low memory, a Pause refuses it.
// It does not look at the bus and does not ack anything: it tells the member WHY it must resume; the member decides what to do.
//
// Everything it reads is injected (roster, census, delivery, clock): `relance-host.ts` wires the store, the kernel-scope census and `sdkStartAndDeliver`; node --test and the
// session-budget rig drive this file as it ships. Not started ⇒ no member ever gets a turn from it (the control arm of the rig).

import { log } from './logger.ts';
import { wasStoppedByHost } from './relance-stopped.ts';
import {
  buildReliquatsEndedRelance,
  decideRelance,
  observeReliquats,
  type RelanceCensus,
  type RelanceMember,
  type RelanceTrack,
} from '../shared/relance.ts';

/** How often the sweep looks. A 15 s grouping window sits on top, so the turn follows the end by ~15-20 s. */
export const RELANCE_SWEEP_MS = 5_000;
/** After a delivery that FAILED (not held), the same member is not tried again for this long. */
export const RELANCE_RETRY_MS = 30_000;
/** One member's delivery (a session start) may take this long before the sweep moves on to the next member; its result is still applied when it lands. */
export const RELANCE_DELIVER_WAIT_MS = 20_000;

export type RelanceDelivery = 'sent' | 'held' | 'failed';

export interface RelanceDeps {
  now(): number;
  /** Every workspace the host knows, as the decision reads it (the host fills the facts; the sweep never reads the store). */
  members(): RelanceMember[];
  /** One member's Reliquats (kernel scope). A throw reads as UNKNOWN. */
  census(wsId: string): RelanceCensus | Promise<RelanceCensus>;
  /** Start / resume the member's session and deliver `text` as its next turn. `held` = Admission is holding the start (low memory): nothing is lost, the host retries. */
  deliver(wsId: string, text: string): Promise<RelanceDelivery>;
  /** How long to wait for ONE delivery before moving on (default RELANCE_DELIVER_WAIT_MS). */
  deliverWaitMs?: number;
}

export interface RelanceCounters {
  /** Relances delivered. */
  fired: number;
  /** Deliveries that failed (retried after RELANCE_RETRY_MS). */
  failed: number;
  /** Deliveries held by Admission. */
  held: number;
  /** Groups of ends dropped by an exclusion (a Relance was not owed). */
  dropped: number;
}

const counters: RelanceCounters = { fired: 0, failed: 0, held: 0, dropped: 0 };
export const relanceCounters = (): RelanceCounters => ({ ...counters });

const tracks = new Map<string, RelanceTrack>();
const retryAt = new Map<string, number>();
const heldLogged = new Set<string>();
/** Members whose delivery is still pending past the wait: not touched again until it lands (a second turn for the same ends would be a duplicate). */
const slow = new Set<string>();
let sweeping = false;
let current: Promise<string[]> | null = null;

/** One pass over every member. Never throws; an overlapping call returns at once. Returns the ids relanced this pass (what the fleet OBSERVES: a turn started or not). */
export async function sweepRelance(deps: RelanceDeps): Promise<string[]> {
  if (sweeping) return [];
  sweeping = true;
  current = runSweep(deps);
  try {
    return await current;
  } finally {
    sweeping = false;
    current = null;
  }
}

async function runSweep(deps: RelanceDeps): Promise<string[]> {
  const fired: string[] = [];
  try {
    const now = deps.now();
    const members = deps.members();
    const ids = new Set(members.map((m) => m.wsId));
    for (const id of [...tracks.keys()]) {
      if (ids.has(id)) continue;
      tracks.delete(id);
      retryAt.delete(id);
      heldLogged.delete(id);
    }
    for (const m of members) {
      try {
        if (slow.has(m.wsId)) continue; // its delivery has not landed yet
        // A member the spec leaves out for good costs nothing: no census, and no baseline to carry (it gets a fresh one if it is ever tasked again).
        if (!m.hasCoordinator || !m.hasTask || m.released) {
          tracks.delete(m.wsId);
          continue;
        }
        let census: RelanceCensus;
        try {
          census = await deps.census(m.wsId);
        } catch (e) {
          log.warn(`relance: census of ${m.wsId} failed — treated as unknown`, e);
          census = 'unknown';
        }
        const track = observeReliquats(tracks.get(m.wsId), census, now, (k) => wasStoppedByHost(k, now));
        const v = decideRelance(m, track, now);
        if (v.kind === 'wait' || v.kind === 'drop') {
          if (v.kind === 'drop' && track.pending.length > 0) {
            counters.dropped++;
            log.info(`relance: ${m.wsId} — ${track.pending.length} end(s) of its Reliquats dropped (${v.why}); no turn`);
          }
          tracks.set(m.wsId, { ...track, pending: v.keep });
          continue;
        }
        if ((retryAt.get(m.wsId) ?? 0) > now) {
          tracks.set(m.wsId, track);
          continue;
        }
        // Mark BEFORE the await (a second pass cannot see these ends again); put them back below if the turn did not go out.
        tracks.set(m.wsId, { ...track, pending: [] });
        const delivery: Promise<RelanceDelivery> = (async () => deps.deliver(m.wsId, buildReliquatsEndedRelance(v.ended, v.running)))().catch((e: unknown) => {
          log.warn(`relance: delivery to ${m.wsId} threw`, e);
          return 'failed' as const;
        });
        const settle = (result: RelanceDelivery): void => {
          if (result === 'sent') {
            counters.fired++;
            heldLogged.delete(m.wsId);
            fired.push(m.wsId);
            log.info(`relance: ${m.wsId} resumed — ${v.ended.length} Reliquat end(s) (${v.ended.map((e) => e.proc.pid).join(',')}), ${v.running.length} still running`);
            return;
          }
          // the turn did not go out: put the ends back (what the track gained meanwhile is kept)
          const cur = tracks.get(m.wsId);
          tracks.set(m.wsId, { ...(cur ?? track), pending: [...v.ended, ...(cur?.pending ?? [])] });
          if (result === 'held') {
            counters.held++;
            if (!heldLogged.has(m.wsId)) {
              heldLogged.add(m.wsId);
              log.info(`relance: ${m.wsId} — the Relance is HELD for memory (Admission); delivered when memory recovers, nothing is lost`);
            }
          } else {
            counters.failed++;
            retryAt.set(m.wsId, deps.now() + RELANCE_RETRY_MS);
            log.warn(`relance: could not deliver the Relance to ${m.wsId}; retrying in ${RELANCE_RETRY_MS / 1000}s`);
          }
        };
        const waitMs = deps.deliverWaitMs ?? RELANCE_DELIVER_WAIT_MS;
        let timer: ReturnType<typeof setTimeout> | undefined;
        const first = await Promise.race([delivery, new Promise<'slow'>((r) => { timer = setTimeout(() => r('slow'), waitMs); })]);
        clearTimeout(timer);
        if (first === 'slow') {
          // a start that hangs must not stall every other member: move on, apply its result when it lands
          slow.add(m.wsId);
          log.warn(`relance: delivery to ${m.wsId} still pending after ${waitMs / 1000}s — moving on`);
          void delivery.then((res) => {
            slow.delete(m.wsId);
            settle(res);
          });
          continue;
        }
        settle(first);
      } catch (e) {
        log.warn(`relance: member ${m.wsId} failed`, e);
      }
    }
  } catch (e) {
    log.warn('relance: sweep failed', e);
  }
  return fired;
}

/** A pass that is guaranteed to run: waits for the one in flight (however long its deliveries take — each is capped), then sweeps. The Admission release re-enters here and must not be dropped. */
export async function sweepRelanceNow(deps: RelanceDeps): Promise<string[]> {
  while (sweeping) await (current ?? Promise.resolve([])).catch(() => []).then(() => new Promise<void>((r) => setImmediate(r)));
  return sweepRelance(deps);
}

let timer: ReturnType<typeof setInterval> | null = null;

export function startRelance(deps: RelanceDeps, everyMs: number = RELANCE_SWEEP_MS): void {
  if (timer) return;
  timer = setInterval(() => void sweepRelance(deps), everyMs);
  timer.unref?.();
  void sweepRelance(deps); // the baseline: what lives now is not an end
}

export function stopRelance(): void {
  if (timer) clearInterval(timer);
  timer = null;
}

export function __resetRelanceForTests(): void {
  stopRelance();
  tracks.clear();
  retryAt.clear();
  heldLogged.clear();
  slow.clear();
  sweeping = false;
  current = null;
  counters.fired = counters.failed = counters.held = counters.dropped = 0;
}
