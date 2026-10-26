// Process identity for rigs that must signal ONLY processes they started: a pid alone is not an identity (pids are reused), a (pid, start time)
// pair is. No host-wide /proc scan lives here: every function takes a pid the caller already obtained from its own children / a private bus.
import fs from 'node:fs';

/** `{ state, start }` of a process (start = field 22 of the process's stat file, in clock ticks since boot), or null when it does not exist. */
export function procStat(pid) {
  try {
    const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8').replace(/^.*\) /, '').split(' ');
    return { state: f[0], start: f[19] };
  } catch {
    return null;
  }
}

/** True only for the SAME process that was recorded: alive (not a zombie) and still carrying the recorded start time. */
export function isAlive(pid, start) {
  const s = procStat(pid);
  return !!s && s.state !== 'Z' && s.start === start;
}

/** Every pid below `root` (inclusive), read from each task's `children` file — descendants only, no scan of unrelated processes. */
export function descendantsOf(root) {
  const seen = new Set([root]);
  const stack = [root];
  while (stack.length) {
    const p = stack.pop();
    try {
      for (const t of fs.readdirSync(`/proc/${p}/task`)) {
        for (const k of fs.readFileSync(`/proc/${p}/task/${t}/children`, 'utf8').trim().split(/\s+/).filter(Boolean).map(Number)) {
          if (!seen.has(k)) { seen.add(k); stack.push(k); }
        }
      }
    } catch {}
  }
  return [...seen];
}

/** Signal `pid` only if it is still the process recorded as (pid, start) — the identity is re-read AT SIGNAL TIME. Returns whether a signal was sent. */
export function signalIfSame(pid, start, sig) {
  if (!isAlive(pid, start)) return false;
  try { process.kill(pid, sig); return true; } catch { return false; }
}
