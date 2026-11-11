// Relance (#427): ONE member's Reliquats as the sweep reads them — the processes of its kernel scope(s) with the role `reliquat` that a Pause/Veille stop WOULD signal (a spared or refused
// process is not ours and never an event). Same pieces as the Veille's census (memberScopeDeps / judgeReliquat), but it returns the PROCESSES, not a count, and needs no keeper probe:
// FI-1 already names the CLI `session` when its keeper pid file is published, and while it is not (own keeper listed as a Reliquat) the whole scope is UNKNOWN, never « none ».
// Electron-free: a fake cgroup tree and real processes drive it under node --test.

import { memberScopeDeps } from './pause-reliquats-scope.ts';
import { realKillDeps, type KillDeps } from './pause-kill.ts';
import { realScopeEnv, type ScopeEnv } from './memory-scope.ts';
import { isOwnKeeperProc, judgeReliquat } from '../shared/pause-reliquats.ts';
import type { RelanceCensus, RelanceProc } from '../shared/relance.ts';

export function censusReliquatsOf(wsId: string, env: ScopeEnv = realScopeEnv(), kill: KillDeps = realKillDeps()): RelanceCensus {
  const deps = memberScopeDeps(wsId, env);
  let scopes;
  try {
    scopes = deps.scopes(wsId);
  } catch {
    return 'unknown'; // the app.slice could not be listed: UNKNOWN is not « no scope »
  }
  const protect = { keeperPid: null, cliPid: null, selfPid: kill.selfPid };
  const out: RelanceProc[] = [];
  for (const scope of scopes) {
    const listing = deps.list(scope);
    if (listing === 'gone') continue;
    if (listing === 'unreadable') return 'unknown';
    for (const m of listing) {
      if (m.role !== 'reliquat') continue;
      // the member's own keeper not yet published ⇒ its CLI and MCP servers read `reliquat` too: the roles of the scope are unreliable
      const f = kill.read(m.pid);
      if (f !== 'gone' && f !== 'unreadable' && isOwnKeeperProc(f, wsId)) return 'unknown';
      const v = judgeReliquat(m.pid, m.startTicks, scope, listing, protect, kill.read);
      if (v.ok) {
        out.push({ pid: m.pid, ppid: m.ppid, startTicks: m.startTicks, comm: m.comm, cmd: (v.proc.argv ?? []).join(' ') || m.comm });
      } else if (v.kind === 'refused') {
        return 'unknown'; // cannot prove what it is: its vanishing must not read as an end
      }
      // 'gone' (died between the listing and the read) and 'spared' (a supervisor / a session's own child) are not Reliquats of the member
    }
  }
  return out;
}
