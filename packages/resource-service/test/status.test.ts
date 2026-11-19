// A5 acceptance 3: `resctl status` shows a run the test created with its process, and its state changing to "in grace" once the owner dies.
// Real CLI, real daemon, real processes; the container source is exercised against real docker AND through the seam with fake sources.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { identityOf, Rig, waitFor, within } from './lib/rig.ts';
import { docker } from './lib/gates.ts';
import type { ContainerSource } from '../src/status-sources.ts';
import { collectStatus, type RunStatus, type Status } from '../src/verbs/status.ts';

const TOKEN = randomBytes(4).toString('hex');
const dockerGate = docker('alpine:3');
const dk = (args: string[]) => {
  const r = spawnSync('docker', args, { encoding: 'utf8', timeout: 60_000 });
  return { status: r.status, stdout: r.stdout ?? '', stderr: r.stderr ?? '' }; // no docker binary: empty output, not a TypeError
};

describe('status', () => {
  let rig: Rig;
  // `RESCTL_DOCKER_TIMEOUT` is generous here: the real-docker test must not depend on how loaded the host is (the 5 s default is tested with a shim, below)
  const json = (env: NodeJS.ProcessEnv = {}): Status => {
    const r = rig.cli(['status', '--json'], { RESCTL_DOCKER_TIMEOUT: '120s', ...env });
    assert.equal(r.status, 0, r.stderr);
    return JSON.parse(r.stdout);
  };
  const runOf = (id: string): RunStatus | undefined => json().runs.find((r) => r.id === id);
  before(() => {
    rig = new Rig({ grace: '3s', tick: '100ms' });
  });
  after(async () => {
    // remove EVERY container of this token first (a failed test may have left the orphan one), dispose the rig regardless, assert last
    const mine = dk(['ps', '-aq', '--filter', `label=resctl.test=${TOKEN}`]).stdout.trim().split('\n').filter(Boolean);
    if (mine.length) dk(['rm', '-f', ...mine]);
    const left = dk(['ps', '-aq', '--filter', `label=resctl.test=${TOKEN}`]).stdout.trim();
    const leaked = await rig.dispose();
    assert.equal(left, '', 'a test container was not removed');
    assert.deepEqual(leaked, [], 'a process was left behind');
  });

  it('an empty state dir: no runs, daemon not running, exit 0', () => {
    const j = json();
    assert.deepEqual(j.runs, []);
    assert.equal(j.daemon.running, false);
    assert.equal(j.stateDir, rig.dir);
    const t = rig.cli(['status']);
    assert.equal(t.status, 0);
    assert.match(t.stdout, /no runs/);
    assert.match(t.stdout, /NOT RUNNING/);
    assert.equal(rig.cli(['status', 'extra']).status, 2);
    assert.equal(rig.cli(['status', '--bogus']).status, 2);
  });

  it('WITHOUT a daemon an owner that died leaves the run "alive" (flagged), because only the reaper moves a run to grace', async () => {
    const c = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 's0', '--owner', String(c.pid)]).status, 0);
    await c.kill();
    await new Promise((r) => setTimeout(r, 400));
    const r = runOf('s0')!;
    assert.equal(r.state, 'alive');
    assert.equal(r.owner.alive, false);
    assert.equal(json().daemon.running, false);
    assert.match(rig.cli(['status']).stdout, /alive \(owner gone, not yet noticed by the reaper\)/);
  });

  it('lists the run with owner, state, its lane and descendants, and the memory they sum to', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 's1', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('s1', 'env-i'); // a node lane + a `sleep` child in its group
    const lanePid = await lane.pid().then(() => rig.run('s1')!.lanes[0].pid);
    const r = await waitFor('both processes of the run listed', () => {
      const x = runOf('s1');
      return x && x.processes.length === 2 ? x : null;
    });
    assert.equal(r.state, 'alive');
    assert.deepEqual({ pid: r.owner.pid, alive: r.owner.alive }, { pid: coord.pid, alive: true });
    assert.equal(r.lanes.length, 1);
    assert.deepEqual({ pid: r.lanes[0].pid, alive: r.lanes[0].alive }, { pid: lanePid, alive: true });
    const laneProc = r.processes.find((p) => p.pid === lanePid)!;
    assert.ok(laneProc.lane && laneProc.cmd.includes('lane.mjs'), laneProc.cmd);
    assert.ok(r.processes.some((p) => !p.lane && p.cmd.startsWith('sleep')), 'the descendant is listed');
    assert.ok(r.processes.every((p) => p.rssKb > 0), JSON.stringify(r.processes));
    const sum = r.processes.reduce((s, p) => s + p.rssKb, 0);
    assert.equal(r.memory.rssKb, sum, 'memory = the sum over EVERY process of the run');
    assert.ok(r.memory.rssKb > laneProc.rssKb, 'more than the lane alone');
    const own = Number(/^VmRSS:\s+(\d+) kB$/m.exec(fs.readFileSync(`/proc/${lanePid}/status`, 'utf8'))![1]); // read here, NOT through the code under test
    assert.ok(Math.abs(laneProc.rssKb - own) <= own * 0.25 + 2048, `lane RSS ${laneProc.rssKb} kB vs an independent read ${own} kB`);
    const text = rig.cli(['status']).stdout;
    assert.match(text, /run s1: alive/);
    assert.ok(text.includes(`lane pid ${lanePid}`) && text.includes('lane.mjs'));
    assert.match(text, /processes: 2, memory /);
    await coord.kill(); // owner dies — with no daemon yet the run stays alive; the s0 run too
  });

  it('once the reaper runs: the state changes to "in grace" after the owner dies, the process is still listed, then "cleaned" with none', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 's2', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('s2', 'sleep');
    const lanePid = await lane.pid();
    assert.equal(runOf('s2')!.state, 'alive');
    rig.startDaemon();
    await waitFor('the daemon', () => json().daemon.running);
    assert.equal(runOf('s2')!.state, 'alive', 'owner alive: stays alive');
    assert.equal(json().daemon.pid !== undefined, true);

    await coord.kill();
    const g = await waitFor('status to show s2 in grace', () => {
      const x = runOf('s2');
      return x?.state === 'grace' ? x : null;
    });
    assert.equal(g.owner.alive, false);
    assert.ok(g.graceEndsAt! > Date.now() - 1000 && g.graceLeftMs! > 0 && g.graceLeftMs! <= 3000, `graceLeftMs ${g.graceLeftMs}`);
    assert.ok(g.processes.some((p) => p.pid === lanePid), 'the lane is still listed during the grace');
    assert.ok(g.memory.rssKb > 0);
    assert.match(rig.cli(['status']).stdout, /run s2: in grace \(\d+s left\)/);

    const done = await waitFor('status to show s2 cleaned', () => {
      const x = runOf('s2');
      return x?.state === 'cleaned' ? x : null;
    }, 20_000);
    assert.deepEqual(done.processes, []);
    assert.equal(done.memory.rssKb, 0);
    assert.equal(identityOf(lanePid), null);
    // the other runs created above went through the same transitions
    await waitFor('s0 and s1 cleaned by the same daemon', () => ['s0', 's1'].every((id) => runOf(id)?.state === 'cleaned'), 20_000);
  });

  it('a corrupt state.json: ONE error line naming the file, no stack, exit 1 — and the daemon / containers lines are still shown', () => {
    const bad = new Rig();
    try {
      fs.writeFileSync(path.join(bad.dir, 'state.json'), '{corrupt');
      const sh = fs.mkdtempSync(path.join(bad.dir, 'shim-'));
      fs.writeFileSync(path.join(sh, 'docker'), "#!/bin/sh\nprintf 'abc\\trelay\\trunning\\timg\\tsome-run\\n'\n", { mode: 0o755 });
      const t = bad.cli(['status'], { PATH: `${sh}:${process.env.PATH}` });
      assert.equal(t.status, 1);
      assert.equal(t.stderr, '', 'no stack on stderr');
      assert.match(t.stdout, /ERROR: .*state\.json is unreadable/);
      assert.match(t.stdout, /^daemon: /m);
      assert.match(t.stdout, /^containers: /m);
      assert.doesNotMatch(t.stdout, / at load /);
      const j = JSON.parse(bad.cli(['status', '--json'], { PATH: `${sh}:${process.env.PATH}` }).stdout) as Status;
      assert.match(j.stateError ?? '', /state\.json is unreadable/);
      assert.deepEqual(j.runs, []);
      assert.deepEqual(j.orphanContainers, [], 'with the state unreadable no container is called an orphan');
    } finally {
      fs.rmSync(bad.dir, { recursive: true, force: true });
    }
  });

  describe('containers', () => {
    /** A `docker` on PATH that is a script: what `status` asks of docker is answered by the test, no daemon, no clock. */
    const shim = (body: string): NodeJS.ProcessEnv => {
      const d = fs.mkdtempSync(path.join(rig.dir, 'shim-'));
      fs.writeFileSync(path.join(d, 'docker'), `#!/bin/sh\n${body}\n`, { mode: 0o755 });
      return { PATH: `${d}:${process.env.PATH}` };
    };

    it('a docker that answers: its containers are grouped under their run, parsed from the exact `ps` format (shim, no real docker)', () => {
      const c = rig.coordinator();
      assert.equal(rig.cli(['run', 'start', '--id', 'sh1', '--owner', String(c.pid)]).status, 0);
      // plus a FOREIGN container of another host-wide run (what a concurrent suite / another swarm leaves on the shared daemon): it must not change sh1's result
      const j = json(shim(`printf 'abc123\\trelay-1\\trunning\\talpine:3\\tsh1\\nfff999\\tforeign\\trunning\\talpine:3\\tsomeone-elses\\n'`));
      assert.equal(j.containers.available, true);
      assert.deepEqual(j.runs.find((r) => r.id === 'sh1')!.containers, [{ id: 'abc123', name: 'relay-1', state: 'running', image: 'alpine:3', run: 'sh1' }]);
      assert.deepEqual(j.orphanContainers.map((c) => c.name), ['foreign'], 'the foreign container is reported apart, not under sh1');
    });

    it('a docker that never answers: status gives up after RESCTL_DOCKER_TIMEOUT (not the 5 s default), says why, exit 0', () => {
      const t0 = Date.now();
      const r = rig.cli(['status', '--json'], { ...shim('exec sleep 30'), RESCTL_DOCKER_TIMEOUT: '300ms' });
      assert.equal(r.status, 0, r.stderr);
      assert.ok(Date.now() - t0 < 4500, `status took ${Date.now() - t0}ms`);
      const j: Status = JSON.parse(r.stdout);
      assert.equal(j.containers.available, false);
      assert.match(j.containers.reasons[0], /did not answer within 0\.3s/);
    });

    it('a docker that answers slowly (11 s, past the old fixed 10 s cap) is waited for when RESCTL_DOCKER_TIMEOUT allows it', () => {
      const c = rig.coordinator();
      assert.equal(rig.cli(['run', 'start', '--id', 'slow1', '--owner', String(c.pid)]).status, 0);
      const j = json({ ...shim(`sleep 11; printf 'abc\\tslow\\trunning\\timg\\tslow1\\n'`), RESCTL_DOCKER_TIMEOUT: '60s' });
      assert.equal(j.containers.available, true, JSON.stringify(j.containers));
      assert.deepEqual(j.runs.find((r) => r.id === 'slow1')!.containers.map((x) => x.name), ['slow']);
    });

    it('a docker that fails: the first line of its stderr is the reason (exit 0)', () => {
      const j = json(shim('echo "Cannot connect to the Docker daemon" >&2; exit 1'));
      assert.equal(j.containers.available, false);
      assert.match(j.containers.reasons[0], /Cannot connect to the Docker daemon/);
    });

    it('no docker binary on PATH: status lists the runs, containers read "unavailable" with the reason and "unknown" per run (exit 0)', () => {
      const missing = rig.cli(['status'], { PATH: fs.mkdtempSync(path.join(rig.dir, 'nopath-')) });
      assert.equal(missing.status, 0, missing.stderr);
      assert.match(missing.stdout, /containers: unavailable \(.*docker not found/);
      assert.match(missing.stdout, /containers: unknown/);
    });

    it('with docker reachable, a container labelled resctl.run=<id> is listed under that run; one labelled with an unknown run is reported apart', { skip: dockerGate.skip }, async () => {
      // run ids are PER TOKEN: the docker daemon is shared by every concurrent copy of this suite (a plain `s3` collided with a sibling's container)
      const runId = `s3-${TOKEN}`;
      const coord = rig.coordinator();
      assert.equal(rig.cli(['run', 'start', '--id', runId, '--owner', String(coord.pid)]).status, 0);
      const mk = (name: string, run: string) => dk(['run', '-d', '--name', name, '--label', `resctl.run=${run}`, '--label', `resctl.test=${TOKEN}`, '--memory', '32m', 'alpine:3', 'sleep', '120']);
      assert.equal(mk(`resctl-test-${TOKEN}`, runId).status, 0);
      assert.equal(mk(`resctl-test-${TOKEN}-orphan`, `nobody-${TOKEN}`).status, 0);
      const j = json();
      assert.equal(j.containers.available, true, JSON.stringify(j.containers));
      const r = j.runs.find((x) => x.id === runId)!;
      assert.deepEqual(r.containers.map((c) => [c.name, c.state, c.image]), [[`resctl-test-${TOKEN}`, 'running', 'alpine:3']]);
      assert.deepEqual(j.orphanContainers.filter((c) => c.name.includes(TOKEN)).map((c) => c.run), [`nobody-${TOKEN}`], 'other containers of the host may be orphans too: only ours are asserted');
      assert.ok(rig.cli(['status']).stdout.includes(`resctl-test-${TOKEN} (running)`));
      dk(['rm', '-f', `resctl-test-${TOKEN}-orphan`]);
      await coord.kill();
    });

    it('docker unreachable or missing: status still lists the runs, says containers are unavailable and why (exit 0)', { skip: dockerGate.skip }, () => {
      const unreachable = rig.cli(['status', '--json'], { DOCKER_HOST: 'unix:///nonexistent/resctl-test.sock' });
      assert.equal(unreachable.status, 0, unreachable.stderr);
      const j: Status = JSON.parse(unreachable.stdout);
      assert.equal(j.containers.available, false);
      assert.ok(j.containers.reasons.length > 0 && /docker/.test(j.containers.reasons[0]), j.containers.reasons.join());
      assert.ok(j.runs.length >= 4, 'the runs are listed regardless');
    });
  });

  describe('the container seam (what A2 plugs into)', () => {
    const fake: ContainerSource = { name: 'fake', collect: async () => ({ available: true, containers: [{ id: 'abc', name: 'relay-1', image: 'x', state: 'running', run: 's1' }, { id: 'def', name: 'relay-2', image: 'x', state: 'exited', run: 'gone' }] }) };
    const env = () => ({ ...rig.env });

    it('a registered source\'s containers appear under their run, merged by id with the other sources', async () => {
      const dup: ContainerSource = { name: 'dup', collect: async () => ({ available: true, containers: [{ id: 'abc', name: 'relay-1', image: 'x', state: 'running', run: 's1' }] }) };
      const s = await collectStatus(env(), [fake, dup]);
      assert.deepEqual(s.runs.find((r) => r.id === 's1')!.containers.map((c) => c.id), ['abc'], 'listed once');
      assert.deepEqual(s.orphanContainers.map((c) => c.id), ['def']);
      assert.equal(s.containers.available, true);
    });

    it('a source that throws SYNCHRONOUSLY, or never answers, degrades too (status neither fails nor hangs)', async () => {
      const sync: ContainerSource = { name: 'sync', collect: () => { throw new Error('sync boom'); } };
      const hang: ContainerSource = { name: 'hang', collect: () => new Promise(() => {}) };
      const t0 = Date.now();
      const s = await within('status answers although a source hangs', collectStatus(env(), [sync, hang, fake], Date.now(), 200), 5000);
      assert.ok(Date.now() - t0 < 5000);
      assert.deepEqual(s.containers.reasons, ['sync: sync boom', 'hang: no answer within 200ms']);
      assert.equal(s.runs.find((r) => r.id === 's1')!.containers.length, 1, 'the healthy source still counts');
    });

    it('a source that throws or reports unavailable degrades; the others still count', async () => {
      const boom: ContainerSource = { name: 'boom', collect: async () => { throw new Error('socket exploded'); } };
      const down: ContainerSource = { name: 'down', collect: async () => ({ available: false, reason: 'no daemon' }) };
      const s = await collectStatus(env(), [boom, down, fake]);
      assert.equal(s.containers.available, true);
      assert.deepEqual(s.containers.reasons, ['boom: socket exploded', 'down: no daemon']);
      assert.equal(s.runs.find((r) => r.id === 's1')!.containers.length, 1);
      const none = await collectStatus(env(), [boom, down]);
      assert.equal(none.containers.available, false);
      assert.ok(none.runs.length >= 4);
    });
  });
});
