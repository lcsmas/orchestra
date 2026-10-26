// electron-builder beforePack hook: the pinned Node (#390, scripts/pinned-node/before-pack.cjs) and the pinned agent-browser (#395,
// scripts/agent-browser-fetch.cjs → build/agent-browser/agent-browser, shipped by build.extraResources). One hook runs on EVERY packaging
// path (pnpm run build, release CI, composed drives, canaries), so none of them needs its own fetch step; afterPack re-verifies both.
// Everything here is plain CommonJS run IN-PROCESS: release.yml packs under Node 20, which has no --experimental-strip-types.

'use strict';

const { ensureAgentBrowser, describe } = require('./agent-browser-fetch.cjs');

const ARCH = { 1: 'x64', 3: 'arm64' }; // builder-util Arch enum

exports.default = async function beforePack(context) {
  await require('./pinned-node/before-pack.cjs').default(context);
  if (context.electronPlatformName !== 'linux') return; // only linux builds are pinned
  const arch = ARCH[context.arch];
  if (!arch) throw new Error(`beforePack: linux arch '${context.arch}' has no pinned agent-browser (pinned: x64, arm64)`);
  console.log(`  • beforePack: ${describe(await ensureAgentBrowser({ platform: 'linux', arch }))}`);
};
