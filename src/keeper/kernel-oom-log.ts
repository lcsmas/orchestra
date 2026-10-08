// #322 m2: the kernel's own record of a memcg OOM kill, read from the journal (`journalctl -k`) — it names the victim's pid and comm, which `memory.events` never does.
// Readable by an unprivileged user in the `wheel`/`adm`/`systemd-journal` group (measured on this host); elsewhere the journal shows nothing and the caller keeps its inference.

import { execFile } from 'node:child_process';
import { parseKernelOomMessage, type KernelOomKill } from '../shared/memory-scope.ts';

/** Parse `journalctl -o json` output (one object per line) into memcg oom-kill lines. Garbage lines are skipped. */
export function parseJournalJson(stdout: string): KernelOomKill[] {
  const out: KernelOomKill[] = [];
  for (const line of stdout.split('\n')) {
    if (!line.trim()) continue;
    try {
      const j = JSON.parse(line) as { MESSAGE?: unknown; __REALTIME_TIMESTAMP?: unknown };
      if (typeof j.MESSAGE !== 'string') continue; // journald encodes a non-UTF8 message as a byte array
      const us = Number(j.__REALTIME_TIMESTAMP);
      const k = parseKernelOomMessage(j.MESSAGE, Number.isFinite(us) ? Math.round(us / 1000) : 0);
      if (k) out.push(k);
    } catch {
      /* a torn line */
    }
  }
  return out;
}

/** The memcg OOM kills in the kernel log since `sinceMs`; null when `journalctl` cannot run (missing, timeout, unreadable). `[]` = nothing matched (journalctl exits 1 on no match). */
export function readKernelOomKills(sinceMs: number): Promise<KernelOomKill[] | null> {
  return new Promise((resolve) => {
    const since = `@${Math.max(0, Math.floor(sinceMs / 1000))}`;
    execFile(
      'journalctl',
      ['-k', '--no-pager', '-q', '-o', 'json', '--grep', 'oom-kill:constraint=CONSTRAINT_MEMCG', '--since', since],
      { timeout: 4000, maxBuffer: 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } },
      (err, stdout) => {
        if (err && (err as { code?: unknown }).code !== 1) return resolve(null); // exit 1 = «no match»; anything else (ENOENT, timeout, killed) = unreadable
        resolve(parseJournalJson(String(stdout ?? '')));
      },
    );
  });
}
