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

/** Options of {@link readKernelOomKills}. The keeper's own lookups (a few seconds back) use none. */
export interface KernelLogOpts {
  /** A regex (PCRE) the line must ALSO match — the APP's lookup of a scope's backstop kill reads a window of hours or days, so it asks only for its own scopes' lines (journalctl greps before it prints). */
  match?: string;
  /** Output cap (default 4 MiB). */
  maxBufferBytes?: number;
  /** Time cap (default 4 s). */
  timeoutMs?: number;
  /** Read every boot still in the journal, not just the current one (`journalctl -k` implies `-b`): the APP asks about scopes that may have ended before a reboot. */
  allBoots?: boolean;
}

/** The memcg OOM kills in the kernel log since `sinceMs`; null when `journalctl` cannot run (missing, timeout, unreadable, output over the cap). `[]` = nothing matched (journalctl exits 1 on no match). */
export function readKernelOomKills(sinceMs: number, opts: KernelLogOpts = {}): Promise<KernelOomKill[] | null> {
  return new Promise((resolve) => {
    const since = `@${Math.max(0, Math.floor(sinceMs / 1000))}`;
    execFile(
      'journalctl',
      // no `-q`: it hides the « inaccessible journal » warnings, and exit 1 alone cannot tell « nothing matched » (stderr empty) from « the journal cannot be read / has no entries » (stderr says so)
      ['-k', ...(opts.allBoots ? ['-b', 'all'] : []), '--no-pager', '-o', 'json', '--grep', opts.match ? `oom-kill:constraint=CONSTRAINT_MEMCG.*(${opts.match})` : 'oom-kill:constraint=CONSTRAINT_MEMCG', '--since', since],
      { timeout: opts.timeoutMs ?? 4000, maxBuffer: opts.maxBufferBytes ?? 4 * 1024 * 1024, env: { PATH: process.env.PATH ?? '/usr/bin:/bin', LC_ALL: 'C' } },
      (err, stdout, stderr) => {
        if (err && (err as { code?: unknown }).code !== 1) return resolve(null); // anything but exit 1 (ENOENT, timeout, killed, buffer overflow) = unreadable
        // exit 1 with a message on stderr (« No journal files were opened due to insufficient permissions », « No journal boot entry found … ») is UNKNOWN, never « nothing matched » (#343 review M4)
        if (err && String(stderr ?? '').trim() !== '') return resolve(null);
        resolve(parseJournalJson(String(stdout ?? '')));
      },
    );
  });
}
