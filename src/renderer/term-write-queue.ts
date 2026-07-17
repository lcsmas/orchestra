/**
 * PTY→xterm write scheduler shared by Terminal.tsx and RunTerminal.tsx.
 *
 * Solves two problems at once:
 *
 * 1. Big bursts must not jank the renderer. A large tool-result dump entering
 *    xterm's parser in one synchronous tick stalls the main thread — and
 *    because ALL main→renderer IPC shares one ordered channel, unrelated
 *    updates (the status dot) queue behind it: the famous "~10s dot lag". So
 *    writes are drained in animation-frame-paced slices of at most
 *    WRITE_BUDGET_BYTES, yielding the thread between slices.
 *
 *    256 KiB, not 64 KiB. Benchmarking xterm 5.5 + WebGL showed a big dump's
 *    wall-clock is dominated by this throttle, NOT xterm's parser (which does
 *    ~35-50 MB/s — 5-10x faster than the slice cadence). 2 MB flushed at
 *    64 KiB takes ~31 frames (~530 ms); at 256 KiB it's ~3.5x faster
 *    (~150 ms). xterm chunks its parser into ~4 KiB sub-tasks that yield
 *    internally, so a 256 KiB slice costs only ~18 ms of cooperatively-yielded
 *    parse work — small enough that the status-dot IPC still gets its turn.
 *    512 KiB starts to regress (~36 ms), so 256 KiB is the sweet spot.
 *
 * 2. Claude's synchronized-output frames must be applied atomically. The PTY
 *    env advertises CLAUDE_CODE_FORCE_SYNC_OUTPUT (see pty.ts), so Claude
 *    wraps every TUI redraw in DEC private mode 2026 markers
 *    (\x1b[?2026h … \x1b[?2026l): "don't paint until the frame is complete".
 *    xterm.js does not implement mode 2026 — it silently ignores the markers —
 *    so the atomicity has to come from us: if a drain slice would end inside
 *    an open frame (erase applied, repaint not yet), xterm's own RAF paints
 *    the half-built screen and the TUI visibly flickers. The drain therefore
 *    never cuts inside a sync frame: it extends the slice to the frame's
 *    close, or holds the frame back until the close arrives (bounded by
 *    SYNC_HOLD_MS so a lost close can't stall output forever).
 *
 * Plus a latency fast path: a small chunk arriving with nothing scheduled
 * (the typical keystroke echo) is written immediately instead of waiting up
 * to a full frame for the next requestAnimationFrame tick. xterm still paints
 * on its own frame; starting the parse now just removes our added wait.
 */

export const WRITE_BUDGET_BYTES = 256 * 1024;
/** Chunks at or below this size bypass the RAF wait when the queue is idle.
 *  Keystroke echoes and single TUI frames are ~0.1-4 KiB; real bursts blow
 *  past this immediately and fall back to frame-paced batching. */
export const FAST_PATH_BYTES = 4 * 1024;
/** How long to hold an open sync frame waiting for its close before giving
 *  up and flushing anyway. Claude closes a frame within milliseconds; only a
 *  crashed writer leaves one open, and output must not stall behind it. */
export const SYNC_HOLD_MS = 150;

const SYNC_OPEN = '\x1b[?2026h';
const SYNC_CLOSE = '\x1b[?2026l';

export interface TermWriteQueue {
  /** Append PTY data; drains to the sink immediately (small idle chunk) or in
   *  frame-paced slices. */
  push(data: string): void;
  /** Drop everything not yet handed to the sink and cancel any scheduled
   *  drain. Used when the PTY restarts so stale output can't corrupt the
   *  fresh session's first frame. */
  reset(): void;
}

/** Scheduling/clock seams. Browser callers use the defaults
 *  (requestAnimationFrame/performance.now); tests inject fakes so held frames
 *  and budget slicing can be driven deterministically under node. */
export interface TermWriteQueueOpts {
  schedule?: (cb: () => void) => number;
  cancel?: (id: number) => void;
  now?: () => number;
}

export function createTermWriteQueue(
  write: (data: string) => void,
  opts?: TermWriteQueueOpts,
): TermWriteQueue {
  const schedule = opts?.schedule ?? ((cb: () => void) => requestAnimationFrame(cb));
  const cancel = opts?.cancel ?? ((id: number) => cancelAnimationFrame(id));
  const now = opts?.now ?? (() => performance.now());

  // Single rolling buffer rather than a queue of chunks: one coalesced
  // `pty:data` message can itself exceed the budget, and slicing within the
  // string spreads an oversized message across frames too — a per-chunk queue
  // would still hand one giant chunk to the sink in a single frame.
  let pending = '';
  let scheduled: number | null = null;
  /** Timestamp of when we first held back an open/partial sync frame; null
   *  when not holding. Drives the SYNC_HOLD_MS give-up. */
  let heldSince: number | null = null;

  const drain = () => {
    scheduled = null;
    if (!pending) return;

    let end = Math.min(pending.length, WRITE_BUDGET_BYTES);
    let hold = false;

    // Frame atomicity: if the cut would land inside an open ?2026 frame,
    // extend the slice to the frame's close, or — close not received yet —
    // cut just before the open and hold the frame for a later drain.
    const open = pending.lastIndexOf(SYNC_OPEN, end - 1);
    if (open !== -1) {
      const close = pending.indexOf(SYNC_CLOSE, open + SYNC_OPEN.length);
      const closeEnd = close + SYNC_CLOSE.length;
      if (close !== -1 && closeEnd <= end) {
        // Frame is complete inside the slice — cut stands.
      } else if (close !== -1 && closeEnd - open <= WRITE_BUDGET_BYTES) {
        end = closeEnd;
      } else if (close === -1) {
        end = open;
        hold = true;
      }
      // else: a pathological >256 KiB frame — flush at the budget cut; a
      // one-frame tear beats a stalled terminal.
    }

    // Never cut through a partially-received sync marker: writing the
    // "\x1b[?20" half of a split marker would make the tracking above miss
    // the frame entirely on the next drain (xterm's parser would still
    // assemble the sequence, but we'd have lost its position).
    const esc = pending.lastIndexOf('\x1b', end - 1);
    if (esc !== -1 && end - esc < SYNC_OPEN.length) {
      const tail = pending.slice(esc, end);
      if (SYNC_OPEN.startsWith(tail) || SYNC_CLOSE.startsWith(tail)) {
        end = esc;
        hold = true;
      }
    }

    if (hold) {
      const t = now();
      if (heldSince === null) {
        heldSince = t;
      } else if (t - heldSince > SYNC_HOLD_MS) {
        // The close never came — the writer died mid-frame or emitted an
        // unpaired open. Stop waiting and flush at the plain budget cut.
        end = Math.min(pending.length, WRITE_BUDGET_BYTES);
        heldSince = null;
      }
    } else {
      heldSince = null;
    }

    if (end > 0) {
      write(pending.slice(0, end));
      pending = pending.slice(end);
    }
    // Reschedule while anything remains — including a held frame, whose
    // re-checks also tick the SYNC_HOLD_MS timeout even if no data arrives.
    if (pending) scheduled = schedule(drain);
  };

  return {
    push(data: string) {
      pending += data;
      if (scheduled !== null) return;
      if (pending.length <= FAST_PATH_BYTES) drain();
      else scheduled = schedule(drain);
    },
    reset() {
      pending = '';
      heldSince = null;
      if (scheduled !== null) {
        cancel(scheduled);
        scheduled = null;
      }
    },
  };
}
