// Production wiring of the session-identity service (#379, ADR 0008; logic: session-identity.ts): registry file + store (tree → wave run) + bus (generation).

import path from 'node:path';
import { createSessionKeyRegistry, resolveSessionIdentity, type SessionKeyRegistry } from './session-identity.ts';
import { orchestraHome } from './platform/index.ts';
import { getBus, coordinatorGeneration } from './bus.ts';
import { nearestOrchestratorId } from './wave-run-id.ts';
import { store } from './store.ts';
import { scoped } from './logger.ts';
import type { IdentityReply } from '../shared/session-identity.ts';

const slog = scoped('session-identity');

let registry: SessionKeyRegistry | null = null;

/** `<ORCHESTRA_HOME>/session-keys.json` — hashes only, 0600. Lazy: the home is known once the platform is up. */
export function sessionKeys(): SessionKeyRegistry {
  return (registry ??= createSessionKeyRegistry(path.join(orchestraHome(), 'session-keys.json'), {
    warn: (msg, err) => slog.warn(msg, err),
  }));
}

/** Make `key` the live session key of `wsId` — called by the keeper facade at a FRESH spawn only (never at an attach). Throws if it cannot be persisted. */
export function registerSessionKey(wsId: string, key: string): void {
  sessionKeys().register(wsId, key);
  slog.info(`session key registered for ${wsId}`); // never the key, never its hash
}

export function hasSessionKey(wsId: string): boolean {
  return sessionKeys().has(wsId);
}

export function forgetSessionKey(wsId: string): void {
  sessionKeys().forget(wsId);
}

/** The `/identity` route body → reply. */
export function dispatchIdentityRequest(msg: Record<string, unknown>): IdentityReply {
  return resolveSessionIdentity(msg, {
    registry: sessionKeys(),
    runIdFor: (id) => {
      const ws = store.getWorkspace(id);
      return ws ? nearestOrchestratorId(ws, (x) => store.getWorkspace(x)) : null;
    },
    generationOf: (runId) => {
      const db = getBus();
      return db ? coordinatorGeneration(db, runId) : 0;
    },
  });
}
