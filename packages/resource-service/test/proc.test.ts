// Signalling safety: identity re-read at signal time, never pid <= 1, never the caller's own group. Negative arms use SIGCONT (harmless
// even if a guard is broken); the positive arm uses SIGTERM on a child the test spawned in its own group.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import { after, describe, it } from 'node:test';
import { groupIsOurs, identityOf, isAlive, ownPgid, readStat, signalGroupIfOurs, signalIfSame, sleep } from '../src/proc.ts';

const kids: ChildProcess[] = [];
const child = (detached: boolean): ChildProcess => {
  const c = spawn('sleep', ['300'], { stdio: 'ignore', detached });
  kids.push(c);
  return c;
};
after(() => kids.forEach((k) => k.kill('SIGKILL')));
const waitGone = async (id: { pid: number; startTime: number }): Promise<boolean> => {
  for (let i = 0; i < 100; i++) {
    if (!isAlive(id)) return true;
    await sleep(20);
  }
  return false;
};

describe('proc identity and signals', () => {
  it('readStat reads pid, state and a stable starttime; an absent pid is null', () => {
    const me = readStat(process.pid)!;
    assert.equal(me.pid, process.pid);
    assert.equal(readStat(process.pid)!.startTime, me.startTime);
    assert.equal(readStat(2 ** 22 + 12345), null);
  });

  it('isAlive: same pid with another starttime is NOT the same process; a killed child is gone', async () => {
    const c = child(true);
    const id = identityOf(c.pid!)!;
    assert.ok(isAlive(id));
    assert.ok(!isAlive({ pid: id.pid, startTime: id.startTime + 1 }), 'pid reuse (other starttime) must not count as alive');
    c.kill('SIGKILL');
    assert.ok(await waitGone(id));
  });

  it('signalIfSame: wrong starttime sends nothing; right identity delivers', async () => {
    const c = child(true);
    const id = identityOf(c.pid!)!;
    assert.equal(signalIfSame({ pid: id.pid, startTime: id.startTime + 1 }, 'SIGTERM'), 'gone');
    await sleep(100);
    assert.ok(isAlive(id), 'a signal went to a process with another identity');
    assert.equal(signalIfSame(id, 'SIGTERM'), 'sent');
    assert.ok(await waitGone(id));
  });

  it('signalIfSame refuses pid 1, itself, and anything in its own process group', () => {
    const init = identityOf(1)!;
    assert.equal(signalIfSame(init, 'SIGCONT'), 'refused');
    assert.equal(signalIfSame(identityOf(process.pid)!, 'SIGCONT'), 'refused');
    const sameGroup = child(false); // a child of the test: same process group as the caller
    assert.equal(readStat(sameGroup.pid!)!.pgrp, ownPgid());
    assert.equal(signalIfSame(identityOf(sameGroup.pid!)!, 'SIGCONT'), 'refused');
    assert.ok(isAlive(identityOf(sameGroup.pid!)!));
  });

  it('signalGroupIfOurs: a reused leader pid is foreign (refused), the real leader\'s group is signalled, own group and pid <= 1 are refused', async () => {
    const leader = child(true); // detached = own session and group
    const id = identityOf(leader.pid!)!;
    assert.equal(groupIsOurs(id), 'ours');
    assert.equal(signalGroupIfOurs({ pid: id.pid, startTime: id.startTime + 1 }, 'SIGTERM'), 'refused');
    await sleep(100);
    assert.ok(isAlive(id), 'a group was signalled through a reused leader pid');
    assert.equal(signalGroupIfOurs({ pid: ownPgid(), startTime: 0 }, 'SIGCONT'), 'refused');
    assert.equal(signalGroupIfOurs({ pid: 1, startTime: 0 }, 'SIGCONT'), 'refused');
    assert.equal(signalGroupIfOurs(id, 'SIGTERM'), 'sent');
    assert.ok(await waitGone(id));
  });
});
