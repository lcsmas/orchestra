// Admission — the QUEUE half (#286, wave G ledger #295, epic #284; contract = ledger FI-2). Pure half: src/shared/admission.ts.
// Holds the AUTOMATIC starts (spawn / restart) of FLEET MEMBERS while the memory guard holds Admission, and releases them coordinators
// first, then in arrival order, ONE at a time, each release preceded by a FRESH reading (`sampleMemoryGuardNow()` + `mayReleaseOneStart`).
// Platform-free (no store / workspaces import: callers pass closures) so node --test drives the real code. The held queue is IN MEMORY: after
// an app restart a held child stays stopped with its brief owed and `orchestra restart <id>` retries it (persisting the queue = follow-up).
// NOT here (#287): a réveil under low memory — the bus-wake sweep keeps it pending with a "held for memory" reason.

import { scoped } from './logger.ts';
import { sampleMemoryGuardNow, subscribeMemoryGuard } from './memory-guard.ts';
import { formatGb, isAdmissionHolding, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { isHumanOrigin, mustHoldStart, planRelease, type HeldStart, type HeldStartKind, type StartOrigin } from '../shared/admission.ts';

const alog = scoped('admission');

/** A held start: the shared fields + what to run on release and how to tell it is no longer wanted. */
interface Entry extends HeldStart {
  run: () => Promise<unknown>;
  stillOwed: () => boolean;
  retryLater?: (result: unknown) => boolean;
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
  /** A release that has not settled after this long stops blocking the line (the hung one may still finish on its own). */
  runTimeoutMs: number;
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
  /** Called with a FAILED release result: true = the failure is "not now" (a fleet Pause is in force) — keep the entry queued instead of losing it. */
  retryLater?: (result: unknown) => boolean;
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
export const ADMISSION_RUN_TIMEOUT_MS = 90_000;
const TIMED_OUT = Symbol('timed-out');

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
    runTimeoutMs: ADMISSION_RUN_TIMEOUT_MS,
    info: (m) => alog.info(m),
    warn: (m, meta) => alog.warn(m, meta),
    ...over,
  };
}

const isFailure = (o: unknown): boolean => typeof o === 'object' && o !== null && (o as { ok?: unknown }).ok === false;
const failureText = (o: unknown): string => String((o as { error?: unknown }).error ?? 'no reason given');
const mem = (s: MemoryGuardSnapshot): string => (s.availBytes === null ? 'MemAvailable unknown' : `MemAvailable ${formatGb(s.availBytes, 2)}`);

export function createAdmission(deps: AdmissionDeps): Admission {
  const queue = new Map<string, Entry>();
  /** Entries whose release is RUNNING now (already out of the queue): a repeat automatic request for the same workspace must not start a duplicate. */
  const releasing = new Map<string, { since: number; kind: HeldStartKind }>();
  let seq = 0;
  let draining: Promise<void> | null = null;
  let rerun = false;
  let retry: unknown = null;
  let waitLogged: string | null = null;

  /** A throwing `stillOwed` (a store hiccup) is treated as "still owed": the start itself reports a vanished workspace; losing a held start is worse. */
  function stillOwedSafe(entry: Entry): boolean {
    try {
      return entry.stillOwed();
    } catch (e) {
      deps.warn(`stillOwed of held ${entry.kind} of ${entry.wsId} threw — treated as still owed`, e);
      return true;
    }
  }

  function runBounded(entry: Entry): Promise<unknown> {
    return new Promise((resolve) => {
      let done = false;
      const finish = (v: unknown): void => {
        if (done) return;
        done = true;
        deps.cancel(timer);
        resolve(v);
      };
      const timer = deps.schedule(() => finish(TIMED_OUT), deps.runTimeoutMs);
      entry.run().then(finish, (e) => finish({ ok: false, error: e instanceof Error ? e.message : String(e) }));
    });
  }

  function disarm(): void {
    if (retry !== null) deps.cancel(retry);
    retry = null;
  }
  function arm(): void {
    disarm();
    if (queue.size > 0) {
      retry = deps.schedule(() => {
        retry = null; // the handle is spent: a pass that throws below must be able to re-arm
        void kick();
      }, deps.retryMs);
    }
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
      if (!stillOwedSafe(entry)) {
        deps.info(`dropped held ${entry.kind} of ${entry.wsId} (no longer wanted) — ${mem(snap)}; ${queue.size} still held`);
        continue;
      }
      deps.info(`RELEASED ${entry.kind} of ${entry.wsId}${entry.coordinator ? ' (coordinator)' : ''}, held since ${new Date(entry.since).toISOString()} — ${mem(snap)}; ${queue.size} still held`);
      releasing.set(entry.wsId, { since: entry.since, kind: entry.kind });
      let outcome: unknown;
      try {
        outcome = await runBounded(entry);
      } catch (e) {
        deps.warn(`released ${entry.kind} of ${entry.wsId} threw`, e);
      } finally {
        releasing.delete(entry.wsId);
      }
      if (outcome === TIMED_OUT) {
        deps.warn(`released ${entry.kind} of ${entry.wsId} did not settle within ${Math.round(deps.runTimeoutMs / 1000)} s — the line moves on (it may still finish)`);
      } else if (isFailure(outcome)) {
        if (entry.retryLater?.(outcome)) {
          queue.set(entry.wsId, entry); // refused for now (a Pause is in force): the SAME slot, not a lost start
          deps.info(`released ${entry.kind} of ${entry.wsId} was refused for now (${failureText(outcome)}) — kept queued`);
          return arm();
        }
        deps.warn(`released ${entry.kind} of ${entry.wsId} FAILED: ${failureText(outcome)}`);
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
      // A release of this very workspace is running right now: report it as held (it IS starting) instead of starting it a second time.
      const inFlight = releasing.get(a.wsId);
      if (inFlight && a.origin === 'auto') return { held: true, since: inFlight.since, kind: inFlight.kind };
      const snap = deps.sample();
      const holding = isAdmissionHolding(snap);
      if (!mustHoldStart({ ws: a.ws, origin: a.origin, holding, queued: queue.size > 0 })) {
        // A HUMAN started this member itself: its held entry (if any) is superseded — never leave peers / bus-status saying "held" for a running member.
        if (isHumanOrigin(a.origin) && queue.delete(a.wsId)) deps.info(`dropped held ${a.kind} of ${a.wsId}: a human started it — ${mem(snap)}; ${queue.size} still held`);
        return { held: false };
      }
      let entry = queue.get(a.wsId);
      if (entry) {
        entry.run = a.run; // the newest request wins; the original arrival (since, seq) is kept
        entry.stillOwed = a.stillOwed;
        entry.retryLater = a.retryLater;
      } else {
        entry = { wsId: a.wsId, kind: a.kind, seq: ++seq, since: deps.now(), coordinator: a.coordinator, run: a.run, stillOwed: a.stillOwed, retryLater: a.retryLater };
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
  // SUBSCRIBE FIRST, then reconcile from the guard's current state (FI-2 item 5 v1.1): an edge between a snapshot and a later subscribe is lost.
  unsubscribe = subscribeMemoryGuard((e) => {
    if (e.transition.kind === 'admission_reopened') void singleton.kick();
  });
  void singleton.kick(); // the reconcile: whatever is already queued meets a FRESH reading now (it samples; a still-held guard just waits)
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
