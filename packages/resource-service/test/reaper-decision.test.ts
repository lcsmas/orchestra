// The pure decision of the reaper (grace boundary, max life, purge) and one tick driven with an injected clock.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { after, describe, it } from 'node:test';
import { decide, tick } from '../src/reaper.ts';
import { readState, withState, type Run } from '../src/state.ts';

const O = { graceMs: 1000, keepMs: 5000 };
const run = (p: Partial<Run>): Run => ({ id: 'r', token: 't', owner: { pid: 999999, startTime: 1 }, state: 'alive', startedAt: 0, lanes: [], ...p });

describe('decide', () => {
  it('an alive run with a live owner is left alone; a dead owner starts the grace from now', () => {
    assert.deepEqual(decide(run({}), 100, true, O), { kind: 'none' });
    assert.deepEqual(decide(run({}), 100, false, O), { kind: 'enter-grace', graceEndsAt: 1100 });
  });

  it('the grace ends exactly at graceEndsAt: one ms before is none, at it is cleanup', () => {
    const r = run({ state: 'grace', graceEndsAt: 1000 });
    assert.deepEqual(decide(r, 999, false, O), { kind: 'none' });
    assert.deepEqual(decide(r, 1000, false, O), { kind: 'cleanup', reason: 'grace-expired' });
    assert.deepEqual(decide(r, 5000, false, O), { kind: 'cleanup', reason: 'grace-expired' });
  });

  it('max life cleans a run whose owner is alive, and one still in grace', () => {
    assert.deepEqual(decide(run({ maxLifeAt: 500 }), 499, true, O), { kind: 'none' });
    assert.deepEqual(decide(run({ maxLifeAt: 500 }), 500, true, O), { kind: 'cleanup', reason: 'max-life' });
    assert.deepEqual(decide(run({ state: 'grace', graceEndsAt: 9999, maxLifeAt: 500 }), 600, false, O), { kind: 'cleanup', reason: 'max-life' });
  });

  it('a cleaned run is kept for keepMs, then purged', () => {
    const r = run({ state: 'cleaned', cleanedAt: 1000 });
    assert.deepEqual(decide(r, 5999, false, O), { kind: 'none' });
    assert.deepEqual(decide(r, 6000, false, O), { kind: 'purge' });
  });
});

describe('tick', () => {
  const dir = fs.mkdtempSync(path.join(process.env.TMPDIR || os.tmpdir(), 'resctl-tick-'));
  after(() => fs.rmSync(dir, { recursive: true, force: true }));

  it('alive → grace → cleaned → purged along an injected clock', async () => {
    const env = { RESCTL_GRACE: '1s', RESCTL_KEEP: '5s', RESCTL_TERM_WAIT: '100ms' };
    const log = () => undefined;
    await withState((s) => void (s.runs.r = run({ id: 'r' })), dir); // owner pid 999999 / starttime 1: not a live process
    await tick(dir, env, log, 10_000);
    assert.equal(readState(dir).runs.r.state, 'grace');
    assert.equal(readState(dir).runs.r.graceEndsAt, 11_000);
    await tick(dir, env, log, 10_999);
    assert.equal(readState(dir).runs.r.state, 'grace', 'still in grace one ms before it ends');
    await tick(dir, env, log, 11_000);
    assert.equal(readState(dir).runs.r.state, 'cleaned');
    await tick(dir, env, log, 11_000 + 4_999);
    assert.ok(readState(dir).runs.r, 'kept until RESCTL_KEEP');
    await tick(dir, env, log, Date.now() + 10_000_000);
    assert.equal(readState(dir).runs.r, undefined, 'purged');
  });
});
