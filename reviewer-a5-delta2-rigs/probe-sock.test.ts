// reviewer-a5-delta probe: drive the BUILT CLI over a fake app SOCKET (the production path) + sibling verbs.
import test from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const WT = '/home/lmas/.orchestra/worktrees/orchestra-cosmic-koala-a0b77f4c';
const { openBus } = await import(`${WT}/src/main/bus.ts`);
const { startRun, getRelatedRunIds } = await import(`${WT}/src/main/bus-runs.ts`).then(async (m) => ({ startRun: m.startRun, getRelatedRunIds: m.getRelatedRunIds }));
const { nearestOrchestratorId } = await import(`${WT}/src/main/wave-run-id.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${WT}/src/shared/bus-switches.ts`);

const CLI = process.env.CLI_PATH ?? `${WT}/dist-electron/cli.js`;
const LEAD = '11111111-2221-4000-8000-00000000a501';
const OPS = '22222222-2221-4000-8000-00000000a502';
const WORKER = '66666666-2221-4000-8000-00000000a506';
const MEMBER = '55555555-2221-4000-8000-00000000a505';

type Node = { id: string; kind: string; parentId?: string; canOrchestrate?: boolean; name: string };
function mk(topology: 'new' | 'old') {
  const home = fs.mkdtempSync(path.join(os.homedir(), '.orchestra-a5d-'));
  const db = openBus(path.join(home, 'bus.sqlite'));
  const nodes = new Map<string, Node>();
  const add = (n: Omit<Node, 'name'>) => nodes.set(n.id, { ...n, name: 'ws-' + n.id.slice(0, 4) });
  add({ id: LEAD, kind: 'worktree' });
  add({ id: OPS, kind: 'worktree', parentId: LEAD, canOrchestrate: true });
  add({ id: WORKER, kind: 'worktree', parentId: LEAD });
  add({ id: MEMBER, kind: 'worktree', parentId: OPS });
  if (topology === 'new') startRun(db, { id: LEAD, kind: 'mission', coordinator: LEAD }, DEFAULT_BUS_SWITCHES);
  startRun(db, { id: OPS, kind: topology === 'new' ? 'vague' : 'mission', coordinator: OPS, parentRunId: topology === 'new' ? LEAD : null }, DEFAULT_BUS_SWITCHES);
  const dir = path.join(home, 'userData', 'orchestra');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ workspaces: [...nodes.values()] }));
  const runOf = (id: string) => nearestOrchestratorId(nodes.get(id)!, (i: string) => nodes.get(i));
  return { home, db, nodes, runOf };
}

async function withApp(w: ReturnType<typeof mk>, withRunId: boolean, fn: (sock: string) => Promise<void>) {
  const sock = path.join(w.home, 'app.sock');
  const srv = http.createServer((req, res) => {
    let b = ''; req.on('data', (c) => (b += c)); req.on('end', () => {
      res.setHeader('content-type', 'application/json');
      if (req.url === '/resolveHandle') {
        res.end(JSON.stringify({ ok: true, workspaces: [...w.nodes.values()].map((n) => ({ id: n.id, name: n.name, ...(withRunId ? { runId: w.runOf(n.id) } : {}) })) }));
      } else { res.statusCode = 404; res.end(JSON.stringify({ ok: false, error: 'no route ' + req.url })); }
    });
  });
  await new Promise<void>((r) => srv.listen(sock, r));
  try { await fn(sock); } finally { await new Promise((r) => srv.close(r)); }
}

function cli(w: ReturnType<typeof mk>, from: string, args: string[], sock?: string) {
  const wt = path.join(w.home, 'wt', from); fs.mkdirSync(wt, { recursive: true });
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: w.home, ORCHESTRA_HOME: w.home, ORCHESTRA_WS_ID: from, ORCHESTRA_RUN_ID: w.runOf(from), ORCHESTRA_WORKSPACE_PATH: wt };
  if (sock) env.ORCHESTRA_SOCK = sock;
  return new Promise<{ code: number; stdout: string; stderr: string }>((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: wt });
    let so = '', se = '';
    p.stdout.on('data', (d) => (so += d)); p.stderr.on('data', (d) => (se += d));
    p.on('close', (code) => resolve({ code: code ?? -1, stdout: so, stderr: se }));
  });
}
const rows = (w: ReturnType<typeof mk>) => (w.db.prepare('SELECT COUNT(*) AS c FROM messages').get() as { c: number }).c;

test('S1 SOCKET branch (production path): LEAD -> plain non-member child `send` is refused loudly', async () => {
  const w = mk('new');
  await withApp(w, true, async (sock) => {
    const r0 = rows(w);
    const r = await cli(w, LEAD, ['send', '--type', 'status', '--to', WORKER, 'x'], sock);
    console.log('S1 rc', r.code, JSON.stringify(r.stderr.slice(0, 160)), 'rows+', rows(w) - r0);
    assert.equal(r.code, 1); assert.equal(rows(w) - r0, 0);
  });
});
test('S2 SOCKET branch, OLD app (no runId): not judged (documented skew) => rc 0 + a row nobody reads', async () => {
  const w = mk('new');
  await withApp(w, false, async (sock) => {
    const r0 = rows(w);
    const r = await cli(w, LEAD, ['send', '--type', 'status', '--to', WORKER, 'x'], sock);
    console.log('S2 rc', r.code, 'rows+', rows(w) - r0);
    assert.equal(r.code, 0);
  });
});
test('S3 SIBLING verbs: `ask --to` / `gate open --to` the same plain non-member child are NOT refused', async () => {
  const w = mk('new');
  await withApp(w, true, async (sock) => {
    const r0 = rows(w);
    const a = await cli(w, LEAD, ['ask', '--to', WORKER, 'q?'], sock);
    const g = await cli(w, LEAD, ['gate', 'open', '--to', WORKER, 'gq?'], sock);
    console.log('S3 ask rc', a.code, JSON.stringify(a.stdout.trim()), '| gate open rc', g.code, JSON.stringify(g.stdout.trim()), '| rows+', rows(w) - r0);
    const q = w.db.prepare("SELECT run_id, recipient, kind FROM messages WHERE kind='question'").all();
    console.log('S3 question rows', JSON.stringify(q), 'related(WORKER) =', JSON.stringify(getRelatedRunIds(w.db, WORKER).ids));
    assert.equal(a.code, 0);
  });
});
test('S5 FIELD (old) topology: OPS -> row-less LEAD: send refused, ask/gate accepted', async () => {
  const w = mk('old');
  await withApp(w, true, async (sock) => {
    const s = await cli(w, OPS, ['send', '--type', 'status', '--to', LEAD, 'x'], sock);
    const a = await cli(w, OPS, ['ask', '--to', LEAD, 'q?'], sock);
    const g = await cli(w, OPS, ['gate', 'open', '--to', LEAD, 'gq?'], sock);
    console.log('S5 send rc', s.code, '| ask rc', a.code, '| gate open rc', g.code, '| related(LEAD)=', JSON.stringify(getRelatedRunIds(w.db, LEAD).ids));
    assert.equal(s.code, 1);
  });
});
