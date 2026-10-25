// #390 — pinned Node for the keepers: the rig. Run: `pnpm run test:pinned-node` (all arms) or `… -- <arm>` for one.
// Real bytes throughout: the REAL pinned Node tarball (cached under build/pinned-node/.cache, hash-checked on every use), the REAL keeper bundle
// (dist-electron/keeper.js, rebuilt when stale), the REAL makeKeeperSpawn facade. Every must-FAIL arm has its positive control in the same run.
// Terminator: `PINNED-NODE: ALL PASS (N/N) tree <repo>` (rc 0). Anything else — including a missing terminator — is not a pass.
//
// Group A  fetch + hash        fetch_real_ok · fetch_corrupt_download · fetch_poisoned_cache · extract_binary_tamper · extract_size_tamper · pins_valid · pins_match_upstream
// Group B  packaged runtime    pack_ok_real · pack_absent · pack_corrupt_byte · pack_truncated · pack_not_executable · pack_manifest_mismatch · pack_cross_arch_refused
//                              smoke_ok_system_node · smoke_garbage_binary · smoke_stub_binary · smoke_wrong_version · smoke_exec_proxy · smoke_hello_only_keeper
// Group C  launcher + updates  bundled_launch · update_keeps_running_keeper · reinstall_when_wiped · fallback_without_bundle · noexec_bin_refused
//
// Rig hygiene: scratch ORCHESTRA_HOME/HOME under $TMPDIR, `PATH` allowlist for children, no live config dir touched (ORCHESTRA_HOME is overridden BEFORE keeper-client loads).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import http from 'node:http';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('./pinned-node/lib.cjs');
const { checkPackedRuntime } = require('./pinned-node/pack-check.cjs');
const { smokeKeeper } = require('./pinned-node/smoke.cjs');

const HOST_ARCH = process.arch; // 'arm64' | 'x64'
if (!['arm64', 'x64'].includes(HOST_ARCH)) {
  console.log(`PINNED-NODE: FAIL host arch ${HOST_ARCH} has no pinned Node`);
  process.exit(1);
}
const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'pnrig-'));
const HOME = path.join(SCR, 'home');
fs.mkdirSync(path.join(HOME, 'bin'), { recursive: true });
process.env.ORCHESTRA_HOME = HOME; // BEFORE keeper-client loads
process.env.HOME = HOME;
delete process.env.APPIMAGE;
Object.assign(process.env, { ORCHESTRA_KEEPER_LINGER_MS: '60000', ORCHESTRA_KEEPER_WEDGE_MS: '60000', ORCHESTRA_KEEPER_TICK_MS: '2000' }); // a keeper whose rig died ends itself

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
const flipByte = (file, at) => { const fd = fs.openSync(file, 'r+'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, at); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, at); fs.closeSync(fd); };

// ── the keeper bundle (rebuilt when stale, like keeper.test.ts) ─────────────────────────────────────────────────────────────────────────────────
const KEEPER_JS = path.join(REPO, 'dist-electron', 'keeper.js');
{
  const srcs = ['src/keeper/index.ts', 'src/shared/keeper-protocol.ts', 'src/shared/memory-scope.ts'].map((s) => path.join(REPO, s));
  if (!fs.existsSync(KEEPER_JS) || srcs.some((s) => fs.statSync(s).mtimeMs > fs.statSync(KEEPER_JS).mtimeMs)) {
    execFileSync(process.execPath, [path.join(REPO, 'node_modules', 'vite', 'bin', 'vite.js'), 'build', '--config', 'vite.keeper.config.ts'], { cwd: REPO, stdio: 'ignore' });
  }
  fs.copyFileSync(KEEPER_JS, path.join(HOME, 'bin', 'keeper.js')); // what installKeeper() does at app start
}

// ── the REAL pinned runtime for this host arch (cache shared with the build; hash-checked every use) ──────────────────────────────────────────────────
const REAL_PINS = lib.loadPins();
const REAL_PIN = lib.pinFor(REAL_PINS, HOST_ARCH);
const { cacheDir: DEFAULT_CACHE } = lib.defaultDirs(HOST_ARCH);
const REAL_DIR = path.join(SCR, 'real');
const real = await lib.prepareRuntime({ arch: HOST_ARCH, outDir: REAL_DIR, cacheDir: DEFAULT_CACHE });
const REAL_NODE = real.nodePath;

/** A copy of the real runtime dir that an arm may damage. */
function copyRuntime(name) {
  const d = path.join(SCR, name);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(REAL_NODE, path.join(d, 'node'));
  fs.chmodSync(path.join(d, 'node'), 0o755);
  fs.copyFileSync(path.join(REAL_DIR, 'manifest.json'), path.join(d, 'manifest.json'));
  return d;
}

/** A synthetic pinned tarball (`node-v<ver>-linux-<arch>/bin/node` = body) + the pin table that describes it — for the arms that need a pin the real node cannot satisfy. */
function syntheticPins(name, { body, pinnedBody = body, pinnedBytes }) {
  const ver = '9.9.9';
  const top = `node-v${ver}-linux-${HOST_ARCH}`;
  const dir = path.join(SCR, name, 'src');
  fs.mkdirSync(path.join(dir, top, 'bin'), { recursive: true });
  fs.writeFileSync(path.join(dir, top, 'bin', 'node'), body);
  const tgz = path.join(SCR, name, `${top}.tar.gz`);
  execFileSync('tar', ['-czf', tgz, '-C', dir, top]);
  return {
    pins: { version: ver, source: 'https://example.invalid/', arch: { [HOST_ARCH]: { tarball: `${top}.tar.gz`, tarballSha256: sha(fs.readFileSync(tgz)), nodeSha256: sha(pinnedBody), nodeBytes: pinnedBytes ?? Buffer.byteLength(pinnedBody) } } },
    tgz,
  };
}

/** Serve `files` ({ '/name': absolutePath }) on a loopback port; returns { url, close }. */
function mirror(files) {
  const srv = http.createServer((req, res) => {
    const f = files[req.url];
    if (!f) { res.statusCode = 404; res.end(); return; }
    res.setHeader('content-length', fs.statSync(f).size);
    fs.createReadStream(f).pipe(res);
  });
  return new Promise((resolve) => srv.listen(0, '127.0.0.1', () => resolve({ url: `http://127.0.0.1:${srv.address().port}/`, close: () => srv.close() })));
}

const rejects = async (fn, re, what) => {
  let err = null;
  try { await fn(); } catch (e) { err = e; }
  if (!err) throw new Error(`${what}: expected a rejection, it PASSED`);
  if (!re.test(err.message)) throw new Error(`${what}: rejected for the wrong reason: ${err.message.slice(0, 200)}`);
  return err.message;
};
const check = (o) => checkPackedRuntime({ arch: HOST_ARCH, keeperJs: KEEPER_JS, ...o });

// ── Group C scaffolding (the real facade) ──────────────────────────────────────────────────────────────────────────────────────────────────────────
let kc = null;
async function loadKeeperClient() {
  if (kc) return kc;
  const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
  initPlatform({
    kind: 'headless-pinned-node-390',
    broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true,
    isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
    openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {},
    openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
    getUserDataDir: () => HOME, getLogsDir: () => `${HOME}/logs`,
    getAppVersion: () => '0.0.0-pinned-node-390', getAppMetrics: () => [],
    isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
  });
  kc = await import(`${REPO}/src/main/keeper-client.ts`);
  return kc;
}
const FAKE_CLI = path.join(SCR, 'fake-cli.cjs');
fs.writeFileSync(FAKE_CLI, `process.on('SIGTERM',()=>process.exit(0));process.stdin.on('data',(d)=>{for(const l of d.toString().split('\\n')){if(!l.trim())continue;let m;try{m=JSON.parse(l)}catch{continue}if(m.echo!==undefined)process.stdout.write(JSON.stringify({type:'assistant',echo:m.echo})+'\\n')}});setInterval(()=>{},1000);`);

const cmdline = (pid) => fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean);
const exeOf = (pid) => { try { return fs.readlinkSync(`/proc/${pid}/exe`); } catch { return null; } };
const keeperPid = (ws) => { try { return JSON.parse(fs.readFileSync(path.join(HOME, 'keepers', `${ws}.pid`), 'utf8')).pid; } catch { return null; } };
const wsLaunched = [];
/** Launch a keeper through the real facade and return once its CLI echoed (so the keeper is fully up). */
async function launch(ws) {
  const k = await loadKeeperClient();
  wsLaunched.push(ws);
  const h = k.makeKeeperSpawn(ws)({ command: process.execPath, args: [FAKE_CLI], cwd: HOME, env: { PATH: process.env.PATH }, signal: new AbortController().signal });
  let out = '';
  h.stdout.on('data', (d) => { out += d.toString(); });
  h.stdin.write(JSON.stringify({ echo: ws }) + '\n');
  const t0 = Date.now();
  while (!out.includes(ws) && Date.now() - t0 < 20_000) await sleep(50);
  if (!out.includes(ws)) throw new Error(`keeper ${ws} never echoed`);
  const pid = keeperPid(ws);
  if (!pid) throw new Error(`keeper ${ws}: no pid file`);
  return { ws, pid, h };
}
/** resources/pinned-node as the package would ship it, for a pin whose version is `version` (same bytes as the real one — only the versioned dir name differs). */
function fakeResources(name, version) {
  const r = path.join(SCR, name, 'resources', 'pinned-node');
  fs.mkdirSync(r, { recursive: true });
  fs.linkSync(REAL_NODE, path.join(r, 'node'));
  fs.writeFileSync(path.join(r, 'manifest.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(REAL_DIR, 'manifest.json'), 'utf8')), version }));
  return path.dirname(r);
}
const setResources = (dir) => { process.resourcesPath = dir; };
const runtimeDirs = () => fs.readdirSync(path.join(HOME, 'bin')).filter((n) => /^node-\d/.test(n)).sort();
/** Group C arms are a story (install → update → wipe → fallback) but each must also run alone: make sure a runtime is installed. */
async function ensureBase() {
  const k = await loadKeeperClient();
  if (runtimeDirs().length === 0) { setResources(fakeResources('c-base', '22.23.4')); k.installKeeper(); }
  return k;
}

// ── the arms ──────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const ARMS = {
  // ---- Group A ----
  async fetch_real_ok() {
    const out = path.join(SCR, 'a1');
    const r = await lib.prepareRuntime({ arch: HOST_ARCH, outDir: out, cacheDir: DEFAULT_CACHE });
    if (lib.sha256File(r.nodePath) !== REAL_PIN.nodeSha256) throw new Error('prepared node does not hash to the pin');
    const again = await lib.prepareRuntime({ arch: HOST_ARCH, outDir: out, cacheDir: DEFAULT_CACHE });
    if (again.source !== 'cached-output') throw new Error(`second prepare re-did the work (${again.source})`);
    return `node ${REAL_PIN.nodeSha256.slice(0, 12)} (${r.source}), second call ${again.source}`;
  },
  async fetch_corrupt_download() {
    const bad = path.join(SCR, 'a2.tgz');
    fs.copyFileSync(path.join(DEFAULT_CACHE, REAL_PIN.tarball), bad);
    flipByte(bad, 1_000_000);
    const m = await mirror({ [`/${REAL_PIN.tarball}`]: bad });
    const cache = path.join(SCR, 'a2-cache');
    const out = path.join(SCR, 'a2-out');
    try {
      const msg = await rejects(() => lib.prepareRuntime({ arch: HOST_ARCH, outDir: out, cacheDir: cache, mirror: m.url }), /downloaded .* SHA-256 mismatch/, 'a corrupted download');
      if (fs.existsSync(path.join(out, 'node'))) throw new Error('a node was produced from a corrupted download');
      if (fs.readdirSync(cache).length !== 0) throw new Error(`the cache kept ${fs.readdirSync(cache).join(',')}`);
      return msg.slice(0, 90);
    } finally { m.close(); }
  },
  async fetch_poisoned_cache() {
    const good = path.join(DEFAULT_CACHE, REAL_PIN.tarball);
    const cache = path.join(SCR, 'a3-cache');
    fs.mkdirSync(cache, { recursive: true });
    fs.copyFileSync(good, path.join(cache, REAL_PIN.tarball));
    flipByte(path.join(cache, REAL_PIN.tarball), 2_000_000);
    // (1) poisoned cache + a good mirror → healed, never trusted
    const m = await mirror({ [`/${REAL_PIN.tarball}`]: good });
    try {
      const r = await lib.prepareRuntime({ arch: HOST_ARCH, outDir: path.join(SCR, 'a3-out'), cacheDir: cache, mirror: m.url });
      if (r.source !== 'downloaded') throw new Error(`poisoned cache was used (${r.source})`);
      if (lib.sha256File(path.join(cache, REAL_PIN.tarball)) !== REAL_PIN.tarballSha256) throw new Error('cache not healed');
    } finally { m.close(); }
    // (2) poisoned cache + an unreachable mirror → rejected (offline never means "use what is there")
    fs.copyFileSync(good, path.join(cache, REAL_PIN.tarball));
    flipByte(path.join(cache, REAL_PIN.tarball), 2_000_000);
    await rejects(() => lib.prepareRuntime({ arch: HOST_ARCH, outDir: path.join(SCR, 'a3-out2'), cacheDir: cache, mirror: 'http://127.0.0.1:1/' }), /./, 'poisoned cache, no mirror');
    if (fs.existsSync(path.join(SCR, 'a3-out2', 'node'))) throw new Error('a node was produced from a poisoned cache');
    return 'poisoned cache healed from a good mirror; rejected when offline';
  },
  async extract_binary_tamper() {
    // the tarball hash is RIGHT, the binary inside is not the pinned one → the second check must catch it
    const { pins, tgz } = syntheticPins('a4', { body: 'A'.repeat(32), pinnedBody: 'B'.repeat(32) });
    const m = await mirror({ [`/${path.basename(tgz)}`]: tgz });
    try {
      return (await rejects(() => lib.prepareRuntime({ arch: HOST_ARCH, outDir: path.join(SCR, 'a4-out'), cacheDir: path.join(SCR, 'a4-cache'), pins, mirror: m.url }), /extracted bin\/node SHA-256 mismatch/, 'a tampered binary in a hash-correct tarball')).slice(0, 80);
    } finally { m.close(); }
  },
  async extract_size_tamper() {
    const { pins, tgz } = syntheticPins('a5', { body: 'same-bytes', pinnedBytes: 999 });
    const m = await mirror({ [`/${path.basename(tgz)}`]: tgz });
    try {
      return (await rejects(() => lib.prepareRuntime({ arch: HOST_ARCH, outDir: path.join(SCR, 'a5-out'), cacheDir: path.join(SCR, 'a5-cache'), pins, mirror: m.url }), /bytes, pinned 999/, 'a wrong-size binary')).slice(0, 80);
    } finally { m.close(); }
  },
  async pins_valid() {
    const p = lib.loadPins();
    for (const a of ['arm64', 'x64']) lib.pinFor(p, a);
    if (!/^22\./.test(p.version)) throw new Error(`pinned major is ${p.version}, the ledger pins 22.x`);
    const bad = path.join(SCR, 'bad-pins.json');
    fs.writeFileSync(bad, JSON.stringify({ ...p, arch: { arm64: { ...p.arch.arm64, tarballSha256: 'xyz' } } }));
    await rejects(async () => lib.loadPins(bad), /64 lowercase hex/, 'a malformed pin');
    await rejects(async () => lib.pinFor(p, 'ia32'), /no pin for arch/, 'an unpinned arch');
    return `v${p.version}, arm64 + x64 pinned, malformed pin refused`;
  },
  async pins_match_upstream() {
    const res = await fetch(`${REAL_PINS.source}SHASUMS256.txt`);
    if (!res.ok) throw new Error(`GET SHASUMS256.txt → HTTP ${res.status}`);
    const lines = new Map((await res.text()).split('\n').map((l) => l.trim().split(/\s+/)).filter((p) => p.length === 2).map(([h, n]) => [n, h]));
    for (const [arch, e] of Object.entries(REAL_PINS.arch)) {
      if (lines.get(e.tarball) !== e.tarballSha256) throw new Error(`${arch}: pinned ${e.tarballSha256} ≠ upstream ${lines.get(e.tarball)}`);
    }
    // positive control for the comparison: a wrong pin WOULD differ
    if (lines.get(REAL_PIN.tarball) === sha('not the hash')) throw new Error('control: comparison is vacuous');
    return `both tarball hashes equal ${REAL_PINS.source}SHASUMS256.txt`;
  },

  // ---- Group B ----
  async pack_ok_real() {
    const d = copyRuntime('b1');
    const line = await check({ runtimeDir: d });
    if (!/started the keeper and relayed a child/.test(line)) throw new Error(line);
    return line;
  },
  async pack_absent() {
    return (await rejects(() => check({ runtimeDir: path.join(SCR, 'b-nothing-here') }), /ABSENT from the package/, 'a package without the runtime')).slice(0, 90);
  },
  async pack_corrupt_byte() {
    const d = copyRuntime('b3');
    flipByte(path.join(d, 'node'), 5_000_000);
    return (await rejects(() => check({ runtimeDir: d }), /bytes differ from the pin/, 'a runtime with one flipped byte')).slice(0, 90);
  },
  async pack_truncated() {
    const d = copyRuntime('b4');
    fs.truncateSync(path.join(d, 'node'), 1_000_000);
    return (await rejects(() => check({ runtimeDir: d }), /bytes, the pin says/, 'a truncated runtime')).slice(0, 90);
  },
  async pack_not_executable() {
    const d = copyRuntime('b5');
    fs.chmodSync(path.join(d, 'node'), 0o644);
    return (await rejects(() => check({ runtimeDir: d }), /not executable/, 'a non-executable runtime')).slice(0, 90);
  },
  async pack_manifest_mismatch() {
    const d = copyRuntime('b6');
    const m = JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8'));
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ ...m, version: '22.0.0' }));
    await rejects(() => check({ runtimeDir: d }), /manifest\.json\.version/, 'a manifest that disagrees with the pin');
    fs.rmSync(path.join(d, 'manifest.json'));
    return (await rejects(() => check({ runtimeDir: d }), /manifest\.json missing/, 'no manifest')).slice(0, 90);
  },
  async pack_cross_arch_refused() {
    const d = copyRuntime('b7');
    const other = HOST_ARCH === 'arm64' ? 'x64' : 'arm64';
    // hostArch faked: this host "cannot execute" the target arch → refuse; the override ships it UNSMOKED and says so
    const pins = { ...REAL_PINS, arch: { ...REAL_PINS.arch, [other]: REAL_PINS.arch[HOST_ARCH] } };
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify({ ...JSON.parse(fs.readFileSync(path.join(d, 'manifest.json'), 'utf8')), arch: other }));
    await rejects(() => checkPackedRuntime({ runtimeDir: d, arch: other, pins, keeperJs: KEEPER_JS }), /cannot smoke a .* runtime on a .* host/, 'a cross-arch pack');
    const ok = await checkPackedRuntime({ runtimeDir: d, arch: other, pins, keeperJs: KEEPER_JS, allowUnsmokedCross: true });
    if (!/NOT smoked/.test(ok)) throw new Error(`override did not say UNSMOKED: ${ok}`);
    return 'refused by default; the override says NOT smoked';
  },

  // the smoke ITSELF (hash gate neutralised by an injected pin that matches the broken file) — proves the keeper-start check has teeth
  async smoke_ok_system_node() {
    const d = path.join(SCR, 's1');
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(d, 'node'));
    fs.chmodSync(path.join(d, 'node'), 0o755);
    const { pins } = injectedPins(path.join(d, 'node'), process.version.slice(1));
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifestFor(pins)));
    const line = await checkPackedRuntime({ runtimeDir: d, arch: HOST_ARCH, pins, keeperJs: KEEPER_JS });
    return line.slice(0, 100);
  },
  async smoke_garbage_binary() {
    const d = injectedRuntime('s2', Buffer.from('this is not an executable\n'.repeat(50)), '22.23.4');
    return (await rejects(() => checkPackedRuntime({ runtimeDir: d.dir, arch: HOST_ARCH, pins: d.pins, keeperJs: KEEPER_JS }), /does not execute/, 'a binary that cannot exec')).slice(0, 100);
  },
  async smoke_stub_binary() {
    // prints the right version and exits 0 — "starts", but is not a node that can host the keeper
    const d = injectedRuntime('s3', Buffer.from('#!/bin/sh\necho v22.23.4\n'), '22.23.4');
    return (await rejects(() => checkPackedRuntime({ runtimeDir: d.dir, arch: HOST_ARCH, pins: d.pins, keeperJs: KEEPER_JS }), /keeper process exited before listening|never accepted/, 'a stub that prints the version')).slice(0, 100);
  },
  async smoke_wrong_version() {
    const d = path.join(SCR, 's4');
    fs.mkdirSync(d, { recursive: true });
    fs.copyFileSync(process.execPath, path.join(d, 'node'));
    fs.chmodSync(path.join(d, 'node'), 0o755);
    const { pins } = injectedPins(path.join(d, 'node'), '22.23.4'); // pinned as 22.23.4 but it IS process.version
    if (process.version === 'v22.23.4') throw new Error('control invalid: the rig node is the pinned version');
    fs.writeFileSync(path.join(d, 'manifest.json'), JSON.stringify(manifestFor(pins)));
    return (await rejects(() => checkPackedRuntime({ runtimeDir: d, arch: HOST_ARCH, pins, keeperJs: KEEPER_JS }), /runtime reports v.*, pinned v22\.23\.4/, 'a runtime of another version')).slice(0, 100);
  },
  async smoke_exec_proxy() {
    // a wrapper that exec's ANOTHER node: runs, right version, serves the keeper — but the keeper is not running on the shipped runtime
    const d = injectedRuntime('s5', Buffer.from(`#!/bin/sh\nexec ${process.execPath} "$@"\n`), process.version.slice(1));
    return (await rejects(() => checkPackedRuntime({ runtimeDir: d.dir, arch: HOST_ARCH, pins: d.pins, keeperJs: KEEPER_JS }), /NOT running on the runtime under test/, 'an exec-proxy runtime')).slice(0, 100);
  },
  async smoke_hello_only_keeper() {
    // a keeper that answers `hello` but never relays the child → the smoke must not call that "a keeper that gets an answer"
    const fake = path.join(SCR, 'hello-only-keeper.cjs');
    fs.writeFileSync(fake, `const net=require('net');const [,,ws,sock]=process.argv;net.createServer((s)=>{s.on('data',(d)=>{for(const l of d.toString().split('\\n')){if(!l.trim())continue;const f=JSON.parse(l);if(f.t==='hello')s.write(JSON.stringify({t:'helloAck',wsId:ws,running:false})+'\\n')}})}).listen(sock);setInterval(()=>{},1000);`);
    return (await rejects(() => smokeKeeper({ nodePath: REAL_NODE, keeperJs: fake, expectVersion: REAL_PIN.version, timeoutMs: 8000 }), /timed out after \d+ ms waiting for the child echo/, 'a keeper that never relays')).slice(0, 100);
  },

  // ---- Group C ----
  async bundled_launch() {
    setResources(fakeResources('c1', '22.23.4'));
    const k = await loadKeeperClient();
    k.installKeeper();
    const dirs = runtimeDirs();
    if (dirs.length !== 1) throw new Error(`expected one versioned runtime dir, got ${dirs.join(',') || 'none'}`);
    const installed = path.join(HOME, 'bin', dirs[0], 'node');
    if (lib.sha256File(installed) !== REAL_PIN.nodeSha256) throw new Error('installed runtime does not hash to the pin');
    const a = await launch('ws-c1');
    const argv = cmdline(a.pid);
    if (argv[0] !== installed) throw new Error(`keeper argv[0] is ${argv[0]}, expected the bundled ${installed}`);
    if (fs.realpathSync(exeOf(a.pid)) !== fs.realpathSync(installed)) throw new Error(`keeper exe is ${exeOf(a.pid)}`);
    if (!(await k.probeKeeper('ws-c1'))?.running) throw new Error('probe did not answer');
    return `keeper pid ${a.pid} argv[0]=${argv[0].replace(HOME, '$HOME')}`;
  },
  async update_keeps_running_keeper() {
    const k = await ensureBase();
    const before = runtimeDirs();
    const a = await launch('ws-c2a'); // launched on the CURRENT runtime
    const aArgv0 = cmdline(a.pid)[0];
    if (!before.some((d) => aArgv0 === path.join(HOME, 'bin', d, 'node'))) throw new Error('control: ws-c2a is not on an installed runtime');
    const ino = fs.statSync(aArgv0).ino;
    // "the update": a package that ships another Node version → installKeeper() at the next app start
    setResources(fakeResources('c2', '22.99.0'));
    k.installKeeper();
    const after = runtimeDirs();
    if (after.length !== before.length + 1) throw new Error(`the update did not add exactly one runtime dir: ${before} → ${after}`);
    const newDir = after.find((d) => !before.includes(d));
    // the running keeper: untouched binary, same exe, still answering
    if (fs.statSync(aArgv0).ino !== ino) throw new Error('the running keeper\'s binary was replaced');
    if (exeOf(a.pid) !== aArgv0 && fs.realpathSync(exeOf(a.pid)) !== fs.realpathSync(aArgv0)) throw new Error(`running keeper exe moved: ${exeOf(a.pid)}`);
    if (/\(deleted\)/.test(exeOf(a.pid) ?? '')) throw new Error('running keeper\'s runtime was deleted');
    if (!(await k.probeKeeper('ws-c2a'))?.running) throw new Error('the running keeper stopped answering after the update');
    // a NEW keeper started after the update gets the NEW runtime
    const b = await launch('ws-c2b');
    const bArgv0 = cmdline(b.pid)[0];
    if (bArgv0 !== path.join(HOME, 'bin', newDir, 'node')) throw new Error(`new keeper argv[0] ${bArgv0}, expected ${newDir}`);
    if (cmdline(a.pid)[0] !== aArgv0) throw new Error('the old keeper\'s argv changed');
    return `old keeper stays on ${path.basename(path.dirname(aArgv0))}, new keeper on ${newDir}`;
  },
  async reinstall_when_wiped() {
    await ensureBase();
    const current = runtimeDirs().at(-1);
    fs.rmSync(path.join(HOME, 'bin', current), { recursive: true, force: true }); // bin/ wiped while the app runs
    const x = await launch('ws-c3');
    const argv0 = cmdline(x.pid)[0];
    if (!argv0.startsWith(path.join(HOME, 'bin', 'node-')) || !fs.existsSync(argv0)) throw new Error(`keeper not on a re-installed runtime: ${argv0}`);
    if (lib.sha256File(argv0) !== REAL_PIN.nodeSha256) throw new Error('re-installed runtime does not hash to the pin');
    return `re-installed ${path.basename(path.dirname(argv0))}`;
  },
  async fallback_without_bundle() {
    const k = await loadKeeperClient();
    for (const d of runtimeDirs()) fs.rmSync(path.join(HOME, 'bin', d), { recursive: true, force: true });
    setResources(path.join(SCR, 'empty-resources')); // a package without pinned-node (dev run, mac/win)
    fs.mkdirSync(process.resourcesPath, { recursive: true });
    const x = await launch('ws-c4');
    const argv0 = cmdline(x.pid)[0];
    if (argv0 !== process.execPath) throw new Error(`without a bundle the keeper should run on the app binary (${process.execPath}), got ${argv0}`);
    if (runtimeDirs().length !== 0) throw new Error('a runtime dir appeared from nothing');
    return `keeper on the app binary ${path.basename(argv0)}`;
  },
  async noexec_bin_refused() {
    // pre-review M1: ORCHESTRA_HOME/bin on a `noexec` mount. The install must REFUSE (so the launcher falls through to the PATH node / app binary, which is what
    // happened before the bundle existed) instead of returning a path whose spawn dies with EACCES. A REAL noexec tmpfs in a private user+mount namespace.
    const res = path.join(SCR, 'nx-res', 'pinned-node');
    fs.mkdirSync(res, { recursive: true });
    const body = '#!/bin/sh\necho stand-in\n';
    fs.writeFileSync(path.join(res, 'node'), body, { mode: 0o755 });
    fs.writeFileSync(path.join(res, 'manifest.json'), JSON.stringify({ version: '22.23.4', arch: HOST_ARCH, tarballSha256: 'a'.repeat(64), nodeSha256: sha(body), nodeBytes: Buffer.byteLength(body) }));
    const probeJs = path.join(SCR, 'noexec-probe.mjs');
    fs.writeFileSync(probeJs, `import { installBundledRuntime } from ${JSON.stringify(`${REPO}/src/main/keeper-runtime-install.ts`)};\nconst bin = process.argv[3]; const first = installBundledRuntime({ resourcesDir: process.argv[2], binDir: bin }); const again = installBundledRuntime({ resourcesDir: process.argv[2], binDir: bin });\nconsole.log('RESULT ' + JSON.stringify({ first, again }));\n`);
    const nodeFlags = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON'];
    const run = (binDir, viaNoexec) => {
      const argv = viaNoexec
        ? ['-Urm', 'sh', '-c', 'mount -t tmpfs -o noexec tmpfs "$1" && exec "$2" "$3" "$4" "$5" "$6" "$1"', 'sh', binDir, process.execPath, ...nodeFlags, probeJs, path.dirname(res)]
        : null;
      const r = viaNoexec
        ? spawnSync('unshare', argv, { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' } })
        : spawnSync(process.execPath, [...nodeFlags, probeJs, path.dirname(res), binDir], { encoding: 'utf8', timeout: 60000, env: { PATH: '/usr/bin:/bin' } });
      const m = /RESULT (.*)/.exec(r.stdout || '');
      if (!m) throw new Error(`probe printed no RESULT (rc ${r.status}): ${(r.stderr || r.stdout || '').trim().split('\n').slice(-2).join(' | ').slice(0, 200)}`);
      return JSON.parse(m[1]);
    };
    // POSITIVE CONTROL: the same install on an ordinary dir succeeds and yields an executable
    const okDir = path.join(SCR, 'nx-ok-bin');
    fs.mkdirSync(okDir, { recursive: true });
    const control = run(okDir, false);
    if (!control.first.ok || !control.again.ok) throw new Error(`control failed: ${JSON.stringify(control).slice(0, 200)}`);
    // the arm: the noexec mount
    const nxDir = path.join(SCR, 'nx-bin');
    fs.mkdirSync(nxDir, { recursive: true });
    const nx = run(nxDir, true);
    for (const [label, r] of [['first', nx.first], ['again', nx.again]]) {
      if (r.ok !== false || !/not executable here/.test(r.reason ?? '')) throw new Error(`${label} install on a noexec mount was not refused: ${JSON.stringify(r).slice(0, 220)}`);
    }
    return `noexec bin/: refused twice (${nx.first.reason.slice(0, 70)}…); an ordinary dir installs`;
  },
};

function injectedPins(nodeFile, version) {
  const body = fs.readFileSync(nodeFile);
  return { pins: { version, source: 'https://example.invalid/', arch: { [HOST_ARCH]: { tarball: `node-v${version}-linux-${HOST_ARCH}.tar.gz`, tarballSha256: 'f'.repeat(64), nodeSha256: sha(body), nodeBytes: body.length } } } };
}
const manifestFor = (pins) => { const e = pins.arch[HOST_ARCH]; return { version: pins.version, arch: HOST_ARCH, tarballSha256: e.tarballSha256, nodeSha256: e.nodeSha256, nodeBytes: e.nodeBytes }; };
function injectedRuntime(name, body, version) {
  const dir = path.join(SCR, name);
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'node'), body, { mode: 0o755 });
  const { pins } = injectedPins(path.join(dir, 'node'), version);
  fs.writeFileSync(path.join(dir, 'manifest.json'), JSON.stringify(manifestFor(pins)));
  return { dir, pins };
}

// ── run ────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const want = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : Object.keys(ARMS);
for (const w of want) if (!ARMS[w]) { console.log(`PINNED-NODE: FAIL unknown arm ${w}`); process.exit(2); }
let pass = 0;
const failed = [];
for (const name of want) {
  try {
    const detail = await ARMS[name]();
    console.log(`ARM ${name}: PASS ${detail ?? ''}`);
    pass++;
  } catch (e) {
    console.log(`ARM ${name}: FAIL ${String(e?.message ?? e).split('\n')[0].slice(0, 300)}`);
    failed.push(name);
  }
}
// teardown: our own keepers, by workspace id through the facade, then identity-checked pid files
try {
  if (kc) for (const ws of wsLaunched) await kc.killKeeper(ws, 'pinned-node-rig-teardown').catch(() => {});
  for (const ws of wsLaunched) { const pid = keeperPid(ws); if (pid && alive(pid) && cmdline(pid).some((a) => a.endsWith('keeper.js')) && cmdline(pid).includes(ws)) try { process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
} catch { /* best effort */ }
spawnSync('rm', ['-rf', '--', SCR]);
if (failed.length === 0 && pass === want.length) {
  console.log(`PINNED-NODE: ALL PASS (${pass}/${want.length}) tree ${REPO}`);
  process.exit(0);
}
console.log(`PINNED-NODE: FAIL (${failed.length} of ${want.length}): ${failed.join(', ')}`);
process.exit(1);
