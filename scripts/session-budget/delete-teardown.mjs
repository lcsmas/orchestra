// Teardown through the REAL workspace-delete path (#210) — replaces the harness's hand-rolled stop sequence
// for the delete arms, so a regression in the shipped delete code (workspaces.ts stopStructuredSession) is
// what the arm observes. Runs INSIDE the containment, in the runner process (one session per process).
//
//   via 'cli' → workspaces.dispatchDeleteWorkspaceRequest — the socket route `orchestra delete` hits (hooks-server.ts
//               `/deleteWorkspace`); NO sdkStopMany before it, so stopStructuredSession is the only stopper.
//   via 'ui'  → api-handlers.apiHandlers.deleteWorkspace — what the renderer's `workspaces:delete` IPC calls:
//               sdkStopMany + browserPanel.destroyPanel + workspaces.deleteWorkspace.
//
// Survivors are found TWO ways so neither containment mode can report a vacuous zero (each half is pinned by an arm whose
// mutant only that half catches — see procs-arms.mjs): the pre-delete tree's
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
 * @param {{REPO: string, wsId: string, via: 'cli'|'ui', pidns: boolean, census: Function, boundMs: number,
 *          stableForMs: number, pollMs?: number, wakeDuringDelete?: boolean}} o
 * @returns {Promise<object>} the `report.delete` block (see DeleteReport in src/shared/session-budget.ts)
 *
 * The observation has three parts: the delete call is RACED against `boundMs` (a hung delete still gets its tree
 * censused and named, review F4); the tree is polled until the first zero reading or `boundMs`; and a zero is then
 * WATCHED for `stableForMs` more (review F1c: a keeper relaunched by a racing wake, or anything spawned after the sweep,
 * appears AFTER the first zero — a poll that stops there cannot see it). `wakeDuringDelete` fires a peer-delivery-style
 * `sdkSend` while the session is stopping and the keeper kill is still running (F1a): the launch tombstone
 * (`forbidKeeperLaunch`) is what must refuse it.
 */
export async function deleteViaRealPath({ REPO, wsId, via, pidns, census, boundMs, stableForMs, pollMs = 50, wakeDuringDelete = false }) {
  if (via !== 'cli' && via !== 'ui') throw new Error(`deleteViaRealPath: unknown route ${via}`);
  if (!(stableForMs > 0)) throw new Error('deleteViaRealPath: stableForMs is required (the budget number, SESSION_BUDGETS.afterDelete.stableForMs)');
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
  const callP = call().then(() => ({ error: null }), (e) => ({ error: String(e?.stack ?? e) }));
  let wake;
  if (wakeDuringDelete) {
    // The session is `stopping` as soon as the delete's synchronous part has run; wait for it anyway (bounded) so the wake
    // provably lands on a stopping session (sdkHasSession is false for it) while killKeeper is still in flight.
    const sdk = await import(`${REPO}/src/main/agent-sdk.ts`);
    const tw = Date.now();
    while (sdk.sdkHasSession(wsId) && Date.now() - tw < 2000) await sleep(2);
    wake = { firedAtMs: Date.now() - t0, sessionStoppingBeforeWake: !sdk.sdkHasSession(wsId), result: 'pending' };
    sdk.sdkSend(wsId, 'wake during delete').then(
      () => { wake.result = 'accepted'; },
      (e) => { wake.result = `rejected: ${String(e?.message ?? e).split('\n')[0].slice(0, 160)}`; },
    );
  }
  const raced = await Promise.race([callP, sleep(boundMs).then(() => null)]);
  const hung = raced === null;
  const returnedMs = hung ? null : Date.now() - t0;
  const alive = () => {
    const c = census({ pidns });
    const out = new Map();
    for (const p of c.procs) out.set(p.pid, p); // (pid namespace) EVERY process still in it — also catches one that was never in the tree
    for (const p of before.procs) {
      const id0 = ids.get(p.pid);
      if (id0 != null && identity(p.pid) === id0) out.set(p.pid, p); // the pre-delete tree by identity — also without a pid namespace
    }
    return [...out.values()];
  };
  let left = alive();
  while (left.length > 0 && Date.now() - t0 < boundMs) { await sleep(pollMs); left = alive(); }
  const firstZeroMs = left.length === 0 ? Date.now() - t0 : null;
  const seen = new Map(left.map((p) => [p.pid, p]));
  let dwellMs = 0;
  if (firstZeroMs !== null) {
    const tz = Date.now();
    while (Date.now() - tz < stableForMs) {
      await sleep(pollMs);
      for (const p of alive()) seen.set(p.pid, p); // anything alive AFTER the first zero counts, even if it dies again
    }
    dwellMs = Date.now() - tz;
  }
  const survivors = [...seen.values()];
  return {
    via,
    boundMs,
    returnedMs,
    ...(hung ? { hung: true } : {}),
    elapsedMs: survivors.length === 0 ? firstZeroMs : null,
    dwellMs,
    treeBefore: before.procs,
    survivors,
    storeRecordGone: !store.getWorkspace(wsId),
    ...(wake ? { wake } : {}),
    ...(raced?.error ? { error: raced.error } : {}),
  };
}
