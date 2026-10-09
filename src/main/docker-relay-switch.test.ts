// #291 — the app-side switch decision against a REAL scratch bus: only a run that FROZE `docker_relay` ON, for a
// local (non-sandbox) member, yields a relay spec; default OFF, unknown run, bus down and sandbox all yield none.

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'drs-'));
process.env.ORCHESTRA_HOME = home;
const { initBus, getBus, closeBus } = await import('./bus.ts');
const { startRun } = await import('./bus-runs.ts');
const { dockerRelaySpecFor } = await import('./docker-relay-switch.ts');
const { DEFAULT_BUS_SWITCHES } = await import('../shared/bus-switches.ts');

test('bus down (not opened yet) → no relay', () => {
  assert.equal(getBus(), null);
  assert.equal(dockerRelaySpecFor('run-on', false), undefined);
});

test('the default is OFF', () => {
  assert.equal(DEFAULT_BUS_SWITCHES.dockerRelay, false);
});

test('frozen ON → spec; frozen OFF / unknown run / sandbox / no run id → none', () => {
  initBus();
  const db = getBus()!;
  startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, dockerRelay: true });
  startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES });
  assert.deepEqual(dockerRelaySpecFor('run-on', false), { runId: 'run-on', holdState: path.join(home, 'admission.state') }, '#321: the spec also names the file the app publishes the Admission hold in');
  assert.equal(dockerRelaySpecFor('run-off', false), undefined);
  assert.equal(dockerRelaySpecFor('run-nope', false), undefined);
  assert.equal(dockerRelaySpecFor('run-on', true), undefined, 'a sandbox-hosted member never gets the relay');
  assert.equal(dockerRelaySpecFor(undefined, false), undefined);
  assert.equal(dockerRelaySpecFor('', false), undefined);
});

test('the freeze: a later live flip never changes a started run (ON stays ON, OFF stays OFF)', () => {
  const db = getBus()!;
  startRun(db, { id: 'run-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, dockerRelay: false }); // re-start: ignored
  startRun(db, { id: 'run-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, dockerRelay: true });
  assert.deepEqual(dockerRelaySpecFor('run-on', false), { runId: 'run-on', holdState: path.join(home, 'admission.state') }, '#321: the spec also names the file the app publishes the Admission hold in');
  assert.equal(dockerRelaySpecFor('run-off', false), undefined);
  closeBus();
  fs.rmSync(home, { recursive: true, force: true });
});
