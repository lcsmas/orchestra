// A run PAST its max life is being cleaned for good — a `run start` must not revive it (nor re-adopt it into the next reaper tick). No daemon here:
// the state is crafted as "deadline passed, the reaper has not looked yet".
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Rig, identityOf, isAlive } from './lib/rig.ts';
import { withState } from '../src/state.ts';

describe('run start on a run past its max life', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '30s' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  const pastDeadline = (id: string) =>
    withState((s) => {
      s.runs[id].maxLifeAt = Date.now() - 1;
    }, rig.dir);

  it('an alive run: a start with a new --max-life ends the old instance and starts a fresh one (not a revival)', async () => {
    const owner = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'x1', '--owner', String(owner.pid), '--max-life', '1h']).status, 0);
    const laneId = identityOf(await rig.lane('x1', 'sleep').pid())!;
    const old = rig.run('x1')!;
    await pastDeadline('x1');
    const r = rig.cli(['run', 'start', '--id', 'x1', '--owner', String(owner.pid), '--max-life', '1h']);
    assert.equal(r.status, 0, r.stderr);
    const fresh = rig.run('x1')!;
    assert.notEqual(fresh.token, old.token, 'a new instance');
    assert.deepEqual(fresh.lanes, []);
    assert.ok(!isAlive(laneId), 'the old instance\'s lane is gone');
    assert.ok(fresh.maxLifeAt! > Date.now() + 3_000_000, 'the new deadline is the new life, not the old one');
  });

  it('a run in grace: a start WITHOUT the flag is not re-adopted into its own cleanup', async () => {
    const o1 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'x2', '--owner', String(o1.pid), '--max-life', '1h']).status, 0);
    const laneId = identityOf(await rig.lane('x2', 'sleep').pid())!;
    const old = rig.run('x2')!;
    await o1.kill();
    await withState((s) => {
      s.runs.x2.state = 'grace';
      s.runs.x2.graceEndsAt = Date.now() + 600_000;
    }, rig.dir);
    await pastDeadline('x2');
    const o2 = rig.coordinator();
    const r = rig.cli(['run', 'start', '--id', 'x2', '--owner', String(o2.pid)]);
    assert.equal(r.status, 0, r.stderr);
    assert.doesNotMatch(r.stderr, /re-adopted/);
    const fresh = rig.run('x2')!;
    assert.notEqual(fresh.token, old.token);
    assert.equal(fresh.state, 'alive');
    assert.equal(fresh.maxLifeAt, undefined);
    assert.ok(!isAlive(laneId));
  });

  it('control: a deadline still in the future is not an expiry (same instance)', async () => {
    const owner = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'x3', '--owner', String(owner.pid), '--max-life', '1h']).status, 0);
    const token = rig.run('x3')!.token;
    assert.equal(rig.cli(['run', 'start', '--id', 'x3', '--owner', String(owner.pid), '--max-life', '1h']).status, 0);
    assert.equal(rig.run('x3')!.token, token);
  });
});
