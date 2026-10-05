// Fleet Pause UI (#257) — the push scheduler: a debounce WITH a max-wait. A bus-directory watch fires on every write; a plain trailing debounce starves under sustained writes (≥ 1 write per debounce
// window ⇒ no push until the writer stops — measured: ≥ 7 writes/s ⇒ 3.5 s of silence, review R1-5). Here the first event of a burst arms a timer of `debounceMs`, every further event re-arms it, but never
// past `maxWaitMs` after the FIRST pending event: a push lands at least every `maxWaitMs` however busy the bus is. Pure over injected timers so it is tested without a clock.

export interface CoalescerDeps {
  now: () => number;
  setTimer: (fn: () => void, ms: number) => unknown;
  clearTimer: (t: unknown) => void;
}

export interface Coalescer {
  /** An event happened (a bus write): make sure `run` fires soon. */
  poke(): void;
  /** Drop a pending fire (stop / quit). */
  cancel(): void;
}

export function createCoalescer(run: () => void, opts: { debounceMs: number; maxWaitMs: number }, deps: CoalescerDeps): Coalescer {
  let timer: unknown = null;
  let pendingSince = 0;
  const fireNow = () => {
    timer = null;
    pendingSince = 0;
    run();
  };
  return {
    poke() {
      const now = deps.now();
      if (timer === null) pendingSince = now;
      else deps.clearTimer(timer);
      const wait = Math.max(0, Math.min(opts.debounceMs, pendingSince + opts.maxWaitMs - now));
      timer = deps.setTimer(fireNow, wait);
    },
    cancel() {
      if (timer !== null) deps.clearTimer(timer);
      timer = null;
      pendingSince = 0;
    },
  };
}
