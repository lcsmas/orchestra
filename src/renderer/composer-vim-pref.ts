// Whether the structured view's composer uses VIM KEYBINDINGS. A renderer-side
// UI preference persisted in localStorage, mirroring `default-agent-view.ts`
// (pure + dependency-free, so it is node-testable and readable from both the
// composer and a settings surface).
//
// Defaults to ENABLED: the composer is a CodeMirror editor and vim is the
// intended editing model for it. Users who don't want modal editing turn it off
// with the mode chip in the composer bar, which persists 'off'.
//
// NOTE on the starting mode: `vim()` initialises in NORMAL, which is wrong for a
// chat composer — typing "hello" would run h/e/l/l/o as COMMANDS (measured: the
// document ended up as a bare newline, with the user's keystrokes swallowed).
// The composer therefore enters INSERT on mount; see `enterInsertMode` in
// CmComposer.tsx. Esc still takes you to NORMAL.

export type ComposerVimPref = 'on' | 'off';

export const COMPOSER_VIM_KEY = 'orchestra:composerVim';

/** Read the persisted preference. Defaults to 'on'. `storage` is injectable for
 *  tests; defaults to window.localStorage when present. */
export function readComposerVim(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): ComposerVimPref {
  const raw = storage?.getItem(COMPOSER_VIM_KEY);
  return raw === 'off' ? 'off' : 'on';
}

/** Persist the preference. No-op if localStorage is unavailable. */
export function writeComposerVim(
  value: ComposerVimPref,
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  storage?.setItem(COMPOSER_VIM_KEY, value);
}

/** The vim editing mode the composer is currently in, or null when vim is off.
 *  Drives the composer-bar chip's label and accent. */
export type VimMode = 'insert' | 'normal' | 'visual';

/** Label for the composer-bar chip: the mode readout when vim is on (so the
 *  chip doubles as the indicator), a quiet affordance when off.
 *
 *  The classic dashed vim form (`-- NORMAL --`) on purpose — it is what the
 *  status line in vim itself shows, so it reads as a mode indicator rather than
 *  as one more label. It measures ~96px, which the control row has room for
 *  (measured: ~84px of items in a 518px bar). */
export function vimChipLabel(mode: VimMode | null): string {
  return mode ? `-- ${mode.toUpperCase()} --` : 'vim';
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    // Accessing localStorage can throw in locked-down contexts.
    return undefined;
  }
}
