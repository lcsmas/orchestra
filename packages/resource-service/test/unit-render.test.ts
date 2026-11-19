// The unit file as text, no systemd needed: quoting round-trips, and the leftover-unit sweep of the real-systemd tests never selects a live sibling's unit.
import assert from 'node:assert/strict';
import path from 'node:path';
import { describe, it } from 'node:test';
import { execWord, parseUnitEnv, renderUnit, unitSpec } from '../src/systemd.ts';
import { staleTestUnits } from './lib/units.ts';

describe('unit file rendering', () => {
  it('execWord quotes what systemd would expand: backslash, quote, $ and %', () => {
    assert.equal(execWord('/a b/node'), '"/a b/node"');
    assert.equal(execWord('p$q%h"x\\y'), '"p$$q%%h\\"x\\\\y"');
  });

  it('Environment lines round-trip through render → parseUnitEnv for a state dir with a space, %, $, a quote and a backslash', () => {
    const weird = '/var/tmp/we ird%h$x"q\\z';
    const spec = unitSpec({ RESCTL_STATE_DIR: weird, RESCTL_GRACE: '2s', RESCTL_UNIT_NAME: 'x.service' });
    const env = parseUnitEnv(renderUnit(spec));
    assert.equal(env.RESCTL_STATE_DIR, weird);
    assert.equal(env.RESCTL_GRACE, '2s');
  });
});

describe('the leftover-unit sweep of the systemd tests', () => {
  const tmp = '/var/tmp/x';
  const unit = (dir: string) => renderUnit(unitSpec({ RESCTL_STATE_DIR: dir, RESCTL_UNIT_NAME: 'x.service' }));
  const live = path.join(tmp, 'resctl-test-AbC123', 'we ird%h$x"q'); // the weird-dir test's dir while it runs
  const files = [
    { name: 'resctl-test-aaaaaaaa.service', text: unit(path.join(tmp, 'resctl-test-gone1')) }, // stale: dir gone
    { name: 'resctl-test-bbbbbbbb.service', text: unit(live) }, // a sibling's LIVE unit with a quote in its dir
    { name: 'resctl-test-cccccccc.service', text: '[Service]\nExecStart=/bin/true\n' }, // not written by resctl
    { name: 'resctl.service', text: unit(path.join(tmp, 'resctl-test-gone2')) }, // the real name: never
    { name: 'resctl-test-dddddddd.service', text: unit('/home/user/.local/state/resctl') }, // not a rig dir
  ];
  it('selects only stale test units; a live sibling unit (quote in its state dir), a foreign file, the real name and a non-rig dir are left alone', () => {
    const stale = staleTestUnits(files, (p) => p === live, tmp);
    assert.deepEqual(stale, ['resctl-test-aaaaaaaa.service']);
  });
});
