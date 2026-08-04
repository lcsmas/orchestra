/**
 * Environment variables that describe how THIS process was packaged and
 * bootstrapped — not anything a child process should inherit.
 *
 * The bug they caused: Orchestra ships as an AppImage, whose runtime exports
 * `APPIMAGE` (the .AppImage path), `APPDIR` (its FUSE mount), `ARGV0` and `OWD`
 * into the app's environment. Every child Orchestra spawns — agent PTYs, the
 * per-repo run/setup/archive scripts, the SDK subprocess — inherits the app's
 * environment wholesale, so those vars leaked into the workspace shell.
 *
 * `APPIMAGE` in particular is not inert: it means "you are running from this
 * AppImage". So when a workspace's run script started a DEV build of an
 * Electron app (`pnpm dev` on Orchestra itself), that dev process's own ozone
 * bootstrap (main/index.ts) saw `APPIMAGE` set, and its relaunch path — written
 * for the packaged app, where re-exec'ing the AppImage is the only way to
 * survive the FUSE mount going away — spawned **the installed AppImage** and
 * exited. The user's Run tab silently launched the SHIPPED build instead of
 * their worktree, so no local change ever appeared. (The same trap hits any
 * agent running `electron .` by hand.)
 *
 * `ORCHESTRA_OZONE_RELAUNCHED` is the one-shot "I already relaunched myself"
 * marker for a single process; inherited by a child it suppresses the child's
 * own, still-needed relaunch — which is the white-screen-on-Wayland bug the
 * relaunch exists to prevent.
 *
 * Deliberately NOT stripped: `ORCHESTRA_OZONE`. That one is the user's explicit
 * platform choice (typically set in their .desktop launcher) and a dev build
 * started from a workspace should honour it exactly like the installed app does.
 */
export const PROCESS_LOCAL_ENV_VARS = [
  'APPIMAGE',
  'APPDIR',
  'ARGV0',
  'OWD',
  'ORCHESTRA_OZONE_RELAUNCHED',
] as const;

/**
 * Delete the process-local vars above from `env`, IN PLACE. Called once on the
 * main process's own `process.env` at startup (after the ozone decision has
 * consumed them), so every child spawned later inherits a clean environment
 * without each spawn site having to remember — new spawn sites are covered for
 * free, which is the whole point of doing it at one choke point.
 *
 * Returns the names actually removed, for the startup log.
 */
export function stripProcessLocalEnv(env: Record<string, string | undefined>): string[] {
  const removed: string[] = [];
  for (const key of PROCESS_LOCAL_ENV_VARS) {
    if (env[key] !== undefined) {
      removed.push(key);
      delete env[key];
    }
  }
  return removed;
}
