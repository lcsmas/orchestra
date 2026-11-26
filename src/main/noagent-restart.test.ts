// #640 — `orchestra restart <id>` / the toolbar / the sidebar row on a no-agent workspace start ITS command: real processes (the #612 runner), idempotent while alive, restartable after it exited.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createNoAgentRunner } from './noagent-runner.ts';
import { restartNoAgent } from '../shared/noagent.ts';
import type { Workspace } from '../shared/types.ts';

function rig(runCommand: string) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'noagent-restart-'));
  const wt = path.join(home, 'wt');
  fs.mkdirSync(wt);
  const ws = { id: 'ws-na', name: 'ops-x', repoPath: wt, worktreePath: wt, branch: 'ops-x', baseBranch: 'master', createdAt: 1, status: 'idle', agent: 'claude', noAgent: true, runCommand } as unknown as Workspace;
  const runner = createNoAgentRunner({ home, getWorkspace: (id) => (id === ws.id ? ws : undefined), runIdOf: () => 'run-x', scriptEnv: () => ({}), hostEnv: { PATH: process.env.PATH, DISPLAY: ':9' }, sock: () => '/nonexistent/fake.sock', registerKey: () => {}, forgetKey: () => {} });
  return { wt, ws, runner, start: (id: string) => runner.start(id) };
}
const until = async (f: () => boolean, ms = 4000): Promise<void> => { const end = Date.now() + ms; while (!f()) { if (Date.now() > end) throw new Error('timeout'); await new Promise((r) => setTimeout(r, 25)); } };

test('restart of a no-agent workspace whose command EXITED starts it again (new pid); while it is alive a second restart reuses it (same pid, nothing restarted)', async () => {
  const r = rig('echo ran >> runs.txt; sleep 30');
  const first = await restartNoAgent(r.ws, false, r.start);
  assert.ok(first.ok && !first.noAgent.reused);
  await until(() => fs.existsSync(path.join(r.wt, 'runs.txt')));
  const again = await restartNoAgent(r.ws, false, r.start);
  assert.ok(again.ok && first.ok && again.noAgent.reused && again.noAgent.pid === first.noAgent.pid, 'alive ⇒ idempotent');
  assert.equal(fs.readFileSync(path.join(r.wt, 'runs.txt'), 'utf8').trim().split('\n').length, 1, 'the command ran once');
  await r.runner.stop('ws-na'); // "the command exits / crashes"
  const after = await restartNoAgent(r.ws, false, r.start);
  assert.ok(after.ok && first.ok && !after.noAgent.reused && after.noAgent.pid !== first.noAgent.pid);
  await until(() => fs.readFileSync(path.join(r.wt, 'runs.txt'), 'utf8').trim().split('\n').length === 2);
  await r.runner.stop('ws-na');
});

test('restart must-FAIL: --fresh is refused (no conversation) and starts nothing; a refused start carries the runner\'s reason', async () => {
  const r = rig('sleep 30');
  const fresh = await restartNoAgent(r.ws, true, r.start);
  assert.ok(!fresh.ok && /^\[noagent-fresh\]/.test(fresh.error));
  assert.equal(r.runner.running('ws-na'), false, 'nothing was started');
  const unknown = await restartNoAgent({ id: 'nope' }, false, r.start);
  assert.ok(!unknown.ok);
});

test('wiring: dispatchRestartRequest answers a no-agent workspace BEFORE the pause / admission / classifier, and the toolbar + sidebar reach it through restartAgent', () => {
  const src = fs.readFileSync(path.join(import.meta.dirname, 'restart-workspace.ts'), 'utf8');
  const body = src.slice(src.indexOf('export async function dispatchRestartRequest('));
  const na = body.indexOf('ws?.noAgent === true');
  assert.ok(na > 0 && na < body.indexOf('sandboxPausedMessage(ws)') && na < body.indexOf('admissionGate('), 'the no-agent branch comes first');
  const side = fs.readFileSync(path.join(import.meta.dirname, '..', 'renderer', 'components', 'Sidebar.tsx'), 'utf8');
  assert.equal((side.match(/<NoAgentRestart w=\{w\}/g) ?? []).length, 2, 'both row kinds offer it');
  assert.match(side, /w\.noAgent !== true\) return null;[\s\S]*window\.orchestra\.restartAgent\(w\.id\)/);
});
