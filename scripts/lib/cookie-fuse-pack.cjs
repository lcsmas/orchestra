// The afterPack half of the cookie-encryption fuse (#407): flip it iff the shipped policy says so, then READ the packaged binary's wire back and fail the release if it
// disagrees. electron-builder runs `afterPack` BEFORE its own `electronFuses` flip (app-builder-lib platformPackager.js: emitAfterPack … doAddElectronFuses), so a flip and
// its proof both live here, through the public `context.packager.addElectronFuses`. Split from after-pack-check.cjs so scripts/verify-cookie-fuse-check.mjs can drive it
// against scratch copies of a real packaged binary with a stand-in packager.
'use strict';
const path = require('node:path');
const { readFuseWireFile, expectCookieFuse, V1_NAMES } = require('./fuse-wire.cjs');

const COOKIE_FUSE_INDEX = V1_NAMES.indexOf('EnableCookieEncryption');

/** @returns {Promise<{message: string}>} throws (the release fails) when the binary's wire disagrees with `shipped` */
async function ensureCookieFuse(context, shipped, binary) {
  const bin = binary || path.join(context.appOutDir, 'orchestra');
  if (shipped) await context.packager.addElectronFuses(context, { version: '1', [COOKIE_FUSE_INDEX]: true });
  const r = expectCookieFuse(readFuseWireFile(bin), shipped);
  if (!r.ok) throw new Error(`afterPack: ${r.message}`);
  return { message: r.message };
}

module.exports = { ensureCookieFuse, COOKIE_FUSE_INDEX };
