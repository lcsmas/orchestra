// Fleet Pause — the click handlers every surface shares (#257): call the store action (= the shipped writer as the workspace row), then either close the floating panel (a success) or
// show the writer's own typed outcome EXPLAINED (a refusal — never a silent failure). Non-hook functions over the store + the panel store, so a Bus-page button and a sidebar menu agree.

import { create } from 'zustand';
import { useStore } from '../../store';
import type { PauseMode } from '../../../shared/pause-lifecycle';
import type { PauseUiExplain, PauseUiOverview, PauseUiRun } from '../../../shared/pause-ui';
import { releasableIds } from '../../../shared/pause-ui-view';

/** Where a floating panel hangs: the hovered row's rect (viewport coordinates), measured when the control was clicked. */
export interface PauseAnchor {
  top: number;
  bottom: number;
  right: number;
}

export type PausePanel =
  | { kind: 'choose'; wsId: string; anchor: PauseAnchor }
  | { kind: 'explain'; wsId: string; anchor: PauseAnchor; explains: PauseUiExplain[]; codes: string[] };

interface PausePanelStore {
  panel: PausePanel | null;
  show: (p: PausePanel) => void;
  close: () => void;
}
/** The ONE floating panel (the soft/hard menu or a refusal's explanation) — mounted once by `PauseMenuHost`. */
export const usePausePanel = create<PausePanelStore>((set) => ({ panel: null, show: (panel) => set({ panel }), close: () => set({ panel: null }) }));

/** A refusal comes back as an outcome; show it. `anchor` null (a Bus-page click) = the caller renders `explains` itself. */
function report(wsId: string, anchor: PauseAnchor | null, explains: PauseUiExplain[], codes: string[]): PauseUiExplain[] {
  const { show, close } = usePausePanel.getState();
  if (explains.length === 0) { close(); return []; }
  if (anchor) show({ kind: 'explain', wsId, anchor, explains, codes });
  return explains;
}

/** One write per (row, kind) at a time: a double-click must not send two writes (the second answers `already-paused` and re-opens an info panel over the success). */
const inflight = new Set<string>();
async function once<T>(key: string, fallback: T, fn: () => Promise<T>): Promise<T> {
  if (inflight.has(key)) return fallback;
  inflight.add(key);
  try {
    return await fn();
  } finally {
    inflight.delete(key);
  }
}

/** A rejected invoke (the main process gone, a handler that threw) is still EXPLAINED — never an unhandled rejection with the panel left open and silent. */
function ipcFailure(e: unknown): PauseUiExplain {
  return { tone: 'error', title: "La commande n'a pas atteint l'hôte", why: `${e instanceof Error ? e.message : String(e)} — rien n'est garanti écrit : relisez l'état (page Bus) avant de réessayer.`, fix: [] };
}

export async function runPause(wsId: string, mode: PauseMode, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  return once(`pause:${wsId}`, [], async () => {
    try {
      const res = await useStore.getState().pausePause(wsId, mode);
      return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);
    } catch (e) {
      return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);
    }
  });
}

export async function runResume(wsId: string, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  return once(`resume:${wsId}`, [], async () => {
    try {
      const res = await useStore.getState().pauseResume(wsId);
      return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);
    } catch (e) {
      return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);
    }
  });
}

/** "Libérer les N bloqués" = EXPLICIT ids (`releasableIds`): `'all'` is the acting row's own run only and would leave a nested wave's workers `below`. */
export async function runReleaseAll(wsId: string, run: PauseUiRun, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  const ids = releasableIds(run);
  if (ids.length === 0) return report(wsId, anchor, [], []);
  return once(`release:${run.carrierRunId}`, [], async () => {
    try {
      const res = await useStore.getState().pauseRelease(wsId, ids, run.carrierRunId);
      return report(wsId, anchor, res.explain, res.explain.map((e) => e.tone));
    } catch (e) {
      return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);
    }
  });
}

export async function runRelease(wsId: string, targetWsId: string, carrierRunId: string, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  return once(`release:${carrierRunId}:${targetWsId}`, [], async () => {
    try {
      const res = await useStore.getState().pauseRelease(wsId, [targetWsId], carrierRunId);
      return report(wsId, anchor, res.explain, res.explain.map((e) => e.tone));
    } catch (e) {
      return report(wsId, anchor, [ipcFailure(e)], ['ipc-failed']);
    }
  });
}

/** The overview selector every row part uses (one subscription shape). */
export const selectPauseOverview = (s: { pauseOverview: PauseUiOverview | null }): PauseUiOverview | null => s.pauseOverview;
