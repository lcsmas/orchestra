// Continuous resource monitor + reaper (issue #198 D11 / track T8).
//
// The laptop overheats the longer Orchestra runs. This module is the PURE half
// of an always-on main-process sampler: every 60s it reads /proc (no child
// process spawned — see src/main/resource-monitor.ts) and appends ONE JSON line
// to <ORCHESTRA_HOME>/logs/resources.jsonl describing totals, each Electron
// process, and EACH session tree (keeper → CLI → MCP children) keyed by
// workspace id. It also runs two detectors, each a log WARN with the stable
// prefix `resources:`:
//   (a) a session tree whose workspace is ABSENT from the store → REAP (kill).
//       The delete-leaves-session-alive ROOT CAUSE is issue #124 D3 (an sdkStop
//       on a CLI without a first result is a no-op); this reaper is the SAFETY
//       NET that stops a deleted workspace's ~700 MB session tree from surviving
//       forever, not the fix.
//   (b) a session tree or Electron process over a cpu/rss threshold → advisory
//       WARN (never kills).
//
// Everything here is dependency-free (no fs, no process, no Electron) so the
// plain `node --test` runner covers the reap DECISION and the log-line shape
// without a real /proc or a real store. The platform I/O — reading /proc, the
// Electron app metrics, the keeper pid files, the store, appending the file and
// killing a reaped tree — lives in src/main/resource-monitor.ts and calls the
// functions below.

import type { ProcSample } from './resources.ts';
import { collectTree } from './resources.ts';

// ─── The JSONL line shape ────────────────────────────────────────────────────

/** One Electron process (main / renderer / gpu / utility) in a log line. */
export interface ResourceLogElectronProc {
  /** Electron's process type ("Browser", "Tab", "GPU", "Utility", …). */
  type: string;
  pid: number;
  /** Percent of one core. */
  cpuPct: number;
  rssBytes: number;
}

/** One session tree (keeper → CLI → MCP children) in a log line, keyed by the
 *  owning workspace id. `present` is whether that workspace id is currently in
 *  the store — a `false` here is exactly what the reaper acts on. */
export interface ResourceLogSessionTree {
  workspaceId: string;
  /** The keeper daemon's pid — the ROOT of the tree we walk. */
  keeperPid: number;
  /** Sum over the whole local tree (keeper + CLI + MCP children). */
  cpuPct: number;
  rssBytes: number;
  procCount: number;
  /** Whether the workspace id is present in the store right now. */
  present: boolean;
  /** The workspace's store status, or null when absent from the store. */
  status: string | null;
  /** True when this tick reaped (killed) this tree. */
  reaped: boolean;
}

/** One sample line appended to resources.jsonl. Compact field names keep the
 *  line small (~one per session tree × 60s × up to 7 days). */
export interface ResourceLogLine {
  /** ISO timestamp of the sample. */
  t: string;
  /** Epoch ms of the sample (redundant with `t` but cheap to sort on). */
  at: number;
  /** Totals across the whole machine. */
  totals: {
    cpuCores: number;
    /** Total system memory in bytes. */
    memTotalBytes: number;
    /** Used system memory in bytes (total − available), or null if unknown. */
    memUsedBytes: number | null;
  };
  /** Electron's own processes (main / renderer / gpu / …). */
  electron: ResourceLogElectronProc[];
  /** Every keeper-hosted session tree, keyed by workspace id. */
  sessions: ResourceLogSessionTree[];
}

// ─── Thresholds (detector b — advisory only) ─────────────────────────────────
//
// UNBASELINED starting points sized from LEAD's 16:30 measurement (issue #198
// D11): a healthy session tree is ~700 MB (claude CLI ~350 MB + chrome-devtools
// MCP ~220 MB + server-filesystem ~130 MB + keeper ~56 MB), so the RSS warn sits
// well above one healthy tree to flag a genuine outlier, not the steady state.
// CPU warn is percent of one core sustained across a single 60s tick.

/** A session tree over this RSS is flagged (advisory). 2 GB ≈ 3× a healthy
 *  ~700 MB tree — a clear outlier, not the norm. */
export const SESSION_RSS_WARN_BYTES = 2 * 1024 * 1024 * 1024;
/** A session tree over this CPU (percent of one core) is flagged (advisory). */
export const SESSION_CPU_WARN_PCT = 150;
/** An Electron process over this RSS is flagged (advisory). */
export const ELECTRON_RSS_WARN_BYTES = 2 * 1024 * 1024 * 1024;
/** An Electron process over this CPU (percent of one core) is flagged. */
export const ELECTRON_CPU_WARN_PCT = 100;

// ─── Rotation policy (bounded log: ≤7 days / ≤50 MB) ─────────────────────────

/** Keep at most 7 days of samples. */
export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Rotate the active file once it passes this — one `.1` backup is kept, so the
 *  worst case on disk is ~2× this. */
export const MAX_FILE_BYTES = 50 * 1024 * 1024;

/** Whether the active resources.jsonl should be rotated before this append.
 *  Size-driven only: age-based pruning is applied to the ROTATED backup at
 *  rotation time (the platform side drops a backup older than RETENTION_MS),
 *  because a single active file that never crosses MAX_FILE_BYTES within 7 days
 *  is left untouched — cheapest correct policy. */
export function shouldRotate(activeSizeBytes: number): boolean {
  return activeSizeBytes >= MAX_FILE_BYTES;
}

// ─── The session-tree roots (one per live keeper) ────────────────────────────

/** A live keeper the sampler found on disk: its owning workspace id and the
 *  keeper daemon's pid (the root of the process tree to walk). */
export interface KeeperRoot {
  workspaceId: string;
  keeperPid: number;
}

// ─── Building the log line ───────────────────────────────────────────────────

export interface BuildLogLineInput {
  at: number;
  cpuCores: number;
  memTotalBytes: number;
  /** total − MemAvailable, or null when /proc/meminfo was unreadable. */
  memUsedBytes: number | null;
  /** The full local process table. */
  table: ProcSample[];
  /** pid → CPU percent (of one core) derived from jiffy deltas. */
  cpuPcts: Map<number, number>;
  /** Every live keeper root (workspace id + keeper pid). */
  keeperRoots: KeeperRoot[];
  /** Workspace ids currently present in the store. */
  liveWorkspaceIds: Set<string>;
  /** Electron's own processes. */
  electron: ResourceLogElectronProc[];
  /** Which trees were reaped this tick (workspace ids) — set by the reaper so
   *  the log line records the action inline with the sample. */
  reapedWorkspaceIds: Set<string>;
}

/** Roll one keeper root's process tree into a `ResourceLogSessionTree`. */
export function summarizeSessionTree(
  root: KeeperRoot,
  table: ProcSample[],
  cpuPcts: Map<number, number>,
  liveWorkspaceIds: Set<string>,
  status: string | null,
  reaped: boolean,
): ResourceLogSessionTree {
  const tree = collectTree(root.keeperPid, table);
  let cpuPct = 0;
  let rssBytes = 0;
  for (const p of tree) {
    cpuPct += cpuPcts.get(p.pid) ?? 0;
    rssBytes += p.memBytes;
  }
  return {
    workspaceId: root.workspaceId,
    keeperPid: root.keeperPid,
    cpuPct,
    rssBytes,
    procCount: tree.length,
    present: liveWorkspaceIds.has(root.workspaceId),
    status,
    reaped,
  };
}

/** Assemble the full JSONL line for one sample. `statusFor` maps a workspace id
 *  to its store status (null when absent). */
export function buildResourceLogLine(
  input: BuildLogLineInput,
  statusFor: (wsId: string) => string | null,
): ResourceLogLine {
  const sessions = input.keeperRoots.map((root) =>
    summarizeSessionTree(
      root,
      input.table,
      input.cpuPcts,
      input.liveWorkspaceIds,
      statusFor(root.workspaceId),
      input.reapedWorkspaceIds.has(root.workspaceId),
    ),
  );
  return {
    t: new Date(input.at).toISOString(),
    at: input.at,
    totals: {
      cpuCores: input.cpuCores,
      memTotalBytes: input.memTotalBytes,
      memUsedBytes: input.memUsedBytes,
    },
    electron: input.electron,
    sessions,
  };
}

// ─── The reaper decision (detector a) ────────────────────────────────────────

/** One tree the reaper has decided to kill, with the members to SIGKILL. */
export interface ReapTarget {
  workspaceId: string;
  keeperPid: number;
  /** Every pid in the tree (keeper + CLI + MCP children), the exact set to
   *  kill. Ordered leaf-first so children die before the keeper that would
   *  otherwise relaunch nothing (the keeper exits when its child dies). */
  pids: number[];
  /** Human-readable members for the pre-kill log line (pid + comm). */
  members: Array<{ pid: number; comm: string }>;
}

export interface ReapDecision {
  /** Trees to kill this tick. Empty unless the store loaded from disk. */
  targets: ReapTarget[];
  /** True when the reaper REFUSED to act because the store is not trustworthy
   *  (never loaded from disk). Surfaced so the caller can log why nothing was
   *  reaped even though orphan-looking trees exist. */
  refusedStoreNotLoaded: boolean;
}

/**
 * Decide which session trees to reap. A tree is reaped iff ALL hold:
 *   1. the store is LOADED FROM DISK — an absent/empty store must NEVER be read
 *      as "every workspace was deleted" (the #187 lesson: absence-from-store as
 *      proof-of-deletion is only sound once the file actually parsed);
 *   2. the tree's workspace id is PROVABLY ABSENT from the live store;
 *   3. the tree has at least one live process (an empty tree — keeper pid gone —
 *      is nothing to kill).
 *
 * The members killed are EXACTLY the descendants of the keeper pid (collectTree),
 * so an Electron or unrelated process is never in the set: the root is a keeper
 * daemon pid read from <ORCHESTRA_HOME>/keepers/<wsId>.pid, and every member is a
 * descendant of it. This is the "known session-tree member" gate the brief
 * requires — we never kill by name-match or by heuristic, only by tree membership
 * under a keeper root.
 *
 * The store MUST be read at DECISION time by the caller (a dry-run then kill with
 * a fresh store read) — this function takes the live snapshot as an argument so
 * the caller controls that ordering.
 */
export function decideReap(
  keeperRoots: KeeperRoot[],
  table: ProcSample[],
  liveWorkspaceIds: Set<string>,
  storeLoadedFromDisk: boolean,
): ReapDecision {
  if (!storeLoadedFromDisk) {
    return { targets: [], refusedStoreNotLoaded: true };
  }
  const targets: ReapTarget[] = [];
  for (const root of keeperRoots) {
    if (liveWorkspaceIds.has(root.workspaceId)) continue; // live ws — NEVER reap
    const tree = collectTree(root.keeperPid, table);
    if (tree.length === 0) continue; // keeper pid already gone — nothing to kill
    // Leaf-first: sort descendants after the root so children are killed before
    // the keeper. collectTree returns BFS from the root, so reverse gives a
    // deepest-first-ish order good enough for a SIGKILL sweep.
    const pids = tree.map((p) => p.pid).reverse();
    targets.push({
      workspaceId: root.workspaceId,
      keeperPid: root.keeperPid,
      pids,
      members: tree.map((p) => ({ pid: p.pid, comm: p.comm })),
    });
  }
  return { targets, refusedStoreNotLoaded: false };
}

// ─── The threshold detector (detector b — advisory) ──────────────────────────

/** One advisory over-threshold finding. `kind` names what breached so the log
 *  line and any future UI can group them. */
export interface ThresholdWarning {
  kind: 'session-rss' | 'session-cpu' | 'electron-rss' | 'electron-cpu';
  /** Workspace id for a session finding, Electron process type for an app one. */
  subject: string;
  pid: number;
  /** The measured value that breached (bytes for rss, percent for cpu). */
  value: number;
  /** The threshold it crossed. */
  threshold: number;
}

/** Advisory over-threshold findings across every session tree and Electron
 *  process. Never kills — the caller emits one WARN per finding. Session trees
 *  that were reaped this tick are excluded (they're gone; a stale RSS reading
 *  is not a leak to warn about). */
export function decideThresholdWarnings(
  sessions: ResourceLogSessionTree[],
  electron: ResourceLogElectronProc[],
): ThresholdWarning[] {
  const out: ThresholdWarning[] = [];
  for (const s of sessions) {
    if (s.reaped) continue;
    if (s.rssBytes > SESSION_RSS_WARN_BYTES) {
      out.push({
        kind: 'session-rss',
        subject: s.workspaceId,
        pid: s.keeperPid,
        value: s.rssBytes,
        threshold: SESSION_RSS_WARN_BYTES,
      });
    }
    if (s.cpuPct > SESSION_CPU_WARN_PCT) {
      out.push({
        kind: 'session-cpu',
        subject: s.workspaceId,
        pid: s.keeperPid,
        value: s.cpuPct,
        threshold: SESSION_CPU_WARN_PCT,
      });
    }
  }
  for (const e of electron) {
    if (e.rssBytes > ELECTRON_RSS_WARN_BYTES) {
      out.push({
        kind: 'electron-rss',
        subject: e.type,
        pid: e.pid,
        value: e.rssBytes,
        threshold: ELECTRON_RSS_WARN_BYTES,
      });
    }
    if (e.cpuPct > ELECTRON_CPU_WARN_PCT) {
      out.push({
        kind: 'electron-cpu',
        subject: e.type,
        pid: e.pid,
        value: e.cpuPct,
        threshold: ELECTRON_CPU_WARN_PCT,
      });
    }
  }
  return out;
}
