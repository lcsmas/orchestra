import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resetCommands } from './cdp-reset.ts';

test('every override a `set …` / `network route` can leave has its undo command, and the UA is set back to the panel\'s own', () => {
  const cmds = resetCommands('UA/normal');
  const by = new Map(cmds.map(([m, p]) => [m, p]));
  for (const m of ['Emulation.clearDeviceMetricsOverride', 'Emulation.setEmulatedMedia', 'Emulation.clearGeolocationOverride', 'Network.emulateNetworkConditions', 'Network.setExtraHTTPHeaders', 'Fetch.disable']) {
    assert.ok(by.has(m), m);
  }
  assert.deepEqual(by.get('Emulation.setUserAgentOverride'), { userAgent: 'UA/normal' });
  assert.deepEqual(by.get('Network.emulateNetworkConditions'), { offline: false, latency: 0, downloadThroughput: -1, uploadThroughput: -1 });
  assert.equal(new Set(cmds.map(([m]) => m)).size, cmds.length, 'no command twice');
});
