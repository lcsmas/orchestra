// Container memory accounting — the PURE half (#293, wave G ledger #295, epic #284; contract = ledger FI-3; ADR 0004).
// Impure half (Docker calls, the per-tick refresh, the synchronous read): src/main/container-accounting.ts.
//
// ATTRIBUTED = a RUNNING container carrying the `orchestra.ws=<id>` label the keeper's Docker relay stamps (FI-1.1) for a workspace that EXISTS: its memory is added to that
// workspace's measured memory. UNATTRIBUTED = a RUNNING container that is nobody's: WITHOUT the label and created at/after the start of the earliest LIVE fleet run, or labelled
// for a workspace that no longer exists (an ORPHAN — deleting a workspace does not stop its containers). Counted and listed, NEVER touched (the human's older stacks never count).
// The label on the container is the only ownership truth.

import { DOCKER_LABEL_RUN, attributedWorkspaceId } from './docker-labels.ts';

/** The fields of a daemon container-list row this module reads (a structural subset of `DockerContainerSummary`). */
export interface ContainerRow {
  id: string;
  name: string;
  /** Unix seconds (the daemon's `Created`). */
  created: number;
  labels: Record<string, string>;
}

export interface AttributedContainer {
  id: string;
  name: string;
  wsId: string;
}
export interface UnattributedContainer {
  id: string;
  name: string;
  created: number;
  /** Set for an ORPHAN: the (deleted) workspace its label names. */
  orphanOf?: string;
}

/**
 * Split the daemon's RUNNING containers. `earliestLiveRunStartMs` = the start of the earliest live fleet run (null = no live run → nothing can have been created "during a run").
 * Compared in whole seconds (the daemon's `Created` has no sub-second part), `>=`. `workspaceKnown` (absent = every id is known): a label naming a workspace the store no longer
 * has makes the container an ORPHAN — unattributed whatever its age — PROVIDED it is provably THIS app's: with `runKnown` given, its `orchestra.run` stamp must name a run this app's bus
 * has. A container stamped by ANOTHER Orchestra instance sharing the daemon (a dev build beside the live app) names a workspace AND a run this app has never heard of: it is not ours,
 * so it is neither attributed nor reported (a false alarm in the LEAD's escalation is worse than a missed foreign container).
 */
export function classifyContainers(
  running: readonly ContainerRow[],
  earliestLiveRunStartMs: number | null,
  workspaceKnown?: (workspaceId: string, runId: string) => boolean,
  runKnown?: (runId: string) => boolean,
): { attributed: AttributedContainer[]; unattributed: UnattributedContainer[] } {
  const attributed: AttributedContainer[] = [];
  const unattributed: UnattributedContainer[] = [];
  const since = earliestLiveRunStartMs === null ? null : Math.floor(earliestLiveRunStartMs / 1000);
  for (const c of running) {
    const ws = attributedWorkspaceId(c.labels);
    if (ws !== null) {
      const runLabel = c.labels?.[DOCKER_LABEL_RUN] ?? '';
      if (workspaceKnown && !workspaceKnown(ws, runLabel)) {
        if (!runKnown || runKnown(runLabel)) unattributed.push({ id: c.id, name: c.name, created: c.created, orphanOf: ws });
        // else: stamped by another Orchestra instance — not ours
      } else attributed.push({ id: c.id, name: c.name, wsId: ws });
    } else if (since !== null && c.created >= since) unattributed.push({ id: c.id, name: c.name, created: c.created });
  }
  return { attributed, unattributed };
}

/**
 * One container's memory in bytes from a daemon `stats` document, exactly as the docker CLI computes it (`calculateMemUsageUnixNoCache`): cgroup v1 `total_inactive_file` first,
 * then cgroup v2 `inactive_file`, each subtracted only when it is BELOW usage; otherwise usage as is. null = the document carries no usable usage (a container that just started,
 * or stopped, answers `memory_stats: {}`) — UNMEASURED, never 0.
 */
export function containerMemoryBytes(stats: unknown): number | null {
  const ms = (stats as { memory_stats?: { usage?: unknown; stats?: Record<string, unknown> } } | null | undefined)?.memory_stats;
  const usage = Number(ms?.usage);
  if (ms?.usage === undefined || ms?.usage === null || !Number.isFinite(usage) || usage < 0) return null;
  const v1 = Number(ms.stats?.total_inactive_file);
  if (ms.stats?.total_inactive_file !== undefined && Number.isFinite(v1) && v1 < usage) return usage - v1;
  const v2 = Number(ms.stats?.inactive_file);
  if (ms.stats?.inactive_file !== undefined && Number.isFinite(v2) && v2 < usage) return usage - v2;
  return usage;
}

/** What the last refresh learned. `byWorkspace` etc. are FI-3.2's frozen shape; the rest is additive. */
export interface ContainerAccounting {
  /** Attributed container memory per workspace id, bytes (measured containers only). */
  byWorkspace: Map<string, number>;
  unattributed: { count: number; ids: string[]; /** additive — an orphan reads `<name> (orphan of <ws>)` */ names: string[] };
  /** Epoch ms of the last refresh; null = never refreshed. */
  sampledAt: number | null;
  /** additive — attributed containers per workspace (measured or not). */
  countByWorkspace: Map<string, number>;
  /** additive — attributed containers per workspace whose stats came back empty/failed: their bytes are NOT in `byWorkspace`. */
  unmeasuredByWorkspace: Map<string, number>;
  /** additive — total of `unmeasuredByWorkspace`. */
  unmeasured: number;
  /** additive — 'ok' = a daemon answered; 'unavailable' = none did (NOTHING measured, not "zero containers"); 'error' = the refresh itself failed (nothing trusted); 'not-sampled' = never refreshed;
   *  'stale' = the last good pass is too old to read as current (derived at read time, `getContainerAccounting`). */
  docker: 'ok' | 'unavailable' | 'error' | 'not-sampled' | 'stale';
  /** additive — daemons that did NOT answer this pass while another did: their containers are missing from every figure (0 = complete). */
  daemonsDown: number;
}

export function emptyAccounting(docker: ContainerAccounting['docker'] = 'not-sampled', sampledAt: number | null = null): ContainerAccounting {
  return { byWorkspace: new Map(), unattributed: { count: 0, ids: [], names: [] }, sampledAt, countByWorkspace: new Map(), unmeasuredByWorkspace: new Map(), unmeasured: 0, docker, daemonsDown: 0 };
}

/** Fold one refresh: the measured attributed containers (bytes null = unmeasured) + the unattributed ones. */
export function buildAccounting(
  attributed: ReadonlyArray<{ wsId: string; bytes: number | null }>,
  unattributed: readonly UnattributedContainer[],
  sampledAt: number,
  daemonsDown = 0,
): ContainerAccounting {
  const out = emptyAccounting('ok', sampledAt);
  out.daemonsDown = daemonsDown;
  for (const a of attributed) {
    out.countByWorkspace.set(a.wsId, (out.countByWorkspace.get(a.wsId) ?? 0) + 1);
    if (a.bytes === null) {
      out.unmeasured += 1;
      out.unmeasuredByWorkspace.set(a.wsId, (out.unmeasuredByWorkspace.get(a.wsId) ?? 0) + 1);
    } else out.byWorkspace.set(a.wsId, (out.byWorkspace.get(a.wsId) ?? 0) + a.bytes);
  }
  out.unattributed = {
    count: unattributed.length,
    ids: unattributed.map((u) => u.id),
    names: unattributed.map((u) => `${u.name || u.id.slice(0, 12)}${u.orphanOf ? ` (orphan of ${u.orphanOf})` : ''}`),
  };
  return out;
}

// ─── JSON view (IPC snapshot / /busStatus / resources.jsonl — Maps do not serialise) ───────────────────────────────────────────

export interface ContainerAccountingView {
  docker: ContainerAccounting['docker'];
  sampledAt: number | null;
  /** Per workspace with at least one attributed container (sorted by bytes, heaviest first). `unmeasured` of `count` containers have NO figure in `bytes`. */
  attributed: Array<{ wsId: string; count: number; bytes: number; unmeasured: number }>;
  unattributed: { count: number; ids: string[]; names: string[] };
  unmeasured: number;
  /** daemons that did not answer this pass (their containers are missing from every figure). */
  daemonsDown: number;
}

export function accountingView(acc: ContainerAccounting): ContainerAccountingView {
  const ids = new Set([...acc.countByWorkspace.keys(), ...acc.byWorkspace.keys()]);
  const attributed = [...ids]
    .map((wsId) => ({ wsId, count: acc.countByWorkspace.get(wsId) ?? 0, bytes: acc.byWorkspace.get(wsId) ?? 0, unmeasured: acc.unmeasuredByWorkspace.get(wsId) ?? 0 }))
    .sort((a, b) => b.bytes - a.bytes || a.wsId.localeCompare(b.wsId));
  return { docker: acc.docker, sampledAt: acc.sampledAt, attributed, unattributed: { ...acc.unattributed }, unmeasured: acc.unmeasured, daemonsDown: acc.daemonsDown };
}

/** wsId → measured bytes over a view (the Resources page folds it into the owning row). 0 for a workspace without containers (or nothing measured). */
export function viewBytesFor(view: Pick<ContainerAccountingView, 'attributed' | 'docker'> | null | undefined, wsId: string | null): number {
  if (!view || !wsId || view.docker !== 'ok') return 0; // a view that was not measured is never read for figures
  return view.attributed.find((a) => a.wsId === wsId)?.bytes ?? 0;
}

/**
 * The `containerBytes` of a session line: undefined = NOT measured (Docker down/failed, or every one of the workspace's containers is unmeasured — "unmeasured, never 0");
 * 0 = Docker answered and the workspace has no container; otherwise the measured bytes.
 */
export function measuredContainerBytes(view: ContainerAccountingView | null | undefined, wsId: string): number | undefined {
  if (!view || view.docker !== 'ok') return undefined;
  const a = view.attributed.find((x) => x.wsId === wsId);
  if (!a) return 0;
  return a.unmeasured >= a.count ? undefined : a.bytes;
}

function fmtBytes(n: number): string {
  if (n >= 1024 ** 3) return `${(n / 1024 ** 3).toFixed(1)} GB`;
  return `${Math.round(n / 1024 ** 2)} MB`;
}

/** The `containers:` line of `orchestra bus-status` (host-wide, like `memory:`). Always one line when the app returned a view. */
export function formatContainersLine(view: ContainerAccountingView, labelOf: (wsId: string) => string): string {
  if (view.docker === 'not-sampled') return 'containers: not sampled yet';
  if (view.docker === 'unavailable') return 'containers: Docker unavailable — not measured';
  if (view.docker === 'error') return 'containers: accounting failed — not measured';
  if (view.docker === 'stale') return 'containers: last Docker pass is too old — not measured';
  const parts: string[] = [];
  if (view.attributed.length === 0) parts.push('0 attributed');
  else {
    const total = view.attributed.reduce((n, a) => n + a.count, 0);
    const one = (a: ContainerAccountingView['attributed'][number]): string =>
      a.unmeasured >= a.count ? `${labelOf(a.wsId)} ×${a.count} · not measured` : `${labelOf(a.wsId)} ×${a.count} · ${fmtBytes(a.bytes)}${a.unmeasured > 0 ? ` (+${a.unmeasured} not measured)` : ''}`;
    parts.push(`${total} attributed (${view.attributed.map(one).join(', ')})`);
  }
  const u = view.unattributed;
  parts.push(u.count === 0 ? '0 unattributed' : `${u.count} unattributed (${u.names.map((n, i) => n || u.ids[i]?.slice(0, 12) || '?').join(', ')}) — never touched`);
  if (view.daemonsDown > 0) parts.push(`${view.daemonsDown} Docker daemon(s) did not answer — figures incomplete`);
  return `containers: ${parts.join(' · ')}`;
}

/** The dim warning line under the Resources table (D-pick4 A): null when there is nothing to say (Docker down / not sampled says nothing here — `bus-status` carries those states). */
export function unattributedWarning(view: Pick<ContainerAccountingView, 'docker' | 'unattributed' | 'daemonsDown'> | null | undefined): string | null {
  if (!view || view.docker !== 'ok') return null;
  const u = view.unattributed;
  const names = u.names.map((n, i) => n || u.ids[i]?.slice(0, 12) || '?').join(', ');
  const parts: string[] = [];
  if (u.count > 0) parts.push(`${u.count} unattributed container${u.count === 1 ? '' : 's'} (${names}) — not attributed to any workspace · never touched`);
  if (view.daemonsDown > 0) parts.push(`${view.daemonsDown} Docker daemon(s) did not answer — container figures incomplete`);
  return parts.length === 0 ? null : `⚠ ${parts.join(' · ⚠ ')}`;
}

/** The tooltip of a row's 🐳 chip: « 2 containers · 700 MB » (+ how many could not be measured). */
export function containersChipTitle(c: { count: number; bytes: number; unmeasured: number }): string {
  const n = `${c.count} container${c.count === 1 ? '' : 's'}`;
  if (c.unmeasured >= c.count) return `${n} · not measured`;
  return `${n} · ${fmtBytes(c.bytes)}${c.unmeasured > 0 ? ` (+${c.unmeasured} not measured)` : ''}`;
}
