// Fetch the PINNED agent-browser release asset for a build target (#395, ADR 0009) into build/agent-browser/agent-browser,
// SHA-256 checked against scripts/agent-browser-pins.json. PLAIN CommonJS on purpose: it runs IN-PROCESS inside electron-builder's
// beforePack hook, i.e. under whatever Node the packager runs on (release.yml pins Node 20: no TypeScript, no --experimental-strip-types).
// CLI: node scripts/agent-browser-fetch.cjs [--check] [--arch x64|arm64] [--platform linux]   (--check: verify only, download nothing)
// A hash mismatch is fatal and never retried; a cache under $XDG_CACHE_HOME/orchestra-build keeps rebuilds offline.

'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const ROOT = path.resolve(__dirname, '..');
const sha256 = (file) => crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');

/** `<platform>-<arch>` key into the pins, or null for a target we do not pin. Mirrors src/shared/agent-browser-binary.ts assetKey (a test pins the parity). */
function assetKey(platform, arch) {
  const a = arch === 'x64' || arch === 'arm64' ? arch : null;
  if (!a) return null;
  return platform === 'linux' ? `linux-${a}` : null;
}

function readPins(root = ROOT) {
  return JSON.parse(fs.readFileSync(path.join(root, 'scripts', 'agent-browser-pins.json'), 'utf8'));
}

/**
 * Make build/agent-browser/agent-browser the pinned binary for {platform, arch}. Returns
 * { status: 'unpinned' | 'present' | 'fetched', key, version, sha256 }. Throws on a mismatch or a failed download.
 * `deps` is injectable for the tests (download, cacheDir, root).
 */
async function ensureAgentBrowser({ platform, arch, checkOnly = false, root = ROOT, cacheDir, download } = {}) {
  const pins = readPins(root);
  const key = assetKey(platform, arch);
  const asset = key ? pins.assets[key] : undefined;
  if (!asset) return { status: 'unpinned', key: null, version: pins.version };
  const outDir = path.join(root, 'build', 'agent-browser');
  const out = path.join(outDir, 'agent-browser');
  if (fs.existsSync(out) && sha256(out) === asset.sha256) return { status: 'present', key, version: pins.version, sha256: asset.sha256 };
  if (checkOnly) throw new Error(`build/agent-browser/agent-browser is missing or does not match the ${key} pin`);
  const cache = cacheDir ?? path.join(process.env.XDG_CACHE_HOME || path.join(os.homedir(), '.cache'), 'orchestra-build', 'agent-browser', pins.version);
  const cached = path.join(cache, asset.name);
  if (!(fs.existsSync(cached) && sha256(cached) === asset.sha256)) {
    fs.mkdirSync(cache, { recursive: true });
    const url = `https://github.com/${pins.repo}/releases/download/v${pins.version}/${asset.name}`;
    const bytes = await (download ?? defaultDownload)(url);
    const tmp = `${cached}.${process.pid}.tmp`;
    fs.writeFileSync(tmp, bytes);
    if (sha256(tmp) !== asset.sha256) {
      fs.rmSync(tmp, { force: true });
      throw new Error(`SHA-256 mismatch for ${asset.name} (expected ${asset.sha256}) — refusing to bundle it`);
    }
    fs.renameSync(tmp, cached);
  }
  fs.mkdirSync(outDir, { recursive: true });
  fs.copyFileSync(cached, out);
  fs.chmodSync(out, 0o755);
  return { status: 'fetched', key, version: pins.version, sha256: asset.sha256 };
}

async function defaultDownload(url) {
  console.log(`downloading ${url}`);
  const res = await fetch(url, { redirect: 'follow' }); // global fetch: Node >= 18
  if (!res.ok) throw new Error(`download failed: HTTP ${res.status} for ${url}`);
  return Buffer.from(await res.arrayBuffer());
}

function describe(r) {
  return r.status === 'unpinned' ? `no pinned agent-browser for this target — nothing bundled` : `agent-browser ${r.version} (${r.key}) ${r.status === 'present' ? 'OK in build/' : '→ build/agent-browser/agent-browser, sha256 verified'} — ${r.sha256.slice(0, 12)}…`;
}

module.exports = { assetKey, readPins, ensureAgentBrowser, describe };

if (require.main === module) {
  const argOf = (n) => { const i = process.argv.indexOf(n); return i >= 0 ? process.argv[i + 1] : undefined; };
  const checkOnly = process.argv.includes('--check');
  ensureAgentBrowser({ platform: argOf('--platform') ?? process.platform, arch: argOf('--arch') ?? process.arch, checkOnly }).then(
    (r) => {
      console.log(describe(r));
      process.exit(r.status === 'unpinned' && checkOnly ? 1 : 0);
    },
    (e) => {
      console.error(`agent-browser-fetch: ${e.message}`);
      process.exit(1);
    },
  );
}
