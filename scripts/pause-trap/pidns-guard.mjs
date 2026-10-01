// D8 rig safety (#252 D1b round-2 F7): the destructive inner rigs (provenance-inner / recycle-inner) run ONLY inside their OWN pid namespace
// (recycle-rig.mjs: `unshare --user --map-root-user --pid --fork --mount-proc` ⇒ the rig node is pid 1 there) and signal ONLY processes carrying this run's tag.
import fs from 'node:fs';

export const REFUSAL = 'REFUSED: this rig must run in its OWN pid namespace (scripts/pause-trap/recycle-rig.mjs) — it is destructive and refuses the host pid namespace';

/** Returns the run tag, or prints the refusal + exits 3 (nothing spawned, nothing killed). `cfg.hostPidNs` = the LAUNCHER's /proc/self/ns/pid. */
export function requireOwnPidNs(cfg, resultKey) {
  let own = null;
  try { own = fs.readlinkSync('/proc/self/ns/pid'); } catch { /* unreadable ⇒ refuse */ }
  if (!cfg.tag || !cfg.hostPidNs || own === null || own === cfg.hostPidNs || process.pid !== 1) {
    console.log(JSON.stringify({ [resultKey]: true, refused: REFUSAL, ok: false, checks: [] }));
    process.exit(3);
  }
  process.env.PT_RIG_TAG = cfg.tag; // every process the rig spawns inherits it
  return cfg.tag;
}

/** Is `pid` one of THIS run's processes (its environ carries the tag)? Unreadable ⇒ no. */
export function isTagged(pid, tag) {
  try { return fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').includes(`PT_RIG_TAG=${tag}`); } catch { return false; }
}
