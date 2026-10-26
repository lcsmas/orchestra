import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createRequire } from 'node:module';
import { assetKey as tsAssetKey } from './agent-browser-binary.ts';

const require = createRequire(import.meta.url);
const fetcher = require('../../scripts/agent-browser-fetch.cjs') as {
  assetKey(p: string, a: string): string | null;
  ensureAgentBrowser(o: Record<string, unknown>): Promise<{ status: string; key: string | null; version: string; sha256?: string }>;
};
const read = (rel: string): string => fs.readFileSync(new URL(`../../${rel}`, import.meta.url), 'utf8');

function scratchRoot(bytes: Buffer, key = 'linux-arm64') {
  const root = fs.mkdtempSync(path.join(process.env.TMPDIR ?? os.tmpdir(), 'abf-'));
  fs.mkdirSync(path.join(root, 'scripts'));
  const sha = crypto.createHash('sha256').update(bytes).digest('hex');
  fs.writeFileSync(path.join(root, 'scripts', 'agent-browser-pins.json'), JSON.stringify({ version: '9.9.9', repo: 'o/r', assets: { [key]: { name: `ab-${key}`, sha256: sha } } }));
  return { root, sha, cache: path.join(root, 'cache') };
}

test('the plain-CJS asset key and the TS one agree on every platform/arch (the cjs cannot import the .ts)', () => {
  for (const p of ['linux', 'darwin', 'win32', 'freebsd']) {
    for (const a of ['x64', 'arm64', 'ia32', 'armv7l', 'universal']) assert.equal(fetcher.assetKey(p, a), tsAssetKey(p, a), `${p}-${a}`);
  }
});

test('fetch: downloads once, verifies the SHA-256, installs an executable; the second call finds it present and downloads nothing', async () => {
  const bytes = Buffer.from('fake agent-browser binary');
  const { root, sha, cache } = scratchRoot(bytes);
  let downloads = 0;
  const download = async () => { downloads++; return bytes; };
  const r1 = await fetcher.ensureAgentBrowser({ platform: 'linux', arch: 'arm64', root, cacheDir: cache, download });
  assert.deepEqual([r1.status, r1.key, r1.sha256], ['fetched', 'linux-arm64', sha]);
  const out = path.join(root, 'build', 'agent-browser', 'agent-browser');
  assert.equal(fs.readFileSync(out, 'utf8'), 'fake agent-browser binary');
  assert.equal(fs.statSync(out).mode & 0o111, 0o111);
  const r2 = await fetcher.ensureAgentBrowser({ platform: 'linux', arch: 'arm64', root, cacheDir: cache, download });
  assert.equal(r2.status, 'present');
  assert.equal(downloads, 1);
  fs.rmSync(out);
  const r3 = await fetcher.ensureAgentBrowser({ platform: 'linux', arch: 'arm64', root, cacheDir: cache, download });
  assert.equal(r3.status, 'fetched');
  assert.equal(downloads, 1, 'rebuilt from the verified cache, offline');
  fs.rmSync(root, { recursive: true, force: true });
});

test('fetch: a hash mismatch is fatal, installs nothing and leaves no cache entry; --check never downloads; an unpinned target is a no-op', async () => {
  const { root, cache } = scratchRoot(Buffer.from('the pinned bytes'));
  await assert.rejects(
    fetcher.ensureAgentBrowser({ platform: 'linux', arch: 'arm64', root, cacheDir: cache, download: async () => Buffer.from('TAMPERED') }),
    /SHA-256 mismatch/,
  );
  assert.equal(fs.existsSync(path.join(root, 'build', 'agent-browser', 'agent-browser')), false);
  assert.deepEqual(fs.existsSync(cache) ? fs.readdirSync(cache) : [], [], 'the tampered download is not cached');
  let called = false;
  await assert.rejects(fetcher.ensureAgentBrowser({ platform: 'linux', arch: 'arm64', root, cacheDir: cache, checkOnly: true, download: async () => { called = true; return Buffer.alloc(0); } }), /missing or does not match/);
  assert.equal(called, false);
  assert.equal((await fetcher.ensureAgentBrowser({ platform: 'darwin', arch: 'arm64', root, cacheDir: cache })).status, 'unpinned');
  fs.rmSync(root, { recursive: true, force: true });
});

test('the beforePack chain needs nothing newer than Node 18: no TypeScript flag, no child Node, no .ts import (release.yml packs on Node 20; reviewer B1)', () => {
  for (const f of ['scripts/before-pack.cjs', 'scripts/agent-browser-fetch.cjs']) {
    const src = read(f).replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, ''); // code only: the header comments name the very flag they forbid
    assert.doesNotMatch(src, /experimental-strip-types|execFileSync|execFile\(|spawn\(|process\.execPath|require\([^)]*\.ts['"]\)|\bimport\s+[\w{*]/, f);
  }
  assert.match(read('scripts/before-pack.cjs'), /require\('\.\/agent-browser-fetch\.cjs'\)/);
  const pkg = JSON.parse(read('package.json')) as { build: { beforePack: string }; scripts: Record<string, string> };
  assert.equal(pkg.build.beforePack, 'scripts/before-pack.cjs');
  assert.equal(pkg.scripts['fetch:agent-browser'], 'node scripts/agent-browser-fetch.cjs');
});
