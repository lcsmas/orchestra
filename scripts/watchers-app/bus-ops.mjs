// bus-ops.mjs <H> <cmd> … — bus writes AS ANOTHER PROCESS (the CLI's shape) with the SHIPPED writers of THIS tree, on the rig's ISOLATED bus (<H>/bus.sqlite). Plain node.
//   reprise <leadName>                    : beginReprise (the structured Reprise) as the human — what `orchestra run resume` does, bypassing the app's IPC (so the app is NOT told)
//   release <carrierName> <name>…         : releaseMembers (the carrier's own run) as the human
//   gate <askerName> <question…>          : open a human decision gate
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
const [H, cmd, ...rest] = process.argv.slice(2);
const TREE = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const REAL_HOME = os.userInfo().homedir;
const resolved = H ? path.resolve(H) : '';
const live = [path.join(REAL_HOME, '.orchestra'), ...fs.readdirSync(REAL_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(REAL_HOME, n))];
const underLive = live.some((l) => resolved === l || resolved.startsWith(l + path.sep));
if (!H || underLive || !/(^|\/)arm-[^/]+\/oh$/.test(resolved) || /bus\.sqlite$/.test(H)) { console.error('bus-ops: refusing a non-rig home', H); process.exit(97); }
if (!fs.existsSync(path.join(H, 'userData/orchestra/store.json'))) { console.error('bus-ops: not a rig home (no store.json)', H); process.exit(97); }
const bus = await import(`${TREE}/src/main/bus.ts`);
const pause = await import(`${TREE}/src/main/bus-pause.ts`);
const reprise = await import(`${TREE}/src/main/pause-reprise.ts`);
const { PAUSE_HUMAN_BY } = await import(`${TREE}/src/shared/pause-lifecycle.ts`);
const { HUMAN_GATE_RECIPIENT } = await import(`${TREE}/src/shared/human-gates.ts`);
const store = JSON.parse(fs.readFileSync(path.join(H, 'userData/orchestra/store.json'), 'utf8'));
const idOf = (name) => store.workspaces.find((w) => w.name === name)?.id;
const db = bus.open(path.join(H, 'bus.sqlite'));
try {
  if (cmd === 'reprise') {
    console.log(JSON.stringify({ outcome: pause.beginReprise(db, idOf(rest[0]), PAUSE_HUMAN_BY, { reason: 'manual', human: true }) }));
  } else if (cmd === 'release') {
    const carrier = idOf(rest[0]);
    console.log(JSON.stringify(reprise.releaseMembers(db, carrier, PAUSE_HUMAN_BY, rest.slice(1).map(idOf), Date.now(), { human: true, ownRuns: [carrier] })));
  } else if (cmd === 'gate') {
    console.log(JSON.stringify({ gate: bus.openGate(db, idOf(rest[0]), idOf(rest[0]), rest.slice(1).join(' '), HUMAN_GATE_RECIPIENT) }));
  } else { console.error('bus-ops: unknown command', cmd); process.exit(2); }
} finally { db.close(); }
