// The process chain of the `orchestra run pause` call (#252 D1b, review F5): recorded by the CLI at pause time so the host trap can tell WHICH
// member's tool issued the pause (spare that tool tree only) from a human typing `--as <coordinator>` in a plain shell (spare nothing).
// Identity is pid + /proc start-time; the trap re-verifies both against the live CLI. Linux only (elsewhere: empty chain ⇒ nobody is spared).

import fs from 'node:fs';
import { parseProcIdent } from '../shared/pause-procs.ts';
import type { PauseOriginProc } from './bus-pause-records.ts';

export function readProcessChain(
  startPid: number = process.pid,
  readStat: (pid: number) => string | null = (pid) => {
    try {
      return fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    } catch {
      return null;
    }
  },
  maxDepth = 48,
): PauseOriginProc[] {
  const out: PauseOriginProc[] = [];
  const seen = new Set<number>();
  let pid = startPid;
  while (pid > 1 && !seen.has(pid) && out.length < maxDepth) {
    seen.add(pid);
    const text = readStat(pid);
    const p = text === null ? null : parseProcIdent(text, null);
    if (!p) break;
    out.push({ pid: p.pid, ppid: p.ppid, startTicks: p.startTicks, comm: p.comm });
    pid = p.ppid;
  }
  return out;
}
