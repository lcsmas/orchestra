import { viewBytesFor, type ContainerAccountingView } from './container-accounting.ts';
import { rowProcessBytes, viewFor, type MemberCapView, type MemberMemoryReport } from './member-memory.ts';
import type { VolumeStat } from './disk-space.ts';
import type { BrowserReliquatView } from './browser-chip.ts';

// Pure logic for the Resources page: parsing the OS process table, walking
// process trees, and turning raw jiffy counters into per-session CPU/memory
// figures. Lives in shared/ (dependency-free) so it's unit-testable with the
// plain node test runner — the platform I/O (reading /proc, spawning `ps`,
// Electron app metrics) stays in src/main/resources.ts.

/** One process as sampled from the OS table (/proc on Linux, `ps` elsewhere). */
export interface ProcSample {
  pid: number;
  ppid: number;
  /** Executable name (the kernel's comm, max 15 chars on Linux). */
  comm: string;
  /** Cumulative CPU time in clock ticks (utime+stime). 0 when the platform
   *  sampler reports an instantaneous percentage instead (see `cpuPct`). */
  cpuTicks: number;
  /** Resident set size in bytes. */
  memBytes: number;
  /** Instantaneous CPU percentage when the sampler provides one directly
   *  (`ps -o pcpu` on macOS); null on Linux where the percentage is derived
   *  from cpuTicks deltas between two samples. */
  cpuPct: number | null;
  /** /proc stat field 22 (start time, clock ticks since boot). With `pid` it is
   *  the process's identity — a recycled pid gets a different value. Absent on
   *  the `ps` fallback, where identity is unverifiable (#198 T8 reaper fails closed). */
  startTicks?: number;
}

/** One process inside a session's tree, ready for display. */
export interface ProcStat {
  pid: number;
  comm: string;
  /** Percent of one core (can exceed 100 for multi-threaded processes). */
  cpuPct: number;
  memBytes: number;
}

/** What kind of PTY a session id denotes. Mirrors the id scheme in
 *  src/main/pty.ts: `<wsId>` = agent, `<wsId>:run`, `<wsId>:nvim`,
 *  `account-login:<accountId>`. */
export type SessionKind = 'agent' | 'run' | 'nvim' | 'login' | 'sdk';

/** Live resource figures for one PTY session's whole process tree. */
export interface SessionResourceStat {
  ptyId: string;
  /** Workspace id for agent PTYs; derived from the id for run/nvim PTYs;
   *  null for account-login PTYs. */
  workspaceId: string | null;
  kind: SessionKind;
  /** True for sandbox-hosted sessions — their processes run in the container,
   *  so there are no local figures to show. */
  remote: boolean;
  /** Sum over the session's local process tree. Percent of one core. */
  cpuPct: number;
  memBytes: number;
  procCount: number;
  /** The tree's processes, heaviest (by memory) first, capped by the caller. */
  processes: ProcStat[];
}

/** One Electron process (main / renderer / GPU / utility), from
 *  `app.getAppMetrics()`. */
export interface AppProcessStat {
  /** Electron's process type ("Browser", "Tab", "GPU", "Utility", …). */
  type: string;
  pid: number;
  cpuPct: number;
  memBytes: number;
}

/** On-disk footprint of Orchestra's own data directories. Every value is
 *  bytes, or null when the directory doesn't exist / `du` failed. Worktree
 *  sizes are deliberately NOT here — the renderer already keeps them fresh
 *  via the existing `workspaces:sizes` poll. */
export interface DiskStats {
  scratchBytes: number | null;
  logsBytes: number | null;
  backupsBytes: number | null;
  eventsBytes: number | null;
  /** Epoch ms when the du pass ran — the sampler caches it (du is heavy). */
  measuredAt: number;
}

/** One full sample of everything Orchestra is consuming on this machine,
 *  assembled by src/main/resources.ts and pulled by the Resources page. */
export interface ResourceSnapshot {
  at: number;
  cpuCores: number;
  memTotalBytes: number;
  sessions: SessionResourceStat[];
  app: AppProcessStat[];
  disk: DiskStats | null;
  /** FREE space per filesystem (issue #87) — a different question from
   *  `disk`, which is Orchestra's own USED footprint via `du`. Deliberately
   *  NOT folded into DiskStats: these come from `statfs(2)`, cost one syscall,
   *  and so are sampled fresh every tick rather than served from the 60s `du`
   *  cache. Empty array when statfs is unavailable — never silently "fine". */
  volumes: VolumeStat[];
  /** #293: attributed container memory per workspace + the unattributed containers, from the LAST resource-monitor tick (the page never calls Docker).
   *  The page folds `attributed[ws].bytes` into the owning workspace's EXISTING memory figure. Absent from an older main. */
  containers?: ContainerAccountingView;
  /** #328: each member's memory read from its kernel scope + its live Reliquats (FI-1), from the shared short-cache read. A tracked member's row memory is the scope's meter (it sees a detached process
   *  the tree walk cannot); an untracked one keeps the tree figure. Absent from an older main. */
  members?: MemberMemoryReport;
  /** #323: the Plafond mémoire levels in the Garde mémoire settings NOW (GB) — the Resources bar marks the soft level and says when a member started under others. Absent from an older main. */
  capLevels?: { softGb: number; hardGb: number };
  /** #331: browser Reliquats (orphaned headless browsers) the resource monitor / a Pause dure stopped, per workspace, since the app started. Absent from an older main. */
  browserReliquats?: BrowserReliquatView;
}

/** Classify a PTY id into its session kind + owning workspace. Login PTYs
 *  (`account-login:<id>`) carry no workspace. */
export function classifyPtyId(
  id: string,
): { kind: SessionKind; workspaceId: string | null } {
  if (id.startsWith('account-login:')) return { kind: 'login', workspaceId: null };
  if (id.endsWith(':run')) return { kind: 'run', workspaceId: id.slice(0, -4) };
  if (id.endsWith(':nvim')) return { kind: 'nvim', workspaceId: id.slice(0, -5) };
  // #293 (D-pick4 option A): a keeper-HOSTED structured agent has no PTY; the page samples its keeper tree under the synthetic id `<wsId>:sdk`
  if (id.endsWith(':sdk')) return { kind: 'sdk', workspaceId: id.slice(0, -4) };
  return { kind: 'agent', workspaceId: id };
}

/** What every memory reader falls back to when the host page size cannot be read (WRONG on a 16 KB-page host — the
 *  reader warns once; #214 finding). NOT a parse default: `parseProcStatLine` requires the page size explicitly. */
export const FALLBACK_PAGE_SIZE_BYTES = 4096;

/** A page size we accept from the kernel: a power of two in [4 KiB, 64 KiB]. Anything else (a hugetlb-backed first VMA
 *  reports MBs) is refused rather than multiplied into every RSS figure. */
export function isPlausiblePageSize(bytes: number): boolean {
  return Number.isInteger(bytes) && bytes >= 4096 && bytes <= 65536 && (bytes & (bytes - 1)) === 0;
}

/** `KernelPageSize:   16 kB` (first VMA block of /proc/self/smaps) → bytes; null unless plausible. Fallback source only. */
export function parseKernelPageSize(smaps: string): number | null {
  const m = /^KernelPageSize:\s+(\d+)\s*kB/m.exec(smaps);
  if (!m) return null;
  const bytes = Number(m[1]) * 1024;
  return isPlausiblePageSize(bytes) ? bytes : null;
}

/** AT_PAGESZ (auxv type 6) from a raw /proc/self/auxv image — the kernel's own answer for THIS process. Entries are
 *  (type, value) pairs of `entryBytes` (8 on 64-bit, 4 on 32-bit); null when absent, truncated or implausible. */
export function parseAuxvPageSize(auxv: Uint8Array, entryBytes: 4 | 8, littleEndian: boolean): number | null {
  const dv = new DataView(auxv.buffer, auxv.byteOffset, auxv.byteLength);
  const read = (off: number): number =>
    entryBytes === 8 ? Number(littleEndian ? dv.getBigUint64(off, true) : dv.getBigUint64(off, false)) : dv.getUint32(off, littleEndian);
  for (let off = 0; off + 2 * entryBytes <= auxv.byteLength; off += 2 * entryBytes) {
    const type = read(off);
    if (type === 0) return null; // AT_NULL: end of vector
    if (type === 6) {
      const v = read(off + entryBytes);
      return isPlausiblePageSize(v) ? v : null;
    }
  }
  return null;
}

/** Identity-only view of a stat line (pid, ppid, comm, start-time, cpu ticks): `memBytes` is 0, deliberately — callers that
 *  need memory must call `parseProcStatLine` with the host page size (RSS is in PAGES; #214 finding). */
export function parseProcIdentity(text: string): ProcSample | null {
  return parseProcStatLine(text, 0);
}

/** Parse one /proc/<pid>/stat file. The comm field is wrapped in parentheses
 *  and may itself contain spaces or parentheses (`(tmux: server)`), so split
 *  on the LAST ')' rather than whitespace-splitting the whole line. Returns
 *  null for anything malformed (process died mid-read, kernel threads, …). */
export function parseProcStatLine(text: string, pageSizeBytes: number): ProcSample | null {
  const open = text.indexOf('(');
  const close = text.lastIndexOf(')');
  if (open < 0 || close < 0 || close < open) return null;
  const pid = Number(text.slice(0, open).trim());
  const comm = text.slice(open + 1, close);
  // Fields after the comm, whitespace-split. rest[i] is stat field i+3:
  // rest[0]=state, rest[1]=ppid, rest[11]=utime, rest[12]=stime, rest[19]=starttime,
  // rest[21]=rss.
  const rest = text.slice(close + 1).trim().split(/\s+/);
  const ppid = Number(rest[1]);
  const utime = Number(rest[11]);
  const stime = Number(rest[12]);
  const startTicks = Number(rest[19]);
  const rssPages = Number(rest[21]);
  if (!Number.isFinite(pid) || !Number.isFinite(ppid)) return null;
  if (!Number.isFinite(utime) || !Number.isFinite(stime)) return null;
  return {
    pid,
    ppid,
    comm,
    cpuTicks: utime + stime,
    memBytes: (Number.isFinite(rssPages) ? rssPages : 0) * pageSizeBytes,
    cpuPct: null,
    ...(Number.isFinite(startTicks) ? { startTicks } : {}),
  };
}

/** Parse `ps -axo pid=,ppid=,rss=,pcpu=,comm=` output (the non-Linux
 *  fallback). rss is KiB; pcpu is ps's own recent-average percentage, used
 *  as-is instead of tick deltas. comm may contain spaces — it's everything
 *  after the fourth column. */
export function parsePsOutput(out: string): ProcSample[] {
  const samples: ProcSample[] = [];
  for (const line of out.split('\n')) {
    const m = line.match(/^\s*(\d+)\s+(\d+)\s+(\d+)\s+([\d.]+)\s+(.+?)\s*$/);
    if (!m) continue;
    samples.push({
      pid: Number(m[1]),
      ppid: Number(m[2]),
      comm: m[5],
      cpuTicks: 0,
      memBytes: Number(m[3]) * 1024,
      cpuPct: Number(m[4]),
    });
  }
  return samples;
}

/** Collect a root process and all its descendants from a full process table.
 *  BFS over a ppid→children index; returns [] when the root isn't in the
 *  table (process exited between listing the PTYs and sampling /proc). */
export function collectTree(rootPid: number, table: ProcSample[]): ProcSample[] {
  const byPid = new Map<number, ProcSample>();
  const children = new Map<number, ProcSample[]>();
  for (const p of table) {
    byPid.set(p.pid, p);
    const list = children.get(p.ppid);
    if (list) list.push(p);
    else children.set(p.ppid, [p]);
  }
  const root = byPid.get(rootPid);
  if (!root) return [];
  const out: ProcSample[] = [];
  const queue = [root];
  const seen = new Set<number>();
  while (queue.length) {
    const p = queue.shift()!;
    if (seen.has(p.pid)) continue; // defensive: a cyclic ppid must not loop
    seen.add(p.pid);
    out.push(p);
    for (const c of children.get(p.pid) ?? []) queue.push(c);
  }
  return out;
}

/** Derive each process's CPU percentage from the jiffy delta between two
 *  samples. `prevTicks` maps pid → cpuTicks at the previous sample; a pid
 *  with no previous reading (new process, or the very first sample) gets 0
 *  rather than a bogus lifetime figure. `hz` is the kernel clock (USER_HZ,
 *  100 on every mainstream Linux). Result is percent of ONE core. */
export function computeCpuPcts(
  table: ProcSample[],
  prevTicks: Map<number, number>,
  elapsedMs: number,
  hz = 100,
): Map<number, number> {
  const out = new Map<number, number>();
  for (const p of table) {
    if (p.cpuPct !== null) {
      out.set(p.pid, p.cpuPct); // sampler already measured it (ps fallback)
      continue;
    }
    const prev = prevTicks.get(p.pid);
    if (prev === undefined || elapsedMs <= 0) {
      out.set(p.pid, 0);
      continue;
    }
    // A restarted pid can wear a smaller counter than its predecessor —
    // clamp instead of reporting a negative percentage.
    const deltaTicks = Math.max(0, p.cpuTicks - prev);
    out.set(p.pid, ((deltaTicks / hz) * 1000 / elapsedMs) * 100);
  }
  return out;
}

/** Roll one session's process tree up into its display stat. `maxProcesses`
 *  caps the per-process breakdown (heaviest by memory first) so the IPC
 *  payload stays small for sessions with big trees. */
export function aggregateSession(
  root: { ptyId: string; remote: boolean; pid: number | undefined },
  table: ProcSample[],
  cpuPcts: Map<number, number>,
  maxProcesses = 8,
): SessionResourceStat {
  const { kind, workspaceId } = classifyPtyId(root.ptyId);
  const tree = root.remote || root.pid === undefined ? [] : collectTree(root.pid, table);
  let cpuPct = 0;
  let memBytes = 0;
  const processes: ProcStat[] = [];
  for (const p of tree) {
    const pct = cpuPcts.get(p.pid) ?? 0;
    cpuPct += pct;
    memBytes += p.memBytes;
    processes.push({ pid: p.pid, comm: p.comm, cpuPct: pct, memBytes: p.memBytes });
  }
  processes.sort((a, b) => b.memBytes - a.memBytes);
  return {
    ptyId: root.ptyId,
    workspaceId,
    kind,
    remote: root.remote,
    cpuPct,
    memBytes,
    procCount: tree.length,
    processes: processes.slice(0, maxProcesses),
  };
}

/**
 * Keeper-HOSTED structured agents (D-pick4 A, #293): their CLI lives in a detached keeper, not under a PTY, so the PTY listing never saw them. One synthetic `<wsId>:sdk` session per
 * LIVE keeper root, aggregated exactly like a PTY session over the page's own process table. The keeper is detached, so its tree is normally DISJOINT from every PTY tree — a workspace with BOTH a
 * terminal agent and a structured session shows both (the keeper's CLI + MCP memory is real). Only a keeper that actually sits INSIDE a PTY root's tree (`ptyRootPids`) is skipped: that PTY
 * row already counts it. A keeper whose tree is empty (its pid left the table between the listing and the scan) yields no row.
 */
export function aggregateKeeperSessions(
  roots: ReadonlyArray<{ workspaceId: string; keeperPid: number }>,
  ptyRootPids: readonly number[],
  table: ProcSample[],
  cpuPcts: Map<number, number>,
): SessionResourceStat[] {
  const claimed = new Set<number>();
  for (const pid of ptyRootPids) for (const p of collectTree(pid, table)) claimed.add(p.pid);
  const out: SessionResourceStat[] = [];
  for (const r of roots) {
    if (claimed.has(r.keeperPid)) continue;
    const s = aggregateSession({ ptyId: `${r.workspaceId}:sdk`, remote: false, pid: r.keeperPid }, table, cpuPcts);
    if (s.procCount > 0) out.push(s);
  }
  return out;
}

/** One per-workspace row of the Resources page's Agents table (the rows before the renderer attaches the workspace record). */
export interface SessionGroup {
  /** Workspace id (or the pty id of a session with no workspace). */
  key: string;
  sessions: SessionResourceStat[];
  cpuPct: number;
  /** Process memory of the workspace's sessions PLUS its attributed containers' (#293) — ONE figure, no new element. */
  memBytes: number;
  procCount: number;
  remote: boolean;
  /** #293 (D-pick4 A): the workspace's attributed containers — drives the 🐳 chip on the row. null = none. `unmeasured` of `count` have no figure in `bytes`. */
  containers: { count: number; bytes: number; unmeasured: number } | null;
  /** #293 (D-pick4 A): a workspace whose only footprint is a container (no session of any kind) — a row with just the chip; cpu / procs read « — ». */
  containerOnly: boolean;
  /** #328: the member's live Reliquats (null = the member is not scope-tracked, or its scope could not be listed). `partial` = a lower bound (a generation unlisted). */
  reliquats: { count: number; bytes: number; partial: boolean; procs: Array<{ pid: number; comm: string; rssBytes: number }> } | null;
  /** #328: a member with NO session left but live Reliquats in its scope (its keeper is gone, they are not) — a row with just its scope's memory + Reliquat count, like the container-only row; cpu / procs read « — ». Never a row without a Reliquat (D-Q3). */
  scopeOnly: boolean;
  /** #323: usage against the cap this member's CURRENT session runs under (the limit the kernel holds on its keeper's scope); null = no cap applied / not scope-tracked / no live session. */
  cap: MemberCapView | null;
}

/**
 * Group the sampled sessions (PTY sessions AND keeper-hosted structured agents, `<wsId>:sdk`) into per-workspace rows + the login PTYs apart — what the page renders. `containers` (the last
 * monitor tick's accounting, #293) is folded into the OWNING row's memory figure and shown as its container chip; a workspace with attributed containers but no session at all gets a
 * container-only row (D-pick4 option A). `members` (#328) replaces a scope-tracked member's process memory with its scope's meter (`rowProcessBytes`) and attaches its Reliquat count.
 */
export function groupSessionsByWorkspace(
  sessions: readonly SessionResourceStat[],
  containers?: ContainerAccountingView | null,
  members?: MemberMemoryReport | null,
): { rows: SessionGroup[]; login: SessionResourceStat[] } {
  const byWs = new Map<string, SessionResourceStat[]>();
  const login: SessionResourceStat[] = [];
  for (const s of sessions) {
    if (s.kind === 'login') {
      login.push(s);
      continue;
    }
    const k = s.workspaceId ?? s.ptyId;
    const list = byWs.get(k);
    if (list) list.push(s);
    else byWs.set(k, [s]);
  }
  const chipOf = (key: string): SessionGroup['containers'] => {
    const a = containers?.docker === 'ok' ? containers.attributed.find((x) => x.wsId === key) : undefined;
    return a && a.count > 0 ? { count: a.count, bytes: a.bytes, unmeasured: a.unmeasured } : null;
  };
  const rows = Array.from(byWs, ([key, list]): SessionGroup => {
    const remote = list.every((s) => s.remote);
    const view = remote ? undefined : viewFor(members, key); // a sandbox member's processes run in the container: never a local scope
    return {
      key,
      sessions: list,
      cpuPct: list.reduce((n, s) => n + s.cpuPct, 0),
      memBytes: (view ? rowProcessBytes(list, view) : list.reduce((n, s) => n + s.memBytes, 0)) + (remote ? 0 : viewBytesFor(containers, key)),
      procCount: list.reduce((n, s) => n + s.procCount, 0),
      remote,
      containers: remote ? null : chipOf(key),
      containerOnly: false,
      reliquats: view && view.reliquats !== null ? { count: view.reliquats, bytes: view.reliquatBytes ?? 0, partial: view.unlisted > 0, procs: view.reliquatProcs } : null,
      scopeOnly: false,
      cap: view?.cap ?? null,
    };
  });
  // #328: a member whose session is gone but whose scope still holds processes (the Reliquats) has no session row — give it one; its containers (if any) fold into the SAME row
  const scopeOnly = new Map<string, SessionGroup>();
  for (const m of members?.tracked ?? []) {
    if (byWs.has(m.wsId) || (m.reliquats ?? 0) <= 0) continue; // D-Q3: the row is kept for a member that has only RELIQUATS left — a scope without one (the keeper's boot window, before its pid file) is not a row
    scopeOnly.set(m.wsId, { key: m.wsId, sessions: [], cpuPct: 0, memBytes: (m.bytes ?? 0) + viewBytesFor(containers, m.wsId), procCount: 0, remote: false, containers: chipOf(m.wsId), containerOnly: false, reliquats: m.reliquats !== null ? { count: m.reliquats, bytes: m.reliquatBytes ?? 0, partial: m.unlisted > 0, procs: m.reliquatProcs } : null, scopeOnly: true, cap: null });
  }
  rows.push(...scopeOnly.values());
  for (const a of containers?.docker === 'ok' ? containers.attributed : []) {
    if (a.count > 0 && !byWs.has(a.wsId) && !scopeOnly.has(a.wsId)) rows.push({ key: a.wsId, sessions: [], cpuPct: 0, memBytes: a.bytes, procCount: 0, remote: false, containers: { count: a.count, bytes: a.bytes, unmeasured: a.unmeasured }, containerOnly: true, reliquats: null, scopeOnly: false, cap: null });
  }
  rows.sort((a, b) => b.cpuPct - a.cpuPct || b.memBytes - a.memBytes);
  return { rows, login };
}

/**
 * The page's ONE grouping call over a sampled snapshot: its sessions, the container accounting (#293) and the member scope report (#328). `ResourcesView` and the screenshot gate both go through it, so a call-site that
 * forgets a source is visible to a rendered capture and not only to a source pin.
 */
export function groupSnapshot(snap: Pick<ResourceSnapshot, 'sessions' | 'containers' | 'members'> | null | undefined): { rows: SessionGroup[]; login: SessionResourceStat[] } {
  return groupSessionsByWorkspace(snap?.sessions ?? [], snap?.containers, snap?.members);
}
