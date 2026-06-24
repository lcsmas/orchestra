/**
 * Remote backend: a {@link SessionTransport} whose process runs in a sandbox,
 * driven over a shared {@link SandboxConnection} (P3).
 *
 * This is the host-side mirror of the shim's per-session PTY. One instance
 * represents one workspace's agent terminal; many instances share a single
 * connection, multiplexed by the workspace id (`session`). It maps the
 * SessionTransport interface 1:1 onto wire frames:
 *
 *   write/resize/kill  → client→sandbox frames carrying this session id
 *   onData             ← `data` frames for this session (via the connection sink)
 *   onExit             ← the `exit` frame for this session (fires once)
 *
 * A `spawn` frame is sent eagerly in the factory, mirroring node-pty's
 * synchronous spawn and LocalPtyTransport's eager construction: by the time the
 * factory resolves, the shim has been told to start the process and this
 * transport is registered to receive its output.
 *
 * `pid` is always undefined — the OS process lives in the sandbox and no local
 * pid is meaningful (the interface documents exactly this case). Activity events
 * and hook RPCs are NOT this transport's concern; they are connection-level
 * (see SandboxConnection.onEvent / onRpc) because they are not per-terminal.
 */

import type {
  SessionTransport,
  TransportDisposable,
  TransportExit,
  TransportSpawnOptions,
} from './types';
import type { SandboxConnection, SessionSink } from './sandbox-connection';

class RemoteTransport implements SessionTransport {
  private readonly dataListeners = new Set<(data: string) => void>();
  private readonly exitListeners = new Set<(e: TransportExit) => void>();
  private exited = false;
  private readonly conn: SandboxConnection;
  private readonly session: string;

  constructor(conn: SandboxConnection, session: string) {
    this.conn = conn;
    this.session = session;
    const sink: SessionSink = {
      handleData: (data) => {
        for (const l of this.dataListeners) l(data);
      },
      handleExit: (exitCode) => this.fireExit(exitCode),
    };
    conn.registerSession(session, sink);
  }

  // Remote process: no local pid. Documented as undefined for remote backends.
  readonly pid = undefined;

  onData(listener: (data: string) => void): TransportDisposable {
    this.dataListeners.add(listener);
    return { dispose: () => this.dataListeners.delete(listener) };
  }

  onExit(listener: (e: TransportExit) => void): TransportDisposable {
    this.exitListeners.add(listener);
    return { dispose: () => this.exitListeners.delete(listener) };
  }

  write(data: string): void {
    if (this.exited) return;
    this.conn.send({ t: 'write', session: this.session, data });
  }

  resize(cols: number, rows: number): void {
    if (this.exited) return;
    this.conn.send({ t: 'resize', session: this.session, cols, rows });
  }

  kill(): void {
    if (this.exited) return;
    this.conn.send({ t: 'kill', session: this.session });
    // The authoritative exit still comes back as an `exit` frame from the shim;
    // we don't synthesize one here so onData/onExit ordering matches the local
    // transport (where the process's final output precedes its exit).
  }

  /** Deliver exit exactly once, then detach from the connection so late frames
   *  for a reused session id can't reach a dead transport. */
  private fireExit(exitCode: number): void {
    if (this.exited) return;
    this.exited = true;
    this.conn.unregisterSession(this.session);
    for (const l of this.exitListeners) l({ exitCode });
    this.exitListeners.clear();
    this.dataListeners.clear();
  }
}

/**
 * Build a remote transport over `conn` for `session` and tell the shim to spawn
 * the process. Returns once the spawn frame is sent — the transport is live and
 * registered to receive output; the actual process start happens in the sandbox.
 *
 * Unlike {@link createLocalPtyTransport}, this takes the shared connection and
 * the session id in addition to the spawn options, so the app layer's
 * `createTransport` const (pty.ts:14) wraps it in a closure that supplies the
 * current connection + the workspace id as the session.
 */
export async function createRemoteTransport(
  conn: SandboxConnection,
  session: string,
  opts: TransportSpawnOptions,
): Promise<SessionTransport> {
  const transport = new RemoteTransport(conn, session);
  conn.send({
    t: 'spawn',
    session,
    command: opts.command,
    args: opts.args,
    cwd: opts.cwd,
    env: opts.env,
    cols: opts.cols,
    rows: opts.rows,
  });
  return transport;
}
