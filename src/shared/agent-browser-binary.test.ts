import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import { AGENT_BROWSER_VERSION, assetFor, assetKey, binaryCandidates, type AgentBrowserPins } from './agent-browser-binary.ts';

const pins = JSON.parse(fs.readFileSync(new URL('../../scripts/agent-browser-pins.json', import.meta.url), 'utf8')) as AgentBrowserPins;

test('linux arm64 and x64 resolve to pinned assets with a 64-hex SHA-256; other platforms/arches do not', () => {
  for (const arch of ['arm64', 'x64']) {
    const a = assetFor(pins, 'linux', arch)!;
    assert.equal(a.key, `linux-${arch}`);
    assert.equal(a.name, `agent-browser-linux-${arch}`);
    assert.match(a.sha256, /^[0-9a-f]{64}$/);
  }
  assert.equal(assetKey('darwin', 'arm64'), null);
  assert.equal(assetKey('win32', 'x64'), null);
  assert.equal(assetKey('linux', 'ia32'), null);
  assert.equal(assetFor(pins, 'darwin', 'arm64'), null);
});

test('the pinned version is the one the ledger fixed', () => {
  assert.equal(pins.version, '0.39.2');
  assert.equal(AGENT_BROWSER_VERSION, pins.version, 'the constant the host installs under = the pinned release');
  assert.equal(pins.repo, 'vercel-labs/agent-browser');
});

test('binary candidates: override first, then packaged resources, then the build dir', () => {
  assert.deepEqual(binaryCandidates({ override: '/o', resourcesPath: '/r', appPath: '/a' }), ['/o', '/r/agent-browser/agent-browser', '/a/build/agent-browser/agent-browser']);
  assert.deepEqual(binaryCandidates({ appPath: '/a' }), ['/a/build/agent-browser/agent-browser']);
  assert.deepEqual(binaryCandidates({}), []);
});
