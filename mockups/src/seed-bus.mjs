// seed-bus.mjs <H> <TREE> <state> [flags…] — seed the rig's ISOLATED bus.sqlite (<H>/bus.sqlite) with the SHIPPED writers. state: idle | douce | dure | escalated | resuming | resumed-all
import path from 'node:path';
import fs from 'node:fs';
const [H, TREE, state, ...flags] = process.argv.slice(2);
const SCRATCH = `/home/lmas/.orchestra/agent-tmp/${process.env.ORCHESTRA_WS_ID ?? ''}/pm/`;
if (!H.startsWith('/home/lmas/.orchestra/agent-tmp/') || /bus\.sqlite$/.test(H) || H === '/home/lmas/.orchestra') { console.error('seed-bus: refusing a non-scratch home', H); process.exit(97); }
const bus = await import(`${TREE}/src/main/bus.ts`);
const runs = await import(`${TREE}/src/main/bus-runs.ts`);
const bp = await import(`${TREE}/src/main/bus-pause.ts`);
const douce = await import(`${TREE}/src/main/pause-douce.ts`);
const rep = await import(`${TREE}/src/main/pause-reprise.ts`);
const rec = await import(`${TREE}/src/main/bus-pause-records.ts`);
const { DEFAULT_BUS_SWITCHES, BUS_MECHANISMS } = await import(`${TREE}/src/shared/bus-switches.ts`);
const store = JSON.parse(fs.readFileSync(path.join(H, 'userData/orchestra/store.json'), 'utf8'));
const byName = Object.fromEntries(store.workspaces.map((w) => [w.name, w]));
const id = (n) => byName[n].id;
rep.setLiveTreeSource(() => ({ get: (i) => store.workspaces.find((w) => w.id === i), ids: () => store.workspaces.map((w) => w.id) }));
const db = bus.openBus(path.join(H, 'bus.sqlite'), {});
const ON = Object.fromEntries(BUS_MECHANISMS.map((m) => [m, true]));
const T0 = Date.now();
try {
  runs.startRun(db, { id: id('fleet-lead'), kind: 'mission', coordinator: id('fleet-lead'), title: 'Vague F — pause de flotte : interface + canari' }, { ...DEFAULT_BUS_SWITCHES, ...ON });
  runs.startRun(db, { id: id('wave-f-ops'), kind: 'vague', coordinator: id('wave-f-ops'), parentRunId: id('fleet-lead'), title: 'Vague F — F1/F2' }, { ...DEFAULT_BUS_SWITCHES, ...ON });
  runs.startRun(db, { id: id('legacy-sweep'), kind: 'mission', coordinator: id('legacy-sweep'), title: 'Balayage hors vague (switch pause OFF)' }, { ...DEFAULT_BUS_SWITCHES, ...ON, pause: false });
  const sends = [
    ['wave-f-ops', 'pause-ui-f1', 'dispatch', 'F1 : maquettes d\'abord (D2), puis la couche IPC.'],
    ['pause-ui-f1', 'wave-f-ops', 'status', 'maquettes A/B/C prêtes, ping envoyé.'],
    ['wave-f-ops', 'canary-f2', 'dispatch', 'F2 : canari 1, flotte factice, 3 cycles par drill.'],
    ['canary-f2', 'wave-f-ops', 'status', 'drill Pause dure : 10/10 en pause en 41 s.'],
    ['review-f1', 'wave-f-ops', 'status', 'diff F1 relu — 0 bloquant, 1 majeur.'],
  ];
  for (const [from, to, kind, body] of sends) bus.send(db, { runId: id('wave-f-ops'), sender: id(from), recipient: id(to), kind, body });

  const LEAD = id('fleet-lead'), OPS = id('wave-f-ops');
  const members = ['fleet-lead', 'wave-f-ops', 'pause-ui-f1', 'canary-f2', 'review-f1', 'verifier-f', 'docs-sweep'];
  const memberRun = (n) => (n === 'fleet-lead' ? LEAD : n === 'docs-sweep' ? LEAD : OPS);
  const enrol = (at) => { for (const n of members) douce.enrollMember(db, LEAD, at, { wsId: id(n), memberRun: n === 'wave-f-ops' ? LEAD : memberRun(n) }); };
  const bilan = (at, n, extra = {}) => rec.insertBilan(db, { runId: LEAD, wsId: id(n), pausedAt: at, activity: { surface: 'sdk', memberRun: memberRun(n), status: 'running', turnRunning: true, interrupt: 'interrupted', branch: n, head: 'ab12cd3', changed: { modified: 2, added: 1, deleted: 0 }, ...extra.activity }, snapshotRef: extra.ref ?? `refs/orchestra/pause/${LEAD.slice(0, 8)}/${id(n).slice(0, 8)}/${at}`, dirty: extra.dirty ?? true, killed: extra.killed ?? [], error: null }, at + 4000);

  if (state === 'douce') {
    // Pause douce en cours : 5/7 accusés, manquent pause-ui-f1 + canary-f2, la dure tombe à ~1:50
    const at = T0 - 70_000;
    db.prepare(`UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = 'soft', pause_deadline_at = ? WHERE id = ?`).run(at, LEAD, at + 180_000, LEAD);
    enrol(at);
    const conf = [['fleet-lead', 'member', 9_000], ['wave-f-ops', 'member', 14_000], ['review-f1', 'member', 31_000], ['verifier-f', 'host-idle', 2_000], ['docs-sweep', 'host-idle', 2_000]];
    for (const [n, via, dt] of conf) douce.confirmMember(db, LEAD, at, { wsId: id(n), memberRun: memberRun(n) }, via, at + dt);
  } else if (state === 'dure' || state === 'escalated' || state === 'resuming' || state === 'resumed-late') {
    const at = T0 - 8 * 60_000 - 20_000;
    const soft = state === 'escalated';
    db.prepare(`UPDATE runs SET paused_at = ?, paused_by = ?, pause_mode = ?, pause_deadline_at = ?, pause_escalated_at = ? WHERE id = ?`).run(at, LEAD, soft ? 'soft' : 'hard', soft ? at + 180_000 : null, soft ? at + 180_000 : null, LEAD);
    enrol(at);
    const dt = { 'fleet-lead': 3000, 'wave-f-ops': 3500, 'pause-ui-f1': 5200, 'canary-f2': 6100, 'review-f1': soft ? 20_000 : 5500, 'verifier-f': 2500, 'docs-sweep': 2600 };
    for (const n of members) douce.confirmMember(db, LEAD, at, { wsId: id(n), memberRun: memberRun(n) }, soft && ['review-f1', 'verifier-f', 'docs-sweep'].includes(n) ? (n === 'review-f1' ? 'member' : 'host-idle') : 'trap', at + dt[n]);
    bilan(at, 'fleet-lead', { activity: { turnRunning: true, changed: { modified: 0, added: 0, deleted: 0 }, inFlightTools: [{ tool: 'Bash', toolUseId: 'tu0', sinceMs: 3000, input: 'orchestra bus-status' }] }, dirty: false });
    bilan(at, 'wave-f-ops', { activity: { turnRunning: true, inFlightTools: [{ tool: 'Bash', toolUseId: 'tu1', sinceMs: 41000, input: 'pnpm run test:pause-reprise' }] }, killed: [{ pid: 4242, cmd: 'node scripts/pause-trap/reprise-run.mjs', signal: 'SIGTERM', outcome: 'killed', cwd: '/wt/wave-f-ops' }] });
    bilan(at, 'pause-ui-f1', { activity: { turnRunning: true, changed: { modified: 6, added: 3, deleted: 0 }, inFlightTools: [{ tool: 'Bash', toolUseId: 'tu2', sinceMs: 12000, input: 'npx tsc --noEmit' }] }, killed: [{ pid: 5120, cmd: 'tsc --noEmit', signal: 'SIGTERM', outcome: 'killed', cwd: '/wt/pause-ui-f1' }, { pid: 5121, cmd: 'node tsserver.js', signal: 'SIGTERM', outcome: 'killed', cwd: '/wt/pause-ui-f1' }] });
    bilan(at, 'canary-f2', { activity: { turnRunning: true, changed: { modified: 1, added: 2, deleted: 0 }, bgTasks: [{ id: 'b1', description: 'drill Pause dure ×3', status: 'running' }] }, killed: [{ pid: 6001, cmd: 'bash scripts/canary/drill-dure.sh', signal: 'SIGKILL', outcome: 'killed', cwd: '/wt/canary-f2' }] });
    bilan(at, 'review-f1', { activity: { turnRunning: false, status: 'waiting', interrupt: 'idle', changed: { modified: 0, added: 0, deleted: 0 } }, dirty: false });
    bilan(at, 'verifier-f', { activity: { turnRunning: false, status: 'idle', interrupt: 'idle', changed: { modified: 0, added: 0, deleted: 0 } }, dirty: false });
    bilan(at, 'docs-sweep', { activity: { turnRunning: false, status: 'idle', interrupt: 'idle', changed: { modified: 3, added: 0, deleted: 0 } }, dirty: true });
    db.prepare('UPDATE runs SET pause_trap_at = ? WHERE id = ?').run(at + 7000, LEAD);
    if (state === 'resuming' || state === 'resumed-late') {
      // Reprise : l'hôte libère les coordinateurs ; l'OPS a déjà libéré 2 workers (1 accusé) ; 2 workers restent BLOQUÉS
      const out = bp.beginReprise(db, LEAD, LEAD, { reason: 'manual' });
      const R = (n, dtc, conf) => { db.prepare(`UPDATE pause_members SET released_at = ?, released_by = ? WHERE run_id = ? AND ws_id = ? AND released_at IS NULL`).run(T0 - dtc, OPS, LEAD, id(n)); if (conf) db.prepare('UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND ws_id = ?').run(T0 - dtc + 4000, LEAD, id(n)); };
      db.prepare(`UPDATE pause_members SET reprise_confirmed_at = ? WHERE run_id = ? AND ws_id IN (?, ?)`).run(T0 - 40_000, LEAD, id('fleet-lead'), id('wave-f-ops'));
      R('review-f1', 30_000, true);
      R('verifier-f', 30_000, false);
      console.log(JSON.stringify({ beginReprise: out }));
    }
  } else if (state !== 'idle') throw new Error(`unknown state ${state}`);
  const view = (await import(`${TREE}/src/main/pause-douce.ts`)).pauseStatusView(db, LEAD);
  console.log(JSON.stringify({ seeded: state, schema: db.pragma('user_version', { simple: true }), phase: view?.phase ?? 'active', summary: view?.summary ?? null }));
} finally { db.close(); }
