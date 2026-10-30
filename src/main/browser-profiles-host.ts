// Profils navigateur (#400) — the Electron wiring: the store (profile list + each workspace's recorded profile), the
// session partitions (clearing a deleted profile's storage), the panel (rebuild on the new identity) and the IPC.
// Called ONCE from index.ts at module scope. The rules live in shared/browser-profile.ts, the orchestration in
// browser-profiles.ts, the sender guard in browser-profiles-ipc.ts.
import { ipcMain, session } from 'electron';
import { randomBytes } from 'node:crypto';
import { effectiveProfileId, ephemeralPartition, profilePartition } from '../shared/browser-profile.ts';
import { reprofilePanel, settleClosedViews, setBrowserProfileResolver, stopSignInPersistence, workspacesOnProfile } from './browser-panel';
import { createBrowserProfilesService } from './browser-profiles.ts';
import { registerBrowserProfilesIpc, type ProfileIpcEvent } from './browser-profiles-ipc.ts';
import { readOwnCookieFuse } from './cookie-fuse-state.ts';
import { log } from './logger';
import { platform } from './platform';
import { store } from './store';
import { setDeletingProfilesProbe } from './spawn-profile-gate.ts';

export function initBrowserProfiles(getMainWebContentsId: () => number | null): void {
  // A panel's identity comes from the workspace RECORD: a profile deleted since (dangling id) reads as ephemeral.
  setBrowserProfileResolver((wsId) => effectiveProfileId(store.getWorkspace(wsId)?.browserProfileId, store.getBrowserProfiles()));

  const service = createBrowserProfilesService({
    getProfiles: () => store.getBrowserProfiles(),
    setProfiles: (next) => store.setBrowserProfiles(next),
    workspaces: () => store.workspaces,
    setWorkspaceProfile: async (wsId, profileId) => {
      const ws = store.getWorkspace(wsId);
      if (!ws) return;
      // `undefined`, not a deleted key: the renderer MERGES a workspace:update (`{...old, ...w}`), so an absent key would keep the old id there.
      // JSON persistence drops the undefined, so store.json is clean either way.
      const updated = { ...ws, browserProfileId: profileId };
      await store.upsertWorkspace(updated);
      platform.broadcast('workspace:update', updated);
    },
    reprofilePanel,
    clearEphemeral: async (wsId) => {
      const ses = session.fromPartition(ephemeralPartition(wsId));
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
    },
    openPanelsOn: workspacesOnProfile,
    settleViews: () => settleClosedViews(3000),
    stopSignIns: (profileId) => stopSignInPersistence(profilePartition(profileId)),
    clearStorage: async (profileId) => {
      const ses = session.fromPartition(profilePartition(profileId));
      await ses.clearStorageData();
      await ses.clearCache();
      await ses.clearAuthCache();
      ses.flushStorageData();
      await ses.cookies.flushStore();
    },
    mintId: () => `bp-${randomBytes(6).toString('hex')}`,
    now: () => Date.now(),
  });

  // #401: an agent spawn hands its profile on only when that profile is not being deleted (the service knows; workspaces.ts asks through this probe).
  setDeletingProfilesProbe(() => service.deleting());

  registerBrowserProfilesIpc({
    ipc: { handle: (channel, fn) => ipcMain.handle(channel, (e, ...args) => fn(e as unknown as ProfileIpcEvent, ...args)) },
    getMainWebContentsId,
    service,
    readCookieFuse: () => readOwnCookieFuse(),
    log: { warn: (m) => log.warn(m), error: (m, e) => log.error(m, e) },
  });
}
