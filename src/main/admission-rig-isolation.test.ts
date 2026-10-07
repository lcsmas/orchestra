// #287 follow-up F3 (ledger #295): concurrent rig drivers (sweep + gate + reviewer) must not share scratch dirs nor overlap their timing-sensitive arms.
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { RIG_LOCK_TIMEOUT_RC, armScratch, flockAvailable, lockedArgv, newRigRunId, pruneOldRuns, rigRunId } from '../../scripts/rig-isolation.mjs';

const scratch = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'admission-rig-isolation-test-'));
test.after(() => fs.rmSync(scratch, { recursive: true, force: true }));

test('R1 scratch: two driver runs never share an arm dir; an arm run by hand is "solo"', () => {
  const a = newRigRunId();
  const b = newRigRunId();
  assert.notEqual(a, b);
  assert.notEqual(armScratch('/base', a, 'human_passes'), armScratch('/base', b, 'human_passes'), 'the same arm of two concurrent drivers has two dirs (the collision that read 16/17)');
  assert.equal(armScratch('/base', 'r1', 'x'), path.join('/base', 'r1', 'x'));
  assert.equal(rigRunId({}), 'solo');
  assert.equal(rigRunId({ RIG_RUN_ID: 'r9' }), 'r9');
});

test('R2 lockedArgv: wraps the command in ONE flock with a bounded wait and a distinct timeout status; bare command when flock is absent', () => {
  const lock = path.join(scratch, 'argv.lock');
  assert.deepEqual(lockedArgv('node', ['a', 'b'], { lockPath: lock, waitS: 5, hasFlock: true }), ['flock', '-w', '5', '-E', String(RIG_LOCK_TIMEOUT_RC), lock, 'node', 'a', 'b']);
  assert.deepEqual(lockedArgv('node', ['a'], { lockPath: lock, waitS: 5, hasFlock: false }), ['node', 'a']);
});

/** Two 300 ms "arms" started at the same moment, each logging start/end into one file; returns the log order. */
async function raceTwoArms(wrap: boolean): Promise<string[]> {
  const log = path.join(scratch, `race-${wrap ? 'locked' : 'bare'}.log`);
  fs.rmSync(log, { force: true });
  const lock = path.join(scratch, 'race.lock');
  const script = (n: string) => `echo start-${n} >> ${log}; sleep 0.3; echo end-${n} >> ${log}`;
  const run = (n: string) => {
    const argv = wrap ? lockedArgv('sh', ['-c', script(n)], { lockPath: lock, waitS: 20, hasFlock: true }) : ['sh', '-c', script(n)];
    return new Promise<void>((resolve) => spawn(argv[0], argv.slice(1), { stdio: 'ignore' }).on('close', () => resolve()));
  };
  await Promise.all([run('A'), run('B')]);
  return fs.readFileSync(log, 'utf8').trim().split('\n');
}

test('R3 the lock really serialises arms: locked → start/end/start/end; the bare control interleaves (the instrument can see an overlap)', async () => {
  if (!flockAvailable()) {
    assert.deepEqual(lockedArgv('x', []), ['x'], 'no flock(1): the wrapper degrades to the bare command (scratch is still per-run)');
    return;
  }
  const locked = await raceTwoArms(true);
  assert.match(locked[0], /^start-/);
  assert.equal(locked[1], locked[0].replace('start', 'end'), `the first arm ends before the second starts: ${locked.join(',')}`);
  const bare = await raceTwoArms(false);
  assert.match(bare[1], /^start-/, `control: without the lock the second arm starts before the first ends: ${bare.join(',')}`);
});

test('R4 pruneOldRuns removes only stale run dirs, never a fresh one, never throws on a missing base', () => {
  const base = path.join(scratch, 'prune');
  fs.mkdirSync(path.join(base, 'old'), { recursive: true });
  fs.mkdirSync(path.join(base, 'fresh'), { recursive: true });
  const t = Date.now() - 3 * 24 * 3600 * 1000;
  fs.utimesSync(path.join(base, 'old'), new Date(t), new Date(t));
  pruneOldRuns(base);
  assert.deepEqual(fs.readdirSync(base).sort(), ['fresh']);
  pruneOldRuns(path.join(scratch, 'does-not-exist'));
});
