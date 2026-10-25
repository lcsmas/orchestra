// Profils navigateur (#400) — the IPC surface. Electron-free (the `ipcMain` is injected) so the guard is testable. The
// ONLY way to create / rename / delete / attach / switch a profile: a channel here, whose write handlers refuse any
// sender that is not the app's own window (isHumanProfileCaller). There is no CLI verb, no socket route and no
// agent tool for it — browser-profiles-wiring.test.ts pins both halves, and these channels are deliberately NOT in the
// generic api-handlers table (a write must not be reachable as a "served read", same split as pause-ui-host.ts).
import type { BrowserProfileResult } from '../shared/types';
import { isHumanProfileCaller } from '../shared/browser-profile.ts';
import type { BrowserProfilesService } from './browser-profiles.ts';

export const BROWSER_PROFILE_IPC_CHANNELS: ReadonlyArray<{ channel: string; writes: boolean; what: string }> = [
  { channel: 'browserProfiles:list', writes: false, what: 'the profiles on record' },
  { channel: 'browserProfiles:create', writes: true, what: 'create a profile' },
  { channel: 'browserProfiles:rename', writes: true, what: 'rename a profile' },
  { channel: 'browserProfiles:delete', writes: true, what: 'delete a profile (detach, reload ephemeral, clear storage)' },
  { channel: 'browser:profileAttach', writes: true, what: 'attach / switch / detach a workspace’s profile' },
];

/** The slice of Electron's `IpcMainInvokeEvent` the guard reads. */
export interface ProfileIpcEvent {
  sender: { id: number; mainFrame?: unknown };
  senderFrame?: unknown | null;
}

export interface ProfileIpcLog {
  warn(msg: string): void;
  error(msg: string, err?: unknown): void;
}

export function registerBrowserProfilesIpc(deps: {
  ipc: { handle(channel: string, fn: (e: ProfileIpcEvent, ...args: any[]) => unknown): void };
  /** `webContents.id` of the app's main window, or null while there is none. */
  getMainWebContentsId: () => number | null;
  service: BrowserProfilesService;
  log: ProfileIpcLog;
}): void {
  const { ipc, service, log } = deps;

  /** null = the caller is the human's own window; else the refusal to hand back. Fail closed on unknown frames. */
  const guard = (channel: string, e: ProfileIpcEvent): BrowserProfileResult | null => {
    const fromMainFrame = e.senderFrame != null && e.senderFrame === e.sender?.mainFrame;
    if (isHumanProfileCaller({ senderId: e.sender?.id, mainId: deps.getMainWebContentsId(), senderIsMainFrame: fromMainFrame })) {
      return null;
    }
    log.warn(`browser-profiles: ${channel} refused — sender ${e.sender?.id ?? '?'} is not the app window`);
    return {
      ok: false,
      reason: 'not-human',
      message: 'Browser profiles can only be changed from the Orchestra window.',
      profiles: service.list(),
    };
  };

  /** An unexpected failure becomes a refusal the UI can show — never a rejected invoke. */
  const run = async (channel: string, fn: () => Promise<BrowserProfileResult>): Promise<BrowserProfileResult> => {
    try {
      return await fn();
    } catch (e) {
      log.error(`browser-profiles: ${channel} failed`, e);
      return { ok: false, reason: 'failed', message: e instanceof Error ? e.message : String(e), profiles: service.list() };
    }
  };

  ipc.handle('browserProfiles:list', () => service.list());
  ipc.handle('browserProfiles:create', (e, name: unknown) =>
    guard('browserProfiles:create', e) ?? run('browserProfiles:create', () => service.create(name)),
  );
  ipc.handle('browserProfiles:rename', (e, id: unknown, name: unknown) =>
    guard('browserProfiles:rename', e) ?? run('browserProfiles:rename', () => service.rename(id, name)),
  );
  ipc.handle('browserProfiles:delete', (e, id: unknown) =>
    guard('browserProfiles:delete', e) ?? run('browserProfiles:delete', () => service.remove(id)),
  );
  ipc.handle('browser:profileAttach', (e, wsId: unknown, profileId: unknown) =>
    guard('browser:profileAttach', e) ?? run('browser:profileAttach', () => service.attach(wsId, profileId)),
  );
}
