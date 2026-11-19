// A daemon autostarted from INSIDE a lane inherits the lane's env; it must not carry the run marker, or `run end` of that run would sweep the daemon.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { BIN, Rig, isAlive, waitFor, within } from './lib/rig.ts';
import { readHolder } from '../src/lockfile.ts';
import { signalIfSame } from '../src/proc.ts';

describe('autostart from inside a lane', () => {
  const rig = new Rig({ grace: '10m', env: { RESCTL_NO_AUTOSTART: '0' } });
  const lockPath = path.join(rig.dir, 'daemon.lock');
  after(async () => {
    const h = readHolder(lockPath);
    if (h && h !== 'unreadable') signalIfSame(h, 'SIGTERM'); // detached: not one of the rig's children
    await waitFor('the daemon to stop', () => readHolder(lockPath) === null, 10_000).catch(() => undefined);
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('the run end of the lane\'s run does not kill the daemon that lane started', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'outer', '--owner', String(coord.pid), ], { RESCTL_NO_AUTOSTART: '1' }).status, 0);
    assert.equal(readHolder(lockPath), null, 'instrument check: no daemon before the lane runs');
    const lane = rig.lane('outer', 'start-run', BIN);
    const reply = await waitFor('the lane\'s run start answer', () => (fs.existsSync(lane.pidfile) ? JSON.parse(fs.readFileSync(lane.pidfile, 'utf8')) : null));
    assert.equal(reply.status, 0, reply.stderr);
    const daemon = await waitFor('a daemon started from inside the lane', () => {
      const h = readHolder(lockPath);
      return h && h !== 'unreadable' && isAlive(h) && h;
    });
    assert.equal(rig.cli(['run', 'end', '--id', 'outer']).status, 0);
    await within('lane wrapper exits', lane.exited);
    assert.ok(isAlive(daemon), 'ending the run swept the daemon that was started from inside its lane');
  });
});
