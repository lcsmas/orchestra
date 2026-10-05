// Mockup rig (F1 #257): scratch fleet + scratch bus + PACKAGED app in MY OWN headless sway. Nothing live is touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';

export const WS = '297149e0-7bf0-4270-85c2-7a7a32b3adbf';
export const SCRATCH = `/home/lmas/.orchestra/agent-tmp/${WS}/pm`;
export const TREE = '/home/lmas/.orchestra/worktrees/orchestra-fuzzy-willow-297149e0';
export const APP_BIN = '/home/lmas/.orchestra/agent-tmp/297149e0-7bf0-4270-85c2-7a7a32b3adbf/pm/app-master/orchestra'; // reflink copy of the packaged master f636a683 (sibling's apps/ dirs get cleaned)
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const say = (...a) => console.log(...a);
const LIVE = ['.claude', '.claude-mc', '.claude-perso', '.config'].map((d) => path.join('/home/lmas', d));
export function assertScratch(label, p) {
  const r = path.resolve(p);
  if (!(r + path.sep).startsWith(SCRATCH + path.sep)) throw new Error(`SCRATCH-ONLY: ${label}=${r} is outside ${SCRATCH}`);
  for (const l of LIVE) if ((r + path.sep).startsWith(l + path.sep)) throw new Error(`SCRATCH-ONLY: ${label}=${r} inside live ${l}`);
}
export function preflight() {
  if (process.env.DISPLAY) throw new Error('ABORT: X11 DISPLAY present');
  const WL = process.env.WAYLAND_DISPLAY;
  if (!process.env.RIG_WAYLAND || WL !== process.env.RIG_WAYLAND || WL === 'wayland-1') throw new Error(`ABORT: WAYLAND_DISPLAY ${WL} != rig's ${process.env.RIG_WAYLAND}`);
  say(`CONTAINMENT rig_wayland=${process.env.RIG_WAYLAND} DISPLAY=<unset> SWAYSOCK=${process.env.SWAYSOCK}`);
}
const GIT_ENV = { PATH: '/usr/bin:/bin', GIT_AUTHOR_NAME: 'pm', GIT_AUTHOR_EMAIL: 'pm@x', GIT_COMMITTER_NAME: 'pm', GIT_COMMITTER_EMAIL: 'pm@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...GIT_ENV, HOME: '/nonexistent' } }).trim();
const UIDS = ['44f27c77-19ff-447b-a94a-b6e3512b1c52', '3610c0f1-860b-4f57-8855-0b5788040149', '012fcdca-d63b-4d43-9dae-7f10031ba33a', 'c34a25ee-763d-4b00-b9d8-fb8fd417bf7c', 'db40de36-dcc2-48d3-a0af-b7319ede5f8b', '9f9955a2-b7cb-4af6-9fdb-96293c210ba6', 'f94e2424-d80e-4de0-a88a-1c367a529632', '2e7c0fc9-d085-4c22-ad0a-dbf1c80fd2f2', 'd6cabdac-f9d8-44a3-8151-abd506f84277', '7463ea93-dea0-4c1e-8da9-ab162978eccb'];
const uid = (n) => UIDS[n - 1];

// the fleet: [key, parentKey, kind, status, note]
export const FLEET = [
  ['lead', null, 'orchestrator', 'running', 'dispatche la vague F'],
  ['ops', 'lead', 'orchestrator', 'running', 'gate : G3 en cours'],
  ['uif1', 'ops', 'worktree', 'running', 'couche IPC pause/reprise'],
  ['canf2', 'ops', 'worktree', 'running', 'drill Pause dure ×3'],
  ['revf1', 'ops', 'worktree', 'waiting', 'review du diff F1'],
  ['verif', 'ops', 'worktree', 'idle', ''],
  ['docs', 'lead', 'worktree', 'idle', 'carte du code à jour'],
  ['legacy', null, 'orchestrator', 'running', 'balayage hors vague'],
  ['swa', 'legacy', 'worktree', 'running', ''],
  ['swb', 'legacy', 'worktree', 'idle', ''],
];
export const NAMES = { lead: 'fleet-lead', ops: 'wave-f-ops', uif1: 'pause-ui-f1', canf2: 'canary-f2', revf1: 'review-f1', verif: 'verifier-f', docs: 'docs-sweep', legacy: 'legacy-sweep', swa: 'sweep-a', swb: 'sweep-b' };
export const IDS = Object.fromEntries(FLEET.map(([k], i) => [k, uid(i + 1)]));
export const WSLIST_ID2KEY = Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, k]));

export function buildWorld(label) {
  const H = path.join(SCRATCH, `h-${label}`);
  assertScratch('H', H);
  fs.rmSync(H, { recursive: true, force: true });
  for (const d of ['home', 'cfg', 'bin', 'userData/orchestra']) fs.mkdirSync(path.join(H, d), { recursive: true });
  fs.writeFileSync(path.join(H, 'bin', 'claude'), '#!/bin/sh\necho PM-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  fs.writeFileSync(path.join(H, 'cfg', '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }));
  const repo = path.join(H, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const acct = { id: 'pm-rig', label: 'pm rig (scratch)', configDir: path.join(H, 'cfg') };
  const wsList = FLEET.map(([k, parent, kind, status, note], i) => {
    const wt = path.join(H, `wt-${k}`);
    const orch = kind === 'orchestrator';
    if (orch) fs.mkdirSync(wt, { recursive: true }); else git(repo, 'worktree', 'add', '-q', '-b', NAMES[k], wt);
    return { id: IDS[k], name: NAMES[k], repoPath: orch ? '' : repo, worktreePath: wt, branch: NAMES[k], baseBranch: orch ? '' : 'master', createdAt: Date.now() - (FLEET.length - i) * 600000, status: 'idle', agent: 'claude', sdkSessionId: '',
      ...(orch ? { kind: 'orchestrator', canOrchestrate: true } : {}), ...(parent ? { parentId: IDS[parent] } : {}), ...(note ? { statusText: note } : {}) };
  });
  fs.writeFileSync(path.join(H, 'userData/orchestra/store.json'), JSON.stringify({ repos: [], workspaces: wsList, accounts: [], selfTuneRuns: [] }, null, 2));
  return { H, repo, acct, wsList };
}

/** seed the rig's isolated bus with the REAL shipped writers (state = idle|douce|dure|escalated|resuming|...) */
export function seedBus(H, state, extra = []) {
  assertScratch('H', H);
  const out = execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(SCRATCH, 'seed-bus.mjs'), H, TREE, state, ...extra], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(H, 'home') }, maxBuffer: 16 << 20 });
  const line = out.split('\n').filter((l) => l.startsWith('{')).pop();
  return line ? JSON.parse(line) : null;
}

export async function launchApp(w, { size = [1440, 900] } = {}) {
  const WL = process.env.WAYLAND_DISPLAY;
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  execFileSync('swaymsg', ['output', 'HEADLESS-1', 'resolution', `${size[0]}x${size[1]}`], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: process.env.SWAYSOCK, XDG_RUNTIME_DIR: '/run/user/1000' } });
  const env = { PATH: `${w.H}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: path.join(w.H, 'home'), XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8',
    WAYLAND_DISPLAY: WL, SWAYSOCK: process.env.SWAYSOCK ?? '', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: w.H, CLAUDE_CONFIG_DIR: path.join(w.H, 'cfg'), ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true' };
  for (const k of ['ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'HOME']) assertScratch(k, env[k]);
  if ('DISPLAY' in env) throw new Error('child env has DISPLAY');
  const logf = path.join(w.H, 'app.log');
  const app = spawn(APP_BIN, ['--ozone-platform=wayland'], { cwd: w.H, env, stdio: ['ignore', fs.openSync(logf, 'w'), fs.openSync(logf, 'a')] });
  say(`APP pid=${app.pid} cdp=${port} PACKAGED ${APP_BIN}`);
  let target;
  for (let i = 0; i < 120 && !target; i++) { await sleep(500); try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = t.find((x) => x.type === 'page' && x.url.includes('index.html')); } catch { /* not up */ } }
  if (!target) throw new Error('ABORT no page target');
  say(`TARGET-URL ${target.url}`);
  const environ = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
  if (environ.some((l) => l.startsWith('DISPLAY='))) throw new Error('ABORT app env has DISPLAY');
  const has = (k) => environ.find((l) => l.startsWith(`${k}=`)) ?? `${k}=<unset>`;
  say(`APP-ENV ${has('WAYLAND_DISPLAY')} ${has('ORCHESTRA_HOME')} ${has('CLAUDE_CONFIG_DIR')} ${has('HOME')}`);
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  return { app, port, cdp, kill: () => killTree(app.pid) };
}
function killTree(pid) { try { for (const k of execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean)) { try { process.kill(Number(k)); } catch { /* gone */ } } } catch { /* none */ } try { process.kill(pid); } catch { /* gone */ } }

export async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cdp ws error')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`cdp eval: ${JSON.stringify(r.result.exceptionDetails).slice(0, 400)}`);
      return r.result?.result?.value;
    },
    async shot(file, clip) {
      const r = await send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) });
      fs.writeFileSync(file, Buffer.from(r.result.data, 'base64'));
      return file;
    },
    async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } },
    close: () => ws.close(),
  };
}

export function teardown(app) {
  try { app?.kill(); } catch { /* */ }
}
