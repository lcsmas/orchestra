import net from 'node:net';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  UI_RPC_PROTO,
  UiRpcFrameDecoder,
  encodeJsonFrame,
  encodePtyDataFrame,
  isUiRpcJsonFrame,
  wireEventChannel,
  type UiBackendKind,
  type UiClientKind,
  type UiRpcFrame,
  type ReqFrame,
} from '../shared/ui-rpc-protocol.ts';
import { orchestraHome, setUiClientSink, type UiClientSink } from './platform/index.ts';
import { log } from './logger.ts';

// The ui-rpc SERVER: a Unix-domain socket every external UI frontend (the GTK
// app, tests) attaches to. Hosted by BOTH backends — the Electron app serves
// it alongside its own renderer, and the daemon serves it as its only UI
// surface. Wire contract: docs/ui-rpc-protocol.md (codec + channel tables in
// src/shared/ui-rpc-protocol.ts).
//
// Dispatch is a mechanical table walk: `req.method` indexes the SAME handler
// table index.ts wires to ipcMain (src/main/api-handlers.ts) — injected here
// rather than imported so tests can drive the server with fakes and so this
// module's import closure stays small enough for the node test runner (which
// is also why the imports above carry explicit .ts extensions).
//
// Events flow the other way: the platform seam fans every broadcast out to
// the registered {@link UiClientSink}; this server registers itself as that
// sink on start, translating internal IPC channel names to wire names and
// pushing PTY output as binary ptyData frames. PTY input arrives as binary
// ptyWrite frames (or the equivalent ptyWrite req) and is routed through the
// handler table's own ptyWrite — so the hasInput flip and heavy-resume gate
// apply identically on every transport.

/** How the server calls into the backend. Matches api-handlers.ts's table
 *  shape structurally; tests inject fakes. */
export type UiRpcHandlerTable = Record<string, (...args: never[]) => unknown>;

export interface UiRpcServerOptions {
  /** The method table — api-handlers.ts's `apiHandlers` in production (its
   *  precise mapped type has no string index signature, hence the union),
   *  or a plain record of fakes in tests. */
  handlers: UiRpcHandlerTable | object;
  appVersion: string;
  backendKind: UiBackendKind;
  /** Socket path override (tests). Default: `$XDG_RUNTIME_DIR/orchestra-ui-<pid>.sock`. */
  socketPath?: string;
  /** Pointer-file override; `null` disables writing it (tests). Default:
   *  `<orchestraHome>/ui-sock`. */
  pointerFile?: string | null;
  /** Idle interval before the server pings a client (default 15 s). */
  pingIntervalMs?: number;
  /** Grace after a ping before the client is declared dead (default 5 s). */
  pongTimeoutMs?: number;
}

export interface UiRpcServer {
  socketPath: string;
  /** Handshaken client count (what the spool gate / focus OR consult). */
  clientCount(): number;
  /** True when any handshaken client's last focus frame said focused. */
  anyFocused(): boolean;
  /** Broadcast one event by INTERNAL IPC channel name (translated to the wire
   *  channel; channels outside the contract are dropped). Normally reached
   *  via platform.broadcast → sink, exposed for tests. */
  broadcastEvent(ipcChannel: string, args: unknown[]): void;
  /** Broadcast one PTY chunk as binary ptyData frames. */
  broadcastPtyData(id: string, data: string): void;
  close(): Promise<void>;
}

const PING_INTERVAL_MS = 15_000;
const PONG_TIMEOUT_MS = 5_000;

/** Default socket path — per-PID under XDG_RUNTIME_DIR (mode-0700 tmpfs) so a
 *  crashed run can't collide with a fresh one; discovery goes through the
 *  pointer file, mirroring the hooks socket's design. */
function defaultSocketPath(): string {
  const dir = process.env.XDG_RUNTIME_DIR || os.tmpdir();
  return path.join(dir, `orchestra-ui-${process.pid}.sock`);
}

interface Client {
  socket: net.Socket;
  decoder: UiRpcFrameDecoder;
  handshaken: boolean;
  clientKind: UiClientKind | null;
  focused: boolean;
  idleTimer: ReturnType<typeof setTimeout> | null;
  pongTimer: ReturnType<typeof setTimeout> | null;
}

/** Start the server, register it as the platform's UI-client sink, and write
 *  the pointer file. Resolves once listening. */
export async function startUiRpcServer(opts: UiRpcServerOptions): Promise<UiRpcServer> {
  const socketPath = opts.socketPath ?? defaultSocketPath();
  const pointerFile = opts.pointerFile === null ? null : (opts.pointerFile ?? path.join(orchestraHome(), 'ui-sock'));
  const pingIntervalMs = opts.pingIntervalMs ?? PING_INTERVAL_MS;
  const pongTimeoutMs = opts.pongTimeoutMs ?? PONG_TIMEOUT_MS;
  const clients = new Set<Client>();

  const dropClient = (c: Client): void => {
    if (c.idleTimer) clearTimeout(c.idleTimer);
    if (c.pongTimer) clearTimeout(c.pongTimer);
    c.idleTimer = null;
    c.pongTimer = null;
    clients.delete(c);
    c.socket.destroy();
  };

  const send = (c: Client, buf: Buffer): void => {
    try {
      c.socket.write(buf);
    } catch {
      dropClient(c);
    }
  };

  /** Re-arm the idle→ping→dead ladder after any inbound traffic. */
  const touch = (c: Client): void => {
    if (c.pongTimer) {
      clearTimeout(c.pongTimer);
      c.pongTimer = null;
    }
    if (c.idleTimer) clearTimeout(c.idleTimer);
    c.idleTimer = setTimeout(() => {
      send(c, encodeJsonFrame({ t: 'ping' }));
      c.pongTimer = setTimeout(() => {
        log.warn('ui-rpc: client unresponsive to ping — dropping');
        dropClient(c);
      }, pongTimeoutMs);
      if (typeof c.pongTimer.unref === 'function') c.pongTimer.unref();
    }, pingIntervalMs);
    if (typeof c.idleTimer.unref === 'function') c.idleTimer.unref();
  };

  const table = opts.handlers as UiRpcHandlerTable;

  const dispatchReq = (c: Client, frame: ReqFrame): void => {
    const handler = table[frame.method];
    if (typeof handler !== 'function') {
      send(
        c,
        encodeJsonFrame({
          t: 'res',
          id: frame.id,
          ok: false,
          error: { message: `unknown method: ${frame.method}` },
        }),
      );
      return;
    }
    let params = Array.isArray(frame.params) ? frame.params : [];
    // Spec §4 deviation: saveClipboardImage's bytes travel as base64 in JSON;
    // the handler wants the renderer's Uint8Array shape.
    if (frame.method === 'saveClipboardImage' && typeof params[1] === 'string') {
      params = [params[0], new Uint8Array(Buffer.from(params[1], 'base64'))];
    }
    void Promise.resolve()
      .then(() => (handler as (...a: unknown[]) => unknown)(...params))
      .then(
        (result) => send(c, encodeJsonFrame({ t: 'res', id: frame.id, ok: true, result })),
        (err: unknown) => {
          const message = err instanceof Error ? err.message : String(err);
          const name = err instanceof Error ? err.name : undefined;
          log.warn(`ui-rpc: method ${frame.method} failed: ${message}`);
          send(
            c,
            encodeJsonFrame({ t: 'res', id: frame.id, ok: false, error: { message, name } }),
          );
        },
      );
  };

  const handleFrame = (c: Client, frame: UiRpcFrame): void => {
    if (frame.t === 'ptyWrite') {
      // Fast-path PTY input: route through the SAME ptyWrite handler as the
      // JSON req so hasInput / heavy-resume gating can never be bypassed.
      const handler = table['ptyWrite'] as
        | ((id: string, data: string) => unknown)
        | undefined;
      if (handler) void Promise.resolve(handler(frame.id, frame.data.toString('utf8'))).catch(() => {});
      return;
    }
    if (frame.t === 'ptyData') return; // server→client only; ignore from a client
    if (!isUiRpcJsonFrame(frame)) return;
    switch (frame.t) {
      case 'hello':
        c.handshaken = true;
        c.clientKind = frame.clientKind;
        c.focused = frame.focused === true;
        if (frame.proto !== UI_RPC_PROTO) {
          log.warn(
            `ui-rpc: client proto ${frame.proto} != ${UI_RPC_PROTO} — answering with ours (client decides)`,
          );
        }
        send(
          c,
          encodeJsonFrame({
            t: 'helloOk',
            proto: UI_RPC_PROTO,
            appVersion: opts.appVersion,
            backendKind: opts.backendKind,
          }),
        );
        break;
      case 'req':
        dispatchReq(c, frame);
        break;
      case 'focus':
        c.focused = frame.focused === true;
        break;
      case 'ping':
        send(c, encodeJsonFrame({ t: 'pong' }));
        break;
      case 'pong':
        break; // touch() already cleared the pending timeout
      default:
        // helloOk / res / event are server→client; a client sending one is a
        // bug on its side but harmless here.
        break;
    }
  };

  const server = net.createServer((socket) => {
    const c: Client = {
      socket,
      decoder: new UiRpcFrameDecoder(),
      handshaken: false,
      clientKind: null,
      focused: false,
      idleTimer: null,
      pongTimer: null,
    };
    clients.add(c);
    touch(c);
    socket.on('data', (chunk) => {
      touch(c);
      let frames: UiRpcFrame[];
      try {
        frames = c.decoder.push(chunk);
      } catch (err) {
        // Framing is unrecoverable per stream — tear the connection down.
        log.warn(`ui-rpc: dropping client on framing error: ${String(err)}`);
        dropClient(c);
        return;
      }
      for (const frame of frames) handleFrame(c, frame);
    });
    socket.on('close', () => dropClient(c));
    socket.on('error', () => dropClient(c));
  });

  // Stale socket file from a crashed run with the same PID — unlink before
  // bind so listen() doesn't fail with EADDRINUSE.
  try {
    fs.unlinkSync(socketPath);
  } catch {
    /* missing is fine */
  }

  await new Promise<void>((resolve, reject) => {
    server.once('error', reject);
    server.listen(socketPath, () => {
      server.removeListener('error', reject);
      resolve();
    });
  });
  // Owner-only, same as the hooks socket.
  try {
    fs.chmodSync(socketPath, 0o600);
  } catch {
    /* best-effort */
  }
  if (pointerFile) {
    try {
      fs.mkdirSync(path.dirname(pointerFile), { recursive: true });
      fs.writeFileSync(pointerFile, socketPath, { mode: 0o600 });
    } catch (e) {
      log.warn('ui-rpc: failed to write socket pointer file', e);
    }
  }
  log.info(`ui-rpc server listening on ${socketPath}`);

  const broadcastEvent = (ipcChannel: string, args: unknown[]): void => {
    if (clients.size === 0) return;
    const channel = wireEventChannel(ipcChannel);
    if (!channel) return; // not part of the ui-rpc contract (e.g. pty:data)
    const buf = encodeJsonFrame({ t: 'event', channel, args });
    for (const c of clients) if (c.handshaken) send(c, buf);
  };

  const broadcastPtyData = (id: string, data: string): void => {
    if (clients.size === 0) return;
    const buf = encodePtyDataFrame(id, data);
    for (const c of clients) if (c.handshaken) send(c, buf);
  };

  const api: UiRpcServer = {
    socketPath,
    clientCount: () => {
      let n = 0;
      for (const c of clients) if (c.handshaken) n++;
      return n;
    },
    anyFocused: () => {
      for (const c of clients) if (c.handshaken && c.focused) return true;
      return false;
    },
    broadcastEvent,
    broadcastPtyData,
    close: async () => {
      setUiClientSink(null);
      for (const c of [...clients]) dropClient(c);
      await new Promise<void>((resolve) => server.close(() => resolve()));
      try {
        fs.unlinkSync(socketPath);
      } catch {
        /* already gone */
      }
      if (pointerFile) {
        // Only remove the pointer if it still points at OUR socket — a newer
        // backend may have already claimed it.
        try {
          if (fs.readFileSync(pointerFile, 'utf8') === socketPath) fs.unlinkSync(pointerFile);
        } catch {
          /* best-effort */
        }
      }
    },
  };

  // Wire the platform seam's fan-out to this server. Every implementation's
  // broadcast/broadcastPtyData/notify now reaches attached clients.
  const sink: UiClientSink = {
    event: broadcastEvent,
    ptyData: broadcastPtyData,
    anyFocused: api.anyFocused,
    clientCount: api.clientCount,
  };
  setUiClientSink(sink);

  return api;
}
