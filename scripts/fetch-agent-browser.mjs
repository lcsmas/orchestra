// Fetch the PINNED agent-browser release asset for this build host (#395, ADR 0009) into
// build/agent-browser/agent-browser, SHA-256 checked against scripts/agent-browser-pins.json.
// usage: node scripts/fetch-agent-browser.mjs [--check] [--arch x64|arm64] [--platform linux]   (--check: verify what is there, download nothing; --arch/--platform default to this host)
// A cache under $XDG_CACHE_HOME/orchestra-build keeps rebuilds offline; a hash mismatch is fatal, never a retry.
import { createHash } from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { assetFor } from '../src/shared/agent-browser-binary.ts';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const pins = JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'agent-browser-pins.json'), 'utf8'));
const checkOnly = process.argv.includes('--check');
const sha256 = (file) => createHash('sha256').update(fs.readFileSync(file)).digest('hex');

const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
const asset = assetFor(pins, argOf('--platform') ?? process.platform, argOf('--arch') ?? process.arch);
if (!asset) {
  console.error(`fetch-agent-browser: no pinned asset for ${process.platform}-${process.arch} — nothing bundled`);
  process.exit(checkOnly ? 1 : 0);
}
const outDir = path.join(root, 'build', 'agent-browser');
const out = path.join(outDir, 'agent-browser');
if (fs.existsSync(out) && sha256(out) === asset.sha256) {
  console.log(`agent-browser ${pins.version} (${asset.key}) OK in build/ — sha256 ${asset.sha256.slice(0, 12)}…`);
  process.exit(0);
}
if (checkOnly) {
  console.error(`fetch-agent-browser: build/agent-browser/agent-browser missing or does not match the pin`);
  process.exit(1);
}
const cacheDir = path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'orchestra-build', 'agent-browser', pins.version);
const cached = path.join(cacheDir, asset.name);
if (!(fs.existsSync(cached) && sha256(cached) === asset.sha256)) {
  fs.mkdirSync(cacheDir, { recursive: true });
  const url = `https://github.com/${pins.repo}/releases/download/v${pins.version}/${asset.name}`;
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' });
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status}`);
  const tmp = `${cached}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, Buffer.from(await res.arrayBuffer()));
  if (sha256(tmp) !== asset.sha256) {
    fs.rmSync(tmp, { force: true });
    throw new Error(`SHA-256 mismatch for ${asset.name} (expected ${asset.sha256}) — refusing to bundle it`);
  }
  fs.renameSync(tmp, cached);
}
fs.mkdirSync(outDir, { recursive: true });
fs.copyFileSync(cached, out);
fs.chmodSync(out, 0o755);
console.log(`agent-browser ${pins.version} (${asset.key}) → build/agent-browser/agent-browser, sha256 verified`);
