// #379 / ADR 0008 — pure half of "the host resolves a session's bus identity per CLI call": the CLI sends `{id, key}` (ORCHESTRA_SESSION_KEY) to `/identity`
// and uses the host's run + generation. Fallback (transitional, goes with #136): no key / host unreachable / unvouched → baked env + the `bus-run-stale` marker guard.
// Host half: src/main/session-identity.ts. Map: docs/codebase-map/bus.md → Session identity.

export const SESSION_KEY_ENV = 'ORCHESTRA_SESSION_KEY';
export const IDENTITY_ROUTE = '/identity';

export type IdentityRefusalCode =
  /** The workspace has a registered key and this one is not it — a replaced session (#128): REFUSE. */
  | 'superseded'
  /** The host holds no key for this workspace (never issued / registry lost): it cannot vouch → the CLI falls back. */
  | 'unregistered';

export type IdentityReply =
  | { ok: true; runId: string; /** null = unfenced (generation 0). */ generation: number | null }
  | { ok: false; code: IdentityRefusalCode; error: string };

export type IdentityResolution =
  | { source: 'host'; runId: string; generation: number | null }
  | {
      source: 'env';
      /** no-key: a keyless session (pre-#379 keeper, plain shell) · no-workspace: no ws id in the env ·
       *  unreachable: the host did not answer · unvouched: it answered but cannot vouch for this ws. */
      why: 'no-key' | 'no-workspace' | 'unreachable' | 'unvouched';
    };

/** A replaced session asked the host who it is — the caller must stop (never fall back to its env). */
export class SessionSupersededError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SessionSupersededError';
  }
}

export interface SessionIdentityEnv {
  ORCHESTRA_SESSION_KEY?: string;
  ORCHESTRA_WS_ID?: string;
  ORCHESTRA_WS_ID_IDENTITY?: string;
}

/** The workspace id the CLI identifies as (same rule as `resolveSelfWorkspaceId`, kept dependency-free here). */
function wsIdOf(env: SessionIdentityEnv): string {
  return (env.ORCHESTRA_WS_ID || env.ORCHESTRA_WS_ID_IDENTITY || '').trim();
}

/**
 * Ask the host who this session is. `call` POSTs a route and returns the parsed reply, or THROWS on
 * a transport failure (no socket, refused, timeout) — that is the "host unreachable" case.
 * Throws {@link SessionSupersededError} for a replaced session; every other outcome is a resolution.
 */
export async function resolveHostIdentity(
  env: SessionIdentityEnv,
  call: (route: string, body: Record<string, unknown>) => Promise<Record<string, unknown>>,
): Promise<IdentityResolution> {
  const key = env.ORCHESTRA_SESSION_KEY?.trim();
  if (!key) return { source: 'env', why: 'no-key' };
  const id = wsIdOf(env);
  if (!id) return { source: 'env', why: 'no-workspace' };
  let reply: Record<string, unknown>;
  try {
    reply = await call(IDENTITY_ROUTE, { id, key });
  } catch {
    return { source: 'env', why: 'unreachable' };
  }
  if (reply.ok === true && typeof reply.runId === 'string' && reply.runId.trim()) {
    const gen = reply.generation;
    return {
      source: 'host',
      runId: reply.runId.trim(),
      generation: typeof gen === 'number' && Number.isInteger(gen) && gen > 0 ? gen : null,
    };
  }
  if (reply.ok === false && reply.code === 'superseded') {
    throw new SessionSupersededError(
      typeof reply.error === 'string' && reply.error ? reply.error : 'this session was superseded',
    );
  }
  // `{}` from an app older than #379 (unknown route), `unregistered`, an internal error: the host cannot vouch.
  return { source: 'env', why: 'unvouched' };
}

/** The env bag the CLI's bus verbs read: the host's answer OVERRIDES the baked run + generation (a host
 *  `generation: null` = unfenced, so the baked one is dropped too — never a live run with a frozen generation). */
export function identityEnv<E extends Record<string, string | undefined>>(
  env: E,
  resolution: IdentityResolution | null,
): E {
  if (resolution?.source !== 'host') return env;
  return {
    ...env,
    ORCHESTRA_RUN_ID: resolution.runId,
    ORCHESTRA_COORDINATOR_GENERATION: resolution.generation === null ? undefined : String(resolution.generation),
  };
}

/** The refusal a replaced session gets. Never names the key. */
export function supersededRefusalMessage(hostMessage: string): string {
  return (
    `refused: ${hostMessage.trim()}\n` +
    `  a superseded session may not use the bus (#128) — its workspace was restarted or re-spawned; ` +
    `the live session carries the current identity.`
  );
}

/** The run a stale marker names as the one the session adopts (`new run: <id>` line, see staleRunMarkerBody). */
export function staleRunMarkerNewRun(markerBody: string): string | null {
  const m = /^new run:[ \t]*(\S+)[ \t]*$/m.exec(markerBody);
  return m ? m[1] : null;
}

/**
 * The FALLBACK's send guard: does the stale marker forbid a send from a session whose env run is `envRunId`?
 * Returns the marker's first line (the refusal reason) or null. A marker whose `new run` equals the env run
 * does not block: that env is ALREADY the new run (a bash-mode `!orchestra send` carries a freshly built env),
 * so the send cannot land in the old one. An unreadable `new run` line blocks (fail closed).
 */
export function staleMarkerBlocksSend(markerBody: string, envRunId: string | undefined): string | null {
  const firstLine = markerBody.split('\n', 1)[0];
  if (!firstLine) return null;
  const newRun = staleRunMarkerNewRun(markerBody);
  if (newRun !== null && envRunId && envRunId.trim() === newRun) return null;
  return firstLine;
}
