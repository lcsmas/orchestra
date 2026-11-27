// #604 (ledger #613 FROZEN v1) — the BUILT CLI, `orchestra fanout plan`: the coordinator's verb and the plan agent's `plan submit`, vouched by a fake host over a real unix socket (the same wire as the app's hooks
// server: `/identity` + `/fanoutAcceptance`); the host op is the production `dispatchFanoutAcceptance`. Fail-closed arms: no host / a key the host does not vouch → nothing is asked, nothing is written.
// Drives dist-electron/cli.js (the `pretest` hook builds it); isolated ORCHESTRA_HOME, never a live app.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { existsSync, mkdtempSync, mkdirSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { runFanout } from './fanout-state.ts';
import { dispatchFanoutAcceptance, type AcceptanceHostDeps } from '../shared/fanout-acceptance-host.ts';
import { planSidecarFile } from '../shared/fanout-plan-host.ts';
import { readState, stateFile } from '../shared/fanout-state.ts';

const here = path.dirname(fileURLToPath(import.meta.url));
const CLI = process.env.ORCHESTRA_TEST_CLI || path.join(here, '..', '..', 'dist-electron', 'cli.js');
const needsBuild = { skip: existsSync(CLI) ? false : 'dist-electron/cli.js not built — run `pnpm run build:cli`' };

const RUN = 'b6040000-0000-4000-8000-0000000000a1'; // the coordinator (it owns the run)
const AGENT = 'b6040000-0000-4000-8000-0000000000b2'; // the plan agent (the host's spawn answers this id)
const KEY_RUN = 'a1'.repeat(32);
const KEY_AGENT = 'b2'.repeat(32);
const NOW = '2026-11-25T10:00:00.000Z';
const PLAN = { version: 1, tickets: [{ id: 'A', title: 'table', spec: 'ledger §A', specText: 'The orders table.', dependsOn: [] }, { id: 'B', title: 'api', spec: 'ledger §B', specText: 'The orders api.', dependsOn: ['A'] }], interfaces: { A: '`orders.status` — kind: column; shape: string; where: src/orders.ts' }, noSharedBehaviour: ['A-B'] };

interface Cli { code: number; stdout: string; stderr: string }
type Stop = { after: (fn: () => void) => void };

function freshHome(t: Stop): string {
  const home = mkdtempSync(path.join(os.tmpdir(), 'orch-604-'));
  t.after(() => rmSync(home, { recursive: true, force: true }));
  mkdirSync(path.join(home, 'userData', 'orchestra'), { recursive: true });
  const d = { env: { ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: RUN }, cwd: home, runner: () => ({ code: 1, stdout: '', stderr: '' }), now: () => NOW, readStdin: () => '', vouchedCaller: RUN };
  assert.equal(runFanout(['state', 'init', '--run', RUN, '--switch', 'seatRecords=on'], d).code, 0);
  return home;
}

/** A fake host: `/identity` vouches the two keys, `/fanoutAcceptance` is the production dispatcher with a fake spawn (the agent id is AGENT). */
async function startHost(t: Stop, home: string): Promise<{ sock: string; spawns: Array<{ name: string; task: string }>; calls: string[] }> {
  const spawns: Array<{ name: string; task: string }> = [];
  const calls: string[] = [];
  const live = new Set<string>();
  const hostDeps: AcceptanceHostDeps = {
    home, now: () => new Date().toISOString(), isWorkspace: (id) => id === RUN || live.has(id), isLive: (id) => id === RUN || live.has(id), repoPath: () => undefined,
    vouches: (id, key) => (id === RUN && key === KEY_RUN) || (id === AGENT && key === KEY_AGENT),
    spawn: async (i) => { spawns.push({ name: i.name, task: i.task }); live.add(AGENT); return { ok: true, id: AGENT }; },
    post: () => undefined,
  };
  const dir = mkdtempSync(path.join(os.tmpdir(), 'orch-604-h-'));
  const sock = path.join(dir, 'h.sock');
  const sockets = new Set<import('node:net').Socket>();
  const server = http.createServer((req, res) => {
    let raw = '';
    req.setEncoding('utf8');
    req.on('data', (c) => (raw += c));
    req.on('end', () => {
      const body = JSON.parse(raw || '{}') as Record<string, unknown>;
      calls.push(String(req.url));
      const reply = async (): Promise<unknown> => {
        if (req.url === '/identity') return (body.id === RUN && body.key === KEY_RUN) || (body.id === AGENT && body.key === KEY_AGENT) ? { ok: true, runId: RUN, generation: null } : {};
        if (req.url === '/fanoutAcceptance') return dispatchFanoutAcceptance(body, hostDeps);
        return {};
      };
      reply().then((r) => { res.writeHead(200, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(r)); });
    });
  });
  server.on('connection', (s) => { sockets.add(s); s.on('close', () => sockets.delete(s)); });
  await new Promise<void>((resolve) => server.listen(sock, resolve));
  t.after(() => { for (const s of sockets) s.destroy(); server.close(); rmSync(dir, { recursive: true, force: true }); });
  return { sock, spawns, calls };
}

function cli(home: string, args: string[], o: { sock?: string; ws: string; key: string | null; stdin?: string }): Promise<Cli> {
  const env: Record<string, string> = { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_WS_ID: o.ws, ORCHESTRA_SOCK: o.sock ?? path.join(home, 'no-such.sock'), ORCHESTRA_WORKSPACE_PATH: home };
  if (o.key) env.ORCHESTRA_SESSION_KEY = o.key;
  return new Promise((resolve) => {
    const p = spawn(process.execPath, [CLI, ...args], { env, cwd: home, stdio: ['pipe', 'pipe', 'pipe'] });
    let stdout = '', stderr = '';
    p.stdout.on('data', (d) => (stdout += d));
    p.stderr.on('data', (d) => (stderr += d));
    p.stdin.end(o.stdin ?? '');
    const timer = setTimeout(() => p.kill('SIGKILL'), 60_000);
    p.on('close', (code) => { clearTimeout(timer); resolve({ code: code ?? -1, stdout, stderr }); });
  });
}
const waitFor = async (what: string, ok: () => boolean): Promise<void> => { for (let i = 0; i < 300; i++) { if (ok()) return; await new Promise((r) => setTimeout(r, 50)); } assert.fail(`timed out waiting for ${what}`); };

test('CLI: the coordinator asks, the host spawns explo-plan-<run8> with the brief rendered by code, the vouched agent submits, the verb returns {"plan":"accepted"} (exit 0)', needsBuild, async (t) => {
  const home = freshHome(t);
  const host = await startHost(t, home);
  const coord = cli(home, ['fanout', 'plan', '--tickets', 'A,B', '--timeout', '2'], { sock: host.sock, ws: RUN, key: KEY_RUN });
  await waitFor('the plan agent to be spawned', () => host.spawns.length === 1 && existsSync(planSidecarFile(home, RUN)) && JSON.parse(readFileSync(planSidecarFile(home, RUN), 'utf8')).agent?.id === AGENT);
  assert.equal(host.spawns[0].name, 'explo-plan-b6040000');
  assert.match(host.spawns[0].task, /orchestra fanout plan submit <file> --run b6040000-0000-4000-8000-0000000000a1/);
  assert.match(host.spawns[0].task, /^- A$/m);
  const sub = await cli(home, ['fanout', 'plan', 'submit', '-', '--run', RUN], { sock: host.sock, ws: AGENT, key: KEY_AGENT, stdin: JSON.stringify(PLAN) });
  assert.equal(sub.code, 0, sub.stderr);
  assert.match(sub.stdout, /plan accepted/);
  const r = await coord;
  assert.equal(r.code, 0, r.stderr);
  assert.equal(JSON.parse(r.stdout).plan, 'accepted');
  assert.equal(readState(stateFile(home, RUN))?.loopPlan?.attempts, 1);
  const dec = await cli(home, ['fanout', 'state', 'set', '--run', RUN, '--run-decision', 'wait for A to merge'], { sock: host.sock, ws: RUN, key: KEY_RUN });
  assert.equal(dec.code, 2);
  assert.match(dec.stderr, /\[decision-after-plan\]/);
});

test('CLI: refused twice → both the agent and the coordinator exit 2 with [plan-refused-twice]; loopPlan not set', needsBuild, async (t) => {
  const home = freshHome(t);
  const host = await startHost(t, home);
  const coord = cli(home, ['fanout', 'plan', '--tickets', 'A,B', '--timeout', '2'], { sock: host.sock, ws: RUN, key: KEY_RUN });
  await waitFor('the plan agent', () => host.spawns.length === 1 && existsSync(planSidecarFile(home, RUN)) && JSON.parse(readFileSync(planSidecarFile(home, RUN), 'utf8')).agent?.id === AGENT);
  const bad = JSON.stringify({ ...PLAN, decisions: 'wait for A' });
  const s1 = await cli(home, ['fanout', 'plan', 'submit', '-', '--run', RUN], { sock: host.sock, ws: AGENT, key: KEY_AGENT, stdin: bad });
  assert.equal(s1.code, 2);
  assert.match(s1.stderr, /ONCE more[\s\S]*\[plan-free-text\]/);
  const s2 = await cli(home, ['fanout', 'plan', 'submit', '-', '--run', RUN], { sock: host.sock, ws: AGENT, key: KEY_AGENT, stdin: bad });
  assert.equal(s2.code, 2);
  assert.match(s2.stderr, /^\[plan-refused-twice\]/);
  const r = await coord;
  assert.equal(r.code, 2);
  assert.match(r.stderr, /\[plan-refused-twice\]/);
  assert.equal(readState(stateFile(home, RUN))?.loopPlan, undefined);
});

test('CLI fails closed: no host / a key the host does not vouch → the agent submits nothing, the coordinator spawns nothing', needsBuild, async (t) => {
  const home = freshHome(t);
  const host = await startHost(t, home);
  // the coordinator with a wrong key: the host cannot vouch it
  const c1 = await cli(home, ['fanout', 'plan', '--tickets', 'A,B'], { sock: host.sock, ws: RUN, key: 'ff'.repeat(32) });
  assert.equal(c1.code, 2);
  assert.match(c1.stderr, /\[plan-caller\]/);
  // no app at all
  const c2 = await cli(home, ['fanout', 'plan', '--tickets', 'A,B'], { ws: RUN, key: KEY_RUN });
  assert.equal(c2.code, 2);
  assert.match(c2.stderr, /\[plan-caller\]/);
  assert.equal(host.spawns.length, 0);
  // an agent that the host does not vouch, with a sidecar that names it
  await cli(home, ['fanout', 'plan', '--tickets', 'A,B', '--timeout', '0.01'], { sock: host.sock, ws: RUN, key: KEY_RUN }); // spawns the agent, times out
  const forged = await cli(home, ['fanout', 'plan', 'submit', '-', '--run', RUN], { ws: AGENT, key: KEY_AGENT, stdin: JSON.stringify(PLAN) }); // env says AGENT, the host is unreachable
  assert.equal(forged.code, 2);
  assert.match(forged.stderr, /^\[plan-caller\]/);
  assert.equal(readState(stateFile(home, RUN))?.loopPlan, undefined);
});

test('CLI: --help and --print never ask the host (no /identity, no op)', needsBuild, async (t) => {
  const home = freshHome(t);
  const host = await startHost(t, home);
  const h = await cli(home, ['fanout', 'plan', '--help'], { sock: host.sock, ws: RUN, key: KEY_RUN });
  assert.equal(h.code, 0);
  assert.match(h.stdout, /plan-refused-twice/);
  const p = await cli(home, ['fanout', 'plan', '--tickets', 'A,B', '--print'], { sock: host.sock, ws: RUN, key: KEY_RUN });
  assert.equal(p.code, 0, p.stderr);
  assert.match(p.stdout, /^- B$/m);
  assert.equal(existsSync(planSidecarFile(home, RUN)), false);
  assert.deepEqual(host.calls, [], 'the host was not asked');
  void writeFileSync;
});
