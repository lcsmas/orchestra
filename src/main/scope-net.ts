// #343 (wave H follow-up, ledger #329; ADR 0005) — tell the member and its coordinator when the scope's BACKSTOP killed something, even when the keeper was the victim.
// The keeper's kill watch reads the tool leaf `w`; a scope-level episode (keeper + CLI outgrew the room above the tool cap) is invisible to it, and when the keeper dies nothing in the member is left to say so.
// The evidence that outlives the scope is the kernel's own OOM line in the journal (it names the cgroup that hit its limit and the victim's): this module reads it from the APP, after a session ends and at app start.
//   • a LEDGER (keepers/memscopes.json) remembers each launched scope — the cgroup directory is gone with its last process, so the unit, tool cap and backstop must be written down at launch;
//   • a check = read the kernel lines since the unit started → `netKillsForUnit` → ONE record → the SAME sink as every other memory notice (the member's row + one bus message to the coordinator);
//   • every kernel line is reported ONCE, across retries and app restarts (`reported` in the ledger). Delivery is at-least-once: a sink that throws (the bus is down) leaves the line owed and a retry is scheduled.
// Deps are INJECTED (keeper-client wires the real journal / fs / listeners) so node --test and the rig drive THIS code, not a copy. Electron-free.

import fs from 'node:fs';
import path from 'node:path';
import { formatMemKillLine, type KernelOomKill, type MemKillRecord } from '../shared/memory-scope.ts';
import { netKillKey, netKillsForUnit, netRecordOf } from '../shared/scope-net.ts';

export interface ScopeLedgerEntry {
  wsId: string;
  /** When the scope was launched (ms): kernel lines older than this belong to someone else. */
  startedAt: number;
  hardBytes: number | null;
  backstopBytes: number | null;
  /** Nothing left to look for: the scope is gone and a check after its end ran to completion. */
  done: boolean;
  /** Kernel lines (`atMs:pid`) already reported — a line is never told twice. */
  reported: string[];
}

export interface ScopeNetDeps {
  /** Where the ledger lives (a file under the keepers dir). */
  ledgerFile: string;
  now(): number;
  /** The kernel's memcg OOM lines since a time (`needle` = a regex the line must also match: the units asked about — the window is hours or days, the journal is grepped before it is printed); null = the journal is unreadable (do NOT conclude « nothing happened »). */
  readKernelKills(sinceMs: number, needle?: string): Promise<KernelOomKill[] | null>;
  /** Does the scope's cgroup still exist? (A live scope is never marked done.) */
  scopeAlive(unit: string): boolean;
  /** Hand the record to the memory-notice sink. THROWS when it could not be delivered — the line stays owed. */
  deliver(wsId: string, rec: MemKillRecord): void;
  sleep(ms: number): Promise<void>;
  log: { info(m: string): void; warn(m: string, e?: unknown): void };
  /** Delays between the attempts of a check that follows a session end (the journal lags the kill by a few ms to a second). Default {@link END_ATTEMPT_DELAYS_MS}. */
  attemptDelaysMs?: readonly number[];
  /** Delay before a failed delivery is retried (default 30 s) and how many times (default 20). */
  retryMs?: number;
  maxRetries?: number;
  /** Timer seam for the delivery retry (default setTimeout, unref'd). */
  setTimer?(fn: () => void, ms: number): { unref?(): void };
}

/** The first look waits half a second: a burst (the keeper, then the CLI) lands in the journal within ms of the first kill and must make ONE report, not two. */
/** The regex the journal is grepped with for these units: their names (dots escaped), or — past 8 — the common prefix of their names (the sweep asks about many). */
export function needleFor(units: readonly string[]): string {
  const esc = (u: string): string => u.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  if (units.length <= 8) return units.map(esc).join('|');
  const first = units[0];
  let n = first.length;
  for (const u of units) while (n > 0 && !u.startsWith(first.slice(0, n))) n--;
  return esc(first.slice(0, n)); // n = 0 ⇒ an empty group: matches every line (never a wrong filter)
}

export const END_ATTEMPT_DELAYS_MS: readonly number[] = [500, 1000, 2500, 5000];
export const MAX_LEDGER_UNITS = 200;
const RETRY_MS = 30_000;
const MAX_RETRIES = 20;
const SINCE_SLACK_MS = 2000;

export interface ScopeNet {
  /** A scope was launched for `wsId` (or adopted at attach): remember it. Idempotent. */
  note(unit: string, e: { wsId: string; startedAt: number; hardBytes: number | null; backstopBytes: number | null }): void;
  /** The member's session ended (CLI killed by a signal / keeper gone): look for backstop kills of its scopes, with the journal's lag in mind. Never throws. */
  sessionEnded(wsId: string): Promise<void>;
  /** App start: every ledger scope that is gone and not yet done gets ONE check; live ones are left alone. Never throws. */
  sweep(isKnownWorkspace?: (wsId: string) => boolean): Promise<void>;
  /** Test/inspection seam. */
  ledger(): Readonly<Record<string, Readonly<ScopeLedgerEntry>>>;
}

function loadLedger(file: string, warn: (m: string) => void): Map<string, ScopeLedgerEntry> {
  const map = new Map<string, ScopeLedgerEntry>();
  try {
    const raw = JSON.parse(fs.readFileSync(file, 'utf8')) as Record<string, unknown>;
    for (const [unit, v] of Object.entries(raw)) {
      const e = v as Partial<ScopeLedgerEntry> | null;
      if (!e || typeof e.wsId !== 'string' || typeof e.startedAt !== 'number' || !Number.isFinite(e.startedAt)) continue;
      map.set(unit, {
        wsId: e.wsId,
        startedAt: e.startedAt,
        hardBytes: typeof e.hardBytes === 'number' ? e.hardBytes : null,
        backstopBytes: typeof e.backstopBytes === 'number' ? e.backstopBytes : null,
        done: e.done === true,
        reported: Array.isArray(e.reported) ? e.reported.filter((s): s is string => typeof s === 'string').slice(-100) : [],
      });
    }
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== 'ENOENT') warn(`scope-net: ledger ${file} unreadable (${(e as Error).message}) — starting empty; a kill already reported may be reported again`);
  }
  return map;
}

export function createScopeNet(deps: ScopeNetDeps): ScopeNet {
  const entries = loadLedger(deps.ledgerFile, (m) => deps.log.warn(m));
  const delays = deps.attemptDelaysMs ?? END_ATTEMPT_DELAYS_MS;
  const setTimer = deps.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
  const chains = new Map<string, Promise<void>>();
  const retries = new Map<string, number>();
  let warnedUnreadable = false;
  /** Kernel lines already written to the app log (a delivery retry must not log the same kill again). */
  const logged = new Set<string>();

  function persist(): void {
    // bounded: finished scopes go first, then the oldest
    while (entries.size > MAX_LEDGER_UNITS) {
      const victim = [...entries.entries()].find(([, e]) => e.done)?.[0] ?? entries.keys().next().value;
      entries.delete(victim as string);
    }
    try {
      fs.mkdirSync(path.dirname(deps.ledgerFile), { recursive: true });
      const tmp = `${deps.ledgerFile}.${process.pid}.tmp`;
      fs.writeFileSync(tmp, JSON.stringify(Object.fromEntries(entries)));
      fs.renameSync(tmp, deps.ledgerFile); // atomic: a reader never sees a torn file
    } catch (e) {
      deps.log.warn(`scope-net: could not persist the ledger (${(e as Error).message}) — an app restart may report a kill again or miss a scope that ended while it was down`);
    }
  }

  function warnUnreadable(): void {
    if (warnedUnreadable) return;
    warnedUnreadable = true;
    deps.log.warn('scope-net: the kernel log (journalctl -k) is unreadable by this user — a scope-backstop kill cannot be detected from the app (add the user to the systemd-journal/adm group)');
  }

  /** One pass over the ledger entries `units`: returns whether a delivery is still owed. `preread` = lines the caller already read (the boot sweep reads the journal ONCE for every workspace). */
  async function pass(units: string[], sessionEnded: boolean, attempt: number, lastAttempt: boolean, preread?: KernelOomKill[]): Promise<{ owed: boolean; foundAny: boolean }> {
    const live = units.filter((u) => entries.has(u) && !entries.get(u)!.done); // a unit another run already closed costs no read
    if (live.length === 0) return { owed: false, foundAny: false };
    const since = Math.min(...live.map((u) => entries.get(u)!.startedAt)) - SINCE_SLACK_MS;
    const lines = preread ?? (await deps.readKernelKills(since, needleFor(live)));
    if (lines === null) {
      warnUnreadable();
      return { owed: false, foundAny: false };
    }
    let owed = false;
    let foundAny = false;
    let dirty = false;
    for (const unit of live) {
      const e = entries.get(unit)!;
      const fresh = netKillsForUnit(lines, unit, e.startedAt - SINCE_SLACK_MS).filter((k) => !e.reported.includes(netKillKey(k)));
      let unitOwed = false;
      const told = fresh.length > 0;
      if (told) {
        foundAny = true;
        const rec = netRecordOf(fresh, { unit, hardBytes: e.hardBytes, backstopBytes: e.backstopBytes }, sessionEnded);
        if (rec) {
          if (!logged.has(`${unit}:${rec.seq}`)) {
            logged.add(`${unit}:${rec.seq}`);
            deps.log.warn(formatMemKillLine(e.wsId, rec));
          }
          try {
            deps.deliver(e.wsId, rec);
            e.reported = [...e.reported, ...fresh.map(netKillKey)].slice(-100);
            dirty = true;
          } catch (err) {
            owed = unitOwed = true;
            deps.log.warn(`scope-net[${e.wsId}]: could not deliver the backstop kill of ${unit} (attempt ${attempt + 1}) — it stays owed and is retried`, err);
          }
        }
      }
      if (!unitOwed && (lastAttempt || told) && !e.done && !deps.scopeAlive(unit)) {
        e.done = true; // the scope is gone and either the journal was read after its end (last attempt) or its kills are told: nothing left to look for
        dirty = true;
      }
    }
    if (dirty) persist();
    return { owed, foundAny };
  }

  function scheduleRetry(wsId: string, units: string[], sessionEnded: boolean): void {
    const n = (retries.get(wsId) ?? 0) + 1;
    if (n > (deps.maxRetries ?? MAX_RETRIES)) {
      retries.delete(wsId);
      deps.log.warn(`scope-net[${wsId}]: giving up on delivering a backstop kill after ${n - 1} retries`);
      return;
    }
    retries.set(wsId, n);
    const t = setTimer(() => void run(wsId, units, sessionEnded, [0]).catch(() => {}), deps.retryMs ?? RETRY_MS);
    t.unref?.();
  }

  /** Serialized per workspace: an `exit` and a `close` for the same session must not both report the same line. */
  function run(wsId: string, units: string[], sessionEnded: boolean, schedule: readonly number[], preread?: KernelOomKill[]): Promise<void> {
    const prev = chains.get(wsId) ?? Promise.resolve();
    const next = prev.then(async () => {
      for (let i = 0; i < schedule.length; i++) {
        if (schedule[i] > 0) await deps.sleep(schedule[i]);
        const last = i === schedule.length - 1;
        let r: { owed: boolean; foundAny: boolean };
        try {
          r = await pass(units, sessionEnded, i, last, preread);
        } catch (err) {
          deps.log.warn(`scope-net[${wsId}]: check failed`, err);
          return;
        }
        if (r.owed) {
          scheduleRetry(wsId, units, sessionEnded);
          return;
        }
        retries.delete(wsId);
        if (r.foundAny) return; // told (and the unit closed once its scope is gone): a later attempt would only re-read the same lines
      }
    });
    chains.set(wsId, next.catch(() => {}));
    return next;
  }

  return {
    note(unit, e) {
      const cur = entries.get(unit);
      if (cur) return;
      entries.set(unit, { wsId: e.wsId, startedAt: e.startedAt, hardBytes: e.hardBytes, backstopBytes: e.backstopBytes, done: false, reported: [] });
      persist();
    },
    async sessionEnded(wsId) {
      try {
        const units = [...entries.entries()].filter(([, e]) => e.wsId === wsId && !e.done).map(([u]) => u);
        if (units.length === 0) return;
        await run(wsId, units, true, delays);
      } catch (err) {
        deps.log.warn(`scope-net[${wsId}]: session-end check failed`, err);
      }
    },
    async sweep(isKnownWorkspace) {
      try {
        const byWs = new Map<string, string[]>();
        for (const [unit, e] of entries) {
          if (e.done || deps.scopeAlive(unit)) continue; // a live scope: its own session end will check it
          if (isKnownWorkspace && !isKnownWorkspace(e.wsId)) {
            e.done = true; // a deleted workspace: nobody to tell
            continue;
          }
          (byWs.get(e.wsId) ?? byWs.set(e.wsId, []).get(e.wsId)!).push(unit);
        }
        persist();
        if (byWs.size === 0) return;
        // ONE journal read for every workspace with something pending
        const all = [...byWs.values()].flat();
        const since = Math.min(...all.map((u) => entries.get(u)!.startedAt)) - SINCE_SLACK_MS;
        const lines = await deps.readKernelKills(since, needleFor(all));
        if (lines === null) {
          warnUnreadable(); // nothing is marked done: a later start with a readable journal still looks
          return;
        }
        for (const [wsId, units] of byWs) await run(wsId, units, true, [0], lines);
      } catch (err) {
        deps.log.warn('scope-net: boot sweep failed', err);
      }
    },
    ledger: () => Object.fromEntries(entries),
  };
}
