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
// #321 (wave H): the hold_* arms drive the Docker HOLD — a container create/start through the relay WAITS while the app-published Admission state says held, and goes out by itself when memory is back.
// "Low memory" is SIMULATED by what the app publishes (the real `createDockerHold().publish` of a guard snapshot, or — hold_guard_chain — the REAL guard fed a fake meter): this host's memory is never pressured.
//
// SAFETY (ledger #295 D4): scratch ORCHESTRA_HOME/HOME under ~/.cache/g2-rig; every container/network/volume/image the
// rig creates carries the rig-unique name prefix `g2r<id>` AND the label `g2rig=g2r<id>` (an unnamed `docker run --rm`, or a
// container a MUTANT left unstamped, is still found: cleanup is by LABEL, never by name alone) and ONLY those are ever removed; the human's own containers
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
  late_daemon: { mustFailOnMaster: true, creates: true }, // F4 (follow-up): dockerd socket absent at spawn → relay still up (502), stamps once the daemon appears
  hold_create: { mustFailOnMaster: true, creates: true }, // #321: held ⇒ `docker run` WAITS (dockerd sees nothing), visible (hold file, bus-status line, one notice, create Warning); memory back ⇒ it passes by itself
  hold_start: { mustFailOnMaster: true, creates: true }, // #321: `docker start` of a container THIS relay stamped waits too, and passes when memory is back
  hold_unattributed: { mustFailOnMaster: true, creates: true }, // #321: a container made around the relay / another workspace's / already running is NEVER held (+ positive control: the stamped one is)
  hold_fresh_reading: { mustFailOnMaster: true, creates: true }, // #321: the guard says OPEN but a FRESH MemAvailable reading is still below threshold+margin ⇒ stays in line
  hold_fail_open: { mustFailOnMaster: true, creates: true }, // #321: no / stale / garbage / foreign-version state ⇒ never held; a line already waiting is flushed when the state goes; no holdState in the frame ⇒ no hold (its positive control is red on master)
  hold_client_leaves: { mustFailOnMaster: true, creates: true }, // #321: a client that gives up while held never has its create sent; the line goes on without it
  hold_one_at_a_time: { mustFailOnMaster: true, creates: true }, // #321: the line is released FIFO, ONE at a time with a settle between (not a thundering herd)
  hold_long_wait: { mustFailOnMaster: true, creates: true }, // #321 (OPS b): a multi-minute hold against the docker CLI, compose, a 200 KB create body, node http and curl — reports the first client that cuts (`measured`)
  hold_guard_chain: { mustFailOnMaster: true, creates: true }, // #321: the REAL guard (fake meter) → real publisher → real keeper → real dockerd: low ⇒ waits, hysteresis reopen ⇒ passes
  api_real: { mustFailOnMaster: true, creates: true }, // F2 (follow-up): the APP's docker-api lists/stops/starts what the relay stamped, on the real daemon
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
const LBL = `--label g2rig=${PFX}`; // on EVERY container the rig creates (see header)
const idsBy = (filter) => dk(['ps', '-a', '-q', '--no-trunc', '--filter', filter]).out.split('\n').filter(Boolean);
/** Every container this rig run owns: by name prefix, by the rig label, by the workspace label the relay stamps, by compose project. */
const mineIds = () => [...new Set([`name=^${PFX}`, `label=g2rig=${PFX}`, `label=orchestra.ws=${PFX}`, `label=com.docker.compose.project=${PFX}p`].flatMap(idsBy))];
const mine = () => {
  const ids = mineIds();
  return ids.length ? dk(['inspect', '-f', '{{.Name}}', ...ids]).out.split('\n').filter(Boolean).map((n) => n.replace(/^\//, '')) : [];
};

/** The human's/other fleets' containers: everything NOT owned by this rig run, id+name+state+image (Status embeds relative
 *  times that drift while the rig runs, so it is deliberately not compared). */
function bystanders() {
  const own = new Set(mineIds());
  const r = dk(['ps', '-a', '--no-trunc', '--format', '{{.ID}} {{.Names}} {{.State}} {{.Image}}']);
  return r.out.split('\n').filter((l) => l && !own.has(l.split(' ')[0])).sort();
}
const BEFORE = bystanders();

function cleanup() {
  const ids = mineIds();
  if (ids.length) dk(['rm', '-f', '-v', ...ids]); // by ID: only what this rig owns
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
  const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts', 'src/keeper/docker-relay.ts', 'src/shared/docker-relay.ts', 'src/shared/docker-endpoint.ts', 'src/shared/docker-labels.ts', 'src/keeper/docker-hold.ts', 'src/shared/docker-hold.ts', 'src/shared/memory-guard.ts']
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
async function member({ ws = WS, run = RUN, relay = true, env = {}, keeperEnv = {}, blockRelaySock = false, holdState } = {}) {
  const sock = path.join(HOME, 'keepers', `${ws}.sock`);
  const pidFile = path.join(HOME, 'keepers', `${ws}.pid`);
  const logFile = path.join(HOME, 'keepers', `${ws}.log`);
  if (blockRelaySock) fs.mkdirSync(path.join(HOME, 'keepers', `${ws}.docker.sock`, 'blocker'), { recursive: true });
  const k = spawn(process.execPath, [KEEPER_JS, ws, sock, pidFile, logFile], {
    detached: true,
    stdio: 'ignore',
    env: { ...REAL_ENV, HOME, ORCHESTRA_HOME: HOME, ORCHESTRA_KEEPER_RELAY_CHECK_MS: '200', ORCHESTRA_KEEPER_HOLD_POLL_MS: '100', ORCHESTRA_KEEPER_HOLD_SETTLE_MS: '300', ...keeperEnv },
  });
  k.unref();
  const c = await Client.dial(sock);
  c.sock.write(frame({ t: 'hello', wsId: ws }));
  const frameEnv = { PATH: process.env.PATH, HOME, ...env };
  c.frameEnv = frameEnv;
  c.sock.write(frame({ t: 'spawn', command: process.execPath, args: [CLI], cwd: BASE, env: frameEnv, ...(relay ? { dockerRelay: { runId: run, ...(holdState ? { holdState } : {}) } } : {}) }));
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
const measured = {};
const check = (name, ok, detail) => checks.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail ?? '').slice(0, 600) }) });
const stamped = (name) => {
  const l = labelsOf(name);
  return l && l['orchestra.ws'] === WS && l['orchestra.run'] === RUN;
};
const sha = (b) => createHash('sha256').update(b).digest('hex');

// ── arms ────────────────────────────────────────────────────────────────────────────────────────────────────────

// ── #321 hold helpers ───────────────────────────────────────────────────────────────────────────────────────────
const GIB = 1024 ** 3;
const MIB = 1024 * 1024;
const STATE = path.join(HOME, 'admission.state');
const HOLD_FILE = (ws = WS) => path.join(HOME, 'keepers', `${ws}.docker.hold`);
const atomicWrite = (f, text) => {
  const tmp = `${f}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, text);
  fs.renameSync(tmp, f);
};
/** The REAL app-side core (src/main/docker-hold.ts) on real files: `publish` is exactly what the app does at every guard sample. */
async function appCore({ holdFiles = () => [], notify = () => {}, noticeAfterMs = 0, stateFile = STATE } = {}) {
  const { createDockerHold } = await import(`${REPO}/src/main/docker-hold.ts`);
  return createDockerHold({
    stateFile,
    holdFiles,
    now: Date.now,
    readText: (f) => {
      try {
        return fs.readFileSync(f, 'utf8');
      } catch {
        return null;
      }
    },
    writeFile: atomicWrite,
    removeFile: (f) => fs.rmSync(f, { force: true }),
    notify,
    noticeAfterMs,
    warn: () => {},
  });
}
/** Guard snapshots: HELD = Admission held (the relays wait); OPEN thresholds are TINY so the keeper's FRESH real MemAvailable passes; LOW_OPEN = the guard says open but any real reading is below threshold+margin. */
const HELD = (o = {}) => ({ admission: 'held', admissionEnabled: true, heldSince: Date.now() - 2000, episode: 7, availBytes: 4 * GIB, admissionBytes: 6 * GIB, releaseMarginBytes: GIB, ...o });
const OPEN = (o = {}) => ({ admission: 'open', admissionEnabled: true, heldSince: null, episode: 7, availBytes: 12 * GIB, admissionBytes: 64 * MIB, releaseMarginBytes: 0, ...o });
const LOW_OPEN = () => OPEN({ admissionBytes: 4096 * GIB });
let publisher = null;
const publish = async (snap) => void (publisher ??= await appCore()).publish(snap);
/** Start a member command WITHOUT waiting for it: {done(): result|null, wait(ms)}. */
function bg(m, cmd, opts) {
  const o = { res: null };
  const p = m.c.sh(cmd, opts).then((r) => (o.res = r));
  return {
    p,
    done: () => o.res,
    wait: async (ms) => {
      await Promise.race([p, sleep(ms)]);
      return o.res;
    },
  };
}
const exists = (name) => labelsOf(name) !== null;
const running = (name) => dk(['inspect', '-f', '{{.State.Running}}', name]).out === 'true';
const created = (name) => Date.parse(dk(['inspect', '-f', '{{.Created}}', name]).out);
const readHold = (ws = WS) => {
  try {
    return JSON.parse(fs.readFileSync(HOLD_FILE(ws), 'utf8'));
  } catch {
    return null;
  }
};

const runArm = {
  async run_labels() {
    const m = await member();
    const env = await m.c.envDump();
    check('DOCKER_HOST points at the keeper relay', env.DOCKER_HOST === `unix://${m.relaySock}`, env.DOCKER_HOST);
    let r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-a ${IMG} sleep 300`);
    check('docker run -d succeeds through the relay', r.code === 0, r.err);
    check('docker run → container labelled orchestra.ws + orchestra.run', stamped(`${PFX}-a`), JSON.stringify(labelsOf(`${PFX}-a`)));
    r = await m.c.sh(`docker ps --filter name=^${PFX}-a --format '{{.Names}}'`);
    check('docker ps lists it through the relay', r.out === `${PFX}-a`, r.out + r.err);
    r = await m.c.sh(`docker exec ${PFX}-a echo hello-exec`);
    check('docker exec (hijacked) works', r.out === 'hello-exec', r.out + r.err);
    r = await m.c.sh(`printf ping | docker run ${LBL} --rm -i ${IMG} cat`);
    check('docker run -i (hijacked attach, stdin piped) round-trips', r.out === 'ping', r.out + r.err);
    r = await m.c.sh(`docker create ${LBL} --name ${PFX}-c ${IMG} echo done && docker start -a ${PFX}-c`);
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
      `services:\n  web:\n    image: ${IMG}\n    command: ["sleep","300"]\n    labels:\n      team: x\n      g2rig: ${PFX}\n  db:\n    image: ${IMG}\n    command: ["sleep","300"]\n    labels:\n      g2rig: ${PFX}\n    volumes:\n      - data:/data\nvolumes:\n  data: {}\n`,
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
    const r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-u --label team=x --label orchestra.ws=forged --label orchestra.run=forged ${IMG} sleep 300`);
    check('docker run with forged labels succeeds', r.code === 0, r.err);
    const l = labelsOf(`${PFX}-u`) ?? {};
    check('the member’s own label is kept', l.team === 'x', JSON.stringify(l));
    check('a forged orchestra.ws / orchestra.run LOSES to the host stamp', l['orchestra.ws'] === WS && l['orchestra.run'] === RUN, JSON.stringify(l));
  },

  async streams() {
    const m = await member();
    // logs -f flushed while the container is still emitting
    let r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-s ${IMG} sh -c 'i=0; while [ $i -lt 24 ]; do echo line$i; i=$((i+1)); sleep 0.25; done; sleep 120'`);
    check('streaming container started', r.code === 0, r.err);
    r = await m.c.sh(`timeout 8 docker logs -f ${PFX}-s`, { stream: true });
    const ts = r.chunks.map((c) => c[0]);
    const lines = r.chunks.map((c) => c[1]).join('').split('\n').filter(Boolean);
    check('logs -f delivers lines LIVE (first well before the last, many separate chunks)', ts.length >= 8 && ts[ts.length - 1] - ts[0] >= 3000, JSON.stringify(ts));
    check('logs -f content complete and in order', lines.length >= 24 && lines[0] === 'line0' && lines[23] === 'line23', lines.length + ' ' + lines.slice(0, 2));
    // events flushed live: the first event arrives while the stream is still open
    const ev = m.c.sh(`timeout 10 docker events --filter container=${PFX}-ev --filter event=create --format '{{.Action}}'`, { stream: true });
    await sleep(1500);
    await m.c.sh(`docker create ${LBL} --name ${PFX}-ev ${IMG} true`);
    const evr = await ev;
    check('docker events streams the create event live', evr.chunks.length >= 1 && evr.chunks[0][1].trim() === 'create' && evr.chunks[0][0] < 8000, JSON.stringify(evr.chunks));
    check('…and that container is labelled', stamped(`${PFX}-ev`), JSON.stringify(labelsOf(`${PFX}-ev`)));
    // 30 MB hijacked stdin, integrity by checksum
    const big = path.join(BASE, 'big.bin');
    fs.writeFileSync(big, randomBytes(30 * 1024 * 1024));
    const want = sha(fs.readFileSync(big));
    r = await m.c.sh(`docker run ${LBL} --rm -i ${IMG} sha256sum < ${big}`, { timeout: 180000 });
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
    r = await m.c.sh(`docker run ${LBL} --rm ${PFX}-img:1 cat /built`);
    check('the built image runs and has the layer', r.out === 'built-through-relay', r.out + r.err);
  },

  async kill_relay() {
    const m = await member();
    let r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-k1 ${IMG} sleep 300`);
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
    r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-k2 ${IMG} sleep 300`);
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
    r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-k3 ${IMG} sleep 300`);
    check('a create after the socket restore is labelled', r.code === 0 && stamped(`${PFX}-k3`), r.err);
    check('the keeper logged the restarts', /docker relay: restarted/.test(fs.readFileSync(m.logFile, 'utf8')));
  },

  async no_relay_fallback() {
    const m = await member({ blockRelaySock: true });
    const env = await m.c.envDump();
    check('relay cannot start → DOCKER_HOST is UNSET in the member', env.DOCKER_HOST === undefined, env.DOCKER_HOST);
    let r = await m.c.sh('docker ps -q >/dev/null');
    check('docker ps still works on the real socket', r.code === 0, r.err);
    r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-f ${IMG} sleep 300`);
    const l = labelsOf(`${PFX}-f`);
    check('a container made on the real socket is UNATTRIBUTED (no orchestra.* label)', r.code === 0 && l && l['orchestra.ws'] === undefined && l['orchestra.run'] === undefined, JSON.stringify(l));
    check('the keeper logged why', /docker relay disabled/.test(fs.readFileSync(m.logFile, 'utf8')));
  },

  async switch_off() {
    const m = await member({ relay: false });
    const env = await m.c.envDump();
    const sent = Object.fromEntries(Object.entries(m.c.frameEnv).sort());
    check('switch OFF: the member env is EXACTLY the frame env (byte-identical to today)', JSON.stringify(env) === JSON.stringify(sent), JSON.stringify(env));
    check('DOCKER_HOST never set', env.DOCKER_HOST === undefined);
    check('no relay socket exists', !fs.existsSync(m.relaySock));
    const r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-o ${IMG} sleep 300`);
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
    const r = await on.ask({ id: 2, sh: `docker run ${LBL} -d --name ${PFX}-w ${IMG} sleep 300` });
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

  async late_daemon() {
    const late = path.join(BASE, 'late.sock');
    const m = await member({ env: { ORCHESTRA_DOCKER_SOCKET: late } });
    const env = await m.c.envDump();
    check('daemon socket absent at spawn → the relay is STILL given to the member (DOCKER_HOST at the relay)', env.DOCKER_HOST === `unix://${m.relaySock}`, env.DOCKER_HOST);
    let r = await m.c.sh('docker ps -q');
    check('no daemon yet → docker fails cleanly THROUGH THE RELAY (non-zero, the relay\'s own message — not docker\'s native "Cannot connect")', r.code !== 0 && /orchestra docker relay/.test(r.err), `${r.code} ${r.err}`);
    check('the keeper logged that it is waiting for the daemon', /no daemon at .*late\.sock yet/.test(fs.readFileSync(m.logFile, 'utf8')));
    fs.symlinkSync('/var/run/docker.sock', late); // "dockerd starts": the socket appears where the member's config says it lives
    r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-l ${IMG} sleep 300`);
    check('once the daemon appears the SAME relay forwards (no keeper restart)', r.code === 0, r.err);
    check('…and the container is stamped', stamped(`${PFX}-l`), JSON.stringify(labelsOf(`${PFX}-l`)));
    r = await m.c.sh('docker ps -q >/dev/null');
    check('docker ps works through the relay', r.code === 0, r.err);
  },

  async hold_create() {
    await publish(HELD());
    const m = await member({ holdState: STATE });
    const t0 = Date.now();
    const cmd = bg(m, `docker run ${LBL} -d --name ${PFX}-h1 ${IMG} sleep 300`);
    check("held: the member's `docker run` is still WAITING after 3 s (not refused, not failed)", (await cmd.wait(3000)) === null, JSON.stringify(cmd.done()));
    check('held: dockerd has NO such container (the create never reached it)', !exists(`${PFX}-h1`));
    const hf = readHold();
    check('visible: the keeper publishes the wait — 1 create, oldest since ~start, the reason names the reading and the threshold', hf && hf.create === 1 && hf.start === 0 && hf.since >= t0 - 1000 && hf.since <= Date.now() && /^Admission hold: MemAvailable 4\.00 GB < 6\.00 GB/.test(hf.reason), JSON.stringify(hf));
    const notices = [];
    const app = await appCore({ holdFiles: () => [{ wsId: WS, file: HOLD_FILE() }], notify: (ws, text) => notices.push({ ws, text }) });
    const { formatDockerHoldsLine } = await import(`${REPO}/src/shared/docker-hold.ts`);
    const line = formatDockerHoldsLine(app.holds().map((h) => ({ wsId: h.wsId, label: 'rig-member', hold: h.hold })), Date.now());
    check("bus-status line (real app core on the keeper's file): who waits, what, for how long, since when, and why", /^docker holds: rig-member: 1 docker call\(s\) waiting \(1 create\) for \d+ s \(since \d\d:\d\d:\d\dZ\) — Admission hold: MemAvailable 4\.00 GB < 6\.00 GB/.test(line), line);
    app.tick();
    app.tick();
    check('the member is told ONCE (bus status): its call waits, why, and that nothing needs retrying', notices.length === 1 && notices[0].ws === WS && /BY THEMSELVES/.test(notices[0].text) && /nothing is refused/.test(notices[0].text), JSON.stringify(notices));
    await publish(OPEN()); // memory is back
    const r = await cmd.wait(20000);
    check('memory back: the SAME `docker run` completes BY ITSELF (exit 0) — nothing to retry', r && r.code === 0, JSON.stringify(r));
    check('…its container exists, stamped with the workspace + run, and RUNS (the start was admitted too)', stamped(`${PFX}-h1`) && running(`${PFX}-h1`), JSON.stringify(labelsOf(`${PFX}-h1`)));
    check('…and the member was told it waited: docker prints the create Warning with the wait and the reason', !!r && /WARNING: orchestra: this container call waited \d+ s under the Admission hold \(Admission hold: MemAvailable 4\.00 GB/.test(r.err), r?.err);
    check("it really waited (≥ 3 s from the member's command to the container)", Date.now() - t0 >= 3000);
    for (let i = 0; i < 50 && readHold(); i++) await sleep(100);
    check('nothing waits any more ⇒ the hold file is gone', readHold() === null);
  },

  async hold_start() {
    await publish(OPEN());
    const m = await member({ holdState: STATE });
    let r = await m.c.sh(`docker create ${LBL} --name ${PFX}-s1 ${IMG} sleep 300`);
    check('baseline (not held): `docker create` is stamped and does not wait', r.code === 0 && stamped(`${PFX}-s1`) && !running(`${PFX}-s1`), r.err);
    await publish(HELD());
    const cmd = bg(m, `docker start ${PFX}-s1`);
    check('held: `docker start` of the container this relay stamped WAITS (3 s)', (await cmd.wait(3000)) === null, JSON.stringify(cmd.done()));
    check('…dockerd has not started it', !running(`${PFX}-s1`));
    const hf = readHold();
    check('visible: the hold file counts it as a START', hf && hf.start === 1 && hf.create === 0, JSON.stringify(hf));
    await publish(OPEN());
    r = await cmd.wait(20000);
    check('memory back: the `docker start` completes by itself and the container runs', r && r.code === 0 && running(`${PFX}-s1`), JSON.stringify(r));
  },

  async hold_unattributed() {
    await publish(OPEN());
    const m = await member({ holdState: STATE });
    const r = await m.c.sh(`docker create ${LBL} --name ${PFX}-s1 ${IMG} sleep 300 && docker run ${LBL} -d --name ${PFX}-r1 ${IMG} sleep 300`);
    check('setup (not held): a stamped STOPPED container and a stamped RUNNING one', r.code === 0 && stamped(`${PFX}-s1`) && !running(`${PFX}-s1`) && running(`${PFX}-r1`), r.err);
    const mk = (name, extra = []) => dk(['create', '--label', `g2rig=${PFX}`, ...extra, '--name', name, IMG, 'sleep', '300']);
    check("setup: an UNATTRIBUTED stopped container and another WORKSPACE's stopped container, made on the real socket", mk(`${PFX}-u1`).code === 0 && mk(`${PFX}-o1`, ['--label', `orchestra.ws=${PFX}-other`]).code === 0);
    await publish(HELD());
    const fast = async (what, cmd, ok) => {
      const t = Date.now();
      const res = await bg(m, cmd).wait(6000);
      check(`held, but ${what} is NEVER held (answered in < 6 s)`, res && res.code === 0 && Date.now() - t < 6000 && (!ok || ok()), JSON.stringify(res));
    };
    await fast('`docker start` of an unattributed container (made around the relay)', `docker start ${PFX}-u1`, () => running(`${PFX}-u1`));
    await fast("`docker start` of ANOTHER workspace's container", `docker start ${PFX}-o1`, () => running(`${PFX}-o1`));
    await fast('`docker start` of an already-running stamped container', `docker start ${PFX}-r1`);
    await fast('`docker ps`', 'docker ps -q');
    await fast('`docker exec` in a running container', `docker exec ${PFX}-r1 true`);
    await fast('`docker stop` of a running one', `docker stop -t 1 ${PFX}-r1`, () => !running(`${PFX}-r1`));
    const t = Date.now();
    const direct = dk(['run', '-d', '--label', `g2rig=${PFX}`, '--name', `${PFX}-d1`, IMG, 'sleep', '300']);
    check('held, but a container the human makes straight on the real socket (no relay) is not held and stays unattributed', direct.code === 0 && Date.now() - t < 15000 && labelsOf(`${PFX}-d1`)?.['orchestra.ws'] === undefined, direct.err);
    // POSITIVE CONTROL in the same arm: the stamped, stopped container IS held — so everything above passed because it was exempt, not because nothing is ever held
    const cmd = bg(m, `docker start ${PFX}-s1`);
    check("positive control: the stamped STOPPED container's `docker start` IS held (3 s)", (await cmd.wait(3000)) === null && !running(`${PFX}-s1`), JSON.stringify(cmd.done()));
    await publish(OPEN());
    const r2 = await cmd.wait(20000);
    check('…and goes through once memory is back', r2 && r2.code === 0 && running(`${PFX}-s1`), JSON.stringify(r2));
  },

  async hold_fresh_reading() {
    await publish(HELD());
    const m = await member({ holdState: STATE });
    const cmd = bg(m, `docker run ${LBL} -d --name ${PFX}-f1 ${IMG} sleep 300`);
    check('held: the `docker run` waits', (await cmd.wait(2000)) === null);
    await publish(LOW_OPEN()); // the guard says OPEN, but the keeper's FRESH reading of the real MemAvailable is below threshold + margin
    check('the guard says open but a FRESH MemAvailable reading is still too low ⇒ it STAYS in line (3 s)', (await cmd.wait(3000)) === null && !exists(`${PFX}-f1`), JSON.stringify(cmd.done()));
    await publish(OPEN());
    const r = await cmd.wait(20000);
    check('a fresh reading above threshold + margin ⇒ it goes', r && r.code === 0 && stamped(`${PFX}-f1`), JSON.stringify(r));
    // the Admission TOGGLE turned OFF releases a waiting line at once, even when a fresh reading is still too low
    await publish(HELD());
    const cmd2 = bg(m, `docker run ${LBL} -d --name ${PFX}-f2 ${IMG} sleep 300`);
    check('held again: the second `docker run` waits', (await cmd2.wait(2000)) === null);
    await publish({ ...LOW_OPEN(), admissionEnabled: false });
    const r2 = await cmd2.wait(15000);
    check('toggle OFF (published `enabled:false`) ⇒ the waiting call goes AT ONCE although the fresh reading is below threshold + margin', r2 && r2.code === 0 && stamped(`${PFX}-f2`), JSON.stringify(r2));
  },

  async hold_fail_open() {
    // positive control first: a FRESH held state does hold
    await publish(HELD());
    const m = await member({ holdState: STATE });
    const ctl = bg(m, `docker run ${LBL} -d --name ${PFX}-c1 ${IMG} sleep 300`);
    check('positive control: a FRESH held state holds (2 s)', (await ctl.wait(2000)) === null);
    // authority lost while a call waits ⇒ the line is flushed at once (the app that decides is gone)
    fs.rmSync(STATE, { force: true });
    const r0 = await ctl.wait(15000);
    check('the state file DISAPPEARS (app gone) ⇒ the waiting call is released, not stranded', r0 && r0.code === 0 && stamped(`${PFX}-c1`), JSON.stringify(r0));
    const { admissionStateOf } = await import(`${REPO}/src/shared/docker-hold.ts`);
    // authority lost by STALENESS (the app wedged: the file is still there but nobody refreshes it) ⇒ a waiting line is flushed too
    await publish(HELD());
    const ctl2 = bg(m, `docker run ${LBL} -d --name ${PFX}-sf ${IMG} sleep 300`);
    check('held again for the stale-flush case (2 s)', (await ctl2.wait(2000)) === null);
    atomicWrite(STATE, JSON.stringify(admissionStateOf(HELD(), Date.now() - 10 * 60_000)));
    const rsf = await ctl2.wait(15000);
    check('the state goes STALE (10 min old) ⇒ the waiting call is released, not stranded', rsf && rsf.code === 0 && stamped(`${PFX}-sf`), JSON.stringify(rsf));
    const cases = [
      ['absent state file', () => fs.rmSync(STATE, { force: true })],
      ['a STALE held state (10 min old: the app is wedged)', () => atomicWrite(STATE, JSON.stringify(admissionStateOf(HELD(), Date.now() - 10 * 60_000)))],
      ['a held state of ANOTHER version', () => atomicWrite(STATE, JSON.stringify({ ...admissionStateOf(HELD(), Date.now()), v: 2 }))],
      ['a garbage state file', () => atomicWrite(STATE, '{"held": tru')],
      ['a TRUNCATED valid state file (half of what the app wrote)', () => fs.writeFileSync(STATE, JSON.stringify(admissionStateOf(HELD(), Date.now())).slice(0, 60))],
    ];
    let i = 0;
    for (const [what, arrange] of cases) {
      arrange();
      const r = await bg(m, `docker run ${LBL} -d --name ${PFX}-fo${i++} ${IMG} sleep 300`).wait(8000);
      check(`fail-open: ${what} ⇒ the create is NOT held`, r && r.code === 0, JSON.stringify(r));
    }
    check('the keeper LOGGED that it could not read the state (and let the call through)', /docker hold: .*state file .*unreadable|docker hold: .*unreadable/i.test(fs.readFileSync(m.logFile, 'utf8')), fs.readFileSync(m.logFile, 'utf8').slice(-400));
    // a member whose spawn frame carries no holdState never holds, whatever the file says
    await publish(HELD());
    const m2 = await member({ ws: `${PFX}b`, run: `${PFX}-runb` });
    const r2 = await bg(m2, `docker run ${LBL} -d --name ${PFX}-nb ${IMG} sleep 300`).wait(8000);
    check("no holdState in the frame ⇒ never held (the frame is #291's, byte for byte)", r2 && r2.code === 0 && labelsOf(`${PFX}-nb`)?.['orchestra.ws'] === `${PFX}b`, JSON.stringify(r2));
  },

  async hold_client_leaves() {
    await publish(HELD());
    const m = await member({ holdState: STATE });
    const stays = bg(m, `docker run ${LBL} -d --name ${PFX}-stays ${IMG} sleep 300`);
    await sleep(500);
    const leaver = bg(m, `timeout 3 docker run ${LBL} -d --name ${PFX}-leaver ${IMG} sleep 300`);
    const lr = await leaver.wait(10000);
    check('the docker client is killed while its create waits (exit 124)', lr && lr.code === 124, JSON.stringify(lr));
    const lint = await bg(m, `timeout -s INT 3 docker run ${LBL} -d --name ${PFX}-leaver-int ${IMG} sleep 300`).wait(10000);
    const lkill = await bg(m, `timeout -s KILL 3 docker run ${LBL} -d --name ${PFX}-leaver-kill ${IMG} sleep 300`).wait(10000);
    const bigf = path.join(BASE, 'leaver.labels');
    fs.writeFileSync(bigf, Array.from({ length: 250 }, (_, i) => `l${i}=${'x'.repeat(1000)}`).join('\n') + '\n');
    const lbig = await bg(m, `timeout 3 docker create ${LBL} --label-file ${bigf} --name ${PFX}-leaver-big ${IMG} true`).wait(10000);
    check('a client holding a 200 KB create body also ends (exit 124)', lbig && lbig.code === 124, JSON.stringify(lbig));
    check('Ctrl-C (SIGINT) and a hard kill (SIGKILL: what a Pause dure does to a tool) both end the waiting client', lint && lkill && lint.code !== 0 && lkill.code !== 0, JSON.stringify([lint, lkill]));
    await sleep(500);
    const hf = readHold();
    check('the leavers are out of the line: the hold file counts only the patient one', hf && hf.create === 1, JSON.stringify(hf));
    await publish(OPEN());
    const sr = await stays.wait(20000);
    check('the patient create goes through when memory is back (the line goes on without the leaver)', sr && sr.code === 0 && stamped(`${PFX}-stays`), JSON.stringify(sr));
    await sleep(3000);
    check("no leaver's create was EVER sent: no container, even long after the release (SIGTERM, SIGINT, SIGKILL)", !exists(`${PFX}-leaver`) && !exists(`${PFX}-leaver-int`) && !exists(`${PFX}-leaver-kill`) && !exists(`${PFX}-leaver-big`));
  },

  async hold_one_at_a_time() {
    await publish(HELD());
    const m = await member({ holdState: STATE, keeperEnv: { ORCHESTRA_KEEPER_HOLD_POLL_MS: '100', ORCHESTRA_KEEPER_HOLD_SETTLE_MS: '800' } });
    const names = ['a', 'b', 'c'].map((x) => `${PFX}-q${x}`);
    const cmds = [];
    for (const n of names) {
      cmds.push(bg(m, `docker create ${LBL} --name ${n} ${IMG} sleep 300`));
      await sleep(500);
    }
    check('three creates queue up behind the hold', cmds.every((c) => c.done() === null) && readHold()?.create === 3, JSON.stringify(readHold()));
    await publish(OPEN());
    const rs = await Promise.all(cmds.map((c) => c.wait(40000)));
    check('all three are released and complete', rs.every((r) => r && r.code === 0), JSON.stringify(rs));
    const t = names.map(created);
    check('FIFO: created in arrival order', t[0] < t[1] && t[1] < t[2], JSON.stringify(t));
    check('ONE at a time: ≥ 0.6 s between two releases (the settle), not a thundering herd', t[1] - t[0] >= 600 && t[2] - t[1] >= 600, JSON.stringify([t[1] - t[0], t[2] - t[1]]));
  },

  async hold_long_wait() {
    // OPS (b): how long can a client WAIT? A multi-minute hold (> Node's 300 s default request timeout, > docker-py/compose-v1's 60 s) against the clients a member really uses; report the first that cuts.
    const HOLD_MS = Number(process.env.HOLD_LONG_MS ?? 390_000);
    await publish(HELD());
    const m = await member({ holdState: STATE });
    const sock = m.relaySock;
    const big = path.join(BASE, 'big.labels');
    fs.writeFileSync(big, Array.from({ length: 250 }, (_, i) => `l${i}=${'x'.repeat(1000)}`).join('\n') + '\n'); // a create body well past every stream buffer: the relay does not read it until the line releases it
    const dir = path.join(BASE, 'compose-long');
    fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'compose.yaml'), `services:\n  web:\n    image: ${IMG}\n    command: ["sleep","300"]\n    labels:\n      g2rig: ${PFX}\n`);
    const node = `const http=require('http');const t0=Date.now();const r=http.request({socketPath:'${sock}',method:'POST',path:'/v1.47/containers/create?name=${PFX}-lib',headers:{'content-type':'application/json'},agent:false},(res)=>{let b='';res.on('data',(c)=>b+=c);res.on('end',()=>console.log(JSON.stringify({status:res.statusCode,ms:Date.now()-t0})));});r.on('error',(e)=>{console.log(JSON.stringify({error:e.message,ms:Date.now()-t0}));process.exit(1)});r.end(JSON.stringify({Image:'${IMG}',Labels:{g2rig:'${PFX}'}}));`;
    const nodeFile = path.join(BASE, 'lib-client.cjs');
    fs.writeFileSync(nodeFile, node);
    const clients = {
      'docker CLI (docker run -d)': `docker run ${LBL} -d --name ${PFX}-w1 ${IMG} sleep 300`,
      'docker CLI (docker create, 200 KB body)': `docker create ${LBL} --label-file ${big} --name ${PFX}-w2 ${IMG} true`,
      'docker compose up -d': `cd ${dir} && docker compose -p ${PFX}p up -d`,
      'node http.request (a client library, no timeout set)': `node ${nodeFile}`,
      'curl (libcurl, no --max-time)': `curl -sS --unix-socket ${sock} -X POST -H 'content-type: application/json' -d '{"Image":"${IMG}","Labels":{"g2rig":"${PFX}"}}' 'http://d/v1.47/containers/create?name=${PFX}-curl' -w '\\n%{http_code}'`,
    };
    const t0 = Date.now();
    const running = Object.entries(clients).map(([name, cmd]) => ({ name, cmd: bg(m, cmd, { timeout: HOLD_MS + 180_000 }), t0: Date.now() }));
    // a REAL guard re-publishes at every sample (≤ 60 s): keep the state fresh (the 5-minute TTL is a different clause, proven in hold_fail_open)
    const cuts = {};
    while (Date.now() - t0 < HOLD_MS) {
      await publish(HELD());
      for (const c of running) if (c.cmd.done() && cuts[c.name] === undefined) cuts[c.name] = { atMs: Date.now() - t0, res: c.cmd.done() };
      if (running.every((c) => c.cmd.done())) break; // every client already ended (a master keeper holds nothing): no point waiting out the clock
      await sleep(10_000);
    }
    check(`held for ${Math.round((Date.now() - t0) / 1000)} s: dockerd has seen NOTHING from any client`, !exists(`${PFX}-w1`) && !exists(`${PFX}-w2`) && !exists(`${PFX}-lib`) && !exists(`${PFX}-curl`) && !exists(`${PFX}p-web-1`));
    const hf = readHold();
    check('the hold file still counts every waiting client after the long wait', hf && hf.create >= 5, JSON.stringify(hf));
    for (const [name, c] of Object.entries(cuts)) check(`the client did NOT cut before memory came back: ${name}`, false, `ended after ${Math.round(c.atMs / 1000)} s — ${JSON.stringify(c.res).slice(0, 300)}`);
    await publish(OPEN());
    const rs = await Promise.all(running.map(async (c) => ({ name: c.name, r: await c.cmd.wait(120_000) })));
    for (const { name, r } of rs) {
      if (cuts[name] === undefined) check(`memory back after ${Math.round(HOLD_MS / 1000)} s: ${name} completes by itself`, r && r.code === 0, JSON.stringify(r)?.slice(0, 300));
    }
    check('…and every container exists, stamped', ['w1', 'w2'].every((x) => stamped(`${PFX}-${x}`)) && stamped(`${PFX}p-web-1`) && exists(`${PFX}-lib`) && exists(`${PFX}-curl`));
    measured.longWait = { holdMs: HOLD_MS, clients: rs.map(({ name, r }) => ({ name, outcome: cuts[name] ? `CUT after ${Math.round(cuts[name].atMs / 1000)} s` : r && r.code === 0 ? 'survived' : `failed: ${JSON.stringify(r)?.slice(0, 120)}` })) };
  },

  async hold_guard_chain() {
    // The REAL guard fed a fake meter → the REAL publisher (docker-hold-host) → the keeper → dockerd. Thresholds are scaled so the keeper's fresh REAL reading passes on reopen.
    process.env.ORCHESTRA_HOME = HOME;
    process.env.HOME = HOME;
    const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
    initPlatform({
      kind: 'headless-docker-relay-g2',
      broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
      openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
      getUserDataDir: () => HOME, getLogsDir: () => path.join(HOME, 'logs'), getAppVersion: () => '0.0.0-g2', getAppMetrics: () => [],
      isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
    });
    (await import(`${REPO}/src/main/logger.ts`)).initLogger();
    const g = await import(`${REPO}/src/main/memory-guard.ts`);
    const host = await import(`${REPO}/src/main/docker-hold-host.ts`);
    const { dockerRelaySpecFor } = await import(`${REPO}/src/main/docker-relay-switch.ts`);
    const { initBus, getBus } = await import(`${REPO}/src/main/bus.ts`);
    const { startRun } = await import(`${REPO}/src/main/bus-runs.ts`);
    const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
    initBus();
    startRun(getBus(), { id: RUN, kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, dockerRelay: true });
    const spec = dockerRelaySpecFor(RUN, false);
    check("the app's spec for an ON run names the Admission state file under ORCHESTRA_HOME", spec?.holdState === STATE, JSON.stringify(spec));
    let mem = 3 * GIB;
    g.__rebuildMemoryGuardForTests({}, () => mem);
    g.setMemoryGuardSettingsReader(() => ({ admissionGb: 1, criticalGb: 0.5, admissionEnabled: true, capSoftGb: 3, capHardGb: 6 }));
    host.startDockerHold();
    mem = 0.3 * GIB; // LOW (simulated): below the 1 GB Admission threshold (and the 0.5 GB critical level — nothing here runs the memory Pause)
    const snap = g.sampleMemoryGuardNow();
    check('the real guard holds Admission at the simulated low reading', snap.admission === 'held', JSON.stringify(snap));
    const m = await member({ holdState: spec?.holdState });
    const cmd = bg(m, `docker run ${LBL} -d --name ${PFX}-g1 ${IMG} sleep 300`);
    check("low memory: the member's `docker run` WAITS (3 s) and dockerd has no container", (await cmd.wait(3000)) === null && !exists(`${PFX}-g1`), JSON.stringify(cmd.done()));
    mem = 1.5 * GIB; // above the 1 GB threshold but inside the 1 GB hysteresis margin: the guard stays held
    g.sampleMemoryGuardNow();
    check('inside the hysteresis band the guard stays held ⇒ the call keeps waiting (2 s)', (await cmd.wait(2000)) === null && !exists(`${PFX}-g1`));
    mem = 3 * GIB; // above threshold + margin (2 GB): reopen
    const reopened = g.sampleMemoryGuardNow();
    check('above threshold + margin the real guard reopens', reopened.admission === 'open', JSON.stringify(reopened));
    const r = await cmd.wait(20000);
    check('memory back: the SAME `docker run` completes by itself, its container stamped', r && r.code === 0 && stamped(`${PFX}-g1`), JSON.stringify(r));
    mem = 0.3 * GIB; // low again: a new episode
    g.sampleMemoryGuardNow();
    const cmd2 = bg(m, `docker run ${LBL} -d --name ${PFX}-g2 ${IMG} sleep 300`);
    check('a second low episode holds again (3 s)', (await cmd2.wait(3000)) === null && !exists(`${PFX}-g2`), JSON.stringify(cmd2.done()));
    g.setMemoryGuardSettingsReader(() => ({ admissionGb: 1, criticalGb: 0.5, admissionEnabled: false, capSoftGb: 3, capHardGb: 6 }));
    const off = g.sampleMemoryGuardNow(); // the operator turned the toggle OFF: the guard still MEASURES low
    const r2 = await cmd2.wait(20000);
    check('the Admission TOGGLE turned OFF releases the waiting call AT ONCE (the guard still reads low: the EFFECTIVE hold is what is published)', off.admission === 'held' && r2 && r2.code === 0 && stamped(`${PFX}-g2`), JSON.stringify([off.admission, r2]));
    const r3 = await bg(m, `docker run ${LBL} -d --name ${PFX}-g3 ${IMG} sleep 300`).wait(8000);
    check('…and a NEW call under the toggle OFF is not held either', r3 && r3.code === 0, JSON.stringify(r3));
    host.stopDockerHold();
    check('the app stopping removes the state file (a hold never outlives the thing that decides it)', !fs.existsSync(STATE));
    g.stopMemoryGuard();
  },

  async api_real() {
    const m = await member();
    // what the relay stamps …
    let r = await m.c.sh(`docker run ${LBL} -d --name ${PFX}-api ${IMG} sleep 300 && docker run ${LBL} -d --rm --name ${PFX}-rm ${IMG} sleep 300`);
    check('two containers created through the relay (one --rm)', r.code === 0, r.err);
    // … and one made AROUND it, on the real socket
    const direct = dk(['run', '-d', '--label', `g2rig=${PFX}`, '--name', `${PFX}-direct`, IMG, 'sleep', '300']);
    check('a container created on the real socket exists, unlabelled', direct.code === 0 && labelsOf(`${PFX}-direct`)?.['orchestra.ws'] === undefined, direct.err);
    // … is what the APP's client sees. Resolve through ORCHESTRA_DOCKER_SOCKET aliasing the real socket (the relay honours it too).
    const alias = path.join(BASE, 'alias.sock');
    fs.symlinkSync('/var/run/docker.sock', alias);
    const { createDockerApi } = await import(`${REPO}/src/main/docker-api.ts`);
    const { realUpstreamDeps } = await import(`${REPO}/src/shared/docker-endpoint.ts`);
    const api = createDockerApi({ env: { ORCHESTRA_DOCKER_SOCKET: alias, HOME: REAL_HOME, PATH: process.env.PATH }, deps: realUpstreamDeps });
    check('the app client resolves the SAME socket the relay would (ORCHESTRA_DOCKER_SOCKET honoured)', (await api.resolveSocket()) === alias, await api.resolveSocket());
    check('available() against real dockerd', (await api.available()) === true);
    const attributed = await api.listContainers({ labels: [`orchestra.ws=${WS}`], status: ['running'] });
    const names = attributed.map((c) => c.name).sort();
    check('listing by label orchestra.ws=<ws> returns exactly the relay-stamped containers (not the direct one)', JSON.stringify(names) === JSON.stringify([`${PFX}-api`, `${PFX}-rm`]), JSON.stringify(names));
    check('each row carries orchestra.run', attributed.every((c) => c.labels['orchestra.run'] === RUN), JSON.stringify(attributed.map((c) => c.labels)));
    const api1 = attributed.find((c) => c.name === `${PFX}-api`);
    const rm1 = attributed.find((c) => c.name === `${PFX}-rm`);
    const insp = await api.inspectContainer(api1.id);
    check('inspect: running, not AutoRemove', insp && insp.running === true && insp.autoRemove === false, JSON.stringify(insp));
    check('inspect: the --rm container reports AutoRemove (it must NOT be stopped by a Pause)', (await api.inspectContainer(rm1.id))?.autoRemove === true);
    const st = await api.containerStats(api1.id);
    check('stats: a one-shot sample with a memory usage', typeof st?.memory_stats?.usage === 'number' && st.memory_stats.usage > 0, JSON.stringify(st?.memory_stats));
    check('stop → stopped (and dockerd agrees)', (await api.stopContainer(api1.id, 3)) === 'stopped' && dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-api`]).out === 'false');
    check('stop again → already-stopped', (await api.stopContainer(api1.id, 3)) === 'already-stopped');
    check('stopping did NOT remove it', labelsOf(`${PFX}-api`)?.['orchestra.ws'] === WS);
    check('start → started (labels intact)', (await api.startContainer(api1.id)) === 'started' && dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-api`]).out === 'true' && stamped(`${PFX}-api`));
    check('start again → already-running', (await api.startContainer(api1.id)) === 'already-running');
    check('unknown id → inspect null, stop/start gone', (await api.inspectContainer('0'.repeat(64))) === null && (await api.stopContainer('0'.repeat(64))) === 'gone' && (await api.startContainer('0'.repeat(64))) === 'gone');
    check('the unattributed container was never touched', dk(['inspect', '-f', '{{.State.Running}}', `${PFX}-direct`]).out === 'true');
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
/** Rig processes still alive, selected by object + identity: a cmdline naming THIS run's unique scratch dir (never a host-wide name grep). */
function survivors() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').includes(BASE)) out.push(Number(d));
    } catch {
      /* gone */
    }
  }
  return out;
}
for (let i = 0; i < 40 && survivors().length; i++) await sleep(100);
const mineBefore = mine();
cleanup();
const leftover = mine();
const AFTER = bystanders();
const unchanged = JSON.stringify(BEFORE) === JSON.stringify(AFTER);
if (ARMS[ARM].creates) check('positive control: the cleanup filter SEES the rig containers (so "none left" means something)', mineBefore.length > 0, 'mine() saw none');
check('every rig container removed', leftover.length === 0, leftover.join(','));
const procLeft = survivors();
check('0 rig processes survive (keepers + member CLIs, selected by the run\'s unique scratch path)', procLeft.length === 0, procLeft.join(','));
check(`bystander containers UNCHANGED (${BEFORE.length} before / ${AFTER.length} after)`, unchanged, unchanged ? '' : `before=${JSON.stringify(BEFORE)} after=${JSON.stringify(AFTER)}`);
fs.rmSync(BASE, { recursive: true, force: true });
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ arm: ARM, ok, mustFailOnMaster: ARMS[ARM].mustFailOnMaster, id: ID, ms: Date.now() - t0, rigContainers: mineBefore.length, ...(Object.keys(measured).length ? { measured } : {}), checks, fatal: fatal ? String(fatal.message ?? fatal) : undefined }));
process.exit(ok ? 0 : 1);
