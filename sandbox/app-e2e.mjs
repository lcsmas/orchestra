/**
 * REAL-APP battle test for the sandbox feature: launches the actual Orchestra
 * (built dist-electron, isolated ORCHESTRA_HOME) and a REAL sandbox container,
 * then drives the app's own IPC surface over CDP — the exact code paths a user
 * clicks through:
 *
 *   1. add a temp repo + create a workspace        (real git worktree)
 *   2. importToSandbox(ws://127.0.0.1:<port>)      (stage → POST → trash-retire
 *                                                   → record flip → auto-backup)
 *   3. verify: container provisioned + config seeded, local worktree in trash
 *      (with its gitignored .env), backup tgz on disk
 *   4. "agent work" inside the container (docker exec: commit + dirty file)
 *   5. ejectFromSandbox                            (export → fetch → worktree
 *                                                   restore → overlay → flip)
 *   6. verify: restored worktree has the container commit AND the uncommitted
 *      change, record is local again
 *
 * Prereqs: `vite build` output in dist-electron/, `docker build -t
 * orchestra-sandbox sandbox/`. Cleans up its container, temp dirs, and the
 * worktree/trash/backup artifacts it created. Exits 0 on success.
 *
 * Run: node sandbox/app-e2e.mjs
 */

import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';
import { WebSocket } from 'ws';

const here = path.dirname(fileURLToPath(import.meta.url));
const root = path.join(here, '..');

const CDP_PORT = 9223;
const SANDBOX_PORT = 18790;
const CONTAINER = 'orchestra-app-e2e';
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'orchestra-app-e2e-'));
const ORCHESTRA_HOME = path.join(tmp, 'orchestra-home');
// The store writes userData/orchestra/store.json.tmp on first save; make sure
// the dir exists before the app races to it on a virgin home.
fs.mkdirSync(path.join(ORCHESTRA_HOME, 'userData', 'orchestra'), { recursive: true });

const log = (...a) => console.log('[e2e]', ...a);
let electronProc = null;
let createdWs = null; // { id, worktreePath } for cleanup

function sh(cmd, args, opts = {}) {
  return execFileSync(cmd, args, { encoding: 'utf8', ...opts }).trim();
}
function dockerExec(args) {
  return sh('docker', ['exec', '-u', 'agent', CONTAINER, ...args]);
}

function cleanup() {
  // Detached spawn → its own process group; kill the whole group or the
  // renderer/gpu children (and the CDP port) outlive us and poison reruns.
  try { if (electronProc) process.kill(-electronProc.pid, 'SIGKILL'); } catch {}
  try { electronProc?.kill('SIGKILL'); } catch {}
  try { sh('docker', ['rm', '-f', CONTAINER]); } catch {}
  // Remove artifacts the app created in the REAL ~/.orchestra (worktree /
  // trash / backups) — they're uniquely named by the workspace id.
  if (createdWs) {
    try {
      const trash = path.join(os.homedir(), '.orchestra', 'trash');
      for (const d of fs.existsSync(trash) ? fs.readdirSync(trash) : []) {
        if (d.startsWith(path.basename(createdWs.worktreePath))) {
          fs.rmSync(path.join(trash, d), { recursive: true, force: true });
        }
      }
      fs.rmSync(path.join(os.homedir(), '.orchestra', 'backups', createdWs.id), { recursive: true, force: true });
      fs.rmSync(createdWs.worktreePath, { recursive: true, force: true });
    } catch {}
  }
  try { fs.rmSync(tmp, { recursive: true, force: true }); } catch {}
}
function fail(msg, err) {
  console.error('FAIL:', msg, err ?? '');
  cleanup();
  process.exit(1);
}

function waitFor(pred, timeoutMs, label) {
  return new Promise((resolve, reject) => {
    const start = Date.now();
    const tick = async () => {
      let ok = false;
      try { ok = await pred(); } catch { ok = false; }
      if (ok) return resolve();
      if (Date.now() - start > timeoutMs) return reject(new Error(`timeout: ${label}`));
      setTimeout(tick, 250);
    };
    tick();
  });
}

// ── minimal CDP client ────────────────────────────────────────────────────────

let cdp = null;
let cdpSeq = 0;
const cdpPending = new Map();

async function cdpConnect() {
  const res = await fetch(`http://127.0.0.1:${CDP_PORT}/json`);
  const targets = await res.json();
  const page = targets.find((t) => t.type === 'page' && t.webSocketDebuggerUrl);
  if (!page) throw new Error('no page target');
  cdp = new WebSocket(page.webSocketDebuggerUrl, { origin: `http://127.0.0.1:${CDP_PORT}` });
  await new Promise((resolve, reject) => {
    cdp.once('open', resolve);
    cdp.once('error', reject);
  });
  cdp.on('message', (data) => {
    const msg = JSON.parse(data.toString());
    if (msg.id && cdpPending.has(msg.id)) {
      const { resolve, reject } = cdpPending.get(msg.id);
      cdpPending.delete(msg.id);
      if (msg.error) reject(new Error(msg.error.message));
      else resolve(msg.result);
    }
  });
}

function cdpSend(method, params) {
  return new Promise((resolve, reject) => {
    const id = ++cdpSeq;
    cdpPending.set(id, { resolve, reject });
    cdp.send(JSON.stringify({ id, method, params }));
  });
}

/** Evaluate an async expression in the renderer and return its JSON value. */
async function evalApp(expression) {
  const r = await cdpSend('Runtime.evaluate', {
    expression: `(async () => (${expression}))().then(v => JSON.stringify(v ?? null))`,
    awaitPromise: true,
    returnByValue: true,
  });
  if (r.exceptionDetails) {
    throw new Error(r.exceptionDetails.exception?.description ?? 'renderer eval failed');
  }
  return JSON.parse(r.result.value);
}

// ── the test ──────────────────────────────────────────────────────────────────

async function main() {
  // 0. a source repo with every file class
  const repo = path.join(tmp, 'demo-repo');
  fs.mkdirSync(repo, { recursive: true });
  const git = (args, cwd = repo) => sh('git', ['-c', 'user.email=t@t', '-c', 'user.name=t', ...args], { cwd });
  git(['init', '-b', 'main']);
  fs.writeFileSync(path.join(repo, '.gitignore'), '.env\n');
  fs.writeFileSync(path.join(repo, 'app.txt'), 'v1\n');
  git(['add', '.']);
  git(['commit', '-m', 'base']);
  log('repo ready');

  // 1. the real container
  try { sh('docker', ['rm', '-f', CONTAINER]); } catch {}
  sh('docker', ['run', '-d', '--name', CONTAINER, '-p', `${SANDBOX_PORT}:8787`, 'orchestra-sandbox']);
  await waitFor(
    () => fetch(`http://127.0.0.1:${SANDBOX_PORT}/healthz`).then((r) => r.ok),
    15000,
    'container healthz',
  );
  log('container up');

  // 2. the real app, isolated. Refuse to start over a stale instance — we'd
  // CDP-attach to the wrong app.
  const portFree = await fetch(`http://127.0.0.1:${CDP_PORT}/json`).then(() => false, () => true);
  if (!portFree) throw new Error(`port ${CDP_PORT} already serving CDP — kill the stale electron first`);
  electronProc = spawn(
    path.join(root, 'node_modules', '.bin', 'electron'),
    ['.', `--remote-debugging-port=${CDP_PORT}`, '--remote-allow-origins=*', '--disable-gpu'],
    {
      cwd: root,
      env: { ...process.env, ORCHESTRA_HOME },
      stdio: ['ignore', 'pipe', 'pipe'],
      detached: true,
    },
  );
  electronProc.stderr.on('data', () => {}); // keep the pipe drained
  electronProc.stdout.on('data', () => {});
  await waitFor(() => fetch(`http://127.0.0.1:${CDP_PORT}/json`).then((r) => r.ok), 30000, 'CDP up');
  await cdpConnect();
  await waitFor(() => evalApp(`typeof window.orchestra === 'object'`), 15000, 'preload ready');
  log('app up, CDP attached');

  // 3. create a workspace through the app
  await evalApp(`window.orchestra.addRepo(${JSON.stringify(repo)})`);
  const ws = await evalApp(`window.orchestra.createWorkspace({ repoPath: ${JSON.stringify(repo)} })`);
  assert.ok(ws.id && ws.worktreePath && ws.branch, 'workspace created');
  createdWs = ws;
  // dirty + untracked + ignored files in the real worktree
  fs.writeFileSync(path.join(ws.worktreePath, 'untracked.txt'), 'scratch\n');
  fs.writeFileSync(path.join(ws.worktreePath, '.env'), 'SECRET=local\n');
  fs.appendFileSync(path.join(ws.worktreePath, 'app.txt'), 'dirty-line\n');
  log(`workspace ${ws.branch} created at ${ws.worktreePath}`);

  // 4. IMPORT through the app's real code path
  const imported = await evalApp(
    `window.orchestra.importToSandbox(${JSON.stringify(ws.id)}, 'ws://127.0.0.1:${SANDBOX_PORT}')`,
  );
  assert.equal(imported.host?.kind, 'sandbox', 'record flipped to sandbox');
  assert.equal(fs.existsSync(ws.worktreePath), false, 'local worktree retired');

  // container got everything (incl. uncommitted + untracked), config seeded
  assert.equal(dockerExec(['cat', '/workspace/untracked.txt']), 'scratch');
  assert.match(dockerExec(['cat', '/workspace/app.txt']), /dirty-line/);
  assert.equal(dockerExec(['sh', '-c', 'test -f /workspace/.env && echo yes || echo no']), 'no');
  assert.equal(dockerExec(['sh', '-c', 'test -d /home/agent/.claude && echo yes || echo no']), 'yes');
  log('✓ import: container provisioned, dirty+untracked shipped, ignored excluded, config seeded');

  // trash has the retired copy WITH the ignored .env
  const trashRoot = path.join(os.homedir(), '.orchestra', 'trash');
  const trashed = fs.readdirSync(trashRoot).find((d) => d.startsWith(path.basename(ws.worktreePath)));
  assert.ok(trashed, 'retired worktree in trash');
  assert.equal(fs.readFileSync(path.join(trashRoot, trashed, '.env'), 'utf8'), 'SECRET=local\n');
  log('✓ retire: trash holds the full local copy including the gitignored .env');

  // the import-time auto-backup exists
  const backupDir = path.join(os.homedir(), '.orchestra', 'backups', ws.id);
  const backups = fs.readdirSync(backupDir).filter((n) => n.endsWith('.tgz'));
  assert.ok(backups.length >= 1, 'initial backup snapshot exists');
  log(`✓ backup: ${backups.length} snapshot(s) at ${backupDir}`);

  // manual backup IPC too
  const backupPath = await evalApp(`window.orchestra.backupSandbox(${JSON.stringify(ws.id)})`);
  assert.ok(fs.existsSync(backupPath), 'manual backup written');
  log('✓ manual backup IPC works');

  // 5. "agent work" inside the container
  dockerExec(['sh', '-c', `cd /workspace && echo built > agent.txt && git add agent.txt && git -c user.email=a@a -c user.name=agent commit -q -m 'agent work' && echo more-dirty >> app.txt`]);
  const containerHead = dockerExec(['git', '-C', '/workspace', 'rev-parse', 'HEAD']);
  log('agent work simulated in container');

  // 6. EJECT through the app's real code path
  const ejected = await evalApp(`window.orchestra.ejectFromSandbox(${JSON.stringify(ws.id)})`);
  assert.ok(!ejected.host, 'record flipped back to local');
  assert.ok(fs.existsSync(ejected.worktreePath), 'worktree restored');
  assert.equal(sh('git', ['-C', ejected.worktreePath, 'rev-parse', 'HEAD']), containerHead, 'container commit restored');
  assert.equal(fs.readFileSync(path.join(ejected.worktreePath, 'agent.txt'), 'utf8'), 'built\n');
  assert.match(fs.readFileSync(path.join(ejected.worktreePath, 'app.txt'), 'utf8'), /more-dirty/, 'container dirty state restored');
  assert.ok(fs.existsSync(path.join(ejected.worktreePath, '.orchestra')), 'hooks restored');
  createdWs = ejected;
  log('✓ eject: worktree restored with container commit + uncommitted work + hooks');

  // eject took one more safety snapshot
  const backupsAfter = fs.readdirSync(backupDir).filter((n) => n.endsWith('.tgz'));
  assert.ok(backupsAfter.length > backups.length, 'eject snapshot taken');
  log('✓ eject snapshot taken before restore');

  // 7. delete through the app to clean its own store/worktree
  await evalApp(`window.orchestra.deleteWorkspace(${JSON.stringify(ws.id)})`);
  log('workspace deleted through the app');

  log('ALL REAL-APP BATTLE-TEST CHECKS PASSED');
  cleanup();
  process.exit(0);
}

main().catch((e) => fail('unexpected error', e));
