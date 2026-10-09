// #327: the host LOGIC of `stopMemberScope` (src/main/scope-stop.ts) — the REAL scope reader, the REAL identity-checked Reliquat kill of #325, and `systemctl --user stop` on the member's OWN unit — with every
// app-bound collaborator (keeper client, logger) INJECTED, so it loads under plain `node --test`. The app-bound facade is src/main/scope-stop-host.ts.
// The explicit-stop paths (delete, archive, clear, account migration) reach it ONLY through `stopMemberScopeIfAny` / `clearScopedMember` (via the facade), which do NOTHING for a member without a kernel scope
// (memory_cap OFF, unsupported host, a human session): there the stop behaves exactly as before #327. A restart, a resume by id and the Veille never call it.

import { execFile } from 'node:child_process';
import path from 'node:path';
import { killReliquats } from './pause-reliquats.ts';
import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realKillDeps } from './pause-kill.ts';
import { realScopeEnv, scopePrefix, type ScopeEnv } from './memory-scope.ts';
import { parseProcCgroupV2, scopeGenForWorkspace } from '../shared/memory-scope.ts';
import { stopMemberScope, type ScopeStopDeps, type ScopeStopReport } from './scope-stop.ts';

/** `systemctl --user stop <unit>` through execFile (no shell). Only reached for a unit `ownsUnit` accepted. */
function systemctlStop(unit: string): Promise<void> {
  return new Promise((resolve, reject) => {
    execFile('systemctl', ['--user', 'stop', '--', unit], { timeout: 15_000 }, (err, _out, stderr) => (err ? reject(new Error(String(stderr || err.message).trim().slice(0, 200))) : resolve()));
  });
}

/** The unit the member's TRACKED live keeper runs in (its own /proc cgroup): null = no live keeper, 'unknown' = alive but not placeable (the stop then touches nothing). */
export function trackedKeeperUnit(wsId: string, e: ScopeEnv, pidOf: (wsId: string) => number | null): string | null | 'unknown' {
  const pid = pidOf(wsId);
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
export interface HostIo {
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  /** The pid of the member's tracked live keeper (pid file + liveness), null = none. */
  pidOf(wsId: string): number | null;
}

export function realScopeStopDeps(wsId: string, io: HostIo, over: Partial<ScopeStopDeps> = {}, e: ScopeEnv = realScopeEnv()): ScopeStopDeps {
  const scopeDeps = memberScopeDeps(wsId, e);
  const kill = realKillDeps();
  return {
    scopes: () => scopeDeps.scopes(wsId),
    list: (scope) => scopeDeps.list(scope),
    killReliquats: (only) => killReliquats(wsId, { ...scopeDeps, scopes: () => scopeDeps.scopes(wsId).filter((s) => only.some((o) => o.unit === s.unit)) }, kill, { keeperPid: null, cliPid: null }),
    stopUnit: systemctlStop,
    ownsUnit: (unit) => scopeGenForWorkspace(scopePrefix(e), wsId, unit) !== null,
    liveKeeperUnit: () => trackedKeeperUnit(wsId, e, io.pidOf),
    sleep: (ms) => new Promise((r) => setTimeout(r, ms)),
    log: io.log,
    ...over,
  };
}

/** Does the member have a kernel scope (any generation)? An unreadable lookup reads as NO (said once): the explicit stops then behave exactly as before #327. */
export function memberHasScope(wsId: string, e: ScopeEnv, logger: { warn(m: string, e?: unknown): void }): boolean {
  try {
    return memberScopeDeps(wsId, e).scopes(wsId).length > 0;
  } catch (err) {
    logger.warn(`scope-stop[${wsId}]: scope lookup failed — treated as no scope (the stop behaves as before #327)`, err);
    return false;
  }
}

/** Upper bound the caller waits (the kill rounds, one `systemctl` per generation and the gone-wait add up): a wedged systemd must not park a delete. The stop itself is not cancelled. */
export const SCOPE_STOP_DEADLINE_MS = 45_000;

/** The collaborators of the host entries, replaceable in a unit test. */
export interface HostDeps {
  hasScope(wsId: string): boolean;
  /** The per-workspace keeper lock (launches, kills and the scope stop never interleave). NOT reentrant. */
  lock<T>(wsId: string, op: () => Promise<T>): Promise<T>;
  /** `stopMemberScope` over the real cgroup tree. */
  stop(wsId: string, reason: string): Promise<ScopeStopReport | null>;
  /** Kill the keeper iff it is still the one read before; call with the lock HELD. */
  killKeeperIfHeld(wsId: string, expectedPid: number | null, reason: string): Promise<void>;
  log: { warn(m: string, e?: unknown): void };
}


/** `p` bounded to `ms` for the CALLER: resolves `undefined` on overrun (the work is not cancelled and a later rejection is swallowed). */
async function within<T>(p: Promise<T>, ms: number, onLate: () => void): Promise<T | undefined> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  p.catch(() => {}); // an overrunning stop must not become an unhandled rejection
  try {
    return await Promise.race([
      p,
      new Promise<undefined>((resolve) => {
        timer = setTimeout(() => {
          onLate();
          resolve(undefined);
        }, ms);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
  }
}

/** Best effort and never throws: a failed scope stop must not block the delete / archive / clear / migration that called it. Runs under the member's keeper lock; the DEADLINE covers the whole call. */
export async function stopMemberScopeFor(wsId: string, reason: string, deadlineMs: number, d: HostDeps): Promise<ScopeStopReport | null> {
  try {
    const r = await within(d.lock(wsId, () => d.stop(wsId, reason)), deadlineMs, () => d.log.warn(`scope-stop[${wsId}] (${reason}): still running after ${deadlineMs / 1000}s — not waiting any longer`));
    return r ?? null;
  } catch (e) {
    d.log.warn(`scope-stop[${wsId}] (${reason}) failed`, e);
    return null;
  }
}

/**
 * THE entry of the explicit stops that already stop the session (delete, archive, account migration): a member WITHOUT a scope ⇒ null and nothing at all happens (`extra` is not run, no lock, no log);
 * a member WITH one ⇒ `extra` first (the stops master did NOT do at that site: a descendant's session + keeper at archive, the keeper at a migration), bounded, then the scope stop. `extra` never blocks the stop.
 */
export async function stopMemberScopeIfAny(wsId: string, reason: string, extra: (() => Promise<void>) | undefined, deadlineMs: number, d: HostDeps): Promise<ScopeStopReport | null> {
  if (!d.hasScope(wsId)) return null;
  if (extra) {
    try {
      await within(extra(), deadlineMs, () => d.log.warn(`scope-stop[${wsId}] (${reason}): the pre-stop step is still running after ${deadlineMs / 1000}s — going on`));
    } catch (e) {
      d.log.warn(`scope-stop[${wsId}] (${reason}): pre-stop step failed`, e);
    }
  }
  return stopMemberScopeFor(wsId, reason, deadlineMs, d);
}

/**
 * /clear of a member that HAS a scope, the whole tail under ONE hold of the keeper lock — no wake can launch a keeper between the steps: (1) `announce` (persist the cleared resume id, send `session/clear`) first, so the
 * pane can never lose a successor's lines; (2) the keeper read BEFORE the stop is killed iff it is still THE one (a successor has another pid and is left alone); (3) the scope stop, which never touches a scope
 * that holds a live member. The announce IS the clear: it is awaited with NO deadline (a /clear that returned before it ran would let the late persist / `session/clear` wipe a successor's id and lines) — the
 * deadline bounds only the teardown after it. A failed announce is surfaced to the caller (exactly as without a scope) and no teardown is done on top of it.
 */
export async function clearScopedMember(wsId: string, oldKeeperPid: number | null, announce: () => Promise<void>, deadlineMs: number, d: HostDeps): Promise<ScopeStopReport | null> {
  let announceFailed: { e: unknown } | null = null;
  let markAnnounced: () => void = () => {};
  const announced = new Promise<void>((resolve) => {
    markAnnounced = resolve;
  });
  const run = d.lock(wsId, async () => {
    try {
      await announce();
    } catch (e) {
      announceFailed = { e };
      return null;
    } finally {
      markAnnounced();
    }
    await d.killKeeperIfHeld(wsId, oldKeeperPid, 'clear').catch((e) => d.log.warn(`scope-stop[${wsId}] (clear): keeper kill failed`, e));
    return d.stop(wsId, 'clear');
  });
  await Promise.race([announced, run.then(() => undefined, () => undefined)]); // the announce, however long the lock wait
  if (announceFailed) throw (announceFailed as { e: unknown }).e;
  try {
    return (await within(run, deadlineMs, () => d.log.warn(`scope-stop[${wsId}] (clear): the teardown is still running after ${deadlineMs / 1000}s — not waiting any longer`))) ?? null;
  } catch (e) {
    d.log.warn(`scope-stop[${wsId}] (clear) failed`, e);
    return null;
  }
}
