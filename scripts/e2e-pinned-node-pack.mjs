// #390 — the REAL electron-builder chain: does a corrupted / missing pinned Node STOP a pack? (the "release-build step … failure blocks the release" clause)
// Drives `electron-builder --linux dir` (unpacked app, no AppImage squash) with the repo's own build config + hooks, the runtime staged by the rig so it can be
// damaged. The full AppImage path (beforePack download → extraResources → afterPack → AppImage) is exercised by `pnpm run build` itself.
// Needs: `pnpm run build:bundles` (dist/, dist-electron/*) and `pnpm run build:bus-abi` (afterPack probes native modules under Electron's ABI).
// Packaged builds serialize fleet-wide: the pack runs under `flock $PKG_LOCK` (default /var/tmp/orch-1000-b17728/pkg-388.lock).
// Run: node scripts/e2e-pinned-node-pack.mjs [chain_good,chain_corrupt,chain_missing,mutant_unwired_hook]
// Terminator: `PINNED-NODE-PACK: ALL PASS (N/N)` (rc 0).

import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const require = createRequire(import.meta.url);
const lib = require('./pinned-node/lib.cjs');
const ARCH = process.arch;
const LOCK = process.env.PKG_LOCK || '/var/tmp/orch-1000-b17728/pkg-388.lock';
const SCR = fs.mkdtempSync(path.join(os.tmpdir(), 'pnpack-'));
const sha = (f) => crypto.createHash('sha256').update(fs.readFileSync(f)).digest('hex');

for (const f of ['dist/index.html', 'dist-electron/main.js', 'dist-electron/preload.js', 'dist-electron/cli.js', 'dist-electron/keeper.js']) {
  if (!fs.existsSync(path.join(REPO, f))) { console.log(`PINNED-NODE-PACK: FAIL precondition: ${f} missing — run \`pnpm run build:bundles\` first`); process.exit(2); }
}

const pin = lib.pinFor(lib.loadPins(), ARCH);
const { cacheDir } = lib.defaultDirs(ARCH);
const real = await lib.prepareRuntime({ arch: ARCH, outDir: path.join(SCR, 'real'), cacheDir });

/** Stage `<stage>/<arch>/{node,manifest.json}`: a good runtime, a one-byte-flipped one, or nothing at all (extraResources then skips the missing source SILENTLY — the trap). */
function stage(name, kind) {
  const root = path.join(SCR, `stage-${name}`);
  if (kind === 'missing') return root;
  const d = path.join(root, ARCH);
  fs.mkdirSync(d, { recursive: true });
  fs.copyFileSync(real.nodePath, path.join(d, 'node'));
  fs.chmodSync(path.join(d, 'node'), 0o755);
  fs.copyFileSync(path.join(path.dirname(real.nodePath), 'manifest.json'), path.join(d, 'manifest.json'));
  if (kind === 'corrupt') { const fd = fs.openSync(path.join(d, 'node'), 'r+'); const b = Buffer.alloc(1); fs.readSync(fd, b, 0, 1, 7_000_000); b[0] ^= 0xff; fs.writeSync(fd, b, 0, 1, 7_000_000); fs.closeSync(fd); }
  return root;
}

function pack(name, kind, afterPack = path.join(REPO, 'scripts', 'after-pack-check.cjs')) {
  const build = JSON.parse(fs.readFileSync(path.join(REPO, 'package.json'), 'utf8')).build;
  delete build.beforePack; // the rig stages the runtime itself (so it can damage it); beforePack has its own arms in e2e-pinned-node.mjs
  build.afterPack = afterPack;
  build.directories = { ...build.directories, output: path.join(SCR, `out-${name}`) };
  build.linux = { ...build.linux, target: ['dir'] };
  build.linux.extraResources = [{ from: path.join(stage(name, kind), '${arch}'), to: 'pinned-node' }];
  const cfg = path.join(SCR, `cfg-${name}.json`);
  fs.writeFileSync(cfg, JSON.stringify(build));
  fs.mkdirSync(path.dirname(LOCK), { recursive: true });
  const r = spawsync(['flock', LOCK, path.join(REPO, 'node_modules', '.bin', 'electron-builder'), '--linux', 'dir', '--config', cfg, '--publish', 'never']);
  const out = `${r.stdout}\n${r.stderr}`;
  const unpacked = path.join(SCR, `out-${name}`, `linux-${ARCH}-unpacked`, 'resources', 'pinned-node');
  return { rc: r.status, out, unpacked };
}
function spawsync(argv) {
  return spawnSync('nice', ['-n', '10', ...argv], { cwd: REPO, encoding: 'utf8', timeout: 900_000, maxBuffer: 64 << 20, env: { ...process.env, CSC_IDENTITY_AUTO_DISCOVERY: 'false' } });
}
const tail = (out) => out.trim().split('\n').slice(-6).join(' ⏎ ').slice(0, 400);

const ARMS = {
  async chain_good() {
    const r = pack('good', 'good');
    if (r.rc !== 0) throw new Error(`control: a good runtime FAILED the pack (rc ${r.rc}): ${tail(r.out)}`);
    if (!/afterPack: pinned Node v22\.\d+\.\d+ \(\w+\) hash-verified, started the keeper and relayed a child/.test(r.out)) throw new Error(`no afterPack smoke line in the output: ${tail(r.out)}`);
    const n = path.join(r.unpacked, 'node');
    if (sha(n) !== pin.nodeSha256 || (fs.statSync(n).mode & 0o111) === 0) throw new Error('the shipped node is not the pinned, executable bytes');
    return `pack rc 0; shipped resources/pinned-node/node = pin ${pin.nodeSha256.slice(0, 12)}, executable; afterPack smoke line present`;
  },
  async chain_corrupt() {
    const r = pack('corrupt', 'corrupt');
    if (r.rc === 0) throw new Error('a CORRUPTED runtime did not fail the pack');
    if (!/pinned Node check FAILED — pinned Node bytes differ from the pin/.test(r.out)) throw new Error(`failed, but not for the corrupted runtime: ${tail(r.out)}`);
    return `pack rc ${r.rc}: ${/pinned Node check FAILED[^\n]*/.exec(r.out)?.[0].slice(0, 110)}`;
  },
  async chain_missing() {
    const r = pack('missing', 'missing');
    if (r.rc === 0) throw new Error('a package WITHOUT the runtime did not fail (extraResources skips a missing source silently)');
    if (!/pinned Node ABSENT from the package/.test(r.out)) throw new Error(`failed, but not for the missing runtime: ${tail(r.out)}`);
    return `pack rc ${r.rc}: ${/pinned Node ABSENT[^\n]*/.exec(r.out)?.[0].slice(0, 100)}`;
  },
  // MUTANT: the afterPack hook without the pinned-node call. The corrupted runtime MUST sail through — proof chain_corrupt depends on the wiring.
  async mutant_unwired_hook() {
    const src = fs.readFileSync(path.join(REPO, 'scripts', 'after-pack-check.cjs'), 'utf8');
    const call = "  await require('./pinned-node/pack-check.cjs').packCheck(context);\n";
    if (src.split(call).length !== 2) throw new Error('anchor drifted: the packCheck call is not exactly once in after-pack-check.cjs');
    const mutant = path.join(REPO, 'scripts', '.after-pack-mutant-390.cjs'); // beside the original so its relative requires resolve; removed below
    fs.writeFileSync(mutant, src.replace(call, ''));
    try {
      const r = pack('unwired', 'corrupt', mutant);
      if (r.rc !== 0) throw new Error(`control: the unwired hook still failed the pack (rc ${r.rc}): ${tail(r.out)}`);
      return 'with the packCheck call removed, a CORRUPTED runtime ships (rc 0) — the wiring is what blocks it';
    } finally {
      fs.rmSync(mutant, { force: true });
    }
  },
};

const want = process.argv[2] && process.argv[2] !== 'all' ? process.argv[2].split(',') : Object.keys(ARMS);
let pass = 0;
const failed = [];
for (const name of want) {
  if (!ARMS[name]) { console.log(`PINNED-NODE-PACK: FAIL unknown arm ${name}`); process.exit(2); }
  try {
    console.log(`ARM ${name}: PASS ${await ARMS[name]()}`);
    pass++;
  } catch (e) {
    console.log(`ARM ${name}: FAIL ${String(e?.message ?? e).split('\n')[0].slice(0, 500)}`);
    failed.push(name);
  }
}
fs.rmSync(SCR, { recursive: true, force: true });
if (!failed.length && pass === want.length) { console.log(`PINNED-NODE-PACK: ALL PASS (${pass}/${want.length}) tree ${REPO}`); process.exit(0); }
console.log(`PINNED-NODE-PACK: FAIL (${failed.length} of ${want.length}): ${failed.join(', ')}`);
process.exit(1);
