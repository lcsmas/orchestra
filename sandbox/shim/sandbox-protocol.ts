// AUTO-GENERATED — do not edit. Vendored copy of src/shared/sandbox-protocol.ts.
// Regenerate with `node sandbox/shim/sync-protocol.mjs` (or `npm run build` in this dir).

/**
 * Wire protocol for the Orchestra ↔ sandbox channel (P3).
 *
 * One bidirectional connection between an Orchestra client and the always-on
 * sandbox carries everything that is local-only today: terminal I/O, activity
 * events, and the hook control plane (the five routes in hooks-server.ts). This
 * module defines the message vocabulary and a streaming length-prefixed framing
 * so the same protocol rides over any byte stream — a websocket over TLS, a raw
 * mTLS socket, an SSH tunnel — without change. It is pure data: no Electron, no
 * Docker, no node-pty, no I/O. The transport (RemoteTransport) and the sandbox
 * shim both import these types and use the same encode/decode pair, so a frame
 * written on one side is the exact object read on the other.
 *
 * Design notes:
 *  - Frames are a discriminated union on `t`. The terminal frames map 1:1 onto
 *    the SessionTransport interface (src/main/transport/types.ts): spawn/write/
 *    resize/kill are client→sandbox, data/exit are sandbox→client.
 *  - `event` frames carry exactly what events-spool.ts extracts from a spool
 *    line ({event, tool?}) and feeds to applyAgentEvent — the spool's file tail
 *    is replaced by these frames inside the sandbox shim.
 *  - `rpc`/`rpcReply` tunnel the five hook routes. The agent inside the sandbox
 *    POSTs to a local socket the shim serves; the shim forwards the request as
 *    an `rpc` frame (sandbox→client), the client dispatches it to the same
 *    handlers hooks-server.ts uses today, and replies with `rpcReply`. A
 *    monotonic `id` correlates request and reply so several can be in flight.
 *  - Multiple sessions share one connection: every terminal/event frame carries
 *    a `session` id (the workspace id) so the client/shim can fan out.
 */

// ─── Wire constants ─────────────────────────────────────────────────────────

/** Length-prefix header width in bytes (uint32, big-endian). */
export const FRAME_HEADER_BYTES = 4;

/** Hard ceiling on a single frame's JSON payload, in bytes. Terminal `data`
 *  bursts are the largest frames; this bounds a malformed/hostile length header
 *  so the decoder never tries to allocate gigabytes. 16 MiB is far above any
 *  real single PTY read yet small enough to reject garbage immediately. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

// ─── Hook RPC routes ─────────────────────────────────────────────────────────

/** The five control-plane routes hooks-server.ts serves today. The wire mirrors
 *  them exactly so the client can dispatch an `rpc` frame to the existing
 *  handlers without translation. */
export type RpcRoute = 'rename' | 'spawn' | 'peers' | 'read' | 'message';

/** Request payloads, one per route — the fields each dispatcher reads. Optional
 *  fields mirror hooks-server.ts's `typeof === 'string'` guards (absent ⇒
 *  undefined). The shim copies the agent's POST body into the matching shape. */
export interface RpcRequestPayloads {
  rename: { id: string; branch: string };
  spawn: { from?: string; repoPath?: string; baseBranch?: string; task: string };
  peers: { from?: string };
  read: { id: string; lines?: number };
  message: { from?: string; to: string; text: string };
}

/** Every route's reply is the same `{ok, ...}` JSON the dispatchers return
 *  today. Kept opaque here (the client forwards the dispatcher's object
 *  verbatim) so the protocol need not enumerate each route's success shape. */
export interface RpcReplyPayload {
  ok: boolean;
  [key: string]: unknown;
}

// ─── Frames ──────────────────────────────────────────────────────────────────

/** Start an agent PTY inside the sandbox. Mirrors TransportSpawnOptions; `cwd`
 *  is a sandbox-side path (always /workspace today) and `env` is the fully
 *  resolved environment the shim passes through to node-pty verbatim. */
export interface SpawnFrame {
  t: 'spawn';
  /** Workspace id — the session key for all subsequent frames. */
  session: string;
  command: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** stdin bytes for a running session. */
export interface WriteFrame {
  t: 'write';
  session: string;
  data: string;
}

/** New terminal size for a running session. */
export interface ResizeFrame {
  t: 'resize';
  session: string;
  cols: number;
  rows: number;
}

/** Terminate a running session's process. */
export interface KillFrame {
  t: 'kill';
  session: string;
}

/** stdout bytes from a session. Fed into the client's existing IPC coalescing
 *  buffer and scrollback log, exactly as LocalPtyTransport.onData is today. */
export interface DataFrame {
  t: 'data';
  session: string;
  data: string;
}

/** A session's process exited. Fires once per session, mirroring TransportExit. */
export interface ExitFrame {
  t: 'exit';
  session: string;
  exitCode: number;
}

/** An activity event from the sandbox — the {event, tool?} pair events-spool.ts
 *  would otherwise read from the on-disk spool line. The shim tails the spool
 *  inside the sandbox and emits one of these per line; the client feeds it
 *  straight into applyAgentEvent. */
export interface EventFrame {
  t: 'event';
  session: string;
  event: string;
  tool?: string;
}

/** A hook control-plane call originating inside the sandbox (the agent POSTed to
 *  the shim's local socket). The client dispatches it to the same handler
 *  hooks-server.ts uses and answers with a matching {@link RpcReplyFrame}. */
export interface RpcFrame<R extends RpcRoute = RpcRoute> {
  t: 'rpc';
  /** Correlation id, unique per in-flight call on this connection. */
  id: number;
  route: R;
  payload: RpcRequestPayloads[R];
}

/** The client's answer to an {@link RpcFrame}, carrying the dispatcher's
 *  `{ok, ...}` object back to the shim, which returns it as the HTTP response to
 *  the agent's POST. */
export interface RpcReplyFrame {
  t: 'rpcReply';
  /** Matches the originating {@link RpcFrame.id}. */
  id: number;
  payload: RpcReplyPayload;
}

/** Client→sandbox frames (drive a session / answer an rpc). */
export type ClientFrame = SpawnFrame | WriteFrame | ResizeFrame | KillFrame | RpcReplyFrame;

/** Sandbox→client frames (session output, activity, control-plane calls). */
export type SandboxFrame = DataFrame | ExitFrame | EventFrame | RpcFrame;

/** Any frame on the wire. */
export type Frame = ClientFrame | SandboxFrame;

/** The discriminant values, for exhaustiveness checks and validation. */
export type FrameType = Frame['t'];

// ─── Framing ──────────────────────────────────────────────────────────────────

/**
 * Encode one frame as a length-prefixed binary buffer: a 4-byte big-endian
 * uint32 byte-length followed by the UTF-8 JSON payload. The length counts the
 * JSON bytes only (it excludes the header), matching what {@link FrameDecoder}
 * expects.
 *
 * Throws if the encoded payload exceeds {@link MAX_FRAME_BYTES} — a frame that
 * large is a bug (no legitimate PTY read approaches the cap), and silently
 * sending it would force the peer's decoder to reject the whole stream.
 */
export function encodeFrame(frame: Frame): Buffer {
  const json = Buffer.from(JSON.stringify(frame), 'utf8');
  if (json.length > MAX_FRAME_BYTES) {
    throw new Error(`sandbox frame too large: ${json.length} > ${MAX_FRAME_BYTES} bytes`);
  }
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + json.length);
  out.writeUInt32BE(json.length, 0);
  json.copy(out, FRAME_HEADER_BYTES);
  return out;
}

/**
 * Streaming decoder for length-prefixed frames.
 *
 * A byte stream (websocket binary message, TCP/TLS chunk, …) delivers bytes in
 * arbitrary boundaries: a single chunk may hold several frames, half a frame,
 * or a header split across two reads. Feed every received chunk to
 * {@link push}; it buffers, extracts every complete frame, and returns them in
 * order. Incomplete trailing bytes are held until the rest arrives.
 *
 * The decoder is stateful and single-stream — use one per connection. It does
 * not validate frame *shape* beyond JSON parsing and the size cap; semantic
 * validation (is this a known frame type?) is the caller's job via
 * {@link isFrame}, kept separate so the framing layer stays a pure transport.
 */
export class FrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Append a chunk and return every complete frame it completes, in order.
   *
   * @throws if a frame's declared length exceeds {@link MAX_FRAME_BYTES} (a
   *   corrupt or hostile header) or if a completed payload is not valid JSON.
   *   Either is unrecoverable for the stream — the caller should tear down the
   *   connection rather than try to resync.
   */
  push(chunk: Buffer): Frame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: Frame[] = [];

    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break; // header not fully arrived
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`sandbox frame length ${len} exceeds cap ${MAX_FRAME_BYTES}`);
      }
      const total = FRAME_HEADER_BYTES + len;
      if (this.buf.length < total) break; // payload not fully arrived

      const json = this.buf.toString('utf8', FRAME_HEADER_BYTES, total);
      this.buf = this.buf.subarray(total);

      let parsed: unknown;
      try {
        parsed = JSON.parse(json);
      } catch {
        throw new Error('sandbox frame payload is not valid JSON');
      }
      frames.push(parsed as Frame);
    }

    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame. Useful in tests and
   *  for diagnostics on a stalled stream. */
  get pending(): number {
    return this.buf.length;
  }
}

// ─── Validation ────────────────────────────────────────────────────────────────

const FRAME_TYPES: ReadonlySet<string> = new Set<FrameType>([
  'spawn',
  'write',
  'resize',
  'kill',
  'data',
  'exit',
  'event',
  'rpc',
  'rpcReply',
]);

/** Narrow an arbitrary decoded value to a {@link Frame} by checking its
 *  discriminant. A guard against a peer (or a bug) sending an object with an
 *  unknown/missing `t`; callers use it before switching on `frame.t`. This is a
 *  cheap discriminant check, not a full schema validation — the field-level
 *  guards on the receiving side (mirroring hooks-server.ts) remain the
 *  authority on payload contents. */
export function isFrame(value: unknown): value is Frame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    FRAME_TYPES.has((value as { t: string }).t)
  );
}
