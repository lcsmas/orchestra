// The memory guard's REAL MemAvailable source (#285). Platform-free (fs only) so node --test imports it.
// Linux only: /proc/meminfo MemAvailable (compressed swap already counted — epic #284). Other platforms read null = UNMEASURED
// (the guard then holds nothing): os.freemem() is NOT an equivalent (macOS "free" excludes reclaimable cache and sits far below 3 GB).

import fs from 'node:fs';
import { parseMemAvailableBytes } from '../shared/memory-guard.ts';

/** MemAvailable in bytes; null when unreadable or not Linux — never a fabricated figure. */
export function readMemAvailableBytes(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    return parseMemAvailableBytes(fs.readFileSync('/proc/meminfo', 'utf8'));
  } catch {
    return null;
  }
}

/** MemTotal in bytes (gauge scale for Settings); null when unreadable or not Linux. */
export function readMemTotalBytes(): number | null {
  if (process.platform !== 'linux') return null;
  try {
    const m = /^MemTotal:\s+(\d+)\s+kB/m.exec(fs.readFileSync('/proc/meminfo', 'utf8'));
    return m ? Number(m[1]) * 1024 : null;
  } catch {
    return null;
  }
}
