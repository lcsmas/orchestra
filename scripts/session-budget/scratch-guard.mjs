// Scratch-only guard (D7): every session-budget rig runs with a scratch HOME / config dir / ORCHESTRA_HOME.
// The app's boot runs account-inheritance sync that can STRIP a live Claude dir (incidents 2026-09-29/30),
// so the rig REFUSES any path that is, or resolves into, a live one. Pure + unit-tested (must-FAIL arms).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

/** Paths that must never be a rig's HOME/config/ORCHESTRA_HOME (or inside one). */
export function liveDirs(env = process.env) {
  const home = os.homedir();
  const out = [path.join(home, '.claude'), path.join(home, '.orchestra'), path.join(home, '.config', 'orchestra')];
  try { for (const n of fs.readdirSync(home)) if (n.startsWith('.claude') || n.startsWith('.orchestra')) out.push(path.join(home, n)); } catch { /* unreadable home */ }
  for (const k of ['CLAUDE_CONFIG_DIR', 'ORCHESTRA_HOME']) if (env[k]) out.push(env[k]);
  return [...new Set(out.map(real))];
}

/**
 * Throws `scratch-guard: REFUSED <label>=<path> — <why>` unless `p` is inside `scratchRoot` and is neither
 * a live dir nor inside/above one. `live` = liveDirs() computed from the INVOKER's env (the runner's own
 * env is already scratch, so it receives the list from its parent).
 */
export function assertScratch(label, p, scratchRoot, live = liveDirs()) {
  const rp = real(p);
  const rr = real(scratchRoot);
  for (const l of live.map(real)) {
    if (rp === l || rp.startsWith(l + path.sep) || l.startsWith(rp + path.sep)) {
      throw new Error(`scratch-guard: REFUSED ${label}=${p} — resolves to/into/over the live dir ${l}`);
    }
  }
  if (rp !== rr && !rp.startsWith(rr + path.sep)) throw new Error(`scratch-guard: REFUSED ${label}=${p} — not inside the scratch root ${scratchRoot}`);
}
