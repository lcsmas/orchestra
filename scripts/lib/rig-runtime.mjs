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
