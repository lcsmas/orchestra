// « Nouvelle version installée » — the HOST: watches the installed AppImage's directory (createWatcher, #330) + a 60 s poll, the
// `appUpdate:*` IPC, and the relaunch (wait for this process to exit, then exec the installed file — app.relaunch() would re-exec
// the OLD mounted binary). Logic: app-update.ts / shared/app-update.ts.
import { app, ipcMain } from 'electron';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { APPIMAGE_PATH } from './app-image';
import { platform } from './platform';
import { scoped } from './logger';
import { createWatcher } from './watchers';
import { createAppUpdateMonitor, type AppUpdateMonitor } from './app-update';
import { relaunchArgv, type AppUpdateState } from '../shared/app-update';

const log = scoped('app-update');
export const APP_UPDATE_PULL_CHANNEL = 'appUpdate:state';
export const APP_UPDATE_PUSH_CHANNEL = 'appUpdate:update';
export const APP_UPDATE_RELAUNCH_CHANNEL = 'appUpdate:relaunch';
const POLL_MS = 60_000;

/** The installed app to watch: the AppImage this process runs from. ORCHESTRA_INSTALLED_APP overrides it for the e2e rig (an
 *  unpackaged app has no AppImage); captured at module load like APPIMAGE_PATH, before the env is stripped. */
const INSTALLED_APP = process.env.ORCHESTRA_INSTALLED_APP || APPIMAGE_PATH;

let monitor: AppUpdateMonitor | null = null;
let stopWatch: (() => void) | null = null;

function statOf(p: string) {
  try {
    const st = fs.statSync(p);
    return st.isFile() ? { ino: st.ino, size: st.size, mtimeMs: st.mtimeMs } : null;
  } catch {
    return null;
  }
}
function readOf(p: string): string | null {
  try {
    return fs.readFileSync(p, 'utf8').slice(0, 200);
  } catch {
    return null;
  }
}

export function appUpdateState(): AppUpdateState {
  return monitor?.current() ?? { kind: 'none' };
}

export function startAppUpdate(): void {
  if (monitor || !INSTALLED_APP) return;
  monitor = createAppUpdateMonitor({
    path: INSTALLED_APP,
    stat: statOf,
    read: readOf,
    push: (s) => platform.broadcast(APP_UPDATE_PUSH_CHANNEL, s),
    info: (m) => log.info(m),
  });
  const base = path.basename(INSTALLED_APP);
  const m = monitor;
  const watcher = createWatcher({
    name: 'app-update',
    label: 'Nouvelle version',
    dir: path.dirname(INSTALLED_APP),
    fallback: 'a 60 s poll',
    fallbackFr: 'un contrôle toutes les 60 s',
    filter: (f) => !f || f === base || f === `${base}.version`,
    onChange: () => m.check(),
    onRecover: () => m.check(),
  });
  watcher.start();
  const poll = setInterval(() => m.check(), POLL_MS);
  poll.unref?.();
  stopWatch = () => {
    clearInterval(poll);
    watcher.stop();
  };
}

export function stopAppUpdate(): void {
  stopWatch?.();
  stopWatch = null;
}

/** Quit, then the installed app starts once this process is gone. Refused when nothing new is installed. */
export function relaunchInstalled(): { ok: boolean; error?: string } {
  if (!INSTALLED_APP || appUpdateState().kind !== 'installed') return { ok: false, error: 'no newer installed app' };
  try {
    spawn('/bin/sh', relaunchArgv(process.pid, INSTALLED_APP), { detached: true, stdio: 'ignore', env: process.env }).unref();
  } catch (e) {
    return { ok: false, error: e instanceof Error ? e.message : String(e) };
  }
  log.info(`relaunching into ${INSTALLED_APP}`);
  setImmediate(() => app.quit());
  return { ok: true };
}

/** Called ONCE at module scope from index.ts. */
export function registerAppUpdateIpc(): void {
  ipcMain.handle(APP_UPDATE_PULL_CHANNEL, (): AppUpdateState => appUpdateState());
  ipcMain.handle(APP_UPDATE_RELAUNCH_CHANNEL, () => relaunchInstalled());
}
