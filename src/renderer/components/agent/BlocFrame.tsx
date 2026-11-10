import React, { useCallback, useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { CodeBlock } from './CodeBlock';
import { useAgentTheme } from './agent-theme';
import { buildBlocDocument, BLOC_ESCAPE_FIELD, BLOC_HEIGHT_TAG, BLOC_HOVER_FIELD, BLOC_MAX_HEIGHT_PX, BLOC_THEME_KEYS, type BlocTokens } from '../../../shared/bloc-html-document';

interface Props {
  /** Accessible name of the frame. */
  title: string;
  /** The model's HTML (the fence content). */
  source: string;
}

/** `--bloc-<key>` ← the `--av-*` token it mirrors; resolved only INSIDE `.av-view`. */
const TOKEN_SOURCE: Record<(typeof BLOC_THEME_KEYS)[number], string> = {
  fg: '--av-text', muted: '--av-text-dim', surface: '--av-surface', border: '--av-hairline-strong',
  accent: '--av-assistant', ok: '--av-add', warn: '--av-warn', err: '--av-error',
};
const INITIAL_HEIGHT_PX = 80;
/** No height report in this time ⇒ the frame never ran: fall back to the source as code. */
const NO_REPORT_MS = 6000;

function readTokens(host: HTMLElement | null): BlocTokens | null {
  const view = host?.closest('.av-view');
  if (!host || !view) return null;
  const vs = getComputedStyle(view);
  const out: BlocTokens = {};
  for (const k of BLOC_THEME_KEYS) out[k] = vs.getPropertyValue(TOKEN_SOURCE[k]).trim();
  const body = getComputedStyle(host);
  out.fontSize = body.fontSize;
  out.fontFamily = body.fontFamily;
  return out;
}

/** A bloc keeps its last height across an unmount (virtualised list) so remounting does not jump the layout; one entry per surface (inline / enlarged). */
const lastHeight = new Map<string, number>();
const heightKey = (mode: string, source: string) => `${mode}:${source.length}:${source.slice(0, 64)}:${source.slice(-64)}`;

/** Above this many characters the source is shown as plain mono, not highlighted (250 KB of markup measured ≈ 1.3 s of long tasks in shiki). */
export const BLOC_SOURCE_HIGHLIGHT_MAX = 64 * 1024;
function SourceCode({ source }: { source: string }) {
  return <CodeBlock code={source} lang="html" done={source.length <= BLOC_SOURCE_HIGHLIGHT_MAX} />;
}

/** A bloc taller than this is clipped behind « Afficher tout » (variant A of the prototype). */
export const BLOC_CLIP_PX = 420;

interface LiveProps {
  title: string;
  source: string;
  /** `inline` sits in the flow; `enlarged` is the overlay's frame (its own width, hence its own height). */
  mode: 'inline' | 'enlarged';
  onHeight?: (h: number) => void;
  /** The pointer entered / left the frame (the parent document never sees it). */
  onHover?: (over: boolean) => void;
  /** The frame's Escape key press (focus inside the frame never reaches the parent document). */
  onEscape?: () => void;
  onFail: () => void;
  /** false ⇒ the frame is out of the Tab order (a clipped bloc: its controls would sit under the fade). */
  tabbable?: boolean;
}

/**
 * ONE live frame: the sandboxed iframe (scripts allowed, opaque origin), themed with the app tokens, sized to its content.
 * The parent accepts a message only from THIS frame's window and clamps the height. (#415, ADR 0011)
 */
function BlocLive({ title, source, mode, onHeight, onHover, onEscape, onFail, tabbable = true }: LiveProps) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useAgentTheme();
  const key = heightKey(mode, source);
  const [tokens, setTokens] = useState<BlocTokens | null>(null);
  const [height, setHeight] = useState(() => lastHeight.get(key) ?? INITIAL_HEIGHT_PX);
  const [reported, setReported] = useState(false);

  // Tokens exist only after layout, inside the mounted `.av-view`; a theme switch re-reads them.
  useLayoutEffect(() => { setTokens(readTokens(hostRef.current)); }, [theme]);
  useEffect(() => { onHeight?.(height); }, [height, onHeight]);

  const doc = useMemo(() => (tokens ? buildBlocDocument({ source, tokens, navigationShim: true }) : null), [source, tokens]);
  useEffect(() => { onHover?.(false); }, [doc, onHover]); // a reloaded frame never sends its mouseleave

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d[BLOC_HEIGHT_TAG] !== 1) return;
      if (d[BLOC_ESCAPE_FIELD] === 1) { onEscape?.(); return; }
      if (d[BLOC_HOVER_FIELD] === 0 || d[BLOC_HOVER_FIELD] === 1) { onHover?.(d[BLOC_HOVER_FIELD] === 1); return; }
      if (typeof d.h !== 'number' || !Number.isFinite(d.h)) return;
      const h = Math.max(0, Math.min(BLOC_MAX_HEIGHT_PX, Math.ceil(d.h)));
      lastHeight.set(key, h);
      setHeight(h); // same value ⇒ React bails out: a bloc flooding reports costs one comparison each
      setReported(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [key, onEscape, onHover]);

  useEffect(() => {
    if (!doc || reported) return;
    const t = window.setTimeout(onFail, NO_REPORT_MS);
    return () => window.clearTimeout(t);
  }, [doc, reported, onFail]);

  return (
    <div className="av-bloc-live" ref={hostRef}>
      {doc ? (
        <iframe
          ref={frameRef}
          className="av-bloc-frame"
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          scrolling="no"
          tabIndex={tabbable ? undefined : -1}
          srcDoc={doc}
          style={{ height }}
        />
      ) : null}
    </div>
  );
}

/** The enlarged bloc: a modal over the conversation pane. Escape / the close control / the backdrop dismiss it. */
function BlocOverlay({ title, source, anchor, onClose }: { title: string; source: string; anchor: React.RefObject<HTMLElement | null>; onClose: () => void }) {
  const closeRef = useRef<HTMLButtonElement>(null);
  const bodyRef = useRef<HTMLDivElement>(null);
  const [failed, setFailed] = useState(false);
  const fail = useCallback(() => setFailed(true), []);
  const [mount, setMount] = useState<Element | null>(null);

  // Portal into the pane (`.av-view`): its tokens apply there, and a message row's `contain: layout` would trap a fixed overlay.
  useLayoutEffect(() => { setMount(anchor.current?.closest('.av-view') ?? document.body); }, [anchor]);
  useEffect(() => { if (mount) closeRef.current?.focus(); }, [mount]);
  useEffect(() => {
    // Capture + stop: Escape here must not also reach the composer's interrupt / a surrounding dialog.
    const onKey = (e: KeyboardEvent) => {
      if (!anchor.current?.closest('.av-view.active')) return; // another workspace's pane is showing: its Escape is not ours
      if (e.key === 'Escape') { e.preventDefault(); e.stopPropagation(); onClose(); }
    };
    window.addEventListener('keydown', onKey, true);
    return () => window.removeEventListener('keydown', onKey, true);
  }, [onClose, anchor]);

  // A modal over the pane must not outlive it: close when the pane stops being the active one or a NEW AskUserQuestion (docked over the composer) arrives — one already pending may be read, enlarged over, then answered.
  useEffect(() => {
    if (!(mount instanceof HTMLElement) || !mount.classList.contains('av-view')) return;
    const pending = mount.querySelector('.av-q');
    const check = () => { const q = mount.querySelector('.av-q'); if (!mount.classList.contains('active') || (q && q !== pending)) onClose(); };
    const mo = new MutationObserver(check);
    mo.observe(mount, { attributes: true, attributeFilter: ['class'], childList: true, subtree: true });
    check();
    return () => mo.disconnect();
  }, [mount, onClose]);

  if (!mount) return null;
  const toEdge = (to: 'close' | 'body') => () => (to === 'close' ? closeRef.current : bodyRef.current?.querySelector<HTMLElement>('iframe, button') ?? closeRef.current)?.focus();
  return createPortal(
    <div className="av-bloc-overlay" role="presentation" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      {/* Focus ring: a sentinel on each side keeps Tab inside the dialog. */}
      <span tabIndex={0} onFocus={toEdge('body')} />
      <div className="av-bloc-overlay-box" role="dialog" aria-modal="true" aria-label={title}>
        <div className="av-bloc-overlay-head">
          <b>{title}</b>
          <button ref={closeRef} type="button" className="av-bloc-btn" aria-label={`Fermer (Échap) : ${title}`} onClick={onClose}>Fermer (Échap)</button>
        </div>
        <div className="av-bloc-overlay-body" ref={bodyRef}>
          {failed ? <SourceCode source={source} /> : <BlocLive title={title} source={source} mode="enlarged" onEscape={onClose} onFail={fail} />}
        </div>
      </div>
      <span tabIndex={0} onFocus={toEdge('close')} />
    </div>,
    mount,
  );
}

/**
 * A Bloc HTML in the flow (#415 frame, #417 chrome). Variant A: no chrome; on hover / keyboard focus two quiet actions (source, enlarge);
 * taller than {@link BLOC_CLIP_PX} ⇒ clipped with a fade behind « Afficher tout ». Only ONE live frame exists per bloc:
 * showing the source or the enlarged view unmounts the inline one (it remounts, scripts restarting, on the way back).
 */
export function BlocFrame({ title, source }: Props) {
  const [failed, setFailed] = useState(false);
  const [showSource, setShowSource] = useState(false);
  const [enlarged, setEnlarged] = useState(false);
  const [expanded, setExpanded] = useState(false);
  const [hover, setHover] = useState(false);
  const [height, setHeight] = useState(() => lastHeight.get(heightKey('inline', source)) ?? INITIAL_HEIGHT_PX);
  const rootRef = useRef<HTMLDivElement>(null);
  const enlargeRef = useRef<HTMLButtonElement>(null);
  const wasEnlarged = useRef(false);
  const fail = useCallback(() => setFailed(true), []);

  // The bloc is the thing that got focus before the overlay opened: hand it back on close.
  useEffect(() => {
    if (wasEnlarged.current && !enlarged) enlargeRef.current?.focus();
    wasEnlarged.current = enlarged;
  }, [enlarged]);
  const closeOverlay = useCallback(() => setEnlarged(false), []);
  useEffect(() => { if (enlarged || showSource) setHover(false); }, [enlarged, showSource]); // the frame that reported it is gone

  if (failed) return <SourceCode source={source} />;
  const tall = height > BLOC_CLIP_PX;
  const clipped = tall && !expanded && !showSource;
  return (
    <div className={`av-bloc${showSource ? ' is-source' : ''}${hover ? ' is-hover' : ''}`} ref={rootRef}>
      <div className="av-bloc-tools">
        <button type="button" className="av-bloc-btn" aria-label={`${showSource ? 'Rendu' : 'Afficher le source'} : ${title}`} title={showSource ? 'Revenir au rendu' : 'Afficher le source'} onClick={() => setShowSource((v) => !v)}>
          {showSource ? 'Rendu' : '</>'}
        </button>
        <button type="button" className="av-bloc-btn" ref={enlargeRef} aria-haspopup="dialog" aria-label={`Agrandir : ${title}`} title="Agrandir" onClick={() => setEnlarged(true)}>⤢</button>
      </div>
      {showSource ? (
        <SourceCode source={source} />
      ) : (
        <>
          <div className={`av-bloc-clip${clipped ? ' is-clipped' : ''}`} style={clipped ? { height: BLOC_CLIP_PX } : undefined}>
            {enlarged ? <div style={{ height }} aria-hidden /> : <BlocLive title={title} source={source} mode="inline" onHeight={setHeight} onHover={setHover} onFail={fail} tabbable={!clipped} />}
          </div>
          {tall ? (
            <button type="button" className={`av-bloc-more${clipped ? ' is-floating' : ''}`} aria-expanded={!clipped} aria-label={`${clipped ? 'Afficher tout' : 'Réduire'} : ${title}`} onClick={() => setExpanded((v) => !v)}>
              {clipped ? 'Afficher tout' : 'Réduire'}
            </button>
          ) : null}
        </>
      )}
      {enlarged ? <BlocOverlay title={title} source={source} anchor={rootRef} onClose={closeOverlay} /> : null}
    </div>
  );
}

/** The placeholder shown while the fence is still being written: no frame, no source. */
export function BlocPending({ title }: { title: string }) {
  return (
    <div className="av-bloc-pending" role="status">
      <span className="av-bloc-pending-dot" aria-hidden />
      <span>{title}</span>
    </div>
  );
}
