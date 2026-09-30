// Process identity from /proc (Linux) for the account-migration stop (#240). Leaf module so `node --test` loads it.
// A FAILED read is never "gone": only ENOENT/ESRCH say the process is absent — EMFILE/EACCES/EIO/ENOMEM say nothing
// (review r3 F2: an fd-exhausted app read every live child as gone → no SIGKILL, latch dropped, transcripts moved under it).
import fs from 'node:fs';
import { isSameLiveProcess } from '../shared/resource-monitor.ts';
import { parseProcIdentity } from '../shared/resources.ts';

/** `/proc/<pid>/stat`: the text; `null` = the process is DEFINITELY absent; `undefined` = UNKNOWN (the read failed for another reason). */
export type StatRead = string | null | undefined;

export function readProcStat(pid: number, readFile: (p: string, enc: 'utf8') => string = fs.readFileSync): StatRead {
  try {
    return readFile(`/proc/${pid}/stat`, 'utf8');
  } catch (e) {
    const code = (e as NodeJS.ErrnoException | null)?.code;
    return code === 'ENOENT' || code === 'ESRCH' ? null : undefined;
  }
}

/** The start-time (clock ticks) in a stat read, or undefined (no /proc — macOS/Windows —, unreadable, unparsable). */
export function procStartTicks(read: StatRead): number | undefined {
  return typeof read === 'string' ? parseProcIdentity(read)?.startTicks : undefined;
}

/** true = still the SAME live process; false = definitely not (exited, zombie, pid recycled, absent); undefined = cannot tell. */
export function sameLiveProcess(startTicks: number, read: StatRead): boolean | undefined {
  if (read === undefined) return undefined;
  return isSameLiveProcess(startTicks, read);
}
