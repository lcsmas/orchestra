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

export async function runPause(wsId: string, mode: PauseMode, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  const res = await useStore.getState().pausePause(wsId, mode);
  return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);
}

export async function runResume(wsId: string, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  const res = await useStore.getState().pauseResume(wsId);
  return report(wsId, anchor, res.explain ? [res.explain] : [], [res.outcome]);
}

/** "Libérer les N bloqués" = EXPLICIT ids (`releasableIds`): `'all'` is the acting row's own run only and would leave a nested wave's workers `below`. */
export async function runReleaseAll(wsId: string, run: PauseUiRun, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  const ids = releasableIds(run);
  if (ids.length === 0) return report(wsId, anchor, [], []);
  const res = await useStore.getState().pauseRelease(wsId, ids, run.carrierRunId);
  return report(wsId, anchor, res.explain, res.explain.map((e) => e.tone));
}

export async function runRelease(wsId: string, targetWsId: string, carrierRunId: string, anchor: PauseAnchor | null): Promise<PauseUiExplain[]> {
  const res = await useStore.getState().pauseRelease(wsId, [targetWsId], carrierRunId);
  return report(wsId, anchor, res.explain, res.explain.map((e) => e.tone));
}

/** The overview selector every row part uses (one subscription shape). */
export const selectPauseOverview = (s: { pauseOverview: PauseUiOverview | null }): PauseUiOverview | null => s.pauseOverview;
