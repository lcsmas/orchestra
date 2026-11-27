#!/usr/bin/env node
// #614 (stack D) — the BUILT CLI `orchestra fanout run` (no --scenario) on the LIVE ports, as far as it goes without a real fleet, against a SCRATCH repository (never lcsmas/orchestra, never a bench; the scratch repo stays PRIVATE):
//   real built CLI · real bus (a temp ORCHESTRA_HOME with a run row) · real `gh` + real `git` on the scratch repo · a FAKE HOST on a unix socket (`/identity` vouches, `/fanoutAcceptance` = the REAL `dispatchFanoutAcceptance`
//   with fake spawns) · a SCRIPTED implementer (it pushes its branch to the scratch repo and mails `status` through the real CLI). No reviewer verdict, and a private repo has no Actions budget, so nothing can merge: the run is
//   stopped once the loop has started the implementer, nominated it, opened the PR on the scratch repo, spawned its reviewer and read the CI. Everything it created on the scratch repo is removed. LOCAL_ONLY (gh auth + network).
//   ORCHESTRA_SCRATCH_REPO=<owner>/<…scratch…> node --experimental-strip-types scripts/e2e-fanout-run-live-scratch.mjs
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import http from 'node:http';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = process.env.ORCHESTRA_SCRATCH_REPO ?? '';
if (!/^[\w.-]+\/[\w.-]*scratch[\w.-]*$/i.test(REPO) || /\/orchestra$/i.test(REPO)) { console.error('set ORCHESTRA_SCRATCH_REPO=<owner>/<name containing "scratch"> — never a repository that is not an explicit scratch one'); process.exit(1); }
const vis = spawnSync('gh', ['repo', 'view', REPO, '--json', 'isPrivate', '--jq', '.isPrivate'], { encoding: 'utf8' }).stdout.trim();
if (vis !== 'true') { console.error(`${REPO} is not PRIVATE (${vis || 'unreadable'}): this rig never runs against a public repository`); process.exit(1); }
const CLI = path.join(ROOT, 'dist-electron', 'cli.js');
if (!fs.existsSync(CLI)) { console.error('missing dist-electron/cli.js — run `pnpm run build:cli`'); process.exit(1); }
const mod = (f) => import(path.join(ROOT, f));
const { dispatchFanoutAcceptance } = await mod('src/shared/fanout-acceptance-host.ts');
const bus = await mod('src/main/bus.ts');
const busRuns = await mod('src/main/bus-runs.ts');
const { DEFAULT_BUS_SWITCHES } = await mod('src/shared/bus-switches.ts');
const st = await mod('src/shared/fanout-state.ts');

const RUN = 'e2e614run0001';
const tag = Date.now().toString(36);
const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'run-live-scratch-'));
const home = path.join(dir, 'home'); fs.mkdirSync(home);
const work = path.join(dir, 'clone');
const sock = path.join(dir, 'host.sock');
const results = [];
const check = (name, ok, detail = '') => { results.push({ name, ok: !!ok, detail }); console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${ok ? '' : ` — ${detail}`}`); };
const run = (cmd, args, cwd = work, env = process.env) => { const r = spawnSync(cmd, args, { cwd, encoding: 'utf8', env: { ...env, GH_PROMPT_DISABLED: '1', GIT_TERMINAL_PROMPT: '0' } }); return { code: r.status ?? 1, stdout: (r.stdout ?? '').trim(), stderr: (r.stderr ?? '').trim() }; };
const g = (...a) => { const r = run('git', ['-c', 'user.name=scratch', '-c', 'user.email=scratch@localhost', ...a]); if (r.code !== 0) throw new Error(`git ${a.join(' ')}: ${r.stderr}`); return r.stdout; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// ── the scratch clone (author scratch@localhost, never a personal email) ──
const cl = run('gh', ['repo', 'clone', REPO, work], os.tmpdir()); if (cl.code !== 0) { console.error(cl.stderr); process.exit(1); }
if (run('git', ['rev-parse', '--verify', 'origin/main']).code !== 0) { console.error(`${REPO} has no main — seed it first (its main needs a ci workflow)`); process.exit(1); }
g('checkout', '-q', '-B', 'main', 'origin/main'); run('git', ['remote', 'set-head', 'origin', 'main']);

// ── the real bus with a run row ──
process.env.ORCHESTRA_HOME = home;
{ const db = bus.openBus(path.join(home, 'bus.sqlite')); busRuns.startRun(db, { id: RUN, kind: 'vague', coordinator: RUN }, DEFAULT_BUS_SWITCHES); db.close(); }

// ── the fake host: /identity vouches every session, /fanoutAcceptance = the real dispatcher over fake spawns ──
const KEYS = { [RUN]: 'k-run', 'ws-impl': 'k-impl', 'ws-review': 'k-review' };
const live = new Set();
const hostLog = [];
let implBranch = null;
const deps = {
  home, now: () => new Date().toISOString(), isWorkspace: (id) => live.has(id), isLive: (id) => live.has(id), implementerLive: (id) => live.has(id),
  repoPath: () => work, post: () => undefined, vouches: (id, key) => KEYS[id] !== undefined && KEYS[id] === key, verifyCaller: (id, key) => (KEYS[id] === key ? 'ok' : 'unregistered'),
  spawn: async (i) => { live.add('ws-review'); hostLog.push(`spawn reviewer ${i.name}`); return { ok: true, id: 'ws-review' }; },
  spawnImplementer: async (i) => { live.add('ws-impl'); implBranch = i.name; hostLog.push(`spawn implementer ${i.name}`); return { ok: true, id: 'ws-impl', branch: i.name }; },
  transcriptDirOf: () => null,
};
const server = http.createServer((req, res) => {
  let b = ''; req.on('data', (c) => (b += c));
  req.on('end', async () => {
    const body = b ? JSON.parse(b) : {};
    const ok = (o) => { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify(o)); };
    hostLog.push(`${req.url}${body.op ? ` ${body.op}` : ''}`);
    if (req.url === '/identity') return ok(KEYS[body.id] !== undefined && KEYS[body.id] === body.key ? { ok: true, runId: RUN, generation: null } : { ok: false, code: 'unregistered' });
    if (req.url === '/fanoutAcceptance') return ok(await dispatchFanoutAcceptance(body, deps));
    if (req.url === '/resolveHandle') return ok({ ok: true, workspaces: [...live, RUN].map((id) => ({ id, name: id, runId: RUN })) });
    ok({});
  });
});
await new Promise((r) => server.listen(sock, r));

const planFile = path.join(dir, 'plan.json');
fs.writeFileSync(planFile, JSON.stringify({ version: 1, tickets: [{ id: 'T1', title: 'one', spec: 'spec/T1.md', specText: 'Ticket one of the scratch run.', dependsOn: [] }], interfaces: {} }));
const envFor = (ws, key) => ({ PATH: process.env.PATH, HOME: process.env.HOME, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: sock, ORCHESTRA_WS_ID: ws, ORCHESTRA_SESSION_KEY: key, ORCHESTRA_RUN_ID: RUN });

// ── the loop: the BUILT CLI, no --scenario ──
let stderr = '';
const loop = spawn(process.execPath, [CLI, 'fanout', 'run', '--plan', planFile], { cwd: work, env: envFor(RUN, KEYS[RUN]) });
loop.stderr.on('data', (d) => { stderr += d; });
let loopExit = null;
loop.on('close', (c) => { loopExit = c; });

// ── the scripted implementer: once the host spawned it, push its branch to the scratch repo and mail `status` ──
let pushedHead = null;
let prNumber = null;
const deadline = Date.now() + 8 * 60_000;
try {
  while (Date.now() < deadline && loopExit === null) {
    if (implBranch && !pushedHead) {
      g('checkout', '-q', '-B', implBranch, 'main'); fs.writeFileSync(path.join(work, `${implBranch}.txt`), `${tag}\n`); g('add', '.'); g('commit', '-q', '-m', `T1 ${tag}`); g('push', '-q', '-f', 'origin', implBranch);
      pushedHead = g('rev-parse', 'HEAD'); g('checkout', '-q', 'main');
      const m = run(process.execPath, [CLI, 'send', '--type', 'status', `T1 nominated ${implBranch}`], work, envFor('ws-impl', KEYS['ws-impl']));
      check('the scripted implementer mailed `status` through the real CLI on the real bus', m.code === 0, m.stderr);
    }
    if (pushedHead && !prNumber) {
      const l = run('gh', ['pr', 'list', '--repo', REPO, '--head', implBranch, '--state', 'open', '--json', 'number']);
      const arr = l.code === 0 ? JSON.parse(l.stdout || '[]') : [];
      if (arr.length) prNumber = arr[0].number;
    }
    const s = st.readState(st.stateFile(home, RUN));
    if (prNumber && s?.tickets?.T1?.review?.reviewer?.id && /CI|check|red|green|pending/i.test(stderr)) break; // opened, reviewer spawned, CI looked at
    if (prNumber && s?.tickets?.T1?.review?.reviewer?.id && Date.now() > deadline - 7 * 60_000 + 90_000) break;
    await sleep(3000);
  }
  const s = st.readState(st.stateFile(home, RUN));
  const t = s?.tickets?.T1;
  check('the loop (built CLI, live ports) vouched by the fake host, applied the plan, started the implementer through the real `fanout start` + host op', /plan applied: T1/.test(stderr) && hostLog.includes('spawn implementer impl-T1') , `${stderr.slice(0, 300)} | ${hostLog.join(', ')}`);
  check('the head came from git (the pushed scratch branch), the ticket was nominated', !!t?.head && pushedHead && t.head.startsWith(pushedHead.slice(0, 12)) && t.status === 'nominated', JSON.stringify({ head: t?.head, status: t?.status }));
  check('a REAL pull request was opened on the scratch repo by the live forge', !!prNumber, `${stderr.slice(-300)}`);
  check('the live fleet spawned the ticket\'s reviewer through the real `fanout review` + host op', !!t?.review?.reviewer?.id && hostLog.some((l) => l.startsWith('spawn reviewer')), JSON.stringify(t?.review));
  const pr = prNumber ? run('gh', ['pr', 'view', String(prNumber), '--repo', REPO, '--json', 'state,baseRefName,headRefOid,commits']) : null;
  const pj = pr && pr.code === 0 ? JSON.parse(pr.stdout) : null;
  check('the PR is OPEN on main at the scripted head, NOT merged (no verdict, and no Actions budget while private)', !!pj && pj.state === 'OPEN' && pj.baseRefName === 'main' && pj.headRefOid === pushedHead, JSON.stringify(pj)?.slice(0, 200));
  if (pj) check('no personal email on the scratch commit', !/lucas|msn\.com|mobile\.club/i.test(g('log', '-1', '--format=%ae %ce', `origin/${implBranch}`)), g('log', '-1', '--format=%ae %ce', `origin/${implBranch}`));
} finally {
  loop.kill('SIGTERM'); await sleep(1500); if (loopExit === null) loop.kill('SIGKILL');
  server.close();
  // leave nothing on the scratch repo
  if (prNumber) run('gh', ['pr', 'close', String(prNumber), '--repo', REPO]);
  if (implBranch) run('git', ['push', '-q', 'origin', '--delete', implBranch]);
  console.log(`\nhost calls: ${hostLog.join(' | ')}`);
  console.log(`loop stderr (tail):\n${stderr.split('\n').slice(-12).join('\n')}`);
  fs.rmSync(dir, { recursive: true, force: true });
}
const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} arms passed`);
process.exit(failed.length ? 1 : 0);
