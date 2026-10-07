// G2 (#291, epic #284, ADR 0004) — the keeper's Docker relay against the host's REAL dockerd.
//
// A REAL keeper daemon (dist-electron/keeper.js) hosts a fake "member" CLI that runs real `docker` / `docker compose`
// with the env the keeper gave it (DOCKER_HOST). Every observable is read back from dockerd itself (`docker inspect`
// over the REAL socket, never through the relay under test). HEAVY rig: needs the OPS's heavy-rig token and
// MemAvailable > 6 GB (the .sh wrapper checks it).
//
//   node scripts/e2e-docker-relay.mjs <arm>      → one JSON line {arm, ok, ...}
//   SUBJECT_REPO=<tree>  drives another tree's src/ + dist-electron/keeper.js (G1: origin/master must FAIL the arms
//                        marked mustFailOnMaster; a master tree has no relay so its keeper ignores `dockerRelay`)
//   KEEPER_JS=<bundle>   use this keeper bundle (e.g. one built from master or a mutant)
//
// SAFETY (ledger #295 D4): scratch ORCHESTRA_HOME/HOME under ~/.cache/g2-rig; every container/network/volume/image the
// rig creates carries the rig-unique name prefix `g2r<id>` and ONLY those are ever removed; the human's own containers
// are snapshotted before/after (id+name+state) and asserted UNCHANGED. The rig never touches the live ~/.orchestra.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const REAL_HOME = os.homedir();
const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';

const ARMS = {
  run_labels: { mustFailOnMaster: true, creates: true }, // docker run/create/start/exec/attach through the relay → labels on the container
  compose_labels: { mustFailOnMaster: true, creates: false }, // (its own `down -v` removes everything; the label inspects prove the containers existed) // docker compose up/ps/exec/down through the relay → labels on every service container
  user_labels: { mustFailOnMaster: true, creates: true }, // the member's own labels survive; a forged orchestra.* label does not
  streams: { mustFailOnMaster: true, creates: true }, // logs -f / events flushed live, 30 MB hijacked stdin, docker cp both ways, docker build (its `…is labelled` check is red on master)
  kill_relay: { mustFailOnMaster: true, creates: true }, // relay killed (SIGUSR2) and socket deleted → keeper restarts it, next call labelled
  no_relay_fallback: { mustFailOnMaster: false, creates: true }, // relay cannot start → DOCKER_HOST unset, docker ps/run still work (unattributed)
  switch_off: { mustFailOnMaster: false, creates: true }, // no dockerRelay in the frame → env byte-identical, no relay socket, unlabelled
  app_switch: { mustFailOnMaster: true, creates: true }, // real makeKeeperSpawn + real scratch bus: frozen ON gets the relay, OFF/default/sandbox never
  sweep_relay_files: { mustFailOnMaster: true, creates: false }, // a dead keeper's relay socket is swept; a live keeper's is spared
};
if (!ARMS[ARM]) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const ID = randomBytes(4).toString('hex'); // rig-unique per invocation
const PFX = `g2r${ID}`;
const BASE = path.join(process.env.G2_RIG_HOME ?? path.join(REAL_HOME, '.cache', 'g2-rig'), ID);
if (!BASE.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${BASE}`);
fs.rmSync(BASE, { recursive: true, force: true });
const HOME = path.join(BASE, 'h'); // scratch HOME + ORCHESTRA_HOME
fs.mkdirSync(path.join(HOME, 'keepers'), { recursive: true });
fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
const WS = `${PFX}`; // workspace id: rig-unique so /tmp/okeeper-<hash> never collides across rigs
const RUN = `${PFX}-run`;
const IMG = 'alpine:3';

// ── real docker, OUTSIDE the relay (cleanup + ground truth) ────────────────────────────────────────────────────
const REAL_ENV = { ...process.env, HOME: REAL_HOME };
delete REAL_ENV.DOCKER_HOST; // the rig's own docker calls always use the real socket
function dk(args, opts = {}) {
  const r = spawnSync('docker', args, { env: REAL_ENV, encoding: 'utf8', timeout: opts.timeout ?? 60000 });
  return { code: r.status ?? -1, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() };
}
const labelsOf = (name) => {
  const r = dk(['inspect', '-f', '{{json .Config.Labels}}', name]);
  if (r.code !== 0) return null;
  return JSON.parse(r.out) ?? {};
};
const mine = () => dk(['ps', '-a', '--filter', `name=^${PFX}`, '--format', '{{.Names}}']).out.split('\n').filter(Boolean);

/** The human's/other fleets' containers: everything NOT carrying the rig prefix, id+name+state (Status embeds
 *  relative times that drift while the rig runs, so it is deliberately not compared). */
function bystanders() {
  const r = dk(['ps', '-a', '--format', '{{.ID}} {{.Names}} {{.State}} {{.Image}}']);
  return r.out.split('\n').filter((l) => l && !l.split(' ')[1].startsWith(PFX)).sort();
}
const BEFORE = bystanders();

function cleanup() {
  const names = mine();
  if (names.length) dk(['rm', '-f', '-v', ...names]);
  for (const kind of ['network', 'volume']) {
    const ls = dk([kind, 'ls', '--filter', `name=^${PFX}`, '--format', '{{.Name}}']).out.split('\n').filter(Boolean);
    if (ls.length) dk([kind, 'rm', ...ls]);
  }
  const imgs = dk(['images', '--format', '{{.Repository}}:{{.Tag}}', `${PFX}-img`]).out.split('\n').filter((i) => i.startsWith(`${PFX}-img`));
  if (imgs.length) dk(['rmi', ...imgs]);
}

// ── keeper bundle ───────────────────────────────────────────────────────────────────────────────────────────────
const KEEPER_SRC = process.env.KEEPER_JS ?? path.join(REPO, 'dist-electron', 'keeper.js');
if (!process.env.KEEPER_JS) {
  const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts', 'src/keeper/docker-relay.ts', 'src/shared/docker-relay.ts']
    .map((s) => path.join(REPO, s))
    .filter((s) => fs.existsSync(s));
  if (!fs.existsSync(KEEPER_SRC) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_SRC).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
}
const KEEPER_JS = path.join(HOME, 'bin', 'keeper.js');
fs.copyFileSync(KEEPER_SRC, KEEPER_JS);

// ── the fake member CLI: runs shell commands with the env the keeper handed it ──────────────────────────────────
// {"id":n,"sh":"…"} → {id,code,out,err}; with "stream":true also {id,chunk:[ms-since-start,text]} per stdout chunk.
const CLI = path.join(BASE, 'cli.cjs');
fs.writeFileSync(CLI, `
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
    const t0 = Date.now();
    const p = spawn('bash', ['-c', m.sh], { cwd: m.cwd || process.cwd(), env: process.env });
    let so = '', se = '';
    p.stdout.on('data', (c) => { so += c; if (m.stream) out({ id: m.id, chunk: [Date.now() - t0, String(c)] }); });
    p.stderr.on('data', (c) => { se += c; });
    p.on('close', (code) => out({ id: m.id, code, out: so.trim().slice(-4000), err: se.trim().slice(-4000), ms: Date.now() - t0 }));
  }
});
process.stdin.on('end', () => process.exit(0));
setInterval(() => {}, 1000);
`);

// ── a keeper client (the frame protocol, byte-compatible with src/shared/keeper-protocol.ts) ────────────────────
const frame = (f) => JSON.stringify(f) + '\n';
class Client {
  constructor(sock) {
    this.sock = sock;
    this.frames = [];
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
        this.frames.push(f);
        if (f.t === 'stdout') {
          for (const ln of Buffer.from(f.b64, 'base64').toString('utf8').split('\n')) {
            if (!ln.trim()) continue;
            const o = JSON.parse(ln);
            if (o.id !== undefined) this.onLine(o);
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
  onLine(o) {
    const p = this.pending.get(o.id);
    if (!p) return;
    if (o.env) {
      this.pending.delete(o.id);
      p.resolve(o.env);
    } else if (o.chunk) p.chunks.push(o.chunk);
    else {
      this.pending.delete(o.id);
      p.resolve({ ...o, chunks: p.chunks });
    }
  }
  /** Run `sh` in the member; resolves {code,out,err,ms,chunks}. */
  sh(cmd, { stream = false, cwd, timeout = 120000 } = {}) {
    const id = (this.seq = (this.seq ?? 0) + 1);
    return new Promise((resolve, reject) => {
      const to = setTimeout(() => reject(new Error(`member command timed out: ${cmd.slice(0, 120)}`)), timeout);
      this.pending.set(id, { chunks: [], resolve: (v) => (clearTimeout(to), resolve(v)) });
      this.sock.write(frame({ t: 'stdin', b64: Buffer.from(JSON.stringify({ id, sh: cmd, stream, cwd }) + '\n').toString('base64') }));
    });
  }
  envDump() {
    const id = (this.seq = (this.seq ?? 0) + 1);
    return new Promise((resolve) => {
      this.pending.set(id, { chunks: [], resolve });
      this.sock.write(frame({ t: 'stdin', b64: Buffer.from(JSON.stringify({ id, env: 1 }) + '\n').toString('base64') }));
    });
  }
  destroy() {
    this.sock.destroy();
  }
}
const keepers = [];
/** Launch a keeper for `ws`, claim it, spawn the member CLI. `relay` = send `dockerRelay`; `env` = member env extras. */
async function member({ ws = WS, run = RUN, relay = true, env = {}, keeperEnv = {}, blockRelaySock = false } = {}) {
  const sock = path.join(HOME, 'keepers', `${ws}.sock`);
  const pidFile = path.join(HOME, 'keepers', `${ws}.pid`);
  const logFile = path.join(HOME, 'keepers', `${ws}.log`);
  if (blockRelaySock) fs.mkdirSync(path.join(HOME, 'keepers', `${ws}.docker.sock`, 'blocker'), { recursive: true });
  const k = spawn(process.execPath, [KEEPER_JS, ws, sock, pidFile, logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...REAL_ENV, HOME, ORCHESTRA_HOME: HOME, ORCHESTRA_KEEPER_RELAY_CHECK_MS: '200', ...keeperEnv },
  });
  k.unref();
  const c = await Client.dial(sock);
  c.sock.write(frame({ t: 'hello', wsId: ws }));
  const frameEnv = { PATH: process.env.PATH, HOME, ...env };
  c.frameEnv = frameEnv;
  c.sock.write(frame({ t: 'spawn', command: process.execPath, args: [CLI], cwd: BASE, env: frameEnv, ...(relay ? { dockerRelay: { runId: run } } : {}) }));
  const m = { c, ws, sock, pidFile, logFile, relaySock: path.join(HOME, 'keepers', `${ws}.docker.sock`), keeperPid: () => JSON.parse(fs.readFileSync(pidFile, 'utf8')).pid };
  keepers.push(m);
  // wait for the CLI to be alive
  const r = await c.sh('echo up');
  if (r.out !== 'up') throw new Error(`member CLI did not start: ${JSON.stringify(r)}`);
  return m;
}
function stopKeepers() {
  for (const m of keepers) {
    m.c.destroy();
    try {
      process.kill(m.keeperPid(), 'SIGKILL');
    } catch {
      /* gone */
    }
  }
}

// ── assertions ──────────────────────────────────────────────────────────────────────────────────────────────────
const checks = [];
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? '').slice(0, 600) }) });
const stamped = (name) => {
  const l = labelsOf(name);
  return l && l['orchestra.ws'] === WS && l['orchestra.run'] === RUN;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── arms ────────────────────────────────────────────────────────────────────────────────────────────────────────
const runArm = {
  async run_labels() {
    const m = await member();
    const env = await m.c.envDump();
    check('DOCKER_HOST points at the keeper relay', env.DOCKER_HOST === `unix://${m.relaySock}`, env.DOCKER_HOST);
    let r = await m.c.sh(`docker run -d --name ${PFX}-a ${IMG} sleep 300`);
    check('docker run -d succeeds through the relay', r.code === 0, r.err);
    check('docker run → container labelled orchestra.ws + orchestra.run', stamped(`${PFX}-a`), JSON.stringify(labelsOf(`${PFX}-a`)));
    r = await m.c.sh(`docker ps --filter name=^${PFX}-a --format '{{.Names}}'`);
    check('docker ps lists it through the relay', r.out === `${PFX}-a`, r.out + r.err);
    r = await m.c.sh(`docker exec ${PFX}-a echo hello-exec`);
    check('docker exec (hijacked) works', r.out === 'hello-exec', r.out + r.err);
    r = await m.c.sh(`printf ping | docker run --rm -i ${IMG} cat`);
    check('docker run -i (hijacked attach, stdin piped) round-trips', r.out === 'ping', r.out + r.err);
    r = await m.c.sh(`docker create --name ${PFX}-c ${IMG} echo done && docker start -a ${PFX}-c`);
    check('docker create + start -a works', r.out.endsWith('done'), r.out + r.err);
    check('docker create → labelled', stamped(`${PFX}-c`), JSON.stringify(labelsOf(`${PFX}-c`)));
    r = await m.c.sh(`docker logs ${PFX}-c`);
    check('docker logs works', r.out === 'done', r.out + r.err);
    r = await m.c.sh(`docker stop ${PFX}-a && docker start ${PFX}-a && docker inspect -f '{{.State.Running}}' ${PFX}-a`);
    check('docker stop/start works and the stamp survives a restart', r.out.endsWith('true') && stamped(`${PFX}-a`), r.out + r.err);
  },

  async compose_labels() {
    const m = await member();
    const proj = `${PFX}p`;
    const dir = path.join(BASE, 'compose');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(
      path.join(dir, 'compose.yaml'),
      `services:\n  web:\n    image: ${IMG}\n    command: ["sleep","300"]\n    labels:\n      team: x\n  db:\n    image: ${IMG}\n    command: ["sleep","300"]\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n`,
    );
    let r = await m.c.sh(`docker compose -p ${proj} up -d`, { cwd: dir });
    check('docker compose up -d succeeds through the relay', r.code === 0, r.err);
    for (const svc of ['web', 'db']) {
      const n = `${proj}-${svc}-1`;
      const l = labelsOf(n);
      check(`compose ${svc} container labelled`, l && l['orchestra.ws'] === WS && l['orchestra.run'] === RUN, JSON.stringify(l));
      check(`compose ${svc} keeps its compose labels`, l && l['com.docker.compose.project'] === proj, JSON.stringify(l));
    }
    check('compose service label survives', labelsOf(`${proj}-web-1`)?.team === 'x', JSON.stringify(labelsOf(`${proj}-web-1`)));
    const idBefore = dk(['inspect', '-f', '{{.Id}}', `${proj}-web-1`]).out;
    r = await m.c.sh(`docker compose -p ${proj} up -d`, { cwd: dir });
    const idAfter = dk(['inspect', '-f', '{{.Id}}', `${proj}-web-1`]).out;
    check('a second compose up converges (the labels do not make compose recreate)', r.code === 0 && idBefore === idAfter, `${idBefore} -> ${idAfter} ${r.err}`);
    r = await m.c.sh(`docker compose -p ${proj} ps --format '{{.Name}}'`, { cwd: dir });
    check('compose ps works', r.out.split('\n').sort().join() === `${proj}-db-1,${proj}-web-1`, r.out + r.err);
    r = await m.c.sh(`docker compose -p ${proj} exec -T web echo from-compose`, { cwd: dir });
    check('compose exec works', r.out === 'from-compose', r.out + r.err);
    r = await m.c.sh(`docker compose -p ${proj} down -v`, { cwd: dir });
    check('compose down works', r.code === 0 && mine().filter((n) => n.startsWith(proj)).length === 0, r.err + mine());
  },

  async user_labels() {
    const m = await member();
    const r = await m.c.sh(`docker run -d --name ${PFX}-u --label team=x --label orchestra.ws=forged --label orchestra.run=forged ${IMG} sleep 300`);
    check('docker run with forged labels succeeds', r.code === 0, r.err);
    const l = labelsOf(`${PFX}-u`) ?? {};
    check('the member’s own label is kept', l.team === 'x', JSON.stringify(l));
    check('a forged orchestra.ws / orchestra.run LOSES to the host stamp', l['orchestra.ws'] === WS && l['orchestra.run'] === RUN, JSON.stringify(l));
  },

  async streams() {
    const m = await member();
    // logs -f flushed while the container is still emitting
    let r = await m.c.sh(`docker run -d --name ${PFX}-s ${IMG} sh -c 'i=0; while [ $i -lt 24 ]; do echo line$i; i=$((i+1)); sleep 0.25; done; sleep 120'`);
    check('streaming container started', r.code === 0, r.err);
    r = await m.c.sh(`timeout 8 docker logs -f ${PFX}-s`, { stream: true });
    const ts = r.chunks.map((c) => c[0]);
    const lines = r.chunks.map((c) => c[1]).join('').split('\n').filter(Boolean);
    check('logs -f delivers lines LIVE (first well before the last, many separate chunks)', ts.length >= 8 && ts[ts.length - 1] - ts[0] >= 3000, JSON.stringify(ts));
    check('logs -f content complete and in order', lines.length >= 24 && lines[0] === 'line0' && lines[23] === 'line23', lines.length + ' ' + lines.slice(0, 2));
    // events flushed live: the first event arrives while the stream is still open
    const ev = m.c.sh(`timeout 10 docker events --filter container=${PFX}-ev --filter event=create --format '{{.Action}}'`, { stream: true });
    await sleep(1500);
    await m.c.sh(`docker create --name ${PFX}-ev ${IMG} true`);
    const evr = await ev;
    check('docker events streams the create event live', evr.chunks.length >= 1 && evr.chunks[0][1].trim() === 'create' && evr.chunks[0][0] < 8000, JSON.stringify(evr.chunks));
    check('…and that container is labelled', stamped(`${PFX}-ev`), JSON.stringify(labelsOf(`${PFX}-ev`)));
    // 30 MB hijacked stdin, integrity by checksum
    const big = path.join(BASE, 'big.bin');
    fs.writeFileSync(big, randomBytes(30 * 1024 * 1024));
    const want = sha(fs.readFileSync(big));
    r = await m.c.sh(`docker run --rm -i ${IMG} sha256sum < ${big}`, { timeout: 180000 });
    check('30 MB through a hijacked attach arrives intact (sha256)', r.out.startsWith(want), r.out + r.err);
    // docker cp both ways (large streamed tar bodies)
    r = await m.c.sh(`docker cp ${big} ${PFX}-s:/tmp/big && docker cp ${PFX}-s:/tmp/big ${BASE}/big.back`, { timeout: 180000 });
    check('docker cp up and down works', r.code === 0 && fs.existsSync(`${BASE}/big.back`) && sha(fs.readFileSync(`${BASE}/big.back`)) === want, r.err);
    // docker build (BuildKit /session + /grpc h2c upgrades, or the legacy chunked tar upload)
    const bdir = path.join(BASE, 'build');
    fs.mkdirSync(bdir, { recursive: true });
    fs.writeFileSync(path.join(bdir, 'Dockerfile'), `FROM ${IMG}\nRUN echo built-through-relay > /built\n`);
    r = await m.c.sh(`docker build -q -t ${PFX}-img:1 ${bdir}`, { timeout: 240000 });
    check('docker build through the relay succeeds', r.code === 0, r.err);
    r = await m.c.sh(`docker run --rm ${PFX}-img:1 cat /built`);
    check('the built image runs and has the layer', r.out === 'built-through-relay', r.out + r.err);
  },

  async kill_relay() {
    const m = await member();
    let r = await m.c.sh(`docker run -d --name ${PFX}-k1 ${IMG} sleep 300`);
    check('baseline create labelled', r.code === 0 && stamped(`${PFX}-k1`), r.err);
    const ino0 = fs.statSync(m.relaySock).ino;
    process.kill(m.keeperPid(), 'SIGUSR2'); // the relay "crashes"
    let ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await sleep(100);
      r = await m.c.sh(`docker ps -q >/dev/null`);
      ok = r.code === 0;
    }
    check('docker works again within 5 s of the kill', ok, r.err);
    check('the relay is a NEW listener (socket inode changed)', fs.existsSync(m.relaySock) && fs.statSync(m.relaySock).ino !== ino0);
    r = await m.c.sh(`docker run -d --name ${PFX}-k2 ${IMG} sleep 300`);
    check('a create AFTER the kill is labelled', r.code === 0 && stamped(`${PFX}-k2`), r.err);
    // the socket file removed under a live relay
    const ino1 = fs.statSync(m.relaySock).ino;
    fs.unlinkSync(m.relaySock);
    ok = false;
    for (let i = 0; i < 50 && !ok; i++) {
      await sleep(100);
      r = await m.c.sh(`docker ps -q >/dev/null`);
      ok = r.code === 0;
    }
    check('a deleted relay socket is restored and docker works', ok && fs.existsSync(m.relaySock) && fs.statSync(m.relaySock).ino !== ino1, r.err);
    r = await m.c.sh(`docker run -d --name ${PFX}-k3 ${IMG} sleep 300`);
    check('a create after the socket restore is labelled', r.code === 0 && stamped(`${PFX}-k3`), r.err);
    check('the keeper logged the restarts', /docker relay: restarted/.test(fs.readFileSync(m.logFile, 'utf8')));
  },

  async no_relay_fallback() {
    const m = await member({ blockRelaySock: true });
    const env = await m.c.envDump();
    check('relay cannot start → DOCKER_HOST is UNSET in the member', env.DOCKER_HOST === undefined, env.DOCKER_HOST);
    let r = await m.c.sh('docker ps -q >/dev/null');
    check('docker ps still works on the real socket', r.code === 0, r.err);
    r = await m.c.sh(`docker run -d --name ${PFX}-f ${IMG} sleep 300`);
    const l = labelsOf(`${PFX}-f`);
    check('a container made on the real socket is UNATTRIBUTED (no orchestra.* label)', r.code === 0 && l && l['orchestra.ws'] === undefined && l['orchestra.run'] === undefined, JSON.stringify(l));
    check('the keeper logged why', /docker relay disabled/.test(fs.readFileSync(m.logFile, 'utf8')));
    // a second variant: the real socket path the member would use does not exist → also no relay, env untouched
    const m2 = await member({ ws: `${PFX}b`, env: { ORCHESTRA_DOCKER_SOCKET: path.join(BASE, 'nonexistent.sock') } });
    const env2 = await m2.c.envDump();
    check('real docker socket missing → DOCKER_HOST unset', env2.DOCKER_HOST === undefined, env2.DOCKER_HOST);
  },

  async switch_off() {
    const m = await member({ relay: false });
    const env = await m.c.envDump();
    const sent = Object.fromEntries(Object.entries(m.c.frameEnv).sort());
    check('switch OFF: the member env is EXACTLY the frame env (byte-identical to today)', JSON.stringify(env) === JSON.stringify(sent), JSON.stringify(env));
    check('DOCKER_HOST never set', env.DOCKER_HOST === undefined);
    check('no relay socket exists', !fs.existsSync(m.relaySock));
    const r = await m.c.sh(`docker run -d --name ${PFX}-o ${IMG} sleep 300`);
    const l = labelsOf(`${PFX}-o`);
    check('docker works and the container is NOT stamped', r.code === 0 && l && l['orchestra.ws'] === undefined, JSON.stringify(l));
    check('the keeper never mentions a relay', !/docker relay/.test(fs.readFileSync(m.logFile, 'utf8')));
  },

  async app_switch() {
    // The REAL app path: scratch bus (runs with FROZEN switches) → dockerRelaySpecFor → the real makeKeeperSpawn facade.
    process.env.ORCHESTRA_HOME = HOME;
    process.env.HOME = HOME;
    const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
    initPlatform({
      kind: 'headless-docker-relay-g2',
      broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
      openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
      getUserDataDir: () => HOME, getLogsDir: () => `${HOME}/logs`, getAppVersion: () => '0.0.0-g2', getAppMetrics: () => [],
      isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
    });
    (await import(`${REPO}/src/main/logger.ts`)).initLogger();
    const { initBus, getBus } = await import(`${REPO}/src/main/bus.ts`);
    const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
    const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
    const { dockerRelaySpecFor } = await import(`${REPO}/src/main/docker-relay-switch.ts`);
    const kc = await import(`${REPO}/src/main/keeper-client.ts`);
    initBus();
    const db = getBus();
    startRun(db, { id: `${PFX}-on`, kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, dockerRelay: true });
    startRun(db, { id: `${PFX}-off`, kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES });
    // A member CLI behind the REAL facade: it runs `bash -c` lines the test writes to the SDK's stdin.
    async function viaFacade(ws, runId, remote) {
      const spec = dockerRelaySpecFor(runId, remote);
      const proc = kc.makeKeeperSpawn(ws, undefined, spec)({ command: process.execPath, args: [CLI], cwd: BASE, env: { PATH: process.env.PATH, HOME }, signal: new AbortController().signal });
      let acc = '';
      const waiters = [];
      proc.stdout.on('data', (d) => {
        acc += d.toString('utf8');
        for (const w of waiters.splice(0)) w();
      });
      const ask = async (o) => {
        proc.stdin.write(JSON.stringify(o) + '\n');
        for (let i = 0; i < 100; i++) {
          const hit = acc.split('\n').filter(Boolean).map((l) => JSON.parse(l)).find((x) => x.id === o.id);
          if (hit) return hit;
          await new Promise((r) => (waiters.push(r), setTimeout(r, 100)));
        }
        throw new Error('no reply');
      };
      const env = (await ask({ id: 1, env: 1 })).env;
      return { spec, env, ask, proc };
    }
    kc.installKeeper?.();
    const on = await viaFacade(`${PFX}-won`, `${PFX}-on`, false);
    check('frozen ON → the facade sent the relay and the member has DOCKER_HOST at its relay', !!on.spec && on.env.DOCKER_HOST === `unix://${kc.keeperRelaySocketPath(`${PFX}-won`)}`, JSON.stringify([on.spec, on.env.DOCKER_HOST]));
    const r = await on.ask({ id: 2, sh: `docker run -d --name ${PFX}-w ${IMG} sleep 300` });
    const l = labelsOf(`${PFX}-w`) ?? {};
    check('…and its container carries that run id', r.code === 0 && l['orchestra.run'] === `${PFX}-on` && l['orchestra.ws'] === `${PFX}-won`, JSON.stringify(l));
    const off = await viaFacade(`${PFX}-woff`, `${PFX}-off`, false);
    check('frozen OFF → no relay, no DOCKER_HOST', off.spec === undefined && off.env.DOCKER_HOST === undefined, JSON.stringify([off.spec, off.env.DOCKER_HOST]));
    const def = await viaFacade(`${PFX}-wdef`, `${PFX}-nope`, false);
    check('a run with no row (default) → no relay', def.spec === undefined && def.env.DOCKER_HOST === undefined);
    const sbx = await viaFacade(`${PFX}-wsbx`, `${PFX}-on`, true);
    check('a sandbox-hosted member is NEVER given the relay even on an ON run', sbx.spec === undefined && sbx.env.DOCKER_HOST === undefined, JSON.stringify([sbx.spec, sbx.env.DOCKER_HOST]));
    for (const ws of [`${PFX}-won`, `${PFX}-woff`, `${PFX}-wdef`, `${PFX}-wsbx`]) await kc.killKeeper(ws, 'g2-rig');
  },

  async sweep_relay_files() {
    process.env.ORCHESTRA_HOME = HOME;
    process.env.HOME = HOME;
    const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
    initPlatform({
      kind: 'headless-docker-relay-g2',
      broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
      openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
      getUserDataDir: () => HOME, getLogsDir: () => `${HOME}/logs`, getAppVersion: () => '0.0.0-g2', getAppMetrics: () => [],
      isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
    });
    (await import(`${REPO}/src/main/logger.ts`)).initLogger();
    const kc = await import(`${REPO}/src/main/keeper-client.ts`);
    if (typeof kc.keeperRelaySocketPath !== 'function') {
      check('keeper-client exposes keeperRelaySocketPath', false, 'absent in this tree');
      return;
    }
    const m = await member();
    check('live keeper: relay socket exists', fs.existsSync(m.relaySock));
    await kc.sweepStaleKeeperFiles(WS);
    check('a LIVE keeper’s relay socket is spared by the sweep', fs.existsSync(m.relaySock));
    // a dead keeper's leftovers: SIGKILL (no cleanup) then sweep
    m.c.destroy();
    process.kill(m.keeperPid(), 'SIGKILL');
    await sleep(500);
    check('SIGKILLed keeper leaves its relay socket behind (the stale file the sweep exists for)', fs.existsSync(m.relaySock));
    await kc.sweepStaleKeeperFiles(WS);
    check('the sweep removes a dead keeper’s relay socket', !fs.existsSync(m.relaySock), m.relaySock);
  },
};

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let fatal = null;
const t0 = Date.now();
try {
  await runArm[ARM]();
} catch (e) {
  fatal = e;
  check('arm completed without throwing', false, e?.stack ?? e);
}
stopKeepers();
const mineBefore = mine();
cleanup();
const leftover = mine();
const AFTER = bystanders();
const unchanged = JSON.stringify(BEFORE) === JSON.stringify(AFTER);
if (ARMS[ARM].creates) check('positive control: the cleanup filter SEES the rig containers (so "none left" means something)', mineBefore.length > 0, 'mine() saw none');
check('every rig container removed', leftover.length === 0, leftover.join(','));
check(`bystander containers UNCHANGED (${BEFORE.length} before / ${AFTER.length} after)`, unchanged, unchanged ? '' : `before=${JSON.stringify(BEFORE)} after=${JSON.stringify(AFTER)}`);
fs.rmSync(BASE, { recursive: true, force: true });
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ arm: ARM, ok, mustFailOnMaster: ARMS[ARM].mustFailOnMaster, id: ID, ms: Date.now() - t0, rigContainers: mineBefore.length, checks, fatal: fatal ? String(fatal.message ?? fatal) : undefined }));
process.exit(ok ? 0 : 1);
