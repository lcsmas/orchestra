import { test } from 'node:test';
import fs from 'node:fs'; import path from 'node:path';
const W = process.env.RV_W + '/src';
const bus: any = await import(`${W}/main/bus.ts`); const runs: any = await import(`${W}/main/bus-runs.ts`);
const ON = { delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: true, receipts: true };
test('M4 control', (t) => {
  const dir = fs.mkdtempSync('/home/lmas/rv-a4d/scratch/db-'); const db = bus.openBus(path.join(dir, 'b.sqlite')); t.after(() => { db.close(); fs.rmSync(dir, { recursive: true, force: true }); });
  runs.startRun(db, { id: 'a', kind: 'vague', coordinator: 'oa' }, ON); runs.startRun(db, { id: 'b', kind: 'vague', coordinator: 'ob' }, ON);
  runs.setRunHold(db, 'a', true, 'oa'); runs.setRunHold(db, 'b', true, 'ob'); runs.setRunHold(db, 'a', false, 'oa');
  console.log('M4 held after resume(a) =', JSON.stringify([...runs.heldRunIds(db)]), '(want ["b"])');
});
