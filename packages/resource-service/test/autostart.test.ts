// `run start` starts a detached reaper when none holds daemon.lock (unless RESCTL_NO_AUTOSTART=1): the swarm needs no manual `serve`.
import assert from 'node:assert/strict';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';
import { readHolder } from '../src/lockfile.ts';
import { signalIfSame } from '../src/proc.ts';

describe('autostart', () => {
  const rig = new Rig({ grace: '1s', env: { RESCTL_NO_AUTOSTART: '0' } });
  const lockPath = path.join(rig.dir, 'daemon.lock');
  after(async () => {
    const h = readHolder(lockPath);
    if (h && h !== 'unreadable') signalIfSame(h, 'SIGTERM'); // the daemon is detached: not one of the rig's children
    await waitFor('the autostarted daemon to stop', () => readHolder(lockPath) === null, 10_000).catch(() => undefined);
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('starts the daemon once, and that daemon reaps the run when its owner dies', async () => {
    assert.equal(readHolder(lockPath), null, 'instrument check: no daemon yet');
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'a1', '--owner', String(coord.pid)]).status, 0);
    const holder = await waitFor('daemon.lock to name a live daemon', () => {
      const h = readHolder(lockPath);
      return h && h !== 'unreadable' && isAlive(h) && h;
    });
    assert.notEqual(holder.pid, process.pid);
    const coord2 = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'a2', '--owner', String(coord2.pid)]).status, 0);
    assert.deepEqual(readHolder(lockPath), holder, 'a second run start must not replace the running daemon');

    const lane = rig.lane('a1', 'sleep');
    const id = identityOf(await lane.pid())!;
    await coord.kill();
    await waitFor('the autostarted daemon to reap the lane', () => !isAlive(id), 15_000);
    await waitFor('run a1 cleaned', () => rig.run('a1')?.state === 'cleaned');
    assert.equal(rig.run('a2')!.state, 'alive');
  });
});
