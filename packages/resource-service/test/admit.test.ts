// The real CLI seam of `resctl admit`: a threshold above the free value waits and says why; lowering it releases; defaults on this machine return at once.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { parseMemAvailable } from '../src/admission.ts';
import { sleep } from '../src/proc.ts';
import { BIN, Rig, waitFor, within } from './lib/rig.ts';

const HUGE = '100T'; // far above any free value of any machine this runs on

describe('resctl admit (CLI)', () => {
  const rig = new Rig({ env: { RESCTL_ADMIT_POLL: '100ms', RESCTL_ADMIT_REPORT: '10m' } });
  after(async () => assert.deepEqual(await rig.dispose(), []));
  /** Like rig.cli but bounded to 8 s: a verb that never gives up must turn a test RED quickly. */
  const cli = (args: string[], env: NodeJS.ProcessEnv = {}) => {
    const r = spawnSync(process.execPath, [BIN, ...args], { env: { ...rig.env, ...env }, encoding: 'utf8', timeout: 8000 });
    return { status: r.status, stdout: r.stdout, stderr: r.stderr };
  };
  const conf = (text: string) => fs.writeFileSync(path.join(rig.dir, 'admit.conf'), text);

  it('memory threshold above the free value: it WAITS and prints what for; lowering the threshold (admit.conf) releases it', async () => {
    const a = rig.spawnCli(['admit'], { RESCTL_MIN_FREE_MEM: HUGE, RESCTL_MIN_FREE_DISK: '1M' });
    await waitFor('the waiting line', () => /waiting for free memory: [\d.]+[KMGT] < 100T \(since \d{4}-\d\d-\d\dT[\d:.]+Z, \d+s elapsed\)/.test(a.stderr()));
    await sleep(600);
    assert.equal(a.child.exitCode, null, 'still waiting 600 ms later, the poll saw the same short value');
    assert.equal(a.stderr().match(/waiting for/g)?.length, 1, 'said once, not at every 100 ms poll');
    assert.doesNotMatch(a.stderr(), /free disk/);
    conf('# lower it\nRESCTL_MIN_FREE_MEM=1M\n');
    const { code } = await within('admit to return after the threshold was lowered', a.exited, 5000);
    assert.equal(code, 0);
    fs.rmSync(path.join(rig.dir, 'admit.conf')); // it overrides the env of every later test
  });

  it('disk threshold above the free value: it waits for DISK only, and --timeout gives up with exit 3 naming it', () => {
    const r = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_DISK: HUGE });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /waiting for free disk: [\d.]+[KMGT] < 100T/);
    assert.match(r.stderr, /timed out after \d+s waiting for free disk: [\d.]+[KMGT] < 100T/);
    assert.doesNotMatch(r.stderr, /free memory/);
  });

  it('both thresholds above: it names both', () => {
    const r = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: HUGE, RESCTL_MIN_FREE_DISK: HUGE });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /waiting for free memory: [\d.]+[KMGT] < 100T; free disk: [\d.]+[KMGT] < 100T/);
  });

  it('--timeout 0 looks once: a short machine is refused at once, an admitted one passes', () => {
    const t0 = Date.now();
    assert.equal(cli(['admit', '--timeout', '0'], { RESCTL_MIN_FREE_MEM: HUGE }).status, 3);
    assert.ok(Date.now() - t0 < 3000);
    assert.equal(cli(['admit', '--timeout', '0'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' }).status, 0);
  });

  it('thresholds low enough: returns at once, prints what it measured, exit 0', () => {
    const t0 = Date.now();
    const r = cli(['admit'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' });
    assert.equal(r.status, 0);
    assert.match(r.stdout, /^admitted: free memory [\d.]+[MGT] >= 1M, free disk [\d.]+[MGT] >= 1M \(/);
    assert.equal(r.stderr, '', 'no waiting line when nothing waited');
    assert.ok(Date.now() - t0 < 5000);
  });

  it('DEFAULT thresholds (6G / 10GiB): returns at once when this machine has that much free, waits (and says so) when it has not', () => {
    const free = () => ({ mem: parseMemAvailable(fs.readFileSync('/proc/meminfo', 'utf8')), disk: Number(fs.statfsSync(os.homedir()).bavail) * Number(fs.statfsSync(os.homedir()).bsize) });
    const before = free();
    const r = cli(['admit', '--timeout', '500ms'], { RESCTL_MIN_FREE_MEM: '', RESCTL_MIN_FREE_DISK: '' });
    const after = free();
    const hi = (f: { mem: number; disk: number }, op: (a: number, b: number) => boolean) => op(f.mem, 6 * 1024 ** 3) && op(f.disk, 10 * 1024 ** 3);
    if (hi(before, (a, b) => a > b * 1.05) && hi(after, (a, b) => a > b * 1.05)) {
      assert.equal(r.status, 0, `comfortably above both defaults (mem ${before.mem}, disk ${before.disk}): ${r.stderr}`);
      assert.match(r.stdout, /^admitted: free memory [\d.]+G >= 6G, free disk [\d.]+[KMGT] >= 10G/);
    } else if (!hi(before, (a, b) => a >= b) && !hi(after, (a, b) => a >= b)) {
      assert.equal(r.status, 3, 'below a default: it waited');
      assert.match(r.stderr, /waiting for free (memory|disk): [\d.]+[MGT] < (6|10)G/);
    } else {
      // within 5% of a default, or crossing it during the run: either answer is honest, but it must be ONE coherent answer
      assert.ok(r.status === 0 || r.status === 3, `exit ${r.status}: ${r.stderr}`);
      if (r.status === 0) assert.match(r.stdout, /^admitted/);
      else assert.match(r.stderr, /timed out after \d+s waiting for free (memory|disk): /);
    }
  });

  it('the free disk it prints is statfs bavail x bsize of the measured path (units pinned)', () => {
    const st = fs.statfsSync(os.homedir());
    const expected = Number(st.bavail) * Number(st.bsize);
    const r = cli(['admit'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' });
    const m = /free disk ([\d.]+)([KMGT])/.exec(r.stdout);
    assert.ok(m, r.stdout);
    const printed = Number(m[1]) * 1024 ** ('KMGT'.indexOf(m[2]) + 1);
    assert.ok(Math.abs(printed - expected) <= Math.max(expected * 0.02, 0.2 * 1024 ** ('KMGT'.indexOf(m[2]) + 1)), `printed ${printed} vs statfs ${expected}`);
  });

  it('measures the filesystem of the home dir by default (NOT the state dir, which may be a tmpfs), or RESCTL_DISK_PATH when set', () => {
    const low = { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' };
    assert.ok(cli(['admit'], low).stdout.endsWith(`(${os.homedir()})\n`), 'the state dir is the rig dir, the measured path must not be');
    const other = os.tmpdir();
    assert.ok(cli(['admit'], { ...low, RESCTL_DISK_PATH: other }).stdout.endsWith(`(${other})\n`));
    assert.equal(cli(['admit'], { ...low, RESCTL_DISK_PATH: path.join(rig.dir, 'nope') }).status, 2, 'an explicit path that does not exist is a usage error');
  });

  it('a threshold that admit.conf set is NAMED in the waiting, timeout and admitted lines (a file never overrides the env silently)', () => {
    try {
      conf('RESCTL_MIN_FREE_MEM=100T\n');
      const w = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' });
      assert.equal(w.status, 3, 'the file overrode the env value');
      assert.match(w.stderr, /waiting for free memory: [\d.]+[KMGT] < 100T \(admit\.conf\)/);
      assert.match(w.stderr, /timed out after \d+s waiting for free memory: [\d.]+[KMGT] < 100T \(admit\.conf\)/);
      conf('RESCTL_MIN_FREE_DISK=1M\n');
      conf('RESCTL_MIN_FREE_DISK=100T\n');
      const d = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' });
      assert.equal(d.status, 3);
      assert.match(d.stderr, /waiting for free disk: [\d.]+[KMGT] < 100T \(admit\.conf\)/);
      assert.doesNotMatch(d.stderr, /free memory/);
      conf('RESCTL_MIN_FREE_DISK=1M\n');
      const ok = cli(['admit'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '100T' });
      assert.equal(ok.status, 0);
      assert.match(ok.stdout, /^admitted: free memory [\d.]+[KMGT] >= 1M, free disk [\d.]+[KMGT] >= 1M \(admit\.conf\) \(/, 'the disk bound came from the file, the memory bound from the env');
      fs.rmSync(path.join(rig.dir, 'admit.conf'));
      assert.doesNotMatch(cli(['admit'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' }).stdout, /admit\.conf/);
    } finally {
      fs.rmSync(path.join(rig.dir, 'admit.conf'), { force: true });
    }
  });

  it('a torn admit.conf (no final newline) and an unreadable one do NOT lower anything: the env value stays and it warns', () => {
    conf('RESCTL_MIN_FREE_MEM=1'); // what a reader sees mid-write of "…=10G"
    const torn = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: HUGE });
    assert.equal(torn.status, 3, 'a torn line must not admit');
    assert.match(torn.stderr, /admit\.conf: last line has no newline, ignored/);
    fs.rmSync(path.join(rig.dir, 'admit.conf'));
    fs.mkdirSync(path.join(rig.dir, 'admit.conf')); // EISDIR: readable by nobody
    const bad = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: HUGE });
    assert.equal(bad.status, 3);
    assert.match(bad.stderr, /admit\.conf: cannot read it \(EISDIR\)/);
    fs.rmdirSync(path.join(rig.dir, 'admit.conf'));
    assert.doesNotMatch(cli(['admit', '--timeout', '0'], { RESCTL_MIN_FREE_MEM: '1M', RESCTL_MIN_FREE_DISK: '1M' }).stderr, /admit\.conf/, 'a missing file is silent');
  });

  it('bad input: unusable thresholds / timeout / argument exit 2, an unusable admit.conf value is ignored with a warning (the env value stays)', () => {
    assert.equal(cli(['admit'], { RESCTL_MIN_FREE_MEM: 'lots' }).status, 2);
    assert.equal(cli(['admit', '--timeout', 'soon']).status, 2);
    assert.equal(cli(['admit', 'now']).status, 2);
    conf('RESCTL_MIN_FREE_MEM=1G # trailing comment\nRESCTL_MIN_FREE_MEM=lots\n');
    const r = cli(['admit', '--timeout', '300ms'], { RESCTL_MIN_FREE_MEM: HUGE });
    assert.equal(r.status, 3);
    assert.match(r.stderr, /admit\.conf: invalid size: "lots" \(ignored\)/);
    assert.match(r.stderr, /admit\.conf: unreadable line "RESCTL_MIN_FREE_MEM=1G # trailing comment"/);
    fs.rmSync(path.join(rig.dir, 'admit.conf'));
  });
});
