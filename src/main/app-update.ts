// « Nouvelle version installée » — the MONITOR (Electron-free): re-reads the installed file's identity + its version sidecar on every
// directory event (and a slow poll) and pushes the state only when it changes. Host binding: app-update-host.ts.
import { appUpdateStateKey, decideAppUpdate, APP_UPDATE_NONE, type AppUpdateState, type InstalledIdentity } from '../shared/app-update.ts';

export interface AppUpdateMonitorDeps {
  /** The installed app this process came from ('' = not an AppImage: never shows anything). */
  path: string;
  stat(p: string): InstalledIdentity | null;
  read(p: string): string | null;
  push(state: AppUpdateState): void;
  info?(msg: string): void;
}

export interface AppUpdateMonitor {
  check(): void;
  current(): AppUpdateState;
}

export function createAppUpdateMonitor(deps: AppUpdateMonitorDeps): AppUpdateMonitor {
  const boot = deps.path ? deps.stat(deps.path) : null;
  let state: AppUpdateState = APP_UPDATE_NONE;
  return {
    check() {
      if (!boot) return;
      const next = decideAppUpdate(boot, deps.stat(deps.path), deps.read(`${deps.path}.version`));
      // a missing file (mid-swap) is not « no update »: keep what was shown until the new file is there
      if (next.kind === 'none' && state.kind === 'installed' && !deps.stat(deps.path)) return;
      if (appUpdateStateKey(next) === appUpdateStateKey(state)) return;
      state = next;
      if (state.kind === 'installed') deps.info?.(`installed app replaced on disk (${state.version ?? 'version unknown'}) — a relaunch picks it up`);
      deps.push(state);
    },
    current: () => state,
  };
}
