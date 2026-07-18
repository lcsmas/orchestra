/**
 * Wire protocol for the Orchestra backend ↔ UI-frontend channel (ui-rpc).
 *
 * One Unix-domain socket between a running backend (the Electron app or the
 * headless daemon) and N attached UI clients (the GTK app, test drivers)
 * carries the whole renderer contract: request/response calls mirroring
 * `OrchestraAPI` (src/shared/ipc.ts), push events mirroring its `on*`
 * channels, and raw PTY byte streams. The frozen spec is
 * docs/ui-rpc-protocol.md — this module is its executable form. It is pure
 * data + framing: no Electron, no sockets, no I/O, so both the server
 * (src/main/ui-rpc.ts) and any TS test client share one encode/decode pair.
 *
 * Framing follows sandbox-protocol.ts — `[u32 BE length][payload]`, 16 MiB
 * cap — with one addition: the payload's FIRST BYTE discriminates its kind.
 *   0x7B ('{') → a UTF-8 JSON object (control frames, requests, events).
 *   0x01      → ptyData  (server→client): `[0x01][u32 BE idLen][id][bytes…]`
 *   0x02      → ptyWrite (client→server): same layout.
 * Terminal bytes ride the binary frames so they are never base64'd or
 * JSON-escaped; everything else stays debuggable JSON.
 */

// ─── Wire constants ──────────────────────────────────────────────────────────

/** Protocol revision carried in hello/helloOk. Bump only via a contract PR
 *  that updates docs/ui-rpc-protocol.md and both codec sides atomically. */
export const UI_RPC_PROTO = 1;

/** Length-prefix header width in bytes (uint32, big-endian). */
export const FRAME_HEADER_BYTES = 4;

/** Hard ceiling on a single frame's payload, in bytes — same rationale as
 *  sandbox-protocol.ts: PTY bursts are the largest real frames, and the cap
 *  bounds a corrupt/hostile length header before any allocation. */
export const MAX_FRAME_BYTES = 16 * 1024 * 1024;

/** First payload byte of a JSON frame — '{', since every JSON frame is an
 *  object. Binary tags below are picked outside the printable range so the
 *  discrimination can never collide with JSON. */
export const TAG_JSON = 0x7b;
/** First payload byte of a server→client PTY output frame. */
export const TAG_PTY_DATA = 0x01;
/** First payload byte of a client→server PTY input frame. */
export const TAG_PTY_WRITE = 0x02;

// ─── JSON frames ─────────────────────────────────────────────────────────────

/** What kind of frontend a client identifies as in its hello. */
export type UiClientKind = 'gtk' | 'electron' | 'test';

/** Which host is serving the socket, echoed in helloOk. */
export type UiBackendKind = 'electron' | 'daemon';

/** First frame a client sends after connecting. `focused` seeds the client's
 *  focus flag (see {@link FocusFrame}) so notification suppression is correct
 *  from the first event. */
export interface HelloFrame {
  t: 'hello';
  proto: number;
  appVersion: string;
  clientKind: UiClientKind;
  focused: boolean;
}

/** The backend's answer to hello. On a `proto` mismatch the backend still
 *  answers with ITS OWN proto and the client decides to disconnect (per spec
 *  §3); `appVersion` skew is a warning, not fatal. */
export interface HelloOkFrame {
  t: 'helloOk';
  proto: number;
  appVersion: string;
  backendKind: UiBackendKind;
}

/** One method call. `method` is an `OrchestraAPI` member name (or one of the
 *  spec's added methods like `app:info`); `params` is the positional argument
 *  list; `id` is client-scoped and monotonic. */
export interface ReqFrame {
  t: 'req';
  id: number;
  method: string;
  params: unknown[];
}

/** The reply to a {@link ReqFrame}: the resolved return value on `ok`, or the
 *  rejection's message (+ error name when known) on failure. */
export interface ResFrame {
  t: 'res';
  id: number;
  ok: boolean;
  result?: unknown;
  error?: { message: string; name?: string };
}

/** One push event. `channel` is the wire channel name (see
 *  {@link WIRE_EVENT_CHANNELS}); `args` are the `on*` callback's positional
 *  arguments, verbatim. */
export interface EventFrame {
  t: 'event';
  channel: string;
  args: unknown[];
}

/** A client's live focus state. The backend's `focused` flag on
 *  `agentFinished`/`agentNeedsInput` (and its notification suppression) is the
 *  OR over every client's last-known focus plus the Electron window's own. */
export interface FocusFrame {
  t: 'focus';
  focused: boolean;
}

/** Liveness probe — either side may ping; the peer answers pong. */
export interface PingFrame {
  t: 'ping';
}

export interface PongFrame {
  t: 'pong';
}

/** Every JSON frame on the wire. */
export type UiRpcJsonFrame =
  | HelloFrame
  | HelloOkFrame
  | ReqFrame
  | ResFrame
  | EventFrame
  | FocusFrame
  | PingFrame
  | PongFrame;

// ─── Binary frames ───────────────────────────────────────────────────────────

/** Decoded form of a server→client PTY output frame. `id` uses today's PTY id
 *  scheme (`<wsId>`, `<wsId>:run`, `<wsId>:nvim`, `account-login:<id>`). */
export interface PtyDataFrame {
  t: 'ptyData';
  id: string;
  data: Buffer;
}

/** Decoded form of a client→server PTY input frame — the fast path equivalent
 *  of a `ptyWrite` JSON req (which also remains valid, per spec §2). */
export interface PtyWriteFrame {
  t: 'ptyWrite';
  id: string;
  data: Buffer;
}

/** Any decoded frame. The binary kinds reuse the `t` discriminant so callers
 *  switch over one union regardless of the wire representation. */
export type UiRpcFrame = UiRpcJsonFrame | PtyDataFrame | PtyWriteFrame;

// ─── Event channel mapping ───────────────────────────────────────────────────

/**
 * Internal Electron IPC channel → wire event channel. The wire names are the
 * `OrchestraAPI` member names minus their `on` prefix (camelCase preserved),
 * per spec §5 — e.g. `onWorkspaceUpdate`'s IPC channel `workspace:update`
 * broadcasts as `workspaceUpdate`. `pty:data` is deliberately absent: PTY
 * output rides {@link PtyDataFrame} binary frames, never JSON events. The two
 * trailing entries are the spec's added M1 channels (`ui:notify` /
 * `accounts:loginUrl`), broadcast main-side through the platform seam.
 */
export const WIRE_EVENT_CHANNELS: Readonly<Record<string, string>> = {
  'accounts:loginDone': 'accountLoginDone',
  'pty:exit': 'ptyExit',
  'pty:restart': 'ptyRestart',
  'pty:stopped': 'ptyStopped',
  'sandbox:control': 'sandboxControl',
  'selfTune:update': 'selfTuneUpdate',
  'selfTune:output': 'selfTuneOutput',
  'workspace:update': 'workspaceUpdate',
  'workspace:removed': 'workspaceRemoved',
  'workspaces:removed': 'workspacesRemoved',
  'workspaces:deleteProgress': 'workspacesDeleteProgress',
  'workspace:focus': 'workspaceFocus',
  'agent:finished': 'agentFinished',
  'agent:needs-input': 'agentNeedsInput',
  'agent:tool': 'agentTool',
  'agent:context': 'agentContext',
  'repo:syncState': 'repoSyncState',
  'usage:update': 'usageUpdate',
  'accounts:usageUpdate': 'accountUsageUpdate',
  'accounts:workspaceAccounts': 'workspaceAccountsUpdate',
  'repos:update': 'reposUpdate',
  'ui:notify': 'uiNotify',
  'accounts:loginUrl': 'accountsLoginUrl',
};

/** The wire event channel for an internal IPC channel, or null when the
 *  channel is not part of the ui-rpc contract (the server just skips it). */
export function wireEventChannel(ipcChannel: string): string | null {
  return WIRE_EVENT_CHANNELS[ipcChannel] ?? null;
}

// ─── Encoding ────────────────────────────────────────────────────────────────

function framePayload(payload: Buffer): Buffer {
  if (payload.length > MAX_FRAME_BYTES) {
    throw new Error(`ui-rpc frame too large: ${payload.length} > ${MAX_FRAME_BYTES} bytes`);
  }
  const out = Buffer.allocUnsafe(FRAME_HEADER_BYTES + payload.length);
  out.writeUInt32BE(payload.length, 0);
  payload.copy(out, FRAME_HEADER_BYTES);
  return out;
}

function encodeBinary(tag: number, id: string, data: Buffer | string): Buffer {
  const idBuf = Buffer.from(id, 'utf8');
  const dataBuf = typeof data === 'string' ? Buffer.from(data, 'utf8') : data;
  const payload = Buffer.allocUnsafe(1 + 4 + idBuf.length + dataBuf.length);
  payload.writeUInt8(tag, 0);
  payload.writeUInt32BE(idBuf.length, 1);
  idBuf.copy(payload, 5);
  dataBuf.copy(payload, 5 + idBuf.length);
  return framePayload(payload);
}

/** Encode one JSON frame as a length-prefixed buffer. Throws over the size
 *  cap — a frame that large is a bug, and sending it would force the peer to
 *  tear down the stream. */
export function encodeJsonFrame(frame: UiRpcJsonFrame): Buffer {
  return framePayload(Buffer.from(JSON.stringify(frame), 'utf8'));
}

/** Encode a server→client PTY output frame. `data` given as a string is the
 *  backend's coalesced UTF-8 chunk (pty.ts buffers strings). */
export function encodePtyDataFrame(id: string, data: Buffer | string): Buffer {
  return encodeBinary(TAG_PTY_DATA, id, data);
}

/** Encode a client→server PTY input frame. */
export function encodePtyWriteFrame(id: string, data: Buffer | string): Buffer {
  return encodeBinary(TAG_PTY_WRITE, id, data);
}

/** Encode any decoded-form frame back to its wire representation. */
export function encodeUiRpcFrame(frame: UiRpcFrame): Buffer {
  if (frame.t === 'ptyData') return encodePtyDataFrame(frame.id, frame.data);
  if (frame.t === 'ptyWrite') return encodePtyWriteFrame(frame.id, frame.data);
  return encodeJsonFrame(frame);
}

// ─── Decoding ────────────────────────────────────────────────────────────────

function decodeBinary(payload: Buffer): PtyDataFrame | PtyWriteFrame {
  const tag = payload.readUInt8(0);
  if (payload.length < 5) throw new Error('ui-rpc binary frame truncated (no id length)');
  const idLen = payload.readUInt32BE(1);
  if (5 + idLen > payload.length) {
    throw new Error(`ui-rpc binary frame truncated (idLen ${idLen} exceeds payload)`);
  }
  const id = payload.toString('utf8', 5, 5 + idLen);
  const data = Buffer.from(payload.subarray(5 + idLen));
  return { t: tag === TAG_PTY_DATA ? 'ptyData' : 'ptyWrite', id, data };
}

/**
 * Streaming decoder for the ui-rpc socket. Same contract as the
 * sandbox-protocol FrameDecoder: feed every received chunk to {@link push};
 * it buffers across arbitrary chunk boundaries and returns each completed
 * frame in order, discriminating JSON vs binary by the payload's first byte.
 * Stateful and single-stream — one per connection.
 */
export class UiRpcFrameDecoder {
  private buf: Buffer = Buffer.alloc(0);

  /**
   * Append a chunk and return every frame it completes, in order.
   *
   * @throws on a declared length over {@link MAX_FRAME_BYTES}, an empty
   *   payload, an unknown discriminator byte, a truncated binary layout, or
   *   invalid JSON — all unrecoverable for the stream; the caller should tear
   *   the connection down rather than resync.
   */
  push(chunk: Buffer): UiRpcFrame[] {
    this.buf = this.buf.length === 0 ? chunk : Buffer.concat([this.buf, chunk]);
    const frames: UiRpcFrame[] = [];

    for (;;) {
      if (this.buf.length < FRAME_HEADER_BYTES) break; // header not fully arrived
      const len = this.buf.readUInt32BE(0);
      if (len > MAX_FRAME_BYTES) {
        throw new Error(`ui-rpc frame length ${len} exceeds cap ${MAX_FRAME_BYTES}`);
      }
      if (len === 0) throw new Error('ui-rpc frame has empty payload');
      const total = FRAME_HEADER_BYTES + len;
      if (this.buf.length < total) break; // payload not fully arrived

      const payload = this.buf.subarray(FRAME_HEADER_BYTES, total);
      this.buf = this.buf.subarray(total);

      const tag = payload.readUInt8(0);
      if (tag === TAG_JSON) {
        let parsed: unknown;
        try {
          parsed = JSON.parse(payload.toString('utf8'));
        } catch {
          throw new Error('ui-rpc JSON frame payload is not valid JSON');
        }
        frames.push(parsed as UiRpcJsonFrame);
      } else if (tag === TAG_PTY_DATA || tag === TAG_PTY_WRITE) {
        frames.push(decodeBinary(payload));
      } else {
        throw new Error(`ui-rpc frame has unknown discriminator byte 0x${tag.toString(16)}`);
      }
    }

    return frames;
  }

  /** Bytes buffered but not yet forming a complete frame. */
  get pending(): number {
    return this.buf.length;
  }
}

// ─── Validation ──────────────────────────────────────────────────────────────

const JSON_FRAME_TYPES: ReadonlySet<string> = new Set<UiRpcJsonFrame['t']>([
  'hello',
  'helloOk',
  'req',
  'res',
  'event',
  'focus',
  'ping',
  'pong',
]);

/** Narrow a decoded JSON value to a {@link UiRpcJsonFrame} by discriminant —
 *  a cheap guard against a peer sending an unknown/missing `t`, not a full
 *  schema validation (field-level guards live server-side). */
export function isUiRpcJsonFrame(value: unknown): value is UiRpcJsonFrame {
  return (
    typeof value === 'object' &&
    value !== null &&
    typeof (value as { t?: unknown }).t === 'string' &&
    JSON_FRAME_TYPES.has((value as { t: string }).t)
  );
}
