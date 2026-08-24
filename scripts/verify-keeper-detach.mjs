#!/usr/bin/env node
/* E2E gate for the detached session keeper: a structured-agent turn SURVIVES
 * quitting Orchestra, and a relaunch REATTACHES to it.
 *
 * Drives the REAL built app (isolated ORCHESTRA_HOME, headless sway, CDP):
 *   1. Seed a scratch workspace; launch app #1; send a turn that runs
 *      `sleep 15 && echo DONE > proof` via the Bash tool (model haiku).
 *   2. Once the keeper + CLI exist, close the app mid-turn (window.close()).
 *   3. Assert keeper + claude survive the quit and the proof file appears
 *      WHILE NO APP IS RUNNING (the turn completed detached).
 *   4. Launch app #2 on the same home; open the workspace; assert the
 *      transcript (incl. the reply produced while closed) is visible, the
 *      main log shows the reattach, and capture a screenshot.
 *   5. `/clear` (agentSdkClear) → assert the keeper + CLI actually DIE
 *      (explicit stop must kill what quit must not).
 *
 * Usage: node scripts/verify-keeper-detach.mjs   (from the repo root, after
 *        `npx vite build && pnpm run build:cli && pnpm run build:keeper`)
 */
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import { spawn, execSync, spawnSync } from 'node:child_process';

const REPO = process.cwd();
const RUN = path.join(os.tmpdir(), `keeper-e2e-f3d27106-${process.pid}`);
const HOME = path.join(RUN, 'home');
const WS = 'e2e-keeper-ws-1';
// Per-run port: a crashed previous run's dying Chromium can hold a fixed port
// at our launch instant, and Electron then silently continues WITHOUT CDP.
const PORT = 9300 + (process.pid % 90);
const results = [];
const check = (name, ok, detail = '') => {
  results.push({ name, ok: !!ok });
  console.log(`${ok ? 'PASS' : 'FAIL'}  ${name}${detail ? '  — ' + detail : ''}`);
};
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, pred, ms, step = 300) {
  const t0 = Date.now();
  for (;;) {
    const v = await pred();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error('timeout: ' + what);
    await sleep(step);
  }
}
const alive = (pid) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

// ── harness: sway ───────────────────────────────────────────────────────────
fs.mkdirSync(HOME, { recursive: true });
const swayCfg = path.join(RUN, 'sway.cfg');
fs.writeFileSync(swayCfg, 'output HEADLESS-1 resolution 1600x1000\n');
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
// A previous crashed run can leave (a) a stray headless sway and (b) a stale
// wayland-N socket FILE that a fresh sway re-binds under the SAME name — so
// detect the new socket by MTIME, not by name diff, and sweep strays first.
try {
  execSync(`pkill -f 'sway -c /tmp/keeper-e2e'`);
  await sleep(500);
} catch {
  /* none running */
}
const t0 = Date.now();
const sway = spawn('sway', ['-c', swayCfg], {
  env: {
    ...process.env,
    WLR_BACKENDS: 'headless',
    WLR_LIBINPUT_NO_DEVICES: '1',
    WAYLAND_DISPLAY: '',
    SWAYSOCK: path.join(RUN, 'sway.sock'),
  },
  stdio: 'ignore',
});
const wayland = await waitFor(
  'sway wayland socket',
  () =>
    fs
      .readdirSync(runtimeDir)
      .filter((f) => /^wayland-\d+$/.test(f))
      .find((f) => fs.statSync(path.join(runtimeDir, f)).mtimeMs >= t0 - 1000),
  10000,
);
console.log(`[harness] sway up on ${wayland}`);

// ── account: derive from THIS shell, then prove it can authenticate ─────────
// Taken from CLAUDE_CONFIG_DIR when set (the value this shell is logged in
// as), else ~/.claude. Deriving beats hardcoding: the harness then runs as
// whoever invokes it rather than as one machine's account.
const ACCOUNT_ID = 'keeper-e2e-account';
const ACCOUNT_CONFIG_DIR = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), '.claude');

// PREFLIGHT. An auth failure surfaces 60+ seconds later as a keeper check
// failing, which reads as a defect in the thing under test. Fail here instead,
// naming auth, before any of that machinery starts.
{
  const probe = spawnSync(process.env.CLAUDE_BIN || 'claude', ['-p', 'say ok'], {
    env: { ...process.env, CLAUDE_CONFIG_DIR: ACCOUNT_CONFIG_DIR },
    encoding: 'utf8',
    timeout: 120_000,
  });
  const out = `${probe.stdout ?? ''}${probe.stderr ?? ''}`;
  if (probe.status !== 0 || /Failed to authenticate|OAuth/i.test(out)) {
    console.error(
      `PREFLIGHT FAIL — cannot authenticate with CLAUDE_CONFIG_DIR=${ACCOUNT_CONFIG_DIR}\n` +
        `  ${out.trim().split('\n').slice(0, 3).join('\n  ')}\n` +
        `This is an AUTH problem, not a keeper problem (see #29). Log in for that\n` +
        `config dir, or re-run with CLAUDE_CONFIG_DIR set to one that is authenticated.`,
    );
    process.exit(1);
  }
}

// ── seed store ──────────────────────────────────────────────────────────────
const scratchDir = path.join(RUN, 'scratch-ws');
fs.mkdirSync(scratchDir, { recursive: true });
const storeDir = path.join(HOME, 'userData', 'orchestra');
fs.mkdirSync(storeDir, { recursive: true });
fs.writeFileSync(
  path.join(storeDir, 'store.json'),
  JSON.stringify(
    {
      repos: [],
      // Seed the account whose config dir this shell is authenticated as, and
      // PIN it on the workspace. Without both, agent-sdk.ts deletes
      // CLAUDE_CONFIG_DIR and re-sets it only from a pinned account
      // (workspaces.ts workspaceAccountConfigDir), so `claude` falls back to
      // ~/.claude — whose OAuth is commonly expired non-interactively. The run
      // then dies at the "sleep 15 running under OUR keeper" check, i.e. it
      // fails in the one place that looks exactly like a keeper defect. See #29.
      accounts: [{ id: ACCOUNT_ID, label: 'keeper-e2e', configDir: ACCOUNT_CONFIG_DIR }],
      workspaces: [
        {
          id: WS,
          name: 'keeper-e2e',
          kind: 'scratch',
          repoPath: '',
          worktreePath: scratchDir,
          branch: 'keeper-e2e',
          baseBranch: '',
          createdAt: Date.now(),
          status: 'idle',
          agent: 'claude',
          model: 'haiku',
          accountId: ACCOUNT_ID,
        },
      ],
    },
    null,
    2,
  ),
);

// ── app launcher + CDP ─────────────────────────────────────────────────────
const appEnv = { ...process.env };
for (const k of ['APPIMAGE', 'APPDIR', 'OWD', 'ARGV0']) delete appEnv[k];
Object.assign(appEnv, {
  WAYLAND_DISPLAY: wayland,
  ELECTRON_OZONE_PLATFORM_HINT: 'wayland',
  ORCHESTRA_OZONE: 'wayland',
  ORCHESTRA_OZONE_RELAUNCHED: '1',
  ORCHESTRA_HOME: HOME,
  ORCHESTRA_DEBUG_PORT: String(PORT),
});
function launchApp(port) {
  return spawn(path.join(REPO, 'node_modules/electron/dist/electron'), ['.', '--ozone-platform=wayland'], {
    cwd: REPO,
    env: { ...appEnv, ORCHESTRA_DEBUG_PORT: String(port) },
    stdio: 'ignore',
  });
}
async function connectCdp(PORT) {
  const url = await waitFor(
    'CDP target',
    async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${PORT}/json`)).json();
        const page = targets.find((t) => t.type === 'page' && t.url.includes('index.html'));
        if (page && !page.url.includes('app.asar')) return page.webSocketDebuggerUrl;
      } catch {
        /* not up yet */
      }
      return null;
    },
    30000,
    500,
  );
  const ws = new WebSocket(url);
  let id = 0;
  const pending = new Map();
  await new Promise((res, rej) => {
    ws.onopen = res;
    ws.onerror = rej;
  });
  ws.onmessage = (m) => {
    const msg = JSON.parse(m.data);
    if (msg.id && pending.has(msg.id)) {
      const { resolve, reject } = pending.get(msg.id);
      pending.delete(msg.id);
      msg.error ? reject(new Error(JSON.stringify(msg.error))) : resolve(msg.result);
    }
  };
  const send = (method, params = {}) =>
    new Promise((resolve, reject) => {
      const my = ++id;
      pending.set(my, { resolve, reject });
      ws.send(JSON.stringify({ id: my, method, params }));
    });
  await send('Runtime.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}
const keeperPidFile = path.join(HOME, 'keepers', `${WS}.pid`);
const keeperPid = () => JSON.parse(fs.readFileSync(keeperPidFile, 'utf8')).pid;
const claudeChildOf = (pid) => {
  try {
    return Number(execSync(`pgrep -P ${pid} -f claude`, { encoding: 'utf8' }).trim().split('\n')[0]);
  } catch {
    return null;
  }
};

let app1;
let app2;
let app3;
let app4;
try {
  // ── phase 1: start a turn, quit mid-turn ──────────────────────────────────
  app1 = launchApp(PORT);
  const cdp1 = await connectCdp(PORT);
  await sleep(1500); // let the store hydrate
  await cdp1.ev(`window.__orchestraSetState({ activeId: ${JSON.stringify(WS)}, view: 'structured' }); 1`);
  const proof = path.join(RUN, 'detach-proof.txt');
  const prompt =
    `Use the Bash tool to run exactly: sleep 15 && echo DONE > ${proof}\n` +
    `Then reply with exactly: KEEPER_E2E_DONE`;
  await cdp1.ev(`window.orchestra.agentSdkSend(${JSON.stringify(WS)}, ${JSON.stringify(prompt)}); 1`);

  await waitFor('keeper pid file', () => fs.existsSync(keeperPidFile), 30000);
  const kPid = keeperPid();
  const cPid = await waitFor('claude child of keeper', () => claudeChildOf(kPid), 30000);
  check('keeper owns the claude subprocess', alive(kPid) && alive(cPid), `keeper=${kPid} claude=${cPid}`);

  // Wait until the Bash tool is actually running — (a) the structured view
  // shows a running tool row AND (b) a `sleep 15` process that is a DESCENDANT
  // of OUR keeper exists (a bare pgrep once matched a sibling agent's process
  // and made this script close the app before the turn even started). Then
  // close the app MID-TURN.
  const ppidOf = (pid) => {
    const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
    return Number(stat.slice(stat.lastIndexOf(')') + 2).split(' ')[1]);
  };
  const keeperDescendantSleep = () => {
    let pids = [];
    try {
      pids = execSync('pgrep -f "sleep 15"', { encoding: 'utf8' }).trim().split('\n').map(Number);
    } catch {
      return false;
    }
    for (const p of pids) {
      try {
        for (let cur = p, i = 0; i < 8 && cur > 1; i++, cur = ppidOf(cur)) {
          if (cur === kPid) return true;
        }
      } catch {
        /* raced exit */
      }
    }
    return false;
  };
  // Live-streaming half: the user bubble (echoed on send) must be visible in
  // the structured view — proves agent events flow through the keeper bridge
  // into the live DOM, not just the on-disk transcript.
  const liveEcho = await waitFor(
    'structured view shows the sent prompt (live stream over keeper bridge)',
    () => cdp1.ev(`document.body.innerText.includes('KEEPER_E2E_DONE')`),
    30000,
    500,
  ).then(() => true, () => false);
  check('live view streams through the keeper bridge', liveEcho);
  await waitFor('sleep 15 running under OUR keeper', keeperDescendantSleep, 90000);
  const midShot = await Promise.race([
    cdp1.send('Page.captureScreenshot', { format: 'png' }),
    sleep(10000).then(() => null),
  ]);
  if (midShot?.data) fs.writeFileSync(path.join(RUN, 'mid-turn.png'), Buffer.from(midShot.data, 'base64'));
  check('mid-turn (proof not yet written)', !fs.existsSync(proof));
  await cdp1.ev('window.close(); 1').catch(() => {});
  await waitFor('app #1 exited', () => app1.exitCode !== null, 15000);

  // ── phase 2: detached survival ───────────────────────────────────────────
  await sleep(1000);
  check('keeper survived app quit', alive(kPid));
  check('claude survived app quit', alive(cPid));
  await waitFor('proof file written WHILE APP CLOSED', () => fs.existsSync(proof), 90000);
  check('turn completed fully detached', fs.existsSync(proof));
  await sleep(2000);
  check('keeper lingers after turn end (default 15m linger)', alive(kPid) && alive(cPid));

  // ── phase 3: relaunch + reattach ─────────────────────────────────────────
  app2 = launchApp(PORT + 1);
  const cdp2 = await connectCdp(PORT + 1);
  await sleep(1500);
  await cdp2.ev(`window.__orchestraSetState({ activeId: ${JSON.stringify(WS)}, view: 'structured' }); 1`);
  // History backfill + attach: the completed reply must appear in the DOM.
  const gotReply = await waitFor(
    'transcript shows the reply produced while the app was closed',
    () => cdp2.ev(`document.body.innerText.includes('KEEPER_E2E_DONE')`),
    30000,
    500,
  ).then(() => true, () => false);
  check('transcript intact after relaunch (incl. detached work)', gotReply);
  const logFile = path.join(HOME, 'logs', 'orchestra.log');
  const logTxt = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
  check('main log records the reattach', /reattach/i.test(logTxt), logFile ?? 'no log file');

  // Screenshot (paint half). Race a timeout — hangs mean no frames.
  const shot = await Promise.race([
    cdp2.send('Page.captureScreenshot', { format: 'png' }),
    sleep(10000).then(() => null),
  ]);
  const shotPath = path.join(RUN, 'reattached-transcript.png');
  if (shot?.data) fs.writeFileSync(shotPath, Buffer.from(shot.data, 'base64'));
  check('screenshot captured', !!shot?.data && fs.statSync(shotPath).size > 20000, shotPath);

  // ── phase 4: explicit stop kills what quit must not ──────────────────────
  await cdp2.ev(`window.orchestra.agentSdkClear(${JSON.stringify(WS)}); 1`);
  await waitFor('keeper dies on explicit /clear', () => !alive(kPid), 25000);
  check('explicit stop kills keeper', !alive(kPid));
  await waitFor('claude dies on explicit /clear', () => !alive(cPid), 25000);
  check('explicit stop kills claude', !alive(cPid));
  check('keeper artifacts cleaned', !fs.existsSync(path.join(HOME, 'keepers', `${WS}.sock`)));

  await cdp2.ev('window.close(); 1').catch(() => {});
  await waitFor('app #2 exited', () => app2.exitCode !== null, 15000).catch(() => app2.kill('SIGKILL'));

  // ── phase 5: the QUIT-RIGHT-AFTER-SEND wedge (real-usage regression) ──────
  // Quit while the CLI is still in session INIT (hooks/MCP handshake): the
  // dead client orphans the init and the prompt sits unrun in the CLI's
  // queue. Reopen must (a) refuse to attach to the never-started CLI (kill
  // it), (b) REPLAY the persisted prompt so the user's message reappears,
  // and (c) show the Working indicator + eventually the reply.
  await sleep(1000);
  app3 = launchApp(PORT + 2);
  const cdp3 = await connectCdp(PORT + 2);
  await sleep(1500);
  await cdp3.ev(`window.__orchestraSetState({ activeId: ${JSON.stringify(WS)}, view: 'structured' }); 1`);
  await cdp3.ev(
    `window.orchestra.agentSdkSend(${JSON.stringify(WS)}, 'Reply with exactly: RECOVERY_OK'); 1`,
  );
  await waitFor('keeper pid file (phase 5)', () => fs.existsSync(keeperPidFile), 30000);
  const kPid2 = keeperPid();
  const cPid2 = await waitFor('claude child (phase 5)', () => claudeChildOf(kPid2), 30000);
  // Quit IMMEDIATELY — before the CLI finishes init (it just spawned).
  await cdp3.ev('window.close(); 1').catch(() => {});
  await waitFor('app #3 exited', () => app3.exitCode !== null, 15000);
  await sleep(500);
  check('phase5: CLI survived the instant quit (init-stage)', alive(cPid2));

  app4 = launchApp(PORT + 3);
  const cdp4 = await connectCdp(PORT + 3);
  await sleep(1500);
  await cdp4.ev(`window.__orchestraSetState({ activeId: ${JSON.stringify(WS)}, view: 'structured' }); 1`);
  // The recovery path: never-started CLI killed, prompt replayed → user
  // bubble + Working indicator + reply, promptly (NOT after a ~60s wedge).
  const t5 = Date.now();
  const bubbleBack = await waitFor(
    'replayed prompt bubble visible',
    () => cdp4.ev(`document.body.innerText.includes('Reply with exactly: RECOVERY_OK')`),
    20000,
    400,
  ).then(() => true, () => false);
  check('phase5: sent prompt REAPPEARS after reopen (replay)', bubbleBack);
  const sawWorking = await waitFor(
    'working indicator during replayed turn',
    () => cdp4.ev(`!!document.querySelector('.av-working-line')`),
    15000,
    200,
  ).then(() => true, () => false);
  check('phase5: Working indicator shows for the replayed turn', sawWorking);
  const gotReply2 = await waitFor(
    'replayed turn reply',
    () => cdp4.ev(`document.body.innerText.includes('RECOVERY_OK')
      && /RECOVERY_OK[\\s\\S]*$/.test(document.body.innerText)`),
    60000,
    500,
  ).then(() => true, () => false);
  check('phase5: replayed turn completes promptly', gotReply2 && Date.now() - t5 < 60000, `${Math.round((Date.now() - t5) / 1000)}s`);
  await waitFor('phase5: wedged init-stage CLI was killed', () => !alive(cPid2), 20000).then(
    () => check('phase5: never-started CLI killed on reopen', true),
    () => check('phase5: never-started CLI killed on reopen', false, `pid ${cPid2} still alive`),
  );
  const shot5 = await Promise.race([
    cdp4.send('Page.captureScreenshot', { format: 'png' }),
    sleep(10000).then(() => null),
  ]);
  const shot5Path = path.join(RUN, 'recovered-after-instant-quit.png');
  if (shot5?.data) fs.writeFileSync(shot5Path, Buffer.from(shot5.data, 'base64'));
  check('phase5: screenshot captured', !!shot5?.data, shot5Path);

  // teardown: clear (kills the replay session's keeper) and close.
  await cdp4.ev(`window.orchestra.agentSdkClear(${JSON.stringify(WS)}); 1`);
  await sleep(3000);
  await cdp4.ev('window.close(); 1').catch(() => {});
  await waitFor('app #4 exited', () => app4.exitCode !== null, 15000).catch(() => app4.kill('SIGKILL'));
} finally {
  for (const p of [app1, app2, app3, app4]) if (p && p.exitCode === null) p.kill('SIGKILL');
  try {
    if (fs.existsSync(keeperPidFile)) process.kill(keeperPid(), 'SIGKILL');
  } catch {
    /* gone */
  }
  sway.kill('SIGKILL');
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed  (artifacts: ${RUN})`);
process.exit(failed.length ? 1 : 0);
