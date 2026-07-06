/**
 * Pure backoff math for the sandbox reconnect policy (P4 item D). No I/O, no
 * timers — sandbox-manager.ts owns the loop; this owns the schedule, so the
 * schedule is unit-testable without electron or sockets.
 *
 * Shape: exponential with a per-attempt cap and an overall give-up window.
 * The shim keeps sessions running while no client is attached, so reconnecting
 * is always safe — the window only bounds how long the HOST keeps terminals
 * frozen-but-alive before unwinding them with EXIT_CONNECTION_LOST.
 */

export interface BackoffPolicy {
  /** First retry delay. */
  baseMs: number;
  /** Multiplier per attempt. */
  factor: number;
  /** Ceiling for any single delay. */
  maxDelayMs: number;
  /** Total time (including the delay about to be slept) before giving up. */
  maxElapsedMs: number;
}

/** 1s → 2s → 4s → 8s → 16s → 30s → 30s … give up after 3 minutes. */
export const DEFAULT_BACKOFF: BackoffPolicy = {
  baseMs: 1_000,
  factor: 2,
  maxDelayMs: 30_000,
  maxElapsedMs: 180_000,
};

/** Delay before retry number `attempt` (0-based). */
export function backoffDelayMs(attempt: number, policy: BackoffPolicy = DEFAULT_BACKOFF): number {
  const raw = policy.baseMs * Math.pow(policy.factor, Math.max(0, attempt));
  return Math.min(policy.maxDelayMs, Math.round(raw));
}

/** True when the loop should stop retrying. Called BEFORE sleeping with the
 *  elapsed time the upcoming delay would bring us to, so we never sleep past
 *  the window just to fail on wake. */
export function shouldGiveUp(
  elapsedMsIncludingNextDelay: number,
  policy: BackoffPolicy = DEFAULT_BACKOFF,
): boolean {
  return elapsedMsIncludingNextDelay > policy.maxElapsedMs;
}
