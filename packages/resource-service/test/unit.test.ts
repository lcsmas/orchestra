// A5 acceptance 1: the systemd USER unit starts and stops cleanly. REAL `systemctl --user`, a UNIQUE unit name (RESCTL_UNIT_NAME) — never the real resctl.service —
// removed in `after`; its state dir is the rig's private dir, so the unit's reaper only ever sees this test's runs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, before, describe, it } from 'node:test';
import { identityOf, isAlive, Rig, waitFor, within } from './lib/rig.ts';
import { systemd } from './lib/gates.ts';
import { readHolder } from '../src/lockfile.ts';
import { execWord } from '../src/systemd.ts';

const gate = systemd();
const UNIT = `resctl-test-${randomBytes(4).toString('hex')}.service`;
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const UNIT_FILE = path.join(UNIT_DIR, UNIT);
const sysctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 60_000 });
const prop = (p: string): string => sysctl('show', '--property', p, '--value', UNIT).stdout.trim();
const isEnabled = (): string => sysctl('is-enabled', UNIT).stdout.trim();
const listed = (): string => sysctl('list-units', '--all', '--plain', '--no-legend', UNIT).stdout.trim();

/** A crashed earlier run (or a mutant that timed out) can leave a test unit behind: drop every `resctl-test-*` unit whose pinned state dir no longer exists. */
function sweepStale(): void {
  for (const f of fs.existsSync(UNIT_DIR) ? fs.readdirSync(UNIT_DIR) : []) {
    if (!/^resctl-test-[0-9a-f]{8}\.service$/.test(f) || f === UNIT) continue;
    const text = fs.readFileSync(path.join(UNIT_DIR, f), 'utf8');
    const dir = /RESCTL_STATE_DIR=([^"]+)"/.exec(text)?.[1];
    if (!text.startsWith('# managed by `resctl install-unit`') || !dir || fs.existsSync(dir)) continue;
    sysctl('disable', '--now', f);
    fs.rmSync(path.join(UNIT_DIR, f), { force: true });
    sysctl('daemon-reload');
  }
}

describe('systemd user unit', { skip: gate.skip }, () => {
  let rig: Rig;
  let u2Lane: ReturnType<typeof identityOf> = null;
  before(() => {
    sweepStale();
    rig = new Rig({ grace: '2s', tick: '100ms', env: { RESCTL_UNIT_NAME: UNIT } });
    // never reach an install unless the CLI itself says it would write OUR unit, not the real resctl.service
    assert.match(UNIT, /^resctl-test-[0-9a-f]{8}\.service$/);
    assert.ok(rig.cli(['install-unit', '--print']).stderr.includes(`would install ${UNIT} at ${UNIT_FILE}`), 'RESCTL_UNIT_NAME did not select the test unit: refusing to install anything');
  });
  after(async () => {
    // never leave a unit, a file or a symlink behind — even when a test failed half way
    sysctl('stop', UNIT); // `disable --now` needs the unit FILE: a loaded unit whose file a failed test removed must still be stopped
    sysctl('disable', UNIT);
    fs.rmSync(UNIT_FILE, { force: true });
    sysctl('daemon-reload');
    sysctl('reset-failed', UNIT);
    const leftovers = [fs.existsSync(UNIT_FILE) && 'unit file', isEnabled() === 'enabled' && 'enabled symlink', /\S/.test(listed()) && 'loaded unit'].filter(Boolean);
    assert.deepEqual(await rig.dispose(), [], 'a process was left behind');
    assert.deepEqual(leftovers, [], 'the test unit was not fully removed');
  });

  it('--print shows the unit without touching systemd or the disk', () => {
    const r = rig.cli(['install-unit', '--print']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(r.stderr.includes(`would install ${UNIT} at ${UNIT_FILE}`), 'names the unit it would write (the test installs only after this matched)');
    assert.match(r.stdout, /^# managed by `resctl install-unit`/);
    assert.match(r.stdout, /^ExecStart="[^"]+node[^"]*" "[^"]*packages\/resource-service\/bin\/resctl\.mjs" "serve"$/m);
    assert.ok(r.stdout.includes(`Environment="RESCTL_STATE_DIR=${rig.dir}"`), 'the unit is pinned to the state dir');
    assert.match(r.stdout, /^Environment="RESCTL_GRACE=2s"$/m);
    assert.match(r.stdout, /^\[Install\]\nWantedBy=default\.target$/m);
    assert.equal(fs.existsSync(UNIT_FILE), false);
  });

  it('a config value the service would reject is refused at install, nothing written', () => {
    const r = rig.cli(['install-unit'], { RESCTL_GRACE: 'soon' });
    assert.equal(r.status, 2);
    assert.match(r.stderr, /RESCTL_GRACE/);
    assert.equal(fs.existsSync(UNIT_FILE), false);
    assert.equal(rig.cli(['install-unit'], { RESCTL_UNIT_NAME: 'bad name.service' }).status, 2);
  });

  it('no systemctl on the host: exit 1 naming the foreground mode, nothing written', () => {
    const empty = fs.mkdtempSync(path.join(rig.dir, 'nopath-'));
    const r = rig.cli(['install-unit'], { PATH: empty });
    assert.equal(r.status, 1);
    assert.match(r.stderr, /no systemd/);
    assert.match(r.stderr, /resctl serve/);
    assert.equal(fs.existsSync(UNIT_FILE), false);
  });

  it('a unit file resctl did not write is neither overwritten nor removed (exit 3)', () => {
    fs.mkdirSync(UNIT_DIR, { recursive: true });
    fs.writeFileSync(UNIT_FILE, '[Service]\nExecStart=/bin/true\n');
    const before = fs.readFileSync(UNIT_FILE, 'utf8');
    assert.equal(rig.cli(['install-unit']).status, 3);
    assert.equal(rig.cli(['uninstall-unit']).status, 3);
    assert.equal(fs.readFileSync(UNIT_FILE, 'utf8'), before, 'the foreign file is untouched');
    fs.rmSync(UNIT_FILE);
  });

  it('execWord quotes what systemd would expand: backslash, quote, $ and %', () => {
    assert.equal(execWord('/a b/node'), '"/a b/node"');
    assert.equal(execWord('p$q%h"x\\y'), '"p$$q%%h\\"x\\\\y"');
  });

  it('install while ANOTHER daemon holds daemon.lock: exit 1 saying so (the unit would sit failed), nothing killed', async () => {
    const d = rig.startDaemon();
    await waitFor('the foreign daemon\'s lock', () => readHolder(path.join(rig.dir, 'daemon.lock')) !== null);
    const r = rig.cli(['install-unit']);
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /daemon\.lock/);
    assert.equal(d.child.exitCode, null, 'the foreign daemon is untouched');
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
    d.child.kill('SIGTERM');
    await within('the foreign daemon exits', d.exited);
    assert.equal(fs.existsSync(UNIT_FILE), false);
  });

  it('install writes, enables and starts the unit; its daemon is the one holding daemon.lock', async () => {
    const r = rig.cli(['install-unit']);
    assert.equal(r.status, 0, r.stderr);
    assert.ok(fs.readFileSync(UNIT_FILE, 'utf8').startsWith('# managed by `resctl install-unit`'));
    assert.equal(isEnabled(), 'enabled');
    await waitFor('the unit to be active', () => sysctl('is-active', UNIT).stdout.trim() === 'active');
    const main = Number(prop('MainPID'));
    assert.ok(main > 1);
    const holder = await waitFor('daemon.lock held by the unit', () => {
      const h = readHolder(path.join(rig.dir, 'daemon.lock'));
      return h && h !== 'unreadable' ? h : null;
    });
    assert.equal(holder.pid, main, 'the lock holder is the unit\'s main process');
    assert.deepEqual(identityOf(main), holder);
  });

  it('the unit reaps a run whose owner dies (grace, then cleaned)', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'u1', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('u1', 'sleep');
    const id = identityOf(await lane.pid())!;
    await coord.kill();
    await waitFor('the unit\'s daemon to put u1 in grace', () => rig.run('u1')?.state === 'grace');
    await waitFor('the unit\'s daemon to clean u1', () => rig.run('u1')?.state === 'cleaned', 20_000);
    assert.equal(isAlive(id), false);
  });

  it('stop is clean and reaps nothing: lock released, exit 0, a live run and its lane untouched', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 'u2', '--owner', String(coord.pid)]).status, 0);
    const lane = rig.lane('u2', 'sleep');
    const id = identityOf(await lane.pid())!;
    u2Lane = id;
    const t0 = Date.now();
    const stop = sysctl('stop', UNIT);
    assert.equal(stop.status, 0, stop.stderr);
    assert.ok(Date.now() - t0 < 8000, `stop took ${Date.now() - t0}ms (the daemon must exit on SIGTERM, not be killed after the timeout)`);
    assert.equal(prop('ActiveState'), 'inactive');
    assert.equal(prop('Result'), 'success');
    assert.equal(prop('ExecMainCode'), '1', 'exited (not killed by a signal)');
    assert.equal(prop('ExecMainStatus'), '0');
    assert.equal(fs.existsSync(path.join(rig.dir, 'daemon.lock')), false, 'daemon.lock released');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rig.run('u2')?.state, 'alive', 'stopping the unit changed no run');
    assert.ok(isAlive(id), 'stopping the unit killed a lane');
    assert.ok(isAlive(identityOf(coord.pid)!), 'stopping the unit killed an owner');
    // and the unit comes back
    assert.equal(sysctl('start', UNIT).status, 0);
    await waitFor('the unit to be active again', () => sysctl('is-active', UNIT).stdout.trim() === 'active');
    await new Promise((r) => setTimeout(r, 500));
    assert.equal(rig.run('u2')?.state, 'alive');
    assert.ok(isAlive(id));
  });

  it('uninstall stops, disables and removes the unit — idempotent, and it reaps nothing either', () => {
    const r = rig.cli(['uninstall-unit']);
    assert.equal(r.status, 0, r.stderr);
    assert.equal(fs.existsSync(UNIT_FILE), false, 'unit file removed');
    assert.notEqual(isEnabled(), 'enabled');
    assert.equal(fs.existsSync(path.join(UNIT_DIR, 'default.target.wants', UNIT)), false, 'enable symlink removed');
    assert.equal(listed(), '', 'the unit is no longer loaded');
    assert.equal(fs.existsSync(path.join(rig.dir, 'daemon.lock')), false);
    assert.equal(rig.run('u2')?.state, 'alive');
    assert.ok(u2Lane && isAlive(u2Lane), 'uninstalling the unit killed a lane');
    const again = rig.cli(['uninstall-unit']);
    assert.equal(again.status, 0);
    assert.match(again.stdout, /not installed/);
  });

  it('a state dir with a space, %, $ and a quote survives the unit file: the unit\'s daemon locks THAT dir', async () => {
    const weird = path.join(rig.dir, 'we ird%h$x"q');
    const r = rig.cli(['install-unit'], { RESCTL_STATE_DIR: weird });
    assert.equal(r.status, 0, r.stderr);
    const holder = await waitFor('daemon.lock in the odd dir', () => {
      const h = readHolder(path.join(weird, 'daemon.lock'));
      return h && h !== 'unreadable' ? h : null;
    });
    assert.equal(holder.pid, Number(prop('MainPID')));
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
  });

  it('uninstall still stops a unit whose FILE was deleted by hand; with no systemd an absent unit is exit 0', async () => {
    assert.equal(rig.cli(['install-unit']).status, 0);
    await waitFor('the unit to be active', () => sysctl('is-active', UNIT).stdout.trim() === 'active');
    fs.rmSync(UNIT_FILE);
    const r = rig.cli(['uninstall-unit']);
    assert.equal(r.status, 0, r.stderr);
    assert.notEqual(sysctl('is-active', UNIT).stdout.trim(), 'active', 'the orphaned unit is still running');
    assert.equal(fs.existsSync(path.join(UNIT_DIR, 'default.target.wants', UNIT)), false);
    const nosys = rig.cli(['uninstall-unit'], { PATH: fs.mkdtempSync(path.join(rig.dir, 'nopath2-')) });
    assert.equal(nosys.status, 0, nosys.stderr);
    assert.match(nosys.stdout, /not installed/);
  });
});
