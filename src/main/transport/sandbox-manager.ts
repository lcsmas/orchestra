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
 * Lifecycle is intentionally simple for the first cut: connections open on
 * demand and a dropped socket is dropped from the cache so the next spawn
 * reconnects. Cross-machine attach/handoff and an explicit reconnect/backoff
 * policy are layered on top later; the seam (one connection per endpoint, keyed
 * by URL) is what this establishes.
 */

import { WebSocket } from 'ws';
import type { BrowserWindow } from 'electron';
import { SandboxConnection, type SandboxSocket } from './sandbox-connection';
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
  /** Resolves when the socket is open (or rejects if it errors before opening). */
  ready: Promise<void>;
}

const connections = new Map<string, Entry>();
let mainWindow: BrowserWindow | null = null;

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

  const ws = new WebSocket(endpoint);
  const ready = new Promise<void>((resolve, reject) => {
    ws.once('open', () => {
      log.info(`sandbox connection open: ${endpoint}`);
      resolve();
    });
    ws.once('error', (err) => {
      // Pre-open error → fail the spawn. Post-open errors are handled by the
      // connection's onError and the cache eviction in onClose below.
      reject(err instanceof Error ? err : new Error(String(err)));
    });
  });

  const conn = new SandboxConnection(adaptSocket(ws), {
    onEvent: (session, event, tool) => applyAgentEvent(session, event, tool, window),
    onRpc: (route, payload, reply) => {
      void dispatchRpc(route, payload, window)
        .then(reply)
        .catch((e) => reply({ ok: false, error: e instanceof Error ? e.message : 'rpc failed' }));
    },
    onClose: () => {
      log.info(`sandbox connection closed: ${endpoint}`);
      connections.delete(endpoint); // next spawn reconnects
    },
    onError: (err) => log.warn(`sandbox connection error (${endpoint})`, err),
  });

  connections.set(endpoint, { conn, ws, ready });
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
    try {
      entry.conn.close(1000, 'app shutdown');
    } catch {
      /* ignore */
    }
  }
  connections.clear();
}
