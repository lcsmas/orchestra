// Reports optional-setup status to the renderer, so the app can show a small
// notice when an integration isn't configured (rather than failing silently).
//
// Each entry is self-describing — add a check here and the sidebar renders it
// with zero renderer changes.

import type { EnvStatusItem } from '../shared/types';
import { getLinearKeySource } from './linear';

/** Snapshot every optional-setup check. Items with `ok: false` surface as a
 *  notice in the UI; `ok: true` items are reported too, but the sidebar only
 *  nags about the false ones. */
export async function getEnvStatus(): Promise<EnvStatusItem[]> {
  const linearSource = await getLinearKeySource();
  return [
    {
      id: 'linear',
      label: 'Linear',
      ok: linearSource !== 'none',
      detail:
        'Linear issue badges are off. Add a Linear personal API key in ' +
        'Orchestra’s Linear settings (or set the LINEAR_API_KEY env var). ' +
        'This is separate from the Linear MCP login.',
      docsUrl: 'https://linear.app/settings/account/security',
    },
  ];
}
