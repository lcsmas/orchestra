/**
 * The debugger seat (#398, ADR 0009): the ONLY file in `src/main` that touches a tab's
 * `webContents.debugger`. The CDP proxy host (`browser-cdp-host.ts`) acquires and releases the seat;
 * everything else — design mode, the legacy `mcp__browser__*` tools, agent-browser — reaches the page
 * through a proxy lease. A second `attach` on the same contents throws, so a second attacher cannot exist
 * unnoticed (`scripts/check-single-debugger-attacher.mjs` pins it). Electron-free: it takes a structural
 * `DebuggerHost`, so `node --test` drives it with a fake.
 *
 * Release policy (#395): when the last holder leaves, the debugger stays for a grace period (agent-browser
 * reconnects lazily; a legacy tool call is followed by another), then the seat undoes what an agent can leave
 * on the shared tab (`detach()` alone does not clear Emulation.*, measured on Electron 33) and detaches.
 */
import { resetCommands } from '../shared/cdp-reset.ts';
import type { CdpTabChannel } from '../shared/cdp-proxy-core.ts';

/** The slice of Electron's `Debugger` the seat uses. */
interface DebuggerLike {
  attach(protocolVersion?: string): void;
  detach(): void;
  isAttached(): boolean;
  sendCommand(method: string, params?: Record<string, unknown>, sessionId?: string): Promise<unknown>;
  on(event: string, listener: (...args: any[]) => void): unknown;
  off(event: string, listener: (...args: any[]) => void): unknown;
}
/** The slice of `Electron.WebContents` the seat uses. */
export interface DebuggerHost {
  readonly debugger: DebuggerLike;
  isDestroyed(): boolean;
  getUserAgent(): string;
}

interface Seat {
  count: number;
  /** Prefix of every trace line (`seat[<ws8>] <tab>`); the rig greps it. */
  label: string;
  /** The grace timer: set while no holder is left and the reset + detach has not run yet. */
  timer: ReturnType<typeof setTimeout> | null;
  /** An agent session held this seat: its leftovers (Emulation.*, Fetch, init scripts) get undone before the detach. Sticky until the seat is dropped. */
  reset: boolean;
  onDetach: () => void;
}
const seats = new WeakMap<DebuggerHost, Seat>();

let trace: ((line: string) => void) | null = null;
/** `ORCHESTRA_CDP_TRACE=1`: every seat transition, with Electron's own `isAttached()` read at that instant (the rig counts attaches from it). */
export function setSeatTrace(t: ((line: string) => void) | null): void {
  trace = t;
}
const note = (wc: DebuggerHost, seat: Seat, what: string): void => {
  if (!trace) return;
  let attached = false;
  try {
    attached = wc.debugger.isAttached();
  } catch {
    /* contents gone */
  }
  trace(`${seat.label} ${what} isAttached=${attached}`);
};

/** The one `attach` call. Idempotent: an attach already in place is shared, never doubled. */
function ensureAttached(wc: DebuggerHost): void {
  if (!wc.debugger.isAttached()) wc.debugger.attach('1.3');
}

/** Take (or share) the one attach on `wc`. Pair every call with one {@link seatRelease}. Says whether this call made the seat. */
export function seatAcquire(wc: DebuggerHost, label = 'seat'): 'attached' | 'shared' {
  let seat = seats.get(wc);
  const first = !seat;
  if (!seat) {
    const made: Seat = {
      count: 0,
      label,
      timer: null,
      reset: false,
      // The debugger went away under us (contents closed, tab destroyed): the seat is empty again.
      onDetach: () => {
        if (made.timer) clearTimeout(made.timer);
        if (seats.get(wc) === made) seats.delete(wc);
        wc.debugger.off('detach', made.onDetach);
      },
    };
    wc.debugger.on('detach', made.onDetach);
    seats.set(wc, made);
    seat = made;
  }
  if (seat.timer) {
    clearTimeout(seat.timer); // a holder came back inside the grace period: the reset is off
    seat.timer = null;
  }
  ensureAttached(wc);
  seat.count++;
  const what = first ? 'attached' : 'shared';
  note(wc, seat, `acquire ${what}`);
  return what;
}

function drop(wc: DebuggerHost, seat: Seat): void {
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = null;
  if (seats.get(wc) === seat) seats.delete(wc);
  try {
    wc.debugger.off('detach', seat.onDetach);
    if (!wc.isDestroyed() && wc.debugger.isAttached()) wc.debugger.detach();
  } catch {
    /* already detached / contents gone */
  }
}

async function resetAndDetach(wc: DebuggerHost, seat: Seat): Promise<void> {
  seat.timer = null;
  if (seats.get(wc) !== seat) return; // a holder coming back cancelled the timer; a force-detach dropped the seat
  note(wc, seat, seat.reset ? "grace-over reset: clearing the agent's overrides, then detaching" : 'grace-over plain: no agent session was here, detaching');
  try {
    if (wc.isDestroyed()) return;
    if (seat.reset) {
      ensureAttached(wc);
      for (const [method, params] of resetCommands(wc.getUserAgent())) {
        if (seat.count > 0 || seats.get(wc) !== seat) break; // an agent came back mid-reset: stop undoing what it is about to set
        note(wc, seat, `reset-command ${method}`);
        await wc.debugger.sendCommand(method, params).catch(() => undefined);
      }
    }
  } catch {
    /* best effort: each command is independent */
  } finally {
    // a holder may have come back while the resets were in flight: then the debugger stays
    if (seats.get(wc) === seat && seat.count === 0) {
      drop(wc, seat);
      note(wc, seat, 'detached');
    }
  }
}

/**
 * Give one hold back. The last one starts the grace period (`graceMs` > 0): after it the seat detaches — first resetting the agent's
 * overrides if an agent session held it (`agentTouched`; design mode and the legacy tools alone leave nothing to undo, so they write
 * nothing to the human's tab) — unless a holder came back; `graceMs` 0 detaches at once without the reset (tests, force paths).
 */
export function seatRelease(wc: DebuggerHost, graceMs: number, agentTouched = true): 'pending' | 'detached' | 'kept' | 'none' {
  const seat = seats.get(wc);
  if (!seat || seat.count === 0) return 'none';
  if (agentTouched) seat.reset = true;
  if (--seat.count > 0) {
    note(wc, seat, 'release kept');
    return 'kept';
  }
  if (graceMs <= 0) {
    drop(wc, seat);
    note(wc, seat, 'release detached');
    return 'detached';
  }
  if (seat.timer) clearTimeout(seat.timer);
  seat.timer = setTimeout(() => void resetAndDetach(wc, seat), graceMs);
  seat.timer.unref?.();
  note(wc, seat, 'release pending');
  return 'pending';
}

/** Detach whatever holds the seat now (the tab is being destroyed). Holds taken before are void; their release is a no-op. */
export function seatForceDetach(wc: DebuggerHost): void {
  const seat = seats.get(wc);
  if (!seat) return;
  drop(wc, seat);
  note(wc, seat, 'force-detached');
}

/** Does `wc` currently have a seat holder? (rig / test observability) */
export function seatCount(wc: DebuggerHost): number {
  return seats.get(wc)?.count ?? 0;
}

/** Is a grace timer pending on `wc` (no holder, reset + detach still to come)? (test observability) */
export function seatPending(wc: DebuggerHost): boolean {
  return !!seats.get(wc)?.timer;
}

/** The proxy's command/event channel over `wc`'s debugger. It does not attach: take the seat first. */
export function seatChannel(wc: DebuggerHost): CdpTabChannel {
  const dbg = wc.debugger;
  return {
    send: (method, params, sessionId) => dbg.sendCommand(method, params ?? {}, sessionId),
    subscribe: (l) => {
      const f = (_e: unknown, method: string, params: unknown, sessionId?: string): void => l(method, params, sessionId || undefined);
      dbg.on('message', f);
      return () => {
        dbg.off('message', f);
      };
    },
    onDetach: (l) => {
      const f = (_e: unknown, reason: string): void => l(reason);
      dbg.on('detach', f);
      return () => {
        dbg.off('detach', f);
      };
    },
  };
}
