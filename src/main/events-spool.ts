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
// truth, ingestion latency no longer equals data loss — which is exactly why
// the old PTY-output reconciliation safety net could be deleted.

const EVENTS_DIR = path.join(os.homedir(), '.orchestra', 'events');

// Safety-net rescan cadence. The directory watcher handles the common case in
// near-real-time; this only catches inotify events that got coalesced or
// dropped under load. Kept slow so it's effectively free.
const POLL_MS = 1000;

interface Cursor {
  /** Byte offset already consumed from the file. */
  offset: number;
  /** Trailing bytes past the last newline — an incompletely-written line held
   *  until its terminating newline arrives in a later append. */
  buffer: string;
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
  if (!name.endsWith('.jsonl')) return null;
  return name.slice(0, -'.jsonl'.length) || null;
}

/** Read and dispatch any bytes appended since this file's last cursor. Reading
 *  is synchronous (the deltas are tiny) so two overlapping triggers — watcher
 *  and poll — can never interleave a half-read. Truncates the file back to
 *  empty at a turn boundary (stop/notify), the one moment the agent is
 *  guaranteed quiescent, to bound growth to a single turn's events. */
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
    cur = { offset: 0, buffer: '' };
    cursors.set(id, cur);
  }
  // File shrank (we truncated it at a turn boundary, or it was recreated) —
  // restart from the top so we don't skip the fresh content.
  if (size < cur.offset) {
    cur.offset = 0;
    cur.buffer = '';
  }
  if (size === cur.offset) return;

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

  let lastTerminal: 'stop' | 'notify' | null = null;
  for (const line of parts) {
    const trimmed = line.trim();
    if (!trimmed) continue;
    let ev: { event?: unknown; tool?: unknown };
    try {
      ev = JSON.parse(trimmed) as { event?: unknown; tool?: unknown };
    } catch {
      continue; // skip a corrupt/partial line rather than wedge the tail
    }
    if (typeof ev.event !== 'string') continue;
    const tool = typeof ev.tool === 'string' && ev.tool.length ? ev.tool : undefined;
    if (window) applyAgentEvent(id, ev.event, tool, window);
    if (ev.event === 'stop' || ev.event === 'notify') lastTerminal = ev.event;
    else lastTerminal = null;
  }

  // Turn ended and nothing is mid-write (no buffered partial): reset the spool
  // so a long-lived workspace's file can't grow unbounded. Safe against a race
  // with a concurrent append because after stop/notify the agent is blocked
  // until the user's next prompt — there is nothing writing right now.
  if (lastTerminal && !cur.buffer) {
    try {
      fs.truncateSync(p, 0);
      cur.offset = 0;
    } catch {
      /* best-effort: next drain's shrink-detect recovers anyway */
    }
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
  // dead session's last status lives in store.json, not here. Clear them for a
  // clean slate; this is the one moment we can truncate with zero race risk.
  try {
    for (const name of fs.readdirSync(EVENTS_DIR)) {
      if (idFromFilename(name)) {
        try {
          fs.unlinkSync(path.join(EVENTS_DIR, name));
        } catch {
          /* ignore */
        }
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
