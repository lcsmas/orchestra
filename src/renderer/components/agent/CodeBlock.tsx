import React, { useMemo, useState, useEffect } from 'react';
import type { HighlighterCore } from 'shiki/core';
import { useAgentTheme } from './agent-theme';
import {
  getHighlighter,
  highlighterReady,
  shikiLang,
  SHIKI_DARK,
  SHIKI_LIGHT,
} from './shiki-highlighter';

interface Props {
  code: string;
  lang: string;
  /** Show a header strip with the language + copy button. Default true. */
  chrome?: boolean;
  /** Whether the surrounding message has finished streaming. While false we
   *  render plain mono (no highlight) — re-highlighting a block on every RAF
   *  token delta would jank long outputs; we highlight once the block settles. */
  done?: boolean;
}

/**
 * A read-only syntax-highlighted code block, highlighted with **Shiki** (the
 * same highlighter family the Claude Code desktop app uses) instead of a full
 * Monaco editor. Shiki is far lighter on this hot path: it produces static
 * highlighted HTML (no editor instance, no layout, no focus/scroll surface).
 *
 * Streaming discipline: while the message is still streaming (`done === false`)
 * — or before the highlighter's WASM/grammars finish loading — we render plain
 * monospace text and upgrade to highlighted HTML once the block is finalized and
 * the highlighter is ready. This keeps the token-delta re-render cheap.
 *
 * Memoized so a token delta on the surrounding message doesn't re-highlight.
 */
function CodeBlockImpl({ code, lang, chrome = true, done = true }: Props) {
  const theme = useAgentTheme(); // 'dark' | 'light'
  const shikiTheme = theme === 'light' ? SHIKI_LIGHT : SHIKI_DARK;
  const language = useMemo(() => shikiLang(lang), [lang]);
  const [copied, setCopied] = useState(false);

  // Highlighted HTML, computed only when the block is finalized. `null` → render
  // the plain-mono fallback (streaming, not-yet-loaded, or an unhighlightable
  // block). A tick re-render is triggered when the async highlighter becomes
  // ready, so a block finalized before load still upgrades.
  const [ready, setReady] = useState(highlighterReady());
  useEffect(() => {
    if (ready) return;
    let alive = true;
    void getHighlighter().then(() => {
      if (alive) setReady(true);
    });
    return () => {
      alive = false;
    };
  }, [ready]);

  const html = useMemo(() => {
    // Highlight only a finalized block, and only once the highlighter's grammars
    // + themes have loaded (ready). Otherwise fall back to plain mono.
    if (!done || !ready) return null;
    return highlightSync(code, language, shikiTheme);
  }, [code, language, shikiTheme, done, ready]);

  return (
    <div className="av-code-block">
      {chrome && (
        <div className="av-code-head">
          <span className="av-code-lang">{lang || language}</span>
          <button
            className={`av-code-copy ${copied ? 'av-code-copied' : ''}`}
            title="Copy code"
            onClick={() => {
              void navigator.clipboard?.writeText(code);
              setCopied(true);
              window.setTimeout(() => setCopied(false), 1200);
            }}
          >
            {copied ? 'Copied' : 'Copy'}
          </button>
        </div>
      )}
      {html ? (
        <div
          className="av-code-shiki"
          // Shiki output is a self-contained <pre><code> with inline styles from
          // a trusted, bundled highlighter over the model's code text (escaped by
          // Shiki). No user HTML is interpreted — the input is treated as source.
          dangerouslySetInnerHTML={{ __html: html }}
        />
      ) : (
        <pre className="av-code-plain">
          <code>{code}</code>
        </pre>
      )}
    </div>
  );
}

/** Synchronous highlight using the already-loaded singleton. Safe to call only
 *  when {@link highlighterReady} is true (the highlighter's `codeToHtml` is sync
 *  once grammars/themes are loaded). Falls back to null on any error. */
function highlightSync(code: string, lang: string, theme: string): string | null {
  const hl = resolvedHighlighter;
  if (!hl) return null;
  return hl.codeToHtml(code, { lang, theme });
}

// Cache the resolved highlighter instance so highlightSync stays synchronous.
let resolvedHighlighter: HighlighterCore | null = null;
void getHighlighter().then((hl) => {
  resolvedHighlighter = hl;
});

export const CodeBlock = React.memo(CodeBlockImpl);
