// afterPack check for the pinned Node (#390). The release gate for "the bundled runtime works": what landed in the package must be the
// pinned bytes, executable, AND must start the real keeper bundle and get an answer (smoke.cjs). Any failure throws → electron-builder
// fails → `pnpm run build` fails → release.sh stops before tagging/publishing (and the CI build job goes red).
// Called from scripts/after-pack-check.cjs; the rigs call checkPackedRuntime directly with an injected pin table.

'use strict';

const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { loadPins, pinFor, sha256File, MANIFEST_NAME } = require('./lib.cjs');
const { smokeKeeper } = require('./smoke.cjs');

const ARCH = { 1: 'x64', 3: 'arm64' }; // builder-util Arch enum

/**
 * Verify `<runtimeDir>/node` (+ manifest.json) against the pin for `arch`, then smoke it with `keeperJs`.
 * Cross-arch (a runtime this host cannot execute) is REFUSED unless allowUnsmokedCross — never a quiet skip.
 * Returns a one-line summary; throws an Error naming the first failed clause.
 */
async function checkPackedRuntime({ runtimeDir, arch, pins = loadPins(), keeperJs, hostArch = process.arch, allowUnsmokedCross = false }) {
  const pin = pinFor(pins, arch);
  const nodePath = path.join(runtimeDir, 'node');
  let st;
  try {
    st = fs.statSync(nodePath);
  } catch {
    throw new Error(`pinned Node ABSENT from the package: ${nodePath} (build.linux.extraResources / beforePack did not deliver it)`);
  }
  if (!st.isFile()) throw new Error(`pinned Node is not a regular file: ${nodePath}`);
  if ((st.mode & 0o111) === 0) throw new Error(`pinned Node is not executable (mode ${(st.mode & 0o777).toString(8)}): ${nodePath}`);
  if (st.size !== pin.nodeBytes) throw new Error(`pinned Node is ${st.size} bytes, the pin says ${pin.nodeBytes}: ${nodePath}`);
  const got = sha256File(nodePath);
  if (got !== pin.nodeSha256) throw new Error(`pinned Node bytes differ from the pin: SHA-256 ${got}, pinned ${pin.nodeSha256} (${nodePath})`);
  let manifest;
  try {
    manifest = JSON.parse(fs.readFileSync(path.join(runtimeDir, MANIFEST_NAME), 'utf8'));
  } catch (e) {
    throw new Error(`${MANIFEST_NAME} missing/unreadable beside the pinned Node: ${e.message}`);
  }
  for (const k of ['version', 'arch', 'tarballSha256', 'nodeSha256', 'nodeBytes']) {
    if (manifest[k] !== (k === 'arch' ? arch : pin[k])) throw new Error(`${MANIFEST_NAME}.${k} is ${JSON.stringify(manifest[k])}, the pin says ${JSON.stringify(k === 'arch' ? arch : pin[k])}`);
  }
  if (hostArch !== arch) {
    if (!allowUnsmokedCross) {
      throw new Error(`cannot smoke a ${arch} runtime on a ${hostArch} host — build ${arch} natively (CI does) or set ORCHESTRA_PINNED_NODE_ALLOW_CROSS=1 to ship it UNSMOKED`);
    }
    return `pinned Node v${pin.version} (${arch}) hash-verified, NOT smoked (cross-arch override)`;
  }
  const r = await smokeKeeper({ nodePath, keeperJs, expectVersion: pin.version });
  return `pinned Node ${r.version} (${arch}) hash-verified, started the keeper and relayed a child (exe ${r.exe})`;
}

/** The afterPack entry: linux only; reads the keeper bundle from the PACKAGED app (the exact bytes users get), not from dist-electron. */
async function packCheck(context) {
  if (context.electronPlatformName !== 'linux') {
    console.log(`  • afterPack: pinned Node — not bundled on ${context.electronPlatformName} (keepers use the app binary there)`);
    return;
  }
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`afterPack: linux arch '${context.arch}' has no pinned Node`);
  const resources = path.join(context.appOutDir, 'resources');
  const scratch = fs.mkdtempSync(path.join(os.tmpdir(), 'pn-pack-'));
  try {
    const keeperJs = path.join(scratch, 'keeper.js');
    const asar = path.join(resources, 'app.asar');
    if (fs.existsSync(asar)) fs.writeFileSync(keeperJs, require('@electron/asar').extractFile(asar, 'dist-electron/keeper.js'));
    else fs.copyFileSync(path.join(resources, 'app', 'dist-electron', 'keeper.js'), keeperJs);
    const line = await checkPackedRuntime({
      runtimeDir: path.join(resources, 'pinned-node'),
      arch,
      keeperJs,
      allowUnsmokedCross: process.env.ORCHESTRA_PINNED_NODE_ALLOW_CROSS === '1',
    });
    console.log(`  • afterPack: ${line}`);
  } catch (e) {
    throw new Error(`afterPack: pinned Node check FAILED — ${e.message}`);
  } finally {
    fs.rmSync(scratch, { recursive: true, force: true });
  }
}

module.exports = { checkPackedRuntime, packCheck };
