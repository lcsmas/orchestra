import { test } from 'node:test';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';

const W = process.env.RV_W!;
const bus: any = await import(`${W}/src/main/bus.ts`);
const runs: any = await import(`${W}/src/main/bus-runs.ts`);
const SCR = '/home/lmas/rv-a4d/scratch';
fs.mkdirSync(SCR, { recursive: true });
const ON = { delivery: true, wake: true, askGate: true, liveness: true, fencing: true, capability: false, receipts: false };
const OFF = { ...ON, fencing: false };

function mk(t: any, seed: (db: any) => void) {
  const home = fs.mkdtempSync(path.join(SCR, 'home-'));
  t.after(() => fs.rmSync(home, { recursive: true, force: true }));
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  seed(db);
  db.close();
  return home;
}
function cli(home: string, args: string[], env: Record<string, string> = {}) {
  const e: Record<string, string> = { PATH: process.env.PATH!, HOME: home, ORCHESTRA_HOME: home, ORCHESTRA_SOCK: path.join(home, 'no.sock'), ...env };
  try {
    const out = execFileSync(process.execPath, [`${W}/dist-electron/cli.js`, ...args], { encoding: 'utf8', env: e, stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
    return `rc=0 ${out.trim().slice(0, 150)}`;
  } catch (x: any) {
    return `rc=${x.status} ${((x.stderr ?? '') + (x.stdout ?? '')).trim().slice(0, 260)}`;
  }
}
function state(home: string) {
  const db = bus.openBus(path.join(home, 'bus.sqlite'));
  const held = db.prepare('SELECT id, held_at IS NOT NULL AS h, held_by FROM runs ORDER BY id').all().map((r: any) => `${r.id}:${r.h ? 'HELD by ' + r.held_by : '-'}`);
  const fe = db.prepare('SELECT run_id, verb, presented, current, fired, actor FROM fence_events').all().map((r: any) => `${r.verb}/${r.actor}/p${r.presented}<c${r.current}/fired=${r.fired}`);
  db.close();
  return `held=${JSON.stringify(held)} fence_events=${JSON.stringify(fe)}`;
}

// ── D7 authorization ──
test('D7 matrix (built CLI, isolated bus)', (t) => {
  const home = mk(t, (db) => {
    runs.startRun(db, { id: 'LEAD', kind: 'mission', coordinator: 'lead' }, ON);
    runs.startRun(db, { id: 'OPS', kind: 'vague', coordinator: 'ops', parentRunId: 'LEAD' }, ON);
    runs.startRun(db, { id: 'OPS2', kind: 'vague', coordinator: 'ops2', parentRunId: 'LEAD' }, ON);
    runs.startRun(db, { id: 'ORPHAN-CHILD', kind: 'vague', coordinator: 'oc', parentRunId: 'GHOST-LEAD' }, ON); // parent has NO row
    runs.startRun(db, { id: 'STRAY', kind: 'mission', coordinator: 'stray' }, ON);
  });
  const P = (label: string, args: string[], env: Record<string, string>) => {
    console.log(`D7 ${label.padEnd(58)} → ${cli(home, args, env)}\n     ${state(home)}`);
  };
  P('coordinator ops holds OPS (control, must succeed)', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops' });
  P('resume OPS (ops)', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops' });
  P('member w holds OPS (must refuse)', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'w1' });
  P('member w --as OPS-UPPER-COORD (spoof; caller-asserted)', ['run', 'hold', '--run', 'OPS', '--as', 'OPS'], { ORCHESTRA_WS_ID: 'w1' });
  P('resume after spoof', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops' });
  P('SDK-session identity only ORCHESTRA_WS_ID_IDENTITY=ops', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID_IDENTITY: 'ops' });
  P('resume', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops' });
  P('sibling OPS2 holds OPS (must refuse)', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops2' });
  P('OPS holds LEAD (descendant → ancestor; must refuse)', ['run', 'hold', '--run', 'LEAD'], { ORCHESTRA_WS_ID: 'ops' });
  P('LEAD holds OPS (ancestor; must succeed)', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'lead' });
  P('LEAD resumes OPS', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'lead' });
  P('LEAD holds ITS OWN run', ['run', 'hold', '--run', 'LEAD'], { ORCHESTRA_WS_ID: 'lead' });
  P('LEAD resume own run', ['run', 'resume', '--run', 'LEAD'], { ORCHESTRA_WS_ID: 'lead' });
  P('LEAD holds ORPHAN-CHILD (parent GHOST-LEAD has no row; lead not ancestor)', ['run', 'hold', '--run', 'ORPHAN-CHILD'], { ORCHESTRA_WS_ID: 'lead' });
  P('"ghost-lead" (the dangling ancestor id) holds ORPHAN-CHILD', ['run', 'hold', '--run', 'ORPHAN-CHILD'], { ORCHESTRA_WS_ID: 'ghost-lead' });
  P('STRAY (unrelated mission coord) holds OPS', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'stray' });
  P('anonymous (no ws id) holds OPS', ['run', 'hold', '--run', 'OPS'], {});
  P('anonymous + --as   lead   (whitespace)', ['run', 'hold', '--run', 'OPS', '--as', '  lead  '], {});
  P('no-run id, coordinator identity', ['run', 'hold', '--run', 'nope'], { ORCHESTRA_WS_ID: 'ops' });
  P('resume OPS via lead (cleanup)', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'lead' });
  P('default --run = $ORCHESTRA_RUN_ID=OPS by ops (no --run)', ['run', 'hold'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_RUN_ID: 'OPS' });
  P('SAME but --run beats env: --run OPS2 by ops with env OPS', ['run', 'hold', '--run', 'OPS2'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_RUN_ID: 'OPS' });
});

// ── F7 fence ──
test('F7 matrix', (t) => {
  const home = mk(t, (db) => {
    runs.startRun(db, { id: 'LEAD', kind: 'mission', coordinator: 'lead' }, ON);
    runs.startRun(db, { id: 'OPS', kind: 'vague', coordinator: 'ops', parentRunId: 'LEAD' }, ON);
    runs.startRun(db, { id: 'OFFRUN', kind: 'vague', coordinator: 'offc', parentRunId: 'LEAD' }, OFF);
    bus.bumpCoordinatorGeneration(db, 'OPS'); bus.bumpCoordinatorGeneration(db, 'OPS'); // OPS gen = 2
    bus.bumpCoordinatorGeneration(db, 'LEAD'); bus.bumpCoordinatorGeneration(db, 'LEAD'); bus.bumpCoordinatorGeneration(db, 'LEAD'); // LEAD gen = 3
    bus.bumpCoordinatorGeneration(db, 'OFFRUN'); bus.bumpCoordinatorGeneration(db, 'OFFRUN');
  });
  const P = (label: string, args: string[], env: Record<string, string>) => {
    console.log(`F7 ${label.padEnd(66)} → ${cli(home, args, env)}\n     ${state(home)}`);
  };
  P('stale coordinator ops (gen 1 < 2) holds OPS (must reject)', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('legit coordinator after restart (gen 2 == 2) holds OPS', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: '2' });
  P('stale coordinator resumes (gen 1) (must reject)', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('coordinator w/ NO generation env (unfenced v1) resumes', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops' });
  P('coordinator --generation 1 flag beats env 2 (must reject)', ['run', 'hold', '--run', 'OPS', '--generation', '1'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: '2' });
  P('resume (clean)', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: '2' });
  P('ZOMBIE LEAD (own run gen 3, presents 1) holds child OPS', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'lead', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('ZOMBIE LEAD resumes child OPS', ['run', 'resume', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'lead', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('same zombie LEAD holds ITS OWN run LEAD (fenced?)', ['run', 'hold', '--run', 'LEAD'], { ORCHESTRA_WS_ID: 'lead', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('coordinator UPPERCASE --as OPS stale (case-fold; must reject)', ['run', 'hold', '--run', 'OPS', '--as', 'OPS'], { ORCHESTRA_WS_ID: 'x', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('fencing OFF run: stale coordinator offc holds (count, proceeds)', ['run', 'hold', '--run', 'OFFRUN'], { ORCHESTRA_WS_ID: 'offc', ORCHESTRA_COORDINATOR_GENERATION: '1' });
  P('garbage generation', ['run', 'hold', '--run', 'OPS'], { ORCHESTRA_WS_ID: 'ops', ORCHESTRA_COORDINATOR_GENERATION: 'abc' });
});
