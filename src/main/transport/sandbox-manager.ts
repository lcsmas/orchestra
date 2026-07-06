/**
 * Host-side connection manager for sandbox-hosted workspaces (P4).
 *
 * Owns one {@link SandboxConnection} per sandbox endpoint, lazily opened and
 * cached. This is where the protocol-pure pieces (SandboxConnection /
 * RemoteTransport) meet the live app: it adapts Node's `ws` WebSocket to the
 * connection's structural socket type, and wires the two connection-level
 * callbacks to the app's existing machinery —
 *
 *   onEvent → applyAgentEvent(...)            (replaces the spool tail for
 *                                              remote workspaces)
 *   onRpc   → dispatch{Rename,Spawn,...}      (the same handlers hooks-server.ts
 *                                              uses for local agents)
 *
 * pty.ts asks this module for the connection matching a workspace's endpoint at
 * spawn time; RemoteTransport then rides it. The local node-pty path never
 * touches this module.
 *
 * Lifecycle: connections open on demand, one per endpoint. A socket that drops
 * WITH live sessions is not torn down — the connection holds its sessions (the
 * shim keeps the PTYs running container-side) while this module reconnects
 * with exponential backoff (reconnect-policy.ts), stamping "link lost/
 * restored" banners into the affected terminals. Only when the give-up window
 * elapses are the sessions unwound with EXIT_CONNECTION_LOST, exactly like the
 * pre-policy behavior. A drop with NO live sessions just evicts the cache
 * entry, so the next spawn dials fresh. Cross-machine attach/handoff (item C)
 * remains layered on top later.
 */

import { WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';
import { SandboxConnection, type SandboxSocket } from './sandbox-connection';
import { backoffDelayMs, shouldGiveUp } from './reconnect-policy';
import type { RpcRoute, RpcRequestPayloads, RpcReplyPayload } from '../../shared/sandbox-protocol';
import { applyAgentEvent } from '../activity';
import {
  dispatchRenameRequest,
  dispatchSpawnRequest,
  dispatchPeersRequest,
  dispatchReadRequest,
  dispatchMessageRequest,
} from '../workspaces';
import { log } from '../logger';

/** Adapt a Node `ws` WebSocket to the structural {@link SandboxSocket} the
 *  connection drives. `ws` already matches the shape closely; this pins the
 *  binary type and the readyState contract. */
function adaptSocket(ws: WebSocket): SandboxSocket {
  ws.binaryType = 'nodebuffer';
  return {
    send: (data) => ws.send(data),
    close: (code, reason) => ws.close(code, reason),
    on: (event, listener) => {
      // `ws` types are broader than our three events; the cast is safe because
      // we only ever subscribe to message/close/error.
      ws.on(event, listener as (...args: unknown[]) => void);
    },
    get readyState() {
      return ws.readyState;
    },
  };
}

/**
 * Dispatch one inbound hook RPC to the matching handler and reply with its
 * result. Mirrors the route table in hooks-server.ts exactly (same field guards,
 * same {ok:false} error convention) so a remote agent's hook calls behave
 * identically to a local one's. The payloads are already typed per route by the
 * wire protocol, but we re-apply the presence guards defensively — the shim
 * forwards the agent's raw POST body.
 */
async function dispatchRpc(
  route: RpcRoute,
  payload: RpcRequestPayloads[RpcRoute],
  window: BrowserWindow,
): Promise<RpcReplyPayload> {
  // Each dispatcher returns a concrete `{ok, ...}` result type. The wire treats
  // every reply opaquely (RpcReplyPayload = {ok, [k]: unknown}), so we widen
  // here — the dispatchers are the same ones hooks-server.ts returns verbatim.
  const reply = (r: { ok: boolean }): RpcReplyPayload => r as RpcReplyPayload;
  switch (route) {
    case 'rename': {
      const p = payload as RpcRequestPayloads['rename'];
      if (typeof p.id === 'string' && typeof p.branch === 'string') {
        return reply(await dispatchRenameRequest(p.id, p.branch, window));
      }
      return { ok: false, error: 'missing id or branch' };
    }
    case 'spawn': {
      const p = payload as RpcRequestPayloads['spawn'];
      if (typeof p.task === 'string') {
        return reply(
          await dispatchSpawnRequest(
            {
              from: typeof p.from === 'string' ? p.from : undefined,
              repoPath: typeof p.repoPath === 'string' ? p.repoPath : undefined,
              baseBranch: typeof p.baseBranch === 'string' ? p.baseBranch : undefined,
              task: p.task,
              agent: 'claude',
            },
            window,
          ),
        );
      }
      return { ok: false, error: 'missing task' };
    }
    case 'peers': {
      const p = payload as RpcRequestPayloads['peers'];
      return reply(dispatchPeersRequest({ from: typeof p.from === 'string' ? p.from : undefined }));
    }
    case 'read': {
      const p = payload as RpcRequestPayloads['read'];
      if (typeof p.id === 'string') {
        return reply(dispatchReadRequest({ id: p.id, lines: typeof p.lines === 'number' ? p.lines : undefined }));
      }
      return { ok: false, error: 'missing id' };
    }
    case 'message': {
      const p = payload as RpcRequestPayloads['message'];
      if (typeof p.to === 'string' && typeof p.text === 'string') {
        return reply(
          await dispatchMessageRequest(
            { from: typeof p.from === 'string' ? p.from : undefined, to: p.to, text: p.text },
            window,
          ),
        );
      }
      return { ok: false, error: 'missing to or text' };
    }
    default:
      return { ok: false, error: `unknown route: ${route}` };
  }
}

/** One cached connection plus the socket it rides, keyed by endpoint URL. */
interface Entry {
  conn: SandboxConnection;
  ws: WebSocket;
  /** Resolves when the connection is usable. Replaced with a fresh promise for
   *  the duration of a reconnect, so a spawn arriving mid-outage waits for the
   *  link instead of writing into the void (rejects if the loop gives up). */
  ready: Promise<void>;
  /** Cancels an in-flight reconnect loop (app shutdown). */
  reconnectAbort: AbortController | null;
}

const connections = new Map<string, Entry>();
let mainWindow: BrowserWindow | null = null;

/** Cap on a single WS dial. Without it a black-holed host (drop, no RST) pins
 *  an attempt on the OS connect timeout, stalling the whole backoff ladder. */
const CONNECT_TIMEOUT_MS = 10_000;

// Host-generated terminal banners. They ride the normal data path (and land in
// scrollback), so keep them one line each, colored and clearly ours.
const BANNER_LOST = '\r\n\x1b[33m[orchestra] sandbox link lost — reconnecting…\x1b[0m\r\n';
const BANNER_RESTORED = '\r\n\x1b[32m[orchestra] sandbox link restored\x1b[0m\r\n';
const BANNER_GAVE_UP = '\r\n\x1b[31m[orchestra] sandbox unreachable — giving up (the agent keeps running in the sandbox; restart the session to reattach)\x1b[0m\r\n';

/** Dial an endpoint, resolving once the socket is open. Rejects on error or
 *  after CONNECT_TIMEOUT_MS (terminating the half-open socket). */
function openSocket(endpoint: string): { ws: WebSocket; open: Promise<void> } {
  const ws = new WebSocket(endpoint);
  const open = new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => {
      try {
        ws.terminate();
      } catch {
        /* ignore */
      }
      reject(new Error(`connect timed out after ${CONNECT_TIMEOUT_MS}ms`));
    }, CONNECT_TIMEOUT_MS);
    if (typeof timer.unref === 'function') timer.unref();
    ws.once('open', () => {
      clearTimeout(timer);
      resolve();
    });
    ws.once('error', (err) => {
      clearTimeout(timer);
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });
  return { ws, open };
}

/** Abortable sleep for the backoff ladder. */
function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    if (typeof timer.unref === 'function') timer.unref();
    signal.addEventListener(
      'abort',
      () => {
        clearTimeout(timer);
        reject(new Error('reconnect aborted'));
      },
      { once: true },
    );
  });
}

/**
 * Reconnect a dropped-but-live connection with exponential backoff. Runs until
 * a dial succeeds (sessions resume on the fresh socket), the give-up window
 * elapses (sessions unwind via abandon), or the app shuts down (abort).
 */
async function reconnectLoop(endpoint: string, entry: Entry): Promise<void> {
  const started = Date.now();
  const abort = new AbortController();
  entry.reconnectAbort = abort;

  let resolveReady!: () => void;
  let rejectReady!: (e: Error) => void;
  entry.ready = new Promise<void>((res, rej) => {
    resolveReady = res;
    rejectReady = rej;
  });
  // A rejection with no spawn waiting on it must not crash the process.
  entry.ready.catch(() => {});

  entry.conn.notifySessions(BANNER_LOST);

  for (let attempt = 0; ; attempt++) {
    const delay = backoffDelayMs(attempt);
    if (shouldGiveUp(Date.now() - started + delay)) break;
    try {
      await sleep(delay, abort.signal);
    } catch {
      // App shutdown: closeAllSandboxConnections tears the connection down.
      rejectReady(new Error('sandbox reconnect aborted'));
      return;
    }
    try {
      const { ws, open } = openSocket(endpoint);
      await open;
      entry.conn.attachSocket(adaptSocket(ws));
      entry.ws = ws;
      entry.reconnectAbort = null;
      entry.conn.notifySessions(BANNER_RESTORED);
      log.info(`sandbox connection restored after ${attempt + 1} attempt(s): ${endpoint}`);
      resolveReady();
      return;
    } catch (e) {
      log.warn(
        `sandbox reconnect attempt ${attempt + 1} failed (${endpoint}): ${e instanceof Error ? e.message : String(e)}`,
      );
    }
  }

  entry.reconnectAbort = null;
  log.warn(`sandbox unreachable — giving up on ${endpoint}`);
  entry.conn.notifySessions(BANNER_GAVE_UP);
  rejectReady(new Error('sandbox unreachable — gave up reconnecting'));
  // Unwind the held sessions (EXIT_CONNECTION_LOST) and fire onClose, which
  // evicts the cache entry — the next spawn dials fresh.
  entry.conn.abandon();
}

/** Hand the manager the window every dispatch/activity update targets. Called
 *  once from app startup, alongside startHooksServer / startEventsSpool. */
export function setSandboxWindow(window: BrowserWindow): void {
  mainWindow = window;
}

/**
 * Get (opening if needed) the connection for an endpoint, and await its socket
 * being open. Throws if no window has been registered or the socket fails to
 * open — the caller (pty.ts) unwinds the spawn exactly as it does for a failed
 * local spawn.
 */
export async function getSandboxConnection(endpoint: string): Promise<SandboxConnection> {
  const existing = connections.get(endpoint);
  if (existing) {
    await existing.ready;
    return existing.conn;
  }
  if (!mainWindow) {
    throw new Error('sandbox manager has no window — setSandboxWindow not called');
  }
  const window = mainWindow;

  const { ws, open } = openSocket(endpoint);
  const ready = open.then(() => log.info(`sandbox connection open: ${endpoint}`));

  const conn = new SandboxConnection(adaptSocket(ws), {
    onEvent: (session, event, tool) => applyAgentEvent(session, event, tool, window),
    onRpc: (route, payload, reply) => {
      void dispatchRpc(route, payload, window)
        .then(reply)
        .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : 'rpc failed' }));
    },
    onDisconnect: () => {
      // Unexpected drop. Worth retrying only if terminals are riding this
      // connection; otherwise fall back to the old drop-and-redial-on-next-
      // spawn behavior via an immediate teardown.
      const entry = connections.get(endpoint);
      if (!entry) return; // pre-open failure already evicted the entry
      if (entry.conn.sessionCount === 0) {
        log.info(`sandbox connection dropped with no live sessions: ${endpoint}`);
        entry.conn.abandon();
        return;
      }
      log.warn(
        `sandbox connection lost (${endpoint}) — ${entry.conn.sessionCount} live session(s), reconnecting`,
      );
      void reconnectLoop(endpoint, entry);
    },
    onClose: () => {
      log.info(`sandbox connection closed: ${endpoint}`);
      connections.delete(endpoint); // next spawn reconnects
    },
    onError: (err) => log.warn(`sandbox connection error (${endpoint})`, err),
  });

  connections.set(endpoint, { conn, ws, ready, reconnectAbort: null });
  try {
    await ready;
  } catch (e) {
    connections.delete(endpoint);
    throw e;
  }
  return conn;
}

/** Close all sandbox connections — called on app shutdown alongside stopAll. */
export function closeAllSandboxConnections(): void {
  for (const [, entry] of connections) {
    entry.reconnectAbort?.abort();
    try {
      entry.conn.close(1000, 'app shutdown');
    } catch {
      /* ignore */
    }
  }
  connections.clear();
}
