// G8 (#292, epic #284, ADR 0004) — a Pause dure stops the member's ATTRIBUTED containers; the Reprise restarts exactly those — on the host's REAL dockerd.
//
// A REAL keeper + relay (#291) hosts a fake member CLI that creates a labelled DB container (with a named volume holding data) through the relay; the REAL trap
// (`runPauseTrap`, over a scratch REAL bus) pauses the run and the REAL Reprise (`beginReprise` → `restartOwedContainers` → `sweepReprise`) lifts it, both with the
// app's REAL Docker client (`docker-api.ts`, real socket). Only the process/session layer of the trap is stubbed (no `claude`). HEAVY rig: needs the OPS's
// heavy-rig token and MemAvailable > 6 GB (the .sh wrapper checks it).
//
//   node --experimental-strip-types --import ./scripts/.r2-register.mjs scripts/e2e-pause-containers.mjs <arm>   → one JSON line {arm, ok, checks…}
//   SUBJECT_REPO=<tree>  drives another tree (G1: the PARENT branch — no container step — must FAIL the `mustFailOnMaster` arms)
//
// SAFETY (ledger #295 D4): scratch ORCHESTRA_HOME/HOME and a scratch bus under the cache dir (never the live bus); every container the rig creates carries the name
// prefix `g8r<id>` AND the label `g8rig=g8r<id>`, cleanup is BY ID over those (+ `orchestra.ws=g8r<id>`) and the volumes by name prefix; the human's own containers
// are snapshotted before/after (id+name+state+image) and asserted UNCHANGED; an unattributed container and another member's container run beside the DB.

import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { createDockerRig, sleep } from './lib/docker-rig.mjs';

const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? '';

const ARMS = {
  pause_and_reprise: { mustFailOnMaster: true }, // Pause dure → DB container stopped, in the Bilan, volume intact, unattributed untouched; Reprise → restarted, data readable
  removed_by_hand: { mustFailOnMaster: true }, // a container removed by hand during the Pause does not break the Reprise (gone, reported, skipped)
  docker_unavailable: { mustFailOnMaster: false }, // the app cannot reach Docker: the trap still completes, the error is recorded, nothing is touched
  autoremove_and_failed: { mustFailOnMaster: true }, // a --rm container is skipped (a stop would delete it); a stop that fails is recorded and does not block
  app_resolution_moved: { mustFailOnMaster: true }, // the app's OWN docker resolution is dead/moved: Pause still stops, Reprise still restarts, on the daemon the member's relay stamped on (the keeper's published upstream)
};
if (!ARMS[ARM]) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

delete process.env.DOCKER_HOST; // the rig process itself never talks to a relay
const rig = createDockerRig({ repo: REPO });
const { PFX, WS, HOME, BASE, IMG, LBL, dk, labelsOf, check, checks } = rig;
process.env.ORCHESTRA_HOME = HOME;
process.env.HOME = HOME;

// ── the REAL modules (the process/session layer of the trap is the only stub) ─────────────────────────────────
const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-pause-containers-g8',
  broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => false, notify: () => {},
  openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => HOME, getLogsDir: () => `${HOME}/logs`, getAppVersion: () => '0.0.0-g8', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
(await import(`${REPO}/src/main/logger.ts`)).initLogger();
const bus = await import(`${REPO}/src/main/bus.ts`);
const busRuns = await import(`${REPO}/src/main/bus-runs.ts`);
const busPause = await import(`${REPO}/src/main/bus-pause.ts`);
const records = await import(`${REPO}/src/main/bus-pause-records.ts`);
const trap = await import(`${REPO}/src/main/pause-trap.ts`);
const reprise = await import(`${REPO}/src/main/pause-reprise.ts`);
const { createDockerApi, dockerApiForMember } = await import(`${REPO}/src/main/docker-api.ts`);
const { realUpstreamDeps } = await import(`${REPO}/src/shared/docker-endpoint.ts`);
const { DEFAULT_BUS_SWITCHES } = await import(`${REPO}/src/shared/bus-switches.ts`);
/** absent on the PARENT tree (no container step): the must-FAIL run still loads, the arms go red on the clause, not on an import error */
const restartOwed = await import(`${REPO}/src/main/pause-containers.ts`).then((m) => m.restartOwedContainers, () => null);

const db = bus.openBus(path.join(HOME, 'bus.sqlite'));
const sw = { ...DEFAULT_BUS_SWITCHES, pause: true };
busRuns.startRun(db, { id: 'M', kind: 'mission', coordinator: 'M' }, sw);
busRuns.startRun(db, { id: 'W', kind: 'vague', coordinator: 'W', parentRunId: 'M' }, sw);
const NODES = [{ id: 'M', kind: 'orchestrator' }, { id: 'W', kind: 'orchestrator', parentId: 'M' }, { id: WS, parentId: 'W' }];
reprise.setLiveTreeSource(() => ({ get: (id) => NODES.find((n) => n.id === id), ids: () => NODES.map((n) => n.id) }));
const MEMBER = { wsId: WS, runId: 'W', worktreePath: path.join(BASE, 'wt'), remote: false, status: null, lastTask: null };
fs.mkdirSync(MEMBER.worktreePath, { recursive: true });

/** the REAL per-member client: pinned to the daemon the member's keeper published, else the app's own */
const memberApi = (api) => (ws) => (dockerApiForMember ? dockerApiForMember(path.join(HOME, 'keepers', `${ws}.sock`), api) : api);
const restartDeps = (api) => ({ getBus: () => db, api, ...(dockerApiForMember ? { apiFor: memberApi(api) } : {}), now: () => Date.now() });
const mkTrapDeps = (api) => ({
  getBus: () => db,
  now: () => Date.now(),
  members: (runIds) => (runIds.includes('W') ? [MEMBER] : []),
  activityOf: async () => ({ surface: 'none', turnRunning: false, inFlightTools: [], bgTasks: [] }),
  interrupt: async () => 'no-session',
  cliOf: async () => null, // no live CLI: the tool-tree kill is "nothing to kill" — the container step is what runs
  snapshot: async (i) => ({ ref: `refs/orchestra/pause/${i.runId}/${i.wsId}/1`, commit: 'c', tree: 't', head: 'h', branch: 'rig', dirty: false, changed: { modified: 0, added: 0, deleted: 0 }, skippedLarge: [], skippedLargeCount: 0, notes: [], warnings: [], submodules: [] }),
  killTrees: async () => ({ cliPid: 0, cli: { pid: 0, startTicks: 0 }, killed: [], refused: [], spared: [], survivors: [], rounds: 0 }),
  sleep,
  settleMs: 0,
  originWaitMs: 0,
  ...(api ? { containers: api } : {}),
  // the REAL path: each member's client is pinned to the daemon ITS keeper's relay stamps on (the published `<ws>.docker.upstream`), else the app's own
  ...(api && dockerApiForMember ? { containersFor: memberApi(api) } : {}),
});
const sweepDeps = { getBus: () => db, members: () => [], subtree: (d, id) => busPause.runSubtreeIds(d, id), storeReady: () => true };
const repriseRows = () => db.prepare("SELECT recipient, sender FROM messages WHERE kind = 'reprise'").all();
const stateOf = (name) => rig.dk(['inspect', '-f', '{{.State.Running}}', name]).out; // 'true' | 'false' | '' (gone)
const existing = (name) => rig.dk(['inspect', '-f', '{{.Id}}', name]).code === 0;

/** The member (real keeper + relay) creates its DB container + volume; a bystander and another member's container run beside it. */
async function setup({ extra = [] } = {}) {
  const m = await rig.member();
  let r = await m.c.sh(`docker volume create ${PFX}-vol`);
  check('the member created a data volume through the relay', r.code === 0, r.err);
  r = await m.c.sh(`docker run -d ${LBL} --name ${PFX}-db -v ${PFX}-vol:/data ${IMG} sh -c 'echo secret-${PFX} > /data/state; sleep 3600'`);
  check('the member created its DB container through the relay', r.code === 0, r.err);
  for (const x of extra) {
    r = await m.c.sh(`docker run -d ${LBL} ${x.args} --name ${PFX}-${x.name} ${IMG} sleep 3600`);
    check(`the member created ${x.name}`, r.code === 0, r.err);
  }
  const l = labelsOf(`${PFX}-db`);
  const published = (() => {
    try {
      return fs.readFileSync(path.join(HOME, 'keepers', `${WS}.docker.upstream`), 'utf8').trim();
    } catch {
      return null;
    }
  })();
  check('the keeper PUBLISHED the daemon its relay forwards to (the Pause asks that one)', published === '/var/run/docker.sock', String(published));
  check('the DB container is attributed (orchestra.ws / orchestra.run stamped by the relay)', l && l['orchestra.ws'] === WS && l['orchestra.run'] === rig.RUN, JSON.stringify(l));
  const human = dk(['run', '-d', '--label', `${rig.rigLabel}=${PFX}`, '--name', `${PFX}-human`, IMG, 'sleep', '3600']);
  check('an UNATTRIBUTED container runs beside them (the human\'s own)', human.code === 0 && labelsOf(`${PFX}-human`)?.['orchestra.ws'] === undefined, human.err);
  const other = dk(['run', '-d', '--label', `${rig.rigLabel}=${PFX}`, '--label', `orchestra.ws=${PFX}-other`, '--name', `${PFX}-other`, IMG, 'sleep', '3600']);
  check('ANOTHER member\'s attributed container runs beside them', other.code === 0, other.err);
  for (let i = 0; i < 30; i++) {
    if (dk(['exec', `${PFX}-db`, 'cat', '/data/state']).out === `secret-${PFX}`) break;
    await sleep(200);
  }
  check('the DB wrote its data into the volume', dk(['exec', `${PFX}-db`, 'cat', '/data/state']).out === `secret-${PFX}`);
  return m;
}
const dataIntact = () => dk(['run', '--rm', '--label', `${rig.rigLabel}=${PFX}`, '-v', `${PFX}-vol:/data`, IMG, 'cat', '/data/state']).out === `secret-${PFX}`;

async function pauseDure(api) {
  check('the pause is written', busPause.setRunPause(db, 'W', true, 'W') === 'paused');
  const carrier = busPause.getRunPause(db, 'W');
  const sum = await trap.runPauseTrap(mkTrapDeps(api), carrier);
  return { carrier, sum };
}
const bilanContainers = (carrier) => records.bilanForMember(db, 'W', WS, carrier.pausedAt)?.activity?.containers;

const runArm = {
  async pause_and_reprise() {
    await setup();
    const api = createDockerApi();
    const { carrier, sum } = await pauseDure(api);
    check('the trap finished (docker did not block it)', sum.done === true, JSON.stringify(sum));
    check('the attributed DB container is STOPPED', stateOf(`${PFX}-db`) === 'false', stateOf(`${PFX}-db`));
    check('…not removed (it still exists, Exited)', existing(`${PFX}-db`));
    check('its data volume is INTACT', dataIntact());
    const bc = bilanContainers(carrier);
    const dbEntry = bc?.stopped?.find((x) => x.name === `${PFX}-db`);
    check('the Bilan lists it (activity.containers.stopped: id, name, image, run, outcome stopped)', dbEntry && dbEntry.outcome === 'stopped' && dbEntry.image === IMG && dbEntry.run === rig.RUN && dbEntry.id === dk(['inspect', '-f', '{{.Id}}', `${PFX}-db`]).out, JSON.stringify(bc));
    check('the unattributed container is NEVER stopped', stateOf(`${PFX}-human`) === 'true', stateOf(`${PFX}-human`));
    check('another member\'s attributed container is NEVER stopped', stateOf(`${PFX}-other`) === 'true', stateOf(`${PFX}-other`));
    check('the Bilan names ONLY this member\'s container', bc?.stopped?.length === 1, JSON.stringify(bc?.stopped?.map((x) => x.name)));

    // ── Reprise ──
    check('the Reprise begins', busPause.beginReprise(db, 'W', 'W') === 'resuming');
    check('FI-1.7: containers FIRST — the coordinators are parked, no Consigne yet', repriseRows().length === 0, JSON.stringify(repriseRows()));
    check('the DB is still stopped until the host\'s container step runs', stateOf(`${PFX}-db`) === 'false');
    if (!restartOwed) check('the container step exists in this tree', false, 'no pause-containers.ts');
    else {
      const started = await restartOwed(restartDeps(api));
      check('the host restarted exactly one container', started === 1, started);
    }
    check('the SAME container is running again', stateOf(`${PFX}-db`) === 'true', stateOf(`${PFX}-db`));
    check('its data is READABLE', dk(['exec', `${PFX}-db`, 'cat', '/data/state']).out === `secret-${PFX}`);
    check('the Bilan records restarted:started', bilanContainers(carrier)?.restarted?.[0]?.outcome === 'started', JSON.stringify(bilanContainers(carrier)));
    check('the unattributed container was never touched by the Reprise either', stateOf(`${PFX}-human`) === 'true' && stateOf(`${PFX}-other`) === 'true');
    reprise.sweepReprise(sweepDeps);
    check('only now are the coordinators released (their reprise rows exist)', repriseRows().length >= 1, JSON.stringify(repriseRows()));
  },

  async removed_by_hand() {
    await setup({ extra: [{ name: 'cache', args: '' }] });
    const api = createDockerApi();
    const { carrier, sum } = await pauseDure(api);
    check('the trap finished', sum.done === true);
    check('both attributed containers were stopped', stateOf(`${PFX}-db`) === 'false' && stateOf(`${PFX}-cache`) === 'false', `${stateOf(`${PFX}-db`)}/${stateOf(`${PFX}-cache`)}`);
    const rm = dk(['rm', '-f', `${PFX}-cache`]);
    check('the human removes the cache container BY HAND during the Pause', rm.code === 0 && !existing(`${PFX}-cache`), rm.err);
    busPause.beginReprise(db, 'W', 'W');
    if (!restartOwed) check('the container step exists in this tree', false, 'no pause-containers.ts');
    else await restartOwed(restartDeps(api));
    const out = new Map((bilanContainers(carrier)?.restarted ?? []).map((x) => [x.id, x.outcome]));
    const ids = new Map((bilanContainers(carrier)?.stopped ?? []).map((x) => [x.name, x.id]));
    check('the removed container is reported GONE (404), skipped', out.get(ids.get(`${PFX}-cache`)) === 'gone', JSON.stringify([...out]));
    check('the DB container is started', out.get(ids.get(`${PFX}-db`)) === 'started' && stateOf(`${PFX}-db`) === 'true', JSON.stringify([...out]));
    reprise.sweepReprise(sweepDeps);
    check('the Reprise CONTINUES: the coordinators are released', repriseRows().length >= 1, JSON.stringify(repriseRows()));
    check('the human\'s container is untouched', stateOf(`${PFX}-human`) === 'true');
  },

  async docker_unavailable() {
    await setup();
    // no published upstream (a keeper that never published, or died): the member falls back to the app's own client — which cannot reach Docker
    fs.rmSync(path.join(HOME, 'keepers', `${WS}.docker.upstream`), { force: true });
    const dead = createDockerApi({ env: { ORCHESTRA_DOCKER_SOCKET: path.join(BASE, 'no-daemon.sock'), HOME, PATH: process.env.PATH }, deps: realUpstreamDeps });
    const { carrier, sum } = await pauseDure(dead);
    check('the trap COMPLETES although Docker is unreachable', sum.done === true, JSON.stringify(sum));
    check('the Bilan records the error, not a stopped container', /^list:/.test(bilanContainers(carrier)?.error ?? '') && (bilanContainers(carrier)?.stopped?.length ?? 0) === 0, JSON.stringify(bilanContainers(carrier)));
    check('nothing was stopped', stateOf(`${PFX}-db`) === 'true' && stateOf(`${PFX}-human`) === 'true');
  },

  async app_resolution_moved() {
    await setup();
    // the app's own resolution has MOVED (a `docker context use`, a relaunch with another env): it points where no daemon is — the member's keeper still publishes the daemon its relay stamped on
    const moved = createDockerApi({ env: { ORCHESTRA_DOCKER_SOCKET: path.join(BASE, 'moved.sock'), HOME, PATH: process.env.PATH }, deps: realUpstreamDeps });
    check('premise: the app\'s own client cannot reach any daemon', (await moved.available()) === false);
    const { carrier, sum } = await pauseDure(moved);
    check('the trap finished', sum.done === true, JSON.stringify(sum));
    check('Pause asked the daemon the containers were STAMPED on: the DB container is stopped', stateOf(`${PFX}-db`) === 'false', stateOf(`${PFX}-db`));
    check('the Bilan lists it with no error', bilanContainers(carrier)?.stopped?.length === 1 && bilanContainers(carrier)?.error === undefined, JSON.stringify(bilanContainers(carrier)));
    check('the unattributed container is untouched', stateOf(`${PFX}-human`) === 'true');
    busPause.beginReprise(db, 'W', 'W');
    if (!restartOwed) check('the container step exists in this tree', false, 'no pause-containers.ts');
    else await restartOwed(restartDeps(moved));
    check('the Reprise restarted it on the same daemon (not a 404 gone on the app\'s)', stateOf(`${PFX}-db`) === 'true' && bilanContainers(carrier)?.restarted?.[0]?.outcome === 'started', JSON.stringify(bilanContainers(carrier)?.restarted));
    check('its data is readable', dk(['exec', `${PFX}-db`, 'cat', '/data/state']).out === `secret-${PFX}`);
  },

  async autoremove_and_failed() {
    await setup({ extra: [{ name: 'tmp', args: '--rm' }] });
    const api = createDockerApi();
    const { carrier, sum } = await pauseDure(api);
    check('the trap finished', sum.done === true);
    check('the `--rm` container is NOT stopped (a stop would delete it) and still runs', stateOf(`${PFX}-tmp`) === 'true', stateOf(`${PFX}-tmp`));
    const e = bilanContainers(carrier)?.stopped?.find((x) => x.name === `${PFX}-tmp`);
    check('the Bilan says skipped-autoremove', e?.outcome === 'skipped-autoremove', JSON.stringify(bilanContainers(carrier)));
    check('the DB container beside it was stopped normally', stateOf(`${PFX}-db`) === 'false');
    busPause.beginReprise(db, 'W', 'W');
    if (restartOwed) await restartOwed(restartDeps(api));
    check('the Reprise never starts/stops the --rm container (it is not in the owed list)', stateOf(`${PFX}-tmp`) === 'true' && (bilanContainers(carrier)?.restarted ?? []).every((x) => x.id !== e?.id), JSON.stringify(bilanContainers(carrier)?.restarted));
  },
};

// ── run ─────────────────────────────────────────────────────────────────────────────────────────────────────────
let fatal = null;
const t0 = Date.now();
try {
  await runArm[ARM]();
} catch (e) {
  fatal = e;
  check('arm completed without throwing', false, e?.stack ?? e);
}
rig.stopKeepers();
const owned = rig.mine();
rig.cleanup();
const leftover = rig.mine();
const AFTER = rig.bystanders();
check('positive control: the cleanup filter SEES the rig containers (so "none left" means something)', owned.length > 0, 'mine() saw none');
check('every rig container removed', leftover.length === 0, leftover.join(','));
const unchanged = JSON.stringify(rig.BEFORE) === JSON.stringify(AFTER);
check(`bystander containers UNCHANGED (${rig.BEFORE.length} before / ${AFTER.length} after)`, unchanged, unchanged ? '' : `before=${JSON.stringify(rig.BEFORE)} after=${JSON.stringify(AFTER)}`);
try {
  db.close();
} catch {
  /* closed */
}
fs.rmSync(BASE, { recursive: true, force: true });
const ok = checks.every((c) => c.ok);
console.log(JSON.stringify({ arm: ARM, ok, mustFailOnMaster: ARMS[ARM].mustFailOnMaster, id: rig.ID, ms: Date.now() - t0, rigContainers: owned.length, checks, fatal: fatal ? String(fatal.message ?? fatal) : undefined }));
process.exit(ok ? 0 : 1);
