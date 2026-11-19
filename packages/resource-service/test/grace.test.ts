// Acceptance 1 + 2 at the CLI seam: a fake coordinator declares a run, `exec` starts a long lane, the coordinator dies.
// Real daemon, real processes, short grace; every time is read from the state file's own graceEndsAt.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { within, Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';
import { readStat, sleep } from '../src/proc.ts';
import { withState } from '../src/state.ts';

describe('grace period', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '3s' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('the lane is alive before the grace ends and gone after it', async () => {
    rig.startDaemon();
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g1', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('g1', 'sleep');
    const pid = await lane.pid();
    const id = identityOf(pid)!;
    assert.ok(isAlive(id));
    const rec = rig.run('g1')!.lanes[0];
    assert.equal(rec.pid, pid);
    assert.equal(rec.pgid, pid, 'the lane is its own process group leader');
    assert.equal(readStat(pid)!.pgrp, pid);

    await coord.kill(); // the coordinator dies
    const ends = await waitFor('run g1 enters its grace', () => rig.run('g1')?.state === 'grace' && rig.run('g1')!.graceEndsAt);
    assert.ok(Date.now() < ends - 1000, 'test is too slow to observe the grace');
    assert.ok(isAlive(id), 'the lane must be alive right after the coordinator died');
    await sleep(Math.max(0, ends - 1000 - Date.now()));
    assert.ok(isAlive(id), 'the lane must still be alive until the grace ends');

    await waitFor('the lane to be killed', () => !isAlive(id), 15_000);
    assert.ok(Date.now() >= ends, 'the lane was killed before the grace ended');
    await waitFor('run g1 marked cleaned', () => rig.run('g1')?.state === 'cleaned');
    const exit = await within('lane wrapper exits', lane.exited);
    assert.equal(exit.code, 128 + 15, 'the exec wrapper reports the lane killed by SIGTERM');
  });

  it('a run start with the same id inside the grace keeps the lane alive past the original deadline', async () => {
    rig.startDaemon(); // a second serve: exits 3, the first still reaps
    const c1 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g2', '--owner', String(c1.pid)]).status, 0);
    const lane = rig.lane('g2', 'sleep');
    const id = identityOf(await lane.pid())!;
    const token = rig.run('g2')!.token;

    await c1.kill();
    const ends = await waitFor('run g2 enters its grace', () => rig.run('g2')?.state === 'grace' && rig.run('g2')!.graceEndsAt);
    assert.ok(Date.now() < ends - 1000, 'test is too slow to observe the grace');

    const c2 = rig.coordinator(); // the resume
    const r = rig.cli(['run', 'start', '--id', 'g2', '--owner', String(c2.pid)]);
    assert.equal(r.status, 0, r.stderr);
    const adopted = rig.run('g2')!;
    assert.equal(adopted.state, 'alive');
    assert.equal(adopted.graceEndsAt, undefined, 'the grace is cleared');
    assert.equal(adopted.owner.pid, c2.pid);
    assert.equal(adopted.token, token, 'same run instance');
    assert.equal(adopted.lanes.length, 1, 'lanes are kept');

    await sleep(Math.max(0, ends + 1500 - Date.now())); // well past the ORIGINAL deadline
    assert.ok(isAlive(id), 'the re-adopted run was cleaned at the old deadline');
    assert.equal(rig.run('g2')!.state, 'alive');

    await c2.kill(); // the re-adopted run is still governed: its new owner dying reaps it
    await waitFor('the lane to be killed after the second owner died', () => !isAlive(id), 15_000);
    await waitFor('run g2 marked cleaned', () => rig.run('g2')?.state === 'cleaned');
  });

  it('a cleaned id starts fresh: new instance, no lanes', async () => {
    const before = rig.run('g2')!;
    const c = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g2', '--owner', String(c.pid)]).status, 0);
    const fresh = rig.run('g2')!;
    assert.equal(fresh.state, 'alive');
    assert.notEqual(fresh.token, before.token);
    assert.deepEqual(fresh.lanes, []);
  });

  it('an alive run refuses a second, different live owner (exit 3)', async () => {
    const a = rig.coordinator();
    const b = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g4', '--owner', String(a.pid)]).status, 0);
    assert.equal(rig.cli(['run', 'start', '--id', 'g4', '--owner', String(a.pid)]).status, 0, 'same owner again is idempotent');
    const r = rig.cli(['run', 'start', '--id', 'g4', '--owner', String(b.pid)]);
    assert.equal(r.status, 3, r.stderr);
    assert.equal(rig.run('g4')!.owner.pid, a.pid);
  });

  it('an EXPIRED grace is not re-adopted: the old instance is cleaned, the id starts fresh', async () => {
    // No daemon involved: the state is crafted as "owner dead, grace over, reaper has not looked yet".
    const dead = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g5', '--owner', String(dead.pid)]).status, 0);
    const lane = rig.lane('g5', 'sleep');
    const id = identityOf(await lane.pid())!;
    const old = rig.run('g5')!;
    await dead.kill();
    await withState((s) => {
      s.runs.g5.state = 'grace';
      s.runs.g5.graceEndsAt = Date.now() - 1;
    }, rig.dir);
    const c = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'g5', '--owner', String(c.pid)]).status, 0);
    assert.ok(!isAlive(id), 'the old instance\'s lane must be dead');
    const fresh = rig.run('g5')!;
    assert.equal(fresh.state, 'alive');
    assert.notEqual(fresh.token, old.token);
    assert.deepEqual(fresh.lanes, []);
  });
});
