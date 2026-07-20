import type { ITheme } from '@xterm/xterm';

// Shared xterm.js theme for Terminal.tsx and RunTerminal.tsx.
//
// background/foreground/cursor/selection match the app chrome. The 16 ANSI
// colors are Ghostty's default palette (Tomorrow Night; ghostty-org/ghostty
// src/terminal/color.zig `Name.default()`) — without an explicit palette
// xterm.js falls back to the legacy VGA-ish scheme, which is why Claude's TUI
// looked harsher in-app than in a native Ghostty window.
export const TERM_THEME: ITheme = {
  background: '#1a1f26',
  foreground: '#e6e9ef',
  cursor: '#6ea8ff',
  selectionBackground: '#334155',
  black: '#1d1f21',
  red: '#cc6666',
  green: '#b5bd68',
  yellow: '#f0c674',
  blue: '#81a2be',
  magenta: '#b294bb',
  cyan: '#8abeb7',
  white: '#c5c8c6',
  brightBlack: '#666666',
  brightRed: '#d54e53',
  brightGreen: '#b9ca4a',
  brightYellow: '#e7c547',
  brightBlue: '#7aa6da',
  brightMagenta: '#c397d8',
  brightCyan: '#70c0b1',
  brightWhite: '#eaeaea',
};
