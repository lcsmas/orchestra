// Fleet Pause, option A (#257) — the floating panel hung off the hovered row: the Pause douce / dure choice, or a refusal / info EXPLAINED. Portalled to <body> beside the sidebar,
// like the row-actions pill it follows (RowActionsPopover.tsx) — the sidebar clips, so nothing laid out inside it can paint past its right edge.

import { useEffect, useRef } from 'react';
import { createPortal } from 'react-dom';
import { useStore } from '../../store';
import { agentsUnder } from '../../../shared/pause-ui-view';
import { PauseExplain, PauseIcon } from './PauseBlocks';
import { gotoWorkspace, runPause, runReleaseMany, selectPauseOverview, usePausePanel } from './pause-actions';

const OFFSET_X = 6;
const PANEL_W = 288;

export function PauseMenuHost() {
  const panel = usePausePanel((s) => s.panel);
  const close = usePausePanel((s) => s.close);
  const workspaces = useStore((s) => s.workspaces);
  // an explanation carrying « Libérer aussi ces N » belongs to the Reprise EPOCH it answered: a re-pause / a finished Reprise closes it (its ids must never be released into a later epoch unreviewed)
  const overview = useStore(selectPauseOverview);
  const epoch = !panel || panel.kind !== 'explain' ? '' : panel.explains.flatMap((e) => (e.actions ?? []).flatMap((a) => (a.kind === 'release' ? [a.carrierRunId] : []))).map((id) => { const r = overview?.runs.find((x) => x.carrierRunId === id); return r ? `${id}:${r.phase}@${r.pausedAt}` : `${id}:none`; }).join('|');
  const seen = useRef<{ panel: unknown; epoch: string } | null>(null);
  useEffect(() => {
    if (!panel || epoch === '') { seen.current = null; return; }
    if (seen.current === null || seen.current.panel !== panel) { seen.current = { panel, epoch }; return; }
    if (seen.current.epoch !== epoch) { seen.current = null; close(); }
  }, [panel, epoch, close]);
  useEffect(() => {
    if (!panel) return;
    // capture phase + swallowed: while the panel is open Escape closes the PANEL only (the Resources page, an open dialog… have their own Escape handlers)
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') { e.stopImmediatePropagation(); e.preventDefault(); close(); } };
    const onDown = (e: MouseEvent) => { if (!(e.target as HTMLElement | null)?.closest('[data-pause-panel]')) close(); };
    window.addEventListener('keydown', onKey, true);
    window.addEventListener('mousedown', onDown, true);
    return () => { window.removeEventListener('keydown', onKey, true); window.removeEventListener('mousedown', onDown, true); };
  }, [panel, close]);
  if (!panel) return null;
  const sidebar = document.querySelector('.sidebar')?.getBoundingClientRect();
  const left = (sidebar?.right ?? panel.anchor.right) + OFFSET_X;
  const top = Math.min(panel.anchor.bottom + 4, Math.max(8, window.innerHeight - 340));
  const ws = workspaces.find((w) => w.id === panel.wsId);
  const name = ws?.branch ?? ws?.name ?? panel.wsId.slice(0, 8);
  return createPortal(
    <div className="pause-panel" data-pause-panel={panel.kind} data-pause-for={panel.wsId} style={{ left, top, width: PANEL_W }} role="dialog" aria-label={panel.kind === 'choose' ? `Mettre ${name} en pause` : 'Pause — résultat'}>
      {panel.kind === 'choose' ? (
        <>
          <div className="pause-panel-h">{name} · {agentsUnder(panel.wsId, workspaces)} agents</div>
          <button type="button" className="pause-panel-item" data-pause-action="soft" data-pause-for={panel.wsId} onClick={() => void runPause(panel.wsId, 'soft', panel.anchor)}>
            <span className="pause-panel-icon pause-t-pausing"><PauseIcon kind="clock" size={14} /></span>
            <span><b>Pause douce</b><small>3 min pour finir, committer et pousser</small></span>
          </button>
          <button type="button" className="pause-panel-item" data-pause-action="hard" data-pause-for={panel.wsId} onClick={() => void runPause(panel.wsId, 'hard', panel.anchor)}>
            <span className="pause-panel-icon pause-t-paused"><PauseIcon kind="pause" size={14} /></span>
            <span><b>Pause dure</b><small>snapshot, interruption, arrêt des outils — tout de suite</small></span>
          </button>
        </>
      ) : (
        panel.explains.map((e, i) => (
          <PauseExplain
            key={i}
            explain={e}
            code={panel.codes[i]}
            onAction={(a) => (a.kind === 'release' ? void runReleaseMany(a.wsId, a.ids, a.carrierRunId, panel.anchor) : gotoWorkspace(a.wsId))}
          />
        ))
      )}
    </div>,
    document.body,
  );
}
