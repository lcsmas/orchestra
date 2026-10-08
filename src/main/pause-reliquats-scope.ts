// Pause trap — the member-scope adapter of the Reliquat kill (#325, wave H ledger #329, FI-1 v1.3): the ONLY place the trap meets `memberScopes` / `listScopeProcs`
// (src/main/memory-scope.ts, Electron-free). A scope is never a hard-coded slice path. Two things FI-1's readers do not say that a DESTRUCTIVE act must know:
//  - `listScopeProcs` answers `[]` for a `cgroup.procs` it cannot read — "empty" and "unreadable" look alike. Here the file is read first: ENOENT/ENODEV/ESRCH = the scope is gone
//    (every member died), any other error = UNKNOWN (the caller retries, it never reads it as "no Reliquat").
//  - the scope's keeper is re-resolved (pid file + the pid's own /proc cgroup) at EVERY listing, so a keeper replaced since the plan changes the roles, not a stale pid.

import path from 'node:path';
import { listScopeProcs, memberScopes, realScopeEnv, type MemberScope, type ScopeEnv } from './memory-scope.ts';
import { parseProcCgroupV2 } from '../shared/memory-scope.ts';
import type { ReliquatScopeDeps } from './pause-reliquats.ts';
import type { ScopeListing, ScopeRef } from '../shared/pause-reliquats.ts';

const GONE = new Set(['ENOENT', 'ENODEV', 'ESRCH']);

/**
 * `memberScopes` answers `[]` for an `app.slice` it could not READ — "no scope" and "cannot look" read alike (review F2). Here a `readdir` failing for any reason but ENOENT (EMFILE, EACCES, EIO…)
 * is UNKNOWN: it throws, which the killer reports as `unknown` (the trap stays open and retries) — never "no tracked scope, trap complete".
 */
function scopesOrThrow(wsId: string, e: ScopeEnv): MemberScope[] {
  let failed: unknown = null;
  const watched: ScopeEnv = {
    ...e,
    readdir: (p) => {
      try {
        return e.readdir(p);
      } catch (err) {
        if ((err as NodeJS.ErrnoException).code !== 'ENOENT') failed = err;
        throw err;
      }
    },
  };
  const out = memberScopes(wsId, watched);
  if (failed) throw failed instanceof Error ? failed : new Error(String(failed));
  return out;
}

/** The scope deps of ONE workspace, over the real cgroup tree (or a fake `ScopeEnv` in tests). */
export function memberScopeDeps(wsId: string, e: ScopeEnv = realScopeEnv()): ReliquatScopeDeps {
  return {
    scopes: (): ScopeRef[] => scopesOrThrow(wsId, e).map((s) => ({ unit: s.unit, cgroupDir: s.cgroupDir })),
    list: (scope): ScopeListing => {
      try {
        e.readFile(path.join(scope.cgroupDir, 'cgroup.procs'));
      } catch (err) {
        return GONE.has((err as NodeJS.ErrnoException).code ?? '') ? 'gone' : 'unreadable';
      }
      let fresh: MemberScope | undefined;
      try {
        fresh = scopesOrThrow(wsId, e).find((s) => s.unit === scope.unit);
      } catch {
        return 'unreadable'; // the slice could not be listed: the scope is not known to be gone
      }
      if (!fresh) return 'gone';
      return listScopeProcs(fresh, null, e);
    },
    cgroupOf: (pid): string | null => {
      try {
        return parseProcCgroupV2(e.readFile(`${e.procRoot}/${pid}/cgroup`));
      } catch {
        return null;
      }
    },
  };
}
