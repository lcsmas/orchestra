// Pinned Node for the keepers (#390): fetch → SHA-256 check against scripts/pinned-node/pins.json → extract bin/node.
// Used by the electron-builder beforePack hook and by the rigs. Every download/extract is untrusted data: it lands in its own
// fresh directory, is hashed BEFORE it is extracted, and the extracted binary is hashed again against the pinned value.

'use strict';

const fs = require('node:fs');
const path = require('node:path');
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');

const PINS_FILE = path.join(__dirname, 'pins.json');
const REPO = path.resolve(__dirname, '..', '..');
const MANIFEST_NAME = 'manifest.json';
const HEX64 = /^[0-9a-f]{64}$/;

/** Read + validate the pin file. Throws on any shape error — a malformed pin must stop the build, not weaken it. */
function loadPins(file = PINS_FILE) {
  const pins = JSON.parse(fs.readFileSync(file, 'utf8'));
  if (typeof pins.version !== 'string' || !/^\d+\.\d+\.\d+$/.test(pins.version)) throw new Error(`pinned-node: ${file}: bad version`);
  if (typeof pins.source !== 'string' || !pins.source.startsWith('https://')) throw new Error(`pinned-node: ${file}: source must be https`);
  if (!pins.arch || typeof pins.arch !== 'object') throw new Error(`pinned-node: ${file}: no arch table`);
  for (const [arch, e] of Object.entries(pins.arch)) {
    if (!HEX64.test(e.tarballSha256 || '') || !HEX64.test(e.nodeSha256 || '')) throw new Error(`pinned-node: ${file}: ${arch}: tarballSha256/nodeSha256 must be 64 lowercase hex`);
    if (!Number.isInteger(e.nodeBytes) || e.nodeBytes <= 0) throw new Error(`pinned-node: ${file}: ${arch}: bad nodeBytes`);
    if (e.tarball !== `node-v${pins.version}-linux-${arch}.tar.gz`) throw new Error(`pinned-node: ${file}: ${arch}: tarball name must be node-v${pins.version}-linux-${arch}.tar.gz`);
  }
  return pins;
}

/** The pin for one linux arch ('arm64' | 'x64'). */
function pinFor(pins, arch) {
  const e = pins.arch[arch];
  if (!e) throw new Error(`pinned-node: no pin for arch '${arch}' (pinned: ${Object.keys(pins.arch).join(', ')})`);
  return { version: pins.version, arch, ...e };
}

function sha256File(file) {
  const h = crypto.createHash('sha256');
  const fd = fs.openSync(file, 'r');
  try {
    const buf = Buffer.allocUnsafe(1 << 20);
    for (;;) {
      const n = fs.readSync(fd, buf, 0, buf.length, null);
      if (n === 0) break;
      h.update(buf.subarray(0, n));
    }
  } finally {
    fs.closeSync(fd);
  }
  return h.digest('hex');
}

/** Throws unless `file` hashes to `expected` (the error names both hashes). */
function assertSha256(file, expected, what) {
  const got = sha256File(file);
  if (got !== expected) throw new Error(`pinned-node: ${what} SHA-256 mismatch: expected ${expected}, got ${got} (${file})`);
}

async function download(url, dest) {
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok || !res.body) throw new Error(`pinned-node: GET ${url} → HTTP ${res.status}`);
  const { Readable } = require('node:stream');
  const { pipeline } = require('node:stream/promises');
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest));
}

/**
 * Produce `<outDir>/node` (+ `manifest.json`) for `arch` from the pinned tarball. Idempotent: an outDir whose binary already hashes to the pin is left alone.
 * `cacheDir` holds the tarball (re-hashed on EVERY use, so a poisoned cache is never trusted); `mirror` overrides the download base URL (tests).
 * Returns { nodePath, manifest, source: 'cached-output'|'cached-tarball'|'downloaded' }.
 */
async function prepareRuntime({ arch, outDir, cacheDir, pins = loadPins(), mirror }) {
  const pin = pinFor(pins, arch);
  const manifest = { version: pin.version, arch, tarballSha256: pin.tarballSha256, nodeSha256: pin.nodeSha256, nodeBytes: pin.nodeBytes };
  const nodePath = path.join(outDir, 'node');
  try {
    if (fs.statSync(nodePath).size === pin.nodeBytes && sha256File(nodePath) === pin.nodeSha256 && JSON.stringify(JSON.parse(fs.readFileSync(path.join(outDir, MANIFEST_NAME), 'utf8'))) === JSON.stringify(manifest)) {
      return { nodePath, manifest, source: 'cached-output' };
    }
  } catch {
    /* absent or stale → rebuild below */
  }

  fs.mkdirSync(cacheDir, { recursive: true });
  const tarball = path.join(cacheDir, pin.tarball);
  let source = 'cached-tarball';
  let ok = false;
  try {
    assertSha256(tarball, pin.tarballSha256, `cached ${pin.tarball}`);
    ok = true;
  } catch {
    fs.rmSync(tarball, { force: true }); // absent, truncated or poisoned: never keep it
  }
  if (!ok) {
    source = 'downloaded';
    const part = `${tarball}.part-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
    try {
      await download(`${(mirror || pins.source).replace(/\/?$/, '/')}${pin.tarball}`, part);
      assertSha256(part, pin.tarballSha256, `downloaded ${pin.tarball}`); // BEFORE it is ever extracted
      fs.renameSync(part, tarball);
    } finally {
      fs.rmSync(part, { force: true });
    }
  }

  const tmp = `${outDir}.tmp-${process.pid}-${crypto.randomBytes(4).toString('hex')}`;
  fs.rmSync(tmp, { recursive: true, force: true });
  fs.mkdirSync(tmp, { recursive: true });
  try {
    const top = `node-v${pin.version}-linux-${arch}`;
    execFileSync('tar', ['-xzf', tarball, '-C', tmp, '--strip-components=2', `${top}/bin/node`], { stdio: ['ignore', 'ignore', 'pipe'] });
    const extracted = path.join(tmp, 'node');
    const st = fs.statSync(extracted);
    if (!st.isFile() || st.size !== pin.nodeBytes) throw new Error(`pinned-node: extracted bin/node is ${st.size} bytes, pinned ${pin.nodeBytes}`);
    assertSha256(extracted, pin.nodeSha256, 'extracted bin/node');
    fs.chmodSync(extracted, 0o755);
    fs.writeFileSync(path.join(tmp, MANIFEST_NAME), JSON.stringify(manifest, null, 2) + '\n');
    fs.rmSync(outDir, { recursive: true, force: true });
    fs.mkdirSync(path.dirname(outDir), { recursive: true });
    fs.renameSync(tmp, outDir);
  } finally {
    fs.rmSync(tmp, { recursive: true, force: true });
  }
  return { nodePath, manifest, source };
}

/** The dirs of the real build (gitignored, inside the worktree). `outDir` MUST match package.json build.linux.extraResources `from`; only the tarball cache is overridable (rigs). */
function defaultDirs(arch) {
  const root = path.join(REPO, 'build', 'pinned-node');
  return { outDir: path.join(root, arch), cacheDir: process.env.ORCHESTRA_PINNED_NODE_CACHE || path.join(root, '.cache') };
}

module.exports = { PINS_FILE, MANIFEST_NAME, REPO, loadPins, pinFor, sha256File, assertSha256, prepareRuntime, defaultDirs };
