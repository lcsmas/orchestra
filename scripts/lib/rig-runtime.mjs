// The contained rig's PRIVATE runtime dir (incident Q2, ledger #405). A driver that builds its own
// child env must take XDG_RUNTIME_DIR from here, never hard-code /run/user/<uid>: the human's runtime
// dir holds the keyring / session-bus sockets a crashing rig Electron aborted gnome-keyring over twice.
// Throws (a NAMED refusal) unless the env came from scripts/e2e-contained-rig.sh, so a bare run fails
// closed instead of silently falling back to the real dir.
export function privateRuntimeDir(env = process.env) {
  const rigDir = env.RIG_DIR ?? '';
  const xdg = env.XDG_RUNTIME_DIR ?? '';
  if (!rigDir) throw new Error('RIG_DIR unset — run this through scripts/e2e-contained-rig.sh (it owns the private XDG_RUNTIME_DIR)');
  if (!xdg) throw new Error('XDG_RUNTIME_DIR unset — the contained rig always exports its private one');
  if (xdg.startsWith('/run/user/')) throw new Error(`XDG_RUNTIME_DIR=${xdg} is the human's runtime dir — refusing (incident Q2, ledger #405)`);
  if (xdg !== `${rigDir}/xdg`) throw new Error(`XDG_RUNTIME_DIR=${xdg} is not the rig's private dir ${rigDir}/xdg`);
  return xdg;
}

/**
 * What a driver HANDED the app, checked on the spawn env object. A clause that reads /proc/<app pid>/environ goes BLIND once
 * DBUS_SESSION_BUS_ADDRESS is in the app's env (Chromium rewrites its title/environ: src/shared/browser-reliquats.ts:37, measured as
 * 1 entry instead of 15), so assert the object and prove the app HONOURED it by an effect (e.g. it loaded the seeded store).
 * Returns the list of problems (empty = ok).
 */
export function handedEnvProblems(env, want) {
  const bad = [];
  for (const [k, v] of [['ORCHESTRA_HOME', want.ohome], ['CLAUDE_CONFIG_DIR', want.cfg], ['HOME', want.home], ['WAYLAND_DISPLAY', want.wayland], ['XDG_RUNTIME_DIR', want.xdg]]) {
    if (env[k] !== v) bad.push(`${k}=${env[k] ?? '<unset>'} (want ${v})`);
  }
  if ('DISPLAY' in env) bad.push(`DISPLAY=${env.DISPLAY} is set (X11 must be unreachable)`);
  const bus = `unix:path=${want.noBusPath}`;
  if (env.DBUS_SESSION_BUS_ADDRESS !== bus) bad.push(`DBUS_SESSION_BUS_ADDRESS=${env.DBUS_SESSION_BUS_ADDRESS ?? '<unset>'} (want ${bus})`);
  for (const [k, v] of Object.entries(env)) if (typeof v === 'string' && v.includes('/run/user/')) bad.push(`${k} contains /run/user/`);
  return bad;
}
