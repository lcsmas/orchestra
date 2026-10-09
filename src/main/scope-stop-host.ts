// #327: the production wiring of `stopMemberScope` (src/main/scope-stop.ts) — the REAL scope reader, the REAL identity-checked Reliquat kill of #325, and `systemctl --user stop` on the member's OWN unit.
// The explicit-stop paths (delete, archive, clear, account migration) reach it ONLY through `stopMemberScopeIfAny` / `clearScopedMember`, which do NOTHING for a member without a kernel scope (memory_cap OFF,
// unsupported host, a human session): there the stop behaves exactly as before #327. A restart, a resume by id and the Veille never call it.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { killReliquats } from './pause-reliquats.ts';
import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realKillDeps } from './pause-kill.ts';
import { realScopeEnv, scopePrefix, type ScopeEnv } from './memory-scope.ts';
import { parseProcCgroupV2, scopeGenForWorkspace } from '../shared/memory-scope.ts';
import { stopMemberScope, type ScopeStopDeps, type ScopeStopReport } from './scope-stop.ts';
import { killKeeperIfHeld, readTrackedKeeperPid, withKeeperLock } from './keeper-client';
import { log } from './logger';

/** `systemctl --user stop <unit>` through execFile (no shell). Only reached for a unit `ownsUnit` accepted. */
function systemctlStop(unit: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'stop', '--', unit], { timeout: 15_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve()));
  });
}

/** The unit the member's TRACKED live keeper runs in (its own /proc cgroup): null = no live keeper, 'unknown' = alive but not placeable (the stop then touches nothing). */
export function trackedKeeperUnit(wsId: string, e: ScopeEnv = realScopeEnv()): string | null | 'unknown' {
  const pid = readTrackedKeeperPid(wsId);
  if (pid === null) return null;
  try {
    const cg = parseProcCgroupV2(e.readFile(`${e.procRoot}/${pid}/cgroup`));
    return cg ? path.posix.basename(cg) : 'unknown';
  } catch (err) {
    const code = (err as NodeJS.ErrnoException).code;
    return code === 'ENOENT' || code === 'ESRCH' ? null : 'unknown'; // died since the pid check: no live keeper
  }
}

/** The deps of one workspace over the real cgroup tree (or a fake `ScopeEnv` / a stubbed `stopUnit` in tests and rigs). */
export function realScopeStopDeps(wsId: string, over: Partial<ScopeStopDeps> = {}, e: ScopeEnv = realScopeEnv()): ScopeStopDeps {
  const scopeDeps = memberScopeDeps(wsId, e);
  const kill = realKillDeps();
  return {
    scopes: () => scopeDeps.scopes(wsId),
    list: (scope) => scopeDeps.list(scope),
    killReliquats: (only) => killReliquats(wsId, { ...scopeDeps, scopes: () => scopeDeps.scopes(wsId).filter((s) => only.some((o) => o.unit === s.unit)) }, kill, { keeperPid: null, cliPid: null }),
    stopUnit: systemctlStop,
    ownsUnit: (unit) => scopeGenForWorkspace(scopePrefix(e), wsId, unit) !== null,
    liveKeeperUnit: () => trackedKeeperUnit(wsId, e),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log,
    ...over,
  };
}

/** Does the member have a kernel scope (any generation)? An unreadable lookup reads as NO: the explicit stops then behave exactly as before #327. */
export function memberHasScope(wsId: string, e: ScopeEnv = realScopeEnv()): boolean {
  try {
    return memberScopeDeps(wsId, e).scopes(wsId).length > 0;
  } catch {
    return false;
  }
}

/** Upper bound the caller waits (the kill rounds, one `systemctl` per generation and the gone-wait add up): a wedged systemd must not park a delete. The stop itself is not cancelled. */
export const SCOPE_STOP_DEADLINE_MS = 45_000;

/** Run `op` under the member's keeper lock (a keeper launch cannot interleave), bounded for the CALLER, never throwing. */
async function boundedLocked(wsId: string, reason: string, deadlineMs: number, op: () => Promise<ScopeStopReport | null>): Promise<ScopeStopReport | null> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    const run = withKeeperLock(wsId, op);
    const late = new Promise<null>((resolve) => {
      timer = setTimeout(() => {
        log.warn(`scope-stop[${wsId}] (${reason}): still running after ${deadlineMs / 1000}s — not waiting any longer`);
        resolve(null);
      }, deadlineMs);
    });
    run.catch(() => {}); // a stop that outlives the deadline must not become an unhandled rejection
    return await Promise.race([run, late]);
  } catch (e) {
    log.warn(`scope-stop[${wsId}] (${reason}) failed`, e);
    return null;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best effort and never throws: a failed scope stop must not block the delete / archive / clear / migration that called it. Runs under the member's keeper lock. */
export function stopMemberScopeFor(wsId: string, reason: string, deadlineMs = SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> {
  return boundedLocked(wsId, reason, deadlineMs, () => stopMemberScope(wsId, reason, realScopeStopDeps(wsId)));
}

/**
 * THE entry of the explicit stops that already stop the session (delete, archive, account migration): a member WITHOUT a scope ⇒ null and nothing at all happens (`extra` is not run, no lock, no log);
 * a member WITH one ⇒ `extra` first (the stops master did NOT do at that site: a descendant's session + keeper at archive, the keeper at a migration), then the scope stop. `extra` never blocks the stop.
 */
export async function stopMemberScopeIfAny(wsId: string, reason: string, extra?: () => Promise<void>): Promise<ScopeStopReport | null> {
  if (!memberHasScope(wsId)) return null;
  if (extra) {
    try {
      await extra();
    } catch (e) {
      log.warn(`scope-stop[${wsId}] (${reason}): pre-stop step failed`, e);
    }
  }
  return stopMemberScopeFor(wsId, reason);
}

/**
 * /clear of a member that HAS a scope, the whole tail under ONE hold of the keeper lock — no wake can launch a keeper between the steps: (1) `announce` (persist the cleared resume id, send `session/clear`) first, so the
 * pane can never lose a successor's lines; (2) the keeper read BEFORE the stop is killed iff it is still THE one (a successor has another pid and is left alone); (3) the scope stop, which never touches a scope
 * that holds a live member.
 */
export async function clearScopedMember(wsId: string, oldKeeperPid: number | null, announce: () => Promise<void>, deadlineMs = SCOPE_STOP_DEADLINE_MS): Promise<ScopeStopReport | null> {
  let announceFailed: { e: unknown } | null = null;
  const report = await boundedLocked(wsId, 'clear', deadlineMs, async () => {
    try {
      await announce();
    } catch (e) {
      announceFailed = { e }; // the clear itself failed: surfaced to the caller below, exactly as without a scope — no teardown on top of a failed clear
      return null;
    }
    await killKeeperIfHeld(wsId, oldKeeperPid, 'clear').catch((e) => log.warn(`scope-stop[${wsId}] (clear): keeper kill failed`, e));
    return stopMemberScope(wsId, 'clear', realScopeStopDeps(wsId));
  });
  if (announceFailed) throw (announceFailed as { e: unknown }).e;
  return report;
}
