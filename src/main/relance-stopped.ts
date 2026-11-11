// Relance (#427): the Reliquats the HOST itself stopped (Veille, Pause dure, explicit scope stop — all through `killReliquats`). Their end is NOT an event for the member: those paths
// tell it their own way (the Veille's inbox notice, the Bilan de pause), and a Relance on top would start the member the Veille just put to sleep. Keyed by process identity
// (pid:startTicks) — never by workspace — and written at the write-ahead point, BEFORE the first signal, so the sweep cannot see the end first.

const stopped = new Map<string, number>();
const KEEP_MS = 10 * 60_000;

export function noteHostStopped(idents: ReadonlyArray<{ pid: number; startTicks: number }>, now: number = Date.now()): void {
  for (const i of idents) stopped.set(`${i.pid}:${i.startTicks}`, now);
  if (stopped.size > 512) for (const [k, at] of stopped) if (now - at > KEEP_MS) stopped.delete(k);
}

export function wasStoppedByHost(key: string, now: number = Date.now()): boolean {
  const at = stopped.get(key);
  if (at === undefined) return false;
  if (now - at > KEEP_MS) {
    stopped.delete(key);
    return false;
  }
  return true;
}

export function __resetHostStoppedForTests(): void {
  stopped.clear();
}
