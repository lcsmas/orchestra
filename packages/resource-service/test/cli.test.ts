// The dispatch table: every verb is registered; not-yet-built verbs say so and exit 64; usage errors exit 2.
import assert from 'node:assert/strict';
import { after, describe, it } from 'node:test';
import { Rig } from './lib/rig.ts';
import { VERBS } from '../src/cli.ts';

describe('cli dispatch', () => {
  const rig = new Rig();
  after(async () => assert.deepEqual(await rig.dispose(), []));

  it('registers every verb of the freeze', () => {
    assert.deepEqual(Object.keys(VERBS).sort(), ['admit', 'docker-env', 'exec', 'run end', 'run start', 'serve', 'status']);
  });

  for (const [verb, ticket] of [['admit', 'A3'], ['docker-env', 'A2'], ['status', 'A5']] as const) {
    it(`${verb} is a stub: "not implemented (${ticket})", exit 64`, () => {
      const r = rig.cli([verb, '--run', 'x']);
      assert.equal(r.status, 64);
      assert.match(r.stderr, new RegExp(`not implemented \\(${ticket}\\)`));
    });
  }

  it('usage errors exit 2', () => {
    assert.equal(rig.cli([]).status, 2);
    assert.equal(rig.cli(['frobnicate']).status, 2);
    assert.equal(rig.cli(['run']).status, 2);
    assert.equal(rig.cli(['run', 'start']).status, 2, '--owner is required');
    assert.equal(rig.cli(['run', 'start', '--owner', 'auto']).status, 2, 'auto is A6');
    assert.equal(rig.cli(['run', 'start', '--owner', '1']).status, 2, 'pid <= 1 is refused');
    assert.equal(rig.cli(['run', 'start', '--id', 'bad id', '--owner', String(process.pid)]).status, 2);
    assert.equal(rig.cli(['exec', '--run', 'x']).status, 2, 'a command is required');
    assert.equal(rig.cli(['exec', '--', 'true']).status, 2, '--run is required');
    assert.equal(rig.cli(['--help']).status, 0);
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
