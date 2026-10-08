// Pause trap — the member-scope adapter of the Reliquat kill (#325, wave H ledger #329, FI-1 v1.3): the ONLY place the trap meets `memberScopes` / `listScopeProcs`
// (src/main/memory-scope.ts, Electron-free). A scope is never a hard-coded slice path. Two things FI-1's readers do not say that a DESTRUCTIVE act must know:
//  - `listScopeProcs` answers `[]` for a `cgroup.procs` it cannot read — "empty" and "unreadable" look alike. Here the file is read first: ENOENT/ENODEV/ESRCH = the scope is gone
//    (every member died), any other error = UNKNOWN (the caller retries, it never reads it as "no Reliquat").
//  - the scope's keeper is re-resolved (pid file + the pid's own /proc cgroup) at EVERY listing, so a keeper replaced since the plan changes the roles, not a stale pid.

import path from 'node:path';
import { listScopeProcs, memberScopes, realScopeEnv, type ScopeEnv } from './memory-scope.ts';
import type { ReliquatScopeDeps } from './pause-reliquats.ts';
import type { ScopeListing, ScopeRef } from '../shared/pause-reliquats.ts';

const GONE = new Set(['ENOENT', 'ENODEV', 'ESRCH']);

/** The scope deps of ONE workspace, over the real cgroup tree (or a fake `ScopeEnv` in tests). */
export function memberScopeDeps(wsId: string, e: ScopeEnv = realScopeEnv()): ReliquatScopeDeps {
  return {
    scopes: (): ScopeRef[] => memberScopes(wsId, e).map((s) => ({ unit: s.unit, cgroupDir: s.cgroupDir })),
    list: (scope): ScopeListing => {
      try {
        e.readFile(path.join(scope.cgroupDir, 'cgroup.procs'));
      } catch (err) {
        return GONE.has((err as NodeJS.ErrnoException).code ?? '') ? 'gone' : 'unreadable';
      }
      const fresh = memberScopes(wsId, e).find((s) => s.unit === scope.unit);
      if (!fresh) return 'gone';
      return listScopeProcs(fresh, null, e);
    },
  };
}
