// Teardown through the REAL workspace-delete path (#210) — replaces the harness's hand-rolled stop sequence
// for the delete arms, so a regression in the shipped delete code (workspaces.ts stopStructuredSession) is
// what the arm observes. Runs INSIDE the containment, in the runner process (one session per process).
//
//   via 'cli' → workspaces.dispatchDeleteWorkspaceRequest — the socket route `orchestra delete` hits (hooks-server.ts
//               `/deleteWorkspace`); NO sdkStopMany before it, so stopStructuredSession is the only stopper.
//   via 'ui'  → api-handlers.apiHandlers.deleteWorkspace — what the renderer's `workspaces:delete` IPC calls:
//               sdkStopMany + browserPanel.destroyPanel + workspaces.deleteWorkspace.
//
// Survivors are found TWO ways so neither containment mode can report a vacuous zero: the pre-delete tree's
// members re-checked BY IDENTITY (pid + /proc start-time, not a zombie — a recycled pid is not a survivor), and
// (pid namespace only) every process still in the namespace, which also catches a keeper RE-launched after the
// delete (the #205 resurrection class). A subtree census alone would lose an orphaned CLI (ppid → 1) — the
// blind spot this file exists to close.
import fs from 'node:fs';

/** `pid → start-time ticks` (stat field 22) or null when gone/zombie/unreadable. */
export function identity(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rest = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
    if (rest[0] === 'Z' || rest[0] === 'X') return null;
    return rest[19]; // field 22 overall = index 19 after `state`
  } catch {
    return null;
  }
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

/**
 * @param {{REPO: string, wsId: string, via: 'cli'|'ui', pidns: boolean, census: Function, boundMs: number, pollMs?: number}} o
 * @returns {Promise<object>} the `report.delete` block (see DeleteReport in src/shared/session-budget.ts)
 */
export async function deleteViaRealPath({ REPO, wsId, via, pidns, census, boundMs, pollMs = 50 }) {
  if (via !== 'cli' && via !== 'ui') throw new Error(`deleteViaRealPath: unknown route ${via}`);
  const { store } = await import(`${REPO}/src/main/store.ts`);
  const before = census({ pidns });
  const ids = new Map(before.procs.map((p) => [p.pid, identity(p.pid)]));
  let call;
  if (via === 'cli') {
    const wsm = await import(`${REPO}/src/main/workspaces.ts`);
    call = async () => {
      const r = await wsm.dispatchDeleteWorkspaceRequest({ id: wsId });
      if (!r.ok) throw new Error(`dispatchDeleteWorkspaceRequest refused: ${r.error}`);
    };
  } else {
    const { apiHandlers } = await import(`${REPO}/src/main/api-handlers.ts`);
    call = () => apiHandlers.deleteWorkspace(wsId);
  }
  const t0 = Date.now();
  let error = null;
  try { await call(); } catch (e) { error = String(e?.stack ?? e); }
  const returnedMs = Date.now() - t0;
  const alive = () => {
    const c = census({ pidns });
    const out = new Map();
    for (const p of c.procs) out.set(p.pid, p);
    for (const p of before.procs) {
      const id0 = ids.get(p.pid);
      if (id0 != null && identity(p.pid) === id0) out.set(p.pid, p);
    }
    return [...out.values()];
  };
  let left = alive();
  while (left.length > 0 && Date.now() - t0 < boundMs) { await sleep(pollMs); left = alive(); }
  return {
    via,
    boundMs,
    returnedMs,
    elapsedMs: left.length === 0 ? Date.now() - t0 : null,
    treeBefore: before.procs,
    survivors: left,
    storeRecordGone: !store.getWorkspace(wsId),
    ...(error ? { error } : {}),
  };
}
