// « Nouvelle version installée » (Lucas 2026-10-12): the running app keeps its code in memory, so a release that replaces the
// installed AppImage does nothing until Orchestra is relaunched — and nothing used to say so. PURE: identity compare, the version
// sidecar written by scripts/release.sh --install, the words, and the wait-then-exec relaunch script.

export interface InstalledIdentity {
  ino: number;
  size: number;
  mtimeMs: number;
}

export type AppUpdateState = { kind: 'none' } | { kind: 'installed'; version: string | null; key: string };

export const APP_UPDATE_NONE: AppUpdateState = { kind: 'none' };

export function identityKey(i: InstalledIdentity): string {
  return `${i.ino}:${i.size}:${Math.round(i.mtimeMs)}`;
}

/** The sidecar `<installed>.version` = `<version> <inode> <size>` of the file it describes (release.sh writes it AFTER the swap).
 *  A sidecar for another file — left by an install that did not write one — gives no version rather than a wrong one. */
export function parseVersionSidecar(text: string | null, now: InstalledIdentity): string | null {
  const m = /^(\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?)\s+(\d+)\s+(\d+)\s*$/.exec(String(text ?? '').trim());
  if (!m || Number(m[2]) !== now.ino || Number(m[3]) !== now.size) return null;
  return m[1];
}

/** `boot` = the installed file when this process started; `now` = the file on disk now (null: missing, e.g. mid-swap). */
export function decideAppUpdate(boot: InstalledIdentity | null, now: InstalledIdentity | null, sidecar: string | null): AppUpdateState {
  if (!boot || !now) return APP_UPDATE_NONE;
  if (identityKey(boot) === identityKey(now)) return APP_UPDATE_NONE;
  return { kind: 'installed', version: parseVersionSidecar(sidecar, now), key: identityKey(now) };
}

export function appUpdateStateKey(s: AppUpdateState): string {
  return s.kind === 'none' ? 'none' : `${s.key}|${s.version ?? ''}`;
}

export function appUpdateTitle(s: AppUpdateState): string {
  if (s.kind === 'none') return '';
  return s.version ? `Nouvelle version installée (v${s.version})` : 'Nouvelle version installée';
}

/** argv for `sh -c`: wait until the quitting app (pid $1) is gone — the new one would otherwise hit the single-instance lock and
 *  just focus the old window — then exec the installed app ($2). Gives up waiting after 60 s and execs anyway. */
export const RELAUNCH_SCRIPT = 'i=0; while kill -0 "$1" 2>/dev/null && [ "$i" -lt 600 ]; do sleep 0.1; i=$((i+1)); done; exec "$2"';
export function relaunchArgv(pid: number, target: string): string[] {
  return ['-c', RELAUNCH_SCRIPT, 'orchestra-relaunch', String(pid), target];
}
