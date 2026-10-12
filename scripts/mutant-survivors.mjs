// Measured survivors for the in-place mutant harnesses (#323 gate c/6112245304: `strays = () => 0` printed « survivors 0 » whatever happened). Pure Linux /proc + fs; no dependency on a harness.
import fs from 'node:fs';
import path from 'node:path';

/** Live descendants (children, grandchildren, …) of `rootPid`, read from /proc/<pid>/stat. A descendant that is a zombie is not alive. `rootPid` itself is not counted. */
export function descendantsOf(rootPid, procDir = '/proc') {
  const parent = new Map();
  const state = new Map();
  for (const n of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(n)) continue;
    try {
      const stat = fs.readFileSync(path.join(procDir, n, 'stat'), 'utf8');
      const m = /^\d+ \(.*\) (\S) (\d+) /s.exec(stat); // « pid (comm) S ppid … » — comm may contain spaces and parentheses
      if (!m) continue;
      parent.set(Number(n), Number(m[2]));
      state.set(Number(n), m[1]);
    } catch { /* gone while reading */ }
  }
  const out = [];
  const seen = new Set([rootPid]);
  let grew = true;
  while (grew) {
    grew = false;
    for (const [pid, ppid] of parent) {
      if (!seen.has(pid) && seen.has(ppid)) { seen.add(pid); grew = true; if (state.get(pid) !== 'Z') out.push(pid); }
    }
  }
  return out;
}

/** Backup files (`*.orig`) in `dir` that are NOT byte-identical to the file they back up — i.e. restores that did not happen. Identical ones are deleted (the restore is proven, the scratch is cleaned); returns what is left on disk. */
export function settleBackups(dir, sourceOf) {
  let left = 0;
  let names = [];
  try { names = fs.readdirSync(dir); } catch { return 0; }
  for (const f of names) {
    const full = path.join(dir, f);
    const src = f.endsWith('.orig') ? sourceOf(f.slice(0, -'.orig'.length)) : null;
    let same = false;
    try { same = src !== null && fs.readFileSync(full).equals(fs.readFileSync(src)); } catch { /* source unreadable */ }
    if (same) fs.rmSync(full, { force: true });
    else left++;
  }
  return left;
}

// ── review m1/m2 of #323 (gate c/6112361358): an ORPHAN (its parent exited; reparented to init OR to a systemd user manager / subreaper — not only « ppid 1 ») is no descendant any more, and a HOME-global scratch dir
// let one run judge, and delete, another run's backups. So: processes are selected by a MARKER in their environment (inherited by every child the harness spawns, orphaned or not), and scratch is per RUN.

/** The env var the harness puts on EVERY process it spawns; its value identifies ONE run. */
export const SWEEP_MARK_ENV = 'ORCHESTRA_MUTANT_SWEEP';

/** Live processes whose environment carries `SWEEP_MARK_ENV=<token>` (readable only for our own uid: another user's processes cannot be ours). `self` is never counted. Zombies are not alive. */
export function markedProcesses(token, procDir = '/proc', self = process.pid) {
  if (!token) throw new Error('markedProcesses needs a run token (an empty one would select every process)');
  const needle = `${SWEEP_MARK_ENV}=${token}`;
  const out = [];
  for (const n of fs.readdirSync(procDir)) {
    if (!/^\d+$/.test(n) || Number(n) === self) continue;
    try {
      const env = fs.readFileSync(path.join(procDir, n, 'environ'), 'latin1').split('\0');
      if (!env.includes(needle)) continue;
      const stat = fs.readFileSync(path.join(procDir, n, 'stat'), 'utf8');
      if (/^\d+ \(.*\) Z /s.test(stat)) continue;
      out.push(Number(n));
    } catch { /* gone / not ours */ }
  }
  return out;
}

/** Everything of THIS run still alive: its live descendants ∪ its marked processes (orphans included). */
export function strayProcesses(rootPid, token, procDir = '/proc') {
  return [...new Set([...descendantsOf(rootPid, procDir), ...markedProcesses(token, procDir, rootPid)])].sort((a, b) => a - b);
}

/** A scratch dir that belongs to THIS run alone (`<base>/run-<pid>-<ms>`): another run's backups are neither read, counted nor deleted. */
export function makeRunDir(base, pid = process.pid, now = Date.now()) {
  const dir = path.join(base, `run-${pid}-${now}`);
  fs.mkdirSync(dir, { recursive: true });
  return dir;
}

/** End of run: settle the run's own backups (identical ones are cleaned), remove the run dir if nothing is left, return what is left (0 = clean). */
export function finishRunDir(dir, sourceOf) {
  const left = settleBackups(dir, sourceOf);
  if (left === 0) fs.rmSync(dir, { recursive: true, force: true });
  return left;
}
