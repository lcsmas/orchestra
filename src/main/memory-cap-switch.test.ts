// #320 — the app-side decision against a REAL scratch bus: only a fleet member whose run FROZE `memory_cap` ON, on a host that can scope it, gets a scope; the levels are read NOW (not frozen).

import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';

const home = fs.mkdtempSync(path.join(os.tmpdir(), 'mcs-'));
process.env.ORCHESTRA_HOME = home;
const { initBus, getBus, closeBus } = await import('./bus.ts');
const { startRun } = await import('./bus-runs.ts');
const { memoryCapDecisionFor, memoryCapSpecFor, realMemoryCapDeps } = await import('./memory-cap-switch.ts');
const { DEFAULT_BUS_SWITCHES } = await import('../shared/bus-switches.ts');
const { parseMemoryScopeUnit } = await import('../shared/memory-scope.ts');

const GIB = 1024 ** 3;
const levels = { capSoftGb: 3, capHardGb: 6 };
let supported = true;
let busOn = new Set<string>();
const deps = (platform = 'linux') => ({
  switchOn: (runId: string) => busOn.has(runId),
  support: () => (supported ? ({ ok: true } as const) : ({ ok: false, reason: 'no systemd-run' } as const)),
  platform,
  prefix: () => 'orchestra-ws-',
  now: () => 1791465663940,
});
const args = (over: Record<string, unknown> = {}) => ({ wsId: 'ws-1', runId: 'run-on', ws: { parentId: 'ops-1' } as { parentId?: string } | null, remote: false, settings: levels, ...over });

test('the default is OFF', () => assert.equal(DEFAULT_BUS_SWITCHES.memoryCap, false));

test('frozen ON + fleet member + supported host → a scope with hard = MemoryMax, swap 0; the unit parses back to the workspace', () => {
  busOn = new Set(['run-on']);
  const spec = memoryCapSpecFor(args(), deps());
  assert.ok(spec);
  assert.deepEqual(spec.limits, { hardBytes: 6 * GIB, softBytes: 3 * GIB, swapMaxBytes: 0 });
  assert.deepEqual(parseMemoryScopeUnit('orchestra-ws-', spec.unit), { wsId: 'ws-1', gen: (1791465663940).toString(36) });
});

test('control arms: switch OFF · human (no parent) · sandbox · unknown run · no run id · unsupported host · non-Linux → NO scope', () => {
  busOn = new Set(['run-on']);
  assert.equal(memoryCapSpecFor(args({ runId: 'run-off' }), deps()), undefined, 'switch OFF');
  assert.equal(memoryCapSpecFor(args({ ws: {} }), deps()), undefined, 'a human session is never capped, even with the switch ON');
  assert.equal(memoryCapSpecFor(args({ remote: true }), deps()), undefined, 'sandbox-hosted');
  assert.equal(memoryCapSpecFor(args({ runId: 'run-nope' }), deps()), undefined, 'unknown run');
  assert.equal(memoryCapSpecFor(args({ runId: undefined }), deps()), undefined);
  assert.equal(memoryCapSpecFor(args({ runId: '  ' }), deps()), undefined);
  assert.equal(memoryCapSpecFor(args(), deps('darwin')), undefined);
  supported = false;
  assert.equal(memoryCapSpecFor(args(), deps()), undefined, 'ON but the host cannot scope it ⇒ the member runs uncapped (and the app log says so)');
  assert.equal(memoryCapDecisionFor(args(), deps()).reason, 'unsupported');
  supported = true;
});

test('the decision carries its reason: the human / switch-off / ok cases are distinguishable', () => {
  busOn = new Set(['run-on']);
  assert.equal(memoryCapDecisionFor(args(), deps()).reason, 'ok');
  assert.equal(memoryCapDecisionFor(args({ runId: 'run-off' }), deps()).reason, 'switch-off');
  assert.equal(memoryCapDecisionFor(args({ ws: {} }), deps()).reason, 'human');
});

test('the levels are read at EACH start (not frozen): a Garde mémoire change shows at the next session start', () => {
  busOn = new Set(['run-on']);
  assert.equal(memoryCapSpecFor(args({ settings: { capSoftGb: 1, capHardGb: 2 } }), deps())?.limits?.hardBytes, 2 * GIB);
  assert.equal(memoryCapSpecFor(args({ settings: { capSoftGb: 3, capHardGb: 8 } }), deps())?.limits?.hardBytes, 8 * GIB);
});

test('a throwing switch read is "no cap", never a failed session start', () => {
  const boom = { ...deps(), switchOn: () => { throw new Error('bus exploded'); } };
  assert.equal(memoryCapSpecFor(args(), boom), undefined);
});

test('against the REAL bus: only the run that froze memory_cap ON reads ON; the freeze outlives a later live flip', async () => {
  initBus();
  const db = getBus()!;
  startRun(db, { id: 'bus-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true });
  startRun(db, { id: 'bus-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES });
  const real = { ...realMemoryCapDeps, support: () => ({ ok: true } as const), platform: 'linux' }; // the PRODUCTION switch read (the real bus), only the host probe is stubbed
  assert.ok(memoryCapSpecFor(args({ runId: 'bus-on' }), real));
  assert.equal(memoryCapSpecFor(args({ runId: 'bus-off' }), real), undefined);
  startRun(db, { id: 'bus-on', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: false }); // re-start: ignored
  startRun(db, { id: 'bus-off', kind: 'vague', coordinator: 'c' }, { ...DEFAULT_BUS_SWITCHES, memoryCap: true }); // re-start: ignored
  assert.ok(memoryCapSpecFor(args({ runId: 'bus-on' }), real), 'ON stays ON');
  assert.equal(memoryCapSpecFor(args({ runId: 'bus-off' }), real), undefined, 'OFF stays OFF');
  closeBus();
  fs.rmSync(home, { recursive: true, force: true });
});
