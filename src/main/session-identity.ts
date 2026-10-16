// #379 / ADR 0008 — host half of the per-call bus identity: the session-key registry + the `/identity` service. Node-only (deps injected; wiring: session-identity-host.ts)
// so it moves unchanged into the host daemon (#136/#137). The key lives only in the session env; the host keeps its SHA-256 (0600) — never logged, never in a reply.

import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import type { IdentityReply } from '../shared/session-identity.ts';

/** A fresh 256-bit session key (hex). */
export function mintSessionKey(): string {
  return crypto.randomBytes(32).toString('hex');
}

export function hashSessionKey(key: string): string {
  return crypto.createHash('sha256').update(key, 'utf8').digest('hex');
}

export type KeyVerdict = 'ok' | 'superseded' | 'unregistered';

export interface SessionKeyRegistry {
  /** Record `key` as THE live session key of `wsId` (replacing any earlier one). Sync; THROWS if it cannot be persisted. */
  register(wsId: string, key: string): void;
  /** Drop the workspace's entry (deleted workspace). */
  forget(wsId: string): void;
  /** Does the host hold a key for this workspace (i.e. can it answer its live session)? */
  has(wsId: string): boolean;
  /** ok = the live key · superseded = an entry exists and this is not it · unregistered = no entry (the host cannot vouch). */
  verify(wsId: string, key: string): KeyVerdict;
}

interface RegistryFile {
  version: 1;
  sessions: Record<string, { hash: string; issuedAt: number }>;
}

export interface RegistryFs {
  readFileSync(file: string, enc: 'utf8'): string;
  writeFileSync(file: string, data: string, opts: { mode: number }): void;
  renameSync(from: string, to: string): void;
  mkdirSync(dir: string, opts: { recursive: true }): void;
}

/**
 * The registry over one JSON file. Loaded once, authoritative in memory afterwards (one host process
 * per ORCHESTRA_HOME — the single-instance lock); every change is persisted tmp + rename BEFORE it is
 * visible, so a crash never leaves a half-written file and a failed write changes nothing.
 * A missing/corrupt file loads EMPTY (`warn` says so): every keyed CLI then reads 'unregistered' and
 * falls back to its env + the stale marker — degraded, never wrongly refused.
 */
export function createSessionKeyRegistry(
  file: string,
  deps: { fs?: RegistryFs; now?: () => number; warn?: (msg: string, err?: unknown) => void } = {},
): SessionKeyRegistry {
  const fsx: RegistryFs = deps.fs ?? fs;
  const now = deps.now ?? Date.now;
  const warn = deps.warn ?? (() => {});
  let sessions: RegistryFile['sessions'] = {};
  try {
    const parsed = JSON.parse(fsx.readFileSync(file, 'utf8')) as Partial<RegistryFile>;
    if (parsed && parsed.version === 1 && parsed.sessions && typeof parsed.sessions === 'object') {
      for (const [id, v] of Object.entries(parsed.sessions)) {
        if (id === '__proto__') continue;
        if (v && typeof v.hash === 'string' && /^[0-9a-f]{64}$/.test(v.hash)) {
          sessions[id] = { hash: v.hash, issuedAt: typeof v.issuedAt === 'number' ? v.issuedAt : 0 };
        }
      }
    } else {
      warn(`session keys: ${file} has an unknown shape — starting with no registered sessions`);
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code !== 'ENOENT') warn(`session keys: cannot read ${file} — starting with no registered sessions`, e);
  }

  const persist = (next: RegistryFile['sessions']): void => {
    const body = JSON.stringify({ version: 1, sessions: next } satisfies RegistryFile);
    const tmp = `${file}.${process.pid}.tmp`;
    fsx.mkdirSync(path.dirname(file), { recursive: true });
    fsx.writeFileSync(tmp, body, { mode: 0o600 });
    fsx.renameSync(tmp, file);
  };

  return {
    register(wsId, key): void {
      if (!wsId || !key) throw new Error('session key: id and key are required');
      const next = { ...sessions, [wsId]: { hash: hashSessionKey(key), issuedAt: now() } };
      persist(next);
      sessions = next;
    },
    forget(wsId): void {
      if (!Object.hasOwn(sessions, wsId)) return;
      const { [wsId]: _gone, ...rest } = sessions;
      void _gone;
      try {
        persist(rest);
      } catch (e) {
        warn(`session keys: could not persist the removal of ${wsId}`, e);
      }
      sessions = rest;
    },
    has: (wsId) => Object.hasOwn(sessions, wsId),
    verify(wsId, key): KeyVerdict {
      const entry = Object.hasOwn(sessions, wsId) ? sessions[wsId] : undefined;
      if (!entry) return 'unregistered';
      // constant-time compare of the two digests; a malformed key can never match
      const presented = Buffer.from(hashSessionKey(typeof key === 'string' ? key : ''), 'hex');
      const stored = Buffer.from(entry.hash, 'hex');
      return presented.length === stored.length && crypto.timingSafeEqual(presented, stored) ? 'ok' : 'superseded';
    },
  };
}

export interface IdentityServiceDeps {
  registry: Pick<SessionKeyRegistry, 'verify'>;
  /** The workspace's CURRENT wave run (nearest orchestrator at or above it), or null when the workspace is unknown. */
  runIdFor(wsId: string): string | null;
  /** The run's current coordinator generation (0 = unfenced). THROW when it cannot be read (the service then cannot vouch). */
  generationOf(runId: string): number;
}

/**
 * The `/identity` service: `{id, key}` → the workspace's CURRENT run + generation, only for the key of its
 * live session. Pure over its deps; the reply never contains the key. A key that is not the live one is
 * REFUSED (`superseded`, #128) — the CLI must not fall back to its env on that; a workspace the host holds
 * no key for answers `unregistered` (the CLI falls back).
 */
export function resolveSessionIdentity(req: Record<string, unknown>, deps: IdentityServiceDeps): IdentityReply {
  const id = typeof req.id === 'string' ? req.id.trim() : '';
  const key = typeof req.key === 'string' ? req.key : '';
  if (!id || !key) return { ok: false, code: 'unregistered', error: 'identity: missing id or key' };
  const verdict = deps.registry.verify(id, key);
  if (verdict === 'unregistered') {
    return { ok: false, code: 'unregistered', error: `identity: the host holds no session key for workspace ${id}` };
  }
  if (verdict === 'superseded') {
    return {
      ok: false,
      code: 'superseded',
      error: `this session of workspace ${id} was superseded — a newer session is live (or its key is not the live one)`,
    };
  }
  const runId = deps.runIdFor(id);
  if (runId === null) return { ok: false, code: 'unregistered', error: `identity: unknown workspace ${id}` };
  let generation: number;
  try {
    generation = deps.generationOf(runId);
  } catch {
    // the host cannot state the generation → it cannot vouch: the CLI keeps its baked one (never an unfenced call on a failed read)
    return { ok: false, code: 'unregistered', error: `identity: the coordinator generation of run ${runId} is unreadable` };
  }
  return { ok: true, runId, generation: Number.isInteger(generation) && generation > 0 ? generation : null };
}

/** The `generationOf` dep over a (possibly absent) bus handle: with NO bus it THROWS — the service then cannot vouch and the CLI keeps its baked generation (never an unfenced answer). */
export function busGenerationReader<D>(getDb: () => D | null, read: (db: D, runId: string) => number): (runId: string) => number {
  return (runId) => {
    const db = getDb();
    if (!db) throw new Error('bus unavailable');
    return read(db, runId);
  };
}
