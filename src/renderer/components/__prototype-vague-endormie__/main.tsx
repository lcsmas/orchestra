// PROTOTYPE — throwaway (grilling 2026-11-11, question Q10). NOT production code.
// Question: how is the human told that a vague is asleep (unfinished tasks, nobody can wake anybody)?
// Three variants via `?variant=A|B|C`, on the REAL sidebar/app CSS and the real status glyph.
// `?state=endormie|reprise` shows that the mark goes away as soon as a member resumes.
// Run: pnpm run proto:vague-endormie
import React, { useEffect, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../styles.css';
import '../../pause-ui.css';
import '../../sidebar-orca.css';
import './proto.css';
import { WorkspaceStatusGlyph } from '../WorkspaceStatusGlyph';
import type { WorkspaceStatus } from '../../../shared/types.ts';

type Variant = 'A' | 'B' | 'C';
type State = 'endormie' | 'reprise';
const VARIANTS: Record<Variant, string> = { A: 'Sur la ligne du coordinateur', B: 'Bandeau dans la barre latérale', C: 'Bannière en haut de l\'app' };

// The night of 2026-11-10, as measured: last activity 22:48 UTC, everyone hibernated by 23:19.
const WAVE = { coord: 'ops-bloc-html-414', since: '23:19', duration: '16 h 19', pending: ['#419 — budget de cadres vivants et taille maximale'], last: 'impl-budget-blocs-html-419, 22:48', live: 'aucun processus vivant', relance: 'coordinateur relancé à 23:29, sans effet' };

interface Row { id: string; name: string; depth: number; status: WorkspaceStatus; hibernated?: boolean; wave?: boolean; coord?: boolean; active?: boolean; note?: string }
const rows = (s: State): Row[] => [
  { id: 'lead', name: 'render-html-in-agent-replies', depth: 0, status: 'idle', active: true },
  { id: 'ops', name: WAVE.coord, depth: 1, status: s === 'reprise' ? 'running' : 'idle', hibernated: s === 'endormie', wave: true, coord: true },
  { id: 'v1', name: 'verif-blocs-html-414', depth: 2, status: 'idle', hibernated: true, wave: true },
  { id: 'i419', name: 'impl-budget-blocs-html-419', depth: 2, status: s === 'reprise' ? 'running' : 'idle', hibernated: s === 'endormie', wave: true },
  { id: 'v2', name: 'verif-blocs-html-seconde-414', depth: 2, status: 'idle', hibernated: true, wave: true },
  { id: 'b2', name: 'bloc2-mc-next-migration-poc', depth: 0, status: 'running' },
  { id: 'b2o', name: 'ops-bloc2-vague9-tickets-robin', depth: 1, status: 'running' },
  { id: 'b2i', name: 'impl-redirection-espace-client', depth: 2, status: 'running' },
  { id: 'solo', name: 'fix-usage-bar-rounding', depth: 0, status: 'waiting' },
];

function RowView({ r, variant, asleep, onRelance }: { r: Row; variant: Variant; asleep: boolean; onRelance: () => void }) {
  const markA = variant === 'A' && asleep && r.wave;
  return (
    <div className={`ws-item ${r.active ? 'active' : ''}${r.depth ? ' ws-child' : ''}${markA && !r.coord ? ' pv-dim' : ''}`} style={r.depth ? ({ '--ws-depth': r.depth } as React.CSSProperties) : undefined}>
      <WorkspaceStatusGlyph status={r.status} hibernated={!!r.hibernated} unread={false} title={r.status} size={r.depth ? 'sm' : undefined} />
      <div className="ws-body">
        <div className="ws-name-row">
          <span className="ws-name">{r.name}</span>
          {markA && r.coord ? <span className="pv-a-badge" title="Vague endormie">☾ endormie</span> : null}
        </div>
        {markA && r.coord ? (
          <div className="pv-a-sub">
            <span>depuis {WAVE.since} · {WAVE.pending.length} tâche en attente</span>
            <button className="pv-a-btn" onClick={(e) => { e.stopPropagation(); onRelance(); }}>Relancer</button>
          </div>
        ) : null}
      </div>
    </div>
  );
}

function Details() {
  return (
    <dl className="pv-details">
      <dt>Reste à faire</dt><dd>{WAVE.pending.join(', ')}</dd>
      <dt>Dernière activité</dt><dd>{WAVE.last}</dd>
      <dt>Processus</dt><dd>{WAVE.live}</dd>
      <dt>Déjà tenté</dt><dd>{WAVE.relance}</dd>
    </dl>
  );
}

function StripB({ onRelance }: { onRelance: () => void }) {
  const [open, setOpen] = useState(true);
  return (
    <div className="pv-b-wrap">
      {open ? (
        <div className="pv-b-pop" role="dialog" aria-label="Vague endormie">
          <b>{WAVE.coord} dort depuis {WAVE.since}</b>
          <Details />
          <div className="pv-actions"><button className="pv-btn pv-primary" onClick={onRelance}>Relancer le coordinateur</button><button className="pv-btn">Ouvrir la vague</button></div>
        </div>
      ) : null}
      <button className="pv-b-strip" onClick={() => setOpen((v) => !v)} aria-expanded={open}>
        <span aria-hidden="true">☾</span><span className="pv-b-label">1 vague endormie</span><span className="pv-b-age">{WAVE.duration}</span>
      </button>
    </div>
  );
}

function BannerC({ onRelance }: { onRelance: () => void }) {
  return (
    <div className="memory-banner warn pv-c" role="status">
      <span className="memory-banner-ico" aria-hidden="true">☾</span>
      <span className="memory-banner-text">
        <span className="memory-banner-title">La vague {WAVE.coord} dort depuis {WAVE.since} ({WAVE.duration})</span>
        <span className="memory-banner-sub">Reste : {WAVE.pending.join(', ')}. Dernière activité : {WAVE.last}. {WAVE.live[0].toUpperCase() + WAVE.live.slice(1)} ; {WAVE.relance}.</span>
      </span>
      <button className="pv-btn pv-primary" onClick={onRelance}>Relancer</button>
      <button className="pv-btn">Ouvrir la vague</button>
    </div>
  );
}

function App() {
  const qs = new URLSearchParams(location.search);
  const [variant, setV] = useState<Variant>((['A', 'B', 'C'] as Variant[]).includes(qs.get('variant') as Variant) ? (qs.get('variant') as Variant) : 'A');
  const [state, setS] = useState<State>(qs.get('state') === 'reprise' ? 'reprise' : 'endormie');
  const sync = (v: Variant, s: State) => { const u = new URL(location.href); u.searchParams.set('variant', v); u.searchParams.set('state', s); history.replaceState(null, '', u); };
  const setVariant = (v: Variant) => { setV(v); sync(v, state); };
  const setState = (s: State) => { setS(s); sync(variant, s); };
  const keys = Object.keys(VARIANTS) as Variant[];
  const step = (d: number) => setVariant(keys[(keys.indexOf(variant) + d + keys.length) % keys.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => { if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1); };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  const asleep = state === 'endormie';
  const relance = () => setState('reprise');
  return (
    <div className="app pv-app">
      <aside className="sidebar">
        <div className="sidebar-header"><h1>Orchestra</h1></div>
        <div className="ws-list">
          <div className="ws-tree">{rows(state).slice(0, 5).map((r) => <RowView key={r.id} r={r} variant={variant} asleep={asleep} onRelance={relance} />)}</div>
          <div className="ws-tree">{rows(state).slice(5, 8).map((r) => <RowView key={r.id} r={r} variant={variant} asleep={asleep} onRelance={relance} />)}</div>
          <div className="ws-tree">{rows(state).slice(8).map((r) => <RowView key={r.id} r={r} variant={variant} asleep={asleep} onRelance={relance} />)}</div>
        </div>
        {variant === 'B' && asleep ? <StripB onRelance={relance} /> : null}
        <div className="sidebar-footer"><span className="sidebar-footer-link">Resources</span><span className="sidebar-footer-link">Bus</span><span className="sidebar-footer-version">PROTOTYPE</span></div>
      </aside>
      <main className="main pv-main">
        {variant === 'C' && asleep ? <BannerC onRelance={relance} /> : null}
        <div className="pv-fake-pane"><p>Conversation du LEAD (factice).</p><p className="pv-muted">La marque « vague endormie » ne passe par aucune conversation : elle est affichée par l'app.</p></div>
      </main>
      <div className="pv-switcher">
        <button onClick={() => step(-1)} aria-label="Variante précédente">←</button>
        <span className="pv-switcher-label">{variant} ({VARIANTS[variant]})</span>
        <button onClick={() => step(1)} aria-label="Variante suivante">→</button>
        <button onClick={() => setState(asleep ? 'reprise' : 'endormie')}>état : {asleep ? 'vague endormie' : 'un membre a repris'}</button>
        <span className="pv-switcher-state">marque affichée : {asleep ? 'oui' : 'non (disparue)'} · conversations touchées : 0</span>
      </div>
    </div>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
