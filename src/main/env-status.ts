// Reports optional-setup status to the renderer, so the app can show a small
// notice when an integration isn't configured (rather than failing silently).
//
// Each entry is self-describing — add a check here and the sidebar renders it
// with zero renderer changes. Keep checks cheap and synchronous: this runs on
// app load and on a slow poll, and must never block.

import type { EnvStatusItem } from '../shared/types';
import { linearApiKeyPresent } from './linear';

/** Snapshot every optional-setup check. Items with `ok: false` surface as a
 *  notice in the UI; `ok: true` items are reported too (a future settings panel
 *  could show the full list), but the sidebar only nags about the false ones. */
export function getEnvStatus(): EnvStatusItem[] {
  return [
    {
      id: 'linear',
      label: 'Linear',
      ok: linearApiKeyPresent(),
      detail:
        'Linear issue badges are off. Set LINEAR_API_KEY to a Linear personal ' +
        'API key (this is separate from the Linear MCP login). On Linux/macOS a ' +
        'GUI launch may not inherit your shell — export it where the app starts ' +
        '(e.g. your login profile or the .desktop entry).',
      docsUrl: 'https://linear.app/settings/account/security',
    },
  ];
}
