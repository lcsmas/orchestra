// #515 — production wiring of the `/fanoutAcceptance` route: the app's agent-spawn route and the bus behind the pure host half (shared/fanout-acceptance-host.ts).
// Not importable under plain node --test (store / platform seam); fanout-acceptance-wiring.test.ts pins it by source, the rig drives the shared half.
import { dispatchFanoutAcceptance, type AcceptanceHostDeps, type AcceptanceHostResult } from '../shared/fanout-acceptance-host.ts';
import { send, getBus } from './bus.ts';
import { orchestraHome } from './platform/index.ts';
import { store } from './store';
import { dispatchAgentSpawnRequest, installOrchestraHooks, resolveWaveRunId } from './workspaces';

const productionDeps: AcceptanceHostDeps = {
  get home() { return orchestraHome(); },
  now: () => new Date().toISOString(),
  isWorkspace: (id) => !!store.getWorkspace(id),
  repoPath: ({ from, repo, implementer, run }) => {
    const byRemote = repo ? store.repos.find((r) => (r.remoteUrl ?? '').replace(/\.git$/, '').toLowerCase().endsWith(`/${repo.toLowerCase()}`) || (r.remoteUrl ?? '').toLowerCase().endsWith(`:${repo.toLowerCase()}`))?.path : undefined;
    return [implementer, from, run].map((id) => (id ? store.getWorkspace(id)?.repoPath : undefined)).find(Boolean) ?? byRemote;
  },
  // The role table does the rest: the `accept-` prefix pins the model (Opus 5.5) and freezes spawnRole='acceptor' (#465/#489).
  spawn: async (i) => {
    const r = await dispatchAgentSpawnRequest({ from: i.from, repoPath: i.repoPath, task: i.task, agent: 'claude', name: i.name });
    return { ok: r.ok, id: r.id, error: r.error };
  },
  childrenOf: (run) => store.workspaces.filter((w) => w.parentId === run).map((w) => w.id), // #554 m1: the run owner's direct children
  // #554: the stamp carries the run's switches, so this rewrites the skill only when they changed
  refreshSkills: async (ids) => {
    const done: string[] = [];
    for (const id of ids) { const ws = store.getWorkspace(id); if (ws && ws.host?.kind !== 'sandbox') { await installOrchestraHooks(ws.worktreePath); done.push(id); } }
    return done;
  },
  post: ({ to, sender, body }) => {
    const ws = store.getWorkspace(to);
    if (!ws) throw new Error(`unknown workspace ${to}`);
    const db = getBus();
    if (!db) throw new Error('the bus is not open');
    send(db, { runId: resolveWaveRunId(ws), sender, recipient: to, kind: 'status', body });
  },
};

export function dispatchFanoutAcceptanceRequest(msg: Record<string, unknown>): Promise<AcceptanceHostResult> {
  return dispatchFanoutAcceptance(msg, productionDeps);
}
