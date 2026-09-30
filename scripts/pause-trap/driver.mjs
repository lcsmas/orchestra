// The pause-trap rig's CONTAINER ENTRY (#252 D1b, ledger #261 G3): runs INSIDE `bwrap --unshare-net
// --unshare-pid` (see run.mjs). Hosts the scripted fake API, starts the main-process stand-in (app.mjs:
// REAL store/bus/agent-sdk/keeper/pause-trap modules) and drives one arm:
//   real keeper → real `claude` CLI → real Bash-tool processes  ──  `orchestra run pause --hard` (the REAL
//   built CLI writes the bus)  ──  the host trap reacts  ──  assertions read only what a user/OS can see.
// Prints ONE JSON line: {"pause_trap":true, arm, mutant, checks:[{id,ok,detail}], ok}.
import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

const cfg = JSON.parse(process.env.PT_CONFIG ?? '{}');
const { REPO, root, arm, mutant = null, apiPort } = cfg;
const HERE = path.join(REPO, 'scripts', 'pause-trap');
const home = path.join(root, 'home');
const orchHome = path.join(root, 'orchestra');
const WT = { w1: path.join(root, 'wt-w1'), ops: path.join(root, 'wt-ops') };
const checks = [];
const check = (id, ok, detail = '') => { checks.push({ id, ok: !!ok, detail: String(detail).slice(0, 600) }); return !!ok; };
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

// ── /proc helpers ───────────────────────────────────────────────────────────
function readProc(pid) {
  try {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    const rp = stat.lastIndexOf(')');
    const rest = stat.slice(rp + 2).split(' ');
    let argv = [];
    try { argv = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').filter(Boolean); } catch { /* */ }
    return { pid, comm: stat.slice(stat.indexOf('(') + 1, rp), state: rest[0], ppid: Number(rest[1]), sid: Number(rest[3]), start: Number(rest[19]), argv };
  } catch { return null; }
}
const allProcs = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).map((n) => readProc(Number(n))).filter(Boolean);
const live = (p) => p && p.state !== 'Z';
const sleepers = (n) => allProcs().filter((p) => live(p) && p.comm === 'sleep' && p.argv[1] === String(n));
const keeperProc = () => allProcs().find((p) => live(p) && p.argv.some((a) => a.endsWith('keeper.js')) && p.argv.includes('w1'));
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
      if (st.isDirectory()) { lines.push(`D ${r} ${st.mtimeNs}`); walk(p, r); }
      else lines.push(`F ${r} ${st.mode} ${st.size} ${st.mtimeNs} ${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`);
    }
  };
  walk(dir, '');
  const idx = path.join(gitDir, 'index');
  const ist = fs.statSync(idx, { bigint: true });
  lines.push(`INDEX ${ist.size} ${ist.mtimeNs} ${ist.ctimeNs} ${crypto.createHash('sha256').update(fs.readFileSync(idx)).digest('hex')}`);
  lines.push(`HEAD ${fs.readFileSync(path.join(gitDir, 'HEAD'), 'utf8')}`);
  lines.push(`HEADS ${execFileSync('git', ['for-each-ref', '--format=%(refname) %(objectname)', 'refs/heads'], { cwd: dir, encoding: 'utf8' })}`);
  return lines.join('\n');
}
const gitOut = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...process.env, GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' } }).trim();

// ── scenarios the fake API plays ────────────────────────────────────────────
const BASH = (command, extra = {}) => ({ tool: { name: 'Bash', input: { command, description: 'pause-trap rig', timeout: 600000, ...extra } } });
const SCENARIOS = {
  blocking: [BASH('sleep 7713'), { text: 'done' }],
  foreground: [BASH("bash -c 'sleep 7711 & sleep 7712; wait'"), { text: 'done' }],
  // a background task + an orphaned job that outlives its shell + a foreground blocking command
  background: [BASH('sleep 7714', { run_in_background: true }), BASH("python3 -c \"import subprocess; subprocess.Popen(['sleep','7715'], start_new_session=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL)\"; sleep 7716"), { text: 'done' }],
  // a background task that, when killed, makes the CLI start a turn by itself (task notification): row 29
  bgnotify: [BASH('sleep 7718', { run_in_background: true }), { text: 'background started' }, BASH('sleep 7717'), { text: 'done' }],
  blockingops: [BASH('sleep 7719'), { text: 'done' }],
  resume: [{ text: 'ok' }],
  dbg: [BASH("python3 -c \"import os,subprocess; p=subprocess.Popen(['sleep','7715'], start_new_session=True); print('child', p.pid, 'childsid', os.getsid(p.pid), 'mysid', os.getsid(0), 'path', os.environ.get('PATH'))\" > $HOME/dbg.txt 2>&1; id >> $HOME/dbg.txt; grep -E 'Seccomp|NoNewPrivs' /proc/self/status >> $HOME/dbg.txt; sleep 7716"), { text: 'done' }],
};
// `mustKill`: commands the TRAP itself must report killing. A foreground tool dies with the interrupt (the CLI aborts it), so only
// what survives an interrupt needs the trap: a background task and a job that outlived its shell.
const ARMS = {
  blocking: { scenario: 'blocking', markers: [7713], mustKill: [] },
  foreground: { scenario: 'foreground', markers: [7711, 7712], mustKill: [] },
  background: { scenario: 'background', markers: [7714, 7715, 7716], mustKill: ['sleep 7714', 'sleep 7715'] },
  'app-restart': { scenario: 'blocking', markers: [7713], restart: true, mustKill: [] },
  // the boot drain must KILL too (not only interrupt): a background task + a daemonized job survive the interrupt
  'app-restart-bg': { scenario: 'background', markers: [7714, 7715, 7716], restart: true, mustKill: ['sleep 7714', 'sleep 7715'] },
  // the first turn has ENDED when the pause lands (only the background task is alive): interrupt = 'idle' is the right outcome
  'turn-while-paused': { scenario: 'bgnotify', markers: [7718], rowTwentyNine: true, mustKill: ['sleep 7718'], idleAtPause: true },
  // the PAUSER (the OPS pausing its own run) is a member with a live session + a running tool: it keeps its turn
  'pauser-exempt': { scenario: 'blocking', markers: [7713], mustKill: [], pauser: { ws: 'ops', scenario: 'blockingops', markers: [7719] } },
  // PROBE (not a verdict arm): what does a plain human interrupt leave alive? — the gap the trap's kill exists for.
  'probe-dbg': { scenario: 'dbg', markers: [7715, 7716], probe: true, mustKill: [] },
  'probe-interrupt': { scenario: 'background', markers: [7714, 7715, 7716], probe: true, mustKill: [] },
};
const A = ARMS[arm];
if (!A) throw new Error(`unknown arm ${arm}`);

const { startScriptedApi } = await import(`${HERE}/fake-api.mjs`);
const api = await startScriptedApi({ apiPort, scenarios: SCENARIOS });

// ── app processes ───────────────────────────────────────────────────────────
function startApp(phase, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'dumb',
    PT_CONFIG: JSON.stringify({ ...cfg, phase, apiUrl: api.url, ...extra }),
  };
  const child = spawn(process.execPath, ['--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=UNDICI-EHPA', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(HERE, 'app.mjs')],
    { cwd: REPO, env, stdio: ['pipe', 'pipe', 'pipe'] });
  const a = { child, events: [], replies: [], err: '' , exited: false };
  let buf = '';
  child.stdout.on('data', (d) => { buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); try { const o = JSON.parse(l); (o.reply ? a.replies : a.events).push(o); } catch { /* non-json */ } } });
  child.stderr.on('data', (d) => { a.err += d; });
  child.on('close', () => { a.exited = true; });
  a.send = (o) => child.stdin.write(`${JSON.stringify(o)}\n`);
  a.waitEv = (pred, ms, what) => waitFor(() => a.events.find(pred) ?? (a.exited ? (() => { throw new Error(`app exited while waiting for ${what}: ${a.err.slice(-500)}`); })() : null), ms, what);
  return a;
}

// ── the REAL built CLI ──────────────────────────────────────────────────────
function cli(...args) {
  const r = spawnSync(process.execPath, [path.join(REPO, 'dist-electron', 'cli.js'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orchHome, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000,
  });
  return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const runStatus = () => { const r = cli('run', 'status', '--run', 'ops', '--json'); try { return { ...JSON.parse(r.out), rc: r.rc }; } catch { return { rc: r.rc, raw: r.out }; } };

let app1 = null, app2 = null;
const result = { pause_trap: true, arm, mutant };
try {
  // 1. fleet up, turn in flight
  app1 = startApp('first', { scenario: A.scenario, noTrap: !!A.probe, ...(A.pauser ? { opsScenario: A.pauser.scenario } : {}) });
  await app1.waitEv((e) => e.ev === 'sent', 120_000, 'the first turn to be sent');
  // 2. POSITIVE CONTROL: the real CLI really spawned the real tool processes
  await waitFor(() => A.markers.every((n) => sleepers(n).length >= 1), 90_000, `tool processes ${A.markers.join(',')} to appear`);
  if (A.pauser) await waitFor(() => A.pauser.markers.every((n) => sleepers(n).length >= 1), 90_000, `the pauser's tool ${A.pauser.markers.join(',')} to appear`);
  const keeper = await waitFor(() => keeperProc(), 10_000, 'the keeper');
  const cli0 = await waitFor(() => cliProcOf(keeper.pid), 10_000, 'the CLI under the keeper');
  check('tool_procs_present_before_pause', A.markers.every((n) => sleepers(n).length >= 1), `markers ${A.markers.join(',')} alive under CLI ${cli0.pid}`);
  if (A.scenario === 'background') {
    const orphan = sleepers(7715)[0];
    const parent = orphan && readProc(orphan.ppid);
    check('orphan_is_reparented_control', !!orphan && orphan.ppid !== cli0.pid && !(parent && /zsh|bash/.test(parent.comm) && parent.state !== 'Z' && parent.argv.includes('-c')), `orphan sleep 7715 ppid=${orphan?.ppid} (${parent?.comm})`);
  }
  if (A.probe) {
    const o = sleepers(7715)[0];
    const env = o ? fs.readFileSync(`/proc/${o.pid}/environ`, 'latin1').split('\0').filter((x) => /^CLAUDE_PID=/.test(x)) : [];
    result.probe = { before: A.markers.map((n) => [n, sleepers(n).map((p) => `pid${p.pid}/ppid${p.ppid}/sid${p.sid}`)]), orphanEnv: env, cli: cli0.pid };
    result.probe.ps = execFileSync('ps', ['-eo', 'pid,ppid,pgid,sid,comm,args'], { encoding: 'utf8' }).split('\n').filter((l) => /sleep|python|zsh|claude/.test(l)).map((l) => l.replace(/\s+/g, ' ').slice(0, 260));
    app1.send({ cmd: 'interrupt', ws: 'w1' });
    await sleep(4000);
    result.probe.after = A.markers.map((n) => [n, sleepers(n).map((p) => `pid${p.pid}/ppid${p.ppid}/sid${p.sid}`)]);
    try { result.probe.dbg = fs.readFileSync(path.join(home, 'dbg.txt'), 'utf8'); } catch { /* none */ }
    result.checks = [{ id: 'probe', ok: true, detail: JSON.stringify(result.probe).slice(0, 300) }];
    result.ok = true;
    console.log(JSON.stringify(result));
    process.exit(0);
  }
  const fp1 = fingerprint(WT.w1);
  await sleep(1200);
  check('fingerprint_is_stable_control', fp1 === fingerprint(WT.w1), 'two reads of the unpaused worktree agree (the instrument is deterministic)');
  const fpBefore = fingerprint(WT.w1);
  const opsFpBefore = fingerprint(WT.ops);

  // 3. (restart arm) the app DIES first: keeper + CLI + tools must survive it — the pause then lands with the app down
  if (A.restart) {
    app1.child.kill('SIGKILL');
    await waitFor(() => app1.exited, 10_000, 'app1 to die');
    await sleep(1500);
    check('tools_survive_app_death_control', A.markers.every((n) => sleepers(n).length >= 1) && alive(keeper.pid, keeper.start) && alive(cli0.pid, cli0.start), 'keeper, CLI and tool processes outlived the app');
  }

  // 4. THE PAUSE, through the real built CLI (store-less: writes the bus directly)
  const tPause = Date.now();
  const p = cli('run', 'pause', '--hard', '--run', 'ops', '--as', A.pauser ? 'ops' : 'lead');
  check('cli_pause_accepted', p.rc === 0 && /PAUSED/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 200)}`);
  if (A.restart) {
    await sleep(2500);
    check('app_down_trap_owed_control', A.markers.every((n) => sleepers(n).length >= 1) && (runStatus().pause?.trapAt ?? null) === null, 'app is down: nothing killed yet, run status says the trap is NOT finished (proves the reaction is the host\'s)');
    app2 = startApp('second');
    await app2.waitEv((e) => e.ev === 'trap-started', 120_000, 'app2 boot');
  }

  // 5. the host trap finishes
  const done = await waitFor(() => { const s = runStatus(); return s.pause?.trapAt ? s : null; }, 90_000, 'pause_trap_at to be stamped').catch((e) => { check('trap_finished', false, String(e.message)); return null; });
  check('trap_finished', !!done, done ? `trap done ${Date.now() - tPause} ms after the pause` : 'never stamped');
  await sleep(1500);

  // 6. assertions — only what the OS / git / the CLI can show
  const leftover = A.markers.filter((n) => sleepers(n).length > 0);
  check('no_surviving_tool_procs', leftover.length === 0, leftover.length ? `still alive: sleep ${leftover.join(',')}` : `sleep ${A.markers.join(',')} all gone`);
  check('cli_and_keeper_alive', alive(keeper.pid, keeper.start) && alive(cli0.pid, cli0.start), `keeper ${keeper.pid} / CLI ${cli0.pid} alive with their original start-times`);
  const w1row = done?.bilan?.find((r) => r.wsId === 'w1');
  const opsrow = done?.bilan?.find((r) => r.wsId === 'ops');
  const ref = w1row?.snapshotRef ?? null;
  let refOk = false, refDetail = 'no snapshot ref in the Bilan';
  if (ref) {
    try {
      const a = gitOut(WT.w1, 'show', `${ref}:a.txt`), u = gitOut(WT.w1, 'show', `${ref}:untracked.txt`);
      refOk = /^refs\/orchestra\/pause\/ops\/w1\/\d+$/.test(ref) && a === 'UNCOMMITTED-EDIT' && u === 'UNTRACKED-WORK';
      refDetail = `${ref}: a.txt=${JSON.stringify(a)} untracked.txt=${JSON.stringify(u)}`;
    } catch (e) { refDetail = `${ref}: ${String(e.message).slice(0, 200)}`; }
  }
  check('pause_ref_holds_uncommitted_work', refOk, refDetail);
  check('snapshot_no_touch', fingerprint(WT.w1) === fpBefore && fingerprint(WT.ops) === opsFpBefore, 'worktree contents+mtimes, REAL index bytes, HEAD and branches are byte-identical after the trap (w1 and ops)');
  const killedCmds = (w1row?.killed?.killed ?? []).map((k) => k.cmd);
  check('bilan_w1', !!w1row && w1row.dirty === true && (A.idleAtPause ? w1row.activity?.interrupt === 'idle' : ['interrupted', 'attached-then-interrupted'].includes(w1row.activity?.interrupt)) && Array.isArray(w1row.killed?.killed) && !w1row.error && w1row.activity?.turnRunning === !A.idleAtPause,
    w1row ? `dirty=${w1row.dirty} turnRunning=${w1row.activity?.turnRunning} interrupt=${w1row.activity?.interrupt} in-flight=${(w1row.activity?.inFlightTools ?? []).map((t) => t.tool).join(',')} killed=[${killedCmds.join(' | ')}] error=${w1row.error}` : 'no Bilan row for w1');
  check('trap_killed_what_survives_an_interrupt', A.mustKill.every((c) => killedCmds.some((k) => k.includes(c))), `the Bilan lists killed commands ${JSON.stringify(A.mustKill)}: got [${killedCmds.join(' | ')}]`);
  check('bilan_ops_member_recorded', !!opsrow && !!opsrow.snapshotRef, opsrow ? `ops: ref=${opsrow.snapshotRef} dirty=${opsrow.dirty} surface=${opsrow.activity?.surface}` : 'no Bilan row for ops (the OPS is a member of its own run)');
  if (A.pauser) {
    const opsKeeper = allProcs().find((x) => live(x) && x.argv.some((a) => a.endsWith('keeper.js')) && x.argv.includes('ops'));
    check('pauser_keeps_its_turn', A.pauser.markers.every((n) => sleepers(n).length >= 1) && !!opsKeeper && opsrow?.activity?.exempt === 'pauser' && opsrow?.activity?.interrupt === 'exempt' && !!opsrow?.snapshotRef,
      `ops (the pauser): tool sleep ${A.pauser.markers.join(',')} alive=${A.pauser.markers.every((n) => sleepers(n).length >= 1)} keeper alive=${!!opsKeeper} Bilan exempt=${opsrow?.activity?.exempt} interrupt=${opsrow?.activity?.interrupt} ref=${opsrow?.snapshotRef}`);
  }
  check('run_still_paused', done?.pause?.runId === 'ops' && !!done?.pause?.pausedAt, `pause=${JSON.stringify(done?.pause ?? null).slice(0, 120)}`);

  // 7. the session is still RESUMABLE (and a HUMAN prompt is allowed while paused, un-pausing nothing)
  const liveApp = app2 ?? app1;
  const tHuman = Date.now();
  liveApp.send({ cmd: 'human-send', ws: 'w1', text: 'SCN:resume' });
  const te = await waitFor(() => liveApp.events.find((e) => e.ev === 'turn-end' && e.ws === 'w1' && e.t >= tHuman), 90_000, 'the resume turn-end').catch(() => null);
  check('session_resumable', !!te && te.isError !== true, te ? `turn-end stopReason=${te.stopReason} isError=${te.isError}` : 'no turn-end for the human prompt');
  check('human_prompt_did_not_unpause', !!runStatus().pause, 'the human prompt lifted nothing');
  check('cli_same_after_resume_turn', alive(cli0.pid, cli0.start) && alive(keeper.pid, keeper.start), 'the same CLI answered (no restart)');

  // 8. background arms: the killed background task must not start work again
  if (A.scenario === 'background') {
    await sleep(3000);
    check('nothing_restarts_on_its_own', A.markers.every((n) => sleepers(n).length === 0), 'after 3 s still no tool process');
  }
  // 9. row 29: the CLI started a turn by itself while paused (background task killed → task notification)
  if (A.rowTwentyNine) {
    const w1b = await waitFor(() => { const r = runStatus().bilan?.find((x) => x.wsId === 'w1'); return (r?.activity?.notes ?? []).some((n) => /turn started while paused/.test(n)) ? r : null; }, 45_000, 'the Bilan note for the CLI-started turn').catch(() => null);
    const served = api.requests.some((r) => r.scn === 'bgnotify' && r.idx === 2);
    check('cli_started_turn_ran_control', served, served ? 'the fake API served step 2 (tool_use sleep 7717) to the CLI-started turn: it really tried to run a tool' : 'the CLI never started a turn by itself — this arm proves nothing');
    const note = (w1b?.activity?.notes ?? []).find((n) => /turn started while paused/.test(n));
    check('turn_while_paused_interrupted', !!w1b && /interrupt=(interrupted|attached)/.test(note ?? '') && sleepers(7717).length === 0, note ? `note: ${note}` : 'no "turn started while paused" note');
  }
  // strays census (report, not judged): anything in the namespace that is not the rig's own tree
  const mine = new Set([process.pid, app1?.child.pid, app2?.child.pid, keeper.pid, cli0.pid].filter(Boolean));
  result.strays = allProcs().filter((x) => live(x) && x.pid !== 1 && !mine.has(x.pid) && (x.comm === 'sleep' || /zsh|bash/.test(x.comm))).map((x) => `${x.pid}:${x.comm}:${x.argv.slice(0, 4).join(' ').slice(0, 60)}`);
  check('rig_ran_to_completion', true, '');
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 500));
}
result.checks = checks;
result.ok = checks.length > 0 && checks.every((c) => c.ok);
result.requests = api.requests.length;
for (const a of [app1, app2]) { try { a?.send({ cmd: 'quit' }); a?.child.kill('SIGKILL'); } catch { /* */ } }
await api.stop().catch(() => {});
console.log(JSON.stringify(result));
process.exit(0);
