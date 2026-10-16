// Serialise async work per key, FIFO. Pure: no Electron, no node:*.
// First user: createWorkspace's branch allocation (#382 follow-up) — "pick a free name" and "create the branch" must be ONE step
// per repo, else parallel spawns of the same name all see it free and the losers fail on git.

export interface KeyedLock {
  /** Run `fn` after every earlier `run` on the same `key` settled; runs on other keys are never delayed. A throw/reject in
   *  `fn` is that caller's alone — it never wedges the queue behind it. */
  run<T>(key: string, fn: () => Promise<T>): Promise<T>;
  /** Keys with work queued or running (the map shrinks back to 0 once idle — no leak per repo). */
  pending(): number;
}

export function createKeyedLock(): KeyedLock {
  const tails = new Map<string, Promise<void>>();
  return {
    async run<T>(key: string, fn: () => Promise<T>): Promise<T> {
      const prev = tails.get(key) ?? Promise.resolve();
      let release!: () => void;
      const mine = new Promise<void>((r) => (release = r));
      const tail = prev.then(() => mine);
      tails.set(key, tail);
      await prev;
      try {
        return await fn();
      } finally {
        release();
        if (tails.get(key) === tail) tails.delete(key);
      }
    },
    pending: () => tails.size,
  };
}
