// Acceptance 4: everything a lane forks dies with the run — double fork and setsid included. A pgid-only kill cannot reach the escaped
// process (own session); the RESCTL_RUN_TOKEN marker sweep does. `env -i` children (no marker) are reached by the group.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { within, Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';
import { readStat } from '../src/proc.ts';

describe('descendants of a lane', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '1s' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('a double-forked, setsid-ed descendant is killed by `run end`', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd1', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('d1', 'escape'); // the lane command itself exits at once
    const pid = await lane.pid();
    await within('lane wrapper exits', lane.exited); // the exec wrapper has returned: only the escaped grandchild is left
    const id = identityOf(pid)!;
    assert.ok(isAlive(id), 'instrument check: the escaped process outlives its lane command');
    const st = readStat(pid)!;
    assert.equal(st.pgrp, pid, 'it is in its own group (so a pgid kill of the lane cannot reach it)');
    assert.notEqual(st.pgrp, rig.run('d1')!.lanes[0]?.pgid ?? -1);

    assert.equal(rig.cli(['run', 'end', '--id', 'd1']).status, 0);
    assert.ok(!isAlive(id), 'the escaped descendant must die with the run');
  });

  it('the same descendant is killed by the reaper when the coordinator dies', async () => {
    rig.startDaemon();
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd2', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('d2', 'escape-stay');
    const id = identityOf(await lane.pid())!;
    await coord.kill();
    await waitFor('the escaped descendant to be reaped', () => !isAlive(id), 15_000);
    await waitFor('run d2 cleaned', () => rig.run('d2')?.state === 'cleaned');
  });

  it('a child that dropped the run marker (env -i) but stayed in the lane group is killed through the group', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd3', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('d3', 'env-i');
    const id = identityOf(await lane.pid())!;
    assert.equal(readStat(id.pid)!.pgrp, rig.run('d3')!.lanes[0].pgid, 'instrument check: same group as the lane');
    assert.equal(rig.cli(['run', 'end', '--id', 'd3']).status, 0);
    assert.ok(!isAlive(id));
  });

  it('a marker-less child that outlives its lane leader is still killed through the recorded group', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd6', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('d6', 'env-i-leave');
    const id = identityOf(await lane.pid())!;
    await within('lane wrapper exits', lane.exited); // the leader is gone, the child remains in its group
    assert.ok(isAlive(id), 'instrument check: the child outlived the leader');
    assert.equal(rig.run('d6')!.lanes.length, 1, 'a group that still has members stays recorded');
    assert.equal(rig.cli(['run', 'end', '--id', 'd6']).status, 0);
    assert.ok(!isAlive(id));
  });

  it('a lane that ignores SIGTERM is SIGKILLed after RESCTL_TERM_WAIT', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd4', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('d4', 'ignore-term');
    const id = identityOf(await lane.pid())!;
    const t0 = Date.now();
    assert.equal(rig.cli(['run', 'end', '--id', 'd4']).status, 0);
    assert.ok(!isAlive(id));
    assert.ok(Date.now() - t0 >= 400, 'SIGKILL only after the TERM wait (400ms here)');
    assert.equal((await within('lane wrapper exits', lane.exited)).code, 128 + 9);
  });

  it('exec forwards the lane exit code and reports a missing command as 127', () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'd5', '--owner', String(coord.pid)]).status, 0);
    assert.equal(rig.cli(['exec', '--run', 'd5', '--', 'sh', '-c', 'exit 7']).status, 7);
    assert.equal(rig.cli(['exec', '--run', 'd5', '--', 'sh', '-c', 'exit 0']).status, 0);
    assert.equal(rig.cli(['exec', '--run', 'd5', '--', 'resctl-no-such-command']).status, 127);
    assert.deepEqual(rig.run('d5')!.lanes, [], 'finished lanes leave the state');
  });
});
