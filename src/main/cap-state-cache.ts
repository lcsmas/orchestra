// #343 (gap 2 + review M3) — what each keeper last said about its own cap (`unprotected` = its tools are not confined to the capped leaf), as the app knows it. Three sources: the keeper's `capState` PUSH (an attached
// client sees a flip at once), every `helloAck.cap`, and — for a keeper NOBODY is attached to (attach is lazy: after an app restart the Resources page lists live keepers long before any session attaches) — a one-shot
// PROBE, refreshed when the entry is older than the TTL. Electron-free; the probe, the clock and the log are injected so node --test drives the real logic.

export interface CapStateValue {
  unit: string;
  state: 'active' | 'unprotected' | 'not-applied' | 'no-scope';
  hardBytes: number;
}

export interface CapStateCacheDeps {
  /** One-shot probe of a keeper (`probeKeeper`); null = it did not answer. */
  probe(wsId: string): Promise<{ cap?: CapStateValue } | null>;
  now(): number;
  log: { warn(wsId: string, m: string): void };
  /** Words for a state change (`describeCapState`). */
  describe(cap: CapStateValue): string;
}

export const CAP_STATE_TTL_MS = 30_000;

export interface CapStateCache {
  /** The latest known state of `wsId`'s keeper; null = unknown or « launched without a cap ». */
  of(wsId: string): CapStateValue | null;
  /** A value the keeper told us (push / helloAck / probe). A CHANGE inside one scope is logged. */
  remember(wsId: string, cap: CapStateValue): void;
  /** Probe every keeper whose entry is missing or older than the TTL (one in flight per workspace). Fire and forget; never throws. */
  refresh(wsIds: readonly string[]): void;
  /** Test seam: the probes still running. */
  idle(): Promise<void>;
}

export function createCapStateCache(deps: CapStateCacheDeps): CapStateCache {
  const entries = new Map<string, { cap: CapStateValue | null; at: number }>();
  const inflight = new Map<string, Promise<void>>();
  return {
    of: (wsId) => entries.get(wsId)?.cap ?? null,
    remember(wsId, cap) {
      const prev = entries.get(wsId)?.cap ?? null;
      entries.set(wsId, { cap, at: deps.now() });
      // a CHANGE of state inside one scope (the placement tripwire: active → unprotected) is news; the first value is logged by the launch
      if (prev && prev.unit === cap.unit && prev.state !== cap.state) deps.log.warn(wsId, `cap state changed ${prev.state} → ${cap.state} — ${deps.describe(cap)}`);
    },
    refresh(wsIds) {
      const t = deps.now();
      for (const wsId of wsIds) {
        const e = entries.get(wsId);
        if (e && t - e.at >= 0 && t - e.at < CAP_STATE_TTL_MS) continue;
        if (inflight.has(wsId)) continue;
        const p = (async () => {
          try {
            const pr = await deps.probe(wsId);
            if (!pr) return; // no answer: keep what we knew, try again at the next look
            if (pr.cap) this.remember(wsId, pr.cap);
            else entries.set(wsId, { cap: null, at: deps.now() }); // answered, launched WITHOUT a cap: remembered, so a poll does not probe it every 2 s
          } catch {
            /* a probe that throws is « no answer » */
          } finally {
            inflight.delete(wsId);
          }
        })();
        inflight.set(wsId, p);
      }
    },
    idle: async () => {
      await Promise.all([...inflight.values()]);
    },
  };
}
