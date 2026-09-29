import { test } from 'node:test'; import fs from 'node:fs'; import path from 'node:path'; import { execFileSync } from 'node:child_process';
const W = '/home/lmas/.orchestra/worktrees/orchestra-happy-river-03b66340';
const bus: any = await import(`${W}/src/main/bus.ts`); const runs: any = await import(`${W}/src/main/bus-runs.ts`);
const ON = { delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: false, receipts: false };
test('fence vs hold', (t) => {
  const home = fs.mkdtempSync('/home/lmas/rev-a4-scratch/home-'); t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = bus.openBus(path.join(home, 'bus.sqlite')); runs.startRun(db, { id: 'R', kind: 'vague', coordinator: 'ops-a' }, ON);
  bus.bumpCoordinatorGeneration(db, 'R'); bus.bumpCoordinatorGeneration(db, 'R'); console.log('FN current generation =', bus.coordinatorGeneration(db, 'R')); db.close();
  const cli = (args: string[]) => { try { return 'rc=0 ' + execFileSync(process.execPath, [`${W}/dist-electron/cli.js`, ...args], { encoding: 'utf8', env: { PATH: process.env.PATH!, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: path.join(home, 'no.sock'), ORCHESTRA_WS_ID: 'ops-a', ORCHESTRA_RUN_ID: 'R', ORCHESTRA_COORDINATOR_GENERATION: '1' }, stdio: ['ignore', 'pipe', 'pipe'] }).trim().slice(0, 140); } catch (e: any) { return `rc=${e.status} ` + ((e.stderr ?? '') + (e.stdout ?? '')).trim().slice(0, 160); } };
  const d0 = bus.openBus(path.join(home, 'bus.sqlite'));
  try { bus.fencedWrite(d0, { runId: 'R', verb: 'send', presented: 1, fencingOn: true, actor: 'ops-a' }, () => 'WROTE'); console.log('FN fencedWrite(stale coordinator) → NOT REJECTED'); } catch (e: any) { console.log('FN fencedWrite(stale coordinator, gen 1<2) → REJECTED:', e.name); }
  try { const r = bus.fencedWrite(d0, { runId: 'R', verb: 'send', presented: 1, fencingOn: true, actor: 'w-member' }, () => 'WROTE'); console.log('FN fencedWrite(member, same stale gen) →', r); } catch (e: any) { console.log('FN member REJECTED', e.name); }
  d0.close();
  console.log('FN stale coordinator (gen 1 < 2) hold  →', cli(['run', 'hold']));
  const d2 = bus.openBus(path.join(home, 'bus.sqlite')); console.log('FN held =', JSON.stringify([...runs.heldRunIds(d2)])); d2.close();
});
