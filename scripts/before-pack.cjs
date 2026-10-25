// electron-builder beforePack hook: the pinned Node (#390, scripts/pinned-node/before-pack.cjs) and the pinned agent-browser (#395,
// scripts/fetch-agent-browser.mjs → build/agent-browser/agent-browser, shipped by build.extraResources). One hook runs on EVERY packaging
// path (pnpm run build, release CI, composed drives, canaries), so none of them needs its own fetch step; afterPack re-verifies both.

'use strict';

const path = require('node:path');
const { execFileSync } = require('node:child_process');

const ARCH = { 1: 'x64', 3: 'arm64' }; // builder-util Arch enum

exports.default = async function beforePack(context) {
  await require('./pinned-node/before-pack.cjs').default(context);
  if (context.electronPlatformName !== 'linux') return; // only linux builds are pinned
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`beforePack: linux arch '${context.arch}' has no pinned agent-browser (pinned: x64, arm64)`);
  const out = execFileSync(process.execPath, ['--experimental-strip-types', path.join(__dirname, 'fetch-agent-browser.mjs'), '--platform', 'linux', '--arch', arch], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'inherit'] });
  console.log(`  • beforePack: ${out.trim().split('\n').pop()}`);
};
