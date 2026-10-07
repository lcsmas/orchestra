// Memory guard ALERT to the LEAD (#289, epic #284 "Visibility", wave G ledger #295 FI-2) — the bus half. NO Electron import (like pause-memory.ts): the store, the guard, Admission and Veille reach it through
// `MemoryAlertDeps`; src/main/memory-alert-host.ts binds the real ones. Pure text + ledger: src/shared/memory-alert.ts.
//
// ONE `escalation` row per memory EPISODE (the guard's `episode` = one downward crossing of the Admission threshold; hysteresis oscillation never opens another) to the LEAD = the COORDINATOR of every ROOT run that carries
// a live local fleet and whose frozen `delivery` switch is ON (a row nobody can read is noise). Subscribe FIRST, then reconcile from the snapshot (FI-2.5): a boot while already held tells the episode once.
// The row waits ALERT_SETTLE_MS after the crossing so "the actions taken" are real numbers; an episode that ends first is told when it ends.

import { send, type BusDb } from './bus.ts';
import { getRun } from './bus-runs.ts';
import { liveFleetRuns, topmostRunIds, type MemoryPauseDeps } from './pause-memory.ts';
import { memoryPausedRuns } from './pause-memory.ts';
import type { GuardTransition, MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { ALERT_SENDER, ALERT_SETTLE_MS, memoryAlertBody, type AlertEpisode } from '../shared/memory-alert.ts';

export interface MemoryAlertDeps extends Pick<MemoryPauseDeps, 'getBus' | 'getWorkspace' | 'listWorkspaces' | 'storeReady' | 'now' | 'log'> {
  /** The guard now (the facts "now" of the row). */
  snapshot(): MemoryGuardSnapshot;
  /** Automatic fleet starts currently HELD by Admission (#286). */
  heldStarts(): number;
  /** Fleet members put in Veille since `at` (epoch ms). */
  veilleSince(at: number): number;
  /** Containers no workspace owns — 0 until #293 lands (the field stays). */
  unattributedContainers(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
}

/** What the host's edge listener hands over (a structural slice of `MemoryGuardTransitionEvent`). */
export interface MemoryAlertEdge {
  transition: Pick<GuardTransition, 'kind' | 'episode' | 'pauseCycle' | 'availBytes' | 'thresholdBytes'>;
  snapshot: MemoryGuardSnapshot;
}

/** The LEAD of an episode: the coordinator of every ROOT run carrying a live local fleet whose frozen `delivery` switch is ON, with its coordinator workspace live. */
export function alertRecipients(db: BusDb, deps: Pick<MemoryAlertDeps, 'getWorkspace' | 'listWorkspaces'>): Array<{ runId: string; coordinator: string }> {
  const fleet = liveFleetRuns(db, deps);
  const roots = topmostRunIds(db, deps, fleet.map((r) => r.id));
  const out: Array<{ runId: string; coordinator: string }> = [];
  for (const id of roots) {
    const run = getRun(db, id);
    if (!run || run.flags.delivery !== true) continue; // a run without the delivery mechanism has nobody who can read a bus row
    const w = deps.getWorkspace(run.coordinator);
    if (!w || w.archived) continue; // a gone coordinator reads nothing
    out.push({ runId: id, coordinator: run.coordinator });
  }
  return out;
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
      const body = memoryAlertBody(t.ep, {
        heldStarts: deps.heldStarts(),
        veille: deps.veilleSince(t.ep.admission.at),
        pausedRuns: memoryPausedRuns(db).map((r) => r.runId),
        unattributedContainers: deps.unattributedContainers(),
        nowAvailBytes: snap.availBytes === null ? null : snap.measured ? snap.availBytes : null,
        nowAdmissionHeld: snap.admission === 'held',
        nowPause: snap.pause === 'held',
        admissionEnabled: snap.admissionEnabled,
        admissionBytes: snap.admissionBytes,
        criticalBytes: snap.criticalBytes,
        releaseMarginBytes: snap.releaseMarginBytes,
        at: deps.now(),
      });
      const to = alertRecipients(db, deps);
      t.sent = true; // BEFORE the writes: a throw half-way must not make the next edge write the same episode again
      for (const r of to) send(db, { runId: r.runId, sender: ALERT_SENDER, recipient: r.coordinator, kind: 'escalation', body });
      deps.log.info(`memory-alert: episode ${t.ep.episode} told to ${to.length ? to.map((r) => `${r.coordinator} (run ${r.runId})`).join(', ') : 'NOBODY (no root run with a live fleet and delivery ON)'} — MemAvailable ${snap.availBytes === null ? 'unreadable' : (snap.availBytes / 1024 ** 3).toFixed(2) + ' GB'}`);
    } catch (e) {
      deps.log.warn(`memory-alert: writing the escalation of episode ${t.ep.episode} failed`, e);
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
