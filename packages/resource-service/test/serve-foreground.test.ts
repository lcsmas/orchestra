// A5 acceptance 2, host half: `resctl serve` is a proper foreground main command with NO systemd in reach — logs on stdout (stderr stays empty), SIGTERM and
// SIGINT are a clean exit 0 that releases daemon.lock, and shutting down reaps nothing.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { BIN, identityOf, isAlive, Rig, waitFor, within } from './lib/rig.ts';

describe('serve in the foreground', () => {
  let rig: Rig;
  const kids: ChildProcess[] = [];
  before(() => {
    rig = new Rig({ grace: '2s', tick: '100ms' });
  });
  after(async () => {
    for (const k of kids) if (k.exitCode === null && k.signalCode === null) k.kill('SIGKILL');
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
  });

  /** `serve` with no systemd/session-bus env, stdout and stderr captured separately. */
  function serve() {
    const env = { ...rig.env };
    for (const k of ['XDG_RUNTIME_DIR', 'DBUS_SESSION_BUS_ADDRESS', 'INVOCATION_ID', 'JOURNAL_STREAM']) delete env[k];
    const child = spawn(process.execPath, [BIN, 'serve'], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    kids.push(child);
    const o = { out: '', err: '' };
    child.stdout!.on('data', (d) => (o.out += d));
    child.stderr!.on('data', (d) => (o.err += d));
    const exited = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((r) => child.once('exit', (code, signal) => r({ code, signal })));
    return { child, o, exited };
  }

  for (const sig of ['SIGTERM', 'SIGINT'] as const) {
    it(`logs on stdout only, and ${sig} is a clean exit 0 that releases daemon.lock and reaps nothing`, async () => {
      const coord = rig.coordinator();
      const runId = `f-${sig.toLowerCase()}`;
      assert.equal(rig.cli(['run', 'start', '--id', runId, '--owner', String(coord.pid)]).status, 0);
      const lane = identityOf(await rig.lane(runId, 'sleep').pid())!;
      const s = serve();
      await waitFor('the serving line on stdout', () => /resctl serve: serving /.test(s.o.out));
      assert.equal(fs.existsSync(path.join(rig.dir, 'daemon.lock')), true);
      assert.equal(s.o.err, '', 'nothing on stderr while it serves');

      s.child.kill(sig);
      const exit = await within('serve exits', s.exited, 8000);
      assert.deepEqual(exit, { code: 0, signal: null }, `${sig} must be a handled, clean exit`);
      assert.match(s.o.out, /resctl serve: stopped/);
      assert.equal(s.o.err, '');
      assert.equal(fs.existsSync(path.join(rig.dir, 'daemon.lock')), false, 'daemon.lock released');
      assert.equal(rig.run(runId)?.state, 'alive', 'a clean stop changes no run');
      assert.ok(isAlive(lane), 'a clean stop killed a lane');
      assert.ok(isAlive(identityOf(coord.pid)!));
    });
  }
});
