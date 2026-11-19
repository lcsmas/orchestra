// Acceptance 3: `run end` kills the run's processes at once — synchronously in the CLI, no daemon running.
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import fs from 'node:fs';
import { BIN, within, Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';

describe('run end', () => {
  let rig: Rig;
  before(() => {
    rig = new Rig({ grace: '10m' });
  });
  after(async () => {
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  it('kills the lane before it returns, marks the run cleaned, and touches nothing else', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'e1', '--owner', String(coord.pid)]).status, 0);
    assert.equal(rig.cli(['run', 'start', '--id', 'e2', '--owner', String(coord.pid)]).status, 0);
    const mine = rig.lane('e1', 'sleep');
    const other = rig.lane('e2', 'sleep'); // another run of the SAME state dir
    const mineId = identityOf(await mine.pid())!;
    const otherId = identityOf(await other.pid())!;
    const by = rig.bystander(); // a process that belongs to no run
    assert.ok(isAlive(mineId) && isAlive(otherId) && isAlive(by.id), 'instrument check: all three are alive before the end');

    const r = rig.cli(['run', 'end', '--id', 'e1']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(!isAlive(mineId), 'the run\'s lane must be dead the moment `run end` returns');
    assert.ok(isAlive(otherId), 'another run\'s lane must survive');
    assert.ok(isAlive(by.id), 'a bystander must survive');
    assert.equal(rig.run('e1')!.state, 'cleaned');
    assert.deepEqual(rig.run('e1')!.lanes, []);
    assert.equal(rig.run('e2')!.state, 'alive');
    assert.equal((await within('lane wrapper exits', mine.exited)).code, 128 + 15);
  });

  it('is idempotent, and an unknown or cleaned run is told apart', () => {
    assert.equal(rig.cli(['run', 'end', '--id', 'e1']).status, 0, 'ending a cleaned run is a no-op');
    assert.equal(rig.cli(['run', 'end', '--id', 'nope']).status, 3, 'an unknown run is refused');
    assert.equal(rig.cli(['run', 'end']).status, 2, '--id is required');
  });

  it('run end from INSIDE one of the run\'s own lanes fails loudly instead of reporting a clean run', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'e3', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('e3', 'end-self', BIN);
    const reply = await waitFor('the lane\'s `run end` answer', () => (fs.existsSync(lane.pidfile) ? JSON.parse(fs.readFileSync(lane.pidfile, 'utf8')) : null));
    assert.equal(reply.status, 1, reply.stderr);
    assert.match(reply.stderr, /own process group/);
    assert.notEqual(rig.run('e3')!.state, 'cleaned', 'a run whose lane could not be signalled must not read as cleaned');
    assert.equal(rig.cli(['run', 'end', '--id', 'e3']).status, 0, 'from outside the lanes it works');
    assert.equal(rig.run('e3')!.state, 'cleaned');
    await within('lane wrapper exits', lane.exited);
  });

  it('exec into a cleaned or unknown run is refused', () => {
    assert.equal(rig.cli(['exec', '--run', 'e1', '--', 'true']).status, 3);
    assert.equal(rig.cli(['exec', '--run', 'nope', '--', 'true']).status, 3);
  });
});
