// Flip Electron's EnableCookieEncryption fuse in a COPY of a packaged app (#407 rig) with @electron/fuses, and print the evidence as JSON:
// both wires read by the independent parser (scripts/lib/fuse-wire.cjs) and by @electron/fuses itself. Usage: node flip-cookie-fuse.cjs <binary> [--off]
// (`--off` flips nothing: it only reads.) @electron/fuses is a transitive dependency of electron-builder, so it is resolved THROUGH electron-builder.
'use strict';
const path = require('node:path');
const fs = require('node:fs');
const { readFuseWireFile } = require('./fuse-wire.cjs');

function loadFuses() {
  const eb = require.resolve('electron-builder/package.json', { paths: [process.cwd(), __dirname] });
  const abl = require.resolve('app-builder-lib/package.json', { paths: [path.dirname(eb)] });
  return require(require.resolve('@electron/fuses', { paths: [path.dirname(abl)] }));
}

async function main() {
  const bin = process.argv[2];
  const readOnly = process.argv.includes('--off');
  if (!bin || !fs.existsSync(bin)) throw new Error(`usage: flip-cookie-fuse.cjs <binary> [--off] (got ${bin})`);
  const fuses = loadFuses();
  const before = readFuseWireFile(bin);
  if (!readOnly) await fuses.flipFuses(bin, { version: fuses.FuseVersion.V1, [fuses.FuseV1Options.EnableCookieEncryption]: true });
  const after = readFuseWireFile(bin);
  const lib = await fuses.getCurrentFuseWire(bin);
  const libState = lib[fuses.FuseV1Options.EnableCookieEncryption] === 49 ? 'enabled' : lib[fuses.FuseV1Options.EnableCookieEncryption] === 48 ? 'disabled' : `other:${lib[fuses.FuseV1Options.EnableCookieEncryption]}`;
  process.stdout.write(JSON.stringify({ bin, flipped: !readOnly, before: before.ok ? before.fuses.EnableCookieEncryption : before.reason, after: after.ok ? after.fuses.EnableCookieEncryption : after.reason, library: libState, wire: after.ok ? after.fuses : null }) + '\n');
}
main().catch((e) => { process.stderr.write(String(e.stack || e) + '\n'); process.exit(1); });
