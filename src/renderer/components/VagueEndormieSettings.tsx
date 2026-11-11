import { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { DEFAULT_VAGUE_DELAYS, VAGUE_DELAY_MAX, VAGUE_DELAY_MIN, vagueDelaysError, type VagueDelays } from '../../shared/vague-human';

interface Props {
  onClose: () => void;
}

/**
 * Vague endormie (#429): the two delays, in minutes — a quiet vague is declared asleep after the first, the human is told that long after its coordinator's Relance (second).
 * A change is written when a field is committed (blur / Enter) and applies at the sweep's next pass: no restart. The fields always show what the host stored, never a value it did not take.
 */
export function VagueEndormieSettings({ onClose }: Props) {
  const [stored, setStored] = useState<VagueDelays | null>(null);
  const [draft, setDraft] = useState<{ asleepMin: string; humanMin: string } | null>(null);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    void window.orchestra.vagueDelays().then(setStored).catch(() => setError('Impossible de lire les délais.'));
  }, []);

  const typed = draft ?? (stored ? { asleepMin: String(stored.asleepMin), humanMin: String(stored.humanMin) } : { asleepMin: '', humanMin: '' });

  const commit = async () => {
    if (!stored || !draft) return;
    const committed = draft;
    const next = { asleepMin: Number(draft.asleepMin), humanMin: Number(draft.humanMin) };
    const bad = vagueDelaysError(next);
    if (bad) return setError(bad);
    if (next.asleepMin === stored.asleepMin && next.humanMin === stored.humanMin) {
      setDraft(null);
      return setError(null);
    }
    try {
      const res = await window.orchestra.setVagueDelays(next);
      if (res.ok) {
        setStored(res.delays);
        setDraft((d) => (d === committed ? null : d)); // keep what was typed since (a blur-commit of one field must not wipe the next field's typing)
        setError(null);
      } else setError(res.error);
    } catch (e) {
      setError(`Non enregistré — ${e instanceof Error ? e.message : String(e)}`);
    }
  };
  const edit = (which: 'asleepMin' | 'humanMin') => (e: React.ChangeEvent<HTMLInputElement>) => {
    setError(null);
    setDraft({ ...typed, [which]: e.target.value });
  };
  // closing (backdrop or button) flushes a typed edit first: a mousedown on the backdrop must not lose it
  const close = () => void commit().finally(onClose);
  const onKey = (e: React.KeyboardEvent) => {
    if (e.key === 'Enter') void commit();
  };

  return createPortal(
    <div
      className="modal-backdrop"
      onMouseDown={(e) => {
        if (e.target === e.currentTarget) close();
      }}
    >
      <div className="modal sound-settings vague-settings" role="dialog" aria-label="Vague endormie" data-vague-settings>
        <h2>Vague endormie</h2>
        <div className="sound-hint">
          Une vague dort quand il lui reste des tâches non terminées et que rien ne peut réveiller personne. <strong>Les changements s'appliquent tout de suite</strong>, sans redémarrage.
        </div>
        <div className="vague-field">
          <label htmlFor="vague-asleep-min">Déclarée endormie après</label>
          <div className="vague-input-row">
            <input id="vague-asleep-min" className="vague-input" data-vague-asleep-min inputMode="numeric" value={typed.asleepMin} onChange={edit('asleepMin')} onBlur={() => void commit()} onKeyDown={onKey} />
            <span className="vague-unit">min</span>
            <span className="vague-default">défaut {DEFAULT_VAGUE_DELAYS.asleepMin}</span>
          </div>
          <div className="vague-desc">Sans activité ni processus vivant. Son coordinateur reçoit alors une Relance.</div>
        </div>
        <div className="vague-field">
          <label htmlFor="vague-human-min">Vous prévenir après</label>
          <div className="vague-input-row">
            <input id="vague-human-min" className="vague-input" data-vague-human-min inputMode="numeric" value={typed.humanMin} onChange={edit('humanMin')} onBlur={() => void commit()} onKeyDown={onKey} />
            <span className="vague-unit">min</span>
            <span className="vague-default">défaut {DEFAULT_VAGUE_DELAYS.humanMin}</span>
          </div>
          <div className="vague-desc">Après la Relance du coordinateur, si aucun membre n'a repris : une notification et la marque « endormie » sur sa ligne. Entre {VAGUE_DELAY_MIN} et {VAGUE_DELAY_MAX} minutes.</div>
        </div>
        {error && (
          <div className="vague-error" role="alert" data-vague-error>
            {error}
          </div>
        )}
        <div className="modal-actions">
          <button className="btn" onClick={close}>
            Fermer
          </button>
        </div>
      </div>
    </div>,
    document.body,
  );
}
