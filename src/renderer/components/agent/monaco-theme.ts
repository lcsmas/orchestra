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

/** Tomorrow Night syntax ink over Orchestra's cool sunken surface, so a diff,
 *  a code block and the embedded terminal read as one instrument matching the
 *  app chrome (the transcript surfaces are Orchestra dark, not CC warm). */
const DARK = {
  bg: '#12151a', // --av-surface-sunken (--bg-2)
  fg: '#d3dae4',
  lineNo: '#414b5c',
  selection: '#334155',
  comment: '#5d6b80',
  string: '#b5bd68', // TN green
  number: '#f0c674', // TN yellow
  keyword: '#b294bb', // TN magenta
  fn: '#81a2be', // TN blue
  type: '#e7c547', // TN bright yellow
  tag: '#cc6666', // TN red
  cyan: '#8abeb7', // TN cyan
  add: '#5bd68b',
  remove: '#ff6b6b',
};

const LIGHT = {
  bg: '#eef1f4', // --av-surface-sunken (cool light)
  fg: '#1f2735',
  lineNo: '#9aa4b2',
  selection: '#cfe0fb',
  comment: '#8a93a2',
  string: '#22733f',
  number: '#a05e03',
  keyword: '#8a5fa8',
  fn: '#2159c8',
  type: '#8f6400',
  tag: '#c62828',
  cyan: '#0e7490',
  add: '#12703f',
  remove: '#c62828',
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
    'editorCursor.foreground': '#6ea8ff',
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
