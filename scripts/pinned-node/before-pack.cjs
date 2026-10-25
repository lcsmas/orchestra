// electron-builder beforePack hook (#390): put the pinned, hash-checked Node for this pack's linux arch at build/pinned-node/<arch>/
// (node + manifest.json) so package.json build.linux.extraResources ships it as resources/pinned-node/. Any failure (offline, hash
// mismatch, bad tar) throws and stops the build — pack-check.cjs (afterPack) re-verifies what actually landed in the package.

'use strict';

const { prepareRuntime, defaultDirs } = require('./lib.cjs');

const ARCH = { 1: 'x64', 3: 'arm64' }; // builder-util Arch enum

exports.default = async function beforePack(context) {
  if (context.electronPlatformName !== 'linux') return; // mac/win keepers keep the app's own binary
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`beforePack: linux arch '${context.arch}' has no pinned Node (pinned: x64, arm64)`);
  const { outDir, cacheDir } = defaultDirs(arch);
  const t0 = Date.now();
  const r = await prepareRuntime({ arch, outDir, cacheDir });
  console.log(`  • beforePack: pinned Node v${r.manifest.version} (${arch}, ${r.source}) → ${r.nodePath} [${Date.now() - t0} ms]`);
};
