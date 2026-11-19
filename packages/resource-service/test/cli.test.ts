// The dispatch table: every verb is registered; not-yet-built verbs say so and exit 64; usage errors exit 2.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Rig } from './lib/rig.ts';
import { VERBS } from '../src/cli.ts';

describe('cli dispatch', () => {
  const rig = new Rig();
  after(async () => assert.deepEqual(await rig.dispose(), []));

  it('registers every verb of the freeze', () => {
    assert.deepEqual(Object.keys(VERBS).sort(), ['admit', 'docker-env', 'exec', 'install-unit', 'run end', 'run start', 'serve', 'status', 'uninstall-unit']);
  });

  it('usage errors exit 2', () => {
    assert.equal(rig.cli([]).status, 2);
    assert.equal(rig.cli(['frobnicate']).status, 2);
    assert.equal(rig.cli(['run']).status, 2);
    assert.equal(rig.cli(['run', 'start']).status, 2, '--owner is required');
    assert.equal(rig.cli(['run', 'start', '--owner', 'banana']).status, 2, 'neither a pid nor auto');
    assert.equal(rig.cli(['run', 'start', '--owner', '1']).status, 2, 'pid <= 1 is refused');
    assert.equal(rig.cli(['run', 'start', '--id', 'bad id', '--owner', String(process.pid)]).status, 2);
    assert.equal(rig.cli(['exec', '--run', 'x']).status, 2, 'a command is required');
    assert.equal(rig.cli(['exec', '--', 'true']).status, 2, '--run is required');
    assert.equal(rig.cli(['--help']).status, 0);
  });

  it('run ids named like Object.prototype members are ordinary ids (start, exec, end)', () => {
    const c = rig.coordinator();
    for (const id of ['constructor', 'toString', 'hasOwnProperty']) {
      const r = rig.cli(['run', 'start', '--id', id, '--owner', String(c.pid)]);
      assert.equal(r.status, 0, r.stderr);
      assert.ok(Object.hasOwn(rig.state().runs, id), `${id}: the run must really be in state.json`);
      assert.equal(rig.cli(['exec', '--run', id, '--', 'sh', '-c', 'exit 5']).status, 5, `${id}: exec`);
      assert.equal(rig.cli(['run', 'end', '--id', id]).status, 0, `${id}: end`);
      assert.equal(rig.run(id)!.state, 'cleaned');
    }
  });

  it('run start refuses an owner that is not running (exit 3) and prints a generated id when none is given', () => {
    assert.equal(rig.cli(['run', 'start', '--id', 'x', '--owner', '4194000']).status, 3);
    const c = rig.coordinator();
    const r = rig.cli(['run', 'start', '--owner', String(c.pid)]);
    assert.equal(r.status, 0);
    assert.match(r.stdout.trim(), /^run-[0-9a-f]{8}$/);
    assert.ok(rig.run(r.stdout.trim()));
  });
});
