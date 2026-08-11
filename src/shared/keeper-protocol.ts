// Wire protocol + pure policy logic for the detached session keeper.
//
// The keeper (src/keeper/index.ts) is a tiny detached daemon that owns a
// `claude` CLI subprocess and relays its stream-json stdio over a unix socket
// so the SDK session survives Orchestra quitting (spike:
// docs/spikes/keeper-findings.md). This module is the shared, Electron-free
// half: frame shapes, newline-JSON codec, and the linger/wedge shutdown policy
// — all pure so `node --test` covers them without spawning anything.
//
// Framing is newline-delimited JSON (NOT the sandbox 4-byte length prefix):
// the payload itself is the CLI's newline-JSON stdio, volumes are small, and
// newline framing keeps the keeper free of any decoder state beyond a line
// buffer. Binary chunks ride as base64.

/** Client → keeper frames. */
export type KeeperClientFrame =
  /** Identify + CLAIM the client slot (preempts any previous client — last
   *  wins, so a stale half-dead connection can never brick reattach). Keeper
   *  answers with `helloAck`. */
  | { t: 'hello'; wsId: string }
  /** Read-only liveness check: answered with `helloAck` but does NOT claim the
   *  client slot — safe to send while another client is attached (used by
   *  probeKeeper/listLiveKeepers without kicking a live session). */
  | { t: 'probe'; wsId: string }
  /** Spawn the CLI (only valid when `helloAck.running` was false). */
  | { t: 'spawn'; command: string; args: string[]; cwd: string; env: Record<string, string | undefined> }
  /** Raw bytes for the CLI's stdin. */
  | { t: 'stdin'; b64: string }
  /** EOF the CLI's stdin — the graceful-shutdown trigger. The keeper then
   *  escalates on its own clock (EOF → SIGTERM → SIGKILL), which is what makes
   *  the bridge handle's `kill()` safe to no-op (the SDK's post-grace kill was
   *  only a wedged-CLI backstop, and the keeper owns that now). */
  | { t: 'stdinEnd' }
  /** Hard-kill the CLI and exit — the explicit-stop path (sdkStop/killKeeper). */
  | { t: 'kill'; signal?: 'SIGTERM' | 'SIGKILL' };

/** Keeper → client frames. */
export type KeeperDaemonFrame =
  | {
      t: 'helloAck';
      wsId: string;
      running: boolean;
      pid?: number;
      startedAt?: number;
      /** True once the CLI has EVER streamed turn activity (assistant/user/
       *  stream lines). False = the session is still in INIT — a client death
       *  in that window orphans the init handshake (in-process MCP) and wedges
       *  the CLI for ~60s, so clients must NOT attach to it (kill + respawn
       *  instead) and the keeper itself kills it after a short detach grace. */
      everStarted?: boolean;
      /** True when a turn is in flight (activity seen, no result yet) — lets
       *  an attaching client restore the "Working…" turn state it never saw
       *  the start of. */
      turnInFlight?: boolean;
    }
  /** Raw bytes from the CLI's stdout. */
  | { t: 'stdout'; b64: string }
  /** CLI exited (delivered only to an attached client; a detached keeper just
   *  cleans up and exits — relaunch finds no socket and resumes by id). */
  | { t: 'exit'; code: number | null; signal: string | null }
  | { t: 'err'; msg: string };

export type KeeperFrame = KeeperClientFrame | KeeperDaemonFrame;

/** Encode one frame for the wire (includes the trailing newline). */
export function encodeKeeperFrame(f: KeeperFrame): string {
  return JSON.stringify(f) + '\n';
}

/** Parse one line into a frame; null for garbage (a keeper must never crash on
 *  a malformed line — the peer may be a different Orchestra version). */
export function parseKeeperFrame(line: string): KeeperFrame | null {
  try {
    const v: unknown = JSON.parse(line);
    if (typeof v === 'object' && v !== null && typeof (v as { t?: unknown }).t === 'string') {
      return v as KeeperFrame;
    }
    return null;
  } catch {
    return null;
  }
}

/** Incremental newline splitter: feed chunks, get complete lines (without the
 *  newline). Carries a partial-line buffer across chunks. */
export function createLineSplitter(onLine: (line: string) => void): (chunk: string | Uint8Array) => void {
  let buf = '';
  return (chunk) => {
    buf += typeof chunk === 'string' ? chunk : Buffer.from(chunk).toString('utf8');
    let i: number;
    while ((i = buf.indexOf('\n')) >= 0) {
      const line = buf.slice(0, i);
      buf = buf.slice(i + 1);
      if (line.trim().length > 0) onLine(line);
    }
  };
}

// ---------------------------------------------------------------------------
// Shutdown policy (linger + wedge backstop)
// ---------------------------------------------------------------------------

/** How a CLI stdout line bears on turn state. `result` closes a turn;
 *  assistant/user/stream activity opens one; `system` lines (init,
 *  thinking_tokens) are NEUTRAL — an attach emits a fresh `system/init`, and
 *  treating it as turn-opening would hold an idle CLI alive forever. */
export function classifyStdoutLine(line: string): 'result' | 'activity' | 'neutral' {
  let v: unknown;
  try {
    v = JSON.parse(line);
  } catch {
    return 'neutral';
  }
  if (typeof v !== 'object' || v === null) return 'neutral';
  const t = (v as { type?: unknown }).type;
  if (t === 'result') return 'result';
  if (t === 'assistant' || t === 'user' || t === 'stream_event' || t === 'tool_progress') return 'activity';
  return 'neutral';
}

export interface KeeperPolicy {
  /** Detached + turn complete → shut down after this long. Post-turn, a live
   *  process is redundant (resume-by-id restores the conversation), so linger
   *  only long enough to make quit-then-reopen instant. */
  lingerMs: number;
  /** Detached + turn NOT complete + no stdout at all for this long → assume
   *  wedged (e.g. an in-flight mcp_message nobody can answer — measured in the
   *  spike) and shut down rather than leak a stuck CLI forever. */
  wedgeMs: number;
  /** Detached + the session NEVER streamed any turn activity → the CLI is
   *  still in INIT (hooks, MCP handshake). A client death there orphans the
   *  init handshake and wedges the CLI (~60s MCP timeout; reproduced from a
   *  real quit-right-after-send), and nothing pre-turn is worth preserving —
   *  the sent prompt sits in the CLI's queue, unrun, and the app persists it
   *  separately (ws.sdkPendingPrompts) for replay. So die fast. */
  initGraceMs: number;
}

export const DEFAULT_KEEPER_POLICY: KeeperPolicy = {
  lingerMs: 15 * 60 * 1000,
  wedgeMs: 2 * 60 * 60 * 1000,
  initGraceMs: 10 * 1000,
};

export interface KeeperState {
  onAttach(): void;
  onDetach(now: number): void;
  onSpawn(now: number): void;
  onStdoutLine(line: string, now: number): void;
  /** Poll: should the keeper begin graceful shutdown now? Latches once true. */
  shouldShutdown(now: number): boolean;
  /** Introspection for tests/logging + helloAck. */
  snapshot(): {
    attached: boolean;
    turnComplete: boolean;
    everStarted: boolean;
    lastStdoutAt: number;
    detachedAt: number;
  };
}

/** Pure keeper shutdown-policy state machine. The daemon calls the event
 *  methods as things happen and polls `shouldShutdown` on a coarse interval —
 *  all time is parameter-injected so tests never sleep. */
export function createKeeperState(policy: KeeperPolicy, spawnedAt: number): KeeperState {
  let attached = false;
  // A fresh CLI is "between turns" until output proves otherwise: if a client
  // spawns it and vanishes before the first send, linger (not wedge) applies.
  let turnComplete = true;
  // Flips true on the FIRST activity line and stays true: distinguishes a
  // session that has really run (linger/wedge rules apply) from one still in
  // INIT (initGrace applies — see KeeperPolicy.initGraceMs).
  let everStarted = false;
  let lastStdoutAt = spawnedAt;
  let detachedAt = spawnedAt;
  let latched = false;

  return {
    onAttach() {
      attached = true;
    },
    onDetach(now) {
      attached = false;
      detachedAt = now;
    },
    onSpawn(now) {
      lastStdoutAt = now;
      detachedAt = now;
    },
    onStdoutLine(line, now) {
      lastStdoutAt = now; // any line is a sign of life for the wedge clock
      const kind = classifyStdoutLine(line);
      if (kind === 'result') turnComplete = true;
      else if (kind === 'activity') {
        turnComplete = false;
        everStarted = true;
      }
    },
    shouldShutdown(now) {
      if (latched) return true;
      if (attached) return false;
      const idleSince = Math.max(detachedAt, lastStdoutAt);
      const limit = !everStarted ? policy.initGraceMs : turnComplete ? policy.lingerMs : policy.wedgeMs;
      if (now - idleSince >= limit) latched = true;
      return latched;
    },
    snapshot() {
      return { attached, turnComplete, everStarted, lastStdoutAt, detachedAt };
    },
  };
}
