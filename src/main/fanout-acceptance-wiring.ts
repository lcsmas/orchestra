// #515 — production wiring of the `/fanoutAcceptance` route: the app's agent-spawn route and the bus behind the pure host half (shared/fanout-acceptance-host.ts).
// Not importable under plain node --test (store / platform seam); fanout-acceptance-wiring.test.ts pins it by source, the rig drives the shared half.
import { dispatchFanoutAcceptance, type AcceptanceHostDeps, type AcceptanceHostResult } from '../shared/fanout-acceptance-host.ts';
import { send, getBus } from './bus.ts';
import { orchestraHome } from './platform/index.ts';
import { store } from './store';
import { detectRemoteUrl, refResolves } from './git';
import { execFile } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { ensureTicketBranch } from '../shared/fanout-ticket-branch.ts';
import { sessionKeys } from './session-identity-host.ts';
import { archiveWorkspace, dispatchAgentSpawnRequest, installOrchestraHooks, resolveWaveRunId } from './workspaces';
import { transcriptDirOfWorkspace } from './agent-sdk';

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
  verifyCaller: (id, key) => sessionKeys().verify(id, key), // #588: `op: review` is re-proved here, not only by the CLI
  isLive: (id) => { const w = store.getWorkspace(id); return !!w && !w.archived; }, // #588: a deleted or archived reviewer is replaced, a live one woken
  // #587 PR B: `fanout start` — the implementer spawn (the one `impl-` door of a seatRecords run), and liveness = the workspace exists and is not archived
  implementerLive: (id) => { const w = store.getWorkspace(id); return !!w && !w.archived; },
  spawnImplementer: async (i) => {
    const r = await dispatchAgentSpawnRequest({ from: i.from, repoPath: i.repoPath, task: i.task, agent: 'claude', name: i.name, ...(i.baseBranch ? { baseBranch: i.baseBranch } : {}), ...(i.reuseBranch ? { reuseBranch: true } : {}) }, { viaFanoutStart: true });
    return { ok: r.ok, id: r.id, branch: r.branch, held: r.held, error: r.error };
  },
  vouches: (id, key) => !!key && sessionKeys().verify(id, key) === 'ok',
  // the spawn answered but the state write was lost: a live child of the run already named for the ticket is adopted, never duplicated
  orphanImplementer: ({ run, name, recorded, others }) => {
    const named = (b: string): boolean => b === name || (b.startsWith(`${name}-`) && /^\d+$/.test(b.slice(name.length + 1)));
    const w = store.workspaces.find((x) => x.parentId === run && !x.archived && !recorded.includes(x.id) && named(x.branch) && !others.includes(x.branch));
    return w ? { id: w.id, branch: w.branch } : null;
  },
  // #682: a shallow read-only checkout of each target repo at the run target (host-owned dir, reused), so the plan agent READS the code the tickets name; the brief renders these paths
  checkouts: async ({ run, repos, target }) => {
    const run1 = (cmd: string, args: string[]) => new Promise<void>((resolve, reject) => execFile(cmd, args, { timeout: 300_000, maxBuffer: 1 << 20 }, (err, _o, stderr) => (err ? reject(new Error(`${cmd} ${args[0]}: ${String(stderr).trim().slice(0, 200) || err.message}`)) : resolve())));
    const out: Array<{ repo: string; path: string }> = [];
    for (const repo of repos) {
      const dir = path.join(orchestraHome(), 'fanout', run, 'plan-src', repo.replace('/', '__'));
      if (!fs.existsSync(path.join(dir, '.git'))) {
        fs.mkdirSync(path.dirname(dir), { recursive: true });
        await run1('gh', ['repo', 'clone', repo, dir, '--', '--depth', '1', '--no-single-branch']);
        await run1('git', ['-C', dir, 'checkout', '--detach', `origin/${target}`]).catch(() => undefined); // a target that is not a branch of it: the default branch stays
      }
      out.push({ repo, path: dir });
    }
    return out;
  },
  // #683: the loop creates the ticket branch in the target repo (gh API, from the target tip) before the implementer is told its name
  prepareTicketBranch: async ({ repo, target, branch }) => {
    const gh = (args: string[]) => new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => execFile('gh', args, { timeout: 60_000, maxBuffer: 1 << 20 }, (err, stdout, stderr) => resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, stdout: String(stdout), stderr: String(stderr) })));
    await ensureTicketBranch({ repo, target, branch, gh });
  },
  // #599: which repository the implementers' worktrees are made in (the coordinator's, as `repoPath` above) and whether the run target is a ref of it
  worktreeRepo: async ({ run, repoPath }) => {
    const p = repoPath ?? store.getWorkspace(run)?.repoPath;
    const r = store.repos.find((x) => x.path === p);
    return { remote: r?.remoteUrl ?? (p ? (await detectRemoteUrl(p)) ?? null : null), defaultBranch: r?.defaultBranch ?? null }; // remoteUrl is backfilled lazily: ask git when the store has none
  },
  refExists: ({ run, repoPath, ref }) => { const p = repoPath ?? store.getWorkspace(run)?.repoPath; return p ? refResolves(p, ref) : Promise.resolve(true); },
  childrenOf: (run) => store.workspaces.filter((w) => w.parentId === run).map((w) => w.id), // #554 m1: the run owner's direct children
  // #554: the stamp carries the run's switches, so this rewrites the skill only when they changed
  refreshSkills: async (ids) => {
    const done: string[] = [];
    for (const id of ids) { const ws = store.getWorkspace(id); if (ws && ws.host?.kind !== 'sandbox') { await installOrchestraHooks(ws.worktreePath); done.push(id); } }
    return done;
  },
  transcriptDirOf: (id) => { const w = store.getWorkspace(id); return w ? transcriptDirOfWorkspace(w) : null; }, // #614: the Boucle's cost-per-ticket reads these
  archive: (id) => archiveWorkspace(id), // #629 plan-release (the plan agent once its plan is accepted) / #628 release (an implementer the Boucle replaces)
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
