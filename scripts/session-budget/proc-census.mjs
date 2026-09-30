// Process census for the session-budget suite (#208) — reused by C3 #210 (processes/memory).
// Reads /proc directly (no `ps`, so the rtk output filter is not in the loop). Two modes:
//   pidns  — the runner is inside its OWN pid namespace: the tree is every process except pid 1 (the
//            namespace init) and the runner's ancestors/self. Nothing can hide from it or outlive it.
//   subtree — no pid namespace: the runner's descendants (a detached keeper keeps ppid = runner while
//            the runner lives).
import fs from 'node:fs';

function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    // pid (comm) state ppid ... — comm may contain spaces/parens, so split on the LAST ')'.
    const rp = stat.lastIndexOf(')');
    const rest = stat.slice(rp + 2).split(' ');
    const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
    let rssKB = 0;
    try { rssKB = Number((fs.readFileSync(`/proc/${pid}/statm`, 'utf8').split(' ')[1] ?? 0)) * 4; } catch { /* gone */ }
    return { pid, state: rest[0], ppid: Number(rest[1]), cmd, rssKB };
  } catch {
    return null; // exited between readdir and read
  }
}

/** Snapshot of every readable process: [{pid, state, ppid, cmd[], rssKB}]. */
export function snapshotProcs() {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name)) continue;
    const p = readProc(Number(name));
    if (p) out.push(p);
  }
  return out;
}

export function classify(p) {
  const argv0 = p.cmd[0] ?? '';
  const line = p.cmd.join(' ');
  if (line.includes('fake-mcp-server.mjs')) return 'mcp';
  if (/(^|\/)keeper\.js(\s|$)/.test(line)) return 'keeper';
  if (/(^|\/)claude$/.test(argv0) || /\/claude\/versions\//.test(argv0)) return 'cli';
  if (/\.orchestra\/.*\.sh|\.claude\/.*hook/.test(line) || (/(^|\/)(ba)?sh$/.test(argv0) && /orchestra/.test(line))) return 'hook';
  return 'other';
}

/**
 * Census of the session's process tree.
 * @param {{pidns: boolean, selfPid?: number}} opts
 * @returns {{total:number, zombies:number, rssKB:number, byKind:{cli:number,keeper:number,mcp:number,hook:number,other:number}, procs:{pid:number,kind:string,cmd:string}[]}}
 */
export function census({ pidns, selfPid = process.pid }) {
  const all = snapshotProcs();
  const byPid = new Map(all.map((p) => [p.pid, p]));
  const ancestors = new Set([selfPid]);
  for (let p = byPid.get(selfPid); p && p.ppid > 0 && !ancestors.has(p.ppid); p = byPid.get(p.ppid)) ancestors.add(p.ppid);
  let tree;
  if (pidns) {
    tree = all.filter((p) => p.pid !== 1 && !ancestors.has(p.pid));
  } else {
    const kids = new Map();
    for (const p of all) (kids.get(p.ppid) ?? kids.set(p.ppid, []).get(p.ppid)).push(p);
    tree = [];
    const stack = [...(kids.get(selfPid) ?? [])];
    while (stack.length) { const p = stack.pop(); tree.push(p); stack.push(...(kids.get(p.pid) ?? [])); }
  }
  const live = tree.filter((p) => p.state !== 'Z');
  const byKind = { cli: 0, keeper: 0, mcp: 0, hook: 0, other: 0 };
  for (const p of live) byKind[classify(p)]++;
  return {
    total: live.length,
    zombies: tree.length - live.length,
    rssKB: live.reduce((a, p) => a + p.rssKB, 0),
    byKind,
    procs: live.map((p) => ({ pid: p.pid, kind: classify(p), cmd: p.cmd.join(' ').slice(0, 140) })),
  };
}
