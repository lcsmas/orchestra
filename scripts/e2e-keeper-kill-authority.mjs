// S3 KILL AUTHORITY (D3) — the half scripts/e2e-stop-semantics.mjs's stub cannot
// show: that the killKeeper sdkStop falls through to actually TERMINATES both
// the keeper daemon pid AND the CLI child pid — the exact observable G3 names.
//
// Spawns the REAL built keeper daemon (dist-electron/keeper.js) owning a REAL
// child (a fake CLI that speaks stream-json but NEVER emits a `result` — the D3
// condition), detaches (as the app does after a quit), then calls the REAL
// killKeeper(wsId) from src/main/keeper-client.ts and asserts both pids die
// within 20 s and the socket/pid artifacts are swept.
//
// Must run under the R2 resolve hook (keeper-client.ts imports extensionless
// specifiers):
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//        scripts/e2e-keeper-kill-authority.mjs

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import {
  createLineSplitter,
  encodeKeeperFrame,
  parseKeeperFrame,
} from '../src/shared/keeper-protocol.ts';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
const KILL_TIMEOUT_MS = 20_000;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

function fail(msg) {
  console.log(JSON.stringify({ ok: false, error: msg }));
  process.exit(1);
}

// Build the keeper bundle if stale (matches src/keeper/keeper.test.ts).
{
  const srcs = [
    path.join(REPO, 'src', 'keeper', 'index.ts'),
    path.join(REPO, 'src', 'shared', 'keeper-protocol.ts'),
  ];
  const stale =
    !fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs);
  if (stale) {
    execFileSync(
      process.execPath,
      [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'],
      { cwd: REPO, stdio: 'ignore' },
    );
  }
}

// A CLI that speaks stream-json but NEVER emits a `result` — the D3 condition.
const FAKE_CLI_NO_RESULT = `
process.stdin.resume();
process.stdout.write(JSON.stringify({ type: 'system', subtype: 'init' }) + '\\n');
setInterval(() => {}, 1000);
`;

class Client {
  frames = [];
  #waiters = [];
  #sock;
  constructor(sock) {
    this.#sock = sock;
    sock.on(
      'data',
      createLineSplitter((line) => {
        const f = parseKeeperFrame(line);
        if (f) {
          this.frames.push(f);
          this.#waiters.splice(0).forEach((w) => w());
        }
      }),
    );
    sock.on('error', () => {});
  }
  static dial(p) {
    return new Promise((resolve, reject) => {
      const s = net.connect(p);
      s.once('connect', () => resolve(new Client(s)));
      s.once('error', reject);
    });
  }
  send(f) {
    this.#sock.write(encodeKeeperFrame(f));
  }
  async wait(pred, ms = 5000) {
    const t0 = Date.now();
    for (;;) {
      const hit = this.frames.find(pred);
      if (hit) return hit;
      if (Date.now() - t0 > ms) throw new Error('timeout waiting for keeper frame');
      await new Promise((r) => {
        this.#waiters.push(r);
        setTimeout(r, 100);
      });
    }
  }
  destroy() {
    this.#sock.destroy();
  }
}

/** First child pid whose ppid is `ppid`, from /proc. */
function childOf(ppid) {
  for (const entry of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(entry)) continue;
    try {
      const stat = fs.readFileSync(`/proc/${entry}/stat`, 'utf8');
      const rp = stat.lastIndexOf(')');
      const fields = stat.slice(rp + 2).split(' ');
      if (Number(fields[1]) === ppid) return Number(entry);
    } catch {
      /* vanished */
    }
  }
  return undefined;
}

// ── Isolated ORCHESTRA_HOME, laid out as keeper-client.ts expects ─────────────
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'kill-authority-'));
process.env.ORCHESTRA_HOME = home;
const keepersDir = path.join(home, 'keepers');
fs.mkdirSync(keepersDir, { recursive: true });

const wsId = 'ws-kill-authority';
const sock = path.join(keepersDir, `${wsId}.sock`);
const pidFile = path.join(keepersDir, `${wsId}.pid`);
const logFile = path.join(keepersDir, `${wsId}.log`);
const fakeCli = path.join(home, 'fake-cli.cjs');
fs.writeFileSync(fakeCli, FAKE_CLI_NO_RESULT);

const keeper = spawn(process.execPath, [KEEPER_JS, wsId, sock, pidFile, logFile], {
  detached: true,
  stdio: 'ignore',
  env: { ...process.env },
});
keeper.unref();

process.on('exit', () => {
  try {
    process.kill(keeper.pid, 'SIGKILL');
  } catch {
    /* gone */
  }
  fs.rmSync(home, { recursive: true, force: true });
});

const isAck = (f) => f.t === 'helloAck';

let c;
for (let i = 0; i < 50 && !c; i++) {
  try {
    c = await Client.dial(sock);
  } catch {
    await sleep(100);
  }
}
if (!c) fail('keeper never came up');
c.send({ t: 'hello', wsId });
await c.wait(isAck);
c.send({ t: 'spawn', command: process.execPath, args: [fakeCli], cwd: home, env: { PATH: process.env.PATH } });

await sleep(400);
const keeperPid = JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid;
if (!alive(keeperPid)) fail('keeper pid not alive after spawn');

const probe = await Client.dial(sock);
probe.send({ t: 'hello', wsId });
const ack = await probe.wait(isAck);
if (ack.running !== true) fail('never-result CLI child not running (helloAck.running !== true)');
probe.destroy();
c.destroy(); // detach

const childPid = childOf(keeperPid);
if (!childPid || !alive(childPid)) fail(`no live CLI child of keeper ${keeperPid} (got ${childPid})`);

// ── THE ACT: the real killKeeper ─────────────────────────────────────────────
const { killKeeper } = await import(`${REPO}/src/main/keeper-client.ts`);
const t0 = Date.now();
await killKeeper(wsId);
for (let i = 0; i < 200 && (alive(keeperPid) || alive(childPid)); i++) await sleep(100);
const elapsedMs = Date.now() - t0;

const keeperDead = !alive(keeperPid);
const childDead = !alive(childPid);
const sockSwept = !fs.existsSync(sock);
const pidSwept = !fs.existsSync(pidFile);
const ok = keeperDead && childDead && sockSwept && pidSwept && elapsedMs < KILL_TIMEOUT_MS;

console.log(
  JSON.stringify({ ok, keeperPid, childPid, keeperDead, childDead, sockSwept, pidSwept, elapsedMs, budgetMs: KILL_TIMEOUT_MS }),
);
process.exit(ok ? 0 : 1);
