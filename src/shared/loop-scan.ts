// Loop detection from a session TRANSCRIPT tail — pure logic (node-testable).
//
// Why this exists when activity.ts already detects `ScheduleWakeup` live: a
// /loop's iterations do not necessarily run under Orchestra. Claude Code's
// daemon (CLI ≥2.1.233, `claude daemon run`) re-invokes a session at wakeup
// time in its own process tree — no `ORCHESTRA_WS_ID` in the env, so the spool
// hook exits without writing, and no attached SDK stream, so `emitFrom` never
// sees the tool call. Ground truth that survives all of that is the session's
// transcript JSONL: every iteration appends its `ScheduleWakeup` tool_use with
// the full input. Scanning the tail answers "is this session looping?" for
// sessions Orchestra cannot observe live — including loops that predate the
// feature and loops whose flag state decayed while the app was closed.
//
// The verdict is FOUR-state, not a boolean, because absence of evidence in a
// bounded tail window is not evidence of absence (`unknown` must never clear
// an existing flag), and an armed wakeup whose fire time has long passed means
// the loop's host died (`stale` — a badge for it would advertise a loop that
// can never tick again).

/** How far past an armed wakeup's due time we keep believing the loop is
 *  alive. Generous on purpose: the wakeup fires, the iteration RUNS (minutes),
 *  and only then does a fresh ScheduleWakeup extend the horizon — plus the
 *  daemon may fire late under load. Past this, the scheduler that owned the
 *  wakeup is presumed dead and the loop with it. */
export const LOOP_STALE_SLACK_MS = 30 * 60 * 1000;

/** Fallback horizon when an armed ScheduleWakeup carries no usable
 *  `delaySeconds` — the runtime clamps real delays to [60, 3600], so assume
 *  the max rather than inventing a shorter one. */
export const LOOP_DEFAULT_DELAY_MS = 3600 * 1000;

export interface LoopScanVerdict {
  /** looping — last ScheduleWakeup is armed and its fire window is still
   *  believable; stopped — last ScheduleWakeup carried `stop: true`;
   *  stale — armed, but `due + slack` has passed (host presumed dead);
   *  unknown — no ScheduleWakeup in the scanned tail (says NOTHING about the
   *  session — the window is bounded). */
  state: 'looping' | 'stopped' | 'stale' | 'unknown';
  /** Epoch ms of the deciding ScheduleWakeup entry (its transcript
   *  timestamp), for `loopingSince` backfill. Absent for `unknown`. */
  at?: number;
}

/** Scan a transcript TAIL (newest-last JSONL text; partial first line fine —
 *  it is skipped as malformed) for the session's loop state at `nowMs`.
 *
 *  The LAST main-chain assistant `ScheduleWakeup` tool_use decides: a loop
 *  re-arms (or stops) every iteration, so the newest call is the whole truth.
 *  Sidechain (subagent) entries are skipped — a subagent cannot own the
 *  session's loop. Malformed lines are skipped, never thrown on. */
export function scanTranscriptTailForLoop(tail: string, nowMs: number): LoopScanVerdict {
  const lines = tail.split('\n');
  for (let i = lines.length - 1; i >= 0; i--) {
    const line = lines[i];
    // Cheap pre-filter — parsing every line of a 256KiB tail is wasteful.
    if (!line.includes('"ScheduleWakeup"')) continue;
    let entry: {
      type?: unknown;
      isSidechain?: unknown;
      timestamp?: unknown;
      message?: { content?: unknown };
    };
    try {
      entry = JSON.parse(line) as typeof entry;
    } catch {
      continue; // truncated first line of the tail window, or garbage
    }
    if (entry.type !== 'assistant') continue;
    if (entry.isSidechain === true) continue;
    const content = entry.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as Array<Record<string, unknown>>) {
      if (block?.type !== 'tool_use' || block.name !== 'ScheduleWakeup') continue;
      const input = (block.input ?? {}) as Record<string, unknown>;
      const at = typeof entry.timestamp === 'string' ? Date.parse(entry.timestamp) : NaN;
      const atMs = Number.isFinite(at) ? at : undefined;
      if (input.stop === true) return { state: 'stopped', at: atMs };
      const delay = typeof input.delaySeconds === 'number' && input.delaySeconds > 0
        ? input.delaySeconds * 1000
        : LOOP_DEFAULT_DELAY_MS;
      // No timestamp → cannot judge staleness; err toward believing the loop
      // (the flag clears via the stop/process rules if it is wrong).
      if (atMs === undefined) return { state: 'looping' };
      return nowMs > atMs + delay + LOOP_STALE_SLACK_MS
        ? { state: 'stale', at: atMs }
        : { state: 'looping', at: atMs };
    }
  }
  return { state: 'unknown' };
}
