// Light/dark selector for the structured agent view's code surfaces.
//
// Dark is the unconditional default, exactly like agent-view-theme.css: the OS
// preference is NOT consulted (the app chrome is dark-only). Light applies only
// when something sets `data-agent-theme="light"` (the settings toggle's hook).
//
// This used to live in monaco-theme.ts alongside the Monaco theme registration;
// Monaco has been removed from the app (the SDK view's diffs are now plain
// summaries and there is no Diff tab), so all that remains is this dependency-
// free hook that CodeBlock uses to pick a Shiki theme.

import { useSyncExternalStore } from 'react';

export type AgentTheme = 'dark' | 'light';

export function currentAgentTheme(): AgentTheme {
  try {
    return document.querySelector('[data-agent-theme="light"]') ? 'light' : 'dark';
  } catch {
    return 'dark';
  }
}

/** Live theme name that follows the explicit `data-agent-theme` attribute. */
export function useAgentTheme(): AgentTheme {
  return useSyncExternalStore(subscribeToAgentTheme, currentAgentTheme, () => 'dark');
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
