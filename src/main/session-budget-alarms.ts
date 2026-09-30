// Field alarms on REAL sessions (#214) — I/O half. Pure half + design: src/shared/session-budget-alarms.ts;
// wiring: `sampleTick` (resource-monitor.ts) hands every 60 s sample line to `engine.tick`. Node builtins + shared
// only (no Electron/logger/store import) so `node --test` and the rig drive the REAL engine over a real directory.
//
// Each tick: (a) judge every session tree's SETTLED sample history against SESSION_BUDGETS.processes (process-count limit
// derived for the session's stdio-MCP-server count, read off its debug log) and SESSION_BUDGETS.field (idle RSS slope);
// (b) tail the per-session CLI debug logs (#177) still inside their START window and judge their request counts
// against SESSION_BUDGETS.beforeFirstReply. An alarm is ONE log line (`session-budget-alarm: …`) per breach — no UI (D5).

import fs from 'node:fs';
import path from 'node:path';
import { parseSessionDebugLogName } from '../shared/session-debug-log.ts';
import {
  AlarmLedger,
  feedStartWindow,
  formatBudgetAlarm,
  newStartWindow,
  pushTreeSample,
  startWindowBreaches,
  treeBreaches,
  countStdioMcpServers,
  type StartWindow,
  type TreeSample,
} from '../shared/session-budget-alarms.ts';
import type { ResourceLogLine } from '../shared/resource-monitor.ts';
import type { RequestCounts } from '../shared/session-budget.ts';

/** A log is only tailed while young: its start window closes within seconds of spawn, so older files are never opened. */
export const START_LOOKBACK_MS = 10 * 60 * 1000;
/** A tracked log whose first reply never came is abandoned after this (a wedged/idle session is not a request budget). */
export const START_WINDOW_MAX_AGE_MS = 30 * 60 * 1000;
/** Bytes read per file per tick (and per read) — the window is in the first ~100 KB; a giant log can't stall the tick. */
export const READ_CHUNK_BYTES = 1024 * 1024;
const MAX_BYTES_PER_FILE_PER_TICK = 8 * READ_CHUNK_BYTES;
/** MCP servers connect in the first seconds of a session: the server count is read from the head of the log … */
export const MCP_READ_BYTES = 512 * 1024;
/** … but only once the log is this old — before that the count may still be climbing, so it is UNKNOWN (never a guess). */
export const MCP_SETTLE_MS = 2 * 60 * 1000;

export interface BudgetAlarmDeps {
  now(): number;
  /** Directory holding `<wsId>__<ts>.log` captures (`sessionDebugLogDir()` in the app). */
  sessionsDir(): string;
  /** Human label for a workspace id (name/branch), null when unknown. */
  label(wsId: string): string | null;
  /** True while the session owns live background work (a running background task, an armed cron/loop) OR that state is
   *  unknown — its tree is then legitimately busy while the store says idle. A throwing implementation reads as TRUE. */
  backgroundWork(wsId: string): boolean;
  /** Emit ONE alarm line (a WARN in the app log). */
  warn(message: string): void;
}

export interface BudgetAlarmEngine {
  /** Judge one resource-monitor sample line + scan the young debug logs. Never throws. */
  tick(line: ResourceLogLine): void;
  reset(): void;
  /** Test/rig introspection: debug logs currently tracked. */
  trackedLogs(): string[];
  /** Test/rig introspection: what each tracked log's start window has counted so far. */
  logCounts(): Record<string, RequestCounts & { closed: boolean }>;
  /** Test/rig introspection: sessions currently holding an unresolved tree breach in the ledger. */
  alarmOwners(): string[];
  /** Test/rig introspection: stdio MCP servers per session as last resolved (null = unknown → process/memory not judged). */
  mcpStdio(): Record<string, number | null>;
}

interface LogState {
  wsId: string;
  spawnedAtMs: number;
  offset: number;
  window: StartWindow;
  fired: Set<string>;
  done: boolean;
}

export function createBudgetAlarmEngine(deps: BudgetAlarmDeps): BudgetAlarmEngine {
  const history = new Map<string, TreeSample[]>();
  const treeLedger = new AlarmLedger();
  const logs = new Map<string, LogState>();
  const mcpCache = new Map<string, { file: string; n: number }>();
  const mcpLast = new Map<string, number | null>();

  interface LogEntry { name: string; wsId: string; spawnedAtMs: number }
  function listLogs(): LogEntry[] {
    let names: string[];
    try {
      names = fs.readdirSync(deps.sessionsDir());
    } catch {
      return []; // no sessions dir yet
    }
    const out: LogEntry[] = [];
    for (const name of names) {
      const parsed = parseSessionDebugLogName(name);
      if (parsed) out.push({ name, wsId: parsed.wsId, spawnedAtMs: parsed.spawnedAtMs });
    }
    return out;
  }

  /** Stdio MCP servers of the session's CURRENT process (its latest debug log), or null when unknown. */
  function mcpStdioFor(wsId: string, entries: LogEntry[], now: number): number | null {
    let latest: LogEntry | null = null;
    for (const e of entries) if (e.wsId === wsId && (latest === null || e.spawnedAtMs > latest.spawnedAtMs)) latest = e;
    if (latest === null) return null;
    const hit = mcpCache.get(wsId);
    if (hit && hit.file === latest.name) return hit.n;
    if (now - latest.spawnedAtMs < MCP_SETTLE_MS) return null; // still connecting: unknown, and NOT cached
    let fd: number | null = null;
    try {
      fd = fs.openSync(path.join(deps.sessionsDir(), latest.name), 'r');
      const buf = Buffer.alloc(MCP_READ_BYTES);
      const n = countStdioMcpServers(buf.toString('utf8', 0, fs.readSync(fd, buf, 0, buf.length, 0)));
      mcpCache.set(wsId, { file: latest.name, n });
      return n;
    } catch {
      return null;
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  function judgeTrees(line: ResourceLogLine, entries: LogEntry[]): void {
    const seen = new Set<string>();
    for (const s of line.sessions) {
      if (s.reaped || !s.present) continue; // orphans are the reaper's business, not a live session's budget
      seen.add(s.workspaceId);
      let background = true; // fail toward silence
      try {
        background = deps.backgroundWork(s.workspaceId);
      } catch {
        /* keep true */
      }
      const h = pushTreeSample(history.get(s.workspaceId) ?? [], { at: line.at, procCount: s.procCount, rssBytes: s.rssBytes, status: s.status, background });
      history.set(s.workspaceId, h);
      const n = mcpStdioFor(s.workspaceId, entries, deps.now());
      mcpLast.set(s.workspaceId, n);
      const broken = treeBreaches(h, n);
      const began = treeLedger.transition(s.workspaceId, broken.map((v) => v.id));
      for (const v of broken) {
        if (!began.includes(v.id)) continue;
        deps.warn(formatBudgetAlarm({ session: s.workspaceId, label: deps.label(s.workspaceId), verdict: v, source: `resource sample ${line.t}` }));
      }
    }
    for (const ws of [...history.keys()]) {
      if (seen.has(ws)) continue; // the tree is gone: forget its history and re-arm, a respawn starts clean
      history.delete(ws);
      mcpLast.delete(ws);
      treeLedger.forget(ws);
    }
  }

  function readNew(file: string, st: LogState): void {
    let fd: number | null = null;
    try {
      fd = fs.openSync(file, 'r');
      let budget = MAX_BYTES_PER_FILE_PER_TICK;
      while (!st.window.closed && budget > 0) {
        const buf = Buffer.alloc(READ_CHUNK_BYTES);
        const n = fs.readSync(fd, buf, 0, buf.length, st.offset);
        if (n <= 0) break;
        budget -= n;
        const nl = buf.subarray(0, n).lastIndexOf(0x0a);
        if (nl < 0) {
          if (n < buf.length) break; // a partial first line: wait for the rest
          st.offset += n; // a >1 MiB line without a newline: skip it rather than stall forever
          continue;
        }
        feedStartWindow(st.window, buf.toString('utf8', 0, nl + 1));
        st.offset += nl + 1;
        if (n < buf.length) break;
      }
    } finally {
      if (fd !== null) fs.closeSync(fd);
    }
  }

  function judgeLog(name: string, st: LogState): void {
    for (const v of startWindowBreaches(st.window)) {
      if (st.fired.has(v.id)) continue;
      st.fired.add(v.id);
      deps.warn(formatBudgetAlarm({ session: st.wsId, label: deps.label(st.wsId), verdict: v, source: `debug log ${name}` }));
    }
  }

  function scanLogs(entries: LogEntry[]): void {
    const now = deps.now();
    const dir = deps.sessionsDir();
    for (const e of entries) {
      if (logs.has(e.name) || now - e.spawnedAtMs > START_LOOKBACK_MS) continue;
      logs.set(e.name, { wsId: e.wsId, spawnedAtMs: e.spawnedAtMs, offset: 0, window: newStartWindow(), fired: new Set(), done: false });
    }
    for (const [name, st] of logs) {
      if (!st.done) {
        if (now - st.spawnedAtMs > START_WINDOW_MAX_AGE_MS) st.done = true;
        else {
          try {
            readNew(path.join(dir, name), st);
          } catch {
            /* raced deletion / unreadable — retry next tick */
          }
          judgeLog(name, st);
          if (st.window.closed) st.done = true;
        }
      }
      // A finished log older than the lookback can never be re-added, so its state (and fired-set) can go.
      if (st.done && now - st.spawnedAtMs > START_LOOKBACK_MS) logs.delete(name);
    }
  }

  return {
    tick(line) {
      let entries: LogEntry[] = [];
      try {
        entries = listLogs();
      } catch (e) {
        deps.warn(`session-budget-alarms (engine): internal error listing session debug logs — ${String((e as Error)?.message ?? e)}`);
      }
      try {
        judgeTrees(line, entries);
      } catch (e) {
        deps.warn(`session-budget-alarms (engine): internal error judging session trees — ${String((e as Error)?.message ?? e)}`);
      }
      try {
        scanLogs(entries);
      } catch (e) {
        deps.warn(`session-budget-alarms (engine): internal error scanning session debug logs — ${String((e as Error)?.message ?? e)}`);
      }
    },
    reset() {
      history.clear();
      logs.clear();
      mcpCache.clear();
      mcpLast.clear();
      for (const o of treeLedger.owners()) treeLedger.forget(o);
    },
    trackedLogs: () => [...logs.keys()],
    alarmOwners: () => treeLedger.owners(),
    mcpStdio: () => Object.fromEntries(mcpLast),
    logCounts: () => Object.fromEntries([...logs].map(([n, st]) => [n, { ...st.window.counts, closed: st.window.closed }])),
  };
}
