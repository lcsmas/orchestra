// Boot-concurrency throttle (#176 D7, ledger #198).
//
// ROOT CAUSE it mitigates (docs/research/issue-176-init-hang.md §9): a fraction
// of TLS connections opened *simultaneously* to api.anthropic.com are black-holed
// at the handshake (SYN-ACK MSS 536, ClientHello never ACKed). Serial connections
// succeed; only bursts stall. When N metarepo sessions boot at once, each opens
// its connectors together and a subset wedge on init for 188–600 s. Capping how
// many opening-turn boots run at once shrinks that burst — the one product lever
// that attacks the trigger, not just the symptom.
//
// This module is the pure, Electron-free mechanism: a FIFO async semaphore of
// capacity K. `agent-sdk.ts` acquires a slot when a FRESH session is about to
// drive its opening turn (firstMessageSeen === false) and releases it the moment
// that session produces its first stream message OR fails/tears down. An ordinary
// turn on an already-started session never touches the throttle.
//
// Frozen behaviour (LEAD D7, 2026-09-28):
//   • at most K opening-turn boots in flight at once; the rest queue FIFO and
//     start as soon as one produces its first stream message OR fails;
//   • K default 3, configurable;
//   • a single spawn is NEVER delayed (K ≥ 1 ⇒ the first acquire resolves
//     synchronously when no other boot is in flight).

export const DEFAULT_BOOT_THROTTLE_K = 3;

/** Resolve the configured K from an env-like bag (ORCHESTRA_BOOT_THROTTLE_K).
 *  Invalid / absent / non-positive → the default. K is clamped to ≥ 1 so the
 *  single-spawn path can never be starved (K = 0 would deadlock every boot). */
export function resolveBootThrottleK(
  env: Record<string, string | undefined> = {},
  fallback: number = DEFAULT_BOOT_THROTTLE_K,
): number {
  const raw = env.ORCHESTRA_BOOT_THROTTLE_K;
  if (raw == null || raw === '') return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n) || n < 1) return fallback;
  return n;
}

/** A slot held by one opening-turn boot. Releasing it is idempotent: a boot that
 *  both sees its first message AND then tears down must not free two slots. */
export interface BootSlot {
  release(): void;
}

/** FIFO async semaphore. `acquire()` resolves immediately while fewer than K
 *  slots are held, otherwise queues the caller; each `release()` hands the freed
 *  slot to the oldest waiter. Not reentrant and not thread-shared — it models the
 *  single main-process event loop, where all boots are driven from one thread. */
export class BootThrottle {
  private readonly capacity: number;
  private inFlight = 0;
  private readonly waiters: Array<() => void> = [];

  constructor(capacity: number = DEFAULT_BOOT_THROTTLE_K) {
    // A capacity < 1 would wedge every boot forever — refuse it, the same reason
    // resolveBootThrottleK clamps. This is the illegitimate case the guard admits
    // if left unchecked (LESSONS: name the case a tightened guard would cut off).
    this.capacity = Math.max(1, Math.floor(capacity));
  }

  /** Number of slots currently held (opening-turn boots in flight). */
  get held(): number {
    return this.inFlight;
  }

  /** Number of boots parked waiting for a slot. */
  get queued(): number {
    return this.waiters.length;
  }

  get k(): number {
    return this.capacity;
  }

  /** Acquire a slot. Resolves synchronously (a microtask) when a slot is free —
   *  so a lone boot is never delayed — else when an earlier boot releases. The
   *  returned BootSlot MUST be released exactly once (idempotent if called more).
   */
  acquire(): Promise<BootSlot> {
    if (this.inFlight < this.capacity) {
      this.inFlight++;
      return Promise.resolve(this.makeSlot());
    }
    return new Promise<BootSlot>((resolve) => {
      this.waiters.push(() => {
        this.inFlight++;
        resolve(this.makeSlot());
      });
    });
  }

  private makeSlot(): BootSlot {
    let released = false;
    return {
      release: () => {
        if (released) return; // idempotent: first-message AND teardown both call it
        released = true;
        this.inFlight--;
        const next = this.waiters.shift();
        // Hand the freed slot straight to the oldest waiter (which re-increments
        // inFlight inside its resolver), keeping FIFO order and the invariant
        // inFlight ≤ capacity at every await boundary.
        if (next) next();
      },
    };
  }
}
