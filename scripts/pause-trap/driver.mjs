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
const SRC = cfg.SRC ?? REPO; // the tree whose built CLI + src the arm drives (default: this one; `unfixed:` arms point at a MASTER checkout)
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
  // the coordinator pauses ITS OWN run from inside one of its tools: a background task (another tool tree) + the tool that holds the `run pause` call
  pauserself: [BASH('sleep 7723', { run_in_background: true }), BASH(`node ${REPO}/dist-electron/cli.js run pause --hard --run ops; sleep 7719`), { text: 'done' }],
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
  // (#282: `noStopTask` = the trap has NO stop_task, the documented FALLBACK (PTY agent, a CLI whose task-output link is unreadable, no live session): the bg task is ended by SIGTERM, which makes the CLI
  //  start a notification turn BY ITSELF — the only deterministic generator of a CLI-started turn, so the OBSERVER (rows 29/30) keeps its must-FAIL coverage. The production path is `bg-notify` below.)
  'turn-while-paused': { scenario: 'bgnotify', markers: [7718], rowTwentyNine: true, mustKill: ['sleep 7718'], idleAtPause: true, noStopTask: true },
  // #282 (ticket: "killing a paused member's background task makes its CLI start a turn on its own"): the trap ends the bg task THROUGH THE CLI (stop_task) before any signal, so no <task-notification> turn
  // starts: ZERO model requests from the paused member after the kill. The app stays up (`bg-notify`) or dies and the boot drain arms the idle keeper (`bg-notify-restart`).
  'bg-notify': { scenario: 'bgnotify', markers: [7718], bgNotify: true, idleAtPause: true, mustKill: ['sleep 7718'] },
  // the member is MID-TURN (blocked in a foreground command) with a background task + a daemonized job when the pause lands: the interrupt ends the turn, the trap ends the task through the CLI
  'bg-notify-running': { scenario: 'background', markers: [7714, 7715, 7716], bgNotify: true, bgCmd: 'sleep 7714', mustKill: ['sleep 7714', 'sleep 7715'] },
  // review F3 R1: the task's `.output` file is UNLINKED while the task runs (tmpfiles-clean, a /tmp sweep): /proc shows `…/<id>.output (deleted)` — the link must still name the task, or the original bug returns in silence
  'bg-notify-deleted': { scenario: 'bgnotify', markers: [7718], bgNotify: true, deletedOutput: true, idleAtPause: true, mustKill: ['sleep 7718'] },
  // review F3 R2: the member's CLI is WEDGED (SIGSTOPped; an idle member's interrupt needs no CLI round trip) — `stop_task` gets no answer: the trap must stay BOUNDED (5 s per request), end the task by signal and make 0 requests
  'bg-notify-wedged': { scenario: 'bgnotify', markers: [7718], wedgedCli: true, idleAtPause: true, mustKill: ['sleep 7718'] },
  'bg-notify-restart': { scenario: 'bgnotify', markers: [7718], bgNotify: true, restart: true, idleAtPause: true, settleBeforeKill: true, mustKill: ['sleep 7718'] },
  // the PAUSER (the OPS pausing its own run) is a member with a live session + a running tool: it keeps its turn
  // review F5: a human typing `--as <coordinator>` in a plain shell exempts NOBODY (the handle is not identity): the coordinator is interrupted + its tool killed
  'pauser-human': { scenario: 'blocking', markers: [7713], mustKill: [], pauser: { ws: 'ops', scenario: 'blockingops', markers: [7719], mode: 'human' } },
  // review F5: the pause is issued from INSIDE the coordinator's own tool: its turn is not interrupted and exactly that tool tree survives; its other tree (a bg task) is killed
  'pauser-self': { scenario: 'blocking', markers: [7713], mustKill: [], pauser: { ws: 'ops', scenario: null, markers: [7719], mode: 'self', otherTree: 7723 } },
  // review F4: the keeper is SIGSTOPped (alive but unresponsive): UNKNOWN is not NONE — nothing is killed, the trap is NOT stamped done, and it completes once the keeper answers again
  'keeper-stopped': { scenario: 'blocking', markers: [7713], mustKill: [], keeperStopped: true },
  // the keeper is IDLE (first turn ended, a background task still runs) when the app dies: the boot drain must ARM it (attach) so the CLI's own
  // task-notification turn — started when the trap kills that task — is observed, interrupted and noted (row 29 after a restart)
  'app-restart-idle': { scenario: 'bgnotify', markers: [7718], restart: true, rowTwentyNine: true, idleAtPause: true, settleBeforeKill: true, mustKill: ['sleep 7718'], noStopTask: true },
  // an AUTO prompt queued behind the running turn must survive the pause interrupt (not dropped, not drained) and run after the lift
  'queue-kept': { scenario: 'blocking', markers: [7713], mustKill: [], queueKept: true },
  // PROBE (not a verdict arm): what does a plain human interrupt leave alive? — the gap the trap's kill exists for.
  'probe-dbg': { scenario: 'dbg', markers: [7715, 7716], probe: true, mustKill: [] },
  'probe-interrupt': { scenario: 'background', markers: [7714, 7715, 7716], probe: true, mustKill: [] },
  // #282 PROBES (not verdict arms): the bg task of an IDLE member is ended (a) by SIGTERM (what the trap does) or (b) by the CLI's own stop_task; count the model requests that follow
  'probe-bg-sigterm': { scenario: 'bgnotify', markers: [7718], bgprobe: 'sigterm', mustKill: [] },
  'probe-bg-stoptask': { scenario: 'bgnotify', markers: [7718], bgprobe: 'stoptask', mustKill: [] },
};
// #254 Pause douce arms (scripts/pause-trap/douce-arm.mjs): function scenarios + their own driver path.
import { DOUCE_ARMS, douceScenarios, runDouce } from './douce-arm.mjs';
Object.assign(SCENARIOS, douceScenarios(path.join(SRC, 'dist-electron', 'cli.js')));
for (const [k, v] of Object.entries(DOUCE_ARMS)) ARMS[k] = { ...v, douce: true };
const A = ARMS[arm];
if (!A) throw new Error(`unknown arm ${arm}`);

const { startScriptedApi } = await import(`${HERE}/fake-api.mjs`);
const api = await startScriptedApi({ apiPort, scenarios: SCENARIOS });

// ── app processes ───────────────────────────────────────────────────────────
function startApp(phase, extra = {}) {
  const env = {
    PATH: process.env.PATH, HOME: home, LANG: 'C.UTF-8', TERM: 'dumb',
    ...(extra.statusSock ? { ORCHESTRA_SOCK: path.join(root, 'orch.sock') } : {}),
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
  const r = spawnSync(process.execPath, [path.join(SRC, 'dist-electron', 'cli.js'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orchHome, LANG: 'C.UTF-8' }, encoding: 'utf8', timeout: 60_000,
  });
  return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
function cliWith(args, extraEnv = {}) {
  const r = spawnSync(process.execPath, [path.join(SRC, 'dist-electron', 'cli.js'), ...args], {
    env: { PATH: process.env.PATH, HOME: home, ORCHESTRA_HOME: orchHome, LANG: 'C.UTF-8', ...extraEnv }, encoding: 'utf8', timeout: 60_000,
  });
  return { rc: r.status, out: (r.stdout ?? '') + (r.stderr ?? '') };
}
const runStatus = () => { const r = cli('run', 'status', '--run', 'ops', '--json'); try { return { ...JSON.parse(r.out), rc: r.rc }; } catch { return { rc: r.rc, raw: r.out }; } };

let app1 = null, app2 = null;
const result = { pause_trap: true, arm, mutant };
if (A.douce) {
  // #254: the Pause douce arms have their own flow (douce-arm.mjs); the teardown + result line are the same as below.
  const tracked = [];
  const trackedStart = (phase, extra) => { const a = startApp(phase, extra); tracked.push(a); return a; };
  try {
    await runDouce({ A, arm, api, cfg, startApp: trackedStart, cli, cliWith, waitFor, sleep, check, result, allProcs, live, alive, gitOut, readProc, home, orchHome, REPO, SRC, root, importSrc: (rel) => import(path.join(SRC, rel)) });
  } catch (e) {
    check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 500));
  }
  result.appErr = tracked.map((a) => a.err.slice(-1500));
  result.checks = checks;
  result.ok = checks.length > 0 && checks.every((c) => c.ok);
  result.requests = api.requests.length;
  for (const a of tracked) { try { a.send({ cmd: 'quit' }); a.child.kill('SIGKILL'); } catch { /* */ } }
  await api.stop().catch(() => {});
  console.log(JSON.stringify(result));
  process.exit(0);
}
try {
  // 1. fleet up, turn in flight
  app1 = startApp('first', { scenario: A.scenario, noTrap: !!A.probe, noStopTask: !!A.noStopTask, ...(A.pauser?.scenario ? { opsScenario: A.pauser.scenario } : {}) });
  await app1.waitEv((e) => e.ev === 'sent', 120_000, 'the first turn to be sent');
  // 2. POSITIVE CONTROL: the real CLI really spawned the real tool processes
  await waitFor(() => A.markers.every((n) => sleepers(n).length >= 1), 90_000, `tool processes ${A.markers.join(',')} to appear`);
  if (A.pauser?.mode === 'human') await waitFor(() => A.pauser.markers.every((n) => sleepers(n).length >= 1), 90_000, `the pauser's tool ${A.pauser.markers.join(',')} to appear`);
  const keeper = await waitFor(() => keeperProc(), 10_000, 'the keeper');
  const cli0 = await waitFor(() => cliProcOf(keeper.pid), 10_000, 'the CLI under the keeper');
  check('tool_procs_present_before_pause', A.markers.every((n) => sleepers(n).length >= 1), `markers ${A.markers.join(',')} alive under CLI ${cli0.pid}`);
  if (A.scenario === 'background') {
    const orphan = sleepers(7715)[0];
    const parent = orphan && readProc(orphan.ppid);
    check('orphan_is_reparented_control', !!orphan && orphan.ppid !== cli0.pid && !(parent && /zsh|bash/.test(parent.comm) && parent.state !== 'Z' && parent.argv.includes('-c')), `orphan sleep 7715 ppid=${orphan?.ppid} (${parent?.comm})`);
  }
  if (A.bgprobe) {
    // wait for the first turn to END (the member is IDLE, only the bg task lives), then end the task and watch the fake API
    await waitFor(() => app1.events.find((e) => e.ev === 'turn-end' && e.ws === 'w1'), 60_000, 'the first turn to end');
    await sleep(1500);
    const root = sleepers(7718)[0];
    const procOf = (pid) => { try { return { fd: [0, 1, 2].map((n) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${n}`); } catch { return null; } }), env: fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0').filter((x) => /CLAUDE|TASK|ORCH/i.test(x) && !/KEY|TOKEN/i.test(x)), cmd: fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ').slice(0, 300) }; } catch { return null; } };
    const par = root && readProc(root.ppid);
    result.mapping = { sleeper: root && procOf(root.pid), parent: par && { pid: par.pid, ...procOf(par.pid) } };
    app1.send({ cmd: 'bgtasks', ws: 'w1' });
    const bt = await waitFor(() => app1.replies.find((r) => r.reply === 'bgtasks'), 10_000, 'bgtasks reply');
    result.tasks = bt.tasks;
    const req0 = api.requests.length, t0 = Date.now();
    if (A.bgprobe === 'sigterm') process.kill(root.pid, 'SIGTERM');
    else {
      const id = (bt.tasks ?? []).find((t) => t.status === 'running')?.id;
      result.stopTaskId = id ?? null;
      app1.send({ cmd: 'stop-task', ws: 'w1', taskId: id });
      result.stopReply = (await waitFor(() => app1.replies.find((r) => r.reply === 'stop-task'), 15_000, 'stop-task reply').catch(() => null)) ?? null;
    }
    await sleep(12_000);
    result.requestsAfter = api.requests.slice(req0).map((r) => ({ seq: r.seq, dt: r.t - t0, scn: r.scn, idx: r.idx, tool: r.tool }));
    result.sleeperAfter = sleepers(7718).length;
    result.taskEvents = app1.events.filter((e) => e.ev === 'task' && e.t >= t0).map((e) => ({ dt: e.t - t0, kind: e.kind, status: e.status, taskId: e.taskId, liveIds: e.liveIds }));
    result.turnEnds = app1.events.filter((e) => e.ev === 'turn-end' && e.t >= t0).map((e) => ({ dt: e.t - t0, stop: e.stopReason }));
    result.checks = [{ id: 'probe', ok: true, detail: `${A.bgprobe}: ${result.requestsAfter.length} request(s) after the end of the bg task` }];
    result.ok = true;
    for (const a of [app1, app2]) { try { a?.send({ cmd: 'quit' }); a?.child.kill('SIGKILL'); } catch { /* */ } }
    await api.stop().catch(() => {});
    console.log(JSON.stringify(result));
    process.exit(0);
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
  if (A.queueKept) {
    app1.send({ cmd: 'auto-send', ws: 'w1', text: 'SCN:resume' });
    await waitFor(() => app1.replies.some((r) => r.reply === 'auto-send'), 30_000, 'the auto-send to be accepted');
    check('auto_prompt_is_queued_control', !app1.events.some((e) => e.ev === 'turn-end' && e.ws === 'w1'), 'the auto prompt is parked behind the running tool: no turn has ended yet');
  }
  const fpBefore = fingerprint(WT.w1);
  const opsFpBefore = fingerprint(WT.ops);

  // 3. (restart arm) the app DIES first: keeper + CLI + tools must survive it — the pause then lands with the app down
  if (A.restart) {
    if (A.settleBeforeKill) await sleep(3000); // let the first turn END: the keeper is idle when the app dies
    app1.child.kill('SIGKILL');
    await waitFor(() => app1.exited, 10_000, 'app1 to die');
    await sleep(1500);
    check('tools_survive_app_death_control', A.markers.every((n) => sleepers(n).length >= 1) && alive(keeper.pid, keeper.start) && alive(cli0.pid, cli0.start), 'keeper, CLI and tool processes outlived the app');
  }

  if (A.keeperStopped) process.kill(keeper.pid, 'SIGSTOP'); // alive but unresponsive
  if (A.deletedOutput) {
    await sleep(1500);
    const sl = sleepers(7718)[0]; let root = sl && readProc(sl.pid);
    while (root && root.ppid !== cli0.pid && root.ppid > 1) root = readProc(root.ppid);
    let linkBefore = null, linkAfter = null;
    try { linkBefore = fs.readlinkSync(`/proc/${root.pid}/fd/1`); fs.unlinkSync(linkBefore); linkAfter = fs.readlinkSync(`/proc/${root.pid}/fd/1`); } catch (e) { linkAfter = `ERR ${String(e.message).slice(0, 100)}`; }
    check('output_file_unlinked_control', !!linkBefore && /\/tasks\/[A-Za-z0-9_-]+\.output$/.test(linkBefore) && /\.output \(deleted\)$/.test(linkAfter ?? ''), `the bg task's stdout link ${linkBefore} → ${linkAfter} after the unlink (the shape this arm is about)`);
  }
  if (A.wedgedCli) { await sleep(1500); process.kill(cli0.pid, 'SIGSTOP'); const stopped = await waitFor(() => readProc(cli0.pid)?.state === 'T', 5000, `the CLI ${cli0.pid} to reach state T`).then(() => true, () => false); check('cli_wedged_control', stopped, `the member's CLI ${cli0.pid} is SIGSTOPped (state ${readProc(cli0.pid)?.state}); its keeper ${keeper.pid} still answers`); } // SIGSTOP lands asynchronously: poll for T (a read right after the kill raced it, 2/300) before the pause is issued // a CLI that answers nothing, keeper alive
  // 4. THE PAUSE, through the real built CLI (store-less: writes the bus directly) — or, for pauser-self, by the coordinator's OWN tool
  const tPause = Date.now();
  result.tPause = tPause;
  if (A.pauser?.mode === 'self') {
    app1.send({ cmd: 'human-send', ws: 'ops', text: 'SCN:pauserself' });
    await waitFor(() => sleepers(A.pauser.otherTree).length >= 1, 90_000, `the coordinator's background task ${A.pauser.otherTree}`);
    const st = await waitFor(() => { const x = runStatus(); return x.pause ? x : null; }, 90_000, 'the coordinator\'s own tool to pause its run');
    // the pause row lands BEFORE the CLI exits and the shell starts `sleep 7719`: wait for the tool that holds the call (a bounded poll — a read at the instant of the row raced it under load)
    const holdsCall = await waitFor(() => sleepers(7719).length >= 1, 15_000, 'sleep 7719 (the tool holding the pause call)').then(() => true, () => false);
    check('pause_issued_from_inside_the_member_tool', st.pause.pausedBy === 'ops' && holdsCall, `pausedBy=${st.pause.pausedBy}; the tool that holds the call (sleep 7719) is running`);
  } else {
    const p = cli('run', 'pause', '--hard', '--run', 'ops', '--as', A.pauser ? 'ops' : 'lead');
    check('cli_pause_accepted', p.rc === 0 && /PAUSED/.test(p.out), `rc=${p.rc} ${p.out.trim().slice(0, 200)}`);
  }
  if (A.keeperStopped) {
    await sleep(22_000);
    const st = runStatus();
    const row = st.bilan?.find((r) => r.wsId === 'w1');
    check('trap_not_stamped_while_keeper_unresponsive', (st.pause?.trapAt ?? null) === null && sleepers(7713).length >= 1 && /did not answer|timed out|unresponsive/i.test(row?.error ?? ''),
      `trapAt=${st.pause?.trapAt ?? null} tool alive=${sleepers(7713).length >= 1} Bilan error=${row?.error ?? 'none'}`);
    process.kill(keeper.pid, 'SIGCONT');
  }
  if (A.restart) {
    await sleep(2500);
    check('app_down_trap_owed_control', A.markers.every((n) => sleepers(n).length >= 1) && (runStatus().pause?.trapAt ?? null) === null, 'app is down: nothing killed yet, run status says the trap is NOT finished (proves the reaction is the host\'s)');
    app2 = startApp('second', { noStopTask: !!A.noStopTask });
    await app2.waitEv((e) => e.ev === 'trap-started', 120_000, 'app2 boot');
  }

  // 5. the host trap finishes
  const done = await waitFor(() => { const s = runStatus(); return s.pause?.trapAt ? s : null; }, mutant === 'no-trap' ? 12_000 : 90_000, 'pause_trap_at to be stamped').catch((e) => { check('trap_finished', false, String(e.message)); return null; });
  check('trap_finished', !!done, done ? `trap done ${Date.now() - tPause} ms after the pause` : 'never stamped');
  await sleep(1500);
  if (A.wedgedCli) {
    const trapMs = done?.pause?.trapAt ? Number(done.pause.trapAt) - tPause : null;
    check('trap_bounded_with_wedged_cli', trapMs !== null && trapMs < 20_000, `the trap stamped ${trapMs} ms after the pause with a wedged CLI (each stop_task request is bounded at 5 s, then the signals take over; unbounded = never)`);
    try { process.kill(cli0.pid, 'SIGCONT'); } catch { /* gone */ }
    await sleep(3000);
  }
  if (A.bgNotify || A.wedgedCli) {
    // #282: the unfixed CLI's notification turn lands 0.1–2 s after the kill; wait well past it, THEN count what the paused member sent to the model since the pause (main, tool-carrying requests; the member was IDLE at the pause)
    await sleep(6000);
    const sent = api.requests.filter((r) => r.t >= tPause && r.tools > 0);
    result.requestsAfterPause = sent.map((r) => ({ seq: r.seq, dt: r.t - tPause, scn: r.scn, idx: r.idx, tool: r.tool }));
    check('no_model_request_while_paused', sent.length === 0, sent.length === 0 ? `0 model requests from the paused member in the ${Math.round((Date.now() - tPause) / 1000)} s after the pause (its bg task was ended)` : `${sent.length} model request(s) from the PAUSED member after the pause: ${JSON.stringify(result.requestsAfterPause)}`);
  }

  // 6. assertions — only what the OS / git / the CLI can show
  const leftover = A.markers.filter((n) => sleepers(n).length > 0);
  check('no_surviving_tool_procs', leftover.length === 0, leftover.length ? `still alive: sleep ${leftover.join(',')}` : `sleep ${A.markers.join(',')} all gone`);
  check('cli_and_keeper_alive', alive(keeper.pid, keeper.start) && alive(cli0.pid, cli0.start), `keeper ${keeper.pid} / CLI ${cli0.pid} alive with their original start-times`);
  // The kills may be recorded by the pause-time trap (`killed`), by the turn observer that raced it on a reattached in-flight turn (`observerKilled`, appended AFTER its kill rounds
  // return) or by an earlier incomplete attempt (`earlierKilled`): wait (bounded) until every expected command is listed somewhere instead of a single read that raced the observer's append.
  const killedIn = (st) => { const r = st?.bilan?.find((x) => x.wsId === 'w1'); return [...(r?.killed?.killed ?? []), ...(r?.activity?.observerKilled ?? []), ...(r?.activity?.earlierKilled ?? [])].map((k) => k.cmd); };
  const doneNow = done && A.mustKill.length > 0
    ? await waitFor(() => { const st = runStatus(); return A.mustKill.every((c) => killedIn(st).some((k) => k.includes(c))) ? st : null; }, 20_000, 'the expected kills to be listed in the Bilan').catch(() => runStatus())
    : done;
  const w1row = doneNow?.bilan?.find((r) => r.wsId === 'w1');
  const opsrow = doneNow?.bilan?.find((r) => r.wsId === 'ops');
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
  // (pauser-self: ops's own session starts writing into its worktree AFTER the baseline was taken, so only w1 — the member the trap alone touched — is compared)
  check('snapshot_no_touch', fingerprint(WT.w1) === fpBefore && (A.pauser?.mode === 'self' || fingerprint(WT.ops) === opsFpBefore), 'worktree contents+mtimes, REAL index bytes, HEAD and branches are byte-identical after the trap (w1 and ops)');
  const killedCmds = killedIn(doneNow); // the pause-time trap's list + what the turn observer killed on a reattached in-flight turn + earlier incomplete attempts
  // (After an app restart the arm pass can attach the member first: the observer then interrupts the reattached in-flight turn before the trap's own
  // interrupt runs, which finds it already over — `idle` is honest IF a Bilan note records the observer's interrupt.)
  check('bilan_w1', !!w1row && w1row.dirty === true && Array.isArray(w1row.killed?.killed) && !w1row.error
    && (A.keeperStopped /* the stopped keeper's queued interrupt lands after SIGCONT, so the retry finds the turn already over: any outcome, the error-free COMPLETE retry is the point */
      || (A.idleAtPause ? w1row.activity?.interrupt === 'idle' && w1row.activity?.turnRunning === false
        : (w1row.activity?.turnRunning === true && (['interrupted', 'attached-then-interrupted'].includes(w1row.activity?.interrupt) || (w1row.activity?.interrupt === 'idle' && (w1row.activity?.notes ?? []).some((n) => /interrupt=interrupted/.test(n)))))))
    , w1row ? `dirty=${w1row.dirty} turnRunning=${w1row.activity?.turnRunning} interrupt=${w1row.activity?.interrupt} in-flight=${(w1row.activity?.inFlightTools ?? []).map((t) => t.tool).join(',')} killed=[${killedCmds.join(' | ')}] error=${w1row.error}` : 'no Bilan row for w1');
  check('trap_killed_what_survives_an_interrupt', A.mustKill.every((c) => killedCmds.some((k) => k.includes(c))), `the Bilan lists killed commands ${JSON.stringify(A.mustKill)}: got [${killedCmds.join(' | ')}]`);
  if (A.wedgedCli) {
    const st = w1row?.killed?.stopTask ?? [];
    check('wedged_stop_reported_failed', st.length >= 1 && st.every((x) => x.ok === false) && st.some((x) => /timed out after \d+ ms/.test(x.note ?? '')), `killed_json.stopTask = ${JSON.stringify(st).slice(0, 300)}`);
    check('wedged_task_ended_by_signal', (w1row?.killed?.killed ?? []).some((k) => k.cmd === 'sleep 7718' && k.signal !== 'stop_task'), `the Bilan lists sleep 7718 as ended by ${JSON.stringify((w1row?.killed?.killed ?? []).filter((k) => k.cmd === 'sleep 7718').map((k) => k.signal))}`);
  }
  if (A.bgNotify) {
    // #282: the Bilan says HOW — through the CLI's own stop_task — and the app saw the CLI's own `task_notification stopped`; no CLI-started turn was ever noted
    const bgCmd = A.bgCmd ?? 'sleep 7718';
    const bgK = (w1row?.killed?.killed ?? []).find((k) => k.cmd === bgCmd);
    const stopIds = (w1row?.killed?.stopTask ?? []).filter((x) => x.ok === true).map((x) => x.taskId); // the task ids the trap asked the CLI to stop AND the CLI's stop ended
    check('bg_task_ended_through_the_cli', !!bgK && bgK.signal === 'stop_task' && bgK.via === 'cli-stop-task' && stopIds.some((id) => (bgK.evidence ?? '').includes(`stop_task(${id}) accepted`)), JSON.stringify({ killed: bgK ?? null, stopTask: w1row?.killed?.stopTask ?? null }).slice(0, 400));
    const liveApp0 = app2 ?? app1;
    const stoppedEv = liveApp0.events.find((e) => e.ev === 'task' && e.ws === 'w1' && e.kind === 'notification' && e.status === 'stopped' && stopIds.includes(e.taskId));
    check('cli_reported_the_task_stopped', !!stoppedEv, stoppedEv ? `the CLI's own task_notification {status:'stopped'} for the task ${stoppedEv.taskId} the trap stopped` : `no task_notification {stopped} from w1 for a task the trap stopped (ids ${JSON.stringify(stopIds)}) reached the app`);
    check('no_cli_started_turn_noted', !(w1row?.activity?.notes ?? []).some((n) => /turn started while paused/.test(n)) && (w1row?.activity?.observerKilled ?? []).length === 0, `notes=${JSON.stringify(w1row?.activity?.notes ?? [])} observerKilled=${(w1row?.activity?.observerKilled ?? []).length}`);
  }
  if (A.mustKill.includes('sleep 7715')) {
    // LEAD ruling D11: the daemonized orphan is listed with pid, cmdline, cwd and the reason that matched (CLI identity = pid + start-time).
    const o = (w1row?.killed?.killed ?? []).find((k) => k.cmd === 'sleep 7715') ?? (w1row?.activity?.observerKilled ?? []).find((k) => k.cmd === 'sleep 7715') ?? (w1row?.activity?.earlierKilled ?? []).find((k) => k.cmd === 'sleep 7715');
    check('orphan_listed_with_cwd_and_reason', !!o && typeof o.pid === 'number' && o.via === 'env' && o.cwd === WT.w1 && /CLAUDE_PID=\d+ names this member's CLI \(pid \d+, start-time \d+\)/.test(o.evidence ?? ''),
      JSON.stringify(o ?? null));
  }
  check('bilan_ops_member_recorded', !!opsrow && !!opsrow.snapshotRef, opsrow ? `ops: ref=${opsrow.snapshotRef} dirty=${opsrow.dirty} surface=${opsrow.activity?.surface}` : 'no Bilan row for ops (the OPS is a member of its own run)');
  if (A.pauser?.mode === 'self') {
    const opsKeeper = allProcs().find((x) => live(x) && x.argv.some((a) => a.endsWith('keeper.js')) && x.argv.includes('ops'));
    check('pauser_keeps_its_call_tree', sleepers(7719).length >= 1 && !!opsKeeper && opsrow?.activity?.exempt === 'pauser' && opsrow?.activity?.interrupt === 'exempt' && !!opsrow?.snapshotRef,
      `ops (the pauser): the tool holding the pause call (sleep 7719) alive=${sleepers(7719).length >= 1} keeper alive=${!!opsKeeper} Bilan exempt=${opsrow?.activity?.exempt} interrupt=${opsrow?.activity?.interrupt} ref=${opsrow?.snapshotRef}`);
    check('pauser_other_tool_tree_killed', sleepers(A.pauser.otherTree).length === 0, `ops's OTHER tool tree (background sleep ${A.pauser.otherTree}) alive=${sleepers(A.pauser.otherTree).length >= 1}`);
  }
  if (A.pauser?.mode === 'human') {
    check('human_as_coordinator_is_not_exempt', sleepers(7719).length === 0 && opsrow?.activity?.exempt === undefined && opsrow?.activity?.interrupt === 'interrupted',
      `ops (paused_by ops via a plain shell): tool sleep 7719 alive=${sleepers(7719).length >= 1} exempt=${opsrow?.activity?.exempt} interrupt=${opsrow?.activity?.interrupt}`);
  }
  check('run_still_paused', done?.pause?.runId === 'ops' && !!done?.pause?.pausedAt, `pause=${JSON.stringify(done?.pause ?? null).slice(0, 120)}`);

  // 6b. row 29 — BEFORE the human prompt below: a human send attaches the session, which would let the observer see a CLI-started turn that only the host's own `arm` (idle keeper
  // re-armed after the app restart) could have observed — the `no-arm` mutant then survived (r3 run: the task-notification turn was still in flight when the human attached).
  if (A.rowTwentyNine) {
    const served = await waitFor(() => api.requests.some((r) => r.scn === 'bgnotify' && r.idx === 2), 45_000, 'the CLI-started turn to reach its tool call').then(() => true, () => false);
    check('cli_started_turn_ran_control', served, served ? 'the fake API served step 2 (tool_use sleep 7717) to the CLI-started turn: it really tried to run a tool' : 'the CLI never started a turn by itself — this arm proves nothing');
    const w1b = await waitFor(() => { const r = runStatus().bilan?.find((x) => x.wsId === 'w1'); return (r?.activity?.notes ?? []).some((n) => /turn started while paused/.test(n)) ? r : null; }, 20_000, 'the Bilan note for the CLI-started turn').catch(() => null);
    await sleep(2000); // the observer's interrupt + kill settle
    const note = (w1b?.activity?.notes ?? []).find((n) => /turn started while paused/.test(n));
    check('turn_while_paused_interrupted', !!w1b && /interrupt=(interrupted|attached)/.test(note ?? '') && sleepers(7717).length === 0, note ? `note: ${note}` : 'no "turn started while paused" note');
  }

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
  if (A.queueKept) {
    const endTurns = () => liveApp.events.filter((e) => e.ev === 'turn-end' && e.ws === 'w1' && e.t >= tPause && e.stopReason === 'end_turn' && e.isError !== true).length;
    await sleep(3000);
    check('queued_prompt_held_while_paused', endTurns() === 1, `only the HUMAN prompt ran (end_turn turn-ends since the pause: ${endTurns()}); the queued AUTO prompt is parked, not drained`);
    // #255: `run resume` starts the structured Reprise — w1 is NOT released by it, so its parked AUTO prompt still waits; the OPS (a coordinator, `--as ops`) releases it
    const lift = cli('run', 'resume', '--run', 'ops', '--as', 'lead');
    check('cli_resume_accepted', lift.rc === 0 && /REPRISE STARTED|LIFTED/.test(lift.out), `rc=${lift.rc} ${lift.out.trim().slice(0, 120)}`);
    await sleep(3000);
    check('queued_prompt_held_until_released', endTurns() === 1, `RESUMING: w1 is not released yet, the queued AUTO prompt is still parked (end_turn turn-ends since the pause: ${endTurns()})`);
    const rel = cli('run', 'release', 'w1', '--run', 'ops', '--as', 'ops');
    check('cli_release_accepted', rel.rc === 0 && /Released 1 member\(s\): w1/.test(rel.out), `rc=${rel.rc} ${rel.out.trim().slice(0, 120)}`);
    const ran = await waitFor(() => endTurns() >= 2, 60_000, 'the queued prompt to run after the release').catch(() => false);
    check('queued_prompt_survives_pause', !!ran, ran ? 'after `run release` the queued prompt ran (end_turn #2): the pause interrupt did not drop it' : 'the queued prompt never ran: it was dropped by the pause interrupt');
  }
  // strays census (report, not judged): anything in the namespace that is not the rig's own tree
  const mine = new Set([process.pid, app1?.child.pid, app2?.child.pid, keeper.pid, cli0.pid].filter(Boolean));
  result.strays = allProcs().filter((x) => live(x) && x.pid !== 1 && !mine.has(x.pid) && (x.comm === 'sleep' || /zsh|bash/.test(x.comm))).map((x) => `${x.pid}:${x.comm}:${x.argv.slice(0, 4).join(' ').slice(0, 60)}`);
  check('rig_ran_to_completion', true, '');
} catch (e) {
  check('rig_ran_to_completion', false, String(e?.stack ?? e).slice(0, 500));
}
result.appErr = [app1, app2].map((a) => (a?.err ?? '').slice(-1500));
result.sweeps = [app1, app2].flatMap((a) => (a?.events ?? []).filter((e) => e.ev === 'sweep' || e.ev === 'sweep-error')).slice(-6); // the host's own stderr (logger lines) for autopsy
result.checks = checks;
result.ok = checks.length > 0 && checks.every((c) => c.ok);
result.requests = api.requests.length;
for (const a of [app1, app2]) { try { a?.send({ cmd: 'quit' }); a?.child.kill('SIGKILL'); } catch { /* */ } }
await api.stop().catch(() => {});
console.log(JSON.stringify(result));
process.exit(0);
