// A5 acceptance 1: the systemd USER unit starts and stops cleanly. REAL `systemctl --user`, a UNIQUE unit name (RESCTL_UNIT_NAME) — never the real resctl.service —
// removed in `after`; its state dir is the rig's private dir, so the unit's reaper only ever sees this test's runs.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { spawn, spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { after, before, describe, it } from 'node:test';
import { identityOf, isAlive, Rig, waitFor, within } from './lib/rig.ts';
import { systemd } from './lib/gates.ts';
import { readHolder } from '../src/lockfile.ts';
import { staleTestUnits, TEST_UNIT } from './lib/units.ts';

const gate = systemd();
const UNIT = `resctl-test-${randomBytes(4).toString('hex')}.service`;
const UNIT_DIR = path.join(process.env.XDG_CONFIG_HOME || path.join(os.homedir(), '.config'), 'systemd', 'user');
const UNIT_FILE = path.join(UNIT_DIR, UNIT);
const sysctl = (...args: string[]) => spawnSync('systemctl', ['--user', ...args], { encoding: 'utf8', timeout: 60_000 });
const prop = (p: string): string => sysctl('show', '--property', p, '--value', UNIT).stdout.trim();
const isEnabled = (): string => sysctl('is-enabled', UNIT).stdout.trim();
const listed = (): string => sysctl('list-units', '--all', '--plain', '--no-legend', UNIT).stdout.trim();

/** A crashed earlier run (or a mutant that timed out) can leave a test unit behind: drop the `resctl-test-*` units whose pinned rig state dir no longer exists (never a live sibling's). */
function sweepStale(): void {
  const files = (fs.existsSync(UNIT_DIR) ? fs.readdirSync(UNIT_DIR) : []).filter((f) => TEST_UNIT.test(f) && f !== UNIT).map((name) => ({ name, text: fs.readFileSync(path.join(UNIT_DIR, name), 'utf8') }));
  for (const f of staleTestUnits(files, fs.existsSync)) {
    sysctl('stop', f);
    sysctl('disable', f);
    fs.rmSync(path.join(UNIT_DIR, f), { force: true });
    sysctl('daemon-reload');
    sysctl('reset-failed', f);
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
    // uninstall resolves its own name and always runs `disable --now`: it must name OUR unit before any test calls it
    assert.ok(rig.cli(['uninstall-unit', '--print']).stderr.includes(`would uninstall ${UNIT} at ${UNIT_FILE}`), 'uninstall-unit did not select the test unit: refusing to run anything');
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

  it('install takes over from an AUTOSTARTED daemon: stopped by identity (it reaps nothing), the unit holds the lock and is not left failed', async () => {
    const coord = rig.coordinator();
    assert.equal(rig.cli(['run', 'start', '--id', 't1', '--owner', String(coord.pid)], { RESCTL_NO_AUTOSTART: '' }).status, 0); // `run start` autostarts a detached serve
    const old = await waitFor('the autostarted daemon\'s lock', () => {
      const h = readHolder(path.join(rig.dir, 'daemon.lock'));
      return h && h !== 'unreadable' ? h : null;
    });
    const lane = identityOf(await rig.lane('t1', 'sleep').pid())!;
    const r = rig.cli(['install-unit']);
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.ok(r.stderr.includes(`stopped daemon pid ${old.pid}`), r.stderr);
    assert.equal(isAlive(old), false, 'the autostarted daemon is gone');
    await waitFor('the unit to hold the lock', () => {
      const h = readHolder(path.join(rig.dir, 'daemon.lock'));
      return h && h !== 'unreadable' && h.pid === Number(prop('MainPID')) && h.pid !== old.pid;
    });
    assert.equal(sysctl('is-active', UNIT).stdout.trim(), 'active');
    assert.equal(rig.run('t1')?.state, 'alive', 'taking over reaped nothing');
    assert.ok(isAlive(lane) && isAlive(identityOf(coord.pid)!));
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
  });

  /** A process that takes daemon.lock and ignores SIGTERM. `detached` = its own process group (like an autostarted daemon); otherwise it shares the caller's group. */
  async function stubbornHolder(detached: boolean) {
    const lockjs = fileURLToPath(new URL('../src/lockfile.ts', import.meta.url));
    const holder = spawn(process.execPath, ['--input-type=module', '-e', `import { tryAcquire } from ${JSON.stringify(lockjs)}; process.on('SIGTERM', () => {}); tryAcquire(${JSON.stringify(path.join(rig.dir, 'daemon.lock'))}); setInterval(() => {}, 1e6);`], { stdio: 'ignore', env: rig.env, detached });
    const h = await waitFor('the stubborn holder\'s lock', () => {
      const x = readHolder(path.join(rig.dir, 'daemon.lock'));
      return x && x !== 'unreadable' && x.pid === holder.pid ? x : null;
    });
    return { holder, h };
  }
  const killHolder = async (holder: ReturnType<typeof spawn>) => {
    holder.kill('SIGKILL');
    await waitFor('the holder to die', () => holder.exitCode !== null || holder.signalCode !== null);
  };

  it('a lock holder that will not exit on SIGTERM: install exits 1 naming its pid and the remedy; the unit is installed + enabled but not started', async () => {
    const { holder, h } = await stubbornHolder(true);
    try {
      const r = rig.cli(['install-unit']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`daemon pid ${h.pid} .*did not exit on SIGTERM`));
      assert.notEqual(sysctl('is-active', UNIT).stdout.trim(), 'active');
      assert.equal(isEnabled(), 'enabled');
    } finally {
      await killHolder(holder);
    }
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
  });

  it('a lock holder in the installer\'s own process group cannot be signalled: install says so (not "did not exit"), exit 1', async () => {
    const { holder, h } = await stubbornHolder(false);
    try {
      const r = rig.cli(['install-unit']);
      assert.equal(r.status, 1, r.stdout + r.stderr);
      assert.match(r.stderr, new RegExp(`daemon pid ${h.pid} .*may not signal it`));
    } finally {
      await killHolder(holder);
    }
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
  });

  it('a unit whose daemon cannot start (state dir is a regular file): install exits 1 saying it is not running, instead of "started"', () => {
    const notADir = path.join(rig.dir, 'a-file');
    fs.writeFileSync(notADir, 'x');
    const r = rig.cli(['install-unit'], { RESCTL_STATE_DIR: notADir });
    assert.equal(r.status, 1, r.stdout + r.stderr);
    assert.match(r.stderr, /right after start/);
    assert.equal(rig.cli(['uninstall-unit']).status, 0);
  });

  it('an XDG_CONFIG_HOME the manager does not search: the unit still lands where the manager looks (and uninstall finds it there)', () => {
    const x = fs.mkdtempSync(path.join(rig.dir, 'xdg-'));
    const r = rig.cli(['install-unit', '--no-start'], { XDG_CONFIG_HOME: x });
    assert.equal(r.status, 0, r.stdout + r.stderr);
    assert.equal(fs.existsSync(UNIT_FILE), true, 'written in the manager\'s own directory');
    assert.equal(fs.existsSync(path.join(x, 'systemd')), false, 'nothing under the unsearched XDG dir');
    assert.equal(isEnabled(), 'enabled');
    assert.equal(rig.cli(['uninstall-unit'], { XDG_CONFIG_HOME: x }).status, 0);
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
