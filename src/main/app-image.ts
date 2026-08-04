/**
 * The AppImage this process was launched from, captured at MODULE LOAD so it
 * survives `stripProcessLocalEnv(process.env)` in index.ts.
 *
 * `APPIMAGE` has to be deleted from `process.env` early (it must not leak into
 * agent PTYs / run scripts — see shared/child-env.ts), but two things in the
 * main process still legitimately need the path: the ozone relaunch (re-exec
 * the AppImage while its FUSE mount is alive) and the `orchestra` CLI shim
 * (the only stable single-file re-invocation target on Linux).
 *
 * Import-time capture is what makes this safe: ES module imports are evaluated
 * before the importing module's body, so every importer sees the launch-time
 * value no matter when the strip runs. Empty string means "not an AppImage"
 * (dev build, distro package, macOS/Windows).
 */
export const APPIMAGE_PATH = process.env.APPIMAGE ?? '';
