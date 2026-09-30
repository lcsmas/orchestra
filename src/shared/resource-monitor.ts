// Always-on resource monitor + reaper — PURE half (issue #198 T8). I/O half:
// src/main/resource-monitor.ts; design + gates: docs/codebase-map/resources.md.
// Dependency-free so `node --test` covers the reap DECISION without a real /proc or store.

import type { ProcSample } from './resources.ts';
import { collectTree, parseProcStatLine } from './resources.ts';

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
 *  owning workspace id. `present:false` + `reaped:false` = an orphan the reaper
 *  WITHHELD (identity unproven) — see the `resources:` WARN for the reason. */
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
  /** True when this tick SIGTERMed (reaped) this tree. */
  reaped: boolean;
}

/** One sample line appended to resources.jsonl. */
export interface ResourceLogLine {
  /** ISO timestamp of the sample. */
  t: string;
  /** Epoch ms of the sample. */
  at: number;
  totals: {
    cpuCores: number;
    memTotalBytes: number;
    /** total − available, or null if unknown. */
    memUsedBytes: number | null;
  };
  electron: ResourceLogElectronProc[];
  /** Every keeper-hosted session tree, keyed by workspace id. */
  sessions: ResourceLogSessionTree[];
}

// ─── Thresholds (detector b — advisory only) ─────────────────────────────────
// UNBASELINED, sized from LEAD's 16:30 measurement (#198 D11): a healthy session
// tree is ~700 MB, so the RSS warn (~3×) flags an outlier, not the steady state.

export const SESSION_RSS_WARN_BYTES = 2 * 1024 * 1024 * 1024;
/** Percent of one core over a single 60s tick. */
export const SESSION_CPU_WARN_PCT = 150;
export const ELECTRON_RSS_WARN_BYTES = 2 * 1024 * 1024 * 1024;
export const ELECTRON_CPU_WARN_PCT = 100;

// ─── Bounded log: ≤7 days / ≤50 MB across the active file + one `.1` backup ──

export const RETENTION_MS = 7 * 24 * 60 * 60 * 1000;
/** Per-file cap: active + `.1` ≤ 50 MB TOTAL (the brief's bound). */
export const MAX_FILE_BYTES = 25 * 1024 * 1024;
/** The active file spans ≤ half the retention, so active + `.1` stay ≤ 7 days. */
export const ROTATE_AFTER_MS = RETENTION_MS / 2;

/** Rotate the active file before an append. Unknown age (`null`) counts as expired. */
export function shouldRotate(
  activeSizeBytes: number,
  activeStartedAt: number | null,
  now: number,
): boolean {
  if (activeSizeBytes <= 0) return false;
  if (activeSizeBytes >= MAX_FILE_BYTES) return true;
  return activeStartedAt === null || now - activeStartedAt >= ROTATE_AFTER_MS;
}

/** Drop the `.1` backup once its OLDEST sample passes the retention. Unknown → drop. */
export function shouldDropBackup(backupStartedAt: number | null, now: number): boolean {
  return backupStartedAt === null || now - backupStartedAt > RETENTION_MS;
}

/** `at` of a jsonl file's first line, or null when unreadable. */
export function firstSampleAt(text: string): number | null {
  const nl = text.indexOf('\n');
  try {
    const at = (JSON.parse(nl < 0 ? text : text.slice(0, nl)) as { at?: unknown }).at;
    return typeof at === 'number' && Number.isFinite(at) ? at : null;
  } catch {
    return null;
  }
}

// ─── Building the log line ───────────────────────────────────────────────────

/** A live keeper found on disk: workspace id + the keeper daemon's pid (tree root). */
export interface KeeperRoot {
  workspaceId: string;
  keeperPid: number;
}

export interface BuildLogLineInput {
  at: number;
  cpuCores: number;
  memTotalBytes: number;
  memUsedBytes: number | null;
  table: ProcSample[];
  /** pid → percent of one core, from jiffy deltas. */
  cpuPcts: Map<number, number>;
  keeperRoots: KeeperRoot[];
  liveWorkspaceIds: Set<string>;
  electron: ResourceLogElectronProc[];
  /** Workspace ids whose tree this tick signalled. */
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

/** Assemble the JSONL line for one sample. `statusFor`: ws id → store status (null = absent). */
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

// ─── The reaper (detector a) — decision + identity ───────────────────────────

/** A tree member as CLASSIFIED (sampled): its identity is (pid, startTicks). */
export interface ReapMember {
  pid: number;
  ppid: number;
  comm: string;
  startTicks: number;
}

/** Why a tree is reaped: 'orphan' = workspace absent from the store; 'orphan-untracked' = absent AND
 *  not the pid-file keeper; 'duplicate' = live workspace, a keeper other than the tracked one (#203). */
export type ReapKind = 'orphan' | 'orphan-untracked' | 'duplicate';

export interface ReapTarget {
  workspaceId: string;
  /** Absent = 'orphan' (the T8 shape). */
  kind?: ReapKind;
  /** The pid-file keeper this tree must NOT be (duplicates / untracked orphans); null = none tracked. */
  trackedPid?: number | null;
  keeperPid: number;
  /** Leaf-first (keeper LAST). */
  pids: number[];
  /** BFS order, keeper first — parents precede children. */
  members: ReapMember[];
}

export interface ReapRefusal {
  workspaceId: string;
  reason: string;
}

export interface ReapDecision {
  targets: ReapTarget[];
  /** Orphans the reaper declined to touch, with the named reason. */
  refused: ReapRefusal[];
  /** True when the whole pass was refused because the store never loaded from disk. */
  refusedStoreNotLoaded: boolean;
}

/**
 * Classify orphaned trees. A tree is a target iff the store LOADED FROM DISK
 * (#187 lesson), its workspace id is absent, and EVERY member carries a start-time
 * (else identity is unverifiable → refused, fail closed). Members are keeper
 * descendants only. Classification is NOT authorization: the caller must run
 * verifyReapIdentity at kill time (#198 T8 review F1 — pid reuse).
 */
export function decideReap(
  keeperRoots: KeeperRoot[],
  table: ProcSample[],
  liveWorkspaceIds: Set<string>,
  storeLoadedFromDisk: boolean,
): ReapDecision {
  if (!storeLoadedFromDisk) return { targets: [], refused: [], refusedStoreNotLoaded: true };
  const targets: ReapTarget[] = [];
  const refused: ReapRefusal[] = [];
  for (const root of keeperRoots) {
    if (liveWorkspaceIds.has(root.workspaceId)) continue; // live ws — NEVER reap
    const tree = collectTree(root.keeperPid, table);
    if (tree.length === 0) continue; // keeper pid already gone
    const blind = tree.find((p) => p.startTicks === undefined);
    if (blind) {
      refused.push({
        workspaceId: root.workspaceId,
        reason: `identity-unverifiable (no start-time for pid ${blind.pid}; non-Linux sampler)`,
      });
      continue;
    }
    const members: ReapMember[] = tree.map((p) => ({
      pid: p.pid,
      ppid: p.ppid,
      comm: p.comm,
      startTicks: p.startTicks as number,
    }));
    targets.push({
      workspaceId: root.workspaceId,
      keeperPid: root.keeperPid,
      pids: members.map((m) => m.pid).reverse(),
      members,
    });
  }
  return { targets, refused, refusedStoreNotLoaded: false };
}

/** A process whose argv is a keeper daemon of THIS home (found by argv scan, not by pid file). */
export interface KeeperProc {
  pid: number;
  workspaceId: string;
}

/** Workspace id of a keeper daemon argv `<runtime> …/keeper.js <wsId> <sock> <pidPath> <log>` whose
 *  pid-file arg is THIS home's (`pidPathFor(wsId)`) — a dev/other-home keeper is never matched. */
export function parseKeeperArgv(argv: string[] | null, pidPathFor: (wsId: string) => string): string | null {
  if (!argv) return null;
  for (let i = 0; i + 4 < argv.length; i++) {
    if (argv[i].split(/[\\/]/).pop() !== 'keeper.js') continue;
    const ws = argv[i + 1];
    if (ws && argv[i + 3] === pidPathFor(ws)) return ws;
  }
  return null;
}

/**
 * Classify keeper trees that are NOT the workspace's tracked (pid-file) keeper (#203). Victims: any
 * keeper of an absent workspace other than the tracked one, and — for a LIVE workspace — every keeper
 * other than the tracked one, but only when the tracked one is proven present in the scan. A live
 * workspace's SOLE keeper is never a victim; no tracked keeper ⇒ nothing is reaped (cannot tell which
 * to keep). Store not loaded from disk ⇒ refuse all. Classification is NOT authorization: the caller
 * re-verifies identity + the tracked keeper at kill time.
 */
export function decideDuplicateReap(
  keeperRoots: KeeperRoot[],
  keeperProcs: KeeperProc[],
  table: ProcSample[],
  liveWorkspaceIds: Set<string>,
  storeLoadedFromDisk: boolean,
): ReapDecision {
  if (!storeLoadedFromDisk) return { targets: [], refused: [], refusedStoreNotLoaded: true };
  const targets: ReapTarget[] = [];
  const refused: ReapRefusal[] = [];
  const byWs = new Map<string, KeeperProc[]>();
  for (const p of keeperProcs) byWs.set(p.workspaceId, [...(byWs.get(p.workspaceId) ?? []), p]);
  for (const [ws, procs] of byWs) {
    const live = liveWorkspaceIds.has(ws);
    if (live && procs.length < 2) continue; // sole keeper of a live workspace — NEVER reap
    const tracked = keeperRoots.find((r) => r.workspaceId === ws)?.keeperPid ?? null;
    if (live) {
      if (tracked === null) {
        refused.push({ workspaceId: ws, reason: `no-tracked-keeper (${procs.length} keepers; cannot tell which to keep)` });
        continue;
      }
      if (!procs.some((p) => p.pid === tracked)) {
        refused.push({ workspaceId: ws, reason: `tracked-keeper-not-in-scan (pid ${tracked} is not a keeper argv)` });
        continue;
      }
    }
    for (const v of procs) {
      if (v.pid === tracked) continue;
      const tree = collectTree(v.pid, table);
      if (tree.length === 0) continue;
      const blind = tree.find((p) => p.startTicks === undefined);
      if (blind) {
        refused.push({ workspaceId: ws, reason: `identity-unverifiable (no start-time for pid ${blind.pid}; non-Linux sampler)` });
        continue;
      }
      // A "duplicate" whose tree CONTAINS the tracked keeper is its fork-style wrapper (`timeout … node keeper.js`):
      // reaping it would SIGTERM the live sole keeper (review K1).
      if (live && tracked !== null && tree.some((p) => p.pid === tracked)) {
        refused.push({ workspaceId: ws, reason: `victim-tree-contains-tracked-keeper (pid ${v.pid} wraps tracked pid ${tracked})` });
        continue;
      }
      const members: ReapMember[] = tree.map((p) => ({ pid: p.pid, ppid: p.ppid, comm: p.comm, startTicks: p.startTicks as number }));
      targets.push({
        workspaceId: ws,
        kind: live ? 'duplicate' : 'orphan-untracked',
        trackedPid: tracked,
        keeperPid: v.pid,
        pids: members.map((m) => m.pid).reverse(),
        members,
      });
    }
  }
  return { targets, refused, refusedStoreNotLoaded: false };
}

/**
 * Boot fallback (review K5): where the /proc reaper cannot act (no start-time identity ⇒ non-Linux `ps`
 * sampler), keep the old boot behaviour — `killKeeper` each absent-from-store keeper (it talks to the socket
 * owner, no pid guess) — but ONLY once the store loaded from disk. Linux ⇒ [] (the guarded reaper owns it).
 */
export function bootFallbackKills(
  platform: string,
  keeperWsIds: string[],
  liveWorkspaceIds: Set<string>,
  storeLoadedFromDisk: boolean,
): string[] {
  if (platform === 'linux' || !storeLoadedFromDisk) return [];
  return keeperWsIds.filter((id) => !liveWorkspaceIds.has(id));
}

/** Is the process whose `/proc/<pid>/stat` text is `statText` (null = unreadable/gone) still the SAME live process
 *  — same start-time (pid not recycled) and not a zombie? Pure, so the identity clauses are unit-pinned (review D3). */
export function isSameLiveProcess(expectedStartTicks: number, statText: string | null): boolean {
  if (statText === null) return false;
  const p = parseProcStatLine(statText);
  if (!p || p.startTicks !== expectedStartTicks) return false;
  return !/\) Z /.test(statText);
}

/** A genuine keeper's argv is `<runtime> …/keeper.js <wsId> <sock> <pid> <log>`
 *  (keeper-client.ts launchKeeperDaemon) — a clock-free anchor for the root. */
export function isKeeperCmdline(argv: string[] | null, wsId: string): boolean {
  if (!argv) return false;
  for (let i = 0; i + 1 < argv.length; i++) {
    if (argv[i].split(/[\\/]/).pop() === 'keeper.js' && argv[i + 1] === wsId) return true;
  }
  return false;
}

export type Identity = 'same' | 'gone' | 'reused';

/** Same process iff the pid still exists with the start-time it had when classified. */
export function identityOf(m: ReapMember, fresh: ProcSample | null | undefined): Identity {
  if (!fresh) return 'gone';
  return fresh.startTicks === m.startTicks ? 'same' : 'reused';
}

export interface IdentityCheck {
  /** Members provably still the classified tree, leaf-first (keeper last). */
  signalable: ReapMember[];
  /** Individual members withheld (tree otherwise intact), with reason. */
  withheld: Array<{ pid: number; reason: string }>;
  /** Non-null → the WHOLE tree is refused (its legitimacy hangs on the keeper root). */
  treeRefusal: string | null;
}

/**
 * Kill-time identity check against FRESH /proc reads. Root: same start-time AND
 * keeper argv for this workspace. Each child: same start-time, same ppid as
 * classified, parent itself still signalable (chain to the keeper intact).
 */
export function verifyReapIdentity(
  target: ReapTarget,
  fresh: Map<number, ProcSample | null>,
  keeperArgv: string[] | null,
): IdentityCheck {
  const refuse = (treeRefusal: string): IdentityCheck => ({ signalable: [], withheld: [], treeRefusal });
  const root = target.members.find((m) => m.pid === target.keeperPid);
  if (!root) return refuse('keeper-not-in-classified-tree');
  const rootId = identityOf(root, fresh.get(root.pid));
  if (rootId === 'gone') return refuse('keeper-gone');
  if (rootId === 'reused') return refuse('keeper-start-time-changed (pid reused)');
  if (!isKeeperCmdline(keeperArgv, target.workspaceId)) {
    return refuse("keeper-cmdline-mismatch (pid is not this workspace's keeper)");
  }
  const ok = new Set<number>([root.pid]);
  const signalable: ReapMember[] = [root];
  const withheld: Array<{ pid: number; reason: string }> = [];
  for (const m of target.members) {
    if (m.pid === root.pid) continue;
    const f = fresh.get(m.pid);
    const id = identityOf(m, f);
    let reason: string | null = null;
    if (id === 'gone') reason = 'gone';
    else if (id === 'reused') reason = 'start-time-changed (pid reused)';
    else if (f?.ppid !== m.ppid) reason = 'reparented';
    else if (!ok.has(m.ppid)) reason = 'parent-withheld';
    if (reason) {
      withheld.push({ pid: m.pid, reason });
      continue;
    }
    ok.add(m.pid);
    signalable.push(m);
  }
  return { signalable: signalable.reverse(), withheld, treeRefusal: null };
}

/** After the SIGTERM grace: SIGKILL only members still the SAME process (pid + start-time). */
export function classifySurvivors(
  signalled: ReapMember[],
  fresh: Map<number, ProcSample | null>,
): { kill: ReapMember[]; gone: number[]; reused: number[] } {
  const out = { kill: [] as ReapMember[], gone: [] as number[], reused: [] as number[] };
  for (const m of signalled) {
    const id = identityOf(m, fresh.get(m.pid));
    if (id === 'same') out.kill.push(m);
    else if (id === 'gone') out.gone.push(m.pid);
    else out.reused.push(m.pid);
  }
  return out;
}

// ─── The threshold detector (detector b — advisory) ──────────────────────────

export interface ThresholdWarning {
  kind: 'session-rss' | 'session-cpu' | 'electron-rss' | 'electron-cpu';
  /** Workspace id for a session finding, Electron process type for an app one. */
  subject: string;
  pid: number;
  /** Measured value (bytes for rss, percent for cpu). */
  value: number;
  threshold: number;
}

/** Advisory over-threshold findings; never kills. A reaped tree is skipped (its RSS is stale). */
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
