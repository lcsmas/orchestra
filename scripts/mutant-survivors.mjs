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
