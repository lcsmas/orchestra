// SIGTERM while several runs are due at once: the daemon finishes the run it is cleaning and exits — it does not work through all of them first
// (N × RESCTL_TERM_WAIT would outlast `TimeoutStopSec=15` and `docker stop`'s 10 s). The runs it did not reach stay due for the next daemon.
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import { after, before, describe, it } from 'node:test';
import { BIN, identityOf, isAlive, Rig, waitFor, within } from './lib/rig.ts';

describe('stop with several runs due', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '300ms', tick: '100ms', termWait: '1500ms' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('SIGTERM after the first of 5 TERM-ignoring runs started cleaning ends the daemon after THAT run (~1.6 s), not after all five (~8 s); the rest stay alive and due', async () => {
    const lanes = [];
    const coords = [];
    for (let i = 0; i < 5; i++) {
      const c = rig.coordinator();
      assert.equal(rig.cli(['run', 'start', '--id', `d${i}`, '--owner', String(c.pid)]).status, 0);
      lanes.push(identityOf(await rig.lane(`d${i}`, 'ignore-term').pid())!);
      coords.push(c);
    }
    for (const c of coords) await c.kill();
    let out = '';
    const d = spawn(process.execPath, [BIN, 'serve'], { env: rig.env, stdio: ['ignore', 'pipe', 'ignore'] });
    d.stdout!.on('data', (x) => (out += x));
    const exited = new Promise<number | null>((r) => d.once('exit', (code) => r(code)));
    try {
      await waitFor('the first run to start cleaning', () => /run d\d: cleaning/.test(out), 10_000, 20);
      const t0 = Date.now();
      d.kill('SIGTERM');
      assert.equal(await within('serve exits', exited, 20_000), 0);
      const took = Date.now() - t0;
      assert.ok(took < 4000, `the daemon took ${took}ms to stop (5 runs × 1.5 s TERM wait = ~8 s if it works through all of them)`);
      const alive = lanes.filter((l) => isAlive(l)).length;
      assert.ok(alive >= 3, `${alive}/5 lanes still alive: the daemon kept cleaning after SIGTERM`);
      assert.ok(Object.values(rig.state().runs).some((r) => r.state !== 'cleaned'), 'the runs it did not reach are not marked cleaned');
    } finally {
      d.kill('SIGKILL');
    }
  });
});
