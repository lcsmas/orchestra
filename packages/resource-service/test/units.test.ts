import assert from 'node:assert/strict';
import { describe, it } from 'node:test';
import { graceMs, keepMs, minFreeDisk, minFreeMem, stateDir, tickMs } from '../src/env.ts';
import { parseDuration, parseSize } from '../src/units.ts';

describe('units', () => {
  it('parseDuration', () => {
    assert.equal(parseDuration('15m'), 900_000);
    assert.equal(parseDuration('2s'), 2000);
    assert.equal(parseDuration('500ms'), 500);
    assert.equal(parseDuration('1h30m'), 5_400_000);
    assert.equal(parseDuration('24h'), 86_400_000);
    assert.equal(parseDuration('90'), 90_000);
    for (const bad of ['', 'm', '5x', '1.5.5s', 'abc', '5 m']) assert.throws(() => parseDuration(bad), /invalid duration/, bad);
  });

  it('parseSize (K/M/G = powers of 1024 like systemd, KB/MB/GB = powers of 1000)', () => {
    assert.equal(parseSize('6G'), 6 * 1024 ** 3);
    assert.equal(parseSize('10GiB'), 10 * 1024 ** 3);
    assert.equal(parseSize('512M'), 512 * 1024 ** 2);
    assert.equal(parseSize('100MB'), 100_000_000);
    assert.equal(parseSize('1.5G'), 1.5 * 1024 ** 3);
    assert.equal(parseSize('4096'), 4096);
    for (const bad of ['', 'G', '6X', '-1G']) assert.throws(() => parseSize(bad), /invalid size/, bad);
  });

  it('env readers: defaults and overrides', () => {
    assert.equal(graceMs({}), 15 * 60_000);
    assert.equal(graceMs({ RESCTL_GRACE: '2s' }), 2000);
    assert.equal(tickMs({}), 1000);
    assert.equal(keepMs({}), 24 * 3_600_000);
    assert.equal(minFreeMem({}), 6 * 1024 ** 3);
    assert.equal(minFreeDisk({}), 10 * 1024 ** 3);
    assert.equal(stateDir({ RESCTL_STATE_DIR: '/x/y' }), '/x/y');
    assert.equal(stateDir({ XDG_STATE_HOME: '/xdg' }), '/xdg/resctl');
  });
});
