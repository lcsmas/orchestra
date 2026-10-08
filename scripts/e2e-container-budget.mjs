#!/usr/bin/env node
// #293 — BEHAVIOURAL proof, in the REAL src/main/resource-monitor.ts (no host Docker needed), of (1) the container pass's budget in `sampleTick` (pre-review #2): a pass that never finishes
// cannot delay the tick (the line still goes out, carrying the LAST result, with one warn); a pass that throws cannot break it; a pass that finishes in time is awaited; and
// (2) `memberPinnedApis` (review m3b): the daemons live members' relays are pinned to are read from the REAL keepers dir + `<ws>.docker.upstream` sidecars and fed to the accounting.
// Run: node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-container-budget.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import http from 'node:http';
import { spawnSync } from 'node:child_process';

const HOME = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'container-budget-rig-'));
process.env.ORCHESTRA_HOME = HOME;
process.on('exit', () => fs.rmSync(HOME, { recursive: true, force: true })); // every exit path (a failing arm, a throw) removes the scratch dir
const M = await import('../src/main/resource-monitor.ts');
let failures = 0;
const check = (name, ok, detail) => { if (ok) console.log(`  ✓ ${name}`); else { failures++; console.log(`  ✗ ${name}${detail !== undefined ? ` — ${detail}` : ''}`); } };
const results = [];
async function arm(name, fn) {
  console.log(`== arm ${name}`);
  const before = failures;
  try { await fn(); } catch (e) { failures++; console.log(`  ✗ arm threw — ${e?.stack ?? e}`); }
  results.push([name, failures === before]);
}
const VIEW = { docker: 'ok', sampledAt: 1, attributed: [], unattributed: { count: 0, ids: [], names: [] }, unmeasured: 0, daemonsDown: 0 };
const mk = (over) => {
  const lines = [];
  const warns = [];
  const d = { ...M.realResourceMonitorDeps(), procTable: async () => [], keeperRoots: () => [], keeperProcs: () => [], trackedKeeperPid: () => null, liveWorkspaceIds: () => new Set(), statusFor: () => 'idle', storeLoadedFromDisk: () => true, electronProcs: () => [], signal: () => false, appendLine: (l) => lines.push(l), warn: (m) => warns.push(m), containerView: () => VIEW, ...over };
  return { d, lines, warns };
};

await arm('overrun_does_not_delay_the_tick', async () => {
  const { d, lines, warns } = mk({ refreshContainers: () => new Promise(() => {}), containerBudgetMs: 80 });
  const t0 = Date.now();
  await M.sampleTick(d);
  const took = Date.now() - t0;
  check(`a pass that never finishes costs the tick ≈ its budget (took ${took} ms, budget 80 ms)`, took >= 70 && took < 2000, String(took));
  check('the line still went out, carrying the LAST accounting view', lines.length === 1 && lines[0].containers?.docker === 'ok', JSON.stringify(lines[0]?.containers));
  check('exactly ONE warn names the overrun', warns.filter((w) => /container accounting pass exceeded/.test(w)).length === 1, JSON.stringify(warns));
});

await arm('failure_does_not_break_the_tick', async () => {
  const { d, lines, warns } = mk({ refreshContainers: async () => { throw new Error('boom'); }, containerBudgetMs: 5000 });
  await M.sampleTick(d);
  check('the line still went out', lines.length === 1);
  check('the failure is warned, not thrown', warns.some((w) => /container accounting pass failed/.test(w)), JSON.stringify(warns));
});

await arm('in_time_pass_is_awaited', async () => {
  let done = false;
  const { d, lines, warns } = mk({ refreshContainers: async () => { await new Promise((r) => setTimeout(r, 40)); done = true; }, containerBudgetMs: 5000 });
  await M.sampleTick(d);
  check('the pass finished BEFORE the line was built (awaited)', done && lines.length === 1);
  check('no overrun warn for a pass inside its budget', !warns.some((w) => /exceeded/.test(w)), JSON.stringify(warns));
});

await arm('no_hook_no_docker', async () => {
  const { d, lines } = mk({ refreshContainers: undefined, containerView: undefined });
  await M.sampleTick(d);
  check('a deps object without the container hook measures nothing and the line carries no containers (every older rig)', lines.length === 1 && lines[0].containers === undefined);
});

// ── (2) memberPinnedApis over the REAL keepers dir ──
const KEEPERS = path.join(HOME, 'keepers');
fs.mkdirSync(KEEPERS, { recursive: true });
const deadPid = (() => { const r = spawnSync(process.execPath, ['-e', 'process.stdout.write(String(process.pid))']); return Number(r.stdout.toString()); })();
const member = (ws, { pid = process.pid, upstream } = {}) => {
  fs.writeFileSync(path.join(KEEPERS, `${ws}.pid`), JSON.stringify({ pid }));
  if (upstream !== undefined) fs.writeFileSync(path.join(KEEPERS, `${ws}.docker.upstream`), `${upstream}\n`);
};
const sockets = async (apis) => Promise.all(apis.map((a) => a.resolveSocket()));

await arm('member_pinned_apis', async () => {
  member('ws-a', { upstream: '/run/fake-a.sock' });
  member('ws-b', { upstream: '/run/fake-a.sock' }); // same daemon as ws-a: ONE memoised client
  member('ws-c'); // keeper alive, no sidecar published
  member('ws-d', { upstream: 'relative.sock' }); // not an absolute path
  member('ws-e', { upstream: path.join(KEEPERS, 'ws-e.docker.sock') }); // a relay socket is never a daemon
  member('ws-f', { pid: deadPid, upstream: '/run/fake-f.sock' }); // dead keeper
  member('ws-g', { upstream: '/run/fake-g.sock' });
  const apis = M.memberPinnedApis();
  check('exactly the live members that published an absolute, non-relay upstream are pinned (a, b, g)', apis.length === 3, JSON.stringify(await sockets(apis)));
  check('each client is pinned to ITS member\'s upstream (not the app\'s own resolution)', JSON.stringify((await sockets(apis)).sort()) === JSON.stringify(['/run/fake-a.sock', '/run/fake-a.sock', '/run/fake-g.sock']), JSON.stringify(await sockets(apis)));
  const bySock = new Map();
  for (const a of apis) { const p = await a.resolveSocket(); bySock.set(p, [...(bySock.get(p) ?? []), a]); }
  check('two members on one daemon share ONE memoised client', bySock.get('/run/fake-a.sock')?.length === 2 && bySock.get('/run/fake-a.sock')[0] === bySock.get('/run/fake-a.sock')[1]);
  check('a second call returns the SAME clients (memoised per socket, not rebuilt every tick)', M.memberPinnedApis().every((a) => apis.includes(a)));
});

await arm('member_pinned_reaches_accounting', async () => {
  // a REAL HTTP-over-unix fake daemon on the member's published upstream; the app's OWN daemon is unreachable
  const sock = path.join(HOME, 'member-daemon.sock');
  const asked = [];
  const srv = http.createServer((req, res) => {
    asked.push(req.url);
    res.setHeader('content-type', 'application/json');
    if (req.url.startsWith('/containers/json')) {
      res.end(JSON.stringify([{ Id: 'cm1', Names: ['/g9-pinned'], Image: 'alpine:3', State: 'running', Status: 'Up', Created: 1, Labels: { 'orchestra.ws': 'ws-pinned' } }]));
    } else if (/^\/containers\/cm1\/stats/.test(req.url)) {
      res.end(JSON.stringify({ memory_stats: { usage: 123 * 1048576, stats: { inactive_file: 0 } } }));
    } else { res.statusCode = 404; res.end('{}'); }
  });
  await new Promise((resolve) => srv.listen(sock, resolve));
  try {
    fs.rmSync(KEEPERS, { recursive: true, force: true });
    fs.mkdirSync(KEEPERS, { recursive: true });
    member('ws-pinned', { upstream: sock });
    const A = await import('../src/main/container-accounting.ts');
    const D = await import('../src/main/docker-api.ts');
    A.__resetContainerAccountingForTests();
    const own = D.createDockerApi({ socketPath: path.join(HOME, 'no-such-daemon.sock') }); // nothing listens: the app's own daemon is DOWN
    const acc = await A.refreshContainerAccounting({ api: own, extraApis: M.memberPinnedApis, earliestLiveRunStartMs: () => null, now: () => Date.now(), info() {}, warn() {} });
    check('the member-pinned daemon answered: state ok, ONE daemon down (the app\'s own), not "unavailable"', acc.docker === 'ok' && acc.daemonsDown === 1, `${acc.docker} down=${acc.daemonsDown}`);
    check('the container on the pinned daemon is attributed and measured (123 MB)', acc.byWorkspace.get('ws-pinned') === 123 * 1048576, JSON.stringify([...acc.byWorkspace]));
    check('stats were asked of THAT daemon', asked.some((u) => /^\/containers\/cm1\/stats/.test(u)), JSON.stringify(asked));
    const none = await A.refreshContainerAccounting({ api: own, extraApis: () => [], earliestLiveRunStartMs: () => null, now: () => Date.now(), info() {}, warn() {} });
    check('control: without the member-pinned client the same state is "unavailable" (nothing measured)', none.docker === 'unavailable' && none.byWorkspace.size === 0, `${none.docker}`);
  } finally { srv.close(); }
});

console.log(`arms: ${results.map(([n, ok]) => `${n}=${ok ? 'ok' : 'FAIL'}`).join(' ')}`);
console.log(failures === 0 ? 'CONTAINER-BUDGET: PASS' : `CONTAINER-BUDGET: FAIL (${failures})`);
process.exit(failures === 0 ? 0 : 1);
