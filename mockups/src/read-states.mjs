// read-states.mjs — seed one scratch bus per state with the SHIPPED writers and read it back with the SHIPPED readers → states.json (what the mockups render)
import { buildWorld, seedBus, SCRATCH, TREE, IDS, NAMES } from './world.mjs';
import fs from 'node:fs';
import path from 'node:path';
const w = buildWorld('states');
const out = { names: Object.fromEntries(Object.entries(IDS).map(([k, v]) => [v, NAMES[k]])), ids: IDS, states: {} };
for (const state of ['idle', 'douce', 'dure', 'escalated', 'resuming']) {
  for (const f of ['bus.sqlite', 'bus.sqlite-wal', 'bus.sqlite-shm']) fs.rmSync(path.join(w.H, f), { force: true });
  const info = seedBus(w.H, state);
  const reader = `
    const bus = await import('${TREE}/src/main/bus.ts'); const d = await import('${TREE}/src/main/pause-douce.ts'); const r = await import('${TREE}/src/main/pause-reprise.ts'); const rec = await import('${TREE}/src/main/bus-pause-records.ts');
    const db = bus.openBus('${w.H}/bus.sqlite', {});
    const lead = '${IDS.lead}';
    const status = d.pauseStatusView(db, lead);
    const reprise = r.repriseStatusView(db, lead);
    const cols = db.prepare('SELECT paused_at, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at, paused_by FROM runs WHERE id = ?').get(lead);
    const bilan = status ? rec.listBilan(db, lead, status.pausedAt) : [];
    console.log(JSON.stringify({ status, reprise, cols, bilan }));
    db.close();`;
  fs.writeFileSync(path.join(SCRATCH, '_reader.mjs'), reader);
  const { execFileSync } = await import('node:child_process');
  const txt = execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(SCRATCH, '_reader.mjs')], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(w.H, 'home') } });
  out.states[state] = JSON.parse(txt.split('\n').filter((l) => l.startsWith('{')).pop());
  console.log(state, JSON.stringify(info), out.states[state].status?.summary ?? null, out.states[state].reprise ? `reprise ${out.states[state].reprise.done}/${out.states[state].reprise.total} released ${out.states[state].reprise.released} blocked ${out.states[state].reprise.blocked.length}` : '');
}
fs.writeFileSync(path.join(SCRATCH, 'states.json'), JSON.stringify(out, null, 1));
console.log('wrote states.json');
