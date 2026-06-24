/**
 * Transport seam for terminal sessions.
 *
 * A `SessionTransport` is the minimal contract the PTY layer (pty.ts) needs to
 * drive a terminal-backed process, independent of *how* that process runs.
 * Today the only implementation is {@link ../local-pty LocalPtyTransport},
 * which wraps node-pty. A future remote backend (sandbox-exec, a websocket to a
 * cloud sandbox, …) can satisfy the same interface and slot in without touching
 * any caller in pty.ts.
 *
 * The transport is deliberately *dumb*: it spawns a process, emits raw output
 * bytes via {@link SessionTransport.onData}, and forwards writes/resizes/kills.
 * Everything that's transport-agnostic — IPC data coalescing, on-disk
 * scrollback logging, the sessions map, status events — lives in the layer
 * above (pty.ts), so any transport only has to relay bytes.
 */

/** Options for spawning the process behind a session — the full set of inputs a
 *  terminal session needs, with no node-pty (or any backend) specifics. */
export interface TransportSpawnOptions {
  command: string;
  args: string[];
  cwd: string;
  /** Fully-resolved environment for the process. The layer above builds this
   *  (process.env + extras + TERM + hook vars); the transport passes it through
   *  verbatim — node-pty replaces env rather than merging it. */
  env: Record<string, string>;
  cols: number;
  rows: number;
}

/** Handle returned by the transport's event subscriptions, so the caller can
 *  detach. Mirrors node-pty's `IDisposable` but is backend-neutral. */
export interface TransportDisposable {
  dispose(): void;
}

/** Exit information surfaced to {@link SessionTransport.onExit}. */
export interface TransportExit {
  exitCode: number;
}

/**
 * A spawned terminal session, decoupled from its backend.
 *
 * Implementations spawn the process eagerly in their factory (mirroring
 * node-pty's synchronous `spawn`) and expose it through this handle.
 */
export interface SessionTransport {
  /** OS process id when the backend has one locally; undefined for backends
   *  (e.g. a remote sandbox) where no local pid is meaningful. Informational
   *  only — used for logging. */
  readonly pid: number | undefined;

  /** Subscribe to raw output bytes. Emitted as-is; the caller handles logging
   *  and IPC coalescing. */
  onData(listener: (data: string) => void): TransportDisposable;

  /** Subscribe to process exit. Fires once. */
  onExit(listener: (e: TransportExit) => void): TransportDisposable;

  /** Write input to the process. */
  write(data: string): void;

  /** Apply a new terminal size. */
  resize(cols: number, rows: number): void;

  /** Terminate the process. */
  kill(): void;
}

/** Factory shape every transport backend exports. Spawns the process and
 *  returns a live handle (throws if the spawn itself fails, matching the
 *  current node-pty behavior). */
export type TransportFactory = (opts: TransportSpawnOptions) => Promise<SessionTransport>;
