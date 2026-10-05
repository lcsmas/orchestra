// Pause canary 1 (#258, wave F ledger #281 D3) — the DRILL driver, run INSIDE scripts/e2e-contained-rig.sh by run.mjs:
//   node drive.mjs --base <scratch> --repo <tree> --app <packaged orchestra> --claude <claude> [--exercise douce,dure,reprise,auto] [--cycles 3] [--members 10] [--label L] [--dwell-s 40] [--app-tree <src tree>] [--pause on|off]
// Fleet: LEAD (mission) ⊃ OPS (vague) ⊃ w1..wN (≥1 member blocked in ONE long command, ≥1 quota member). Every exercise gets its OWN scratch rig + app + fake API; N cycles each on the SAME fleet.
//   douce    `run pause` (soft) → orders at tool boundaries → obeyers commit+push+accusé → a quota member hits a simulated usage limit INSIDE the window → the blocked member runs to the 3-min deadline → escalation → trap → hold → account switch → `run resume` → Reprise
//   dure     `run pause --hard` → all paused (< 60 s) → a quota member hits the limit DURING the pause → hold (wake attempts to EVERY worker) → account switch → `run resume` → OPS releases --all → every member accused
//   reprise  dure + a Reprise in TWO batches: workers wait for THEIR OPS (0 request before release), the LEAD's `release --all` wakes nobody
//   auto     a member hits a simulated usage limit → the host pauses the OPS run (hard) → still paused after a tick → `migrate-account` (simulated account switch) → auto Reprise → all accused
// Per cycle: time to all-paused, time to all-resumed, lost work (each pause ref holds the member's uncommitted diff, every branch intact), self-restarts (must be 0), accusés. Bars in bars.mjs — never lowered.
// Verdicts: PASS · FAIL (a measured RED, kept even if the host later dips) · VOID (host below the 6 GB bar with NOTHING red yet: no verdict, re-run) — a cycle that ABORTS reports `cycle_aborted`, never bars painted "NOT MEASURED".
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync, spawn } from 'node:child_process';
import { initBase, preflight, liveSnapshot, hostNow, startApi, makeRig, seedRuns, startBusReader, launchApp, census, kindOf, memberOfCwd, rigMemory, teardown, git, gitSafe, gitShow, say, sleep, B_KEY, ACCT_B } from './lib.mjs';
import { fleetSpec } from './ids.mjs';
import { makeModel, markersOf } from './fleet.mjs';
import { BARS, evaluateCycle, lostWorkOf, forbiddenRequests, holdWindows, holdWindowGaps, isMemberTool, renderTable } from './bars.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = opt('base'), REPO = opt('repo'), APP = opt('app'), CLAUDE = opt('claude');
const APP_TREE = opt('app-tree', REPO);
const LABEL = opt('label', `run${Date.now().toString(36).slice(-4)}`);
const EXERCISES = opt('exercise', 'douce,dure,reprise,auto').split(',').filter(Boolean);
const CYCLES = Number(opt('cycles', '3'));
const MEMBERS = Number(opt('members', '10'));
const DWELL_S = Number(opt('dwell-s', '40'));
const PAUSE_SWITCH = opt('pause', 'on');
const MIN_AVAIL_GB = Number(opt('min-avail-gb', '6'));
const MAX_LOAD = Number(opt('max-load', '20'));
const DOUCE_LIMIT = opt('douce-limit', '1') === '1';
const CYCLE_RESULTS_FILE = opt('out', null);
// harness-level INSTRUMENT controls (proof arms only): after the pause, sabotage one member's evidence — the matching instrument must read RED
const SABOTAGE = opt('sabotage', null);   // 'branch' (rewind a branch to master) | 'ref' (delete a pause ref) | 'session' (SIGTERM a member's CLI)
// proof-only process INJECTION during the hold window (dure only): 'orphan-tool' = a REAL command that came back in a member worktree (an orphan: must stay detected);
// 'app-git' = a process whose ancestry is the APP's (a fake app helper running a child in the worktree: what the app's own `git ls-files --others` looks like: must NOT be flagged).
const INJECT = opt('inject', null);
const WINDOW = opt('window', 'member');   // 'legacy' = the pre-fix run-level hold window only (the proof's blind-window arm)
const TOOLPROCS = opt('toolprocs', 'fixed');   // 'legacy' = the pre-fix definition (any non-keeper/CLI/app process in a member worktree): the proof's must-FAIL arm for the app-git injection
if (!BASE || !REPO || !APP || !CLAUDE) { console.error('usage: drive.mjs --base --repo --app --claude …'); process.exit(2); }
const KNOWN = ['douce', 'dure', 'reprise', 'auto'];
if (EXERCISES.length === 0 || EXERCISES.some((e) => !KNOWN.includes(e))) { console.error(`unknown/empty --exercise ${JSON.stringify(opt('exercise', ''))} (have ${KNOWN})`); process.exit(2); }
if (!Number.isInteger(CYCLES) || CYCLES < 1 || !Number.isInteger(MEMBERS) || MEMBERS < 1 || MEMBERS > 10) { console.error(`--cycles must be ≥ 1 and --members 1..10 (got ${CYCLES}, ${MEMBERS})`); process.exit(2); }
if (INJECT && (!['orphan-tool', 'app-git', 'late-request'].includes(INJECT) || EXERCISES.join() !== 'dure')) { console.error('--inject orphan-tool|app-git|late-request applies to `--exercise dure` only'); process.exit(2); }
if (!['member', 'legacy'].includes(WINDOW)) { console.error('--window member|legacy'); process.exit(2); }
if (!['fixed', 'legacy'].includes(TOOLPROCS)) { console.error('--toolprocs fixed|legacy'); process.exit(2); }
if (SABOTAGE && (!['branch', 'ref', 'session'].includes(SABOTAGE) || EXERCISES.join() !== 'dure')) { console.error('--sabotage branch|ref|session applies to `--exercise dure` only (anywhere else it would be a silent no-op control)'); process.exit(2); }
initBase(BASE);
preflight();
const before = liveSnapshot();
say(`LIVE-BEFORE ${JSON.stringify(before)}`);
say(`REPO=${REPO} HEAD=${git(REPO, 'rev-parse', 'HEAD')} APP=${APP} claude=${execFileSync(CLAUDE, ['--version'], { encoding: 'utf8' }).trim()} exercises=${EXERCISES} cycles=${CYCLES} members=${MEMBERS} dwell=${DWELL_S}s pause=${PAUSE_SWITCH} douce-limit=${DOUCE_LIMIT} sabotage=${SABOTAGE ?? '-'} inject=${INJECT ?? '-'} toolprocs=${TOOLPROCS} window=${WINDOW}`);

class VoidError extends Error { constructor(msg, kind = 'host') { super(msg); this.kind = kind; } }
let voidReason = null, voidKind = null;
let curRig = null, curBaselineMB = null;   // the running rig + its mid-work memory: a product-induced blow-up must not be mistaken for a busy host
const host = { minAvailGB: Infinity, maxLoad: 0, maxRigRssMB: 0, lowStreak: 0, samples: 0 };
const emit = (tag, obj) => say(`${tag} ${JSON.stringify(obj)}`);

async function runExercise(name) {
  const spec = fleetSpec(MEMBERS);
  const kindOfRole = Object.fromEntries(spec.workers.map((w) => [w.k, w.kind]));
  const quotaWorkers = spec.workers.filter((w) => w.kind === 'quota');
  const limited = new Set();
  const plan = { release: name === 'reprise' ? 'manual' : 'all', first: [] };
  const usageProbeHits = [];
  const usageHeaders = (cred) => { usageProbeHits.push({ t: Date.now(), cred }); const rs = Math.floor(Date.now() / 1000); return { 'anthropic-ratelimit-unified-5h-utilization': '0.10', 'anthropic-ratelimit-unified-5h-reset': String(rs + 3 * 3600), 'anthropic-ratelimit-unified-7d-utilization': '0.20', 'anthropic-ratelimit-unified-7d-reset': String(rs + 5 * 86400) }; };
  const resetS = Math.floor(Date.now() / 1000) + 3600;
  const api = await startApi({ decide: makeModel({ kindOfRole, plan, limited, resetS }), usageHeaders });
  const rig = await makeRig({ label: `${LABEL}-${name}`, spec, apiUrl: api.url, appBin: APP, claudeBin: CLAUDE });
  curRig = rig; curBaselineMB = null;
  say(`[${name}] RIG H=${rig.H} workers=${spec.workers.map((w) => `${w.k}:${w.kind}`).join(' ')}`);
  say(`[${name}] SEED-RUNS ${JSON.stringify(seedRuns(rig, APP_TREE, PAUSE_SWITCH === 'off' ? 'pause-off' : 'none'))}`);
  const busr = startBusReader(rig, REPO);
  const Q = (sql, ...a) => busr.q(sql, ...a);
  const nm = rig.names;
  const cycles = [];
  const wsChecks = [];   // exercise-level checks (not tied to a cycle)
  let curCyc = null;     // the cycle in flight (its checks survive a VOID / an abort)
  let lateInject = null;   // --inject late-request: the harness sends the FIRST member the host completes a human prompt (allowed in a Pause) so it makes a request inside the blind window (declared BEFORE the cycles loop: a `let` below it is in its temporal dead zone)
  const allChecks = () => [...wsChecks, ...cycles.flatMap((x) => x.checks), ...(curCyc && !cycles.includes(curCyc) ? curCyc.checks : [])];
  const reqsOf = (role, since, until = Infinity) => api.requests.filter((r) => r.role === role && r.t >= since && r.t < until && r.tools > 0).length;
  // an older app's schema lacks the wave-E columns: they read as null (absent ≠ undefined), so a pre-wave-E arm fails on its NAMED check, not on noise
  const NULL_COLS = { pause_mode: null, pause_trap_at: null, pause_deadline_at: null, pause_escalated_at: null, resume_started_at: null, pause_auto: null };
  const runRow = async (id) => { const r = (await Q('SELECT * FROM runs WHERE id = ?', id))?.[0]; return r ? { ...NULL_COLS, ...r } : null; };
  const rosterOf = async (runId, pausedAt) => (await Q('SELECT * FROM pause_members WHERE run_id = ? AND paused_at = ? ORDER BY ws_id', runId, pausedAt)) ?? [];
  const maxSeq = async () => (await Q('SELECT coalesce(max(sequence), 0) AS m FROM messages'))?.[0]?.m ?? 0;
  const storeWs = (id) => { try { return JSON.parse(fs.readFileSync(`${rig.H}/userData/orchestra/store.json`, 'utf8')).workspaces.find((w) => w.id === id); } catch { return null; } };
  const stopIfVoid = () => { if (voidReason) throw new VoidError(voidReason, voidKind ?? 'host'); };
  const waitFor = async (fn, ms = 60000, step = 250) => { const t0 = Date.now(); for (;;) { stopIfVoid(); const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
  const wtOf = (k) => rig.wt(k);
  const readWt = (k, f) => { try { return fs.readFileSync(path.join(wtOf(k), f), 'utf8'); } catch { return null; } };
  /** processes a member's Bash tool tree left alive (`isMemberTool`: in a member worktree, not its keeper / CLI / the app / an `orchestra cli` client, and not the APP's own git refresh) */
  // the pre-fix definition, kept ONLY as the proof's must-FAIL arm (`--toolprocs legacy`): anything in a member worktree that is not its keeper / CLI / the app / an `orchestra cli` client
  const legacyToolProcs = () => census(rig).filter((x) => memberOfCwd(rig, x) && !['keeper', 'claude', 'app'].includes(kindOf(x)) && !/orchestra cli /.test(x.cmd) && !/ cli /.test(x.cmd));
  const fixedToolProcs = () => { const c = census(rig); const byPid = new Map(c.map((x) => [x.pid, x])); return c.filter((x) => isMemberTool(x, byPid, kindOf, (y) => memberOfCwd(rig, y))); };
  const toolProcs = TOOLPROCS === 'legacy' ? legacyToolProcs : fixedToolProcs;
  /** per-member session identity (keeper = ppid of the member's CLI): pid + /proc start ticks */
  const identities = () => {
    const c = census(rig);
    const out = {};
    for (const p of c) {
      if (kindOf(p) !== 'claude') continue;
      const k = memberOfCwd(rig, p);
      if (!k) continue;
      const kp = c.find((x) => x.pid === p.ppid && kindOf(x) === 'keeper');
      out[k] = { claude: `${p.pid}@${p.startTicks}`, keeper: kp ? `${kp.pid}@${kp.startTicks}` : null, pid: p.pid, startTicks: p.startTicks };
    }
    return out;
  };
  /** proof-only: start the injected process(es) in w1's worktree, with the rig's ORCHESTRA_HOME in their env (so the census sees them like any rig process). */
  const injected = [];
  const injectProc = (kind) => {
    const wt = wtOf('w1');
    const env = { PATH: '/usr/bin:/bin', HOME: path.join(rig.H, 'home'), ORCHESTRA_HOME: rig.H };
    if (kind === 'orphan-tool') {
      // a real command that "came back": started in its own session, parent = this drive (outside the rig census) ⇒ an orphan from the census' point of view
      const c = spawn('setsid', ['sleep', '7403'], { cwd: wt, env, detached: true, stdio: 'ignore' }); c.unref(); injected.push(c.pid);
    } else if (kind === 'app-git') {
      // a helper whose cmdline reads as the APP (`<app> --type=…`: kindOf → 'app') running git + a child in the worktree = the shape of the app's own `git ls-files --others` (ppid = app). The trailing `:` matters: bash `-c` EXECs its last simple command, so `sleep 8` would REPLACE the helper (cmdline `sleep 8`, parent outside the rig = an orphan)
      const c = spawn('bash', ['-c', `exec -a "${rig.appBin} --type=fake-app-helper" bash -c 'git ls-files --others --exclude-standard >/dev/null; sleep 8; :'`], { cwd: wt, env, detached: true, stdio: 'ignore' }); c.unref(); injected.push(c.pid);
    }
    say(`   INJECT ${kind}: started pid ${injected[injected.length - 1]} in ${wt}`);
  };
  const sameSession = (a, b) => a && b && a.claude === b.claude && a.keeper === b.keeper;
  const check = (cyc, id, ok, detail) => { const row = { exercise: name, cycle: cyc?.cycle ?? 0, id, ok: !!ok, detail }; (cyc ? cyc.checks : wsChecks).push(row); say(`${ok ? 'ok ' : 'RED'} [${name}${cyc ? ` c${cyc.cycle}` : ''}] ${id} — ${detail}`); emit('PC-CHECK', row); };
  let app, result = 'ABORT';
  const abort = (cyc, msg) => Object.assign(new Error(msg), { cyc });
  try {
    app = await launchApp(rig);
    await sleep(3000);
    const who = await app.cli(spec.lead, ['whoami'], { run: spec.lead });
    check(null, 'cli_speaks_control', who.out.length > 0, `whoami rc=${who.code}`);
    // account B = an API-key account saved through the app's own IPC (keystore); its usage probe `POST <baseUrl>/v1/messages max_tokens:1` is answered by the fake API with quota headers
    const k = await app.cdp.eval(`window.orchestra.saveAccountApiKey(${JSON.stringify(ACCT_B)}, ${JSON.stringify(B_KEY)}).then(() => window.orchestra.saveAccountBaseUrl(${JSON.stringify(ACCT_B)}, ${JSON.stringify(api.url)})).then(() => 'saved')`).catch((e) => `ERR ${e}`);
    check(null, 'account_b_apikey_and_baseurl_saved', k === 'saved', `${k}`);
    const sendTo = (id, text) => app.cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(id)}, ${JSON.stringify(text)})`);

    for (let c = 1; c <= CYCLES; c++) {
      stopIfVoid();
      const cyc = { exercise: name, cycle: c, workers: spec.workers.length, mode: name === 'douce' ? 'soft' : 'hard', rosterMin: spec.workers.length + (name === 'auto' ? 1 : 2), checks: [] };
      curCyc = cyc;
      say(`── [${name}] cycle ${c}/${CYCLES} ──`);
      const carrier = name === 'auto' ? spec.ops : spec.lead;
      // 0. the run must be ACTIVE (the previous cycle's Reprise really lifted the gate)
      const r0 = await runRow(carrier);
      check(cyc, 'run_active_before_work', !!r0 && r0.paused_at === null && r0.resume_started_at === null, `${name === 'auto' ? 'ops' : 'lead'} run paused_at=${r0?.paused_at} resume_started=${r0?.resume_started_at}`);
      const seq0 = await maxSeq();   // this cycle's bus rows are those after it
      // 1. every worker starts real work (real keeper + real CLI + real tool processes)
      const workStart = Date.now();
      const loopLines = (kk) => (readWt(kk, `loop-${kk}.txt`) ?? '').split('\n').filter(Boolean).length;
      const loopBase = Object.fromEntries(spec.workers.map((w) => [w.k, loopLines(w.k)]));   // cycle >= 2: the previous cycle's lines must not satisfy "mid-work"
      await Promise.all(spec.workers.map((w) => sendTo(w.id, `SCN:work c${c}`)));
      const midOk = await waitFor(() => spec.workers.every((w) => {
        if (!readWt(w.k, `mark-${w.k}-c${c}.txt`)) return false;
        const tp = toolProcs().filter((p) => memberOfCwd(rig, p) === w.k);
        if (w.kind === 'blocked') return tp.some((p) => /sleep 7400/.test(p.cmd));
        if (w.kind === 'quota') return true;
        if (w.kind === 'bg') return tp.some((p) => /sleep 7402/.test(p.cmd)) && loopLines(w.k) >= loopBase[w.k] + 3;
        return loopLines(w.k) >= loopBase[w.k] + 3;
      }), 240000, 500);
      const hn = hostNow();
      const rm = rigMemory(rig);
      host.maxRigRssMB = Math.max(host.maxRigRssMB, rm.totalMB);
      curBaselineMB = rm.totalMB;
      cyc.rigMemory = { totalMB: Math.round(rm.totalMB), by: Object.fromEntries(Object.entries(rm.by).map(([kk, v]) => [kk, { n: v.n, mb: Math.round(v.mb) }])) };
      check(cyc, 'workers_mid_work', !!midOk, `${spec.workers.length} workers mid-work after ${((Date.now() - workStart) / 1000).toFixed(0)} s (${spec.workers.map((w) => `${w.k}:${w.kind}`).join(' ')}); MemAvailable ${hn.availGB.toFixed(2)} GB load ${hn.load1.toFixed(1)}; rig PSS ${rm.totalMB.toFixed(0)} MB (${Object.entries(rm.by).map(([kk, v]) => `${kk}×${v.n}=${v.mb.toFixed(0)}`).join(' ')})`);
      if (!midOk) throw abort(cyc, 'fleet never reached mid-work');
      const idPre = identities();
      // positive control of the session-identity instrument: a member whose keeper/CLI could not be read would pass every "same pid+start" comparison vacuously
      check(cyc, 'identity_instrument_armed', spec.workers.every((w) => idPre[w.k]?.claude && idPre[w.k]?.keeper), `keeper+CLI identity read for ${spec.workers.filter((w) => idPre[w.k]?.claude && idPre[w.k]?.keeper).length}/${spec.workers.length} workers`);
      const heads = Object.fromEntries(['lead', 'ops'].map((kk) => [kk, git(wtOf(kk), 'rev-parse', 'HEAD')]));
      const pre = Object.fromEntries(spec.workers.map((w) => [w.k, { head: git(wtOf(w.k), 'rev-parse', 'HEAD'), porcelain: gitSafe(wtOf(w.k), 'status', '--porcelain').split('\n').filter((l) => l && !/loop-/.test(l)).sort().join('\n') }]));
      pre.__coord = heads;
      say(`   pre: sessions with identity ${Object.keys(idPre).length}/${spec.workers.length}; tool procs ${toolProcs().length}`);

      if (name === 'douce') await doDouce(cyc, c, pre, idPre, seq0);
      else if (name === 'auto') await doAuto(cyc, c, pre, idPre, seq0);
      else await doDure(cyc, c, pre, idPre, seq0, name === 'reprise');
      cyc.checks.push(...evaluateCycle(cyc).map((kk) => { emit('PC-CHECK', { exercise: name, cycle: c, ...kk }); say(`${kk.ok ? 'ok ' : 'RED'} [${name} c${c}] ${kk.id} — ${kk.detail}`); return { exercise: name, cycle: c, ...kk }; }));
      cyc.host = { minAvailGB: host.minAvailGB, maxLoad: host.maxLoad, maxRigRssMB: host.maxRigRssMB };
      cycles.push(cyc);
      emit('PC-CYCLE', cyc);
      await sleep(2000);
    }

    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function snapshotFacts(cyc, c, pre, tP) {
      // lost work: each marker must be in the member's branch tip, its pushed branch OR the pause ref; each branch (workers AND coordinators) must still contain its pre-pause head
      const facts = [];
      const isAnc = (a, b) => { try { git(rig.repo, 'merge-base', '--is-ancestor', a, b); return true; } catch { return false; } };
      for (const w of spec.workers) {
        const refs = gitSafe(rig.repo, 'for-each-ref', '--format=%(refname)', `refs/orchestra/pause/*/${w.id}/*`).split('\n').filter((l) => l && !l.startsWith('ERR')).filter((r) => Number(r.split('/').pop()) >= tP - 2000).sort();
        const ref = refs[refs.length - 1] ?? null;
        const tip = gitSafe(rig.repo, 'rev-parse', `refs/heads/pc-${w.k}`);
        const markers = markersOf(w.k, c).map((mk) => ({ name: mk.name, needle: mk.needle, shape: mk.shape, found: { branch: gitShow(rig.repo, `refs/heads/pc-${w.k}:${mk.file}`), pushed: gitShow(rig.remote, `refs/heads/pc-${w.k}:${mk.file}`), ref: ref ? gitShow(rig.repo, `${ref}:${mk.file}`) : null } }));
        facts.push({ id: `${nm[w.id]}(${w.kind})`, ref, refCount: refs.length, branchIntact: isAnc(pre[w.k].head, tip), branchDetail: `pre ${pre[w.k].head.slice(0, 8)} tip ${tip.slice(0, 8)} ref ${ref ? ref.split('/').slice(-3).join('/') : 'NONE'}`, markers });
      }
      for (const kk of ['lead', 'ops']) { const tip = gitSafe(rig.repo, 'rev-parse', `refs/heads/pc-${kk}`); facts.push({ id: `pc-${kk}(coordinator)`, refCount: 0, branchIntact: isAnc(pre.__coord[kk], tip), branchDetail: `pre ${pre.__coord[kk].slice(0, 8)} tip ${tip.slice(0, 8)}`, markers: [] }); }
      cyc.lostWork = lostWorkOf(facts);
      cyc.lostWork.refsPerWorker = facts.filter((f) => f.markers.length).map((f) => f.refCount).join('/');
      cyc.lostWork.shapes = Object.fromEntries(['committed', 'tracked-edit', 'staged', 'untracked'].map((s) => [s, facts.flatMap((f) => f.markers).filter((m) => m.shape === s && ['branch', 'pushed', 'ref'].some((l) => typeof m.found[l] === 'string' && m.found[l].includes(m.needle))).length]));
      return facts;
    }
    async function bilanChecks(cyc, carrierRun, pausedAt) {
      const rows = (await Q('SELECT ws_id, snapshot_ref, killed_json, dirty FROM pause_records WHERE run_id = ? AND paused_at = ? AND ws_id != ? ORDER BY id', carrierRun, pausedAt ?? -1, '__pause_origin__')) ?? [];   // THIS pause epoch only (the rows of earlier cycles outlive the lift)
      const byWs = Object.fromEntries(rows.map((r) => [r.ws_id, r]));
      const missing = spec.workers.filter((w) => !byWs[w.id]?.snapshot_ref || byWs[w.id]?.killed_json === null).map((w) => nm[w.id]);
      check(cyc, 'bilan_row_per_worker', missing.length === 0, `${spec.workers.length - missing.length}/${spec.workers.length} workers have a Bilan row with a snapshot ref and a stamped kill list${missing.length ? ` — missing ${missing.join(', ')}` : ''}`);
    }
    /** a quota member hits the simulated usage limit while the run is PAUSED (a HUMAN prompt is allowed in a Pause): the Pause must stay as it was (no auto Pause on top of a manual one). Returns { qw } (only requests answering the limit prompt are exempted, by content) or null. */
    async function limitDuringPause(cyc, c, carrierRun, pausedAt, wantMode) {
      const qw = quotaWorkers[c - 1];
      if (!qw) { cyc.limitMember = 'none'; check(cyc, 'limit_member_available', false, `only ${quotaWorkers.length} quota member(s) for cycle ${c}: the drill cannot put a member on a usage limit this cycle (use --members ≥ 6 for 3 cycles)`); return null; }
      limited.add(qw.k);
      const from = Date.now();
      await sendTo(qw.id, 'SCN:limit go');   // the real CLI turns the fake unified 429 into a real rate_limit_event
      const lim = await waitFor(() => storeWs(qw.id)?.lastStopReason === 'usage_limit', 60000);
      const rN = await runRow(carrierRun);
      cyc.limitMember = qw.k;
      check(cyc, 'limit_during_pause_stays_manual', !!lim && !!rN && rN.paused_at === pausedAt && rN.pause_auto === null && (wantMode === null || rN.pause_mode === wantMode), `${qw.k}.lastStopReason=${storeWs(qw.id)?.lastStopReason}; run paused_at same=${rN?.paused_at === pausedAt} pause_mode=${rN?.pause_mode} pause_auto=${rN?.pause_auto}`);
      return { qw, from };
    }
    /** wake attempts to EVERY worker + a polling window: any request / process / session change after the trap and before the Reprise is a member that restarted ON ITS OWN */
    async function holdWindow(cyc, c, tTrapDone, idPre, carrierRun) {
      const probeResults = await Promise.all(spec.workers.map(async (w) => { const r = await app.cli(spec.ops, ['send', '--type', 'status', '--to', w.id, `hold probe ${name} c${c}`], { run: spec.ops }); return `${w.k}:rc${r.code}`; }));
      const probes = probeResults.filter((x) => x.endsWith('rc0')).length;
      const tHold0 = Date.now();
      const procEvents = [];
      let n = 0, legacySeen = false;
      if (INJECT) injectProc(INJECT);
      while (Date.now() - tHold0 < DWELL_S * 1000) {
        stopIfVoid();
        n++;
        if (!legacySeen && INJECT && legacyToolProcs().some((x) => /^sleep (7403|8)$/.test(x.cmd))) legacySeen = true;   // the injected `sleep 7403` (orphan) / `sleep 8` (app-git child) — by content, never any process
        const tp = toolProcs();
        if (tp.length) procEvents.push(...tp.map((p) => `${memberOfCwd(rig, p)}:${p.cmd.slice(0, 40)}`));
        await sleep(500);
      }
      const idNow = identities();
      const replaced = Object.keys(idPre).filter((kk) => idNow[kk] && !sameSession(idNow[kk], idPre[kk]));
      const gone = Object.keys(idPre).filter((kk) => !idNow[kk]);
      return { probes, probeNotes: probeResults, tHold0, procEvents: [...new Set(procEvents)], replaced, gone, polls: n, legacySeen };
    }
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function doReprise(cyc, c, carrierRun, epochPausedAt, hold, idPre, seq0, { manual, rosterMin, tStartOverride = null, skipIdentity = [], exempt = null }) {
      const tR = tStartOverride ?? Date.now();
      let harnessWaitMs = 0;   // fixed sleeps THIS harness inserts into the Reprise (the lead's `release --all` probe): subtracted from the published time
      if (!tStartOverride) {
        const rs = await app.cli(spec.lead, ['run', 'resume', '--run', carrierRun], { run: spec.lead });
        check(cyc, 'resume_accepted', rs.code === 0 && /REPRISE STARTED|resum|Reprise/i.test(rs.out + rs.err), `rc=${rs.code} ${(rs.out + rs.err).slice(0, 140).replace(/\n/g, ' | ')}`);
      }
      const coordRoles = carrierRun === spec.lead ? ['lead', 'ops'] : ['ops'];
      const woke = await waitFor(() => coordRoles.every((r) => reqsOf(r, tR) > 0), 90000);
      const tWoke = woke ? Date.now() - tR : null;
      check(cyc, 'coordinators_woken', !!woke, `coordinators ${coordRoles.join('+')} woken ${tWoke === null ? 'never' : `+${(tWoke / 1000).toFixed(1)} s`} after the resume`);
      const reprRows = ((await Q("SELECT sequence, recipient, sender FROM messages WHERE kind='reprise' AND sequence > ? ORDER BY sequence", seq0)) ?? []);   // THIS cycle's rows only
      const toLead = reprRows.find((m) => m.recipient === spec.lead), toOps = reprRows.find((m) => m.recipient === spec.ops);
      if (carrierRun === spec.lead) check(cyc, 'coordinators_get_bilan_top_down', !!toLead && !!toOps && toLead.sequence < toOps.sequence, `reprise rows lead #${toLead?.sequence} ops #${toOps?.sequence} (this cycle's, after #${seq0})`);
      if (manual) {
        // two batches: the OPS releases the first half only; the second half must stay silent (0 request) until released
        const half = spec.workers.slice(0, Math.ceil(spec.workers.length / 2)).map((w) => w.id);
        plan.first = half;
        await sleep(3000); harnessWaitMs += 3000;
        const leadAll = await app.cli(spec.lead, ['run', 'release', '--all', '--run', spec.lead], { run: spec.lead });   // M1 probe: an ANCESTOR's --all must not dispatch the OPS's workers
        await sleep(4000); harnessWaitMs += 4000;
        const w0 = Object.fromEntries(spec.workers.map((w) => [w.k, reqsOf(w.k, tR)]));
        check(cyc, 'lead_release_all_wakes_no_worker', spec.workers.every((w) => w0[w.k] === 0), `lead \`release --all\` rc=${leadAll.code}; worker requests since the resume: ${Object.entries(w0).map(([kk, v]) => `${kk}:${v}`).join(' ')}`);
        await sendTo(spec.ops, 'SCN:release-first go');
        const firstWoke = await waitFor(() => spec.workers.filter((w) => half.includes(w.id)).every((w) => reqsOf(w.k, tR) > 0), 120000);
        const restSilent = spec.workers.filter((w) => !half.includes(w.id)).every((w) => reqsOf(w.k, tR) === 0);
        check(cyc, 'second_batch_stays_blocked_until_released', !!firstWoke && restSilent, `first batch (${half.length}) woke=${!!firstWoke}; the other ${spec.workers.length - half.length} made ${spec.workers.filter((w) => !half.includes(w.id)).reduce((a, w) => a + reqsOf(w.k, tR), 0)} request(s) while blocked`);
        await sendTo(spec.ops, 'SCN:release-rest go');
      }
      const active = await waitFor(async () => { const r = await runRow(carrierRun); return r && r.paused_at === null && r.resume_started_at === null ? r : null; }, 180000, 250);
      const tActive = active ? Date.now() : null;
      await waitFor(async () => { const rows = await rosterOf(carrierRun, epochPausedAt); return rows.length >= rosterMin && rows.every((x) => x.reprise_confirmed_at); }, 120000, 250);
      const rows = await rosterOf(carrierRun, epochPausedAt);
      const accused = rows.filter((x) => x.reprise_confirmed_at);
      const lastAccuse = accused.length ? Math.max(...accused.map((x) => x.reprise_confirmed_at)) : null;
      cyc.rosterSize = rows.length;
      cyc.rosterMin = rosterMin;
      cyc.repriseAccused = { n: accused.length, m: rows.length, missing: rows.filter((x) => !x.reprise_confirmed_at).map((x) => nm[x.ws_id] ?? x.ws_id.slice(0, 8)) };
      cyc.tAllResumedRawS = tActive && lastAccuse && accused.length === rows.length ? (Math.max(tActive, lastAccuse) - tR) / 1000 : null;
      cyc.harnessWaitS = harnessWaitMs / 1000;
      cyc.tAllResumedS = cyc.tAllResumedRawS === null ? null : Math.max(0, cyc.tAllResumedRawS - cyc.harnessWaitS);
      check(cyc, 'run_active_after_reprise', !!active, `carrier run ${active ? 'ACTIVE' : 'still resuming/paused'} +${tActive ? ((tActive - tR) / 1000).toFixed(1) : 'never'} s`);
      // self-restarts: (a) any turn during the hold window; (b) a worker's turn BEFORE its own release; (c) tool processes back / session replaced during the hold.
      // The ONE exemption: the limited member's own request that answers the harness's human `SCN:limit` prompt (a human turn is allowed in a Pause) — a 15 s window, that member only.
      const holdMembers = [{ role: carrierRun === spec.lead ? 'lead' : 'ops', wsId: carrierRun, optional: true }, ...(carrierRun === spec.lead ? [{ role: 'ops', wsId: spec.ops, optional: true }] : []), ...spec.workers.map((w) => ({ role: w.k, wsId: w.id }))];
      const gaps = holdWindowGaps({ rows, members: holdMembers });
      check(cyc, 'hold_windows_per_member', gaps.length === 0, gaps.length ? `NO per-member hold window for ${gaps.join(' | ')} — the verdict would fall back to the run-level window (H-1 blind spot)` : `${holdMembers.length} member(s): a per-member (or by-design run-level) hold window exists for every roster row`);
      const forb = [...holdWindows({ rows, tTrapDone: hold.tTrapDone, tR, legacy: WINDOW === 'legacy', members: holdMembers }), ...spec.workers.map((w) => ({ role: w.k, from: tR, until: rows.find((x) => x.ws_id === w.id)?.released_at ?? null, label: 'before-release' }))];
      const bad = forbiddenRequests(api.requests, forb).filter((b) => !(exempt && b.role === exempt.qw.k && b.limitPrompt));   // exempt BY CONTENT: only a request that answers the harness's own `SCN:limit` human prompt (a wake of that member for any other reason still counts)
      // WORK written after the trap is unambiguous evidence of a restart (a request alone can be the documented task-notification blip: killing a BACKGROUND task makes the CLI start ONE turn that the host interrupts)
      const grew = spec.workers.filter((w) => ((readWt(w.k, `loop-${w.k}.txt`) ?? '').split('\n').filter(Boolean).length) > (cyc.loopAtTrap?.[w.k] ?? Infinity)).map((w) => `${w.k}:+${(readWt(w.k, `loop-${w.k}.txt`) ?? '').split('\n').filter(Boolean).length - cyc.loopAtTrap[w.k]} loop line(s)`);
      const restarted = new Set([...bad.map((b) => b.role), ...hold.replaced, ...hold.gone, ...hold.procEvents.map((e) => e.split(':')[0]), ...grew.map((g) => g.split(':')[0])]);
      cyc.selfRestarts = { members: [...restarted].map((kk) => `pc-${kk}`), probes: hold.probes, detail: `requests-in-forbidden-windows=${bad.length} (${bad.map((b) => `${b.role}@${((b.t - hold.tTrapDone) / 1000).toFixed(2)}s after the trap stamp/${b.window}/answered ${b.tool ?? 'text'}`).join(', ') || '-'}); work-written-after-the-trap=${grew.join(',') || 'none'}; tool-procs-back=${hold.procEvents.length}; sessions-replaced=${hold.replaced.concat(hold.gone).join(',') || '-'}; probes ${hold.probeNotes.join(' ')}${exempt ? `; exempt: ${exempt.qw.k}'s requests that answer the harness's own limit prompt` : ''}` };
      const idEnd = identities();
      const compared = Object.keys(idPre).filter((kk) => !skipIdentity.includes(kk));
      const replacedEnd = compared.filter((kk) => idEnd[kk] && !sameSession(idEnd[kk], idPre[kk]));
      check(cyc, 'sessions_intact_through_the_cycle', compared.length > 0 && replacedEnd.length === 0 && compared.every((kk) => idEnd[kk]), `${compared.length} worker keeper+CLI pairs same pid+start after the Reprise${skipIdentity.length ? ` (${skipIdentity.join(',')} excluded: its account switch legitimately restarts its session)` : ''}${replacedEnd.length ? ` — replaced: ${replacedEnd.join(',')}` : ''}${compared.filter((kk) => !idEnd[kk]).length ? ` — gone: ${compared.filter((kk) => !idEnd[kk]).join(',')}` : ''}`);
      return { tR, rows };
    }
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function waitTrap(carrierRun) {
      let toolsDeadAt = null;
      const trapRow = await waitFor(async () => {
        if (toolsDeadAt === null && toolProcs().length === 0) toolsDeadAt = Date.now();
        const r = await runRow(carrierRun);
        if (INJECT === 'late-request' && !lateInject && r?.paused_at) {
          const rows = await rosterOf(carrierRun, r.paused_at);
          const first = spec.workers.find((w) => rows.some((x) => x.ws_id === w.id && x.pause_confirm_via === 'trap' && x.pause_confirmed_at));
          if (first) { lateInject = { k: first.k, confirmedAt: rows.find((x) => x.ws_id === first.id).pause_confirmed_at, sentAt: Date.now() }; sendTo(first.id, 'SCN:late go').catch(() => {}); say(`   INJECT late-request: ${first.k} completed at ${lateInject.confirmedAt}, human prompt sent at ${lateInject.sentAt}`); }
        }
        return r?.pause_trap_at ? r : null;
      }, 120000, 50);
      if (toolsDeadAt === null) await waitFor(() => { if (toolProcs().length === 0) { toolsDeadAt = Date.now(); return true; } return false; }, 20000, 250);
      const loopAtTrap = Object.fromEntries(spec.workers.map((w) => [w.k, (readWt(w.k, `loop-${w.k}.txt`) ?? '').split('\n').filter(Boolean).length]));   // work on disk the instant the trap is seen: any growth later = a member that WORKED after the pause
      return { trapRow, toolsDeadAt, tTrap: trapRow?.pause_trap_at ?? null, loopAtTrap };
    }
    async function doDure(cyc, c, pre, idPre, seq0, staged) {
      const tP = Date.now();
      const pz = await app.cli(spec.lead, ['run', 'pause', '--hard', '--run', spec.lead], { run: spec.lead });
      check(cyc, 'pause_accepted', pz.code === 0, `rc=${pz.code} (${pz.ms} ms) ${(pz.out + pz.err).slice(0, 120).replace(/\n/g, ' | ')}`);
      if (pz.code !== 0) throw abort(cyc, 'pause refused');
      const { trapRow, toolsDeadAt, tTrap, loopAtTrap } = await waitTrap(spec.lead);
      cyc.loopAtTrap = loopAtTrap;
      cyc.tAllPausedS = tTrap && toolsDeadAt ? (Math.max(tTrap, toolsDeadAt) - tP) / 1000 : null;
      cyc.tTrapStampS = tTrap ? (tTrap - tP) / 1000 : null; cyc.tToolsDeadS = toolsDeadAt ? (toolsDeadAt - tP) / 1000 : null;
      check(cyc, 'trap_finished', !!trapRow, `trap stamped +${cyc.tTrapStampS?.toFixed(1) ?? 'never'} s; every worker tool tree gone +${cyc.tToolsDeadS?.toFixed(1) ?? 'never'} s`);
      { const alive = toolProcs(); check(cyc, 'tools_dead', alive.length === 0, `${alive.length} tool process(es) alive after the trap (${alive.map((p) => `${memberOfCwd(rig, p)}:${p.cmd.slice(0, 40)}`).join('; ')})`); }   // ONE census feeds both the verdict and the evidence
      await bilanChecks(cyc, spec.lead, trapRow?.paused_at);
      // a sabotage that did not take effect proves nothing: each one is VERIFIED (else the drive throws — never a silent green control)
      if (SABOTAGE === 'branch') {
        const bef = gitSafe(rig.repo, 'rev-parse', 'refs/heads/pc-w1');
        gitSafe(rig.repo, 'update-ref', 'refs/heads/pc-w1', git(rig.repo, 'rev-parse', 'master'));   // (`branch -f` refuses a branch checked out in a worktree)
        const aft = gitSafe(rig.repo, 'rev-parse', 'refs/heads/pc-w1');
        say(`   SABOTAGE branch: pc-w1 ${bef.slice(0, 8)} → ${aft.slice(0, 8)}`);
        if (bef === aft) throw new Error('SABOTAGE branch had no effect (the control would be vacuous)');
      }
      if (SABOTAGE === 'ref') {
        const refsW1 = gitSafe(rig.repo, 'for-each-ref', '--format=%(refname)', `refs/orchestra/pause/*/${spec.workers[0].id}/*`).split('\n').filter((l) => l && !l.startsWith('ERR'));
        for (const r of refsW1) gitSafe(rig.repo, 'update-ref', '-d', r);
        const left = gitSafe(rig.repo, 'for-each-ref', '--format=%(refname)', `refs/orchestra/pause/*/${spec.workers[0].id}/*`).split('\n').filter((l) => l && !l.startsWith('ERR'));
        say(`   SABOTAGE ref: deleted ${refsW1.length} pause ref(s) of ${spec.workers[0].k}, ${left.length} left`);
        if (refsW1.length === 0 || left.length > 0) throw new Error('SABOTAGE ref had no effect (the control would be vacuous)');
      }
      if (SABOTAGE === 'session') {
        const t = identities()[spec.workers[0].k];
        if (!t) throw new Error('SABOTAGE session: no CLI to kill (the control would be vacuous)');
        process.kill(t.pid, 'SIGTERM');   // identity just read; the rig is single-tenant
        const dead = await waitFor(() => { const n = identities()[spec.workers[0].k]; return !n || n.claude !== t.claude; }, 15000, 250);
        say(`   SABOTAGE session: SIGTERM ${spec.workers[0].k}'s CLI ${t.claude} → ${dead ? 'replaced/gone' : 'STILL THERE'}`);
        if (!dead) throw new Error('SABOTAGE session had no effect (the control would be vacuous)');
      }
      await snapshotFacts(cyc, c, pre, tP);
      const unchanged = spec.workers.filter((w) => gitSafe(wtOf(w.k), 'status', '--porcelain').split('\n').filter((l) => l && !/loop-/.test(l)).sort().join('\n') !== pre[w.k].porcelain);
      check(cyc, 'worktrees_untouched_by_pause', unchanged.length === 0 && spec.workers.every((w) => !!readWt(w.k, `mark-${w.k}-c${c}.txt`)), `worktree status identical before/after for ${spec.workers.length - unchanged.length}/${spec.workers.length} members (D4: the host never touches a worktree)${unchanged.length ? ` — changed: ${unchanged.map((w) => w.k).join(',')}` : ''}`);
      const lim = await limitDuringPause(cyc, c, spec.lead, trapRow?.paused_at, 'hard');
      const hold = await holdWindow(cyc, c, tTrap ?? Date.now(), idPre, spec.lead);
      hold.tTrapDone = tTrap ?? Date.now();
      if (INJECT === 'late-request') {
        const hit = lateInject ? api.requests.find((r) => r.role === lateInject.k && r.tools > 0 && /SCN:late/.test(r.last ?? '') && r.t >= lateInject.confirmedAt && r.t < (tTrap ?? Infinity)) : null;
        check(cyc, 'inject_lands_in_the_blind_window', !!hit, hit ? `${lateInject.k} made a request ${((hit.t - lateInject.confirmedAt) / 1000).toFixed(2)} s after ITS completion and ${(((tTrap ?? 0) - hit.t) / 1000).toFixed(2)} s BEFORE the run stamp: invisible to a run-level window` : `no request of the injected member between its completion and the run stamp (inject ${JSON.stringify(lateInject)}) — the arm proves nothing`);
      }
      if (INJECT === 'orphan-tool' || INJECT === 'app-git') check(cyc, 'inject_is_observable', hold.legacySeen === true, `the injected ${INJECT} process was seen by the LEGACY classifier during the hold (${hold.legacySeen}) — an injection nobody can see proves nothing`);
      if (lim) {
        const mg = await app.cli(spec.ops, ['migrate-account', lim.qw.id, ACCT_B], { run: spec.ops });   // the simulated account switch: from here the limited member is NOT limited
        check(cyc, 'migrate_account_accepted', mg.code === 0, `rc=${mg.code} ${(mg.out + mg.err).replace(/\n/g, ' | ').slice(0, 120)}`);
        const rM = await runRow(spec.lead);
        check(cyc, 'manual_pause_never_auto_resumed_after_switch', !!rM && rM.paused_at !== null && rM.resume_started_at === null, `after the switch: lead paused_at=${rM?.paused_at} resume_started=${rM?.resume_started_at} (a manual Pause is lifted only by \`run resume\`)`);
      }
      await doReprise(cyc, c, spec.lead, trapRow?.paused_at, hold, idPre, seq0, { manual: staged, rosterMin: cyc.rosterMin, skipIdentity: lim ? [lim.qw.k] : [], exempt: lim });
      await endOfCycleChecks(cyc, c, pre);
    }
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function doDouce(cyc, c, pre, idPre, seq0) {
      const tP = Date.now();
      const pz = await app.cli(spec.lead, ['run', 'pause', '--run', spec.lead], { run: spec.lead });
      check(cyc, 'pause_accepted', pz.code === 0 && /DOUCE/i.test(pz.out + pz.err), `rc=${pz.code} (${pz.ms} ms) ${(pz.out + pz.err).slice(0, 140).replace(/\n/g, ' | ')}`);
      if (pz.code !== 0) throw abort(cyc, 'pause douce refused');
      const row0 = await waitFor(async () => { const r = await runRow(spec.lead); return r?.paused_at ? r : null; }, 15000, 250);
      const deadlineS = row0?.pause_deadline_at && row0?.paused_at ? (row0.pause_deadline_at - row0.paused_at) / 1000 : null;
      cyc.deadlineS = deadlineS;
      let lim = null;
      if (DOUCE_LIMIT) { await sleep(6000); lim = await limitDuringPause(cyc, c, spec.lead, row0?.paused_at, 'soft'); }   // a member hits a simulated usage limit INSIDE the douce window: a manual Pause must stay manual
      const escalated = await waitFor(async () => { const r = await runRow(spec.lead); return r?.pause_escalated_at ? r : null; }, (BARS.softDeadlineS + 60) * 1000, 500);
      const tEsc = escalated?.pause_escalated_at ?? null;
      cyc.escalatedAtS = tEsc && row0?.paused_at ? (tEsc - row0.paused_at) / 1000 : null;   // from the pause the HOST wrote: the deadline is relative to it (tP also carries the CLI's ~0.3 s spawn)
      const hasBlocked = spec.workers.some((w) => w.kind === 'blocked');
      check(cyc, 'straggler_not_cut_short', !hasBlocked || (cyc.escalatedAtS !== null && cyc.escalatedAtS >= BARS.softDeadlineS - 5), `escalated at ${cyc.escalatedAtS?.toFixed(1) ?? 'never'} s with a blocked member present (deadline ${BARS.softDeadlineS} s): a straggler must not be cut short`);
      const { trapRow, toolsDeadAt, tTrap, loopAtTrap } = await waitTrap(spec.lead);
      cyc.loopAtTrap = loopAtTrap;
      cyc.tAllPausedS = tTrap && toolsDeadAt ? (Math.max(tTrap, toolsDeadAt) - tP) / 1000 : null;
      cyc.tTrapStampS = tTrap ? (tTrap - tP) / 1000 : null;
      check(cyc, 'trap_finished', !!trapRow, `escalation +${cyc.escalatedAtS?.toFixed(1) ?? 'never'} s, trap stamped +${cyc.tTrapStampS?.toFixed(1) ?? 'never'} s`);
      { const alive = toolProcs(); check(cyc, 'tools_dead', alive.length === 0, `${alive.length} tool process(es) alive after the trap (${alive.map((p) => `${memberOfCwd(rig, p)}:${p.cmd.slice(0, 40)}`).join('; ')})`); }
      const orderSeen = spec.workers.filter((w) => w.kind === 'obey' || w.kind === 'bg').map((w) => ({ k: w.k, t: api.requests.find((r) => r.role === w.k && r.order && r.t >= tP)?.t ?? null }));
      cyc.orderLatencyS = orderSeen.map((o) => (o.t ? (o.t - tP) / 1000 : null));
      check(cyc, 'order_delivered_at_tool_boundary', orderSeen.every((o) => o.t), `order seen by ${orderSeen.filter((o) => o.t).length}/${orderSeen.length} working members; latency (s) ${cyc.orderLatencyS.map((v) => v?.toFixed(1) ?? 'never').join(' ')}`);
      const roster = await rosterOf(spec.lead, trapRow?.paused_at ?? row0?.paused_at);
      const via = {};
      for (const r of roster) via[r.pause_confirm_via ?? 'none'] = (via[r.pause_confirm_via ?? 'none'] ?? 0) + (r.pause_confirmed_at ? 1 : 0);
      cyc.pauseAccused = { n: roster.filter((r) => r.pause_confirmed_at).length, m: roster.length, via };
      const wantMember = spec.workers.filter((w) => w.kind === 'obey' || w.kind === 'bg').length;
      check(cyc, 'accuses_by_kind', (via.member ?? 0) === wantMember && (via.trap ?? 0) >= (hasBlocked ? 1 : 0), `via member=${via.member ?? 0} (want ${wantMember} obeying) · host-idle=${via['host-idle'] ?? 0} · trap=${via.trap ?? 0} (the straggler) · roster ${roster.length}`);
      await bilanChecks(cyc, spec.lead, trapRow?.paused_at);
      await snapshotFacts(cyc, c, pre, tP);
      const hold = await holdWindow(cyc, c, tTrap ?? Date.now(), idPre, spec.lead);
      hold.tTrapDone = tTrap ?? Date.now();
      if (lim) {
        const mg = await app.cli(spec.ops, ['migrate-account', lim.qw.id, ACCT_B], { run: spec.ops });   // the simulated account switch: from here the limited member is NOT limited
        check(cyc, 'migrate_account_accepted', mg.code === 0, `rc=${mg.code} ${(mg.out + mg.err).replace(/\n/g, ' | ').slice(0, 120)}`);
        const rM = await runRow(spec.lead);
        check(cyc, 'manual_douce_never_auto_resumed_after_switch', !!rM && rM.paused_at !== null && rM.resume_started_at === null, `after the switch: lead paused_at=${rM?.paused_at} resume_started=${rM?.resume_started_at} (a manual Pause is lifted only by \`run resume\`)`);
      }
      await doReprise(cyc, c, spec.lead, trapRow?.paused_at ?? row0?.paused_at, hold, idPre, seq0, { manual: false, rosterMin: cyc.rosterMin, skipIdentity: lim ? [lim.qw.k] : [], exempt: lim });
      await endOfCycleChecks(cyc, c, pre);
    }
    // ─────────────────────────────────────────────────────────────────────────────────────────────────────
    async function doAuto(cyc, c, pre, idPre, seq0) {
      const qw = quotaWorkers[c - 1];
      if (!qw) { check(cyc, 'quota_member_available', false, `only ${quotaWorkers.length} quota member(s): cycle ${c} cannot run (use --members ≥ 6)`); throw abort(cyc, 'no quota member'); }
      limited.add(qw.k);
      const tL = Date.now();
      await sendTo(qw.id, 'SCN:limit go');   // the quota member's next request is answered by the unified 429 → a real rate_limit_event → the host's usage-limit stop
      const stopped = await waitFor(() => storeWs(qw.id)?.lastStopReason === 'usage_limit', 60000);
      check(cyc, 'limit_recorded_by_the_real_producer', !!stopped, `${qw.k}.lastStopReason=${storeWs(qw.id)?.lastStopReason} (a real rate_limit_event from the CLI)`);
      const paused = await waitFor(async () => { const r = await runRow(spec.ops); return r?.paused_at ? r : null; }, 60000, 250);
      let auto = null; try { auto = JSON.parse(paused?.pause_auto ?? 'null'); } catch { /* */ }
      check(cyc, 'auto_pause_dure_on_limit', !!paused && paused.pause_mode === 'hard' && /usage_limit/.test(String(paused.paused_by)) && !!auto && auto.wsIds?.includes(qw.id), `ops run paused +${paused ? ((paused.paused_at - tL) / 1000).toFixed(1) : 'never'} s after the limit prompt; mode=${paused?.pause_mode} by=${paused?.paused_by} pause_auto=${paused?.pause_auto?.slice(0, 120)}`);
      if (!paused) throw abort(cyc, 'no auto pause');
      cyc.tLimitToPauseS = (paused.paused_at - tL) / 1000;
      const tP = paused.paused_at;   // the host wrote this pause itself (no command to time): its origin is the pause row
      const { trapRow, toolsDeadAt, tTrap, loopAtTrap } = await waitTrap(spec.ops);
      cyc.loopAtTrap = loopAtTrap;
      cyc.tAllPausedS = tTrap && toolsDeadAt ? (Math.max(tTrap, toolsDeadAt) - tP) / 1000 : null;
      cyc.tTrapStampS = tTrap ? (tTrap - tP) / 1000 : null;
      check(cyc, 'trap_finished', !!trapRow, `auto Pause dure: trap stamped +${cyc.tTrapStampS?.toFixed(1) ?? 'never'} s after the pause was written; every tool tree gone +${toolsDeadAt ? ((toolsDeadAt - tP) / 1000).toFixed(1) : 'never'} s`);
      await bilanChecks(cyc, spec.ops, trapRow?.paused_at);
      await snapshotFacts(cyc, c, pre, tP - 2000);
      const hold = await holdWindow(cyc, c, tTrap ?? Date.now(), idPre, spec.ops);
      hold.tTrapDone = tTrap ?? Date.now();
      const rStill = await runRow(spec.ops);
      check(cyc, 'still_paused_after_a_tick_account_still_limited', !!rStill && rStill.paused_at === paused.paused_at && rStill.resume_started_at === null, `after ${DWELL_S} s (> 1 tick of 20 s) with the account still limited: paused_at same=${rStill?.paused_at === paused.paused_at} resume_started=${rStill?.resume_started_at}`);
      const probes0 = usageProbeHits.length;
      const tM = Date.now();
      const mg = await app.cli(spec.ops, ['migrate-account', qw.id, ACCT_B], { run: spec.ops });   // the simulated account switch
      check(cyc, 'migrate_account_accepted', mg.code === 0, `rc=${mg.code} ${(mg.out + mg.err).replace(/\n/g, ' | ').slice(0, 120)}`);
      const resumed = await waitFor(async () => { const r = await runRow(spec.ops); return r && (r.resume_started_at || r.paused_at === null) ? r : null; }, 60000, 250);
      const lat = resumed ? ((resumed.resume_started_at ?? Date.now()) - tM) / 1000 : null;
      check(cyc, 'auto_reprise_within_one_tick_of_the_switch', !!resumed && lat < 25, `auto Reprise started +${lat?.toFixed(1) ?? 'never'} s after the account switch (tick 20 s)`);
      const newProbes = usageProbeHits.slice(probes0);
      check(cyc, 'fresh_reading_of_B_was_forced', newProbes.some((h) => h.cred === B_KEY), `usage probes against the fake endpoint since THIS switch: ${newProbes.length} (x-api-key = B's key: ${newProbes.filter((h) => h.cred === B_KEY).length})`);
      await doReprise(cyc, c, spec.ops, paused.paused_at, hold, idPre, seq0, { manual: false, rosterMin: cyc.rosterMin, tStartOverride: tM, skipIdentity: [qw.k] });   // all-resumed is timed from the switch (the Reprise is the host's)
      check(cyc, 'limited_member_now_on_B_and_worked_again', storeWs(qw.id)?.accountId === ACCT_B && api.requests.some((r) => r.role === qw.k && r.cred === B_KEY && r.t >= tM), `${qw.k}.accountId=${storeWs(qw.id)?.accountId}; requests with B's key after the switch=${api.requests.filter((r) => r.role === qw.k && r.cred === B_KEY && r.t >= tM).length}`);
      await endOfCycleChecks(cyc, c, pre);
    }
    async function endOfCycleChecks(cyc, c, pre) {
      const bad = spec.workers.filter((w) => { const tip = gitSafe(rig.repo, 'rev-parse', `refs/heads/pc-${w.k}`); try { git(rig.repo, 'merge-base', '--is-ancestor', pre[w.k].head, tip); return !readWt(w.k, `mark-${w.k}-c${c}.txt`); } catch { return true; } });
      check(cyc, 'branches_and_worktrees_intact_after_reprise', bad.length === 0, `${spec.workers.length - bad.length}/${spec.workers.length} branches contain their pre-pause head and the untracked marker is still on disk after the Reprise${bad.length ? ` — ${bad.map((w) => w.k).join(',')}` : ''}`);
      check(cyc, 'killed_commands_not_rerun', !toolProcs().some((p) => /sleep 740[02]/.test(p.cmd)), 'no killed `sleep 7400/7402` is running again');
      const noRole = api.requests.filter((r) => r.tools > 0 && !r.role).length;   // the self-restart instrument keys on the role: a request it cannot attribute would be invisible to it
      check(cyc, 'every_main_request_has_a_role', noRole === 0 && api.requests.some((r) => r.tools > 0), `${api.requests.filter((r) => r.tools > 0).length} tool-carrying API requests so far, ${noRole} without a role`);
    }
    result = allChecks().every((kk) => kk.ok) && cycles.length === CYCLES ? 'PASS' : 'FAIL';
  } catch (e) {
    const partial = (why) => { if (curCyc && !cycles.includes(curCyc) && curCyc.checks.length) { if (!curCyc.checks.some((k) => k.id === 'cycle_aborted' || k.id === 'cycle_incomplete')) check(curCyc, 'cycle_incomplete', false, why); cycles.push(curCyc); emit('PC-CYCLE', { ...curCyc, aborted: true }); } };
    if (e instanceof VoidError) {
      say(`[${name}] VOID(${e.kind}) ${e.message}`);
      if (e.kind === 'blowup') check(curCyc, 'rig_memory_blowup', false, e.message);   // the RIG itself grew: a product-side defect, not a busy host
      // a RED measured before the host dipped is a real result: it must not vanish into a VOID + a clean re-run
      result = allChecks().some((kk) => !kk.ok) ? 'FAIL' : 'VOID';
      if (result === 'FAIL') partial(`cut short by a VOID (${e.message.slice(0, 120)}) after a RED was already measured`);
    } else {
      say(`[${name}] DRIVE-ERROR ${String(e.stack ?? e).slice(0, 900)}`);
      // an aborted cycle is NOT evaluated against the bars (absent metrics would paint every bar "NOT MEASURED"): it reports the abort itself
      const target = e.cyc ?? curCyc;
      if (target) check(target, 'cycle_aborted', false, String(e.message).slice(0, 200));
      partial(`aborted: ${String(e.message).slice(0, 120)}`);
      // the host guard had ALREADY fired (a CLI that timed out under load, …) and nothing but the abort's own symptoms is red: that is a VOID, not a product bug
      const symptoms = new Set(['pause_accepted', 'workers_mid_work', 'cycle_aborted', 'cycle_incomplete', 'resume_accepted', 'limit_during_pause_stays_manual']);
      result = voidReason && allChecks().filter((kk) => !kk.ok).every((kk) => symptoms.has(kk.id)) ? 'VOID' : allChecks().some((kk) => !kk.ok) ? 'FAIL' : 'ERROR';
    }
  } finally {
    try { fs.writeFileSync(`${rig.H}/api-requests.json`, JSON.stringify(api.requests)); } catch { /* */ }
    busr.close();
    const left = await teardown(rig, app);
    say(`[${name}] TEARDOWN leftover=${left.length}`);
    await api.stop();
    curRig = null; curBaselineMB = null;
    emit('PC-EXERCISE', { exercise: name, result, cycles: cycles.length, wanted: CYCLES, leftover: left.length, red: allChecks().filter((k) => !k.ok).map((k) => `${k.cycle ? `c${k.cycle} ` : ''}${k.id}`) });
  }
  return { name, result, cycles };
}

// ── host guard sampler: the OPS bar (MemAvailable ≥ 6 GB, load ≤ 20) — below it for 3 samples the drill is VOID (never a verdict),
//    unless the RIG ITSELF grew > 1.5× its mid-work footprint (+300 MB): that is the product misbehaving, reported as a RED, not hidden as host noise ─────────────────
const sampler = setInterval(() => {
  const h = hostNow();
  host.samples++; host.minAvailGB = Math.min(host.minAvailGB, h.availGB); host.maxLoad = Math.max(host.maxLoad, h.load1);
  host.lowStreak = (h.availGB < MIN_AVAIL_GB || h.load1 > MAX_LOAD) ? host.lowStreak + 1 : 0;
  if (host.lowStreak >= 3 && !voidReason) {
    let rigMB = null;
    try { rigMB = curRig ? rigMemory(curRig).totalMB : null; } catch { /* the rig is going away */ }
    const blowup = rigMB !== null && curBaselineMB !== null && rigMB > curBaselineMB * 1.5 + 300;
    voidKind = blowup ? 'blowup' : 'host';
    voidReason = `${blowup ? `the RIG grew to ${rigMB.toFixed(0)} MB (mid-work baseline ${curBaselineMB.toFixed(0)} MB) while ` : ''}host below the bar for 3 samples: MemAvailable ${h.availGB.toFixed(2)} GB (< ${MIN_AVAIL_GB}) or load ${h.load1.toFixed(1)} (> ${MAX_LOAD})${rigMB !== null ? `; rig PSS ${rigMB.toFixed(0)} MB` : ''}`;
  }
}, 5000);
const h0 = hostNow();
say(`HOST-START MemAvailable ${h0.availGB.toFixed(2)} GB load ${h0.load1.toFixed(1)} swap used ${h0.swapUsedGB.toFixed(1)} GB`);
if (h0.availGB < MIN_AVAIL_GB || h0.load1 > MAX_LOAD) { voidReason = `host below the bar at start: MemAvailable ${h0.availGB.toFixed(2)} GB (< ${MIN_AVAIL_GB}) or load ${h0.load1.toFixed(1)} (> ${MAX_LOAD})`; voidKind = 'host'; }

const results = [];
for (const ex of EXERCISES) {
  if (voidReason) { emit('PC-EXERCISE', { exercise: ex, result: 'VOID', cycles: 0, wanted: CYCLES, reason: voidReason }); results.push({ name: ex, result: 'VOID', cycles: [] }); continue; }
  results.push(await runExercise(ex));
}
clearInterval(sampler);
const after = liveSnapshot();
const same = JSON.stringify(before) === JSON.stringify(after);
say(`LIVE-AFTER same=${same}`);
const allCycles = results.flatMap((r) => r.cycles);
say(`\n${renderTable(allCycles)}\n`);
emit('PC-HOST', { minAvailGB: host.minAvailGB, maxLoad: host.maxLoad, samples: host.samples, voidReason });
if (CYCLE_RESULTS_FILE) fs.writeFileSync(CYCLE_RESULTS_FILE, JSON.stringify({ results: results.map((r) => ({ name: r.name, result: r.result, cycles: r.cycles })), host, liveUnchanged: same }, null, 1));
const verdict = results.some((r) => r.result === 'FAIL' || r.result === 'ERROR') || !same ? 'FAIL' : results.some((r) => r.result === 'VOID') ? 'VOID' : 'PASS';
say(`PAUSE-CANARY-DRIVE ${verdict} (${results.map((r) => `${r.name}:${r.result}`).join(' ')}) liveUnchanged=${same} BARS=${JSON.stringify(BARS)}`);
process.exit(0);
