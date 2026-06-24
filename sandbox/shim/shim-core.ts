/**
 * Pure, I/O-free helpers for the sandbox shim, split out so they can be unit
 * tested without a websocket, a unix socket, or a real PTY. shim.ts wires these
 * into the live file tail / HTTP server; everything here is plain data → data.
 */

import type { RpcRoute } from './sandbox-protocol.js';

/** An activity event extracted from one spool line: the {event, tool?} pair the
 *  agent's hooks append and the host feeds to applyAgentEvent. */
export interface SpoolEvent {
  event: string;
  tool?: string;
}

/** Result of parsing a chunk of appended spool text. Mirrors events-spool.ts's
 *  drain loop, minus the file I/O: caller keeps `leftover` as the next cursor
 *  buffer, emits one frame per `events` entry, and truncates the file iff
 *  `truncate` is true (a turn boundary with nothing mid-write). */
export interface SpoolParseResult {
  events: SpoolEvent[];
  /** Trailing partial line (no terminating newline yet) to carry forward. */
  leftover: string;
  /** True when the last complete line was a turn terminator (stop/notify) AND no
   *  partial line is buffered — the one safe moment to reset the spool file. */
  truncate: boolean;
}

/**
 * Parse newline-delimited spool text into activity events, a carry-forward
 * partial line, and a truncate-at-turn-boundary decision. A faithful port of the
 * line loop in src/main/events-spool.ts:drain so the sandbox tail behaves
 * identically to the local one: corrupt lines are skipped (not fatal), a line
 * without a string `event` is ignored, an empty `tool` becomes undefined, and a
 * trailing stop/notify with no buffered partial signals truncation.
 *
 * @param prevBuffer the cursor's carried partial line from the previous call
 * @param chunk      the bytes appended since the last cursor offset, as text
 */
export function parseSpoolChunk(prevBuffer: string, chunk: string): SpoolParseResult {
  const text = prevBuffer + chunk;
  const parts = text.split('\n');
  const leftover = parts.pop() ?? '';

  const events: SpoolEvent[] = [];
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
    events.push(tool ? { event: ev.event, tool } : { event: ev.event });
    if (ev.event === 'stop' || ev.event === 'notify') lastTerminal = ev.event;
    else lastTerminal = null;
  }

  return { events, leftover, truncate: lastTerminal !== null && leftover === '' };
}

/** The five hook routes the shim forwards to the host as `rpc` frames. Anything
 *  else (the default /event activity POST) is answered locally — activity rides
 *  the spool tail, not the socket, exactly as in hooks-server.ts. */
export const FORWARDED_ROUTES: ReadonlySet<RpcRoute> = new Set<RpcRoute>([
  'rename',
  'spawn',
  'peers',
  'read',
  'message',
]);

/** Map a request URL ("/spawn") to a bare route name ("spawn"). */
export function routeFromUrl(url: string | undefined): string {
  const u = url ?? '/';
  return u.startsWith('/') ? u.slice(1) : u;
}

/** Per-route request body cap, matching hooks-server.ts: /spawn and /message
 *  carry the agent's opening prompt / message text; everything else is tiny. */
export function maxBodyBytesFor(route: string): number {
  return route === 'spawn' || route === 'message' ? 1_048_576 : 4096;
}

/** True iff a route should be forwarded to the host (vs. answered locally). */
export function isForwarded(route: string): boolean {
  return FORWARDED_ROUTES.has(route as RpcRoute);
}
