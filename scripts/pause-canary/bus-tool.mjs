// Pause canary (#258) — the rig's ISOLATED bus (<H>/bus.sqlite), never the live one.
//   seed  <H> <TREE> [pause-off|wake-off]   create the LEAD (mission) + OPS (vague, parent LEAD) runs with every switch ON (a real wave's frozen flags + `pause`), using the modules of TREE (the source tree matching the app under drive)
//   serve <H> <TREE>                        persistent read-only SQL server: one JSON line {id,sql,args} in → {id,rows|err} out (the drive polls at 250 ms; a node spawn per poll would skew the timings)
import path from 'node:path';
import fs from 'node:fs';
import readline from 'node:readline';
import { uid } from './ids.mjs';

const [cmd, H, TREE, ...rest] = process.argv.slice(2);
// the rig home must sit under the scratch base the runner declared and never be (or contain) the live bus
const BASE = process.env.PC_BASE ?? '';
if (!H || !BASE || !(path.resolve(H) + path.sep).startsWith(path.resolve(BASE) + path.sep) || /bus\.sqlite$/.test(H) || path.resolve(H) === path.join(process.env.HOME ?? '', '.orchestra')) {
  console.error('bus-tool: refusing a non-scratch home', H, 'base', BASE);
  process.exit(97);
}
const bus = await import(`${TREE}/src/main/bus.ts`);
const dbFile = path.join(H, 'bus.sqlite');

if (cmd === 'seed') {
  const { startRun } = await import(`${TREE}/src/main/bus-runs.ts`);
  const { DEFAULT_BUS_SWITCHES, BUS_MECHANISMS } = await import(`${TREE}/src/shared/bus-switches.ts`);
  const db = bus.openBus(dbFile, {});
  try {
    const all = Object.fromEntries(BUS_MECHANISMS.map((m) => [m, true]));
    if (rest[0] === 'pause-off') all.pause = false;   // the must-FAIL control arm: the same drive with the switch OFF
    if (rest[0] === 'wake-off') all.wake = false;
    const sw = { ...DEFAULT_BUS_SWITCHES, ...all };
    startRun(db, { id: uid(1), kind: 'mission', coordinator: uid(1) }, sw);
    startRun(db, { id: uid(2), kind: 'vague', coordinator: uid(2), parentRunId: uid(1) }, sw);
    console.log(JSON.stringify({ seeded: [uid(1), uid(2)], schema: db.pragma('user_version', { simple: true }), switches: BUS_MECHANISMS.map((m) => `${m}=${all[m]}`).join(',') }));
  } finally { db.close(); }
} else if (cmd === 'serve') {
  let db = null;
  const rl = readline.createInterface({ input: process.stdin });
  for await (const line of rl) {
    let req;
    try { req = JSON.parse(line); } catch { continue; }
    try {
      if (!db) { if (!fs.existsSync(dbFile)) throw new Error('no bus yet'); db = bus.open(dbFile, { readonly: true }); }
      const rows = db.prepare(req.sql).all(...(req.args ?? []));
      process.stdout.write(`${JSON.stringify({ id: req.id, rows })}\n`);
    } catch (e) {
      process.stdout.write(`${JSON.stringify({ id: req.id, err: String(e.message ?? e).slice(0, 200) })}\n`);
    }
  }
  try { db?.close(); } catch { /* */ }
} else {
  console.error(`bus-tool: unknown command ${cmd}`);
  process.exit(2);
}
