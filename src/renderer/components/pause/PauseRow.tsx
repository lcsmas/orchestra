// Fleet Pause, option A (#257) — the parts the sidebar rows compose: the status-glyph swap, the per-agent badge, the orchestrator's progress note + thin bar, the dim, and the
// hover action buttons (⏸ → the douce / dure choice · ■ dure maintenant · ▶ reprendre · ▶ libérer les N bloqués). Each reads ONE store slice (`pauseOverview`) and renders
// nothing when the fleet is not under a pause, so an ordinary row is byte-for-byte what it was. Kept apart from Sidebar.tsx (two render paths) and from the building blocks
// (PauseBlocks.tsx) so another option swaps THIS file and nothing else.

import type { ReactNode } from 'react';
import { useStore } from '../../store';
import { controlOf, pauseStateOf, releasableIds, rowNoteText, runOfControl } from '../../../shared/pause-ui-view';
import { PauseBadge, PauseBar, PauseGlyph, PauseIcon, useNowTick } from './PauseBlocks';
import { runPause, runReleaseAll, runResume, selectPauseOverview, usePausePanel, type PauseAnchor } from './pause-actions';

/** The agent's status glyph, or — while it is under a pause / Reprise — the state's own glyph. */
export function PauseAwareGlyph({ wsId, children }: { wsId: string; children: ReactNode }) {
  const st = pauseStateOf(useStore(selectPauseOverview), wsId);
  return st ? <PauseGlyph wsId={wsId} ui={st.ui} /> : <>{children}</>;
}

/** The small pill on the name line ("en pause", "finit…", "bloqué", "libéré", "repris"). */
export function PauseRowBadge({ wsId }: { wsId: string }) {
  const st = pauseStateOf(useStore(selectPauseOverview), wsId);
  return st ? <PauseBadge wsId={wsId} ui={st.ui} /> : null;
}

/** ` pause-dim` while the agent is held (its name reads dim, like a stopped one). */
export function usePauseDim(wsId: string): string {
  return pauseStateOf(useStore(selectPauseOverview), wsId) ? ' pause-dim' : '';
}

function NoteLine({ wsId }: { wsId: string }) {
  const o = useStore(selectPauseOverview);
  const run = runOfControl(o, controlOf(o, wsId));
  const now = useNowTick(run?.phase === 'pausing');
  if (!run || run.phase === 'active') return null;
  const n = rowNoteText(run, now);
  return (
    <div className={`ws-status-note pause-note pause-t-${n.tone}`} data-pause-note={wsId} data-pause-phase={run.phase}>
      {n.text}
    </div>
  );
}

/** The orchestrator's note line: the progress of the pause it holds, else the agent's own status note. */
export function PauseRowNote({ wsId, children }: { wsId: string; children: ReactNode }) {
  const o = useStore(selectPauseOverview);
  const run = runOfControl(o, controlOf(o, wsId));
  return run && run.phase !== 'active' ? <NoteLine wsId={wsId} /> : <>{children}</>;
}

/** The thin bar under an orchestrator row holding a pause: "N/M en pause" / "N/M repris". */
export function PauseRowBar({ wsId }: { wsId: string }) {
  const o = useStore(selectPauseOverview);
  const run = runOfControl(o, controlOf(o, wsId));
  const now = useNowTick(run?.phase === 'pausing');
  if (!run || run.phase === 'active') return null;
  const n = rowNoteText(run, now);
  return (
    <div className="pause-rowbar">
      <PauseBar fraction={n.fraction} tone={n.tone} done={run.progress.done} total={run.progress.total} kind={run.progress.kind} />
    </div>
  );
}

type Btn = { kind: 'soft' | 'hard' | 'resume' | 'release-all' | 'repause'; title: string; tone?: 'go' | 'warn'; icon: 'pause' | 'play' | 'stop'; onClick: () => void };

/** The hover action buttons for a row (they join the floating pill beside Archive / Unread). `rect` = the hovered row, where the panel will hang. */
export function PauseRowActions({ wsId, rect, onDone }: { wsId: string; rect: PauseAnchor; onDone?: () => void }) {
  const o = useStore(selectPauseOverview);
  if (!o) return null;
  const ctl = controlOf(o, wsId);
  const run = runOfControl(o, ctl);
  const under = pauseStateOf(o, wsId);
  const choose = () => usePausePanel.getState().show({ kind: 'choose', wsId, anchor: rect });
  const btns: Btn[] = [];
  if (ctl) {
    // an orchestrator row: the control follows the phase of the run it anchors
    if (ctl.phase === 'pausing') {
      btns.push({ kind: 'hard', title: 'Pause dure maintenant', tone: 'warn', icon: 'stop', onClick: () => void runPause(wsId, 'hard', rect) });
      btns.push({ kind: 'resume', title: 'Reprendre la vague', tone: 'go', icon: 'play', onClick: () => void runResume(wsId, rect) });
    } else if (ctl.phase === 'paused') {
      btns.push({ kind: 'resume', title: 'Reprendre la vague', tone: 'go', icon: 'play', onClick: () => void runResume(wsId, rect) });
    } else if (ctl.phase === 'resuming') {
      const n = run ? releasableIds(run).length : 0;
      if (run && n > 0) btns.push({ kind: 'release-all', title: `Libérer les ${n} bloqué${n > 1 ? 's' : ''}`, tone: 'go', icon: 'play', onClick: () => void runReleaseAll(wsId, run, rect) });
      btns.push({ kind: 'repause', title: 'Re-mettre la vague en pause…', icon: 'pause', onClick: choose });
    } else if (ctl.coveredBy) {
      // paused through an ancestor: the click is the writer's own `not-paused`, explained ("fleet-lead tient déjà cette vague en pause")
      btns.push({ kind: 'resume', title: `Reprendre (couverte par ${ctl.coveredBy.label})`, icon: 'play', onClick: () => void runResume(wsId, rect) });
    } else {
      btns.push({ kind: 'soft', title: 'Mettre la vague en pause…', icon: 'pause', onClick: ctl.can.pauseSoft.ok ? choose : () => void runPause(wsId, 'soft', rect) });
    }
  } else if (!under) {
    // a worker row: the click is the writer's own `refused`, explained (it names the run to pause) — nothing is written
    btns.push({ kind: 'soft', title: 'Mettre en pause…', icon: 'pause', onClick: () => void runPause(wsId, 'soft', rect) });
  }
  if (btns.length === 0) return null;
  return (
    <>
      {btns.map((b) => (
        <button
          key={b.kind}
          type="button"
          className="ws-icon-btn pause-row-btn"
          style={b.tone === 'go' ? { color: 'var(--green)' } : b.tone === 'warn' ? { color: 'var(--yellow)' } : undefined}
          title={b.title}
          aria-label={b.title}
          data-pause-action={b.kind}
          data-pause-for={wsId}
          onClick={(e) => { e.stopPropagation(); b.onClick(); onDone?.(); }}
        >
          <PauseIcon kind={b.icon} size={13} />
        </button>
      ))}
    </>
  );
}
