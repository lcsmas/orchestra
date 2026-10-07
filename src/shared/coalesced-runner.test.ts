import { test } from 'node:test';
import assert from 'node:assert/strict';
import { coalescedRunner } from './coalesced-runner.ts';

const gate = () => {
  let open!: () => void;
  const p = new Promise<void>((r) => (open = r));
  return { p, open };
};
const tick = () => new Promise((r) => setImmediate(r));

test('a request runs the job once, and the runner is idle afterwards', async () => {
  let runs = 0;
  const r = coalescedRunner(async () => void (runs += 1), () => assert.fail('no error expected'));
  r.request();
  assert.equal(r.busy(), true);
  await tick();
  assert.equal(runs, 1);
  assert.equal(r.busy(), false);
  r.request(); // control: idle again → a fresh request runs
  await tick();
  assert.equal(runs, 2);
});

test('requests during a run never overlap it and fold into exactly ONE re-run', async () => {
  let runs = 0, active = 0, maxActive = 0;
  const gates = [gate(), gate()];
  const r = coalescedRunner(async () => {
    const g = gates[runs++];
    active += 1; maxActive = Math.max(maxActive, active);
    await g.p;
    active -= 1;
  }, () => {});
  r.request();
  await tick();
  r.request(); r.request(); r.request(); // three requests mid-run
  await tick();
  assert.equal(runs, 1, 'no second run while the first is in flight');
  gates[0].open();
  await tick(); await tick();
  assert.equal(runs, 2, 'exactly one owed re-run');
  gates[1].open();
  await tick(); await tick();
  assert.equal(runs, 2, 'and nothing after it');
  assert.equal(maxActive, 1);
  assert.equal(r.busy(), false);
});

test('a request mid-run is not lost: the re-run starts as soon as the run ends', async () => {
  const order: string[] = [];
  const g = gate();
  let n = 0;
  const r = coalescedRunner(async () => {
    const me = ++n;
    order.push(`start${me}`);
    if (me === 1) await g.p;
    order.push(`end${me}`);
  }, () => {});
  r.request();
  await tick();
  r.request();
  g.open();
  await tick(); await tick();
  assert.deepEqual(order, ['start1', 'end1', 'start2', 'end2']);
});

test('a throwing job is reported, does not wedge the runner, and a mid-run request still re-runs', async () => {
  const errors: unknown[] = [];
  let runs = 0;
  const g = gate();
  const r = coalescedRunner(async () => {
    runs += 1;
    if (runs === 1) { await g.p; throw new Error('boom'); }
  }, (e) => errors.push(e));
  r.request();
  await tick();
  r.request();
  g.open();
  await tick(); await tick();
  assert.equal(errors.length, 1);
  assert.equal(runs, 2);
  assert.equal(r.busy(), false);
  r.request(); // not wedged
  await tick();
  assert.equal(runs, 3);
});
