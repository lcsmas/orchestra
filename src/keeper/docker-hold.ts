// The keeper's Docker HOLD gate (#321, wave H ledger #329; pure half: src/shared/docker-hold.ts). A container create/start the relay is about to forward WAITS here while the app-published Admission state
// says held, and goes out BY ITSELF when memory is back — never refused. Same retention semantics as Admission (#286): a newcomer joins the line while one exists, the line is released FIFO ONE AT A TIME,
// each release preceded by a FRESH MemAvailable reading (`mayReleaseOne`) and followed by a settle so the container just started shows in the next reading.
//
// Fail-open by construction: no state file, an unreadable one, another version, or one older than the TTL (the app that decides is gone) ⇒ nothing is held and a line already waiting is flushed at once. A client
// that gives up (its connection closes) simply leaves the line — its create is never sent.
//
// While anything waits the gate publishes `<ws>.docker.hold` (count / oldest since / reason; refreshed ≥ every 5 s) for the app's `bus-status` and the member's coordinator, and removes it when the line is empty.
// Electron-free; every clock / file / meter is injected so node --test drives the real code.

import type { FleetLine, HoldLease } from './release-lease.ts';
import {
  ADMISSION_STATE_TTL_MS,
  holdReason,
  holdsNow,
  mayReleaseOne,
  parseAdmissionState,
  stateIsFresh,
  type AdmissionState,
  type HoldFile,
} from '../shared/docker-hold.ts';

export type HeldKind = 'create' | 'start';

export interface HoldAdmitted {
  /** 0 = never held. */
  waitedMs: number;
  /** Why it waited (the reason as the line last saw it); null when it never waited. */
  reason: string | null;
  /** Released because the state stopped being authoritative (absent / stale / toggle OFF), not because memory came back. */
  flushed?: boolean;
}

export interface HoldGateOptions {
  /** The file the APP writes (the guard's EFFECTIVE hold + thresholds). */
  stateFile: string;
  /** Where THIS keeper publishes what waits (`<ws>.docker.hold`). */
  holdFile: string;
  now(): number;
  /** A FRESH MemAvailable in bytes; null = unreadable. */
  readMem(): number | null;
  /** Whole file text, null when absent / unreadable. */
  readText(file: string): string | null;
  /** Atomic publish (tmp + rename); a throw is logged once. */
  writeFile(file: string, text: string): void;
  removeFile(file: string): void;
  sleep(ms: number): Promise<void>;
  /** How soon the line re-reads the state while held (default 1 s). */
  pollMs: number;
  /** Pause between two releases (default 1.5 s). */
  settleMs: number;
  ttlMs?: number;
  /** The FLEET-wide release slot (review M1): releases are ONE AT A TIME across every keeper's relay, not per keeper. Absent = per-keeper only (unit tests; never production). */
  lease?: HoldLease;
  /** The OTHER keepers' lines: oldest call first across the fleet, and a newcomer queues behind a line in motion (Admission's `mustHoldStart`: a newcomer never jumps the line). Absent = this keeper alone. */
  fleet?: FleetLine;
  log(msg: string): void;
}

export interface HoldGate {
  /** Resolves when the request may go out (`waitedMs` 0 = it never waited), or null when `signal` aborted first (the client left; its request must NOT be forwarded). */
  admit(kind: HeldKind, signal: AbortSignal): Promise<HoldAdmitted | null>;
  waiting(): number;
  /** Is anything held NOW (a line exists or the fresh state says held)? A START skips its inspect round trip while nothing is. */
  holding(): boolean;
  /** Keeper exit: everyone in the line is dropped (their sockets die with the keeper), the hold file removed, no timer left. */
  stop(): void;
}

interface Entry {
  kind: HeldKind;
  since: number;
  resolve(v: HoldAdmitted | null): void;
  detach(): void;
}

const HEARTBEAT_MS = 5_000;

export function createHoldGate(o: HoldGateOptions): HoldGate {
  const ttl = o.ttlMs ?? ADMISSION_STATE_TTL_MS;
  const queue: Entry[] = [];
  let running = false;
  let stopped = false;
  let lastState: AdmissionState | null = null;
  let lastReason = 'Admission hold';
  let lastKey = '';
  let lastWriteAt = 0;
  let wroteOnce = false;
  let warnedWrite = false;
  let authorityNote: 'fresh' | 'absent' | 'unreadable' | 'stale' | null = null;

  function readState(): AdmissionState | null {
    const text = o.readText(o.stateFile);
    const s = text === null ? null : parseAdmissionState(text);
    lastState = s;
    // ONE log line at every change of authority INTO a fail-open state — with or without a line waiting (review m2: a guard wedged for > 5 min under swap switches the function off; that must not be silent).
    // Back to a fresh state and into a fail-open one again logs again; a state that stays absent / stale logs once.
    const a: 'fresh' | 'absent' | 'unreadable' | 'stale' = text === null ? 'absent' : s === null ? 'unreadable' : stateIsFresh(s, o.now(), ttl) ? 'fresh' : 'stale';
    if (a !== authorityNote) {
      authorityNote = a;
      if (a !== 'fresh') {
        const what = a === 'absent' ? `no Admission state file (${o.stateFile})` : a === 'unreadable' ? `Admission state file ${o.stateFile} unreadable or of another version` : 'Admission state is stale (the app is gone or wedged)';
        o.log(`docker hold: ${what} — fail open: nothing is held${queue.length > 0 ? ', the waiting line is released' : ''}`);
      }
    }
    return s;
  }

  /** A fresh state with the Admission toggle ON: the only kind that gives the fleet's line a meaning. */
  function authoritativeNow(st: AdmissionState | null, t: number): boolean {
    return st !== null && stateIsFresh(st, t, ttl) && st.enabled;
  }

  function publish(force = false): void {
    if (queue.length === 0) {
      if (wroteOnce) {
        try {
          o.removeFile(o.holdFile);
        } catch {
          /* already gone */
        }
        wroteOnce = false;
        lastKey = '';
      }
      return;
    }
    const create = queue.filter((e) => e.kind === 'create').length;
    const start = queue.length - create;
    const since = queue[0].since;
    const key = `${create}/${start}/${since}`;
    const t = o.now();
    if (!force && key === lastKey && t - lastWriteAt < HEARTBEAT_MS) return;
    const hold: HoldFile = { v: 1, ts: t, create, start, since, heldSince: lastState?.heldSince ?? null, episode: lastState?.episode ?? 0, reason: lastReason };
    try {
      o.writeFile(o.holdFile, JSON.stringify(hold));
      lastKey = key;
      lastWriteAt = t;
      wroteOnce = true;
    } catch (e) {
      if (!warnedWrite) o.log(`docker hold: cannot publish ${o.holdFile}: ${(e as Error).message}`);
      warnedWrite = true;
    }
  }

  function releaseHead(flushed: boolean): void {
    const e = queue.shift();
    if (!e) return;
    e.detach();
    e.resolve({ waitedMs: Math.max(0, o.now() - e.since), reason: lastReason, ...(flushed ? { flushed: true } : {}) });
  }

  async function run(): Promise<void> {
    if (running) return;
    running = true;
    try {
      while (queue.length > 0 && !stopped) {
        const st = readState();
        const t = o.now();
        if (st !== null && stateIsFresh(st, t, ttl) && st.held) lastReason = holdReason(st);
        if (holdsNow(st, t, ttl)) {
          publish();
          await o.sleep(o.pollMs);
          continue;
        }
        // no authority (state gone / stale / foreign) or the toggle OFF ⇒ flush the whole line at once, like Admission's planRelease; otherwise ONE release per FRESH reading
        const flush = st === null || !stateIsFresh(st, t, ttl) || !st.enabled;
        if (flush) {
          releaseHead(true);
          publish();
          continue;
        }
        // OLDEST CALL FIRST across the fleet: a keeper draining a long line must not starve an older call on another keeper (it would re-take the slot before anyone else's poll lands)
        if (o.fleet?.olderWaiter(queue[0].since)) {
          publish();
          await o.sleep(o.pollMs);
          continue;
        }
        // ONE release at a time FOR THE WHOLE FLEET (review M1): take the single release slot. Another keeper holding it ⇒ wait and look again.
        if (o.lease && !o.lease.tryAcquire()) {
          publish();
          await o.sleep(o.pollMs);
          continue;
        }
        if (!mayReleaseOne(st, o.readMem())) {
          // the guard says open but a FRESH reading (taken UNDER the slot) says memory is not back far enough: stay in line (Admission's re-measure between releases)
          o.lease?.release();
          publish();
          await o.sleep(o.pollMs);
          continue;
        }
        releaseHead(false);
        publish();
        // the settle is spent HOLDING the slot, even when this keeper's line is now empty: the container just started must show in the next reading — whichever keeper takes the slot
        try {
          await o.sleep(o.settleMs);
        } finally {
          o.lease?.release();
        }
      }
    } finally {
      running = false;
      publish();
    }
  }

  return {
    admit(kind, signal): Promise<HoldAdmitted | null> {
      if (stopped || signal.aborted) return Promise.resolve(null);
      const st = readState();
      const t = o.now();
      // a newcomer passes only when nothing is held, nothing waits HERE and — with authority — no other keeper's line is in motion (Admission: a newcomer joins the line, it never jumps it)
      if (queue.length === 0 && !holdsNow(st, t, ttl) && !(authoritativeNow(st, t) && (o.fleet?.busy() ?? false))) return Promise.resolve({ waitedMs: 0, reason: null });
      if (st !== null && stateIsFresh(st, t, ttl) && st.held) lastReason = holdReason(st);
      return new Promise<HoldAdmitted | null>((resolve) => {
        const entry: Entry = {
          kind,
          since: t,
          resolve,
          detach: () => signal.removeEventListener('abort', onAbort),
        };
        const onAbort = (): void => {
          const i = queue.indexOf(entry);
          if (i < 0) return;
          queue.splice(i, 1);
          publish(true);
          resolve(null);
        };
        signal.addEventListener('abort', onAbort, { once: true });
        queue.push(entry);
        publish(true);
        void run();
      });
    },
    waiting: () => queue.length,
    holding: () => {
      if (stopped) return false;
      const st = readState();
      const t = o.now();
      return queue.length > 0 || holdsNow(st, t, ttl) || (authoritativeNow(st, t) && (o.fleet?.busy() ?? false));
    },
    stop(): void {
      stopped = true;
      o.lease?.release();
      for (const e of queue.splice(0)) {
        e.detach();
        e.resolve(null);
      }
      publish(true);
    },
  };
}
