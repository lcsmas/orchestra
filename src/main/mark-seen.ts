// The human looked at a workspace — on the desktop or through the Accès mobile (#337, CONTEXT.md « Non lu »): clears the bell and
// resolves an en attente workspace to idle. ONE definition for both surfaces (was inline in api-handlers.ts).

import { platform } from './platform';
import { store } from './store';
import type { Workspace } from '../shared/types';

export async function markWorkspaceSeen(id: string): Promise<void> {
  const ws = store.getWorkspace(id);
  if (!ws || ws.archived) return;
  const nextStatus = ws.status === 'waiting' ? 'idle' : ws.status;
  if (nextStatus === ws.status && !ws.autoUnread) return;
  // Explicit `undefined`, not a dropped key: `workspace:update` is merged
  // into the renderer store, so omitting it would leave the bell on screen.
  const updated: Workspace = { ...ws, status: nextStatus, autoUnread: undefined };
  await store.upsertWorkspace(updated);
  platform.broadcast('workspace:update', updated);
}
