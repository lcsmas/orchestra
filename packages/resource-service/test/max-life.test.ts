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
    // The deadline must not start ticking before the lane is running: `resctl exec` + the lane boot in ~0.2 s idle but > 2 s under heavy load, and a run
    // cleaned meanwhile kills the lane before it writes its pidfile (the old flake). So: declare with a long life, wait for the lane (progress), THEN shorten
    // (a repeat start only moves a deadline earlier). The lane boots 2.5 s late on purpose — longer than the 2 s life below — so this holds at any load.
    const t00 = Date.now();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml1', '--owner', String(owner.pid), '--max-life', '1h']).status, 0);
    const created = rig.run('ml1')!.maxLifeAt!;
    assert.ok(created >= t00 + 3_600_000 && created <= Date.now() + 3_600_000, `maxLifeAt ${created} is not start + 1h`);
    const lane = rig.lane('ml1', 'sleep', '2500');
    const laneId = identityOf(await lane.pid())!;
    await waitFor('the lane is registered in the run', () => rig.run('ml1')!.lanes.length === 1);
    assert.equal(rig.run('ml1')!.state, 'alive');

    const t0 = Date.now();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml1', '--owner', String(owner.pid), '--max-life', '2s']).status, 0);
    const t1 = Date.now();
    const rec = rig.run('ml1')!;
    assert.ok(rec.maxLifeAt! >= t0 + 2000 && rec.maxLifeAt! <= t1 + 2000, `maxLifeAt ${rec.maxLifeAt} is not shortened to start + 2s`);

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

  it('a repeated start NEVER extends the deadline (it is not a heartbeat); a shorter one moves it earlier; a run with none gets one', () => {
    const owner = rig.coordinator();
    const o = String(owner.pid);
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o]).status, 0);
    assert.equal(rig.run('ml4')!.maxLifeAt, undefined);
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o, '--max-life', '1h']).status, 0);
    const first = rig.run('ml4')!.maxLifeAt!;
    assert.ok(first > Date.now() + 3_000_000, 'a run with no deadline gets one');
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o]).status, 0);
    assert.equal(rig.run('ml4')!.maxLifeAt, first, 'no flag: untouched');
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o, '--max-life', '2h']).status, 0);
    assert.equal(rig.run('ml4')!.maxLifeAt, first, 'a LONGER life does not extend it');
    assert.equal(rig.cli(['run', 'start', '--id', 'ml4', '--owner', o, '--max-life', '30m']).status, 0);
    const earlier = rig.run('ml4')!.maxLifeAt!;
    assert.ok(earlier < first - 1_500_000 && earlier > Date.now() + 1_700_000, 'a SHORTER life moves it earlier');
  });

  it('a re-adopted run (inside its grace) keeps its deadline against a longer life and takes a shorter one', async () => {
    const o1 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'ml5', '--owner', String(o1.pid), '--max-life', '1h']).status, 0);
    const old = rig.run('ml5')!.maxLifeAt!;
    await o1.kill();
    await withState((s) => {
      s.runs.ml5.state = 'grace';
      s.runs.ml5.graceEndsAt = Date.now() + 600_000;
    }, rig.dir);
    const o2 = rig.coordinator();
    const r1 = rig.cli(['run', 'start', '--id', 'ml5', '--owner', String(o2.pid), '--max-life', '10m']);
    assert.equal(r1.status, 0, r1.stderr);
    assert.match(r1.stderr, /re-adopted/, 'instrument: this start really took the re-adopt path');
    const r = rig.run('ml5')!;
    assert.equal(r.state, 'alive');
    assert.ok(r.maxLifeAt! < old - 2_000_000 && r.maxLifeAt! > Date.now() + 500_000, 'the re-adopt takes a SHORTER life');
    // and a longer one never extends it, on the same adopted run
    const shorter = r.maxLifeAt!;
    assert.equal(rig.cli(['run', 'start', '--id', 'ml5', '--owner', String(o2.pid), '--max-life', '2h']).status, 0);
    assert.equal(rig.run('ml5')!.maxLifeAt, shorter);
  });

  it('a bad --max-life is a usage error (exit 2) and records nothing', () => {
    const owner = rig.coordinator();
    for (const bad of ['0', '0s', 'abc', '-5s', '5x', '', `${'9'.repeat(400)}ms`]) {
      const r = rig.cli(['run', 'start', '--id', 'mlbad', '--owner', String(owner.pid), '--max-life', bad]);
      assert.equal(r.status, 2, `--max-life ${JSON.stringify(bad)} → ${r.status} (${r.stderr})`);
      assert.match(r.stderr, /--max-life/);
    }
    assert.equal(rig.run('mlbad'), undefined);
  });

  it('the longest life is 100 years: 36500d is accepted, 36600d refused (the deadline must stay a formattable date)', () => {
    const owner = rig.coordinator();
    const o = String(owner.pid);
    assert.equal(rig.cli(['run', 'start', '--id', 'mlbig', '--owner', o, '--max-life', '36500d']).status, 0);
    assert.doesNotThrow(() => new Date(rig.run('mlbig')!.maxLifeAt!).toISOString());
    const r = rig.cli(['run', 'start', '--id', 'mlbig2', '--owner', o, '--max-life', '36600d']);
    assert.equal(r.status, 2, r.stderr);
    assert.match(r.stderr, /100 years/);
    assert.equal(rig.run('mlbig2'), undefined);
    assert.equal(rig.cli(['run', 'start', '--id', 'mlbig3', '--owner', o, '--max-life', '9999999999999d']).status, 2);
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
