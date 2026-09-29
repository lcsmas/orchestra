// reviewer-a5-delta2: D5 controls that the delta's own arms leave unpinned (mutants C1, C3 survived 186/0/0).
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
const WT = '/home/lmas/.orchestra/worktrees/orchestra-cosmic-koala-a0b77f4c';
const { openBus } = await import(`${WT}/src/main/bus.ts`);
const { startRun } = await import(`${WT}/src/main/bus-runs.ts`);
const { nearestOrchestratorId } = await import(`${WT}/src/main/wave-run-id.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${WT}/src/shared/bus-switches.ts`);
const CLI = `${WT}/dist-electron/cli.js`;
const LEAD = '11111111-2221-4000-8000-00000000a501';
const OPS = '22222222-2221-4000-8000-00000000a502';
function mk() {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-a5d2-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  const nodes = [
    { id: LEAD, name: 'lead', kind: 'worktree' },
    { id: OPS, name: 'ops', kind: 'worktree', parentId: LEAD, canOrchestrate: true },
  ];
  startRun(db, { id: LEAD, kind: 'mission', coordinator: LEAD }, DEFAULT_BUS_SWITCHES);
  startRun(db, { id: OPS, kind: 'vague', coordinator: OPS, parentRunId: LEAD }, DEFAULT_BUS_SWITCHES);
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ workspaces: nodes }));
  const byId = new Map(nodes.map((n) => [n.id, n]));
  return { home, db, runOf: (id: string) => nearestOrchestratorId(byId.get(id) as any, (i: string) => byId.get(i) as any) };
}
function cli(w: ReturnType<typeof mk>, from: string, args: string[]) {
  const wt = path.join(w.home, 'wt', from); fs.mkdirSync(wt, { recursive: true });
  const env = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_WS_ID: from, ORCHESTRA_RUN_ID: w.runOf(from), ORCHESTRA_WORKSPACE_PATH: wt };
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: wt });
    let so = '', se = ''; p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: so, stderr: se }));
  });
}
test('D5-C1 `ask --to human` (a real surface, #161) is accepted and stored as recipient=human', async () => {
  const w = mk();
  const r = await cli(w, OPS, ['ask', '--to', 'human', 'need a ruling?']);
  const row = w.db.prepare("SELECT recipient FROM messages WHERE body = 'need a ruling?'").get() as { recipient: string } | undefined;
  console.log('D5-C1 rc', r.code, JSON.stringify(r.stderr.slice(0, 120)), 'recipient', row?.recipient);
  assert.equal(r.code, 0); assert.equal(row?.recipient, 'human');
});
test('D5-C3 `gate open --to <8-char LEAD handle>` stores the FULL id (the #144 canary class)', async () => {
  const w = mk();
  const r = await cli(w, OPS, ['gate', 'open', '--to', LEAD.slice(0, 8), 'ruling?']);
  const row = w.db.prepare('SELECT recipient FROM decision_gates ORDER BY rowid DESC LIMIT 1').get() as { recipient: string } | undefined;
  console.log('D5-C3 rc', r.code, JSON.stringify(r.stdout.slice(0, 80)), 'recipient', row?.recipient);
  assert.equal(r.code, 0); assert.equal(row?.recipient, LEAD);
});
