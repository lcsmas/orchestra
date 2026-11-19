// State records can outlive what they describe: after a reboot, or when a lane's group is gone. Neither may ever be signalled later.
import assert from 'node:assert/strict';
import { spawn, type ChildProcess } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { tick } from '../src/reaper.ts';
import { bootId, identityOf, isAlive, sleep, type Identity } from '../src/proc.ts';
import { readState, stateFile, withState, type Lane, type Run } from '../src/state.ts';

const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-stale-'));
const kids: ChildProcess[] = [];
after(() => {
  kids.forEach((k) => k.kill('SIGKILL'));
  fs.rmSync(dir, { recursive: true, force: true });
});
const env = { RESCTL_GRACE: '0s', RESCTL_KEEP: '1h', RESCTL_TERM_WAIT: '200ms' };
const noLog = () => undefined;
const leader = (): { id: Identity; lane: Lane } => {
  const c = spawn('sleep', ['300'], { detached: true, stdio: 'ignore' });
  kids.push(c);
  const id = identityOf(c.pid!)!;
  return { id, lane: { pid: id.pid, pgid: id.pid, startTime: id.startTime, cmd: ['sleep', '300'], startedAt: 0 } };
};
const run = (id: string, lanes: Lane[], extra: Partial<Run> = {}): Run => ({ id, token: 'tok-' + id, owner: { pid: 999999, startTime: 1 }, state: 'alive', startedAt: 0, lanes, ...extra });

describe('stale records', () => {
  it('a state file from another boot closes its runs and never signals their lanes', async () => {
    const l = leader(); // looks exactly like a recorded lane of the old boot: same pid, same starttime, own group
    fs.writeFileSync(stateFile(dir), JSON.stringify({ version: 1, bootId: 'a-previous-boot', runs: { old: run('old', [l.lane]) } }));
    await tick(dir, env, noLog, 1000); // owner dead: the grace is 0, so without the boot check this tick pair kills the lane
    await tick(dir, env, noLog, 1001);
    const s = readState(dir);
    assert.equal(s.runs.old.state, 'cleaned');
    assert.deepEqual(s.runs.old.lanes, []);
    assert.equal(s.bootId, bootId());
    assert.ok(isAlive(l.id), 'a lane recorded in another boot was signalled');
  });

  it('a lane whose group is gone is dropped from the record; a live one is kept', async () => {
    const dead = leader();
    const live = leader();
    await withState((s) => void (s.runs.mix = run('mix', [dead.lane, live.lane], { owner: identityOf(process.pid)! })), dir);
    process.kill(dead.id.pid, 'SIGKILL');
    for (let i = 0; i < 100 && isAlive(dead.id); i++) await sleep(20);
    await tick(dir, env, noLog, Date.now());
    assert.deepEqual(readState(dir).runs.mix.lanes.map((x) => x.pid), [live.id.pid]);
    assert.ok(isAlive(live.id));
  });
});
