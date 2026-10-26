// Browser tab memory, attributed to the owning workspace (#394, spec #388 story 16). Pure and
// dependency-free (the renderer bundles it): the producer in main/browser-tab-memory.ts feeds it
// each tab's OS renderer pid and the sampler's process table.

/** One tab of one workspace and the OS pid of its renderer (`webContents.getOSProcessId()`). */
export interface BrowserTabProc {
  wsId: string;
  tabId: string;
  /** null / ≤ 0 = the tab has no live webContents (or the pid is not known). */
  pid: number | null;
}

/** One workspace's browser footprint. */
export interface BrowserWorkspaceMemory {
  wsId: string;
  tabs: number;
  /** Σ of the tabs' shares; null = NO tab of the workspace could be measured (never a fake 0). */
  bytes: number | null;
  /** Tabs with no figure: no live pid, pid not in the table, or the pid also hosts a non-tab page. */
  unmeasured: number;
  /** Tabs whose renderer process is shared with a tab of ANOTHER workspace — its memory is split, so `bytes` is an estimate. */
  shared: number;
}

/** What the page, the monitor line and `bus-status` read. JSON-safe. */
export interface BrowserTabMemoryView {
  byWorkspace: BrowserWorkspaceMemory[];
  /** Renderer pids whose memory is folded into a workspace above — the app's own process list must not count them again. */
  attributedPids: number[];
}

export const EMPTY_BROWSER_TAB_MEMORY: BrowserTabMemoryView = { byWorkspace: [], attributedPids: [] };

/**
 * Attribute renderer memory to workspaces.
 *
 * - A tab is MEASURED when its pid is positive, in `memByPid` and not in `excludePids` (a pid that also hosts a non-tab page —
 *   Orchestra's own UI, a login window — is not the tab's to bill: its whole figure would land on a workspace). Otherwise it counts
 *   as `unmeasured`, never as 0 bytes.
 * - A pid used by k tabs is split between THOSE tabs (remainder bytes to the first, ordered by wsId then tabId), so the shares sum to
 *   the process exactly: never counted twice, whether the tabs belong to one workspace or several.
 * - A workspace's figure is the sum of its tabs' shares; null when none of its tabs was measured.
 * - Cross-workspace sharing cannot be resolved from a process figure — `shared` marks it so the figure reads as an estimate.
 */
export function attributeBrowserTabMemory(
  tabs: readonly BrowserTabProc[],
  memByPid: ReadonlyMap<number, number>,
  excludePids: ReadonlySet<number> = new Set(),
): BrowserTabMemoryView {
  const ordered = [...tabs].sort((a, b) => (a.wsId < b.wsId ? -1 : a.wsId > b.wsId ? 1 : a.tabId < b.tabId ? -1 : a.tabId > b.tabId ? 1 : 0));
  const measuredOf = (t: BrowserTabProc): number | null => {
    if (t.pid === null || !Number.isInteger(t.pid) || t.pid <= 0 || excludePids.has(t.pid)) return null;
    const m = memByPid.get(t.pid);
    return m !== undefined && Number.isFinite(m) && m >= 0 ? m : null;
  };
  const users = new Map<number, BrowserTabProc[]>();
  for (const t of ordered) {
    if (measuredOf(t) === null) continue;
    const list = users.get(t.pid as number);
    if (list) list.push(t);
    else users.set(t.pid as number, [t]);
  }
  const rows = new Map<string, BrowserWorkspaceMemory>();
  const rowOf = (wsId: string): BrowserWorkspaceMemory => {
    let r = rows.get(wsId);
    if (!r) rows.set(wsId, (r = { wsId, tabs: 0, bytes: null, unmeasured: 0, shared: 0 }));
    return r;
  };
  for (const t of ordered) {
    const r = rowOf(t.wsId);
    r.tabs += 1;
    if (measuredOf(t) === null) r.unmeasured += 1;
  }
  for (const [pid, list] of users) {
    const total = Math.round(memByPid.get(pid) as number);
    const base = Math.floor(total / list.length);
    const extra = total - base * list.length;
    const crossWs = new Set(list.map((t) => t.wsId)).size > 1;
    list.forEach((t, i) => {
      const r = rowOf(t.wsId);
      r.bytes = (r.bytes ?? 0) + base + (i < extra ? 1 : 0);
      if (crossWs) r.shared += 1;
    });
  }
  return { byWorkspace: [...rows.values()], attributedPids: [...users.keys()].sort((a, b) => a - b) };
}

/** The bytes to fold into `wsId`'s memory figure (0 when it has none measured — the row's `browser` block still says « not measured »). */
export function browserBytesFor(view: BrowserTabMemoryView | null | undefined, wsId: string): number {
  return view?.byWorkspace.find((w) => w.wsId === wsId)?.bytes ?? 0;
}

/** The workspace's browser block for its Resources row; null = no tab. */
export function browserOf(view: BrowserTabMemoryView | null | undefined, wsId: string): BrowserWorkspaceMemory | null {
  const w = view?.byWorkspace.find((x) => x.wsId === wsId);
  return w && w.tabs > 0 ? w : null;
}

/** Σ of the app's process memory EXCLUDING the renderers already billed to a workspace (the « App memory » tile + the « Agent memory » tile must not count one process twice). */
export function appMemoryExcludingTabs(app: ReadonlyArray<{ pid: number; memBytes: number }>, view: BrowserTabMemoryView | null | undefined): number {
  const billed = new Set(view?.attributedPids ?? []);
  return app.reduce((n, p) => (billed.has(p.pid) ? n : n + p.memBytes), 0);
}

const MB = 1024 * 1024;
function mb(b: number): string {
  return b >= 1024 * MB ? `${(b / (1024 * MB)).toFixed(1)} GB` : `${Math.round(b / MB)} MB`;
}

/** Chip text + tooltip for a row (`SessionChips`). */
export function browserChipText(b: BrowserWorkspaceMemory): string {
  return `${b.tabs} tab${b.tabs === 1 ? '' : 's'}${b.bytes !== null ? ` · ${mb(b.bytes)}` : ''}`;
}
export function browserChipTitle(b: BrowserWorkspaceMemory): string {
  const parts = [`${b.tabs} browser tab${b.tabs === 1 ? '' : 's'}`, b.bytes !== null ? `${mb(b.bytes)} of renderer memory, counted in this row's memory` : 'renderer memory not measured'];
  if (b.unmeasured > 0 && b.bytes !== null) parts.push(`${b.unmeasured} not measured`);
  if (b.shared > 0) parts.push(`${b.shared} share a renderer process with another workspace's tab — estimate`);
  return parts.join(' · ');
}

/** The `bus-status` `browser tabs:` line. `label` names a workspace (the CLI only has the host's labels). */
export function formatBrowserTabsLine(view: BrowserTabMemoryView | null | undefined, label: (wsId: string) => string = (id) => id): string {
  const rows = (view?.byWorkspace ?? []).filter((w) => w.tabs > 0);
  if (rows.length === 0) return 'browser tabs: none open';
  const total = rows.reduce((n, w) => n + w.tabs, 0);
  const measured = rows.reduce((n, w) => n + (w.bytes ?? 0), 0);
  const heaviest = [...rows].sort((a, b) => (b.bytes ?? -1) - (a.bytes ?? -1) || (a.wsId < b.wsId ? -1 : 1));
  const per = heaviest.slice(0, 5).map((w) => `${label(w.wsId)} ×${w.tabs} · ${w.bytes !== null ? mb(w.bytes) : 'not measured'}${w.unmeasured > 0 && w.bytes !== null ? ` (+${w.unmeasured} not measured)` : ''}${w.shared > 0 ? ' ~' : ''}`);
  const more = heaviest.length > 5 ? `, +${heaviest.length - 5} more` : '';
  return `browser tabs: ${total} in ${rows.length} workspace${rows.length === 1 ? '' : 's'} (${per.join(', ')}${more}) · ${mb(measured)} total, counted in each workspace's memory${rows.some((w) => w.shared > 0) ? ' · ~ = renderer shared across workspaces, split' : ''}`;
}
