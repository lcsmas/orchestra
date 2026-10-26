/**
 * In-flight commands per CDP child session. Chromium never answers a command whose session died while it was in flight, and Electron keeps that
 * `debugger.sendCommand` promise pending until the WHOLE debugger detaches — so a client that waits for the reply (agent-browser's attach-time
 * chain `Page.enable → Runtime.enable → …` on an iframe that is removed a few ms after it appeared) sits there for its own timeout (ledger #405,
 * seat-1 `tchurn`). The proxy settles those commands itself the moment it announces the session's detach.
 */
export class SessionPending {
  private readonly bySession = new Map<string, Set<() => void>>();
  /** Sessions whose detach was announced (bounded, oldest first out): a command for one is refused at once, never forwarded into the void (ids are random, never reused). */
  private readonly retired = new Set<string>();

  private readonly retiredCap: number;

  constructor(retiredCap = 1024) {
    this.retiredCap = retiredCap;
  }

  /** Run `send` for `sessionId`. Its outcome is the result unless `abort(sessionId)` comes first: then the result rejects with `onAbort()` and the late outcome is dropped. */
  track<T>(sessionId: string, send: () => Promise<T>, onAbort: () => Error): Promise<T> {
    if (this.retired.has(sessionId)) return Promise.reject(onAbort());
    return new Promise<T>((resolve, reject) => {
      let done = false;
      let set = this.bySession.get(sessionId);
      if (!set) this.bySession.set(sessionId, (set = new Set()));
      const mine = set;
      const finish = (): boolean => {
        if (done) return false;
        done = true;
        mine.delete(abort);
        if (mine.size === 0) this.bySession.delete(sessionId);
        return true;
      };
      const abort = (): void => {
        if (finish()) reject(onAbort());
      };
      mine.add(abort);
      let p: Promise<T>;
      try {
        p = send();
      } catch (e) {
        if (finish()) reject(e);
        return;
      }
      p.then(
        (r) => {
          if (finish()) resolve(r);
        },
        (e) => {
          if (finish()) reject(e);
        },
      );
    });
  }

  /** The session is gone: settle everything still in flight on it and refuse what comes later. Returns how many commands were settled. */
  abort(sessionId: string): number {
    this.retired.add(sessionId);
    if (this.retired.size > this.retiredCap) this.retired.delete(this.retired.values().next().value as string);
    const set = this.bySession.get(sessionId);
    if (!set) return 0;
    const all = [...set];
    for (const a of all) a();
    return all.length;
  }

  /** Commands in flight on `sessionId` (all sessions when omitted). */
  size(sessionId?: string): number {
    if (sessionId !== undefined) return this.bySession.get(sessionId)?.size ?? 0;
    let n = 0;
    for (const s of this.bySession.values()) n += s.size;
    return n;
  }
}
