// seed-bus.mjs <H> <mode> — seed / read the rig's ISOLATED bus.sqlite (<H>/bus.sqlite) with the SHIPPED modules of THIS tree. Plain node (ABI 127 copy).
//   seed  : lead (mission) ⊃ ops (vague), legacy (mission, `pause` switch OFF) — frozen flags like a real wave start
//   read  : prints {runs, roster, bilan, messages} as one JSON line (what the drive asserts against)
//   sql   : <query> [args…] → rows
import path from 'node:path';
import fs from 'node:fs';
import { fileURLToPath } from 'node:url';
const [H, cmd, ...rest] = process.argv.slice(2);
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
if (!H || /\/\.orchestra\/bus\.sqlite$/.test(H) || path.resolve(H) === path.join(process.env.HOME ?? '', '.orchestra')) { console.error('seed-bus: refusing the live orchestra home', H); process.exit(97); }
if (!fs.existsSync(path.join(H, 'userData/orchestra/store.json'))) { console.error('seed-bus: not a rig home (no store.json)', H); process.exit(97); }
const bus = await import(`${TREE}/src/main/bus.ts`);
const runs = await import(`${TREE}/src/main/bus-runs.ts`);
const { DEFAULT_BUS_SWITCHES, BUS_MECHANISMS } = await import(`${TREE}/src/shared/bus-switches.ts`);
const store = JSON.parse(fs.readFileSync(path.join(H, 'userData/orchestra/store.json'), 'utf8'));
const idOf = (name) => store.workspaces.find((w) => w.name === name)?.id;
const db = bus.openBus(path.join(H, 'bus.sqlite'), {});
try {
  if (cmd === 'seed') {
    const ON = Object.fromEntries(BUS_MECHANISMS.map((m) => [m, true]));
    // `wake` OFF on the waves: the rig's members are idle stubs — a Reprise row must not WAKE them into a live (never-answering) session that the next Pause would have to interrupt
    const sw = { ...DEFAULT_BUS_SWITCHES, ...ON, wake: false };
    runs.startRun(db, { id: idOf('fleet-lead'), kind: 'mission', coordinator: idOf('fleet-lead'), title: 'Vague F — pause de flotte' }, sw);
    runs.startRun(db, { id: idOf('wave-ops'), kind: 'vague', coordinator: idOf('wave-ops'), parentRunId: idOf('fleet-lead'), title: 'Vague F — F1/F2' }, sw);
    runs.startRun(db, { id: idOf('legacy-sweep'), kind: 'mission', coordinator: idOf('legacy-sweep'), title: 'Balayage hors vague (switch pause OFF)' }, { ...sw, pause: false });
    // NO message: a pending `dispatch` would WAKE its recipient (bus-wake ON) and start a live session — the rig's members are idle
    console.log(JSON.stringify({ seeded: true, schema: db.pragma('user_version', { simple: true }) }));
  } else if (cmd === 'sql') {
    console.log(JSON.stringify(db.prepare(rest[0]).all(...rest.slice(1))));
  } else {
    const q = (s, ...a) => db.prepare(s).all(...a);
    console.log(JSON.stringify({
      runs: q('SELECT id, paused_at, paused_by, pause_mode, pause_deadline_at, pause_escalated_at, pause_trap_at, resume_started_at FROM runs ORDER BY created_at, id'),
      roster: q('SELECT run_id, paused_at, ws_id, role, member_run, pause_confirmed_at, pause_confirm_via, released_at, released_by, reprise_confirmed_at FROM pause_members ORDER BY run_id, paused_at, rowid'),
      bilan: q("SELECT run_id, ws_id, paused_at, snapshot_ref, dirty, killed_json IS NOT NULL AS trapped FROM pause_records WHERE ws_id != '__pause_origin__' ORDER BY id"),
      messages: q("SELECT sequence, run_id, sender, recipient, kind, substr(body,1,80) AS body FROM messages ORDER BY sequence"),
    }));
  }
} finally { db.close(); }
