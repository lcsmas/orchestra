// The user's preferred DEFAULT agent view — 'terminal' (the classic embedded
// Claude Code TUI) or 'structured' (the SDK-driven native pane). A renderer-side
// UI preference, persisted in localStorage exactly like the chime/theme prefs
// (chime.ts). Defaults to 'terminal' so existing users see no change until they
// opt in; the Settings toggle flips it.
//
// Phase 6 of the structured-agent-view rollout: when set to 'structured', a
// workspace opens on the Structured tab and the embedded terminal is demoted to
// a "Raw" fallback tab. Pure + dependency-free so it is node-testable and can be
// read from both the store's initial state and the Settings UI.

export type DefaultAgentView = 'terminal' | 'structured';

export const DEFAULT_AGENT_VIEW_KEY = 'orchestra:defaultAgentView';

/** Read the persisted preference. Returns 'terminal' when unset or invalid, so
 *  the classic view is always the safe fallback. `storage` is injectable for
 *  tests; defaults to window.localStorage when present. */
export function readDefaultAgentView(
  storage: Pick<Storage, 'getItem'> | undefined = safeLocalStorage(),
): DefaultAgentView {
  const raw = storage?.getItem(DEFAULT_AGENT_VIEW_KEY);
  return raw === 'structured' ? 'structured' : 'terminal';
}

/** Persist the preference. No-op if localStorage is unavailable. */
export function writeDefaultAgentView(
  value: DefaultAgentView,
  storage: Pick<Storage, 'setItem'> | undefined = safeLocalStorage(),
): void {
  storage?.setItem(DEFAULT_AGENT_VIEW_KEY, value);
}

/** The label the embedded-terminal tab should carry given the preference: it is
 *  "Terminal" normally, but "Raw" once the structured view is the default (it
 *  becomes the fallback rather than the primary surface). */
export function terminalTabLabel(pref: DefaultAgentView): string {
  return pref === 'structured' ? 'Raw' : 'Terminal';
}

function safeLocalStorage(): Pick<Storage, 'getItem' | 'setItem'> | undefined {
  try {
    return typeof localStorage !== 'undefined' ? localStorage : undefined;
  } catch {
    // Accessing localStorage can throw in locked-down contexts.
    return undefined;
  }
}
