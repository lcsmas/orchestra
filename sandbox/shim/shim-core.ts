/**
 * Pure, I/O-free helpers for the sandbox shim, split out so they can be unit
 * tested without a websocket, a unix socket, or a real PTY. shim.ts wires these
 * into the live file tail / HTTP server; everything here is plain data → data.
 */

import type { RpcRoute, ControlFrame } from './sandbox-protocol.js';

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

// ─── Cross-machine drive broker (P4 item C) ─────────────────────────────────
//
// Pure ownership bookkeeping for "many machines attached, one drives". The
// shim holds one broker and feeds it attach/hello/takeControl/detach; every
// method returns whether ownership changed so the shim knows when to broadcast
// a `control` frame. Generic over the connection handle (a WebSocket in the
// shim, anything in tests) — the broker never touches it, only identity-maps.

interface ClientRecord {
  /** From `hello`; null until the client identifies itself. */
  id: string | null;
  name: string | null;
  /** Attach order, for deterministic promotion when the driver leaves. */
  order: number;
}

export class DriveBroker<C> {
  private readonly clients = new Map<C, ClientRecord>();
  private driver: C | null = null;
  private seq = 0;

  /** A new connection attached. Never grants the drive by itself. */
  attach(conn: C): void {
    this.clients.set(conn, { id: null, name: null, order: this.seq++ });
  }

  /** A client identified itself. First identified client wins the drive; a
   *  reconnect bearing the CURRENT DRIVER's clientId resumes the drive on the
   *  new connection (same machine, fresh socket — not a rival). */
  hello(conn: C, id: string, name: string): boolean {
    const rec = this.clients.get(conn);
    if (!rec) return false;
    rec.id = id;
    rec.name = name;
    if (this.driver === null) {
      this.driver = conn;
      return true;
    }
    const driverRec = this.driver === conn ? rec : this.clients.get(this.driver);
    if (driverRec?.id === id && this.driver !== conn) {
      this.driver = conn;
      return true;
    }
    return false;
  }

  /** Explicit take-over — always honored for an attached client. */
  takeControl(conn: C): boolean {
    if (!this.clients.has(conn) || this.driver === conn) return false;
    this.driver = conn;
    return true;
  }

  /** Legacy grandfathering: a client that never said hello but is the only
   *  candidate (no driver at all) adopts the drive on its first write, so an
   *  old Orchestra build attached alone still works. */
  adoptIfVacant(conn: C): boolean {
    if (this.driver !== null || !this.clients.has(conn)) return false;
    this.driver = conn;
    return true;
  }

  /** A connection went away. If it held the drive, promote the longest-
   *  attached IDENTIFIED client (deterministic, observers stay observers only
   *  until someone who said hello exists). Returns true if ownership changed. */
  detach(conn: C): boolean {
    const wasDriver = this.driver === conn;
    this.clients.delete(conn);
    if (!wasDriver) return false;
    let heir: C | null = null;
    let heirOrder = Infinity;
    for (const [c, rec] of this.clients) {
      if (rec.id !== null && rec.order < heirOrder) {
        heir = c;
        heirOrder = rec.order;
      }
    }
    this.driver = heir;
    return true;
  }

  isDriver(conn: C): boolean {
    return this.driver !== null && this.driver === conn;
  }

  /** The `control` frame to send to one client — `isDriver` is per-recipient. */
  stateFor(conn: C): ControlFrame {
    const driverRec = this.driver === null ? undefined : this.clients.get(this.driver);
    return {
      t: 'control',
      driverId: driverRec?.id ?? null,
      driverName: driverRec?.name ?? null,
      isDriver: this.isDriver(conn),
    };
  }

  /** Every attached connection, for broadcasts. */
  connections(): C[] {
    return [...this.clients.keys()];
  }

  get clientCount(): number {
    return this.clients.size;
  }

  get hasDriver(): boolean {
    return this.driver !== null;
  }
}
