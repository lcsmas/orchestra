// daemon.lock: a second `serve` is refused while the holder lives; a stale lock (dead holder, or its pid reused by another process) is
// stolen — ONLY after the identity probe fails.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { within, Rig, identityOf, isAlive, waitFor } from './lib/rig.ts';
import { readHolder } from '../src/lockfile.ts';

describe('daemon lock', () => {
  const rig = new Rig({ grace: '10m' });
  const lockPath = path.join(rig.dir, 'daemon.lock');
  const write = (id: { pid: number; startTime: number }) => fs.writeFileSync(lockPath, JSON.stringify(id) + '\n');
  after(async () => {
    assert.deepEqual(await rig.dispose(), []);
  });

  it('a lock held by a LIVE process is not stolen: serve exits 3 and the file is untouched', async () => {
    const holder = rig.coordinator();
    const id = identityOf(holder.pid)!;
    write(id);
    const d = rig.startDaemon();
    assert.equal((await within('serve exits', d.exited)).code, 3, d.stderr());
    assert.match(d.stderr(), /already running/);
    assert.deepEqual(readHolder(lockPath), id);
    await holder.kill();
  });

  it('a lock whose holder is dead is stolen; a second serve is then refused; the lock is released on SIGTERM', async () => {
    const dead = rig.coordinator();
    const id = identityOf(dead.pid)!;
    await dead.kill();
    assert.ok(!isAlive(id));
    write(id);
    const d = rig.startDaemon();
    const mine = await waitFor('serve to take the lock', () => {
      const h = readHolder(lockPath);
      return h && h !== 'unreadable' && h.pid === d.child.pid && h;
    });
    assert.deepEqual(mine, identityOf(d.child.pid!));
    const second = rig.startDaemon();
    assert.equal((await within('second serve exits', second.exited)).code, 3);
    assert.ok(isAlive(mine), 'the first daemon must survive the refused second one');
    d.child.kill('SIGTERM');
    assert.equal((await within('serve exits', d.exited)).code, 0);
    assert.equal(readHolder(lockPath), null, 'the lock file is removed on a clean stop');
  });

  it('a lock naming a live pid with ANOTHER starttime (pid reuse) is stale and stolen', async () => {
    const other = rig.coordinator();
    const real = identityOf(other.pid)!;
    write({ pid: real.pid, startTime: real.startTime + 1 });
    const d = rig.startDaemon();
    await waitFor('serve to steal the reused-pid lock', () => {
      const h = readHolder(lockPath);
      return h && h !== 'unreadable' && h.pid === d.child.pid;
    });
    assert.ok(isAlive(real), 'the innocent process whose pid the lock named must not be touched');
    d.child.kill('SIGTERM');
    await within('serve exits', d.exited);
  });
});
