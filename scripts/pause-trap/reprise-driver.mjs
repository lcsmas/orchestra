// The structured-Reprise rig's CONTAINER ENTRY (#255, wave E ledger #276 G3, E2): runs INSIDE `bwrap --unshare-net --unshare-pid` (see reprise-run.mjs).
// Hosts the scripted fake API, starts the main-process stand-in (app.mjs: REAL store/bus/agent-sdk/keeper/pause-trap + reprise sweep wiring) and drives
// the fleet lead ⊃ ops ⊃ {w1, w2} through `cycles` × pause → resume → release → confirm with the REAL built CLI and REAL `claude` sessions on the fake API.
// Prints ONE JSON line: {"pause_reprise":true, arm, mutant, checks:[{id,ok,detail}], ok}.
//
// Who does what (nothing here is simulated by the rig except what a human/agent would type):
//   rig (human path, `--as lead`)   orchestra run pause --hard / run resume                 (the LEAD's verbs; the lead has no session)
//   ops's OWN session tool          orchestra run release --all                              (scripted by the fake API; identity = the session's env)
//   w1 / w2 / ops OWN session tool  orchestra run confirm reprise                           (the reprise accusé)
//   rig, as lead                    orchestra run confirm reprise                            (the lead's accusé)
//   "the wake"                      an AUTO send to a member (what bus-wake would do): accepted for a RELEASED member, refused for a blocked one
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.PT_CONFIG ?? '{}');
const { REPO, root, mutant = null, apiPort, cycles = 1, restartAt = null, repause = false } = cfg;
const HERE = path.join(REPO, 'scripts', 'pause-trap');
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const CLI_JS = path.join(REPO, 'dist-electron', 'cli.js');
const WT = { lead: path.join(root, 'wt-lead'), ops: path.join(root, 'wt-ops'), w1: path.join(root, 'wt-w1'), w2: path.join(root, 'wt-w2') };
const checks = [];
const check = (id, ok, detail = '') => { checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 700) }); return !!ok; };
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(fn, ms, what) {
  const end = Date.now() + ms;
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timeout waiting for ${what} (${ms} ms)`);
    await sleep(100);
  }
}
/** A wait that never throws: null on timeout (the caller records a RED check and the rig keeps going — a must-FAIL arm has to finish to name its check). */
const soft = (fn, ms, what) => waitFor(fn, ms, what).catch(() => null);

// ── /proc helpers (as driver.mjs) ───────────────────────────────────────────
function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const rest = stat.slice(rp + 2).split(' ');
    let argv = [];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* */ }
    return { pid, comm: stat.slice(stat.indexOf('(') + 1, rp), state: rest[0], ppid: Number(rest[1]), start: Number(rest[19]), argv };
  } catch { return null; }
}
const allProcs = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map((n) => readProc(Number(n))).filter(Boolean);
const live = (p) => p && p.state !== 'Z';
const sleepers = (n) => allProcs().filter((p) => live(p) && p.comm === 'sleep' && p.argv[1] === String(n));
const keeperProc = (ws) => allProcs().find((p) => live(p) && p.argv.some((a) => a.endsWith('keeper.js')) && p.argv.includes(ws));
const cliProcOf = (keeperPid) => allProcs().find((p) => live(p) && p.ppid === keeperPid && /claude/.test(p.argv[0] ?? ''));
const alive = (pid, start) => { const p = readProc(pid); return !!p && p.state !== 'Z' && (start === undefined || p.start === start); };

function fingerprint(dir) {
  const gitDir = execFileSync('git', ['rev-parse', '--absolute-git-dir'], { cwd: dir, encoding: 'utf8' }).trim();
  const lines = [];
  const walk = (d, rel) => {
    for (const name of fs.readdirSync(d).sort()) {
      if (rel === '' && name === '.git') continue;
      const p = path.join(d, name); const r = rel ? `${rel}/${name}` : name;
      const st = fs.lstatSync(p, { bigint: true });
      if (st.isDirectory()) { lines.push(`D ${r}`); walk(p, r); }
      else lines.push(`F ${r} ${st.mode} ${st.size} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  const idx = path.join(gitDir, 'index');
  lines.push(`INDEX ${crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex')}`);
  lines.push(`HEAD ${fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8')}`);
  lines.push(`HEADS ${execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { cwd: dir, encoding: 'utf8' })}`);
  return lines.join('\n');
}
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

// ── scenarios the fake API plays ────────────────────────────────────────────
const BASH = (command, extra = {}) => ({ tool: { name: 'Bash', input: { command, description: 'pause-reprise rig', timeout: 600000, ...extra } } });
/** Distinct sleep markers per cycle: a stale process of cycle c can never be mistaken for cycle c+1's. */
const M = (c) => ({ bg: 7740 + 10 * c, orphan: 7741 + 10 * c, fg1: 7742 + 10 * c, fg2: 7743 + 10 * c });
const SCENARIOS = {
  opsidle: [{ text: 'ready' }],
  // the OPS's own tool releases its wave (identity = the session's ORCHESTRA_WS_ID env) — what the OPS agent does after reading its Bilan row
  rel: [BASH(`node ${CLI_JS} run release --all --run ops`), { text: 'released' }],
  // a member's reprise accusé from its own tool
  conf: [BASH(`node ${CLI_JS} run confirm reprise`), { text: 'confirmed' }],
  // a long command in the RELEASED coordinator's session, to be caught by a re-Pause (repause arm)
  opsbusy: [BASH('sleep 7790'), { text: 'done' }],
  probew1: [{ text: 'probe' }],
  probew2: [{ text: 'probe' }],
};
for (let c = 0; c < Math.max(cycles, 1); c++) {
  const m = M(c);
  // w1: a background task + an orphan that outlives its shell + a blocking command; w2: one blocking command
  SCENARIOS[`w1c${c}`] = [BASH(`sleep ${m.bg}`, { run_in_background: true }), BASH(`python3 -c "import subprocess; subprocess.Popen(['sleep','${m.orphan}'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)"; sleep ${m.fg1}`), { text: 'done' }];
  SCENARIOS[`w2c${c}`] = [BASH(`sleep ${m.fg2}`), { text: 'done' }];
}

const { startScriptedApi } = await import(`${HERE}/fake-api.mjs`);
const api = await startScriptedApi({ apiPort, scenarios: SCENARIOS });

// ── app processes ───────────────────────────────────────────────────────────
function startApp(phase, extra = {}) {
  const env = { PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'dumb', PT_CONFIG: JSON.stringify({ ...cfg, phase, apiUrl: api.url, ...extra }) };
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=UNDICI-EHPA', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(HERE, 'app.mjs')],
    { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const a = { child, events: [], replies: [], err: '', exited: false };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); (o.reply ? a.replies : a.events).push(o); } catch { /* non-json */ } } });
  child.stderr.on('data', (d) => { a.err += d; });
  child.on('close', () => { a.exited = true; });
  a.send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  a.waitEv = (pred, ms, what) => waitFor(() => a.events.find(pred) ?? (a.exited ? (() => { throw new Error(`app exited while waiting for ${what}: ${a.err.slice(-500)}`); })() : null), ms, what);
  /** Send a command and wait for ITS reply (`{reply: cmd, ...}` or `{reply:'error', cmd}`). */
  a.ask = async (o, ms = 30_000) => {
    const before = a.replies.length;
    a.send(o);
    const r = await soft(() => a.replies.slice(before).find((x) => x.reply === o.cmd || (x.reply === 'error' && x.cmd === o.cmd)), ms, `reply to ${o.cmd}`);
    return r ?? { reply: 'timeout' };
  };
  return a;
}

// ── the REAL built CLI ──────────────────────────────────────────────────────
function cli(args, ws = null) {
  const r = spawnSync(process.execPath, [CLI_JS, ...args], {
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orchHome, LANG: 'C.UTF-8', ...(ws ? { ORCHESTRA_WS_ID: ws } : {}) }, encoding: 'utf8', timeout: 60_000,
  });
  return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? ''), stdout: r.stdout ?? '' };
}
const runStatus = (run = 'lead') => { const r = cli(['run', 'status', '--run', run, '--json']); try { return { ...JSON.parse(r.stdout), rc: r.rc }; } catch { return { rc: r.rc, raw: r.out }; } };
/** The bus rows of `kind` addressed to `ws` in `run` (`orchestra check`), then ACKED: an unacked lot is REPLAYED, so a later cycle would read this cycle's rows. */
const rowsFor = (run, ws, kind) => {
  const r = cli(['check', '--run', run, '--as', ws]);
  try {
    const lot = JSON.parse(r.stdout);
    if (lot.lot !== null && lot.lot !== undefined) cli(['ack', '--run', run, '--as', ws, String(lot.lot)]);
    return (lot.messages ?? []).filter((m) => m.kind === kind);
  } catch { return []; }
};

const result = { pause_reprise: true, arm: cfg.arm, mutant, cycles, restartAt };
const apps = [];
const app = () => apps[apps.length - 1];
let broken = false; // an earlier check of this cycle failed: later waits are short (the named check is what a must-FAIL arm needs)
const T = (ms) => (broken ? Math.min(ms, 8_000) : ms);
const ident = {}; // keeper + CLI identities of w1/w2 at the first pause: the SAME processes must answer after every Reprise (no restart)
try {
  // 0. fleet up: w1 + w2 each mid-turn on a long command, ops with an idle live session
  const app1 = startApp('first', { scenario: 'w1c0', w2Scenario: 'w2c0', opsScenario: 'opsidle' });
  apps.push(app1);
  await app1.waitEv((e) => e.ev === 'sent', 150_000, 'the first turns to be sent');

  for (let c = 0; c < Math.max(cycles, 1); c++) {
    const P = `c${c}:`;
    const m = M(c);
    broken = false;
    const ok = (id, cond, detail) => { const r = check(`${P}${id}`, cond, detail); if (!r) broken = true; return r; };
    const expectWork = { w1: { a: `W1-C${c}-EDIT`, u: `W1-C${c}-UNTRACKED` }, w2: { a: `W2-C${c}-EDIT`, u: `W2-C${c}-UNTRACKED` } };

    // 1. each worker mid-command, each with its OWN uncommitted work
    if (c > 0) {
      for (const w of ['w1', 'w2']) {
        fs.writeFileSync(path.join(WT[w], 'a.txt'), `${expectWork[w].a}\n`);
        fs.writeFileSync(path.join(WT[w], 'untracked.txt'), `${expectWork[w].u}\n`);
        await app().ask({ cmd: 'human-send', ws: w, text: `SCN:${w}c${c}` });
      }
    } else {
      expectWork.w1 = { a: 'UNCOMMITTED-EDIT', u: 'UNTRACKED-WORK' };
      expectWork.w2 = { a: 'W2-UNCOMMITTED-EDIT', u: 'W2-UNTRACKED-WORK' };
    }
    const upAll = await soft(() => [m.bg, m.orphan, m.fg1, m.fg2].every((n) => sleepers(n).length >= 1), 120_000, `tool processes ${Object.values(m).join(',')}`);
    ok('tool_procs_present_before_pause', !!upAll, `markers ${Object.values(m).join(',')} alive (positive control: the real CLI really spawned the real tools)`);
    const keepers = {}, clis = {};
    for (const w of ['w1', 'w2']) {
      keepers[w] = await soft(() => keeperProc(w), 10_000, `keeper ${w}`);
      clis[w] = keepers[w] && (await soft(() => cliProcOf(keepers[w].pid), 10_000, `CLI of ${w}`));
      if (c === 0 && keepers[w] && clis[w]) ident[w] = { keeper: { pid: keepers[w].pid, start: keepers[w].start }, cli: { pid: clis[w].pid, start: clis[w].start } };
    }
    if (c === 0) await sleep(1500);
    const fp0 = { w1: fingerprint(WT.w1), w2: fingerprint(WT.w2) };
    await sleep(800);
    ok('fingerprint_is_stable_control', fp0.w1 === fingerprint(WT.w1) && fp0.w2 === fingerprint(WT.w2), 'two reads of the unpaused worktrees agree (the instrument is deterministic)');

    // 2. PAUSE (the real built CLI, the LEAD's handle), the host trap finishes
    const tPause = Date.now();
    const p = cli(['run', 'pause', '--hard', '--run', 'lead', '--as', 'lead']);
    ok('cli_pause_accepted', p.rc === 0 && /PAUSED/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 160)}`);
    const trapped = await soft(() => { const s = runStatus('lead'); return s.pause?.trapAt ? s : null; }, T(120_000), 'pause_trap_at to be stamped');
    ok('trap_finished', !!trapped, trapped ? `trap done ${Date.now() - tPause} ms after the pause` : 'never stamped');
    await sleep(1200);
    const leftover = [m.bg, m.orphan, m.fg1, m.fg2].filter((n) => sleepers(n).length > 0);
    ok('no_surviving_tool_procs', leftover.length === 0, leftover.length ? `still alive: sleep ${leftover.join(',')}` : `sleep ${Object.values(m).join(',')} all gone`);
    ok('cli_and_keeper_alive', ['w1', 'w2'].every((w) => ident[w] && alive(ident[w].keeper.pid, ident[w].keeper.start) && alive(ident[w].cli.pid, ident[w].cli.start)), 'the same keeper + CLI of w1 and w2 are alive (the session is never stopped)');
    const bilan = (ws) => trapped?.bilan?.find((r) => r.wsId === ws);
    let refOf = {};
    let refsOk = true; const refDetail = [];
    for (const w of ['w1', 'w2']) {
      const ref = bilan(w)?.snapshotRef ?? null;
      refOf[w] = ref;
      try {
        const a = ref ? gitOut(WT[w], 'show', `${ref}:a.txt`) : null; const u = ref ? gitOut(WT[w], 'show', `${ref}:untracked.txt`) : null;
        const good = !!ref && /^refs\/orchestra\/pause\/lead\/(w1|w2)\/\d+$/.test(ref) && a === expectWork[w].a && u === expectWork[w].u;
        refsOk = refsOk && good; refDetail.push(`${w}: ${ref} a=${JSON.stringify(a)} u=${JSON.stringify(u)}`);
      } catch (e) { refsOk = false; refDetail.push(`${w}: ${ref}: ${String(e.message).slice(0, 120)}`); }
    }
    ok('pause_ref_holds_uncommitted_work', refsOk, refDetail.join(' | '));
    ok('snapshot_no_touch', fingerprint(WT.w1) === fp0.w1 && fingerprint(WT.w2) === fp0.w2, 'both worktrees (contents, REAL index, HEAD, branches) are byte-identical after the Pause');
    const killedW1 = (bilan('w1')?.killed?.killed ?? []).map((k) => k.cmd);

    // (restart variant A) the app DIES during the Pause; the Reprise starts while it is DOWN (the verbs are store-less)
    if (restartAt === 'pause' && c === 0) {
      app().child.kill('SIGKILL');
      await waitFor(() => app().exited, 10_000, 'the app to die');
      await sleep(1200);
      ok('keepers_survive_app_death_control', ['w1', 'w2'].every((w) => ident[w] && alive(ident[w].keeper.pid, ident[w].keeper.start) && alive(ident[w].cli.pid, ident[w].cli.start)), 'keepers and CLIs outlived the app');
    }

    // 3. RESUME = start the structured Reprise
    const tResume = Date.now();
    const reqBase = api.requests.length;
    const r = cli(['run', 'resume', '--run', 'lead', '--as', 'lead']);
    ok('resume_started', r.rc === 0 && /REPRISE STARTED/.test(r.out), `rc=${r.rc} ${r.out.trim().slice(0, 200)}`);
    if (restartAt === 'pause' && c === 0) {
      const s0 = runStatus('lead');
      ok('reprise_began_while_app_down', !!s0.reprise && s0.reprise.phase === 'resuming', `run status (store-less, app DOWN): ${JSON.stringify(s0.reprise ?? null)}`);
      const app2 = startApp('second');
      apps.push(app2);
      await app2.waitEv((e) => e.ev === 'trap-started', 120_000, 'app2 boot');
    }
    const view = await soft(() => { const s = runStatus('lead'); return s.reprise ? s.reprise : null; }, T(30_000), 'the Reprise view');
    ok('coordinators_released_workers_blocked', !!view && view.phase === 'resuming' && view.total === 4 && view.released === 2 && JSON.stringify([...view.blocked].sort()) === '["w1","w2"]',
      `view=${JSON.stringify(view)} — lead + ops released by the host, w1 + w2 still blocked`);
    const rows0 = rowsFor('lead', 'lead', 'reprise');
    ok('coordinator_bilan_row', rows0.length >= 1 && rows0[0].sender === 'host' && /coordinator of run lead/.test(rows0[0].body) && /• ops /.test(rows0[0].body), `lead received ${rows0.length} reprise row(s) from ${rows0[0]?.sender}: ${(rows0[0]?.body ?? '').split('\n').filter((l) => /^  • |^Bilan de pause/.test(l)).join(' ⏎ ').slice(0, 400)}`);

    if (restartAt === 'resuming' && c === 0) {
      await sleep(1500);
      app().child.kill('SIGKILL');
      await waitFor(() => app().exited, 10_000, 'the app to die');
      await sleep(1200);
      const app2 = startApp('second');
      apps.push(app2);
      await app2.waitEv((e) => e.ev === 'trap-started', 120_000, 'app2 boot');
    }
    await sleep(2500); // the host sweep settles (boot drain + bus watch)

    // 4. NO MASS WAKE: an AUTO start (what a réveil does) is refused for the BLOCKED workers; nothing of theirs runs
    const probes = {};
    for (const w of ['w1', 'w2']) probes[w] = await app().ask({ cmd: 'auto-send', ws: w, text: `SCN:probe${w}` });
    await sleep(2500);
    const newReq = api.requests.slice(reqBase);
    const wakeLeak = newReq.filter((q) => /^probew|^w[12]c\d+$/.test(q.scn ?? ''));
    const turnsW = app().events.filter((e) => (e.ws === 'w1' || e.ws === 'w2') && e.t >= tResume && e.ev === 'turn-end');
    const freshProcs = [m.bg, m.orphan, m.fg1, m.fg2].filter((n) => sleepers(n).length > 0);
    ok('workers_blocked_no_mass_wake',
      ['w1', 'w2'].every((w) => probes[w].reply === 'error' && /run en pause/.test(probes[w].error ?? '')) && wakeLeak.length === 0 && turnsW.length === 0 && freshProcs.length === 0,
      `w1: ${probes.w1.reply === 'error' ? String(probes.w1.error).slice(0, 80) : `NOT REFUSED (${probes.w1.reply})`} · w2: ${probes.w2.reply === 'error' ? String(probes.w2.error).slice(0, 80) : `NOT REFUSED (${probes.w2.reply})`} · API requests for w1/w2 since the resume: ${wakeLeak.length} · turns ended: ${turnsW.length} · tool procs alive: ${freshProcs.length}`);

    // 4a. review M1: the LEAD's own `release --all` (the path the host's message recommends) must NOT dispatch the OPS's workers: `--all` = the caller's OWN run only
    const leadAll = cli(['run', 'release', '--all', '--run', 'lead'], 'lead');
    const afterLeadAll = runStatus('lead').reprise;
    ok('lead_release_all_leaves_the_ops_workers', leadAll.rc === 0 && /belong to a run BELOW yours/.test(leadAll.out) && !!afterLeadAll && afterLeadAll.phase === 'resuming' && JSON.stringify([...afterLeadAll.blocked].sort()) === '["w1","w2"]',
      `lead \`release --all\`: rc=${leadAll.rc} ${leadAll.out.trim().slice(0, 140).replace(/\n/g, ' | ')} · roster still blocked: ${JSON.stringify(afterLeadAll?.blocked ?? null)}`);

    // 4b. (repause arm) a Pause landing WHILE RESUMING: the released OPS is mid-command; the re-Pause opens a NEW epoch whose host trap must really act on it
    if (repause && c === 0) {
      const epoch1 = view?.pausedAt ?? 0;
      const busy = await app().ask({ cmd: 'auto-send', ws: 'ops', text: 'SCN:opsbusy' });
      const busyUp = busy.reply === 'auto-send' && !!(await soft(() => sleepers(7790).length >= 1, T(60_000), 'the released OPS to start its long command'));
      ok('repause_ops_busy_control', busyUp, 'the released OPS is mid-command (sleep 7790): it runs through a re-Pause unless the host trap really acts');
      await sleep(1500);
      const rp = cli(['run', 'pause', '--hard', '--run', 'lead', '--as', 'lead']);
      ok('repause_accepted', rp.rc === 0 && /PAUSED/.test(rp.out), `rc=${rp.rc} ${rp.out.trim().slice(0, 120)}`);
      const st2 = await soft(() => { const x = runStatus('lead'); return x.pause && !x.pause.resumeStartedAt && x.pause.pausedAt > epoch1 && x.pause.trapAt ? x : null; }, T(90_000), 'the NEW epoch trap');
      ok('repause_new_epoch_trapped', !!st2, st2 ? `new epoch ${st2.pause.pausedAt} > ${epoch1}, trap done ${st2.pause.trapAt - st2.pause.pausedAt} ms after it` : `status: ${JSON.stringify(runStatus('lead').pause ?? null)}`);
      const opsRow2 = st2?.bilan?.find((r) => r.wsId === 'ops');
      ok('repause_trap_acted_on_released_member', sleepers(7790).length === 0 && !!opsRow2?.snapshotRef && opsRow2.activity?.turnRunning === true, `sleep 7790 alive=${sleepers(7790).length >= 1} · ops Bilan (new epoch): ref ${opsRow2?.snapshotRef} turnRunning=${opsRow2?.activity?.turnRunning} interrupt=${opsRow2?.activity?.interrupt}`);
      const again = await app().ask({ cmd: 'auto-send', ws: 'ops', text: 'SCN:opsidle' });
      ok('repause_blocks_released_coordinator_again', again.reply === 'error' && /run en pause/.test(again.error ?? ''), `AUTO send to the (formerly released) OPS: ${again.reply === 'error' ? String(again.error).slice(0, 70) : `NOT REFUSED (${again.reply})`}`);
      for (const w of ['w1', 'w2']) refOf[w] = st2?.bilan?.find((r) => r.wsId === w)?.snapshotRef ?? null; // the refs of the NEW epoch (the Consigne names these)
      const r2 = cli(['run', 'resume', '--run', 'lead', '--as', 'lead']);
      ok('repause_second_reprise_started', r2.rc === 0 && /REPRISE STARTED/.test(r2.out), `rc=${r2.rc} ${r2.out.trim().slice(0, 100)}`);
      await sleep(2500);
    }

    // 5. the released COORDINATOR may start (the wake of a coordinator): it releases its wave from ITS OWN tool
    const tOps = Date.now();
    const sentOps = await app().ask({ cmd: 'auto-send', ws: 'ops', text: 'SCN:rel' });
    ok('ops_coordinator_may_start', sentOps.reply === 'auto-send', `AUTO send to the released OPS: ${sentOps.reply === 'auto-send' ? 'accepted' : `${sentOps.reply} ${String(sentOps.error ?? '').slice(0, 100)}`}`);
    const active = await soft(() => { const s = runStatus('lead'); return s.reprise?.phase === 'active' && s.reprise.released === 4 ? s : null; }, T(90_000), 'the OPS to release its wave (run ACTIVE)');
    // positive control: the model really got the tool RESULT back (step 1 of `rel` served) — the release came from the OPS's own Bash tool, not from the rig
    const relServed = !!(await soft(() => api.requests.some((q) => q.scn === 'rel' && q.idx === 1), T(20_000), 'the model to see the release tool result'));
    ok('ops_releases_via_its_own_tool', !!active && relServed, active ? `${Date.now() - tOps} ms after the OPS was woken: roster ${JSON.stringify(active.reprise)}; its Bash tool ran and the model saw the result: ${relServed}` : `run status: ${JSON.stringify(runStatus('lead').reprise ?? null)}`);
    const relRows = { w1: rowsFor('ops', 'w1', 'reprise'), w2: rowsFor('ops', 'w2', 'reprise') };
    /** Which literal fields of `w`'s Consigne are missing ([] = all present): the ref, the dirty tree, the killed section, each expected killed command, the sender. */
    const missing = (w, killedCmds, abortedCmds = []) => {
      const row = relRows[w][0];
      const body = row?.body ?? '';
      const need = [[`Snapshot ref: ${refOf[w]}`, 'snapshot ref'], ['Dirty tree: YES', 'dirty tree'], ['Commands killed by the ', 'killed section'], ...killedCmds.map((k) => [`- ${k}`, `killed ${k}`]), ...abortedCmds.map((k) => [k, `aborted in-flight ${k}`])];
      return [...(row ? [] : ['no reprise row']), ...(row && row.sender !== 'ops' ? [`sender ${row.sender}`] : []), ...need.filter(([n]) => !body.includes(n)).map(([, label]) => label), ...(killedCmds.length && !body.includes('NOT re-run') ? ['"NOT re-run"'] : [])];
    };
    // M2: a FOREGROUND command dies with the interrupt (the host trap kills nothing for it): the Consigne must still name it as an in-flight call the interrupt ABORTED
    const m1 = missing('w1', [`sleep ${m.bg}`, `sleep ${m.orphan}`], [`sleep ${m.fg1}`, 'IN FLIGHT']), m2 = missing('w2', [], [`Bash: sleep ${m.fg2}`, 'IN FLIGHT']);
    // a COMPLETED background Bash call is no in-flight call: the IN FLIGHT section holds exactly the ONE foreground command per member (w1's `sleep bg`/orphan are listed as KILLED, never as aborted)
    const inFlightOf = (w) => { const lines = (relRows[w][0]?.body ?? '').split('\n'); const i = lines.findIndex((l) => l.startsWith('Calls IN FLIGHT')); return i < 0 ? [] : lines.slice(i + 1).filter((l, j, a) => a.slice(0, j).every((x) => x.startsWith('  - ')) && l.startsWith('  - ')); };
    const f1 = inFlightOf('w1'), f2 = inFlightOf('w2');
    ok('consigne_in_flight_exact', f1.length === 1 && f2.length === 1 && f1[0].includes(`sleep ${m.fg1}`) && f2[0].includes(`sleep ${m.fg2}`) && !f1[0].includes(`sleep ${m.bg}`),
      `IN FLIGHT section: w1 ${JSON.stringify(f1.map((l) => l.slice(0, 70)))} · w2 ${JSON.stringify(f2.map((l) => l.slice(0, 70)))} — exactly one foreground call each, no completed background call`);
    ok('consigne_literal_fields', m1.length === 0 && m2.length === 0,
      `Bilan in-flight w1=${JSON.stringify((trapped?.bilan?.find((r) => r.wsId === 'w1')?.activity?.inFlightTools ?? []).map((t) => [t.tool, t.input ?? null]))} w2=${JSON.stringify((trapped?.bilan?.find((r) => r.wsId === 'w2')?.activity?.inFlightTools ?? []).map((t) => [t.tool, t.input ?? null]))} · w1 Consigne (${refOf.w1}) missing [${m1.join(', ')}], listing ${(relRows.w1[0]?.body.match(/^  - .*/gm) ?? []).map((l) => l.slice(0, 60)).join(' | ')} · w2 Consigne (${refOf.w2}) missing [${m2.join(', ')}]`);

    // 6. the members come back (the wake of a released member) and confirm FROM THEIR OWN TOOLS; the lead confirms as lead
    for (const ws of ['w1', 'w2', 'ops']) {
      const t = Date.now();
      const sent = await app().ask({ cmd: 'auto-send', ws, text: 'SCN:conf' });
      if (sent.reply !== 'auto-send') ok(`${ws}_wake_after_release`, false, `AUTO send refused: ${String(sent.error ?? sent.reply).slice(0, 120)}`);
      await soft(() => app().events.find((e) => e.ev === 'turn-end' && e.ws === ws && e.t >= t), T(60_000), `${ws}'s confirm turn`);
    }
    const mid = await soft(() => { const s = runStatus('lead'); return s.reprise?.done === 3 ? s.reprise : null; }, T(30_000), '3/4 accusés');
    ok('repris_n_of_m_visible', !!mid && mid.total === 4 && JSON.stringify(mid.missing) === '["lead"]', `after w1+w2+ops confirmed: ${JSON.stringify(mid)} — "3/4 repris — manquent : lead"`);
    const lc = cli(['run', 'confirm', 'reprise'], 'lead');
    ok('lead_confirm_accepted', lc.rc === 0 && /accusé recorded for lead/.test(lc.out), `rc=${lc.rc} ${lc.out.trim().slice(0, 120)}`);
    const done = await soft(() => { const s = runStatus('lead'); return s.reprise === null && !s.pause ? s : null; }, T(30_000), 'every member accused');
    ok('every_member_reprise_accused', !!done, done ? 'run status: no open Reprise, run not paused — all 4 members (lead, ops, w1, w2) accused' : `still open: ${JSON.stringify(runStatus('lead').reprise ?? null)}`);

    // 7. nothing the Pause killed came back, and no uncommitted work was lost
    await sleep(2500);
    const back = [m.bg, m.orphan, m.fg1, m.fg2].filter((n) => sleepers(n).length > 0);
    ok('killed_commands_not_rerun', back.length === 0, back.length ? `a killed command is running again: sleep ${back.join(',')}` : `after the Reprise still no sleep ${Object.values(m).join(',')}`);
    let intact = true; const intactDetail = [];
    for (const w of ['w1', 'w2']) {
      const worktreeIntact = fingerprint(WT[w]) === fp0[w];
      let refIntact = false;
      try { refIntact = !!refOf[w] && gitOut(WT[w], 'show', `${refOf[w]}:a.txt`) === expectWork[w].a && gitOut(WT[w], 'show', `${refOf[w]}:untracked.txt`) === expectWork[w].u; } catch { /* gone */ }
      intact = intact && worktreeIntact && refIntact; intactDetail.push(`${w}: worktree ${worktreeIntact ? '=' : '≠'} pre-pause, ref ${refIntact ? 'holds the work' : 'LOST'}`);
    }
    ok('no_lost_work', intact, intactDetail.join(' · '));
    ok('run_active_again', !runStatus('lead').pause, 'run status: not paused (every pause column back to NULL)');
  }

  // 8. after all cycles: the very same sessions answered every Reprise, and a prompt still runs
  broken = false;
  check('same_cli_keeper_throughout', ['w1', 'w2'].every((w) => ident[w] && alive(ident[w].keeper.pid, ident[w].keeper.start) && alive(ident[w].cli.pid, ident[w].cli.start)), 'w1/w2: the keeper + CLI that existed at the first pause are the ones alive now (no session was restarted by any Pause/Reprise)');
  const tH = Date.now();
  await app().ask({ cmd: 'human-send', ws: 'w1', text: 'SCN:conf' });
  const te = await soft(() => app().events.find((e) => e.ev === 'turn-end' && e.ws === 'w1' && e.t >= tH), 60_000, 'a final turn');
  check('session_resumable', !!te && te.isError !== true, te ? `turn-end stopReason=${te.stopReason}` : 'no turn-end');
  check('app_restarted_control', restartAt === null ? apps.length === 1 : apps.length === 2, `restart variant '${restartAt ?? 'none'}': ${apps.length} app process(es) booted over the same ORCHESTRA_HOME (the restart really happened)`);
  const mine = new Set([process.pid, ...apps.map((a) => a.child.pid), ...Object.values(ident).flatMap((i) => [i.keeper.pid, i.cli.pid])].filter(Boolean));
  result.strays = allProcs().filter((x) => live(x) && x.pid !== 1 && !mine.has(x.pid) && x.comm === 'sleep').map((x) => `${x.pid}:${x.comm}:${x.argv.slice(0, 3).join(' ')}`);
  check('rig_ran_to_completion', true, '');
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 600));
}
result.appErr = apps.map((a) => (a?.err ?? '').slice(-1200));
result.checks = checks;
result.ok = checks.length > 0 && checks.every((c) => c.ok);
result.requests = api.requests.length;
for (const a of apps) { try { a?.send({ cmd: 'quit' }); a?.child.kill('SIGKILL'); } catch { /* */ } }
await api.stop().catch(() => {});
console.log(JSON.stringify(result));
process.exit(0);
