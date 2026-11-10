// PROTOTYPE — throwaway (grilling 2026-11-10). NOT production code: no tests, no error handling.
// Question: what should a Bloc HTML look like in the conversation — height, enlarging, theme?
// Three variants on one page, switchable via `?variant=A|B|C` (and `?theme=dark|light`), mounted on the
// REAL agent-view CSS, the real AgentMessage and the real MarkdownView. Run: pnpm run proto:bloc-html
import React, { createContext, useContext, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createRoot } from 'react-dom/client';
import '../../../styles.css';
import '../../../agent-view-defaults.css';
import '../../../agent-view-structure.css';
import '../../../agent-view-theme.css';
import '../../../agent-view-flat.css';
import './proto.css';
import { AgentMessage } from '../AgentMessage';
import { MarkdownView } from '../MarkdownView';
import { CONVERSATION, type SampleMessage } from './samples';

type Variant = 'A' | 'B' | 'C';
type Theme = 'dark' | 'light';
const VARIANTS: Record<Variant, string> = { A: 'Dans le fil', B: 'Carte à hauteur fixe', C: 'Vignette + panneau' };
const CAP = 420; // variant A: taller blocs are clipped behind « Afficher tout »

interface Bloc { key: string; title: string; html: string }
type Part = { kind: 'md'; text: string } | { kind: 'bloc'; bloc: Bloc } | { kind: 'pending'; title: string };

/** The candidate wire format: a ```html-render fence with an optional title. An unclosed fence = still streaming. */
function parse(msg: SampleMessage): Part[] {
  const parts: Part[] = [];
  const re = /```html-render(?: title="([^"]*)")?\n([\s\S]*?)\n```/g;
  let last = 0; let n = 0; let m: RegExpExecArray | null;
  while ((m = re.exec(msg.text))) {
    if (m.index > last) parts.push({ kind: 'md', text: msg.text.slice(last, m.index) });
    parts.push({ kind: 'bloc', bloc: { key: `${msg.id}-${n++}`, title: m[1] || 'Bloc HTML', html: m[2] } });
    last = m.index + m[0].length;
  }
  const rest = msg.text.slice(last);
  const open = /```html-render(?: title="([^"]*)")?\n/.exec(rest);
  if (open) { parts.push({ kind: 'md', text: rest.slice(0, open.index) }); parts.push({ kind: 'pending', title: open[1] || 'Bloc HTML' }); }
  else if (rest.trim()) parts.push({ kind: 'md', text: rest });
  return parts;
}

// ---------- the isolated frame (the mechanism the probes validated) ----------
const META_CSP = `<meta http-equiv="Content-Security-Policy" content="default-src 'none'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; img-src data:">`;
const TOKENS: [string, string][] = [['fg', '--av-text'], ['muted', '--av-text-dim'], ['surface', '--av-surface'], ['border', '--av-hairline-strong'], ['accent', '--av-assistant'], ['ok', '--av-add'], ['warn', '--av-warn'], ['err', '--av-error']];

function readTokens(): string {
  const view = document.querySelector('.av-view');
  if (!view) return '';
  const cs = getComputedStyle(view);
  return TOKENS.map(([k, v]) => `--bloc-${k}:${cs.getPropertyValue(v).trim()};`).join('');
}

/** The app's tokens, read from the mounted `.av-view` AFTER layout (reading them during render returns nothing). */
const TokensCtx = createContext('');

function srcdoc(bloc: Bloc, themed: boolean, tokens: string, fit: boolean): string {
  // FINDING: no `color-scheme` in a themed frame — a frame whose scheme differs from its embedder's gets an OPAQUE canvas
  // (measured: a #111 slab behind the bloc), and the app's own scheme is `normal` even though it looks dark.
  // `fit` = the frame is sized to its content, so it must never show a scrollbar of its own.
  const base = themed
    ? `:root{${tokens}}html{${fit ? 'overflow:hidden' : ''}}html,body{margin:0;background:transparent;color:var(--bloc-fg);font:13px/1.55 Inter,system-ui,sans-serif}`
    : `:root{color-scheme:light}html{background:#fff}body{margin:0;padding:14px;color:#16181d;font:14px/1.5 system-ui,sans-serif}`;
  // The frame is opaque to the parent, so its height can only come from a script INSIDE it.
  const report = `<script>(function(){function s(){parent.postMessage({__blocHtml:${JSON.stringify(bloc.key)},h:Math.ceil(document.documentElement.getBoundingClientRect().height)},'*')}new ResizeObserver(s).observe(document.documentElement);s()})()</script>`;
  return `<!doctype html><html><head><meta charset="utf-8">${META_CSP}<style>${base}</style></head><body>${bloc.html}${report}</body></html>`;
}

const heights = new Map<string, number>();
const heightListeners = new Set<() => void>();
window.addEventListener('message', (e) => {
  const d = e.data as { __blocHtml?: string; h?: number } | null;
  if (d && typeof d.__blocHtml === 'string' && typeof d.h === 'number') { heights.set(d.__blocHtml, d.h); heightListeners.forEach((f) => f()); }
});
function useHeight(key: string): number {
  const [, bump] = useState(0);
  useEffect(() => { const f = () => bump((x) => x + 1); heightListeners.add(f); return () => { heightListeners.delete(f); }; }, []);
  return heights.get(key) ?? 0;
}

interface FrameProps { bloc: Bloc; themed: boolean; theme: Theme; style?: React.CSSProperties; className?: string; inert?: boolean; fit?: boolean }
function BlocFrame({ bloc, themed, style, className, inert, fit }: FrameProps) {
  const tokens = useContext(TokensCtx);
  const doc = useMemo(() => srcdoc(bloc, themed, tokens, !!fit), [bloc, themed, tokens, fit]);
  if (themed && !tokens) return null; // wait for the tokens rather than paint an unthemed frame first
  return <iframe className={`pb-frame ${className ?? ''}`} title={bloc.title} sandbox="allow-scripts" srcDoc={doc} style={style} tabIndex={inert ? -1 : 0} />;
}

function Source({ bloc }: { bloc: Bloc }) {
  return <div className="av-md pb-source"><MarkdownView text={'```html\n' + bloc.html + '\n```'} done /></div>;
}

function Overlay({ bloc, themed, theme, onClose }: { bloc: Bloc; themed: boolean; theme: Theme; onClose: () => void }) {
  useEffect(() => { const k = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); }; window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k); }, [onClose]);
  return (
    <div className="pb-overlay" onClick={onClose}>
      <div className={`pb-overlay-box ${themed ? 'is-themed' : 'is-paper'}`} onClick={(e) => e.stopPropagation()}>
        <div className="pb-overlay-head"><b>{bloc.title}</b><span className="pb-grow" /><button className="pb-btn" onClick={onClose}>Fermer (Échap)</button></div>
        <BlocFrame bloc={bloc} themed={themed} theme={theme} className="pb-overlay-frame" />
      </div>
    </div>
  );
}

// ---------- Variant A: in the flow. No chrome, app theme, grows to its content, clipped past CAP. ----------
function VariantA({ bloc, theme }: { bloc: Bloc; theme: Theme }) {
  const h = useHeight(bloc.key);
  const [all, setAll] = useState(false);
  const [src, setSrc] = useState(false);
  const [big, setBig] = useState(false);
  const clipped = h > CAP && !all;
  return (
    <div className="pb-a">
      <div className="pb-a-tools">
        <button className="pb-ghost" title="Voir le source" onClick={() => setSrc((v) => !v)}>{src ? 'Rendu' : '</>'}</button>
        <button className="pb-ghost" title="Agrandir" onClick={() => setBig(true)}>⤢</button>
      </div>
      {src ? <Source bloc={bloc} /> : (
        <div className={`pb-a-clip ${clipped ? 'is-clipped' : ''}`} style={{ height: h ? (clipped ? CAP : h) : 80 }}>
          <BlocFrame bloc={bloc} themed theme={theme} style={{ height: h || 80 }} fit />
          {clipped ? <button className="pb-a-more" onClick={() => setAll(true)}>Afficher tout ({h} px)</button> : null}
        </div>
      )}
      {big ? <Overlay bloc={bloc} themed theme={theme} onClose={() => setBig(false)} /> : null}
    </div>
  );
}

// ---------- Variant B: a card. Title bar with labelled actions, fixed height, scrolls inside, the bloc's own look. ----------
function VariantB({ bloc, theme }: { bloc: Bloc; theme: Theme }) {
  const [src, setSrc] = useState(false);
  const [big, setBig] = useState(false);
  return (
    <div className="pb-b">
      <div className="pb-b-head">
        <span className="pb-b-kind">HTML</span><b>{bloc.title}</b><span className="pb-grow" />
        <button className="pb-btn" onClick={() => setSrc((v) => !v)}>{src ? 'Rendu' : 'Source'}</button>
        <button className="pb-btn" onClick={() => setBig(true)}>Agrandir</button>
      </div>
      {src ? <Source bloc={bloc} /> : <BlocFrame bloc={bloc} themed={false} theme={theme} className="pb-b-frame" />}
      {big ? <Overlay bloc={bloc} themed={false} theme={theme} onClose={() => setBig(false)} /> : null}
    </div>
  );
}

// ---------- Variant C: a thumbnail row in the reply; the bloc itself opens in a side panel. ----------
function VariantC({ bloc, theme, open, onOpen }: { bloc: Bloc; theme: Theme; open: boolean; onOpen: () => void }) {
  return (
    <button className={`pb-c ${open ? 'is-open' : ''}`} onClick={onOpen}>
      <span className="pb-c-thumb"><BlocFrame bloc={bloc} themed theme={theme} className="pb-c-thumb-frame" inert fit /></span>
      <span className="pb-c-text"><b>{bloc.title}</b><small>{open ? 'Ouvert dans le panneau' : 'Bloc HTML — cliquer pour ouvrir'}</small></span>
      <span className="pb-c-chev">›</span>
    </button>
  );
}

function Pending({ title }: { title: string }) {
  return <div className="pb-pending"><span className="pb-pending-dot" />Bloc HTML en cours… <b>{title}</b></div>;
}

function Reply({ msg, variant, theme, openKey, onOpen }: { msg: SampleMessage; variant: Variant; theme: Theme; openKey: string | null; onOpen: (b: Bloc) => void }) {
  const parts = useMemo(() => parse(msg), [msg]);
  // Same wrapper markup as MessageBubble (av-message > av-message-text > av-md) so density and spacing are the app's.
  return (
    <div className="av-row"><div className="av-message av-message-assistant" data-role="assistant"><div className="av-message-text">
      {parts.map((p, i) => p.kind === 'md' ? <div className="av-md" key={i}><MarkdownView text={p.text} done /></div>
        : p.kind === 'pending' ? <Pending key={i} title={p.title} />
        : variant === 'A' ? <VariantA key={p.bloc.key} bloc={p.bloc} theme={theme} />
        : variant === 'B' ? <VariantB key={p.bloc.key} bloc={p.bloc} theme={theme} />
        : <VariantC key={p.bloc.key} bloc={p.bloc} theme={theme} open={openKey === p.bloc.key} onOpen={() => onOpen(p.bloc)} />)}
      {msg.streaming ? <span className="av-cursor" aria-hidden /> : null}
    </div></div></div>
  );
}

function Switcher({ variant, theme, setVariant, setTheme, state }: { variant: Variant; theme: Theme; setVariant: (v: Variant) => void; setTheme: (t: Theme) => void; state: string }) {
  const keys = Object.keys(VARIANTS) as Variant[];
  const step = (d: number) => setVariant(keys[(keys.indexOf(variant) + d + keys.length) % keys.length]);
  useEffect(() => {
    const k = (e: KeyboardEvent) => {
      const t = e.target as HTMLElement | null;
      if (t && (t.tagName === 'INPUT' || t.tagName === 'TEXTAREA' || t.isContentEditable)) return;
      if (e.key === 'ArrowLeft') step(-1); else if (e.key === 'ArrowRight') step(1);
    };
    window.addEventListener('keydown', k); return () => window.removeEventListener('keydown', k);
  });
  return (
    <div className="pb-switcher">
      <button onClick={() => step(-1)} aria-label="Variante précédente">←</button>
      <span className="pb-switcher-label">{variant} ({VARIANTS[variant]})</span>
      <button onClick={() => step(1)} aria-label="Variante suivante">→</button>
      <button onClick={() => setTheme(theme === 'dark' ? 'light' : 'dark')}>thème : {theme}</button>
      <span className="pb-switcher-state">{state}</span>
    </div>
  );
}

function App() {
  const qs = new URLSearchParams(location.search);
  const [variant, setVariantState] = useState<Variant>((['A', 'B', 'C'] as Variant[]).includes(qs.get('variant') as Variant) ? (qs.get('variant') as Variant) : 'A');
  const [theme, setThemeState] = useState<Theme>(qs.get('theme') === 'light' ? 'light' : 'dark');
  const [open, setOpen] = useState<Bloc | null>(null);
  const [state, setState] = useState('');
  const listRef = useRef<HTMLDivElement>(null);
  const [tokens, setTokens] = useState('');
  useLayoutEffect(() => { setTokens(readTokens()); }, [theme]);
  const sync = (v: Variant, t: Theme) => { const u = new URL(location.href); u.searchParams.set('variant', v); u.searchParams.set('theme', t); history.replaceState(null, '', u); };
  const setVariant = (v: Variant) => { setVariantState(v); setOpen(null); sync(v, theme); };
  const setTheme = (t: Theme) => { setThemeState(t); sync(variant, t); };
  // Surface the state after every switch: live frames and the heights the blocs reported.
  useEffect(() => {
    const read = () => setState(`cadres vivants : ${document.querySelectorAll('iframe').length} · hauteurs : ${[...heights.values()].join(' / ') || '—'} px`);
    const id = setInterval(read, 400); read(); return () => clearInterval(id);
  }, [variant, theme, open]);
  return (
    <TokensCtx.Provider value={tokens}><div className="pb-app" data-agent-theme={theme}>
      <aside className="pb-fake-sidebar"><b>PROTOTYPE</b><span>Bloc HTML</span><i>workspace-a</i><i>workspace-b</i><i>workspace-c</i></aside>
      <main className="pb-pane">
        <div className="av-view active pb-view" key={theme}>
          <div className="av-message-list" ref={listRef}>
            {CONVERSATION.map((m) => m.role === 'user'
              ? <div className="av-row" key={m.id}><AgentMessage message={{ id: m.id, role: 'user', text: m.text, done: true }} /></div>
              : <Reply key={`${m.id}-${variant}`} msg={m} variant={variant} theme={theme} openKey={open?.key ?? null} onOpen={setOpen} />)}
          </div>
        </div>
      </main>
      {variant === 'C' && open ? (
        <section className="pb-panel av-view active" key={`${open.key}-${theme}`}>
          <div className="pb-panel-head"><b>{open.title}</b><span className="pb-grow" /><button className="pb-btn" onClick={() => setOpen(null)}>Fermer</button></div>
          <BlocFrame bloc={open} themed theme={theme} className="pb-panel-frame" />
        </section>
      ) : null}
      {(import.meta as unknown as { env?: { PROD?: boolean } }).env?.PROD ? null : <Switcher variant={variant} theme={theme} setVariant={setVariant} setTheme={setTheme} state={state} />}
    </div></TokensCtx.Provider>
  );
}

createRoot(document.getElementById('root')!).render(<App />);
