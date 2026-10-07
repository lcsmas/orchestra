// Run an async job now, or — when a run is already in flight — exactly ONE more right after it (#288). Two runs never overlap (the Veille
// sweep would stop the same session twice) and a request that lands mid-run is never lost (a hold that began after the run read the guard).

export interface CoalescedRunner {
  /** Start a run, or fold into the single re-run owed after the one in flight. Never throws, never returns a promise. */
  request(): void;
  /** True while a run (or its owed re-run) is in flight. */
  busy(): boolean;
}

export function coalescedRunner(job: () => Promise<unknown>, onError: (e: unknown) => void): CoalescedRunner {
  let inFlight: Promise<void> | null = null;
  let again = false;
  return {
    request() {
      if (inFlight) {
        again = true;
        return;
      }
      inFlight = (async () => {
        do {
          again = false;
          try {
            await job();
          } catch (e) {
            onError(e);
          }
        } while (again);
      })().finally(() => {
        inFlight = null;
      });
    },
    busy: () => inFlight !== null,
  };
}
