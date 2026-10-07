// Admission — the QUEUE half (#286, wave G ledger #295, epic #284; contract = ledger FI-2). Pure half: src/shared/admission.ts.
// Holds the AUTOMATIC starts (spawn / restart) of FLEET MEMBERS while the memory guard holds Admission, and releases them coordinators
// first, then in arrival order, ONE at a time, each release preceded by a FRESH reading (`sampleMemoryGuardNow()` + `mayReleaseOneStart`).
// Platform-free (no store / workspaces import: callers pass closures) so node --test drives the real code. The held queue is IN MEMORY: after
// an app restart a held child stays stopped with its brief owed and `orchestra restart <id>` retries it (persisting the queue = follow-up).
// NOT here (#287): a réveil under low memory — the bus-wake sweep keeps it pending with a "held for memory" reason.

import { scoped } from './logger.ts';
import { sampleMemoryGuardNow, subscribeMemoryGuard } from './memory-guard.ts';
import { formatGb, isAdmissionHolding, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { mustHoldStart, planRelease, type HeldStart, type HeldStartKind, type StartOrigin } from '../shared/admission.ts';

const alog = scoped('admission');

/** A held start: the shared fields + what to run on release and how to tell it is no longer wanted. */
interface Entry extends HeldStart {
  run: () => Promise<unknown>;
  stillOwed: () => boolean;
}

export interface AdmissionDeps {
  /** A FRESH guard reading (the FI-2 re-measure): default `sampleMemoryGuardNow`. */
  sample(): MemoryGuardSnapshot;
  now(): number;
  schedule(fn: () => void, ms: number): unknown;
  cancel(handle: unknown): void;
  /** Pause between two releases so the start just made shows in MemAvailable before the next fresh reading. */
  sleep(ms: number): Promise<void>;
  /** How soon a stalled release (memory not back yet) tries again — the guard's own cadence can be 60 s above the threshold. */
  retryMs: number;
  settleMs: number;
  info(message: string): void;
  warn(message: string, meta?: unknown): void;
}

export interface GateArgs {
  wsId: string;
  ws: { parentId?: string } | null | undefined;
  origin: StartOrigin;
  kind: HeldStartKind;
  /** The start to run on release (it must bypass this gate). */
  run: () => Promise<unknown>;
  /** Still wanted at release time? (the workspace may have been deleted, archived or started by a human meanwhile) */
  stillOwed: () => boolean;
  /** The workspace itself coordinates (released before any worker). */
  coordinator: boolean;
}
export type GateResult = { held: false } | { held: true; since: number; kind: HeldStartKind };

export interface Admission {
  gate(args: GateArgs): GateResult;
  heldFor(wsId: string): { kind: HeldStartKind; since: number } | null;
  list(): HeldStart[];
  /** Try to release now (single-flight). Resolves when this pass is done. */
  kick(): Promise<void>;
  stop(): void;
}

export const ADMISSION_RETRY_MS = 10_000;
export const ADMISSION_SETTLE_MS = 3_000;

export function realAdmissionDeps(over: Partial<AdmissionDeps> = {}): AdmissionDeps {
  return {
    sample: () => sampleMemoryGuardNow(),
    now: () => Date.now(),
    schedule: (fn, ms) => {
      const h = setTimeout(fn, ms);
      h.unref?.();
      return h;
    },
    cancel: (h) => clearTimeout(h as NodeJS.Timeout),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    retryMs: ADMISSION_RETRY_MS,
    settleMs: ADMISSION_SETTLE_MS,
    info: (m) => alog.info(m),
    warn: (m, meta) => alog.warn(m, meta),
    ...over,
  };
}

const mem = (s: MemoryGuardSnapshot): string => (s.availBytes === null ? 'MemAvailable unknown' : `MemAvailable ${formatGb(s.availBytes, 2)}`);

export function createAdmission(deps: AdmissionDeps): Admission {
  const queue = new Map<string, Entry>();
  let seq = 0;
  let draining: Promise<void> | null = null;
  let rerun = false;
  let retry: unknown = null;
  let waitLogged: string | null = null;

  function disarm(): void {
    if (retry !== null) deps.cancel(retry);
    retry = null;
  }
  function arm(): void {
    disarm();
    if (queue.size > 0) retry = deps.schedule(() => void kick(), deps.retryMs);
  }

  async function pass(): Promise<void> {
    for (;;) {
      if (queue.size === 0) {
        waitLogged = null;
        return disarm();
      }
      const snap = deps.sample();
      const step = planRelease([...queue.values()], snap);
      if (step.action === 'wait') {
        if (waitLogged !== step.reason) {
          deps.info(`release waits (${step.reason}) — ${mem(snap)}; ${queue.size} held start(s) stay queued`);
          waitLogged = step.reason;
        }
        return arm();
      }
      waitLogged = null;
      const entry = queue.get(step.entry.wsId) as Entry;
      queue.delete(entry.wsId);
      if (!entry.stillOwed()) {
        deps.info(`dropped held ${entry.kind} of ${entry.wsId} (no longer wanted) — ${mem(snap)}; ${queue.size} still held`);
        continue;
      }
      deps.info(`RELEASED ${entry.kind} of ${entry.wsId}${entry.coordinator ? ' (coordinator)' : ''}, held since ${new Date(entry.since).toISOString()} — ${mem(snap)}; ${queue.size} still held`);
      try {
        await entry.run();
      } catch (e) {
        deps.warn(`released ${entry.kind} of ${entry.wsId} threw`, e);
      }
      if (queue.size > 0) await deps.sleep(deps.settleMs);
    }
  }

  /** Single-flight, but a kick that arrives while a pass is winding down is NOT swallowed: it re-runs the pass (the guard edge that
   *  reopens Admission can land exactly then, and the next retry may be 10 s away). */
  function kick(): Promise<void> {
    if (draining) {
      rerun = true;
      return draining;
    }
    draining = (async () => {
      do {
        rerun = false;
        await pass();
      } while (rerun);
    })()
      .catch((e) => deps.warn('release pass threw', e))
      .finally(() => {
        draining = null;
        if (queue.size > 0 && retry === null) arm();
      });
    return draining;
  }

  return {
    gate(a) {
      const snap = deps.sample();
      const holding = isAdmissionHolding(snap);
      if (!mustHoldStart({ ws: a.ws, origin: a.origin, holding, queued: queue.size > 0 })) return { held: false };
      let entry = queue.get(a.wsId);
      if (entry) {
        entry.run = a.run; // the newest request wins; the original arrival (since, seq) is kept
        entry.stillOwed = a.stillOwed;
      } else {
        entry = { wsId: a.wsId, kind: a.kind, seq: ++seq, since: deps.now(), coordinator: a.coordinator, run: a.run, stillOwed: a.stillOwed };
        queue.set(a.wsId, entry);
        deps.warn(`HELD ${a.kind} of ${a.wsId}${a.coordinator ? ' (coordinator)' : ''} — ${mem(snap)}, Admission ${holding ? 'held' : 'releasing in order'}; ${queue.size} held start(s)`);
      }
      arm();
      if (!holding) void kick();
      return { held: true, since: entry.since, kind: entry.kind };
    },
    heldFor(wsId) {
      const e = queue.get(wsId);
      return e ? { kind: e.kind, since: e.since } : null;
    },
    list() {
      return [...queue.values()].map(({ wsId, kind, seq: s, since, coordinator }) => ({ wsId, kind, seq: s, since, coordinator }));
    },
    kick,
    stop() {
      disarm();
      queue.clear();
    },
  };
}

// ─── The process-wide admission (index.ts wires the guard edge; workspaces / restart-workspace import the facade) ──────────────────────

let singleton: Admission = createAdmission(realAdmissionDeps());
let unsubscribe: (() => void) | null = null;

/** Gate one AUTOMATIC start. `{held:true}` = it was queued (the caller reports "accepted, held" and starts NOTHING); `{held:false}` = go. */
export function admissionGate(args: GateArgs): GateResult {
  return singleton.gate(args);
}
export function heldStartFor(wsId: string): { kind: HeldStartKind; since: number } | null {
  return singleton.heldFor(wsId);
}
export function listHeldStarts(): HeldStart[] {
  return singleton.list();
}
/** Release trigger: the guard reopening Admission (memory back above threshold + margin) tries to release at once. */
export function startAdmission(): void {
  if (unsubscribe) return;
  unsubscribe = subscribeMemoryGuard((e) => {
    if (e.transition.kind === 'admission_reopened') void singleton.kick();
  });
}
export function stopAdmission(): void {
  unsubscribe?.();
  unsubscribe = null;
  singleton.stop();
}

/** Test/rig seam: replace the process-wide admission with one on injected deps. */
export function __rebuildAdmissionForTests(over: Partial<AdmissionDeps> = {}): Admission {
  singleton.stop();
  singleton = createAdmission(realAdmissionDeps(over));
  return singleton;
}
export { type HeldStart, type HeldStartKind } from '../shared/admission.ts';
