// Lazy singleton Shiki highlighter for the structured agent view's code blocks.
//
// Why lazy + singleton: the agent view streams token-by-token and re-renders on
// every RAF flush. A highlighter must NOT be created per code block per frame —
// loading grammars is expensive. We create ONE highlighter, load a curated set
// of common languages + both themes up front, and reuse it. Highlighting itself
// (`codeToHtml`) is synchronous once loaded, so callers highlight only FINALIZED
// blocks (a streaming block shows plain mono until it closes) — see CodeBlock.
//
// Bundle discipline: we use Shiki's FINE-GRAINED core API (`createHighlighterCore`)
// with EXPLICIT per-language / per-theme imports and the pure-JS regex engine,
// NOT the convenience `createHighlighter` from 'shiki' — that one pulls Shiki's
// entire language registry as async chunks (asciidoc, wolfram, emacs-lisp, a
// 600 KB WASM…), balloooning the renderer bundle. The explicit-import form ships
// only the ~30 grammars below + the JS engine (no oniguruma WASM).

import type { HighlighterCore } from 'shiki/core';

// The id set the highlighter loads (used by `shikiLang` to gate fence tags).
const LANG_IDS = [
  'typescript', 'javascript', 'tsx', 'jsx', 'json', 'python', 'rust', 'go',
  'java', 'c', 'cpp', 'csharp', 'bash', 'yaml', 'toml', 'html', 'css', 'scss',
  'sql', 'markdown', 'diff', 'dockerfile', 'ruby', 'php', 'lua', 'xml', 'ini',
];

export const SHIKI_DARK = 'github-dark';
export const SHIKI_LIGHT = 'github-light';

let highlighterPromise: Promise<HighlighterCore> | null = null;

/** Get (or lazily create) the shared highlighter. First call DYNAMICALLY imports
 *  Shiki's core + engine + ONLY the curated grammars/themes below, so none of it
 *  lands in the main renderer chunk — it splits into async chunks fetched the
 *  first time a code block actually highlights (post-startup). Uses the
 *  fine-grained `createHighlighterCore` (NOT `shiki`'s `createHighlighter`, which
 *  pulls the entire language registry) and the pure-JS regex engine (no
 *  oniguruma WASM). Subsequent calls resolve from cache. */
export function getHighlighter(): Promise<HighlighterCore> {
  if (!highlighterPromise) {
    highlighterPromise = (async () => {
      const [{ createHighlighterCore }, { createJavaScriptRegexEngine }] = await Promise.all([
        import('shiki/core'),
        import('shiki/engine/javascript'),
      ]);
      // Curated grammars — dynamically imported so they code-split out of the
      // main bundle. Fence tags map to these via `shikiLang`; unknown tags fall
      // back to 'text' (an unhighlighted pre/code).
      const langs = await Promise.all([
        import('shiki/langs/typescript.mjs'), import('shiki/langs/javascript.mjs'),
        import('shiki/langs/tsx.mjs'), import('shiki/langs/jsx.mjs'),
        import('shiki/langs/json.mjs'), import('shiki/langs/python.mjs'),
        import('shiki/langs/rust.mjs'), import('shiki/langs/go.mjs'),
        import('shiki/langs/java.mjs'), import('shiki/langs/c.mjs'),
        import('shiki/langs/cpp.mjs'), import('shiki/langs/csharp.mjs'),
        import('shiki/langs/bash.mjs'), import('shiki/langs/yaml.mjs'),
        import('shiki/langs/toml.mjs'), import('shiki/langs/html.mjs'),
        import('shiki/langs/css.mjs'), import('shiki/langs/scss.mjs'),
        import('shiki/langs/sql.mjs'), import('shiki/langs/markdown.mjs'),
        import('shiki/langs/diff.mjs'), import('shiki/langs/docker.mjs'),
        import('shiki/langs/ruby.mjs'), import('shiki/langs/php.mjs'),
        import('shiki/langs/lua.mjs'), import('shiki/langs/xml.mjs'),
        import('shiki/langs/ini.mjs'),
      ]);
      const [githubDark, githubLight] = await Promise.all([
        import('shiki/themes/github-dark.mjs'),
        import('shiki/themes/github-light.mjs'),
      ]);
      return createHighlighterCore({
        themes: [githubDark.default, githubLight.default],
        langs: langs.map((m) => m.default),
        engine: createJavaScriptRegexEngine(),
      });
    })();
  }
  return highlighterPromise;
}

let ready = false;
/** True once the highlighter has finished loading — lets a caller render plain
 *  text on the first frame and upgrade to highlighted output once ready. */
export function highlighterReady(): boolean {
  return ready;
}
void getHighlighter().then(() => {
  ready = true;
});

/** Normalize an arbitrary fence tag to a language id the highlighter loaded.
 *  Unknown/absent tags become 'text' (Shiki renders an unhighlighted block). */
export function shikiLang(tag: string | undefined): string {
  if (!tag) return 'text';
  const t = tag.toLowerCase();
  const alias: Record<string, string> = {
    ts: 'typescript', js: 'javascript', py: 'python', rs: 'rust',
    sh: 'bash', zsh: 'bash', shell: 'bash', 'c++': 'cpp', 'c#': 'csharp',
    yml: 'yaml', md: 'markdown', htm: 'html', rb: 'ruby', docker: 'dockerfile',
  };
  const id = alias[t] ?? t;
  return LANG_IDS.includes(id) ? id : 'text';
}
