import { test } from 'node:test'; import fs from 'node:fs'; import path from 'node:path';
const W = '/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340/src'; const M = '/home/lmas/rev-a4-scratch/master-wt/src';
const cand: any = await import(`${W}/main/bus.ts`); const master: any = await import(`${M}/main/bus.ts`);
test('fc', () => {
  const dir = fs.mkdtempSync('/home/lmas/rev-a4-scratch/db-'); const f = path.join(dir, 'b.sqlite');
  const d = cand.openBus(f); const v = d.pragma('user_version', { simple: true }); d.close();
  try { const o = master.openBus(f); console.log('FC master-build opened a v' + v + ' DB'); o.close(); } catch (e: any) { console.log('FC master-build (v7) on candidate-created v' + v + ' DB → THROWS: ' + e.message); }
  fs.rmSync(dir, { recursive: true, force: true });
});
