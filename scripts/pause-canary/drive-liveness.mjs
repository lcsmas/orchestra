// #438-fu (ledger #443 D3) — the REAL-CLOCK liveness soak of a run of two. ONE rig = ONE drive, run INSIDE scripts/e2e-contained-rig.sh by liveness-soak.mjs:
//   node drive-liveness.mjs --base <scratch> --repo <tree> --app <packaged orchestra> --claude <claude> --arm done-idle|silent-idle|hung [--switch on|off] [--window-s 780] [--label L]
// The PACKAGED app (the only place the real activity funnel + the 60-s liveness sweep run), a plain parent P that owns its mission run + ONE child, the REAL keeper + REAL `claude` CLI against the scripted LOCAL fake API
// (zero tokens), a scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR under the rig base. Real clock: nothing is faked, the window is waited out (> STALE_AFTER_MS = 10 min + 3 sweeps).
//   done-idle    the child works 3 turns, reports `worker_done` to P, goes idle: ZERO escalation rows expected (a finished child is idle on purpose) — CLEAN iff 0
//   silent-idle  same without `worker_done`: the policy escalates ONCE once silent past the window — CLEAN iff exactly 1 staleness row (« the sweep CAN escalate this roster » — the zero's positive control)
//   hung         the child starts a foreground command and the HARNESS freezes its CLI (SIGSTOP: alive, status running, no result, no exit — the #90 wedge): MUST escalate « hung mid-call » — CLEAN iff ≥ 1 hung row
// `--switch off` freezes `liveness` OFF on the run (counted, not fired): the hung control must then go DIRTY — the control can say FAIL. Prints `LIVSOAK-RESULT {json}` and `LIVSOAK <CLEAN|DIRTY>` (the arm's own expectation met or not).
import fs from 'node:fs';
import { initBase, preflight, liveSnapshot, hostNow, startApi, makeRig, seedRuns, startBusReader, launchApp, census, kindOf, memberOfCwd, teardown, say, sleep } from './lib.mjs';
import { fleetSpec } from './ids.mjs';
import { makeModel } from './fleet.mjs';

const argv = process.argv.slice(2);
const opt = (k, d) => { const i = argv.indexOf(`--${k}`); return i >= 0 ? argv[i + 1] : d; };
const BASE = opt('base'), REPO = opt('repo'), APP = opt('app'), CLAUDE = opt('claude');
const ARM = opt('arm', 'done-idle');
const SWITCH = opt('switch', 'on');
const WINDOW_S = Number(opt('window-s', '780'));   // 10 min staleness bound + 3 sweeps of 60 s
const SABOTAGE = opt('sabotage', null);   // 'collector' = the must-FAIL arm of the end-of-window guard: the bus reader is killed before the last read — the verdict MUST be VOID, never CLEAN
const LABEL = opt('label', `liv${Date.now().toString(36).slice(-4)}`);
const STALE_S = 600;
if (!BASE || !REPO || !APP || !CLAUDE || !['done-idle', 'silent-idle', 'hung'].includes(ARM) || !['on', 'off'].includes(SWITCH)) { console.error('usage: drive-liveness.mjs --base --repo --app --claude --arm done-idle|silent-idle|hung [--switch on|off] [--window-s 780]'); process.exit(2); }
initBase(BASE);
preflight();
const before = liveSnapshot();
const spec = fleetSpec(1, undefined, { shape: 'plain', childKind: ARM });
const P = spec.ops, C = spec.workers[0];
const kindOfRole = { [C.k]: ARM };
const plan = { release: 'all', first: [], parent: P };
const api = await startApi({ decide: makeModel({ kindOfRole, plan, limited: new Set(), resetS: Math.floor(Date.now() / 1000) + 3600 }), usageHeaders: null });
const rig = await makeRig({ label: LABEL, spec, apiUrl: api.url, appBin: APP, claudeBin: CLAUDE });
say(`[${LABEL}] arm=${ARM} switch=${SWITCH} window=${WINDOW_S}s RIG H=${rig.H} parent=${P.slice(0, 8)} child=${C.id.slice(0, 8)}`);
say(`[${LABEL}] SEED ${JSON.stringify(seedRuns(rig, REPO, SWITCH === 'off' ? 'liveness-off' : 'none'))}`);
const busr = startBusReader(rig, REPO);
// the collector: a failed/hung read is `null`, NEVER an empty list (a dead collector reads as « 0 rows » — the very zero this soak asserts). Every read has a timeout; the reads are counted.
const reads = { ok: 0, failed: 0, lastOkAt: null };
const Q = async (sql, ...a) => { const r = await Promise.race([busr.q(sql, ...a), sleep(8000).then(() => null)]); if (r === null || r === undefined) reads.failed++; else { reads.ok++; reads.lastOkAt = Date.now(); } return r ?? null; };
const result = { arm: ARM, switch: SWITCH, label: LABEL, windowS: WINDOW_S, verdict: 'ERROR' };
let app, frozen = null;
const wtC = rig.wt(C.k);
const childCli = () => census(rig).find((p) => kindOf(p) === 'claude' && memberOfCwd(rig, p) === C.k) ?? null;
const waitFor = async (fn, ms, step = 500) => { const t0 = Date.now(); for (;;) { const v = await fn(); if (v) return v; if (Date.now() - t0 > ms) return null; await sleep(step); } };
try {
  app = await launchApp(rig);
  await sleep(3000);
  const who = await app.cli(P, ['whoami'], { run: P });
  if (!who.out.length) throw new Error('whoami empty');
  // the parent's DISPATCH to the child (what #435's spawn records): the child's completion is accepted only with the token it mints
  const disp = await app.cli(P, ['send', '--type', 'dispatch', '--to', C.id, 'the task of the liveness soak'], { run: P });
  result.dispatchRc = disp.code;
  if (disp.code !== 0) throw new Error(`dispatch refused rc=${disp.code} ${(disp.out + disp.err).slice(0, 160)}`);
  await sleep(4000);
  const t0 = Date.now();
  await app.cdp.eval(`window.orchestra.agentSdkSend(${JSON.stringify(C.id)}, "SCN:work c1")`);
  let tActivity = null;
  if (ARM === 'hung') {
    const hung = await waitFor(() => census(rig).find((p) => /sleep 7400/.test(p.cmd) && memberOfCwd(rig, p) === C.k), 240000);
    if (!hung) throw new Error('the child never started its long command');
    await sleep(2000);
    const cli = childCli();
    if (!cli) throw new Error('no CLI for the child');
    const st = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const f = s.slice(s.lastIndexOf(')') + 2).split(' '); return { state: f[0], ticks: Number(f[19]) }; } catch { return null; } };
    const cur = st(cli.pid);
    if (!cur || cur.ticks !== cli.startTicks) throw new Error('identity changed before the freeze');
    process.kill(cli.pid, 'SIGSTOP');
    frozen = { pid: cli.pid, ticks: cli.startTicks };
    await sleep(300);
    const after = st(cli.pid);
    result.frozen = { pid: cli.pid, state: after?.state };
    if (after?.state !== 'T') throw new Error(`the CLI is not stopped (state ${after?.state}): the control would be vacuous`);
    tActivity = Date.now();
  } else {
    const ended = await waitFor(async () => {
      const mine = api.requests.filter((r) => r.role === C.k && r.tools > 0);
      const last = mine[mine.length - 1];
      if (!last || last.tool !== null) return null;   // the turn ends with a text-only reply
      if (ARM === 'done-idle' && !(await Q("SELECT 1 AS x FROM messages WHERE kind = 'worker_done' AND sender = ?", C.id))?.length) return null;
      return last;
    }, 240000);
    if (!ended) throw new Error(`the child never finished its turns (requests ${api.requests.filter((r) => r.role === C.k).length})`);
    await sleep(4000);   // the Stop hook reaches the activity clock
    tActivity = ended.t + 4000;
  }
  result.tActivityAfterStartS = Math.round((tActivity - t0) / 1000);
  say(`[${LABEL}] child ${ARM === 'hung' ? 'FROZEN mid-call' : 'idle between turns'} at +${result.tActivityAfterStartS}s; observing until +${WINDOW_S}s of real clock (MemAvailable ${hostNow().availGB.toFixed(1)} GB)`);
  const rows = [];
  const seen = new Set();
  const deadline = tActivity + WINDOW_S * 1000;
  let polls = 0;
  while (Date.now() < deadline) {
    const r = (await Q("SELECT sequence, sender, recipient, run_id, created_at, body FROM messages WHERE kind = 'escalation' ORDER BY sequence")) ?? [];   // a null poll only costs one sample: the END-OF-WINDOW read below is the guarded one
    for (const x of r) if (!seen.has(x.sequence)) { seen.add(x.sequence); rows.push({ ...x, atS: Math.round((Date.now() - tActivity) / 1000) }); say(`[${LABEL}] ESCALATION #${x.sequence} +${rows[rows.length - 1].atS}s ${x.sender === C.id ? 'child' : x.sender === P ? 'PARENT' : x.sender}→${x.recipient === P ? 'P' : x.recipient} ${String(x.body).slice(0, 110)}`); }
    polls++;
    await sleep(5000);
  }
  // END-OF-WINDOW GUARD: one last read of the escalation rows AND a POSITIVE control — the harness' own `dispatch` row (sent at the start) must be readable: either read failing, or the dispatch row missing = the collector is dead: VOID, never CLEAN/DIRTY
  if (SABOTAGE === 'collector') { try { busr.close(); } catch { /* */ } }
  const finalEsc = await Q("SELECT sequence, sender, recipient, run_id, created_at, body FROM messages WHERE kind = 'escalation' ORDER BY sequence");
  const finalCount = await Q("SELECT COUNT(*) AS n FROM messages WHERE kind = 'dispatch'");
  const finalN = finalCount?.[0]?.n ?? null;   // the dispatch rows (≥ 1: the one this harness sent)
  const collectorOk = finalEsc !== null && finalN !== null && finalN >= 1;
  result.collector = { okReads: reads.ok, failedReads: reads.failed, finalReadAt: new Date().toISOString(), finalEscalationRows: finalEsc?.length ?? null, finalDispatchRows: finalN, ok: collectorOk, sabotage: SABOTAGE };
  if (collectorOk) for (const x of finalEsc) if (!seen.has(x.sequence)) { seen.add(x.sequence); rows.push({ ...x, atS: Math.round((Date.now() - tActivity) / 1000) }); }
  const cliNow = ARM === 'hung' ? (frozen && fs.existsSync(`/proc/${frozen.pid}`) ? 'frozen CLI still there' : 'frozen CLI GONE (the app replaced/killed it)') : (childCli() ? 'CLI alive' : 'CLI gone');
  const logs = (() => { try { return fs.readdirSync(`${rig.H}/logs`).flatMap((f) => fs.readFileSync(`${rig.H}/logs/${f}`, 'utf8').split('\n').filter((l) => /bus-liveness:/.test(l))); } catch { return []; } })();
  const bodies = rows.map((x) => String(x.body));
  const subjectIsParent = rows.some((x) => x.sender === P);
  const toP = rows.every((x) => x.recipient === P && x.run_id === P);
  let clean, why;
  if (ARM === 'done-idle') { clean = rows.length === 0; why = `${rows.length} escalation row(s) over ${WINDOW_S}s of real clock after the child went idle (expected 0)`; }
  else if (ARM === 'silent-idle') { clean = rows.length === 1 && /no session activity for \d+m/.test(bodies[0]) && toP && !subjectIsParent && rows[0].atS >= STALE_S - 30; why = `${rows.length} row(s); first at +${rows[0]?.atS ?? 'never'}s (expected exactly 1 staleness row to P at ≥ ${STALE_S} s)`; }
  else { clean = rows.length >= 1 && /hung mid-call/.test(bodies[0]) && toP && !subjectIsParent && rows[0].atS >= STALE_S - 30; why = `${rows.length} row(s); first at +${rows[0]?.atS ?? 'never'}s (expected a « hung mid-call » row to P at ≥ ${STALE_S} s)`; }
  if (!collectorOk) { clean = false; why = `COLLECTOR DEAD at the end of the window (final escalation read ${finalEsc === null ? 'FAILED' : 'ok'}, dispatch-row read ${finalN ?? 'FAILED'}, failed reads ${reads.failed}) — a zero would be unproven: VOID`; }
  Object.assign(result, { verdict: !collectorOk ? 'VOID' : clean ? 'CLEAN' : 'DIRTY', why, rows: rows.map((x) => ({ seq: x.sequence, atS: x.atS, sender: x.sender === C.id ? 'child' : x.sender === P ? 'parent' : x.sender, to: x.recipient === P ? 'P' : x.recipient, run: x.run_id === P ? 'P' : x.run_id, body: String(x.body).slice(0, 140) })), polls, cliNow, livenessLog: logs.slice(-6).map((l) => l.slice(-170)), childRequests: api.requests.filter((r) => r.role === C.k).length, minAvailGB: hostNow().availGB });
} catch (e) {
  result.verdict = 'ERROR';
  result.error = String(e?.message ?? e).slice(0, 300);
  say(`[${LABEL}] DRIVE-ERROR ${String(e?.stack ?? e).slice(0, 600)}`);
} finally {
  if (frozen) { try { process.kill(frozen.pid, 'SIGCONT'); } catch { /* gone */ } }
  try { fs.writeFileSync(`${rig.H}/api-requests.json`, JSON.stringify(api.requests)); } catch { /* */ }
  busr.close();
  const left = await teardown(rig, app);
  result.leftover = left.length;
  await api.stop();
  const after = liveSnapshot();
  result.liveUnchanged = JSON.stringify(before) === JSON.stringify(after);
}
say(`LIVSOAK-RESULT ${JSON.stringify(result)}`);
say(`LIVSOAK ${result.verdict}${result.verdict === 'ERROR' ? ` (${result.error})` : ` — ${result.why}`} liveUnchanged=${result.liveUnchanged} leftover=${result.leftover}`);
process.exit(0);
