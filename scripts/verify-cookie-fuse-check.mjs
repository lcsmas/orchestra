// #407 — the MUST-FAIL arm of the release step that proves the cookie-encryption fuse: scripts/lib/cookie-fuse-pack.cjs `ensureCookieFuse` (called by afterPack) run against scratch
// copies of a REAL packaged binary (argv[2] = release/linux-arm64-unpacked/orchestra; never written), with a stand-in packager whose addElectronFuses is the real @electron/fuses flip.
//   ctl   shipped=false · stock binary                       → passes            (the control: the step is not red for everything)
//   mf1   shipped=false · binary flipped ON in a scratch copy → THROWS            (the ticket's must-FAIL: flip the fuse in a scratch build ⇒ the step fails)
//   fl    shipped=true  · stock binary                       → flips, then passes (the flip config the held commit relies on is accepted by @electron/fuses and lands)
//   mf2   shipped=true  · a packager whose flip silently does nothing → THROWS    (a flip that did not happen cannot ship)
//   mf3   shipped=false · a file with no fuse wire            → THROWS            (an unreadable wire fails closed)
// Usage: node scripts/verify-cookie-fuse-check.mjs <packaged orchestra binary>   (pnpm run test:cookie-fuse-check <binary>)
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const here = path.dirname(new URL(import.meta.url).pathname);
const { ensureCookieFuse } = require('./lib/cookie-fuse-pack.cjs');
const { readFuseWireFile } = require('./lib/fuse-wire.cjs');
const { COOKIE_ENCRYPTION_FUSE_SHIPPED } = require('./lib/cookie-fuse-policy.cjs');

const src = process.argv[2];
if (!src || !fs.existsSync(src)) { console.error('usage: verify-cookie-fuse-check.mjs <packaged orchestra binary>'); process.exit(2); }
const eb = require.resolve('electron-builder/package.json', { paths: [path.resolve(here, '..')] });
const fuses = require(require.resolve('@electron/fuses', { paths: [path.dirname(require.resolve('app-builder-lib/package.json', { paths: [path.dirname(eb)] }))] }));

const scratch = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'cookie-fuse-check-'));
const copy = (name) => { const f = path.join(scratch, name); execFileSync('cp', ['--reflink=auto', src, f]); return f; };
const realPackager = (bin) => ({ addElectronFuses: async (_ctx, cfg) => fuses.flipFuses(bin, cfg) });
const results = [];
const arm = async (name, expectThrow, fn) => {
  let threw = null;
  try { await fn(); } catch (e) { threw = String(e.message ?? e); }
  const ok = expectThrow ? threw !== null : threw === null;
  results.push({ name, ok });
  console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${expectThrow ? (threw ? `threw: ${threw.slice(0, 150)}` : 'DID NOT THROW (the release would ship)') : (threw ? `threw: ${threw.slice(0, 150)}` : 'passed')}`);
};

try {
  const stock = readFuseWireFile(src);
  console.log(`source binary: EnableCookieEncryption=${stock.ok ? stock.fuses.EnableCookieEncryption : stock.reason}; shipped policy COOKIE_ENCRYPTION_FUSE_SHIPPED=${COOKIE_ENCRYPTION_FUSE_SHIPPED}`);
  if (!stock.ok || stock.fuses.EnableCookieEncryption !== 'disabled') { console.log('ABORT: the source must be the stock (fuse OFF) packaged binary — this arm flips scratch copies of it'); process.exit(2); }

  await arm('ctl: shipped=false, stock binary passes', false, () => ensureCookieFuse({}, false, copy('ctl')));
  await arm('mf1: shipped=false, binary flipped ON in a scratch build → the step FAILS', true, async () => { const b = copy('mf1'); await fuses.flipFuses(b, { version: '1', 1: true }); return ensureCookieFuse({}, false, b); });
  await arm('fl: shipped=true, stock binary is flipped by the hook and passes', false, async () => { const b = copy('fl'); await ensureCookieFuse({ packager: realPackager(b) }, true, b); if (readFuseWireFile(b).fuses.EnableCookieEncryption !== 'enabled') throw new Error('flip did not land'); });
  await arm('mf2: shipped=true but the flip silently does nothing → the step FAILS', true, () => ensureCookieFuse({ packager: { addElectronFuses: async () => {} } }, true, copy('mf2')));
  await arm('mf3: a file with no fuse wire → the step FAILS closed', true, () => { const b = path.join(scratch, 'mf3'); fs.writeFileSync(b, 'not an electron binary'); return ensureCookieFuse({}, false, b); });
  // the arms are only worth something if the pair differ: the SAME call, flipped vs stock, with the policy fixed
  const sameCall = results.find((r) => r.name.startsWith('ctl'))?.ok && results.find((r) => r.name.startsWith('mf1'))?.ok;
  console.log(`  ${sameCall ? 'PASS' : 'FAIL'}  pair: the identical shipped=false call passes on the stock binary and fails on the flipped one`);
  results.push({ name: 'pair', ok: !!sameCall });
} finally { fs.rmSync(scratch, { recursive: true, force: true }); }
const red = results.filter((r) => !r.ok);
console.log(red.length === 0 ? `\nALL ${results.length} ARMS GREEN` : `\nRED: ${red.map((r) => r.name).join(' | ')}`);
process.exit(red.length === 0 ? 0 : 1);
