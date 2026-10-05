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
import { createCoalescer } from './pause-ui-coalesce';
import { pauseOverviewFingerprint, readPauseOverview, uiPause, uiRelease, uiResume, type PauseUiDeps } from './pause-ui';
import type { PauseMode } from '../shared/pause-lifecycle';
import type { PauseUiOverview, PauseUiReleaseResult, PauseUiWriteResult } from '../shared/pause-ui';

export const PAUSE_UI_IPC_CHANNELS: ReadonlyArray<{ channel: string; writes: boolean; what: string }> = [
  { channel: 'pause:overview', writes: false, what: 'read the pause overview: carriers + rosters + Bilan, per-orchestrator controls, per-workspace badges' },
  { channel: 'pause:pause', writes: true, what: 'setRunPause (douce | dure) as the HUMAN (D-pick Q1)' },
  { channel: 'pause:resume', writes: true, what: 'beginReprise (the structured Reprise) + the hold lift, as the HUMAN' },
  { channel: 'pause:release', writes: true, what: 'releaseMembers (<ws>… | all) as the HUMAN (`all` = the clicked row\'s own run)' },
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

function busKey(): string {
  const db = getBus();
  if (!db) return 'no-bus';
  try {
    return pauseOverviewFingerprint(db);
  } catch (e) {
    return `err:${e instanceof Error ? e.message : String(e)}`;
  }
}

let lastKey = '\u0000never';
let lastJson = '';
/** Strictly increasing per process: every overview that leaves this module carries one, so the renderer can drop an OLDER one (a write reply racing a fresher push — R1b-2). */
let overviewRev = 0;
const stamped = (o: PauseUiOverview): PauseUiOverview => ({ ...o, rev: ++overviewRev });

/** Rebuild the overview and push it to every renderer IF it changed. `force` = after the user's own write (no fingerprint shortcut). */
export function broadcastPauseOverview(force = false): PauseUiOverview | null {
  const deps = realPauseUiDeps();
  const key = `${busKey()}#${treeKey(deps)}`;
  if (!force && key === lastKey) return null;
  lastKey = key;
  const built = readPauseOverview(getBus(), deps);
  const json = JSON.stringify({ ...built, at: 0 });
  if (!force && json === lastJson) return built;
  lastJson = json;
  const overview = stamped(built);
  platform.broadcast(PAUSE_UI_PUSH_CHANNEL, overview);
  return overview;
}

export function invalidatePauseOverviewBroadcast(): void {
  lastKey = '\u0000never';
  lastJson = '';
}

/** After a UI write: force one push and answer the invoke with THAT SAME overview (the one the renderer also receives by push), never the older one `uiX` built before the push. */
function afterWrite<T extends { overview: PauseUiOverview }>(res: T): T {
  invalidatePauseOverviewBroadcast();
  const pushed = broadcastPauseOverview(true);
  return pushed ? { ...res, overview: pushed } : res;
}

/** Register the `pause:*` channels. Called ONCE at module scope from index.ts (a second registration THROWS on darwin). Every handler answers — never rejects the invoke: a down bus is `available:false` / `bus-unavailable`. */
export function registerPauseUiIpc(): void {
  ipcMain.handle('pause:overview', (): PauseUiOverview => stamped(readPauseOverview(getBus(), realPauseUiDeps())));
  ipcMain.handle('pause:pause', (_e, wsId: string, mode: PauseMode): PauseUiWriteResult => {
    const res = uiPause(getBus(), realPauseUiDeps(), { wsId: String(wsId ?? ''), mode });
    log.info(`pause-ui: pause ${mode === 'soft' ? 'douce' : mode === 'hard' ? 'dure' : '?'} on ${res.runId ?? '?'} as ${res.actor ?? '?'} → ${res.outcome}`);
    return afterWrite(res);
  });
  ipcMain.handle('pause:resume', (_e, wsId: string): PauseUiWriteResult => {
    const res = uiResume(getBus(), realPauseUiDeps(), { wsId: String(wsId ?? '') });
    log.info(`pause-ui: resume ${res.runId ?? '?'} as ${res.actor ?? '?'} → ${res.outcome}`);
    return afterWrite(res);
  });
  ipcMain.handle('pause:release', (_e, wsId: string, targets: string[] | 'all', carrierRunId?: string | null): PauseUiReleaseResult => {
    const res = uiRelease(getBus(), realPauseUiDeps(), {
      wsId: String(wsId ?? ''),
      targets: targets === 'all' ? 'all' : (Array.isArray(targets) ? targets.map(String) : []),
      carrierRunId: carrierRunId ?? null,
    });
    log.info(`pause-ui: release ${res.carrierRunId ?? res.runId ?? '?'} as ${res.actor ?? '?'} → released ${res.result?.released.length ?? 0}`);
    return afterWrite(res);
  });
}

// ── watching the bus ────────────────────────────────────────────────────────────────────────────────────────────────────────
// Every Pause column is written by the CLI / the host sweep / this module straight into the bus DB, so the push rides the SAME directory watch the human-gates push
// and the bus-wake accelerator use (the `-wal` inode is recycled — watching the directory survives it).

let watcher: fs.FSWatcher | null = null;
const WATCH_DEBOUNCE_MS = 150;
/** A push at least this often however busy the bus is (a plain trailing debounce starved under ≥ 7 writes/s — R1-5). */
const WATCH_MAX_WAIT_MS = 1000;
// MONOTONIC clock: a wall-clock step (the known RTC +2h trap) must not push the max-wait deadline out
const coalescer = createCoalescer(
  () => {
    try {
      broadcastPauseOverview();
    } catch (e) {
      log.warn('pause-ui: overview push failed', e);
    }
  },
  { debounceMs: WATCH_DEBOUNCE_MS, maxWaitMs: WATCH_MAX_WAIT_MS },
  { now: () => performance.now(), setTimer: (fn, ms) => { const t = setTimeout(fn, ms); t.unref?.(); return t; }, clearTimer: (t) => clearTimeout(t as ReturnType<typeof setTimeout>) },
);

export function startPauseUiWatcher(): void {
  if (watcher) return;
  const bus = busPath();
  const dir = path.dirname(bus);
  const base = path.basename(bus);
  try {
    fs.mkdirSync(dir, { recursive: true });
    watcher = fs.watch(dir, (_event, filename) => {
      if (filename && filename !== `${base}-wal` && filename !== base) return; // a null filename is a match: a spurious idempotent recompute beats a missed pause
      coalescer.poke();
    });
  } catch (e) {
    log.warn('pause-ui: could not watch the bus directory (the overview then refreshes on the UI\'s own writes and on pull)', e);
  }
}

export function stopPauseUiWatcher(): void {
  coalescer.cancel();
  watcher?.close();
  watcher = null;
}

/** Publish the current state once (boot: a pause may have landed while the app was down). */
export function reconcilePauseUi(): void {
  invalidatePauseOverviewBroadcast();
  broadcastPauseOverview(true);
}
