// Orchestra Monaco themes for the structured agent view's code/diff surfaces.
//
// The stock `vs-dark` theme clashes with the app (its #1e1e1e background sits
// against Orchestra's #0d1015 sunken panels, and its syntax palette matches
// nothing else on screen). These themes reuse the terminal's Tomorrow Night
// ANSI palette (src/renderer/term-theme.ts) for syntax and the app's surface
// tokens for chrome, so a diff, a code block, and the embedded terminal all
// read as one instrument.
//
// Registered lazily via `beforeMount` on each editor (defineTheme is idempotent
// per monaco instance; the `registered` set guards repeat work). The smoke
// harness's monaco stub ignores `beforeMount`, so this stays smoke-safe.

import { useSyncExternalStore } from 'react';

// Minimal structural type for the monaco global `beforeMount` hands us — avoids
// importing monaco types (the editor package is bundled, but keeping this file
// dependency-light lets pure tooling import it without pulling Monaco).
interface MonacoLike {
  editor: {
    defineTheme: (name: string, theme: object) => void;
  };
}

/** Syntax ink tuned to Claude-Code's warm palette. Chrome sits on the agent
 *  view's warm sunken surface (#1f1e1d) so a diff, a code block (Shiki
 *  github-dark) and the terminal read as one warm instrument rather than a cool
 *  IDE dropped into cream chrome. */
const DARK = {
  bg: '#1f1e1d', // --av-surface-sunken (CC bg-200)
  fg: '#e6e3da', // warm off-white, matches --av-text-dim family
  lineNo: '#6b675d',
  selection: '#4a453d',
  comment: '#8c877a',
  string: '#a7c080', // warm green
  number: '#e0a458', // amber
  keyword: '#c98a6a', // clay-leaning magenta/orange
  fn: '#7fa8c9', // muted blue
  type: '#d9a441', // gold
  tag: '#d97757', // clay
  cyan: '#83c0b8', // teal
  add: '#6fbf5f',
  remove: '#e0685f',
};

const LIGHT = {
  bg: '#f0eee7', // --av-surface-sunken (warm cream)
  fg: '#29261b',
  lineNo: '#a8a498',
  selection: '#e4dcc8',
  comment: '#8f8b7d',
  string: '#3f7a34',
  number: '#a05e03',
  keyword: '#b8562f', // clay-leaning
  fn: '#2159c8',
  type: '#8f6400',
  tag: '#c15f3c',
  cyan: '#0e7490',
  add: '#3f8a2c',
  remove: '#c0392b',
};

function rules(c: typeof DARK) {
  return [
    { token: '', foreground: c.fg.slice(1) },
    { token: 'comment', foreground: c.comment.slice(1), fontStyle: 'italic' },
    { token: 'string', foreground: c.string.slice(1) },
    { token: 'string.escape', foreground: c.cyan.slice(1) },
    { token: 'number', foreground: c.number.slice(1) },
    { token: 'constant', foreground: c.number.slice(1) },
    { token: 'keyword', foreground: c.keyword.slice(1) },
    { token: 'operator', foreground: c.cyan.slice(1) },
    { token: 'delimiter', foreground: c.fg.slice(1) },
    { token: 'type', foreground: c.type.slice(1) },
    { token: 'type.identifier', foreground: c.type.slice(1) },
    { token: 'function', foreground: c.fn.slice(1) },
    { token: 'identifier.function', foreground: c.fn.slice(1) },
    { token: 'tag', foreground: c.tag.slice(1) },
    { token: 'attribute.name', foreground: c.number.slice(1) },
    { token: 'attribute.value', foreground: c.string.slice(1) },
    { token: 'variable', foreground: c.tag.slice(1) },
    { token: 'variable.predefined', foreground: c.cyan.slice(1) },
    { token: 'regexp', foreground: c.cyan.slice(1) },
  ];
}

function colors(c: typeof DARK) {
  return {
    'editor.background': c.bg,
    'editor.foreground': c.fg,
    'editorLineNumber.foreground': c.lineNo,
    'editorLineNumber.activeForeground': c.lineNo,
    'editor.selectionBackground': c.selection,
    'editor.inactiveSelectionBackground': c.selection,
    'editorCursor.foreground': '#d97757',
    'editorWidget.background': c.bg,
    'editorGutter.background': c.bg,
    'scrollbarSlider.background': '#7d879a33',
    'scrollbarSlider.hoverBackground': '#7d879a55',
    'scrollbarSlider.activeBackground': '#7d879a66',
    'editorOverviewRuler.border': '#00000000',
    'diffEditor.insertedTextBackground': `${c.add}2e`,
    'diffEditor.removedTextBackground': `${c.remove}2e`,
    'diffEditor.insertedLineBackground': `${c.add}14`,
    'diffEditor.removedLineBackground': `${c.remove}14`,
    'diffEditorGutter.insertedLineBackground': `${c.add}14`,
    'diffEditorGutter.removedLineBackground': `${c.remove}14`,
    'diffEditor.diagonalFill': '#7d879a1a',
  };
}

const registered = new WeakSet<object>();

/** Register both Orchestra themes on a monaco instance (idempotent). */
export function defineOrchestraThemes(monaco: unknown): void {
  const m = monaco as MonacoLike & object;
  if (!m?.editor?.defineTheme || registered.has(m)) return;
  registered.add(m);
  m.editor.defineTheme('orchestra-dark', {
    base: 'vs-dark',
    inherit: true,
    rules: rules(DARK),
    colors: colors(DARK),
  });
  m.editor.defineTheme('orchestra-light', {
    base: 'vs',
    inherit: true,
    rules: rules(LIGHT),
    colors: colors(LIGHT),
  });
}

/** Shared editor typography — matches --font-mono and the 18px row math the
 *  height estimates in CodeBlock/ToolDiff rely on. */
export const MONACO_FONT = {
  // CC's code stack — a system mono (claude.ai ships no custom mono face), so a
  // diff reads like the Shiki code blocks and the composer's mono input.
  fontFamily: 'ui-monospace, SFMono-Regular, "SF Mono", Menlo, Monaco, Consolas, "Liberation Mono", "JetBrains Mono", "Courier New", monospace',
  fontSize: 13,
  lineHeight: 20,
  fontLigatures: false,
} as const;

/** Dark is the unconditional default, exactly like agent-view-theme.css: the
 *  OS preference is NOT consulted (the app chrome is dark-only). Light applies
 *  only when something sets `data-agent-theme="light"` (the future settings
 *  toggle's hook). */
export function currentMonacoTheme(): 'orchestra-dark' | 'orchestra-light' {
  try {
    return document.querySelector('[data-agent-theme="light"]')
      ? 'orchestra-light'
      : 'orchestra-dark';
  } catch {
    return 'orchestra-dark';
  }
}

/** Live theme name that follows the explicit `data-agent-theme` attribute. */
export function useMonacoTheme(): 'orchestra-dark' | 'orchestra-light' {
  return useSyncExternalStore(subscribeToAgentTheme, currentMonacoTheme, () => 'orchestra-dark');
}

function subscribeToAgentTheme(onChange: () => void): () => void {
  try {
    const mo = new MutationObserver(onChange);
    mo.observe(document.documentElement, {
      attributes: true,
      subtree: true,
      attributeFilter: ['data-agent-theme'],
    });
    return () => mo.disconnect();
  } catch {
    return () => {};
  }
}
