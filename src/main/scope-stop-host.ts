// #327: the production wiring of `stopMemberScope` (src/main/scope-stop.ts) — the REAL scope reader, the REAL identity-checked Reliquat kill of #325, and `systemctl --user stop` on the member's OWN unit.
// `stopMemberScopeFor` is the ONE entry point the explicit-stop paths call (delete, archive, clear, account migration); a restart, a resume by id and the Veille never do.

import { execFile } from 'node:child_process';
import { killReliquats } from './pause-reliquats.ts';
import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realKillDeps } from './pause-kill.ts';
import { realScopeEnv, scopePrefix, type ScopeEnv } from './memory-scope.ts';
import { scopeGenForWorkspace } from '../shared/memory-scope.ts';
import { stopMemberScope, type ScopeStopDeps, type ScopeStopReport } from './scope-stop.ts';
import { readTrackedKeeperPid, withKeeperLock } from './keeper-client';
import { log } from './logger';

/** `systemctl --user stop <unit>` through execFile (no shell). Only reached for a unit `ownsUnit` accepted. */
function systemctlStop(unit: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'stop', '--', unit], { timeout: 15_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve()));
  });
}

/** The deps of one workspace over the real cgroup tree (or a fake `ScopeEnv` / a stubbed `stopUnit` in tests and rigs). */
export function realScopeStopDeps(wsId: string, over: Partial<ScopeStopDeps> = {}, e: ScopeEnv = realScopeEnv()): ScopeStopDeps {
  const scopeDeps = memberScopeDeps(wsId, e);
  const kill = realKillDeps();
  return {
    scopes: () => scopeDeps.scopes(wsId),
    list: (scope) => scopeDeps.list(scope),
    killReliquats: () => killReliquats(wsId, scopeDeps, kill, { keeperPid: null, cliPid: null }),
    stopUnit: systemctlStop,
    ownsUnit: (unit) => scopeGenForWorkspace(scopePrefix(e), wsId, unit) !== null,
    keeperAlive: () => readTrackedKeeperPid(wsId) !== null,
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    ...over,
  };
}

/** Upper bound the caller waits (the kill rounds, one `systemctl` per generation and the gone-wait add up): a wedged systemd must not park a delete. The stop itself is not cancelled. */
export const SCOPE_STOP_DEADLINE_MS = 45_000;

/** Best effort and never throws: a failed scope stop must not block the delete / archive / clear / migration that called it. Runs under the member's keeper lock — a keeper launch cannot interleave with the kill. */
export async function stopMemberScopeFor(wsId: string, reason: string, deadlineMs = SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const stop = withKeeperLock(wsId, () => stopMemberScope(wsId, reason, realScopeStopDeps(wsId)));
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`scope-stop[${wsId}] (${reason}): still running after ${deadlineMs / 1000}s — not waiting any longer`);
        resolve(null);
      }, deadlineMs);
    });
    stop.catch(() => {}); // a stop that outlives the deadline must not become an unhandled rejection
    return await Promise.race([stop, late]);
  } catch (e) {
    log.warn(`scope-stop[${wsId}] (${reason}) failed`, e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}
