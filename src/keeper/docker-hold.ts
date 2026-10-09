// The keeper's Docker HOLD gate (#321, wave H ledger #329; pure half: src/shared/docker-hold.ts). A container create/start the relay is about to forward WAITS here while the app-published Admission state
// says held, and goes out BY ITSELF when memory is back — never refused. Same retention semantics as Admission (#286): a newcomer joins the line while one exists, the line is released FIFO ONE AT A TIME,
// each release preceded by a FRESH MemAvailable reading (`mayReleaseOne`) and followed by a settle so the container just started shows in the next reading.
//
// Fail-open by construction: no state file, an unreadable one, another version, or one older than the TTL (the app that decides is gone) ⇒ nothing is held and a line already waiting is flushed at once. A client
// that gives up (its connection closes) simply leaves the line — its create is never sent.
//
// While anything waits the gate publishes `<ws>.docker.hold` (count / oldest since / reason; refreshed ≥ every 5 s) for the app's `bus-status` and the member's coordinator, and removes it when the line is empty.
// Electron-free; every clock / file / meter is injected so node --test drives the real code.

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
  let authorityNote: 'fresh' | 'none' | null = null;
  let unreadableLogged = false;

  function readState(): AdmissionState | null {
    const text = o.readText(o.stateFile);
    const s = text === null ? null : parseAdmissionState(text);
    lastState = s;
    // a file that is THERE but cannot be read (torn, garbage, another version): fail open AND say so — once until it reads again (the app writes it atomically, so this is not expected)
    if (text !== null && s === null) {
      if (!unreadableLogged) o.log(`docker hold: Admission state file ${o.stateFile} unreadable or of another version — treated as no hold (fail open)`);
      unreadableLogged = true;
    } else {
      unreadableLogged = false;
    }
    // one log line per change of authority (a keeper log, not a flood)
    const now: 'fresh' | 'none' = s !== null && stateIsFresh(s, o.now(), ttl) ? 'fresh' : 'none';
    if (now !== authorityNote) {
      authorityNote = now;
      if (now === 'none' && queue.length > 0) o.log(`docker hold: no authoritative Admission state (${text === null ? 'file absent' : s === null ? 'unreadable or another version' : 'stale'}) — releasing the line`);
    }
    return s;
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
        if (!flush && !mayReleaseOne(st, o.readMem())) {
          // the guard says open but a FRESH reading says memory is not back far enough: stay in line (Admission's re-measure between releases)
          publish();
          await o.sleep(o.pollMs);
          continue;
        }
        releaseHead(flush);
        publish();
        // with authority each release is followed by a settle (the start must show in the next reading)
        if (queue.length > 0 && !flush) await o.sleep(o.settleMs);
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
      if (queue.length === 0 && !holdsNow(st, t, ttl)) return Promise.resolve({ waitedMs: 0, reason: null });
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
    holding: () => !stopped && (queue.length > 0 || holdsNow(readState(), o.now(), ttl)),
    stop(): void {
      stopped = true;
      for (const e of queue.splice(0)) {
        e.detach();
        e.resolve(null);
      }
      publish(true);
    },
  };
}
