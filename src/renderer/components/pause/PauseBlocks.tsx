// Fleet Pause — the building blocks every option composes (#257, wave F ledger #281): state badge / glyph, progress bar, the refusal block, the action button, a 1 s clock
// that only ticks while a Pause douce is waiting. Pure render over the wire types of src/shared/pause-ui.ts; styled by src/renderer/pause-ui.css (the app's own tokens).
// Every element carries a `data-pause-*` hook: the G3 drive (scripts/pause-ui/) reads state and clicks through them, never through text.

import { useEffect, useState } from 'react';
import type { PauseUiExplain, PauseUiExplainAction, PauseUiMemberState } from '../../../shared/pause-ui';
import { PAUSE_STATE_WORD, stateTone } from '../../../shared/pause-ui-view';

export type PauseIconKind = 'pause' | 'play' | 'clock' | 'check' | 'stop' | 'ban' | 'info' | 'chev';

const PATHS: Record<PauseIconKind, React.ReactNode> = {
  pause: (<><rect x="3.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /><rect x="9.5" y="2.5" width="3" height="11" rx="1" fill="currentColor" /></>),
  play: <path d="M4.5 2.5v11l9-5.5z" fill="currentColor" />,
  stop: <rect x="3" y="3" width="10" height="10" rx="1.6" fill="currentColor" />,
  check: <path d="M3.5 8.6l3 3 6-7.2" stroke="currentColor" fill="none" strokeWidth="1.9" strokeLinecap="round" strokeLinejoin="round" />,
  clock: (<><circle cx="8" cy="8" r="6" stroke="currentColor" fill="none" strokeWidth="1.5" /><path d="M8 4.6V8l2.3 1.5" stroke="currentColor" fill="none" strokeWidth="1.5" strokeLinecap="round" /></>),
  info: (<><circle cx="8" cy="8" r="6.2" stroke="currentColor" fill="none" strokeWidth="1.5" /><path d="M8 7.2v4M8 4.9v.2" stroke="currentColor" strokeWidth="1.7" strokeLinecap="round" /></>),
  ban: (<><circle cx="8" cy="8" r="6.2" stroke="currentColor" fill="none" strokeWidth="1.5" /><path d="M3.9 12.1l8.2-8.2" stroke="currentColor" strokeWidth="1.5" /></>),
  chev: <path d="M4 6l4 4 4-4" stroke="currentColor" fill="none" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />,
};

export function PauseIcon({ kind, size = 12 }: { kind: PauseIconKind; size?: number }) {
  return (
    <svg className="pause-icon" viewBox="0 0 16 16" width={size} height={size} aria-hidden="true">
      {PATHS[kind]}
    </svg>
  );
}

const STATE_ICON: Record<PauseUiMemberState, PauseIconKind> = { pausing: 'clock', paused: 'pause', blocked: 'pause', released: 'play', resumed: 'check' };

/** The member's state as a small pill ("en pause", "finit…", "bloqué", "libéré", "repris"). */
export function PauseBadge({ wsId, ui, compact = false }: { wsId: string; ui: PauseUiMemberState; compact?: boolean }) {
  return (
    <span
      className={`pause-badge pause-t-${stateTone(ui)}${ui === 'blocked' ? ' is-blocked' : ''}${compact ? ' is-compact' : ''}`}
      data-pause-badge={wsId}
      data-pause-state={ui}
      title={PAUSE_STATE_WORD[ui]}
    >
      <PauseIcon kind={STATE_ICON[ui]} size={9} />
      {PAUSE_STATE_WORD[ui]}
    </span>
  );
}

/** The icon-only form (replaces the row's status glyph). */
export function PauseGlyph({ wsId, ui }: { wsId: string; ui: PauseUiMemberState }) {
  return (
    <span className={`pause-glyph pause-t-${stateTone(ui)}`} data-pause-glyph={wsId} data-pause-state={ui} title={PAUSE_STATE_WORD[ui]} role="img" aria-label={PAUSE_STATE_WORD[ui]}>
      <PauseIcon kind={STATE_ICON[ui]} size={12} />
    </span>
  );
}

export function PauseBar({ fraction, tone, done, total, kind }: { fraction: number; tone: 'pausing' | 'paused' | 'resumed'; done?: number; total?: number; kind?: 'en-pause' | 'repris' }) {
  return (
    <div className="pause-bar" data-pause-progress="" data-done={done} data-total={total} data-kind={kind} role="progressbar" aria-valuemin={0} aria-valuemax={total ?? 100} aria-valuenow={done ?? Math.round(fraction * 100)}>
      <i className={`pause-fill pause-fill-${tone}`} style={{ width: `${Math.round(Math.max(0, Math.min(1, fraction)) * 100)}%` }} />
    </div>
  );
}

export type PauseActionKind = 'soft' | 'hard' | 'resume' | 'release-all' | 'release' | 'repause';
const ACTION_ICON: Record<PauseActionKind, PauseIconKind> = { soft: 'clock', hard: 'pause', resume: 'play', 'release-all': 'play', release: 'play', repause: 'pause' };

export function PauseActionButton({ kind, wsId, tone = 'ghost', disabled, children, onClick, why }: {
  kind: PauseActionKind;
  /** The workspace row the action is attributed to (the writer's actor). */
  wsId: string;
  tone?: 'primary' | 'go' | 'warn' | 'ghost';
  disabled?: boolean;
  children: React.ReactNode;
  onClick: () => void;
  /** Why it is greyed out (title) — a dead control is always explained. */
  why?: string;
}) {
  return (
    <button type="button" className={`pause-btn pause-btn-${tone}${disabled ? ' is-off' : ''}`} data-pause-action={kind} data-pause-for={wsId} aria-disabled={disabled || undefined} title={disabled ? why : undefined} onClick={disabled ? undefined : onClick}>
      <PauseIcon kind={ACTION_ICON[kind]} size={11} />
      {children}
    </button>
  );
}

/** The overview could not be read (bus down / a read threw): the badges are NOT reliable — said out loud, never an empty "nothing is paused". */
export function PauseUnreadable({ error }: { error: string | null }) {
  return (
    <div className="pause-unreadable" role="alert" data-pause-unreadable="">
      <PauseIcon kind="ban" size={12} />
      <span><b>Pause : état illisible</b> — une flotte en pause peut ne pas s'afficher ici. {error ?? ''}</span>
    </div>
  );
}

/** A refusal / info / warning from an outcome, explained (never a bare failure): what happened, what was (not) written, what to do. */
export function PauseExplain({ explain, code, onAction }: { explain: PauseUiExplain; code?: string; onAction?: (a: PauseUiExplainAction) => void }) {
  return (
    <div className={`pause-explain is-${explain.tone}`} data-pause-explain={explain.tone} data-pause-explain-code={code} role={explain.tone === 'error' ? 'alert' : 'status'}>
      <PauseIcon kind={explain.tone === 'error' ? 'ban' : 'info'} size={13} />
      <div>
        <b>{explain.title}</b>
        <span className="pause-explain-why">{explain.why}</span>
        {explain.actions && explain.actions.length > 0 && onAction ? (
          <div className="pause-explain-actions">
            {explain.actions.map((a) =>
              a.kind === 'goto' ? (
                // NAVIGATION only (spec Q5): a link to the worker's orchestrator — it selects that row, it acts on nothing
                <button key={`goto:${a.wsId}`} type="button" className="pause-link" data-pause-fix="goto" data-pause-for={a.wsId} onClick={() => onAction(a)}>
                  {a.label} →
                </button>
              ) : (
                <button key={`release:${a.wsId}:${a.ids.join(',')}`} type="button" className="pause-btn pause-btn-go" data-pause-fix="release" data-pause-for={a.wsId} data-pause-ids={a.ids.join(',')} onClick={() => onAction(a)}>
                  <PauseIcon kind="play" size={11} />
                  {a.label}
                </button>
              ),
            )}
          </div>
        ) : explain.fix.length > 0 && (
          <ul className="pause-explain-fix">
            {explain.fix.map((f) => (
              <li key={f}>{f}</li>
            ))}
          </ul>
        )}
      </div>
    </div>
  );
}

/** A clock that ticks every second ONLY while `active` (a Pause douce is waiting): no timer is mounted otherwise. */
export function useNowTick(active: boolean, ms = 1000): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    setNow(Date.now());
    const t = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(t);
  }, [active, ms]);
  return now;
}
