// Admission — the QUEUE half (#286, wave G ledger #295, epic #284; contract = ledger FI-2). Pure half: src/shared/admission.ts.
// Holds the AUTOMATIC starts (spawn / restart) of FLEET MEMBERS while the memory guard holds Admission, and releases them coordinators
// first, then in arrival order, ONE at a time, each release preceded by a FRESH reading (`sampleMemoryGuardNow()` + `mayReleaseOneStart`).
// Platform-free (no store / workspaces import: callers pass closures) so node --test drives the real code. The held queue is IN MEMORY: after
// an app restart a held child stays stopped with its brief owed and `orchestra restart <id>` retries it (persisting the queue = follow-up).
// NOT here (#287): a réveil under low memory — the bus-wake sweep keeps it pending with a "held for memory" reason.

import { scoped } from './logger.ts';
import { sampleMemoryGuardNow, subscribeMemoryGuard } from './memory-guard.ts';
import { formatGb, isAdmissionHolding, type MemoryGuardSnapshot } from '../shared/memory-guard.ts';
import { isHumanOrigin, kindRank, mustHoldStart, planRelease, releaseFailureBody, releaseTimeoutBody, type HeldStart, type HeldStartKind, type StartOrigin } from '../shared/admission.ts';

const alog = scoped('admission');

/** A held start: the shared fields + what to run on release and how to tell it is no longer wanted. */
interface Entry extends HeldStart {
  run: () => Promise<unknown>;
  stillOwed: () => boolean;
  /** The last release attempt was REFUSED by a fleet Pause: the entry keeps its slot but is NOT a line a newcomer must join (review r2 N1). */
  paused?: boolean;
  retryLater?: (result: unknown) => boolean;
  /** Tell the coordinator (bus) that a released start did not start. Best-effort; never throws into the release loop. */
  report?: (text: string) => void;
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
  /** Tell the coordinator (bus) that a released start did not start (review F4). Best-effort; the loop never lets it throw. */
  report?: (text: string) => void;
}
export type GateResult = { held: false } | { held: true; since: number; kind: HeldStartKind };

/** An AUTOMATIC start of a SLEEPING fleet member that is a wake (réveil, parked-prompt flush, usage-limit resume, peer message, recovery) — #287. */
export interface WakeGateArgs {
  wsId: string;
  /** The member has a coordinator (a parent). A top-level / detached workspace is never held. */
  fleetMember: boolean;
  /** No live session / PTY: this wake would START a process. A wake of a LIVE member is a plain turn — never held. */
  sleeping: boolean;
  coordinator: boolean;
  /** Run the site's NORMAL path again (it re-enters `holdWake`, which then consumes the permit and lets it through). Must resolve when the
   *  wake has actually been delivered, so the release stays one at a time. */
  retry: () => Promise<unknown>;
  stillOwed: () => boolean;
  report?: (text: string) => void;
}

export interface Admission {
  /** The release of a held wake grants a ONE-SHOT permit for the member; the site's retry consumes it here. */
  holdWake(args: WakeGateArgs): GateResult;
  gate(args: GateArgs): GateResult;
  heldFor(wsId: string): { kind: HeldStartKind; since: number } | null;
  list(): HeldStart[];
  /** Forget a held start (the workspace was deleted): it must not linger in `held starts:` nor keep the line "non-empty". */
  drop(wsId: string): boolean;
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
  /** One-shot permits: "this member may be started NOW" — granted by a release, consumed by whichever wake site reaches `holdWake` first. */
  const permits = new Set<string>();
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
    /** Entries a fleet Pause REFUSED during THIS pass: they keep their slot but never block the line — everything behind them (any run) still goes
     *  out; the next retry tries them again (review F2: a long manual / usage-limit / memory Pause on one run used to freeze every other run). */
    const deferred = new Set<string>();
    for (;;) {
      const waiting = [...queue.values()].filter((e) => !deferred.has(e.wsId));
      if (waiting.length === 0) {
        waitLogged = null;
        if (queue.size === 0) return disarm();
        return; // only Pause-refused entries are left: kick()'s `finally` re-arms the retry (pinned by pause_refused_does_not_block_the_line)
      }
      const snap = deps.sample();
      const step = planRelease(waiting, snap);
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
        const secs = Math.round(deps.runTimeoutMs / 1000);
        deps.warn(`released ${entry.kind} of ${entry.wsId} did not settle within ${secs} s — the line moves on (it may still finish)`);
        tell(entry, releaseTimeoutBody(entry.kind, entry.wsId, entry.since, secs));
      } else if (isFailure(outcome)) {
        if (entry.retryLater?.(outcome)) {
          entry.paused = true;
          queue.set(entry.wsId, entry); // refused for now (a Pause is in force): the SAME slot, not a lost start — and NOT a wall for the others
          deferred.add(entry.wsId);
          deps.info(`released ${entry.kind} of ${entry.wsId} was refused for now (${failureText(outcome)}) — kept queued, the line goes on`);
          continue; // nothing started: no settle pause
        }
        deps.warn(`released ${entry.kind} of ${entry.wsId} FAILED: ${failureText(outcome)}`);
        tell(entry, releaseFailureBody(entry.kind, entry.wsId, entry.since, failureText(outcome)));
      }
      if (queue.size > 0) await deps.sleep(deps.settleMs);
    }
  }

  /** Forget held entries that are no longer wanted (the member was started by a person, archived…) at READ time, so `peers` / `bus-status` never keep
   *  saying "held" for a member that is running — a release pass may be hours away (review F4). A running release is not in the queue, so untouched. */
  function pruneUnowed(): void {
    for (const e of [...queue.values()]) {
      if (stillOwedSafe(e)) continue;
      queue.delete(e.wsId);
      deps.info(`dropped held ${e.kind} of ${e.wsId} (no longer wanted) — ${queue.size} still held`);
    }
    if (queue.size === 0) disarm();
  }

  /** Tell the coordinator a released start did not start. Never throws. */
  function tell(entry: Entry, body: string): void {
    try {
      entry.report?.(body);
    } catch (e) {
      deps.warn(`could not report the failed release of ${entry.wsId} to its coordinator`, e);
    }
  }

  /** Single-flight, but a kick that arrives while a pass is winding down is NOT swallowed: it re-runs the pass (the guard edge that
   *  reopens Admission can land exactly then, and the next retry may be 10 s away). */
  function kick(): Promise<void> {
    if (draining) {
      rerun = true;
      return draining;
    }
    // The body starts in a MICROTASK, after `draining` is assigned: a pass's own fresh sample can emit the guard's reopen edge synchronously, whose
    // subscriber calls `kick()` — with `draining` still null that started a 2nd concurrent pass (two releases off one reading, review F1).
    draining = Promise.resolve()
      .then(async () => {
        do {
          rerun = false;
          await pass();
        } while (rerun);
      })
      .catch((e) => deps.warn('release pass threw', e))
      .finally(() => {
        draining = null;
        if (queue.size > 0 && retry === null) arm();
      });
    return draining;
  }

  const api: Admission = {
    gate(a) {
      pruneUnowed(); // an entry a person already superseded must neither make a newcomer "join the line" nor swallow a repeat request
      // A release of this very workspace is running right now: report it as held (it IS starting) instead of starting it a second time.
      const inFlight = releasing.get(a.wsId);
      if (inFlight && a.origin === 'auto') return { held: true, since: inFlight.since, kind: inFlight.kind };
      const snap = deps.sample();
      const holding = isAdmissionHolding(snap);
      if (!mustHoldStart({ ws: a.ws, origin: a.origin, holding, queued: [...queue.values()].some((e) => !e.paused) })) {
        // A HUMAN started this member itself: its held entry (if any) is superseded — never leave peers / bus-status saying "held" for a running member.
        if (isHumanOrigin(a.origin) && queue.delete(a.wsId)) deps.info(`dropped held ${a.kind} of ${a.wsId}: a human started it — ${mem(snap)}; ${queue.size} still held`);
        return { held: false };
      }
      let entry = queue.get(a.wsId);
      if (entry && kindRank(entry.kind) > kindRank(a.kind)) {
        // A held SPAWN/RESTART already covers this member: a WAKE request is satisfied by that start (whatever the wake was for reaches the running member
        // as a plain turn afterwards) — it must NOT replace the start's closure with a wake's.
        return { held: true, since: entry.since, kind: entry.kind };
      }
      if (entry) {
        if (kindRank(a.kind) > kindRank(entry.kind)) entry.kind = a.kind; // a real start supersedes a held wake, keeping the slot
        entry.run = a.run; // the newest request wins; the original arrival (since, seq) is kept
        entry.stillOwed = a.stillOwed;
        entry.retryLater = a.retryLater;
        entry.report = a.report;
      } else {
        entry = { wsId: a.wsId, kind: a.kind, seq: ++seq, since: deps.now(), coordinator: a.coordinator, run: a.run, stillOwed: a.stillOwed, retryLater: a.retryLater, report: a.report };
        queue.set(a.wsId, entry);
        deps.warn(`HELD ${a.kind} of ${a.wsId}${a.coordinator ? ' (coordinator)' : ''} — ${mem(snap)}, Admission ${holding ? 'held' : 'releasing in order'}; ${queue.size} held start(s)`);
      }
      arm();
      if (!holding) void kick();
      return { held: true, since: entry.since, kind: entry.kind };
    },
    holdWake(a) {
      if (!a.fleetMember || !a.sleeping) return { held: false }; // a turn to a running member, or a non-fleet workspace: never a held start
      if (permits.delete(a.wsId)) return { held: false }; // its turn came: the release granted the permit, this call consumes it
      return api.gate({
        wsId: a.wsId,
        ws: { parentId: 'fleet' },
        origin: 'auto',
        kind: 'wake',
        coordinator: a.coordinator,
        stillOwed: a.stillOwed,
        report: a.report,
        run: async () => {
          permits.add(a.wsId);
          try {
            await a.retry();
          } finally {
            permits.delete(a.wsId); // never leave a stale permit that could bypass a LATER hold
          }
          return { ok: true };
        },
      });
    },
    heldFor(wsId) {
      pruneUnowed();
      const e = queue.get(wsId);
      if (e) return { kind: e.kind, since: e.since };
      // A release in progress still counts: the member is booting (its first lifecycle event — the idle clock — lands only after `ensureSession`), so the
      // liveness shield must not drop at the moment the release BEGINS (review r2 L1: a false "silent" escalation during the CLI boot).
      return releasing.get(wsId) ?? null;
    },
    drop(wsId) {
      const had = queue.delete(wsId);
      if (had) deps.info(`dropped held start of ${wsId} (workspace deleted) — ${queue.size} still held`);
      if (queue.size === 0) disarm();
      return had;
    },
    list() {
      pruneUnowed();
      return [...queue.values()].map(({ wsId, kind, seq: s, since, coordinator }) => ({ wsId, kind, seq: s, since, coordinator }));
    },
    kick,
    stop() {
      disarm();
      queue.clear();
    },
  };
  return api;
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
/** The liveness roster's silence predicate for Admission (index.ts wires THIS function; admission-liveness.test.ts drives it): a member whose start is held — or
 *  is being released right now — is not "silent". */
export function livenessSilencedByAdmission(wsId: string): boolean {
  return singleton.heldFor(wsId) !== null;
}
/** #287: hold an automatic wake of a SLEEPING fleet member. `{held:true}` = skip it — the site's durable pending state is untouched and the queue
 *  re-runs `retry` when this member's turn comes (coordinators first, one at a time, a fresh reading each); `{held:false}` = go ahead (memory is
 *  fine, or the release just granted this member's permit). */
export function holdWake(args: WakeGateArgs): GateResult {
  return singleton.holdWake(args);
}
/** Try to release the queue now (single-flight) — what a recovery edge, the retry timer and the release trigger of other start kinds call. */
export function kickAdmission(): Promise<void> {
  return singleton.kick();
}
export function listHeldStarts(): HeldStart[] {
  return singleton.list();
}
/** The workspace was deleted: forget its held start (review F4). */
export function dropHeldStart(wsId: string): boolean {
  return singleton.drop(wsId);
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
