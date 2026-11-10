import React, { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { CodeBlock } from './CodeBlock';
import { useAgentTheme } from './agent-theme';
import { buildBlocDocument, BLOC_HEIGHT_TAG, BLOC_MAX_HEIGHT_PX, BLOC_THEME_KEYS, type BlocTokens } from '../../../shared/bloc-html-document';

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

/** A bloc keeps its last height across an unmount (virtualised list) so remounting does not jump the layout. */
const lastHeight = new Map<string, number>();
const heightKey = (source: string) => `${source.length}:${source.slice(0, 64)}:${source.slice(-64)}`;

/**
 * A Bloc HTML: the model's HTML in a sandboxed frame (scripts allowed, opaque origin), themed with the app tokens, sized to its content.
 * The parent accepts a height only from THIS frame's window and clamps it; any failure shows the source as code. (#415, ADR 0011)
 */
export function BlocFrame({ title, source }: Props) {
  const hostRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const theme = useAgentTheme();
  const [tokens, setTokens] = useState<BlocTokens | null>(null);
  const [height, setHeight] = useState(() => lastHeight.get(heightKey(source)) ?? INITIAL_HEIGHT_PX);
  const [reported, setReported] = useState(false);
  const [failed, setFailed] = useState(false);

  // Tokens exist only after layout, inside the mounted `.av-view`; a theme switch re-reads them.
  useLayoutEffect(() => { setTokens(readTokens(hostRef.current)); }, [theme]);

  const doc = useMemo(() => (tokens ? buildBlocDocument({ source, tokens }) : null), [source, tokens]);

  useEffect(() => {
    const onMessage = (e: MessageEvent) => {
      if (!frameRef.current || e.source !== frameRef.current.contentWindow) return;
      const d = e.data as Record<string, unknown> | null;
      if (!d || d[BLOC_HEIGHT_TAG] !== 1 || typeof d.h !== 'number' || !Number.isFinite(d.h)) return;
      const h = Math.max(0, Math.min(BLOC_MAX_HEIGHT_PX, Math.ceil(d.h)));
      lastHeight.set(heightKey(source), h);
      setHeight(h);
      setReported(true);
    };
    window.addEventListener('message', onMessage);
    return () => window.removeEventListener('message', onMessage);
  }, [source]);

  useEffect(() => {
    if (!doc || reported) return;
    const t = window.setTimeout(() => setFailed(true), NO_REPORT_MS);
    return () => window.clearTimeout(t);
  }, [doc, reported]);

  if (failed) return <CodeBlock code={source} lang="html" />;
  return (
    <div className="av-bloc" ref={hostRef}>
      {doc ? (
        <iframe
          ref={frameRef}
          className="av-bloc-frame"
          title={title}
          sandbox="allow-scripts"
          referrerPolicy="no-referrer"
          scrolling="no"
          srcDoc={doc}
          style={{ height }}
        />
      ) : null}
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
