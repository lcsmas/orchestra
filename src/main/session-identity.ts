// #379 / ADR 0008 — the HOST half of "bus identity resolved by the host per CLI call": the session-key
// registry + the `/identity` service. Node-only on purpose (no Electron, no store, no bus import — the
// deps are injected; production wiring: session-identity-host.ts) so it moves unchanged into the future
// host daemon (#136) and is on the #137 seam inventory as "pure Node". Pure half: ../shared/session-identity.ts.
//
// SECRECY: the key itself lives ONLY in the session's env (handed to the CLI at spawn); the host keeps its
// SHA-256 (`<ORCHESTRA_HOME>/session-keys.json`, 0600). The key is never logged, never in a reply, never
// in a Workspace record (those are broadcast and spread-copied — a stale copy would revert the hash).

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
      if (!(wsId in sessions)) return;
      const { [wsId]: _gone, ...rest } = sessions;
      void _gone;
      try {
        persist(rest);
      } catch (e) {
        warn(`session keys: could not persist the removal of ${wsId}`, e);
      }
      sessions = rest;
    },
    has: (wsId) => wsId in sessions,
    verify(wsId, key): KeyVerdict {
      const entry = sessions[wsId];
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
  /** The run's current coordinator generation (0 = unfenced). A throw reads as 0 (the unfenced v1 path). */
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
  let generation = 0;
  try {
    generation = deps.generationOf(runId);
  } catch {
    generation = 0;
  }
  return { ok: true, runId, generation: Number.isInteger(generation) && generation > 0 ? generation : null };
}
