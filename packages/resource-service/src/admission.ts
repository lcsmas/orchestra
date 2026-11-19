// Admission (A3): the PURE decision (memory, disk, both) and the wait loop around it. No process env, no clock, no filesystem here —
// the verb injects the readings, so every branch is testable without waiting for the machine to change.

export type Reading = { memFree: number; diskFree: number };
/** `memSrc`/`diskSrc` name where a threshold came from when it is NOT the env/default (the admit.conf file), so a message can say so. */
export type Thresholds = { minMem: number; minDisk: number; memSrc?: string; diskSrc?: string };
export type Shortage = { resource: 'memory' | 'disk'; free: number; min: number; src?: string };
export type Decision = { admit: boolean; short: Shortage[] };

/** Admitted iff free ≥ threshold for BOTH resources (equal passes); `short` names each resource that is below its threshold. */
export function decide(r: Reading, t: Thresholds): Decision {
  const short: Shortage[] = [];
  if (!(r.memFree >= t.minMem)) short.push({ resource: 'memory', free: r.memFree, min: t.minMem, src: t.memSrc });
  if (!(r.diskFree >= t.minDisk)) short.push({ resource: 'disk', free: r.diskFree, min: t.minDisk, src: t.diskSrc });
  return { admit: short.length === 0, short };
}

/** `MemAvailable` of a /proc/meminfo text, in bytes (the kernel's estimate of memory a new workload can use without swapping). */
export function parseMemAvailable(meminfo: string): number {
  const m = /^MemAvailable:\s+(\d+)\s*kB\s*$/m.exec(meminfo);
  if (!m) throw new Error('MemAvailable not found in /proc/meminfo');
  return Number(m[1]) * 1024;
}

/** Bytes as `3.2G` / `512M` (powers of 1024, the same letters the thresholds are written in). */
export function formatSize(bytes: number): string {
  const units: [string, number][] = [['T', 1024 ** 4], ['G', 1024 ** 3], ['M', 1024 ** 2], ['K', 1024]];
  for (const [u, n] of units) {
    if (bytes >= n) return `${Math.floor((bytes / n) * 10) / 10}${u}`; // floor: a value just under its threshold never prints as equal to it
  }
  return `${Math.max(0, Math.round(bytes))}B`;
}

export function formatElapsed(ms: number): string {
  const s = Math.floor(ms / 1000);
  if (s < 60) return `${s}s`;
  const m = Math.floor(s / 60);
  return m < 60 ? `${m}m${s % 60}s` : `${Math.floor(m / 60)}h${m % 60}m`;
}

/** `free memory: 3.2G < 6G; free disk: 4G < 10G` */
export function shortPhrase(short: Shortage[]): string {
  return short.map((s) => `free ${s.resource}: ${formatSize(s.free)} < ${formatSize(s.min)}${s.src ? ` (${s.src})` : ''}`).join('; ');
}

export type WaitOptions = {
  read: () => Reading;
  /** Re-read at every poll: a threshold lowered while `admit` waits takes effect. */
  thresholds: () => Thresholds;
  now: () => number;
  sleep: (ms: number) => Promise<void>;
  pollMs: number;
  reportMs: number;
  /** Give up after this long (0 = look once, never wait); undefined = wait forever. */
  timeoutMs?: number;
  say: (line: string) => void;
};
export type WaitResult = { admitted: boolean; waitedMs: number; last: Decision; reading: Reading; thresholds: Thresholds };

/** Check, and while short: say what is waited for (at once, then every `reportMs` or when the set of short resources changes), re-measure every `pollMs`. */
export async function waitForAdmission(o: WaitOptions): Promise<WaitResult> {
  const t0 = o.now();
  let lastSaid = -Infinity;
  let lastKey = '';
  for (;;) {
    const reading = o.read();
    const thresholds = o.thresholds();
    const last = decide(reading, thresholds);
    const waitedMs = o.now() - t0;
    if (last.admit) return { admitted: true, waitedMs, last, reading, thresholds };
    if (o.timeoutMs !== undefined && waitedMs >= o.timeoutMs) return { admitted: false, waitedMs, last, reading, thresholds };
    const key = last.short.map((s) => `${s.resource}<${s.min}${s.src ?? ''}`).join(','); // a changed threshold is said at once
    if (key !== lastKey || o.now() - lastSaid >= o.reportMs) {
      o.say(`waiting for ${shortPhrase(last.short)} (since ${new Date(t0).toISOString()}, ${formatElapsed(waitedMs)} elapsed)`);
      lastSaid = o.now();
      lastKey = key;
    }
    const left = o.timeoutMs === undefined ? o.pollMs : Math.min(o.pollMs, Math.max(0, o.timeoutMs - waitedMs));
    await o.sleep(left);
  }
}
