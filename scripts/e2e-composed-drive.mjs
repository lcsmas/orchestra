// #294 (wave G, ledger #295) — the PACKAGED-APP drive of the composed proof. Run INSIDE scripts/e2e-contained-rig.sh by scripts/e2e-composed-drive.sh:
//   node e2e-composed-drive.mjs --base <scratch> --repo <tree> --app <packaged orchestra> --claude <claude> [--label g] [--containers 6] [--ballast-mb 100] [--phases main,resident]
//
// REAL path, zero tokens: the PACKAGED app (a session's `orchestra` shim needs it) in its own headless sway, scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, the REAL keepers (each hosting its Docker RELAY) + the REAL
// `claude` CLI against a scripted local fake Anthropic API, the REAL Docker daemon. The memory guard is the app's own (reads /proc/meminfo): the thresholds are moved around the live MemAvailable through the app's own
// `settings:setMemoryGuard` seam (what the Settings modal calls), exactly as scripts/e2e-memory-banner.mjs does. The fleet is LEAD ⊃ OPS ⊃ w1..w3 (the pause-canary's fleet); every switch ON for the scratch runs only.
//
//   main      Admission HELD (the amber banner, idle members to Veille) → the members create REAL labelled containers THROUGH THE RELAY (orchestra.ws / orchestra.run stamped) → critical (the red banner, a memory Pause
//             dure) → the attributed containers are STOPPED (not removed, data volume kept, the Bilan lists them), the unattributed ones are not → recovery → the automatic Reprise STARTS exactly those again, data intact
//             — and what the Reprise does to the host when N containers are owed (G7 r2 note: no MemAvailable check between starts) is MEASURED
//   resident  #287 seat-2 F1 — `setWakeKeeperResident` exercised in the REAL app: the app is closed (the keepers survive), reopened, Admission is HELD, then a message to a keeper-resident member is delivered (a reattach —
//             never held) while a message to a member whose keeper was killed is HELD for memory and goes out when memory recovers
//
// SAFETY (D4): scratch only (assertScratch), the live ~/.claude* dirs are hashed before/after, Docker: every container this drive touches carries the rig prefix / the rig label / an orchestra.ws of a rig workspace; every OTHER
// container (the host's own stacks) is snapshotted before and asserted UNCHANGED after; cleanup removes by those three keys only. A hard kill leaks only prefixed containers (`docker rm -f $(docker ps -aq --filter label=g10rig)`).
// Output: `OK|RED <check> — detail` lines, `PC-MEASURE {json}`, final `COMPOSED-DRIVE PASS|FAIL|VOID`. Exit 0 PASS · 1 FAIL · 3 VOID.

import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawnSync } from 'node:child_process';
import { initBase, preflight, liveSnapshot, hostNow, startApi, makeRig, seedRuns, startBusReader, launchApp, census, kindOf, teardown, say, sleep } from './pause-canary/lib.mjs';
import { fleetSpec } from './pause-canary/ids.mjs';
import { makeModel } from './pause-canary/fleet.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = opt('base'), REPO = opt('repo'), APP = opt('app'), CLAUDE = opt('claude');
const LABEL = opt('label', 'g');
const N = Number(opt('containers', '6'));
const BALLAST_MB = Number(opt('ballast-mb', '100'));
const PHASES = opt('phases', 'main,resident').split(',').filter(Boolean);
const OUT = opt('out', null);
if (!BASE || !REPO || !APP || !CLAUDE) { console.error('usage: e2e-composed-drive.mjs --base --repo --app --claude …'); process.exit(2); }
if (!Number.isInteger(N) || N < 3 || N > 12) { console.error('--containers 3..12'); process.exit(2); }
initBase(BASE);
preflight();

// ── verdict machine ──
const checks = [];
let voidReason = null;
const check = (name, ok, detail = '') => { checks.push({ name, ok: !!ok, detail: String(detail).slice(0, 400) }); say(`${ok ? 'OK ' : 'RED'} ${name}${detail ? ` — ${String(detail).slice(0, 300)}` : ''}`); return !!ok; };
const VOID = (why) => { voidReason = why; throw Object.assign(new Error(why), { isVoid: true }); };

// ── docker (the REAL daemon; HOME is the rig's fake one, so the default unix socket is used) ──
const dk = (...a) => { const r = spawnSync('docker', a, { encoding: 'utf8', timeout: 120_000, env: { PATH: '/usr/local/bin:/usr/bin:/bin', HOME: process.env.HOME } }); return { code: r.status, out: (r.stdout ?? '').trim(), err: (r.stderr ?? '').trim() }; };
if (dk('info', '--format', '{{.ServerVersion}}').code !== 0) { console.log('COMPOSED-DRIVE VOID — docker is not reachable'); process.exit(3); }
const IMAGE = 'alpine:3';
if (dk('image', 'inspect', IMAGE).code !== 0 && dk('pull', IMAGE).code !== 0) { console.log(`COMPOSED-DRIVE VOID — image ${IMAGE} is neither present nor pullable`); process.exit(3); }
const PFX = `g10r${crypto.randomBytes(4).toString('hex')}`;
const RIGLBL = 'g10rig';
const spec = fleetSpec(3);
const wsIds = new Set([spec.lead, spec.ops, ...spec.workers.map((w) => w.id)]);
/** one line per container: id|name|state|image|labels(orchestra.ws) — the daemon's truth */
const psAll = () => dk('ps', '-a', '--no-trunc', '--format', '{{.ID}}|{{.Names}}|{{.State}}|{{.Image}}|{{.Label "orchestra.ws"}}|{{.Label "' + RIGLBL + '"}}').out.split('\n').filter(Boolean).map((l) => { const [id, name, state, image, ws, rig] = l.split('|'); return { id, name, state, image, ws, rig }; });
const isMine = (c) => c.name.startsWith(PFX) || c.rig === PFX || wsIds.has(c.ws) || c.ws?.startsWith(PFX);
const bystanders = () => psAll().filter((c) => !isMine(c)).map((c) => `${c.id} ${c.name} ${c.state} ${c.image}`).sort();
const BEFORE = bystanders();
say(`DOCKER rig prefix ${PFX}; ${BEFORE.length} bystander container(s) of the host snapshotted (read-only)`);
function cleanup() {
  for (const c of psAll().filter(isMine)) dk('rm', '-f', '-v', c.id);
  for (const v of dk('volume', 'ls', '-q').out.split('\n').filter((x) => x.startsWith(PFX))) dk('volume', 'rm', '-f', v);
}
process.on('exit', () => { try { cleanup(); } catch { /* best effort */ } });
const inspect = (name) => { for (let i = 0; i < 3; i++) { const r = dk('inspect', name); try { const o = JSON.parse(r.out)[0]; if (o) return o; } catch { /* retry: a transient CLI failure must not read as "no such container / no labels" */ } if (/No such/i.test(r.err)) return null; spawnSync('sleep', ['0.3']); } return null; };
const running = (name) => inspect(name)?.State?.Running === true;
const exists = (name) => inspect(name) !== null;

// ── the fake API's model: the pause-canary's (mail acks, Reprise accusé, the OPS' `release --all`) + one scenario: `SCN:docker <tag>` = create a REAL container through the keeper relay ──
const tags = Array.from({ length: N }, (_, i) => String.fromCharCode(97 + i));
const dockerCmd = (tag) => `docker run -d --init --label ${RIGLBL}=${PFX} --name ${PFX}-${tag} -v ${PFX}-vol-${tag}:/data ${IMAGE} sh -c 'echo secret-${PFX}-${tag} > /data/state; awk "BEGIN{x=sprintf(\\"%${BALLAST_MB * 1024 * 1024}s\\",\\"\\"); system(\\"sleep 3600\\")}"'; echo DOCKER_RC=$? DOCKER_HOST=$DOCKER_HOST # g10 ${tag}`;   // the container's DB (a file in its volume) + a held ballast of ${BALLAST_MB} MB (awk keeps the string): it re-allocates at every (re)start, like a real service
const baseModel = makeModel({ kindOfRole: Object.fromEntries(spec.workers.map((w) => [w.k, 'idle'])), plan: { release: 'all', first: [] }, limited: new Set(), resetS: Math.floor(Date.now() / 1000) + 3600 });
const textOfMsg = (m) => (typeof m.content === 'string' ? m.content : Array.isArray(m.content) ? m.content.filter((b) => b.type === 'text').map((b) => b.text).join('\n') : '');
const toolOut = [];                                                 // what the members' Bash tool printed (DOCKER_RC / DOCKER_HOST of each `docker run`)
function decide(req) {
  for (const m of req.messages) if (m.role === 'user' && Array.isArray(m.content)) for (const b of m.content) if (b.type === 'tool_result') { const t = JSON.stringify(b.content ?? ''); const x = /DOCKER_RC=\d+ DOCKER_HOST=[^\\"]*/.exec(t); if (x && !toolOut.includes(`${req.role}:${x[0]}`)) toolOut.push(`${req.role}:${x[0]}`); }
  const r = baseModel(req);
  if (r?.tool) return r;                                            // mail / Consigne / release tools first
  if (!req.role || req.role === 'lead' || req.role === 'ops') return r;
  const users = req.messages.filter((m) => m.role === 'user').map(textOfMsg);
  const asked = [...users.join('\n').matchAll(/SCN:docker ([a-z])/g)].map((m) => m[1]);
  const ran = new Set(req.messages.filter((m) => m.role === 'assistant' && Array.isArray(m.content)).flatMap((m) => m.content.filter((b) => b.type === 'tool_use').map((b) => String(b.input?.command ?? ''))).map((c) => /# g10 ([a-z])/.exec(c)?.[1]).filter(Boolean));
  const next = asked.find((t) => !ran.has(t));
  if (next) return { tool: { name: 'Bash', input: { command: dockerCmd(next), description: `g10 create container ${next}` } } };
  return r;
}

// ── host guard: the rig's footprint + the containers' ballast must fit ──
const host0 = hostNow();
const NEED_GB = 9 + (N * BALLAST_MB * 2) / 1024;
if (host0.availGB < NEED_GB || host0.load1 > 20) { console.log(`COMPOSED-DRIVE VOID — host ${host0.availGB.toFixed(1)} GB available / load ${host0.load1} (need ≥ ${NEED_GB.toFixed(1)} GB, load ≤ 20)`); process.exit(3); }
const liveBefore = liveSnapshot();
say(`LIVE-BEFORE ${JSON.stringify(liveBefore)}`);
const memTotalGB = Number(/MemTotal:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
const availGB = () => Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576;
const L = availGB();
if (L < 8 || memTotalGB - L < 7.5) { console.log(`COMPOSED-DRIVE VOID — MemAvailable ${L.toFixed(1)} GB: the thresholds need room (live > 8 GB, MemTotal ${memTotalGB.toFixed(1)} GB)`); process.exit(3); }

let rig = null, api = null, busr = null, app = null;
const shots = [];
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function shot(name) {
  const r = await app.cdp.send('Page.captureScreenshot', { format: 'png' });
  const buf = Buffer.from(r.result.data, 'base64');
  const file = path.join(rig.H, 'shots', `${name}.png`);
  fs.mkdirSync(path.dirname(file), { recursive: true });
  fs.writeFileSync(file, buf);
  shots.push({ name, file, md5: md5(buf) });
  return file;
}
const ev = (expr) => app.cdp.eval(expr);
const banner = () => ev(`(() => { const b = document.querySelector('.memory-banner'); return b ? { kind: b.getAttribute('data-kind'), tone: b.getAttribute('data-tone'), text: b.textContent.slice(0, 220) } : null; })()`);
const waitFor = async (pred, ms, what, step = 250) => { const t0 = Date.now(); for (;;) { let v = null; try { v = await pred(); } catch { /* retry */ } if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
const Q = (sql, ...a) => busr.q(sql, ...a);
const setGuard = (admissionGb, criticalGb) => ev(`window.orchestra.setMemoryGuard(${JSON.stringify({ admissionGb, criticalGb })})`);
const busStatus = async () => (await app.cli(spec.ops, ['bus-status'])).out;
const sendTo = (id, text) => ev(`window.orchestra.agentSdkSend(${JSON.stringify(id)}, ${JSON.stringify(text)})`);
const logText = () => { try { return fs.readFileSync(path.join(rig.H, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } };
const wsByK = (k) => spec.workers.find((w) => w.k === k).id;
const runStatus = async () => { const r = await app.cli(spec.ops, ['run', 'status', '--run', spec.lead, '--json']); try { return JSON.parse(r.out); } catch { return null; } };

const measure = { containers: N, ballastMb: BALLAST_MB };
let touched = [];                                                   // names of every container the host's Pause stopped (the Bilan)
try {
  // ── the world ──
  api = await startApi({ decide });
  rig = await makeRig({ label: LABEL, spec, apiUrl: api.url, appBin: APP, claudeBin: CLAUDE });
  say(`RIG H=${rig.H} (H length ${rig.H.length}: the relay socket <H>/keepers/<ws>.docker.sock must be ≤ 107 bytes) workers=${spec.workers.map((w) => `${w.k}=${w.id}`).join(' ')}`);
  say(`SEED-RUNS ${JSON.stringify(seedRuns(rig, REPO, 'none'))}`);
  busr = startBusReader(rig, REPO);
  app = await launchApp(rig);
  await waitFor(() => ev(`!!document.querySelector('.sidebar, aside, [class*=sidebar]')`), 60_000, 'the sidebar');
  const runOf = async () => (await Q("SELECT id, kind, paused_at, paused_by, pause_mode, pause_trap_at, resume_started_at FROM runs ORDER BY id")) ?? [];
  check('rig_runs_seeded_with_every_switch_on', (await runOf()).length === 2, JSON.stringify(await runOf()));

  if (PHASES.includes('main')) {
    // ── A0: nothing at open memory ──
    check('A0_no_banner_at_open_memory', (await banner()) === null, JSON.stringify(await banner()));
    // ── A1: the members create REAL containers through the keeper's relay ──
    for (let i = 0; i < tags.length; i++) {
      const w = spec.workers[i % spec.workers.length];
      await sendTo(w.id, `SCN:docker ${tags[i]}`);
    }
    const created = await waitFor(() => tags.every((t) => exists(`${PFX}-${t}`)), 180_000, 'every container to be created');
    await sleep(1500);
    check('A1_members_created_N_real_containers_through_the_relay', !!created, `${tags.filter((t) => exists(`${PFX}-${t}`)).length}/${N} exist; tool output: ${toolOut.join(' | ')}`);
    if (!created) VOID(`containers were not created (${tags.filter((t) => !exists(`${PFX}-${t}`)).join(',')} missing) — is the relay / the scenario broken? requests=${api.requests.length}`);
    const lab = (t) => { const o = inspect(`${PFX}-${t}`); return o ? (o.Config?.Labels ?? {}) : { 'inspect-failed': 'true' }; };
    say(`LABELS a: ${JSON.stringify(lab(tags[0]))}`);
    const stamped = tags.map((t, i) => lab(t)['orchestra.ws'] === spec.workers[i % spec.workers.length].id && !!lab(t)['orchestra.run']);
    check('A1_the_relay_stamped_orchestra_ws_and_orchestra_run', stamped.every(Boolean), JSON.stringify(tags.map((t) => [t, lab(t)['orchestra.ws']?.slice(-6), lab(t)['orchestra.run']?.slice(-6)])));
    check('A1_run_label_is_the_members_own_run', tags.every((t) => lab(t)['orchestra.run'] === spec.ops), `expected the OPS run ${spec.ops.slice(-6)}: ${JSON.stringify(tags.map((t) => lab(t)['orchestra.run']?.slice(-6)))}`);
    // the data is written (the rig's DB)
    await waitFor(() => tags.every((t) => dk('exec', `${PFX}-${t}`, 'cat', '/data/state').out === `secret-${PFX}-${t}`), 60_000, 'every container to write its data');
    check('A1_every_container_wrote_its_data', tags.every((t) => dk('exec', `${PFX}-${t}`, 'cat', '/data/state').out === `secret-${PFX}-${t}`), '');
    // bystanders OUTSIDE the relay: an unlabelled one, and one attributed to a workspace that is not in this fleet
    check('A1_bystanders_created', dk('run', '-d', '--init', '--label', `${RIGLBL}=${PFX}`, '--name', `${PFX}-human`, IMAGE, 'sleep', '3600').code === 0 && dk('run', '-d', '--init', '--label', `${RIGLBL}=${PFX}`, '--label', `orchestra.ws=${PFX}-ghost`, '--name', `${PFX}-other`, IMAGE, 'sleep', '3600').code === 0, '');
    const idleMem = availGB();
    measure.availBeforeStopGb = Number(idleMem.toFixed(2));

    // ── A2: Admission HELD ──
    const A = Math.min(Math.round((L + 6) * 10) / 10, Math.floor((memTotalGB - 1.5) * 10) / 10), C = Math.round((L + 2) * 10) / 10;
    const r1 = await setGuard(A, 3);
    check('A2_settings_accepted_admission_above_the_live_reading', r1?.ok === true, JSON.stringify(r1)?.slice(0, 200));
    const held = await waitFor(async () => { const b = await banner(); return b?.kind === 'held' ? b : null; }, 30_000, 'the amber banner');
    check('A2_the_amber_banner_shows_while_admission_is_held', !!held && held.tone === 'warn', JSON.stringify(held));
    await shot('a2-held-amber');
    const bs1 = await busStatus();
    check('A2_bus_status_says_admission_held', /memory: .*admission HELD since /.test(bs1), bs1.split('\n').find((l) => /^memory:/.test(l)) ?? bs1.slice(0, 160));
    const veille = await waitFor(() => /hibernating .*Admission HELD/.test(logText()), 40_000, 'a fast Veille under the hold');
    check('A2_idle_members_went_to_veille_under_the_hold', !!veille, (logText().match(/hibernating [^\n]*Admission HELD[^\n]*/) ?? [''])[0].slice(0, 200));
    check('A2_containers_are_untouched_by_admission', tags.every((t) => running(`${PFX}-${t}`)), '');

    // ── A3: critical → the memory Pause dure ──
    const tPause0 = Date.now();
    const r2 = await setGuard(A, C);
    check('A3_settings_accepted_critical_above_the_live_reading', r2?.ok === true, JSON.stringify(r2)?.slice(0, 200));
    const paused = await waitFor(async () => { const rr = await runOf(); return rr.find((x) => x.id === spec.lead)?.paused_at ? rr : null; }, 30_000, 'the memory Pause');
    const lead = (await runOf()).find((x) => x.id === spec.lead);
    check('A3_the_memory_pause_dure_is_written_by_the_host', !!paused && lead?.paused_by === 'host:memory' && lead?.pause_mode === 'hard', JSON.stringify(lead));
    const stopped = await waitFor(() => tags.every((t) => exists(`${PFX}-${t}`) && !running(`${PFX}-${t}`)), 240_000, 'the attributed containers to stop', 500);
    measure.pauseToAllStoppedS = Math.round((Date.now() - tPause0) / 100) / 10;
    check('A3_every_attributed_container_is_STOPPED', !!stopped, tags.map((t) => `${t}:${inspect(`${PFX}-${t}`)?.State?.Status}`).join(' '));
    check('A3_none_was_removed_and_the_data_volumes_are_kept', tags.every((t) => exists(`${PFX}-${t}`) && dk('volume', 'inspect', `${PFX}-vol-${t}`).code === 0), '');
    check('A3_bystanders_untouched_unattributed_and_other_workspace', running(`${PFX}-human`) && running(`${PFX}-other`), `human=${running(`${PFX}-human`)} other=${running(`${PFX}-other`)}`);
    const red = await waitFor(async () => { const b = await banner(); return b?.kind === 'pause' ? b : null; }, 30_000, 'the red banner');
    check('A3_the_red_banner_shows_the_memory_pause', !!red && red.tone === 'crit', JSON.stringify(red));
    await shot('a3-pause-red');
    const bs2 = await busStatus();
    check('A3_bus_status_says_the_memory_pause_is_in_effect', /memory: .*memory Pause IN EFFECT since /.test(bs2), bs2.split('\n').find((l) => /^memory:/.test(l)) ?? '');
    const st = await runStatus();
    const bilan = (st?.bilan ?? []).flatMap((r) => (r.activity?.containers?.stopped ?? []).map((c) => ({ ws: r.wsId, name: c.name, outcome: c.outcome, atMs: c.atMs })));
    touched = bilan.map((b) => b.name);
    check('A3_the_bilan_lists_exactly_the_stopped_containers', bilan.length === N && tags.every((t) => bilan.some((b) => b.name === `${PFX}-${t}` && b.outcome === 'stopped')) && !bilan.some((b) => /-human|-other/.test(b.name)), JSON.stringify(bilan.map((b) => [b.name.slice(-6), b.outcome])));
    measure.stop = { firstAtMs: Math.min(...bilan.map((b) => b.atMs)), lastAtMs: Math.max(...bilan.map((b) => b.atMs)), spanS: Math.round((Math.max(...bilan.map((b) => b.atMs)) - Math.min(...bilan.map((b) => b.atMs))) / 100) / 10 };
    // the cost of keeping them: what N containers held
    const stats = dk('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}', ...[]).out;   // after the stop: only running ones (the bystanders)
    measure.runningAfterStop = stats.split('\n').filter((l) => l.startsWith(PFX)).length;

    // ── A4: recovery → the automatic Reprise ──
    const samples = [];
    const sampler = setInterval(() => samples.push([Date.now(), availGB()]), 250);
    const availAtLift = availGB();
    const tLift = Date.now();
    const r3 = await setGuard(6, 3);
    check('A4_settings_back_to_the_defaults', r3?.ok === true, JSON.stringify(r3)?.slice(0, 200));
    const back = await waitFor(() => tags.every((t) => running(`${PFX}-${t}`)), 300_000, 'the containers to start again', 250);
    const tBack = Date.now();
    await sleep(3000);
    clearInterval(sampler);
    check('A4_the_reprise_started_every_stopped_container_again', !!back, tags.map((t) => `${t}:${inspect(`${PFX}-${t}`)?.State?.Status}`).join(' '));
    check('A4_the_same_containers_data_intact', tags.every((t) => dk('exec', `${PFX}-${t}`, 'cat', '/data/state').out === `secret-${PFX}-${t}` && !!inspect(`${PFX}-${t}`)), '');
    check('A4_bystanders_still_untouched', running(`${PFX}-human`) && running(`${PFX}-other`), '');
    check('A4_the_banner_is_gone_on_recovery', await waitFor(async () => (await banner()) === null, 30_000, 'the banner to clear'), JSON.stringify(await banner()));
    const st2 = await waitFor(async () => { const s = await runStatus(); return (s?.bilan ?? []).some((r) => (r.activity?.containers?.restarted ?? []).length) ? s : null; }, 60_000, 'the Bilan restarted entries');
    const restarted = (st2?.bilan ?? []).flatMap((r) => (r.activity?.containers?.restarted ?? []).map((c) => ({ id: c.id, outcome: c.outcome, atMs: c.atMs })));
    check('A4_the_bilan_records_each_restart', restarted.length === N && restarted.every((r) => r.outcome === 'started'), JSON.stringify(restarted.map((r) => r.outcome)));
    await shot('a4-recovered');
    // the run goes ACTIVE (the OPS released its workers on its own Consigne)
    const active = await waitFor(async () => { const l = (await runOf()).find((x) => x.id === spec.lead); return l && l.paused_at === null ? l : null; }, 120_000, 'the run to go ACTIVE', 500);
    check('A4_the_run_is_active_again_after_the_ops_released_its_workers', !!active, JSON.stringify((await runOf()).find((x) => x.id === spec.lead)));
    // G7 r2 note — the Reprise's cost on the host, MEASURED
    const startedAt = tags.map((t) => Date.parse(inspect(`${PFX}-${t}`)?.State?.StartedAt ?? '')).filter(Number.isFinite).sort((a, b) => a - b);
    const gaps = startedAt.slice(1).map((t, i) => t - startedAt[i]);
    const during = samples.filter(([t]) => t >= tLift && t <= tBack + 3000).map(([, g]) => g);
    const statsRaw = dk('stats', '--no-stream', '--format', '{{.Name}} {{.MemUsage}}').out;
    say(`STATS ${JSON.stringify(statsRaw.split('\n').filter((l) => l.startsWith(PFX)))}`);
    const sumRssMb = statsRaw.split('\n').filter((l) => l.startsWith(PFX) && !/-human|-other/.test(l)).map((l) => { const m = /([\d.]+)(MiB|GiB|kB|B)\s*\//.exec(l); return m ? Number(m[1]) * ({ MiB: 1, GiB: 1024, kB: 1 / 1024, B: 1 / 1048576 })[m[2]] : 0; }).reduce((a, b) => a + b, 0);
    measure.reprise = { liftToAllRunningS: Math.round((tBack - tLift) / 100) / 10, startSpanS: startedAt.length ? Math.round((startedAt.at(-1) - startedAt[0]) / 100) / 10 : null, startGapsMs: gaps, minAvailDuringGb: during.length ? Number(Math.min(...during).toFixed(2)) : null, availAtLiftGb: Number(availAtLift.toFixed(2)), dipGb: during.length ? Number((availAtLift - Math.min(...during)).toFixed(2)) : null, availBeforeStopGb: measure.availBeforeStopGb, containerMemMb: Math.round(sumRssMb), sequential: gaps.length ? gaps.every((g) => g >= 50) : null };
    console.log(`PC-MEASURE ${JSON.stringify(measure)}`);
    check('A4_measured_the_reprise_burst', measure.reprise.startSpanS !== null && measure.reprise.minAvailDuringGb !== null, JSON.stringify(measure.reprise));
  }

  if (PHASES.includes('resident')) {
    // ── B: #287 seat-2 F1 — setWakeKeeperResident in the REAL app ──
    await setGuard(6, 3);
    const w1 = wsByK('w1'), w2 = wsByK('w2'), w3 = wsByK('w3');
    const keeperOf = (id) => census(rig).find((p) => kindOf(p) === 'keeper' && p.cmd.includes(id));
    const cliOfKeeper = (k) => census(rig).find((p) => p.ppid === k.pid && kindOf(p) === 'claude');
    for (const id of [w1, w2, w3]) await sendTo(id, 'SCN:hello');
    const live = await waitFor(() => [w1, w2, w3].every((id) => { const k = keeperOf(id); return k && cliOfKeeper(k); }), 90_000, 'three live keepers with a CLI');
    check('B0_three_members_have_a_live_keeper_and_cli', !!live, JSON.stringify([w1, w2, w3].map((id) => !!keeperOf(id))));
    if (!live) VOID('no live keepers for the resident phase');
    const id1 = (() => { const k = keeperOf(w1); const c = cliOfKeeper(k); return { k: [k.pid, k.startTicks], c: [c.pid, c.startTicks] }; })();
    const k3 = keeperOf(w3), c3 = cliOfKeeper(k3);
    for (const p of [c3, k3]) { try { process.kill(p.pid, 'SIGKILL'); } catch { /* gone */ } }          // the contrast member: its keeper and CLI are dead before the app closes
    await sleep(1500);
    // close the app GRACEFULLY: the keepers + CLIs of the others survive it
    try { await ev('window.close()'); } catch { /* the page dies with the window */ }
    const gone = await waitFor(() => { try { process.kill(app.app.pid, 0); return false; } catch { return true; } }, 60_000, 'the app to exit', 500);
    check('B1_the_app_closed_gracefully', !!gone, '');
    const surv = (id, want) => { const k = keeperOf(id); const c = k && cliOfKeeper(k); return !!k && !!c && k.pid === want.k[0] && k.startTicks === want.k[1] && c.pid === want.c[0] && c.startTicks === want.c[1]; };
    check('B1_the_keeper_and_cli_of_a_member_survived_the_app', surv(w1, id1), JSON.stringify(id1));
    check('B1_the_killed_members_keeper_is_gone', !keeperOf(w3), '');
    const logBefore = logText().length;
    app = await launchApp(rig);
    await waitFor(() => ev(`!!document.querySelector('.sidebar, aside, [class*=sidebar]')`), 60_000, 'the sidebar (2nd launch)');
    // Admission HELD AFTER the relaunch: every member is "sleeping" (no in-memory session) — the resident one's wake must only REATTACH
    const A = Math.min(Math.round((availGB() + 6) * 10) / 10, Math.floor((memTotalGB - 1.5) * 10) / 10);
    const rh = await setGuard(A, 3);
    check('B2_admission_held_after_the_relaunch', rh?.ok === true && (await waitFor(async () => (await banner())?.kind === 'held', 30_000, 'the amber banner')), JSON.stringify(rh)?.slice(0, 160));
    const reqBefore = (role) => api.requests.filter((r) => r.role === role).length;
    const n1 = reqBefore('w1'), n3 = reqBefore('w3');
    await app.cli(spec.ops, ['send', '--type', 'status', '--to', w1, 'resident ping'], { run: spec.ops });
    await app.cli(spec.ops, ['send', '--type', 'status', '--to', w3, 'killed ping'], { run: spec.ops });
    const delivered = await waitFor(() => reqBefore('w1') > n1, 60_000, 'a request for the resident member');
    const newLog = () => logText().slice(logBefore);
    const reLine = (id) => new RegExp(`agent-sdk\\[${id}\\] reattached to detached keeper session[^\\n]*`);
    check('B3_the_resident_members_wake_was_a_reattach_not_held', !!delivered && !new RegExp(`bus-wake: ${w1} is PENDING and its réveil is HELD for memory`).test(newLog()) && reLine(w1).test(newLog()), (newLog().match(reLine(w1)) ?? ['(no reattach line for the member)'])[0].slice(0, 200));
    const reattachedPid = Number((newLog().match(reLine(w1)) ?? [''])[0].match(/cli pid=(\d+)/)?.[1] ?? NaN);
    check('B3_it_reattached_to_the_SAME_cli_process_that_survived_the_app', reattachedPid === id1.c[0], `reattach line names cli pid ${reattachedPid}; the CLI before the app closed was ${id1.c[0]}`);
    await sleep(4000);
    check('B4_the_killed_members_wake_is_HELD_for_memory', new RegExp(`bus-wake: ${w3} is PENDING and its réveil is HELD for memory`).test(newLog()) && reqBefore('w3') === n3, `requests for w3 +${reqBefore('w3') - n3}; ${(newLog().match(/[^\n]*is PENDING and its réveil is HELD[^\n]*/) ?? ['(no held line)'])[0].slice(0, 160)}`);
    const bs = await busStatus();
    check('B4_bus_status_lists_the_held_wake', /held starts: 1 held for memory/.test(bs) && /pc-w3 \(wake, since /.test(bs), (bs.split('\n').find((l) => /^held starts/.test(l)) ?? '(no line)').slice(0, 200));
    await setGuard(6, 3);
    check('B5_on_recovery_the_held_wake_goes_out_once', !!(await waitFor(() => reqBefore('w3') > n3, 90_000, 'a request for the released member')) && /RELEASED wake of /.test(newLog()), `requests for w3 +${reqBefore('w3') - n3}`);
  }
} catch (e) {
  if (e?.isVoid) say(`VOID: ${voidReason}`); else { check('drive_completed', false, String(e?.stack ?? e).slice(0, 400)); }
} finally {
  try { busr?.close(); } catch { /* */ }
  let left = [];
  try { left = rig ? await teardown(rig, app) : []; } catch { /* */ }
  try { await api?.stop(); } catch { /* */ }
  cleanup();
  check('teardown_no_rig_process_survives', left.length === 0, left.map((p) => `${p.pid}:${p.cmd.slice(0, 60)}`).join(' '));
  check('docker_every_rig_container_and_volume_removed', psAll().filter(isMine).length === 0 && dk('volume', 'ls', '-q').out.split('\n').every((v) => !v.startsWith(PFX)), '');
  const after = bystanders();
  // the host is SHARED (sibling agents run their own stacks and churn them): the invariant is PROVENANCE — everything ORCHESTRA stopped / started (the Bilan the host wrote) is a rig container — and the drive's own bystanders; the host-wide snapshot is reported, not asserted
  say(`DOCKER host-wide snapshot (informational, siblings churn their own stacks): ${BEFORE.length} before / ${after.length} after; changed-by-someone: -${BEFORE.filter((x) => !after.includes(x)).length} +${after.filter((x) => !BEFORE.includes(x)).length}`);
  check('docker_everything_orchestra_touched_is_a_rig_container', touched.length > 0 && touched.every((n) => n.startsWith(PFX) && !/-human|-other/.test(n)), `${touched.length} container(s) in the Bilan: ${touched.map((n) => n.slice(-8)).join(',')}`);
  const liveAfter = liveSnapshot();
  check('live_claude_dirs_untouched', JSON.stringify(liveBefore) === JSON.stringify(liveAfter), `${Object.keys(liveBefore).length} live ~/.claude* dirs hashed before/after`);
  say('== shots (md5) ==');
  for (const s of shots) say(`  ${s.md5}  ${s.file}`);
  check('shots_are_distinct', new Set(shots.map((s) => s.md5)).size === shots.length, `${shots.length} captures`);
  const red = checks.filter((c) => !c.ok);
  if (OUT) fs.writeFileSync(OUT, JSON.stringify({ checks, measure, shots, pfx: PFX, voidReason }, null, 2));
  const verdict = voidReason && red.length === 0 ? 'VOID' : red.length === 0 ? 'PASS' : 'FAIL';
  say(`COMPOSED-DRIVE ${verdict}${red.length ? `: RED ${red.map((c) => c.name).join(', ')}` : ''} (${checks.length - red.length}/${checks.length})`);
  process.exitCode = verdict === 'PASS' ? 0 : verdict === 'VOID' ? 3 : 1;
}
