// reviewer-a5-delta2: exhaustive sender x recipient enumeration of `ask --to`: master CLI vs candidate CLI vs the recipient's actual read scope.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
const WT = '/home/lmas/.orchestra/worktrees/orchestra-cosmic-koala-a0b77f4c';
const MASTER_CLI = '/home/lmas/.orchestra/reviewer-a5-delta2-work/master-wt/dist-electron/cli.js';
const CAND_CLI = `${WT}/dist-electron/cli.js`;
const { openBus } = await import(`${WT}/src/main/bus.ts`);
const { startRun, getRelatedRunIds } = await import(`${WT}/src/main/bus-runs.ts`);
const { nearestOrchestratorId } = await import(`${WT}/src/main/wave-run-id.ts`);
const { readPendingReaders } = await import(`${WT}/src/main/bus-wake.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${WT}/src/shared/bus-switches.ts`);
type N = { id: string; name: string; kind: string; parentId?: string; canOrchestrate?: boolean };
const id = (c: string) => `${c.repeat(8)}-0000-4000-8000-${c.repeat(12)}`;
const TOPOS: Record<string, { nodes: N[]; runs: { id: string; kind: string; parent: string | null }[] }> = {
  // post-#221: plain LEAD anchors a mission run; OPS nested; W plain child of LEAD; M member of OPS; S standalone
  newPlainLead: {
    nodes: [
      { id: id('a'), name: 'LEAD', kind: 'worktree' },
      { id: id('b'), name: 'OPS', kind: 'worktree', parentId: id('a'), canOrchestrate: true },
      { id: id('c'), name: 'W', kind: 'worktree', parentId: id('a') },
      { id: id('d'), name: 'M', kind: 'worktree', parentId: id('b') },
      { id: id('e'), name: 'S', kind: 'worktree' },
    ],
    runs: [{ id: id('a'), kind: 'mission', parent: null }, { id: id('b'), kind: 'vague', parent: id('a') }],
  },
  // field: LEAD row-less, OPS root mission
  oldPlainLead: {
    nodes: [
      { id: id('a'), name: 'LEAD', kind: 'worktree' },
      { id: id('b'), name: 'OPS', kind: 'worktree', parentId: id('a'), canOrchestrate: true },
      { id: id('c'), name: 'W', kind: 'worktree', parentId: id('a') },
      { id: id('d'), name: 'M', kind: 'worktree', parentId: id('b') },
      { id: id('e'), name: 'S', kind: 'worktree' },
    ],
    runs: [{ id: id('b'), kind: 'mission', parent: null }],
  },
  // orchestrator LEAD with a run and nested OPS (the standard fleet)
  orchLead: {
    nodes: [
      { id: id('a'), name: 'LEAD', kind: 'worktree', canOrchestrate: true },
      { id: id('b'), name: 'OPS', kind: 'worktree', parentId: id('a'), canOrchestrate: true },
      { id: id('c'), name: 'W', kind: 'worktree', parentId: id('a') },
      { id: id('d'), name: 'M', kind: 'worktree', parentId: id('b') },
      { id: id('e'), name: 'S', kind: 'worktree' },
    ],
    runs: [{ id: id('a'), kind: 'mission', parent: null }, { id: id('b'), kind: 'vague', parent: id('a') }],
  },
  // legacy row-less orchestrator LEAD, OPS pointing at it (child pointer)
  legacyOrchLead: {
    nodes: [
      { id: id('a'), name: 'LEAD', kind: 'worktree', canOrchestrate: true },
      { id: id('b'), name: 'OPS', kind: 'worktree', parentId: id('a'), canOrchestrate: true },
      { id: id('c'), name: 'W', kind: 'worktree', parentId: id('a') },
      { id: id('d'), name: 'M', kind: 'worktree', parentId: id('b') },
      { id: id('e'), name: 'S', kind: 'worktree' },
    ],
    runs: [{ id: id('b'), kind: 'vague', parent: id('a') }],
  },
};
function world(t: string) {
  const T = TOPOS[t];
  const home = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-a5d2e-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  for (const r of T.runs) startRun(db, { id: r.id, kind: r.kind, coordinator: r.id, parentRunId: r.parent }, DEFAULT_BUS_SWITCHES);
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ workspaces: T.nodes }));
  const by = new Map(T.nodes.map((n) => [n.id, n]));
  const runOf = (i: string) => nearestOrchestratorId(by.get(i) as any, (x: string) => by.get(x) as any);
  return { home, db, nodes: T.nodes, runOf };
}
function ask(w: ReturnType<typeof world>, cli: string, from: string, to: string): number {
  const wt = path.join(w.home, 'wt', from); fs.mkdirSync(wt, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_WS_ID: from, ORCHESTRA_RUN_ID: w.runOf(from), ORCHESTRA_WORKSPACE_PATH: wt };
  return spawnSync(process.execPath, [cli, 'ask', '--to', to, `q ${from.slice(0, 2)}->${to.slice(0, 2)}?`], { env, cwd: wt, encoding: 'utf8' }).status ?? -1;
}

function realRead(w: ReturnType<typeof world>, R: N, _tag: string): boolean {
  // the REAL wake predicate: is R pending (would the sweep wake it, ordering `check --run <pendingRunId>`)?
  const pend = readPendingReaders(w.db, [{ reader: R.id, runId: w.runOf(R.id) }]) as any[];
  return pend.length === 1 && pend[0].pending === true;
}
let falseRef = 0, newLoud = 0, voidRemains = 0, total = 0, seenCnt = 0, pendCnt = 0;
for (const t of Object.keys(TOPOS)) {
  const out: string[] = [];
  const base = world(t);
  for (const S of base.nodes) for (const R of base.nodes) {
    if (S.id === R.id) continue;
    total++;
    const tag = `q ${S.id.slice(0, 2)}->${R.id.slice(0, 2)}?`;
    const wm = world(t); const m = ask(wm, MASTER_CLI, S.id, R.id);
    const real = m === 0 ? realRead(wm, R, tag) : false;
    const pendState = m === 0 ? JSON.stringify(readPendingReaders(wm.db, [{ reader: R.id, runId: wm.runOf(R.id) }])) : '';
    wm.db.close();
    const wc = world(t); const c = ask(wc, CAND_CLI, S.id, R.id); wc.db.close();
    const cls = c === 1 && real ? 'FALSE-REFUSAL' : c === 1 && m === 0 ? 'new-loud' : c === 0 && m === 0 && !real ? 'silent-void(remains)' : '';
    if (cls === 'FALSE-REFUSAL') falseRef++; if (cls === 'new-loud') newLoud++; if (cls.startsWith('silent')) voidRemains++;
    if (cls) out.push(`  ${S.name}->${R.name}: master rc ${m}, cand rc ${c}, master-row really pending (wake predicate)=${real} ${cls}`);
    if (m === 0 && real) { seenCnt++; }
  }
  base.db.close();
  console.log(`## ${t}`); console.log(out.join('\n') || '  (no classified pairs)');
}
console.log(`TOTAL pairs=${total} FALSE-REFUSAL(real read)=${falseRef} new-loud=${newLoud} silent-void-remaining=${voidRemains} master-accepted-and-really-readable=${seenCnt}`);
