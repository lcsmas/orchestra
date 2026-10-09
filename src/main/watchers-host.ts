// #330 (wave H, ledger #329) — the Electron-bound half of the watcher registry (src/main/watchers.ts stays electron-free so a rig can import it): the PULL channel for the initial paint / a reload and nothing else — the push
// (`watchers:update`, edge-triggered) is wired by `pushWatchersToRenderer()`. Registered ONCE at module scope from index.ts (a second registration THROWS on darwin).
import { ipcMain } from 'electron';
import { watchersStatus } from './watchers';
import type { WatchersStatus } from '../shared/watcher-status';

export const WATCHERS_PULL_CHANNEL = 'watchers:status';

export function registerWatchersIpc(): void {
  ipcMain.handle(WATCHERS_PULL_CHANNEL, (): WatchersStatus => watchersStatus());
}
