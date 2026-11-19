// A5 acceptance 2, container half: `resctl serve` as the main command (PID 1, no --init, NO systemd) of a real container — logs on stdout, a run created
// through `docker exec` is reaped when its owner dies, `status` inside shows the grace, `docker stop` ends it with exit code 0 (not 137).
// The image must already be local (never pulled by a test). The container is labelled resctl.test=<token> and removed in `after`.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { waitFor } from './lib/rig.ts';
import { docker } from './lib/gates.ts';
import type { Status } from '../src/verbs/status.ts';

const IMAGE = 'node:22-slim';
const gate = docker(IMAGE);
const PKG = fileURLToPath(new URL('..', import.meta.url)).replace(/\/$/, '');
const TOKEN = randomBytes(4).toString('hex');
const NAME = `resctl-test-${TOKEN}`;
const CTL = 'node /opt/resctl/bin/resctl.mjs';
const dk = (args: string[], timeout = 120_000) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
};
const inBox = (cmd: string) => dk(['exec', NAME, 'sh', '-c', cmd]);
const status = (): Status => JSON.parse(inBox(`${CTL} status --json`).stdout);

describe('serve as a container main command', { skip: gate.skip }, () => {
  before(() => {
    const r = dk(['run', '-d', '--name', NAME, '--label', `resctl.test=${TOKEN}`, '--memory', '300m', '-v', `${PKG}:/opt/resctl:ro`,
      '-e', 'RESCTL_STATE_DIR=/var/lib/resctl', '-e', 'RESCTL_GRACE=2s', '-e', 'RESCTL_TICK=200ms', '-e', 'RESCTL_TERM_WAIT=400ms', IMAGE, 'node', '/opt/resctl/bin/resctl.mjs', 'serve']);
    assert.equal(r.status, 0, r.stderr);
  });
  after(() => {
    dk(['rm', '-f', NAME]);
    assert.equal(dk(['ps', '-aq', '--filter', `label=resctl.test=${TOKEN}`]).stdout.trim(), '', 'the test container was not removed');
  });

  it('serve is PID 1 and logs on stdout (stderr stays empty)', async () => {
    await waitFor('the serving line in docker logs', () => /resctl serve: serving /.test(dk(['logs', NAME]).stdout), 20_000, 200);
    const logs = dk(['logs', NAME]);
    assert.equal(logs.stderr.replace(/\s+$/, ''), '', 'nothing on the container\'s stderr');
    assert.match(inBox('tr "\\0" " " < /proc/1/cmdline').stdout, /resctl\.mjs serve/);
    assert.equal(inBox('command -v systemctl || echo none').stdout.trim().split('\n').pop(), 'none', 'the image has no systemctl: nothing systemd could have helped');
  });

  it('a run declared through docker exec shows its process, goes in grace when its owner dies, then is reaped', async () => {
    const ownerPid = Number(inBox('sleep 300 >/dev/null 2>&1 & echo $!').stdout.trim());
    assert.ok(ownerPid > 1);
    const start = inBox(`${CTL} run start --id c1 --owner ${ownerPid}`);
    assert.equal(start.status, 0, start.stderr);
    assert.equal(dk(['exec', '-d', NAME, 'sh', '-c', `exec ${CTL} exec --run c1 -- sleep 301`]).status, 0);
    const alive = await waitFor('status to list the lane', () => {
      const r = status().runs.find((x) => x.id === 'c1');
      return r && r.processes.some((p) => p.cmd.includes('sleep 301')) ? r : null;
    }, 20_000, 300);
    const lanePid = alive.processes.find((p) => p.cmd.includes('sleep 301'))!.pid;
    assert.equal(alive.state, 'alive');
    assert.equal(status().daemon.running, true);
    assert.equal(status().daemon.pid, 1, 'the daemon is the container\'s PID 1');
    assert.equal(status().containers.available, false, 'no docker inside the container: status degrades, it does not fail');

    assert.equal(inBox(`kill ${ownerPid}`).status, 0);
    const grace = await waitFor('status to show the run in grace', () => status().runs.find((x) => x.id === 'c1' && x.state === 'grace'), 10_000, 200);
    assert.equal(grace.owner.alive, false);
    assert.ok(grace.processes.length > 0, 'the lane is still alive during the grace');
    await waitFor('the run to be cleaned', () => status().runs.find((x) => x.id === 'c1')?.state === 'cleaned', 20_000, 300);
    assert.notEqual(inBox(`kill -0 ${lanePid} 2>/dev/null; echo $?`).stdout.trim(), '0', 'the lane is gone');
    assert.deepEqual(status().runs.find((x) => x.id === 'c1')!.processes, []);
  });

  it('docker stop ends the main command with exit code 0 (SIGTERM handled as PID 1), quickly, with a final log line', () => {
    const t0 = Date.now();
    assert.equal(dk(['stop', '-t', '8', NAME]).status, 0);
    const took = Date.now() - t0;
    const st = JSON.parse(dk(['inspect', '--format', '{{json .State}}', NAME]).stdout);
    assert.equal(st.ExitCode, 0, `exit code ${st.ExitCode} (137 = SIGKILLed after the stop timeout: SIGTERM was ignored as PID 1)`);
    assert.ok(took < 6000, `docker stop took ${took}ms`);
    assert.match(dk(['logs', NAME]).stdout, /resctl serve: stopped/);
  });
});

// The shipped Dockerfile itself: built from the package dir (needs network once for tini's apt layer), run as the image's own ENTRYPOINT/CMD — NO `--init`,
// no bind mount, no command override. The image carries its own init: tini is PID 1, so a killed escapee is reaped instead of staying <defunct>.
describe('the Dockerfile', { skip: gate.skip }, () => {
  const IMG = `resctl-test-${TOKEN}-img`;
  const NAME2 = `${NAME}-img`;
  const CTL2 = 'node /opt/resctl/bin/resctl.mjs';
  const box = (cmd: string) => dk(['exec', NAME2, 'sh', '-c', cmd]);
  const zombies = () => box('for f in /proc/[0-9]*/status; do grep -q "^State:.Z" $f 2>/dev/null && echo $f; done; true').stdout.trim();
  const st = (): Status => JSON.parse(box(`${CTL2} status --json`).stdout);
  after(() => {
    dk(['rm', '-f', NAME2]);
    dk(['rmi', '-f', IMG]);
    assert.equal(dk(['ps', '-aq', '--filter', `label=resctl.test=${TOKEN}`]).stdout.trim(), '', 'a test container was not removed');
    assert.equal(dk(['images', '-q', IMG]).stdout.trim(), '', 'the test image was not removed');
  });

  it('builds; PID 1 is an init (tini) that runs `serve` as CMD; a setsid-escaped lane process, once killed, leaves NO zombie; docker stop exits 0', async () => {
    const b = dk(['build', '-q', '--label', `resctl.test=${TOKEN}`, '-t', IMG, PKG], 600_000);
    assert.equal(b.status, 0, b.stderr);
    const r = dk(['run', '-d', '--name', NAME2, '--label', `resctl.test=${TOKEN}`, '--memory', '300m', '-e', 'RESCTL_GRACE=2s', '-e', 'RESCTL_TICK=200ms', '-e', 'RESCTL_TERM_WAIT=400ms', IMG]);
    assert.equal(r.status, 0, r.stderr);
    await waitFor('the serving line in docker logs', () => /resctl serve: serving \/var\/lib\/resctl\/state\.json/.test(dk(['logs', NAME2]).stdout), 20_000, 200);
    assert.match(box('tr "\\0" " " < /proc/1/cmdline').stdout, /tini .*resctl\.mjs serve/, 'PID 1 is the init, wrapping serve');
    assert.equal(st().daemon.running, true);
    assert.equal(st().stateDir, '/var/lib/resctl');

    const owner = Number(box('sleep 300 >/dev/null 2>&1 & echo $!').stdout.trim());
    assert.equal(box(`${CTL2} run start --id z1 --owner ${owner}`).status, 0);
    // a lane that spawns a `setsid` child (own session: only the run's token finds it) and stays; both are orphaned to PID 1 once killed
    assert.equal(dk(['exec', '-d', NAME2, 'sh', '-c', `exec ${CTL2} exec --run z1 -- sh -c 'setsid sleep 302 >/dev/null 2>&1 & exec sleep 301'`]).status, 0);
    await waitFor('both lane processes listed', () => (st().runs.find((x) => x.id === 'z1')?.processes.length ?? 0) >= 2, 20_000, 300);
    assert.equal(box(`kill ${owner}`).status, 0);
    await waitFor('the run cleaned', () => st().runs.find((x) => x.id === 'z1')?.state === 'cleaned', 20_000, 300);
    await waitFor('no zombie in the container', () => zombies() === '', 10_000, 300).catch(() => assert.equal(zombies(), '', 'defunct processes left: PID 1 does not reap'));

    assert.equal(dk(['stop', '-t', '8', NAME2]).status, 0);
    assert.equal(JSON.parse(dk(['inspect', '--format', '{{json .State}}', NAME2]).stdout).ExitCode, 0);
  });
});
