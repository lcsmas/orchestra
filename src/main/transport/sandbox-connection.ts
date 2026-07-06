/**
 * Host-side end of the single Orchestra↔sandbox connection (P3).
 *
 * One {@link SandboxConnection} owns one WebSocket to a sandbox's shim and is
 * shared by every session running in that sandbox — the wire is multiplexed by
 * the per-frame `session` id (the workspace id). It is the inverse of the shim:
 * the shim terminates this connection inside the container; this class drives it
 * from the app.
 *
 * Responsibilities, all keyed off the frame type the shim sends:
 *  - `data` / `exit`  → routed to the {@link RemoteTransport} for that session,
 *    which re-emits them on the SessionTransport interface pty.ts consumes.
 *  - `event`          → handed to {@link onEvent}; the app wires this to
 *    applyAgentEvent, replacing the local events-spool file tail.
 *  - `rpc`            → handed to {@link onRpc}; the app wires this to the same
 *    hook dispatchers hooks-server.ts uses, then calls the provided `reply` to
 *    send the `rpcReply` back so the agent's POST resolves.
 *
 * Outgoing frames (spawn/write/resize/kill from the transports, and rpcReply
 * from the rpc handler) go through {@link send}. The class does not own session
 * lifecycle policy (reconnect, attach/detach across machines) — that is the P4
 * layer above; here we expose a clean send/receive seam and let RemoteTransport
 * map it onto the per-session interface.
 *
 * This module imports only the wire protocol and a WebSocket; it has no Electron
 * or node-pty dependency, so it can be unit-tested against an in-process server.
 */

import {
  FrameDecoder,
  encodeFrame,
  isFrame,
  type Frame,
  type DataFrame,
  type ExitFrame,
  type EventFrame,
  type RpcFrame,
  type ControlFrame,
  type ClientFrame,
  type SandboxFrame,
  type RpcReplyPayload,
} from '../../shared/sandbox-protocol.ts';

/** Minimal structural type for the WebSocket the connection drives, so this
 *  module needn't hard-depend on a particular ws implementation (Node's `ws`
 *  package in the app; a fake in tests). Mirrors the subset we use. */
export interface SandboxSocket {
  send(data: Uint8Array): void;
  close(code?: number, reason?: string): void;
  on(event: 'message', listener: (data: Buffer | ArrayBuffer | Buffer[]) => void): void;
  on(event: 'close', listener: () => void): void;
  on(event: 'error', listener: (err: Error) => void): void;
  readonly readyState: number;
}

/** Routes per-session terminal frames to the matching transport. A transport
 *  registers itself on spawn and unregisters on exit/kill. */
export interface SessionSink {
  handleData(data: string): void;
  handleExit(exitCode: number): void;
}

export interface SandboxConnectionHandlers {
  /** An activity event arrived from the sandbox (replaces the spool tail). */
  onEvent?: (session: string, event: string, tool: string | undefined) => void;
  /** The sandbox broadcast its ownership state (who drives; are we it). Fired
   *  on attach and on every change — the P4 layer surfaces it to the UI. */
  onControl?: (state: ControlFrame) => void;
  /** A hook control-plane call arrived from the sandbox. Dispatch it and call
   *  `reply` exactly once with the dispatcher's `{ok, ...}` object. */
  onRpc?: (
    route: RpcFrame['route'],
    payload: RpcFrame['payload'],
    reply: (payload: RpcReplyPayload) => void,
  ) => void;
  /** The underlying socket closed. The P4 layer decides whether to reconnect;
   *  here we just surface it and fail any in-flight work. */
  onClose?: () => void;
  /** The socket dropped UNEXPECTEDLY (not via close()). When provided, the
   *  connection enters a disconnected state instead of tearing down: sinks are
   *  RETAINED, sends are dropped, and the handler owns what happens next —
   *  either attachSocket() with a fresh socket (sessions resume, the shim kept
   *  their PTYs running) or abandon() (give up: synthesized exits + onClose).
   *  When absent, an unexpected close tears down immediately (legacy). */
  onDisconnect?: () => void;
  /** A fatal protocol error (bad framing / JSON). The stream is torn down. */
  onError?: (err: Error) => void;
}

export class SandboxConnection {
  private decoder = new FrameDecoder();
  private readonly sinks = new Map<string, SessionSink>();
  private closed = false;
  /** Deliberate close() in flight — the socket's close event must tear down,
   *  never hand off to onDisconnect. */
  private closing = false;
  /** Socket down, sinks retained, reconnect possible (see onDisconnect). */
  private disconnected = false;
  private socket: SandboxSocket;
  private readonly handlers: SandboxConnectionHandlers;

  constructor(socket: SandboxSocket, handlers: SandboxConnectionHandlers = {}) {
    this.socket = socket;
    this.handlers = handlers;
    this.wire(socket);
  }

  /** Subscribe to a socket's events, ignoring anything from a socket that has
   *  since been replaced by attachSocket (a late close/error from the old
   *  socket must not affect the new stream). */
  private wire(socket: SandboxSocket): void {
    socket.on('message', (data) => {
      if (this.socket === socket) this.onMessage(data);
    });
    socket.on('close', () => {
      if (this.socket === socket) this.onSocketClose();
    });
    socket.on('error', (err) => {
      if (this.socket === socket) this.handlers.onError?.(err);
    });
  }

  /** Resume a disconnected connection on a fresh socket. Sinks (and therefore
   *  the RemoteTransports terminals hold) carry over untouched — the shim kept
   *  the PTYs running, so their frames simply start flowing again. The frame
   *  decoder is reset: a new socket is a new byte stream, and any partial
   *  frame from the old one is garbage. */
  attachSocket(socket: SandboxSocket): void {
    if (this.closed) throw new Error('cannot attach a socket to a closed connection');
    this.decoder = new FrameDecoder();
    this.socket = socket;
    this.disconnected = false;
    this.wire(socket);
  }

  /** Give up on a disconnected connection: synthesize connection-lost exits
   *  for retained sessions and tear down (fires onClose). Idempotent. */
  abandon(): void {
    if (this.closed) return;
    this.teardown();
  }

  /** Push host-generated text into every live session's terminal — used by the
   *  reconnect layer for "link lost / restored" banners. Rides the normal data
   *  path so it lands in scrollback like agent output. */
  notifySessions(text: string): void {
    for (const [, sink] of this.sinks) {
      try {
        sink.handleData(text);
      } catch {
        /* a broken sink must not stop the others */
      }
    }
  }

  /** Live (registered) session count — the reconnect layer uses this to decide
   *  whether a dropped socket is worth retrying. */
  get sessionCount(): number {
    return this.sinks.size;
  }

  get isDisconnected(): boolean {
    return this.disconnected;
  }

  /** Register the sink for a session's terminal frames. Called by a
   *  RemoteTransport as it spawns. Replacing an existing sink is allowed (a
   *  respawn of the same workspace id). */
  registerSession(session: string, sink: SessionSink): void {
    this.sinks.set(session, sink);
  }

  /** Drop a session's sink so its late frames are ignored. Called on exit/kill. */
  unregisterSession(session: string): void {
    this.sinks.delete(session);
  }

  /** Send a client→sandbox frame. No-op once closed or while disconnected (a
   *  write during an outage is dropped, same as writing to a dead local pty). */
  send(frame: ClientFrame): void {
    if (this.closed || this.disconnected || this.socket.readyState !== OPEN) return;
    this.socket.send(encodeFrame(frame));
  }

  /** Deliberately close the connection. Idempotent. Unlike a remote drop this
   *  always tears down — never hands off to onDisconnect. */
  close(code = 1000, reason = 'closing'): void {
    if (this.closed) return;
    this.closing = true;
    try {
      this.socket.close(code, reason);
    } catch {
      /* ignore */
    }
    if (this.disconnected) {
      // The socket is already gone, so no close event will arrive to finish
      // the job — tear down directly.
      this.teardown();
    }
    // Otherwise onSocketClose fires from the socket's own 'close' event.
  }

  private onMessage(data: Buffer | ArrayBuffer | Buffer[]): void {
    const buf = Array.isArray(data)
      ? Buffer.concat(data)
      : Buffer.isBuffer(data)
        ? data
        : Buffer.from(data as ArrayBuffer);
    let frames: Frame[];
    try {
      frames = this.decoder.push(buf);
    } catch (e) {
      // Unrecoverable framing/JSON error — tear the stream down (matches the
      // protocol module's contract: don't try to resync).
      this.handlers.onError?.(e instanceof Error ? e : new Error(String(e)));
      this.close(1002, 'protocol error');
      return;
    }
    for (const frame of frames) {
      if (!isFrame(frame)) continue; // drop a non-frame object defensively
      this.dispatch(frame as SandboxFrame);
    }
  }

  private dispatch(frame: SandboxFrame): void {
    switch (frame.t) {
      case 'data': {
        const f = frame as DataFrame;
        this.sinks.get(f.session)?.handleData(f.data);
        break;
      }
      case 'exit': {
        const f = frame as ExitFrame;
        // Deliver exit, then drop the sink — a session fires exit once.
        const sink = this.sinks.get(f.session);
        this.sinks.delete(f.session);
        sink?.handleExit(f.exitCode);
        break;
      }
      case 'event': {
        const f = frame as EventFrame;
        this.handlers.onEvent?.(f.session, f.event, f.tool);
        break;
      }
      case 'control': {
        this.handlers.onControl?.(frame as ControlFrame);
        break;
      }
      case 'rpc': {
        const f = frame as RpcFrame;
        const reply = (payload: RpcReplyPayload): void => {
          this.send({ t: 'rpcReply', id: f.id, payload });
        };
        if (this.handlers.onRpc) {
          this.handlers.onRpc(f.route, f.payload, reply);
        } else {
          // No handler wired (e.g. step-3 standalone): answer so the agent's
          // POST doesn't hang waiting on a reply that will never come.
          reply({ ok: false, error: 'no rpc handler on host' });
        }
        break;
      }
      default:
        // A client→sandbox frame arriving from the shim is a protocol error we
        // ignore — the shim never originates spawn/write/resize/kill/rpcReply.
        break;
    }
  }

  private onSocketClose(): void {
    if (this.closed || this.disconnected) return;
    // Unexpected drop with a reconnect layer above us: hold the sessions and
    // let it decide (attachSocket to resume, abandon to give up).
    if (!this.closing && this.handlers.onDisconnect) {
      this.disconnected = true;
      this.handlers.onDisconnect();
      return;
    }
    this.teardown();
  }

  private teardown(): void {
    if (this.closed) return;
    this.closed = true;
    this.disconnected = false;
    // Synthesize an exit for every still-running session so RemoteTransport
    // listeners (and pty.ts above them) unwind rather than hang.
    const sinks = [...this.sinks.entries()];
    this.sinks.clear();
    for (const [, sink] of sinks) {
      try {
        sink.handleExit(EXIT_CONNECTION_LOST);
      } catch {
        /* ignore */
      }
    }
    this.handlers.onClose?.();
  }

  get isClosed(): boolean {
    return this.closed;
  }
}

/** WebSocket OPEN readyState constant (avoids importing `ws` just for the enum;
 *  the value is fixed by the WHATWG spec). */
const OPEN = 1;

/** Exit code surfaced for sessions whose connection dropped out from under them.
 *  Distinct, large value so logs can tell it apart from a real process code. */
export const EXIT_CONNECTION_LOST = -1;
