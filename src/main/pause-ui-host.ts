// Fleet PAUSE — the UI's host wiring (#257): binds src/main/pause-ui.ts (pure over a bus handle) to the real store, the boot bus connection, ipcMain and the
// renderer push. Kept apart so pause-ui.ts (and its tests) never import Electron-coupled modules.
//
// THE ENUMERATION (like BUS_PANE_IPC_CHANNELS, bus-pane.ts): the Pause WRITES are NOT pane channels — the pane's registrar refuses `writes: true`, so a write cannot be
// smuggled in as a read. They live here, on their own `pause:*` channels, each marked `writes: true`; the one READ is `pause:overview`.

import fs from 'node:fs';
import path from 'node:path';
import { ipcMain } from 'electron';
import { store } from './store';
import { platform } from './platform';
import { log } from './logger';
import { busPath, getBus } from './bus';
import { readPauseOverview, uiPause, uiRelease, uiResume, type PauseUiDeps } from './pause-ui';
import type { PauseMode } from '../shared/pause-lifecycle';
import type { PauseUiOverview, PauseUiReleaseResult, PauseUiWriteResult } from '../shared/pause-ui';

export const PAUSE_UI_IPC_CHANNELS: ReadonlyArray<{ channel: string; writes: boolean; what: string }> = [
  { channel: 'pause:overview', writes: false, what: 'read the pause overview: carriers + rosters + Bilan, per-orchestrator controls, per-workspace badges' },
  { channel: 'pause:pause', writes: true, what: 'setRunPause (douce | dure) as the workspace row the control belongs to' },
  { channel: 'pause:resume', writes: true, what: 'beginReprise (the structured Reprise) as the workspace row' },
  { channel: 'pause:release', writes: true, what: 'releaseMembers (<ws>… | all) as the workspace row' },
];
/** The push the renderer subscribes to (the whole overview, rebuilt from the bus; a snapshot, not a delta — it cannot drift). */
export const PAUSE_UI_PUSH_CHANNEL = 'pause:update';

export function realPauseUiDeps(): PauseUiDeps {
  return {
    getWorkspace: (id) => store.getWorkspace(id),
    listWorkspaces: () => store.workspaces.filter((w) => !w.archived),
    labelOf: (id) => {
      const w = store.getWorkspace(id);
      return w ? (w.branch || w.name || null) : null;
    },
  };
}

/** The live tree the overview depends on besides the bus: ids, links, kinds, names. A cheap change token (the push is skipped while neither it nor the bus fingerprint moved). */
function treeKey(deps: PauseUiDeps): string {
  return deps
    .listWorkspaces()
    .map((w) => `${w.id}|${w.parentId ?? ''}|${w.kind ?? ''}|${w.canOrchestrate ? 1 : 0}|${deps.labelOf(w.id) ?? ''}`)
    .sort()
    .join('\n');
}

/** What a bus write can change in the overview, read with 4 tiny aggregate queries — a message / ack / wake does not touch any of it, so the (heavier) overview is not rebuilt for it. */
function busKey(): string {
  const db = getBus();
  if (!db) return 'no-bus';
  try {
    const r = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(paused_at),0) AS p, COALESCE(SUM(resume_started_at),0) AS s, COALESCE(SUM(pause_escalated_at),0) AS e, COALESCE(SUM(pause_trap_at),0) AS t, COALESCE(SUM(held_at),0) AS h FROM runs').get() as Record<string, number>;
    const m = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(pause_confirmed_at),0) AS c, COALESCE(SUM(released_at),0) AS r, COALESCE(SUM(reprise_confirmed_at),0) AS a FROM pause_members').get() as Record<string, number>;
    const b = db.prepare('SELECT COUNT(*) AS n, COALESCE(MAX(id),0) AS m, COALESCE(SUM(killed_json IS NOT NULL),0) AS k FROM pause_records').get() as Record<string, number>;
    const f = db.prepare('SELECT COUNT(*) AS n, COALESCE(SUM(length(flags)),0) AS l FROM run_flags').get() as Record<string, number>;
    return JSON.stringify([r, m, b, f]);
  } catch (e) {
    return `err:${e instanceof Error ? e.message : String(e)}`;
  }
}

let lastKey = '\u0000never';
let lastJson = '';

/** Rebuild the overview and push it to every renderer IF it changed. `force` = after the user's own write (no fingerprint shortcut). */
export function broadcastPauseOverview(force = false): PauseUiOverview | null {
  const deps = realPauseUiDeps();
  const key = `${busKey()}#${treeKey(deps)}`;
  if (!force && key === lastKey) return null;
  lastKey = key;
  const overview = readPauseOverview(getBus(), deps);
  const json = JSON.stringify({ ...overview, at: 0 });
  if (!force && json === lastJson) return overview;
  lastJson = json;
  platform.broadcast(PAUSE_UI_PUSH_CHANNEL, overview);
  return overview;
}

export function invalidatePauseOverviewBroadcast(): void {
  lastKey = '\u0000never';
  lastJson = '';
}

/** Register the `pause:*` channels. Called ONCE at module scope from index.ts (a second registration THROWS on darwin). Every handler answers — never rejects the invoke: a down bus is `available:false` / `bus-unavailable`. */
export function registerPauseUiIpc(): void {
  ipcMain.handle('pause:overview', (): PauseUiOverview => readPauseOverview(getBus(), realPauseUiDeps()));
  ipcMain.handle('pause:pause', (_e, wsId: string, mode: PauseMode): PauseUiWriteResult => {
    const res = uiPause(getBus(), realPauseUiDeps(), { wsId: String(wsId ?? ''), mode: mode === 'soft' ? 'soft' : 'hard' });
    log.info(`pause-ui: pause ${mode === 'soft' ? 'douce' : 'dure'} on ${res.runId ?? '?'} as ${res.actor ?? '?'} → ${res.outcome}`);
    invalidatePauseOverviewBroadcast();
    broadcastPauseOverview(true);
    return res;
  });
  ipcMain.handle('pause:resume', (_e, wsId: string): PauseUiWriteResult => {
    const res = uiResume(getBus(), realPauseUiDeps(), { wsId: String(wsId ?? '') });
    log.info(`pause-ui: resume ${res.runId ?? '?'} as ${res.actor ?? '?'} → ${res.outcome}`);
    invalidatePauseOverviewBroadcast();
    broadcastPauseOverview(true);
    return res;
  });
  ipcMain.handle('pause:release', (_e, wsId: string, targets: string[] | 'all', carrierRunId?: string | null): PauseUiReleaseResult => {
    const res = uiRelease(getBus(), realPauseUiDeps(), {
      wsId: String(wsId ?? ''),
      targets: targets === 'all' ? 'all' : (Array.isArray(targets) ? targets.map(String) : []),
      carrierRunId: carrierRunId ?? null,
    });
    log.info(`pause-ui: release ${res.carrierRunId ?? res.runId ?? '?'} as ${res.actor ?? '?'} → released ${res.result?.released.length ?? 0}`);
    invalidatePauseOverviewBroadcast();
    broadcastPauseOverview(true);
    return res;
  });
}

// ── watching the bus ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every Pause column is written by the CLI / the host sweep / this module straight into the bus DB, so the push rides the SAME directory watch the human-gates push
// and the bus-wake accelerator use (the `-wal` inode is recycled — watching the directory survives it).

let watcher: fs.FSWatcher | null = null;
let debounce: ReturnType<typeof setTimeout> | null = null;
const WATCH_DEBOUNCE_MS = 150;

export function startPauseUiWatcher(): void {
  if (watcher) return;
  const bus = busPath();
  const dir = path.dirname(bus);
  const base = path.basename(bus);
  const fire = () => {
    if (debounce) clearTimeout(debounce);
    debounce = setTimeout(() => {
      try {
        broadcastPauseOverview();
      } catch (e) {
        log.warn('pause-ui: overview push failed', e);
      }
    }, WATCH_DEBOUNCE_MS);
    debounce.unref?.();
  };
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== `${base}-wal` && filename !== base) return; // a null filename is a match: a spurious idempotent recompute beats a missed pause
      fire();
    });
  } catch (e) {
    log.warn('pause-ui: could not watch the bus directory (the overview then refreshes on the UI\'s own writes and on pull)', e);
  }
}

export function stopPauseUiWatcher(): void {
  if (debounce) clearTimeout(debounce);
  debounce = null;
  watcher?.close();
  watcher = null;
}

/** Publish the current state once (boot: a pause may have landed while the app was down). */
export function reconcilePauseUi(): void {
  invalidatePauseOverviewBroadcast();
  broadcastPauseOverview(true);
}
