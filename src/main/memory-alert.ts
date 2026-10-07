// Memory guard ALERT to the LEAD (#289, epic #284 "Visibility", wave G ledger #295 FI-2) — the bus half. NO Electron import (like pause-memory.ts): the store, the guard, Admission and Veille reach it through
// `MemoryAlertDeps`; src/main/memory-alert-host.ts binds the real ones. Pure text + ledger: src/shared/memory-alert.ts.
//
// ONE `escalation` row per memory EPISODE (the guard's `episode` = one downward crossing of the Admission threshold; hysteresis oscillation never opens another) to the LEAD = the COORDINATOR of every ROOT run that carries
// a live local fleet and whose frozen `delivery` switch is ON (a row nobody can read is noise). Subscribe FIRST, then reconcile from the snapshot (FI-2.5): a boot while already held tells the episode once.
// The row waits ALERT_SETTLE_MS after the crossing so "the actions taken" are real numbers; an episode that ends first is told when it ends.

import { send, type BusDb } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { liveFleetRuns, memoryPauseCandidates, topmostRunIds, type MemoryPauseDeps } from './pause-memory.ts';
import { memoryPausedRuns } from './pause-memory.ts';
import { isAdmissionHolding, type GuardTransition, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { ALERT_SENDER, ALERT_SETTLE_MS, memoryAlertBody, type AlertEpisode } from '../shared/memory-alert.ts';

export interface MemoryAlertDeps extends Pick<MemoryPauseDeps, 'getBus' | 'getWorkspace' | 'listWorkspaces' | 'storeReady' | 'now' | 'log'> {
  /** The guard now (the facts "now" of the row). */
  snapshot(): MemoryGuardSnapshot;
  /** Automatic fleet starts currently HELD by Admission (#286). */
  heldStarts(): number;
  /** Fleet members put in Veille since `at` (epoch ms). */
  veilleSince(at: number): number;
  /** Containers no workspace owns (#293, the last monitor tick's count). */
  unattributedContainers(): number;
  /** additive (#293): the accounting's state ('ok' | 'unavailable' | 'error' | 'not-sampled'): anything but 'ok' makes the row say "not measured (why)" instead of "0". Absent = 'ok'. */
  unattributedDocker?(): 'ok' | 'unavailable' | 'error' | 'not-sampled' | 'stale';
  /** additive (#293): daemons that did not answer the last pass. */
  unattributedDaemonsDown?(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** What the host's edge listener hands over (a structural slice of `MemoryGuardTransitionEvent`). */
export interface MemoryAlertEdge {
  transition: Pick<GuardTransition, 'kind' | 'episode' | 'pauseCycle' | 'availBytes' | 'thresholdBytes'>;
  snapshot: MemoryGuardSnapshot;
}

/** The LEAD of an episode: the coordinator of the TOPMOST run, among the runs carrying a live local fleet, that CAN READ a bus row (frozen `delivery` switch ON, coordinator workspace live). Readers are filtered BEFORE
 *  the topmost is taken: a root that cannot read must not silence the delivery-ON run below it (the memory Pause pauses that one too). */
export function alertRecipients(db: BusDb, deps: Pick<MemoryAlertDeps, 'getWorkspace' | 'listWorkspaces'>): Array<{ runId: string; coordinator: string }> {
  const readers = new Map<string, string>(); // runId → its live coordinator
  for (const r of liveFleetRuns(db, deps)) {
    if (r.flags.delivery !== true) continue; // a run without the delivery mechanism has nobody who can read a bus row
    const run = getRun(db, r.id);
    const w = run ? deps.getWorkspace(run.coordinator) : undefined;
    if (!run || !w || w.archived) continue; // a gone coordinator reads nothing
    readers.set(r.id, run.coordinator);
  }
  return topmostRunIds(db, deps, [...readers.keys()]).map((runId) => ({ runId, coordinator: readers.get(runId)! }));
}

interface Tracked {
  ep: AlertEpisode;
  timer: unknown;
  sent: boolean;
  /** Times the send found the bus / store not ready (bounded: the next timer re-tries). */
  tries: number;
}

const MAX_TRIES = 6;

export interface MemoryAlert {
  onEdge(e: MemoryAlertEdge): void;
  /** A LEVEL read of the snapshot (the boot reconcile): an episode already in progress is opened once. */
  reconcile(snapshot: MemoryGuardSnapshot): void;
  stop(): void;
  /** Rig / test view: the episodes seen, with whether their row was written. */
  episodes(): Array<{ episode: number; sent: boolean; critical: boolean; ended: boolean }>;
}

export function createMemoryAlert(deps: MemoryAlertDeps): MemoryAlert {
  const tracked = new Map<number, Tracked>();

  function open(episode: number, admission: AlertEpisode['admission']): Tracked {
    const t: Tracked = { ep: { episode, admission, critical: null, pauseCycles: 0, endedAt: null }, timer: null, sent: false, tries: 0 };
    tracked.set(episode, t);
    arm(t);
    return t;
  }

  function arm(t: Tracked): void {
    if (t.timer !== null) deps.cancel(t.timer);
    t.timer = deps.schedule(() => {
      t.timer = null;
      write(t);
    }, ALERT_SETTLE_MS);
  }

  /** Write the ONE row (once per episode). Not ready (no bus / store not loaded) ⇒ the timer re-arms, bounded. */
  function write(t: Tracked): void {
    if (t.sent) return;
    try {
      const db = deps.getBus();
      if (!db || (deps.storeReady && !deps.storeReady())) {
        if (++t.tries < MAX_TRIES) arm(t);
        else deps.log.warn(`memory-alert: episode ${t.ep.episode} NOT told — the bus / store was not ready ${MAX_TRIES} times`);
        return;
      }
      const snap = deps.snapshot();
      const pausedRuns = memoryPausedRuns(db).map((r) => r.runId);
      const body = memoryAlertBody(t.ep, {
        heldStarts: deps.heldStarts(),
        veille: deps.veilleSince(t.ep.admission.at),
        pausedRuns,
        unattributedContainers: deps.unattributedContainers(),
        unattributedDocker: deps.unattributedDocker ? deps.unattributedDocker() : undefined,
        unattributedDaemonsDown: deps.unattributedDaemonsDown ? deps.unattributedDaemonsDown() : undefined,
        nowAvailBytes: snap.availBytes === null ? null : snap.measured ? snap.availBytes : null,
        nowAdmissionHeld: isAdmissionHolding(snap), // the EFFECTIVE state (toggle ON and held), never the raw flag
        nowPause: pausedRuns.length > 0, // runs ARE under the memory Pause — "the guard is below critical" is not that
        eligibleRuns: memoryPauseCandidates(db, deps).length,
        admissionEnabled: snap.admissionEnabled,
        admissionBytes: snap.admissionBytes,
        criticalBytes: snap.criticalBytes,
        releaseMarginBytes: snap.releaseMarginBytes,
        at: deps.now(),
      });
      const to = alertRecipients(db, deps);
      t.sent = true; // BEFORE the writes: a throw half-way must not make the next edge write the same episode again
      for (const r of to) {
        try {
          send(db, { runId: r.runId, sender: ALERT_SENDER, recipient: r.coordinator, kind: 'escalation', body });
        } catch (e) {
          deps.log.warn(`memory-alert: episode ${t.ep.episode} NOT written to ${r.coordinator} (run ${r.runId}) — the other lead(s) are still told`, e); // at-most-once per recipient
        }
      }
      deps.log.info(`memory-alert: episode ${t.ep.episode} told to ${to.length ? to.map((r) => `${r.coordinator} (run ${r.runId})`).join(', ') : 'NOBODY (no root run with a live fleet and delivery ON)'} — MemAvailable ${snap.availBytes === null ? 'unreadable' : (snap.availBytes / 1024 ** 3).toFixed(2) + ' GB'}`);
    } catch (e) {
      // nothing was written yet (`sent` is set only after the facts and recipients were read): retry on the bounded timer rather than telling the episode only when it ends, hours later
      const retry = !t.sent && t.tries + 1 < MAX_TRIES;
      deps.log.warn(`memory-alert: preparing the escalation of episode ${t.ep.episode} failed${retry ? ' — retried' : ''}`, e);
      if (retry) (t.tries++, arm(t));
    }
  }

  function settle(t: Tracked): void {
    if (t.timer !== null) deps.cancel(t.timer);
    t.timer = null;
    write(t);
  }

  function criticalOf(t: Tracked, at: number, availBytes: number, thresholdBytes: number, pauseCycle: number): void {
    t.ep.pauseCycles += 1;
    if (!t.ep.critical) t.ep.critical = { at, availBytes, thresholdBytes, pauseCycle };
  }

  return {
    onEdge(e) {
      const tr = e.transition;
      const now = deps.now();
      try {
        if (tr.kind === 'admission_held') {
          if (!tracked.has(tr.episode)) open(tr.episode, { at: now, availBytes: tr.availBytes, thresholdBytes: tr.thresholdBytes });
        } else if (tr.kind === 'pause_due') {
          const t = tracked.get(tr.episode) ?? open(tr.episode, { at: e.snapshot.heldSince ?? now, availBytes: tr.availBytes, thresholdBytes: e.snapshot.admissionBytes });
          criticalOf(t, now, tr.availBytes, tr.thresholdBytes, tr.pauseCycle);
        } else if (tr.kind === 'admission_reopened') {
          const t = tracked.get(tr.episode);
          if (t) {
            t.ep.endedAt = now;
            if (!t.sent) settle(t); // the episode ended before its settle window: tell it now
          }
        }
      } catch (err) {
        deps.log.warn(`memory-alert: handling ${tr.kind} failed`, err);
      }
    },
    reconcile(snapshot) {
      try {
        if (!snapshot.sampled || !snapshot.measured || snapshot.availBytes === null) return; // unknown ≠ held ≠ open
        if (snapshot.admission !== 'held') {
          // Admission is OPEN: a tracked episode whose reopen edge we missed is over — tell it
          for (const t of tracked.values()) if (!t.sent && t.ep.endedAt === null) (t.ep.endedAt = deps.now(), settle(t));
          return;
        }
        if (tracked.has(snapshot.episode)) return;
        const t = open(snapshot.episode, { at: snapshot.heldSince ?? deps.now(), availBytes: snapshot.availBytes, thresholdBytes: snapshot.admissionBytes });
        if (snapshot.pause === 'held') criticalOf(t, snapshot.pauseSince ?? deps.now(), snapshot.availBytes, snapshot.criticalBytes, snapshot.pauseCycle);
      } catch (err) {
        deps.log.warn('memory-alert: reconcile failed', err);
      }
    },
    stop() {
      for (const t of tracked.values()) {
        if (t.timer !== null) deps.cancel(t.timer);
        t.timer = null;
      }
    },
    episodes: () => [...tracked.values()].map((t) => ({ episode: t.ep.episode, sent: t.sent, critical: t.ep.critical !== null, ended: t.ep.endedAt !== null })),
  };
}
