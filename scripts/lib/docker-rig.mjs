// Shared scaffolding for the REAL-dockerd rigs that drive a REAL keeper + relay (#291/#292): a rig-unique prefix, scratch HOME/ORCHESTRA_HOME under the
// user's cache dir, ground-truth `docker` calls on the REAL socket (never through a relay), a fake member CLI hosted by a real keeper that runs shell
// commands with the env the keeper hands it (DOCKER_HOST → the relay), and label-based cleanup: every container the rig creates carries
// `--label <rigLabel>=<prefix>`, cleanup is BY ID over (name prefix ∪ rig label ∪ orchestra.ws=<prefix> ∪ compose project) — an unnamed or unstamped
// container is still found. e2e-docker-relay.mjs predates this file and keeps its own copy (it is merged + verified; do not refactor it under a gate).

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';

export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const frame = (f) => JSON.stringify(f) + '\n';

export function createDockerRig({ repo, keeperJsEnv = process.env.KEEPER_JS, prefix = 'g8r', rigLabel = 'g8rig', baseDirName = 'g8-rig', image = 'alpine:3' }) {
  const REAL_HOME = os.homedir();
  const ID = randomBytes(4).toString('hex');
  const PFX = `${prefix}${ID}`;
  const CACHE = path.join(REAL_HOME, ['.', 'cache'].join(''));
  const BASE = path.join(process.env.RIG_HOME ?? path.join(CACHE, baseDirName), ID);
  if (!BASE.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${BASE}`);
  fs.rmSync(BASE, { recursive: true, force: true });
  const HOME = path.join(BASE, 'h');
  fs.mkdirSync(path.join(HOME, 'keepers'), { recursive: true });
  fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
  const WS = PFX; // rig-unique workspace id (keeper sockets hash the ws id into /tmp when the path is long)
  const RUN = `${PFX}-run`;

  const REAL_ENV = { ...process.env, HOME: REAL_HOME };
  delete REAL_ENV.DOCKER_HOST;
  const dk = (args, opts = {}) => {
    const r = spawnSync('docker', args, { env: REAL_ENV, encoding: 'utf8', timeout: opts.timeout ?? 60000 });
    return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
  };
  const labelsOf = (name) => {
    const r = dk(['inspect', '-f', '{{json .Config.Labels}}', name]);
    return r.code === 0 ? (JSON.parse(r.out) ?? {}) : null;
  };
  const LBL = `--label ${rigLabel}=${PFX}`;
  const idsBy = (filter) => dk(['ps', '-a', '-q', '--no-trunc', '--filter', filter]).out.split('\n').filter(Boolean);
  const mineIds = () => [...new Set([`name=^${PFX}`, `label=${rigLabel}=${PFX}`, `label=orchestra.ws=${PFX}`, `label=com.docker.compose.project=${PFX}p`].flatMap(idsBy))];
  const mine = () => {
    const ids = mineIds();
    return ids.length ? dk(['inspect', '-f', '{{.Name}}', ...ids]).out.split('\n').filter(Boolean).map((n) => n.replace(/^\//, '')) : [];
  };
  const bystanders = () => {
    const own = new Set(mineIds());
    return dk(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}} {{.State}} {{.Image}}']).out.split('\n').filter((l) => l && !own.has(l.split(' ')[0])).sort();
  };
  const BEFORE = bystanders();
  const cleanup = () => {
    const ids = mineIds();
    if (ids.length) dk(['rm', '-f', '-v', ...ids]);
    for (const kind of ['network', 'volume']) {
      const ls = dk([kind, 'ls', '--filter', `name=^${PFX}`, '--format', '{{.Name}}']).out.split('\n').filter(Boolean);
      if (ls.length) dk([kind, 'rm', ...ls]);
    }
  };

  // keeper bundle (rebuilt from the subject tree when stale) → installed in the scratch HOME
  const KEEPER_SRC = keeperJsEnv ?? path.join(repo, 'dist-electron', 'keeper.js');
  if (!keeperJsEnv) {
    const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts', 'src/keeper/docker-relay.ts', 'src/shared/docker-relay.ts', 'src/shared/docker-endpoint.ts', 'src/shared/docker-labels.ts'].map((s) => path.join(repo, s)).filter((s) => fs.existsSync(s));
    if (!fs.existsSync(KEEPER_SRC) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_SRC).mtimeMs)) {
      execFileSync(process.execPath, [path.join(repo, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: repo, stdio: 'ignore' });
    }
  }
  const KEEPER_JS = path.join(HOME, 'bin', 'keeper.js');
  fs.copyFileSync(KEEPER_SRC, KEEPER_JS);

  const CLI = path.join(BASE, 'cli.cjs');
  fs.writeFileSync(
    CLI,
    `
const { spawn } = require('child_process');
let buf = '';
const out = (o) => process.stdout.write(JSON.stringify(Object.assign({ type: 'assistant' }, o)) + '\\n');
process.stdin.on('data', (d) => {
  buf += d.toString('utf8');
  let i;
  while ((i = buf.indexOf('\\n')) >= 0) {
    const line = buf.slice(0, i); buf = buf.slice(i + 1);
    if (!line.trim()) continue;
    let m; try { m = JSON.parse(line); } catch { continue; }
    if (m.env) { out({ id: m.id, env: Object.fromEntries(Object.entries(process.env).sort()) }); continue; }
    if (!m.sh) continue;
    const p = spawn('bash', ['-c', m.sh], { cwd: m.cwd || process.cwd(), env: process.env });
    let so = '', se = '';
    p.stdout.on('data', (c) => { so += c; });
    p.stderr.on('data', (c) => { se += c; });
    p.on('close', (code) => out({ id: m.id, code, out: so.trim().slice(-4000), err: se.trim().slice(-4000) }));
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`,
  );

  class Client {
    constructor(sock) {
      this.sock = sock;
      this.pending = new Map();
      let acc = '';
      sock.on('data', (d) => {
        acc += d.toString('utf8');
        let i;
        while ((i = acc.indexOf('\n')) >= 0) {
          const l = acc.slice(0, i);
          acc = acc.slice(i + 1);
          if (!l.trim()) continue;
          const f = JSON.parse(l);
          if (f.t === 'stdout') {
            for (const ln of Buffer.from(f.b64, 'base64').toString('utf8').split('\n')) {
              if (!ln.trim()) continue;
              const o = JSON.parse(ln);
              const p = o.id !== undefined ? this.pending.get(o.id) : null;
              if (p) {
                this.pending.delete(o.id);
                p(o.env ?? o);
              }
            }
          }
        }
      });
      sock.on('error', () => {});
    }
    static async dial(p) {
      for (let i = 0; i < 80; i++) {
        try {
          return await new Promise((resolve, reject) => {
            const s = net.connect(p);
            s.once('connect', () => resolve(new Client(s)));
            s.once('error', reject);
          });
        } catch {
          await sleep(100);
        }
      }
      throw new Error('keeper never came up');
    }
    ask(o, timeout = 120000) {
      const id = (this.seq = (this.seq ?? 0) + 1);
      return new Promise((resolve, reject) => {
        const to = setTimeout(() => reject(new Error(`member command timed out: ${JSON.stringify(o).slice(0, 120)}`)), timeout);
        this.pending.set(id, (v) => (clearTimeout(to), resolve(v)));
        this.sock.write(frame({ t: 'stdin', b64: Buffer.from(JSON.stringify({ id, ...o }) + '\n').toString('base64') }));
      });
    }
    sh(cmd, o = {}) {
      return this.ask({ sh: cmd, cwd: o.cwd }, o.timeout);
    }
    envDump() {
      return this.ask({ env: 1 });
    }
    destroy() {
      this.sock.destroy();
    }
  }
  const keepers = [];
  /** A keeper for `ws` hosting the fake member CLI, relay ON (DOCKER_HOST → its relay, labels `orchestra.ws=<ws>` / `orchestra.run=<run>`). */
  async function member({ ws = WS, run = RUN, relay = true, env = {} } = {}) {
    const sock = path.join(HOME, 'keepers', `${ws}.sock`);
    const pidFile = path.join(HOME, 'keepers', `${ws}.pid`);
    const logFile = path.join(HOME, 'keepers', `${ws}.log`);
    spawn(process.execPath, [KEEPER_JS, ws, sock, pidFile, logFile], { detached: true, stdio: 'ignore', env: { ...REAL_ENV, HOME, ORCHESTRA_HOME: HOME, ORCHESTRA_KEEPER_RELAY_CHECK_MS: '200' } }).unref();
    const c = await Client.dial(sock);
    c.sock.write(frame({ t: 'hello', wsId: ws }));
    const frameEnv = { PATH: process.env.PATH, HOME, ...env };
    c.sock.write(frame({ t: 'spawn', command: process.execPath, args: [CLI], cwd: BASE, env: frameEnv, ...(relay ? { dockerRelay: { runId: run } } : {}) }));
    const m = { c, ws, logFile, relaySock: path.join(HOME, 'keepers', `${ws}.docker.sock`), keeperPid: () => JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid };
    keepers.push(m);
    const r = await c.sh('echo up');
    if (r.out !== 'up') throw new Error(`member CLI did not start: ${JSON.stringify(r)}`);
    return m;
  }
  const stopKeepers = () => {
    for (const m of keepers) {
      m.c.destroy();
      try {
        process.kill(m.keeperPid(), 'SIGKILL');
      } catch {
        /* gone */
      }
    }
  };

  const checks = [];
  const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? '').slice(0, 600) }) });

  return { REAL_HOME, ID, PFX, BASE, HOME, WS, RUN, IMG: image, LBL, rigLabel, REAL_ENV, dk, labelsOf, mineIds, mine, bystanders, BEFORE, cleanup, member, stopKeepers, checks, check, sleep };
}
