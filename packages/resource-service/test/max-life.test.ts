// A6 acceptance 2: `run start --max-life <dur>` sets maxLifeAt; the reaper cleans the run once past it WHILE ITS OWNER IS STILL ALIVE (no grace is involved).
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';
import { sleep } from '../src/proc.ts';
import { withState } from '../src/state.ts';

describe('--max-life', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '30s' }); // a long grace: a cleanup inside this test can only come from the max life
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('a run past its max life is cleaned while its owner lives — never through the grace', async () => {
    rig.startDaemon();
    const owner = rig.coordinator();
    const t0 = Date.now();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml1', '--owner', String(owner.pid), '--max-life', '2s']).status, 0);
    const t1 = Date.now();
    const rec = rig.run('ml1')!;
    assert.ok(rec.maxLifeAt! >= t0 + 2000 && rec.maxLifeAt! <= t1 + 2000, `maxLifeAt ${rec.maxLifeAt} is not start + 2s`);
    const lane = rig.lane('ml1', 'sleep');
    const laneId = identityOf(await lane.pid())!;

    const seen = new Set<string>();
    const done = await waitFor('the run to be cleaned', () => {
      seen.add(rig.run('ml1')!.state);
      return rig.run('ml1')!.state === 'cleaned';
    }, 15_000, 20);
    assert.ok(done);
    assert.ok(Date.now() >= rec.maxLifeAt!, 'cleaned before its max life');
    assert.ok(!isAlive(laneId), 'the lane is gone');
    assert.ok(isAlive(identityOf(owner.pid)!), 'the owner is STILL alive: this was the max life, not the owner dying');
    assert.ok(!seen.has('grace'), `the run went through a grace (${[...seen]})`);
  });

  it('control: the same run WITHOUT --max-life is untouched past the same delay', async () => {
    const owner = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml2', '--owner', String(owner.pid)]).status, 0);
    assert.equal(rig.run('ml2')!.maxLifeAt, undefined);
    const laneId = identityOf(await rig.lane('ml2', 'sleep').pid())!;
    await sleep(3000);
    assert.equal(rig.run('ml2')!.state, 'alive');
    assert.ok(isAlive(laneId), 'no max life ⇒ the lane lives as long as its owner');
  });

  it('a long max life leaves the run alone before it', async () => {
    const owner = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml3', '--owner', String(owner.pid), '--max-life', '1h']).status, 0);
    const laneId = identityOf(await rig.lane('ml3', 'sleep').pid())!;
    await sleep(1500);
    assert.equal(rig.run('ml3')!.state, 'alive');
    assert.ok(isAlive(laneId));
    assert.ok(rig.run('ml3')!.maxLifeAt! > Date.now() + 3_000_000);
  });

  it('a repeated start with the flag moves the deadline; without it, the deadline stays', () => {
    const owner = rig.coordinator();
    const o = String(owner.pid);
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o, '--max-life', '1h']).status, 0);
    const first = rig.run('ml4')!.maxLifeAt!;
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o]).status, 0);
    assert.equal(rig.run('ml4')!.maxLifeAt, first, 'no flag: untouched');
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o, '--max-life', '2h']).status, 0);
    const moved = rig.run('ml4')!.maxLifeAt!;
    assert.ok(moved > first + 3_000_000, 'the flag moves it (same owner, run already alive)');
  });

  it('a re-adopted run (inside its grace) takes the new max life too', async () => {
    const o1 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml5', '--owner', String(o1.pid), '--max-life', '1h']).status, 0);
    const old = rig.run('ml5')!.maxLifeAt!;
    await o1.kill();
    await withState((s) => {
      s.runs.ml5.state = 'grace';
      s.runs.ml5.graceEndsAt = Date.now() + 600_000;
    }, rig.dir);
    const o2 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml5', '--owner', String(o2.pid), '--max-life', '2h']).status, 0);
    const r = rig.run('ml5')!;
    assert.equal(r.state, 'alive');
    assert.ok(r.maxLifeAt! > old + 3_000_000);
  });

  it('a bad --max-life is a usage error (exit 2) and records nothing', () => {
    const owner = rig.coordinator();
    for (const bad of ['0', '0s', 'abc', '-5s', '5x', '']) {
      const r = rig.cli(['run', 'start', '--id', 'mlbad', '--owner', String(owner.pid), '--max-life', bad]);
      assert.equal(r.status, 2, `--max-life ${JSON.stringify(bad)} → ${r.status} (${r.stderr})`);
      assert.match(r.stderr, /--max-life/);
    }
    assert.equal(rig.run('mlbad'), undefined);
  });

  it('after a max-life cleanup the id starts fresh: no stale deadline carried over', async () => {
    const owner = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml6', '--owner', String(owner.pid), '--max-life', '1s']).status, 0);
    await waitFor('ml6 cleaned', () => rig.run('ml6')?.state === 'cleaned', 15_000);
    assert.equal(rig.cli(['run', 'start', '--id', 'ml6', '--owner', String(owner.pid)]).status, 0);
    const fresh = rig.run('ml6')!;
    assert.equal(fresh.state, 'alive');
    assert.equal(fresh.maxLifeAt, undefined);
    await sleep(1500);
    assert.equal(rig.run('ml6')!.state, 'alive', 'the old deadline did not come back');
  });
});
