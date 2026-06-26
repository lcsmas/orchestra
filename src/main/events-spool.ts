import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { BrowserWindow } from 'electron';
import { applyAgentEvent } from './activity';

// Durable activity-event spool tailer.
//
// Each workspace's Claude hooks append one JSON line per lifecycle event
// (submit/stop/notify/pretool/posttool) to `<EVENTS_DIR>/<wsid>.jsonl` via the
// installed `.orchestra/orchestra-hook.sh` helper. A local file append is
// atomic and sub-millisecond, so — unlike the old fire-and-forget socket POST
// with its 1s `curl --max-time` — an event is never dropped when orchestra's
// event loop is briefly busy, and the hook never blocks the agent waiting on
// orchestra. The worst case is the UI updating a beat late, not a lost event.
//
// This module tails those files (a single directory watcher for low latency +
// a slow poll as a safety net for any coalesced/missed inotify event) and
// feeds each line to the activity tracker. Because the file is the source of
// truth, ingestion latency no longer equals data loss.
//
// Delivery is made robust by treating the spool as an append-only log with a
// monotonic per-line `seq` (stamped by the writer hook under flock):
//
//   • Exactly-once, ordered apply. We remember the highest seq applied per
//     workspace and skip any line at or below it. A duplicate drain (the
//     watcher and the poll both firing for one append, or two overlapping
//     polls) therefore can't re-apply an event — which is what used to re-fire
//     the "agent finished" chime several times for one stop.
//
//   • No truncation under a live writer. The previous version truncated the
//     file to zero the moment a drained batch ended in stop/notify, on the
//     theory that "the agent is blocked after stop". It isn't: the next submit
//     (or a sub-agent's events) can append between our statSync and truncate,
//     and that write — or the stop itself, via an offset/size desync — was
//     silently discarded, leaving the dot stuck on `running`. We never truncate
//     now. Growth is bounded instead by rotation (rename-away + fresh start)
//     that only happens when the file is large AND quiescent, a state the
//     reader fully controls, so there is no write-vs-reset race.

const EVENTS_DIR = path.join(os.homedir(), '.orchestra', 'events');

// Safety-net rescan cadence. The directory watcher handles the common case in
// near-real-time; this only catches inotify events that got coalesced or
// dropped under load. Kept slow so it's effectively free.
const POLL_MS = 1000;

// Rotate a spool once it crosses this size, to bound a long-lived workspace's
// file. We only rotate after observing the file unchanged across two
// consecutive drains (no new bytes, no buffered partial line) so the agent is
// provably idle at that instant — never mid-write. seq keeps climbing across a
// rotation, so a post-rotation replay still can't re-apply pre-rotation events.
const ROTATE_BYTES = 256 * 1024;

interface Cursor {
  /** Byte offset already consumed from the file. */
  offset: number;
  /** Trailing bytes past the last newline — an incompletely-written line held
   *  until its terminating newline arrives in a later append. */
  buffer: string;
  /** Highest `seq` already applied. Lines at or below this are duplicates from
   *  an overlapping watcher/poll drain and are skipped. 0 means "nothing
   *  sequenced yet"; unsequenced lines (seq 0, flock-less writer) always apply. */
  lastSeq: number;
  /** File size seen at the previous drain, for the quiescence check that gates
   *  rotation (size unchanged + no buffered partial ⇒ safe to rotate). */
  prevSize: number;
}

let window: BrowserWindow | null = null;
let watcher: fs.FSWatcher | null = null;
let poll: ReturnType<typeof setInterval> | null = null;
const cursors = new Map<string, Cursor>();

function spoolPathFor(id: string): string {
  return path.join(EVENTS_DIR, `${id}.jsonl`);
}

/** Absolute path of the per-workspace spool directory, handed to spawned PTYs
 *  via $ORCHESTRA_EVENTS_DIR so the hook helper writes where we tail. */
export function getEventsDir(): string {
  return EVENTS_DIR;
}

function idFromFilename(name: string): string | null {
  // Only the live spool is a tail target. The sibling `.seq` counter and any
  // rotated-away `.jsonl.old` must not be drained as if they were spools.
  if (!name.endsWith('.jsonl')) return null;
  return name.slice(0, -'.jsonl'.length) || null;
}

/** Read and dispatch any bytes appended since this file's last cursor. Reading
 *  is synchronous (the deltas are tiny) so two overlapping triggers — watcher
 *  and poll — can never interleave a half-read. Each line's monotonic `seq`
 *  makes apply exactly-once: a line at or below the highest seq already applied
 *  is a duplicate from an overlapping drain and is dropped. We never truncate
 *  the file under a writer; growth is bounded by `maybeRotate` at a quiescent
 *  moment instead. */
function drain(id: string): void {
  const p = spoolPathFor(id);
  let size: number;
  try {
    size = fs.statSync(p).size;
  } catch {
    return; // not created yet, or removed
  }
  let cur = cursors.get(id);
  if (!cur) {
    cur = { offset: 0, buffer: '', lastSeq: 0, prevSize: 0 };
    cursors.set(id, cur);
  }
  // File shrank — it was rotated away (by us) or recreated. Restart byte
  // tracking from the top; `lastSeq` is deliberately preserved so any line
  // that lingered through the rename can't be re-applied.
  if (size < cur.offset) {
    cur.offset = 0;
    cur.buffer = '';
  }
  if (size === cur.offset) {
    // No new bytes. If the file is also big and has no buffered partial, it's
    // quiescent — the one safe moment to rotate it away.
    maybeRotate(id, cur, size);
    cur.prevSize = size;
    return;
  }

  let chunk = '';
  try {
    const fd = fs.openSync(p, 'r');
    try {
      const len = size - cur.offset;
      const buf = Buffer.alloc(len);
      const read = fs.readSync(fd, buf, 0, len, cur.offset);
      chunk = buf.toString('utf8', 0, read);
    } finally {
      fs.closeSync(fd);
    }
  } catch {
    return;
  }
  cur.offset = size;

  const text = cur.buffer + chunk;
  const parts = text.split('\n');
  cur.buffer = parts.pop() ?? ''; // trailing partial line (no newline yet)

  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: { seq?: unknown; event?: unknown; tool?: unknown };
    try {
      ev = JSON.parse(trimmed) as { seq?: unknown; event?: unknown; tool?: unknown };
    } catch {
      continue; // skip a corrupt/partial line rather than wedge the tail
    }
    if (typeof ev.event !== 'string') continue;
    // Exactly-once: a sequenced line we've already applied (overlapping
    // watcher+poll drain, or a re-read after rotation) is dropped. seq 0 is the
    // flock-less writer's "unsequenced" marker — those always apply, matching
    // the old at-least-once behavior on that degraded path.
    const seq = typeof ev.seq === 'number' && Number.isFinite(ev.seq) ? ev.seq : 0;
    if (seq > 0) {
      if (seq <= cur.lastSeq) continue;
      cur.lastSeq = seq;
    }
    const tool = typeof ev.tool === 'string' && ev.tool.length ? ev.tool : undefined;
    if (window) applyAgentEvent(id, ev.event, tool, window);
  }
  cur.prevSize = size;
}

/** Bound a long-lived workspace's spool by renaming the current file aside and
 *  letting the writer recreate it on its next append. Only fires when the file
 *  is large AND has been observed unchanged across two consecutive drains with
 *  no buffered partial line — i.e. provably no hook is mid-write — so there is
 *  no truncate-vs-append race. `seq` keeps climbing in the sibling `.seq`
 *  counter (untouched here), and `lastSeq` is preserved across the cursor
 *  reset in `drain`, so a stray pre-rotation line can never be re-applied. */
function maybeRotate(id: string, cur: Cursor, size: number): void {
  if (size < ROTATE_BYTES) return;
  if (cur.buffer) return; // a partial line is buffered ⇒ a write is in flight
  if (size !== cur.prevSize) return; // changed since last drain ⇒ not yet quiescent
  const p = spoolPathFor(id);
  try {
    fs.rmSync(`${p}.old`, { force: true });
    fs.renameSync(p, `${p}.old`); // writer's next `>>` append recreates a fresh, empty file
    cur.offset = 0;
    cur.buffer = '';
    cur.prevSize = 0;
  } catch {
    /* best-effort: a failed rotate just means the file keeps growing a bit longer */
  }
}

function drainAll(): void {
  let names: string[];
  try {
    names = fs.readdirSync(EVENTS_DIR);
  } catch {
    return;
  }
  for (const name of names) {
    const id = idFromFilename(name);
    if (id) drain(id);
  }
}

export function startEventsSpool(win: BrowserWindow): void {
  if (watcher || poll) return;
  window = win;
  try {
    fs.mkdirSync(EVENTS_DIR, { recursive: true });
  } catch {
    /* best-effort */
  }
  // No agent is running at startup (PTYs are spawned later, on the renderer's
  // pty:start), so any spool file on disk is stale from a previous run — and a
  // dead session's last status lives in store.json, not here. Clear the whole
  // events dir (spools, the `.seq` counters, and any rotated `.old` files) for
  // a clean slate; this is the one moment we can wipe with zero race risk. The
  // counters reset to 0, so the new run's seq restarts from 1 against a fresh
  // cursor whose lastSeq is also 0 — consistent on both ends.
  try {
    for (const name of fs.readdirSync(EVENTS_DIR)) {
      try {
        fs.unlinkSync(path.join(EVENTS_DIR, name));
      } catch {
        /* ignore */
      }
    }
  } catch {
    /* dir unreadable — nothing to clear */
  }

  try {
    watcher = fs.watch(EVENTS_DIR, (_event, filename) => {
      if (!filename) {
        drainAll();
        return;
      }
      const id = idFromFilename(filename.toString());
      if (id) drain(id);
    });
    watcher.on('error', () => {
      /* keep the poll going as the fallback even if the watcher dies */
    });
  } catch {
    watcher = null; // platform without fs.watch — poll-only still works
  }

  poll = setInterval(drainAll, POLL_MS);
  if (typeof poll.unref === 'function') poll.unref();
}

export function stopEventsSpool(): void {
  if (watcher) {
    try {
      watcher.close();
    } catch {
      /* ignore */
    }
    watcher = null;
  }
  if (poll) {
    clearInterval(poll);
    poll = null;
  }
  cursors.clear();
  window = null;
}
