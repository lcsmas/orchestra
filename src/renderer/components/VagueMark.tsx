// Vague endormie (#429, prototype variant A): the mark on the COORDINATOR's own sidebar row — a « endormie » pill on the name line, a sub-line « depuis HH:MM · N tâche(s) en attente » and a Relancer button.
// The members' rows are dimmed by the `vague-dim` class (shared/vague-human.ts `vagueDimClass`). Each piece reads ONE store slice (`vagueMarks`) and renders nothing for an ordinary row. The mark is
// drawn by the app, never by a conversation: it sits on the coordinator's row, so a vague folded in the sidebar still shows it.
import { useEffect, useState } from 'react';
import { useStore } from '../store';
import { VAGUE_PILL, markOfCoordinator, markSubLine } from '../../shared/vague-human';

const RELANCE_WORDS: Record<string, string> = {
  sent: 'Relancé',
  held: 'Mémoire basse — en attente',
  pending: 'Démarrage en cours…',
  failed: 'Échec — réessayer',
  'not-wakeable': 'Démarrage impossible',
  'not-asleep': 'Plus endormie',
  'no-parent': 'Aucun parent',
};

/** The « ☾ endormie » pill, on the name line of the coordinator. */
export function VagueRowBadge({ wsId }: { wsId: string }) {
  const mark = useStore((s) => markOfCoordinator(s.vagueMarks, wsId));
  if (!mark) return null;
  return (
    <span className="vague-pill" title="Vague endormie — aucun membre ne peut reprendre seul" data-vague-pill={wsId}>
      {VAGUE_PILL}
    </span>
  );
}

/** « depuis HH:MM · N tâche(s) en attente » + the Relancer button (absent when the coordinator has no parent: nothing is ever sent to the LEAD's conversation). */
export function VagueRowNote({ wsId }: { wsId: string }) {
  const mark = useStore((s) => markOfCoordinator(s.vagueMarks, wsId));
  const [state, setState] = useState<'idle' | 'busy' | string>('idle');
  const episode = mark ? `${mark.runId}@${mark.since}` : '';
  // the answer belongs to ONE episode: it goes when the mark does (the component stays mounted) and fades after a few seconds
  useEffect(() => setState('idle'), [episode]);
  useEffect(() => {
    if (state === 'idle' || state === 'busy') return;
    const t = setTimeout(() => setState('idle'), 8000);
    return () => clearTimeout(t);
  }, [state]);
  if (!mark) return null;
  const relancer = async (e: React.MouseEvent) => {
    e.stopPropagation(); // a click on the button is not a click on the row
    if (state === 'busy') return;
    setState('busy');
    try {
      setState(await window.orchestra.relanceVague(mark.runId));
    } catch {
      setState('failed');
    }
  };
  return (
    <div className="ws-status-note vague-note" data-vague-note={wsId}>
      <span className="vague-note-text" data-vague-since={mark.since} data-vague-pending={mark.pending}>
        {markSubLine(mark)}
      </span>
      {mark.canRelance && (
        <button type="button" className="vague-btn" data-vague-relance={wsId} disabled={state === 'busy'} onClick={(e) => void relancer(e)} title="Relancer le coordinateur (un nouveau tour pour lui — rien n'est envoyé à une conversation que vous menez)">
          Relancer
        </button>
      )}
      {state !== 'idle' && state !== 'busy' && (
        <span className="vague-result" data-vague-result={state} role="status">
          {RELANCE_WORDS[state] ?? state}
        </span>
      )}
    </div>
  );
}
