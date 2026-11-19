// endRun vs an `exec` that registers a lane while the cleanup steps run: the run must not be marked cleaned with that lane still alive.
// The race is injected deterministically as an extra cleanup step that behaves like a late exec (spawns a marked process, records its lane).
import assert from 'node:assert/strict';
import { spawn } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { CLEANUP_STEPS, endRun, type CleanupStep } from '../src/cleanup.ts';
import { identityOf, isAlive, sleep, type Identity } from '../src/proc.ts';
import { readState, withState } from '../src/state.ts';

describe('end vs a late lane', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-race-'));
  const victims: number[] = [];
  after(() => {
    for (const pid of victims) {
      try {
        process.kill(pid, 'SIGKILL');
      } catch {
        /* gone */
      }
    }
    fs.rmSync(dir, { recursive: true, force: true });
  });

  it('a lane registered mid-cleanup is cleaned before the run is marked cleaned', async () => {
    const token = 'race-token-' + process.pid;
    const owner = identityOf(process.pid)!;
    await withState((s) => void (s.runs.race = { id: 'race', token, owner, state: 'alive', startedAt: Date.now(), lanes: [] }), dir);
    let late: Identity | null = null;
    const lateExec: CleanupStep = {
      name: 'test-late-exec',
      run: async () => {
        if (late) return; // only the first round
        const c = spawn('sleep', ['300'], { detached: true, stdio: 'ignore', env: { ...process.env, RESCTL_RUN_TOKEN: token } });
        c.unref();
        victims.push(c.pid!);
        const id = identityOf(c.pid!)!;
        late = id;
        await withState((s) => void s.runs.race.lanes.push({ pid: id.pid, pgid: id.pid, startTime: id.startTime, cmd: ['sleep', '300'], startedAt: Date.now() }), dir);
      },
    };
    CLEANUP_STEPS.push(lateExec);
    try {
      const failures = await endRun(dir, JSON.parse(JSON.stringify(readState(dir).runs.race)), { env: { RESCTL_TERM_WAIT: '200ms' } });
      assert.deepEqual(failures, []);
    } finally {
      CLEANUP_STEPS.splice(CLEANUP_STEPS.indexOf(lateExec), 1);
    }
    const id = late as Identity | null;
    assert.ok(id, 'instrument check: the late lane was started');
    for (let i = 0; i < 50 && isAlive(id); i++) await sleep(20);
    assert.ok(!isAlive(id), 'the lane that registered during the cleanup survived and the run reads as cleaned');
    assert.equal(readState(dir).runs.race.state, 'cleaned');
  });
});
