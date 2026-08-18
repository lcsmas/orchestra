#!/usr/bin/env node
/* E2E gate for two features (real built app, isolated ORCHESTRA_HOME, headless
 * sway, CDP):
 *
 * A. /loop corner badge (.ws-glyph-loop) — renders on the sidebar status glyph
 *    for a looping workspace in every state it composes with:
 *      idle dot + badge, autoUnread bell + badge, running spinner + badge —
 *    plus a no-badge control row, LIVE detection (a spool `pretool
 *    ScheduleWakeup` line marks the workspace looping while the app runs) and
 *    live turn-end (stop → bell, badge persists).
 *
 * B. Keeper restart status restore — a workspace whose persisted status was
 *    `running` (floored to idle by store.load()) is lifted back to `running` at
 *    startup when a live keeper reports turnInFlight, WITHOUT opening the
 *    workspace. Fake keeper daemons (pid file + unix socket speaking the real
 *    frame protocol) stand in for the CLI: turnInFlight:true must restore
 *    running; turnInFlight:false (lingering keeper) must stay idle — the
 *    negative control that proves the gate discriminates.
 *
 * Usage: node scripts/verify-loop-badge-restore.mjs   (repo root, after
 *        `npx vite build`)
 */
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import crypto from 'node:crypto';
import { spawn, execSync } from 'node:child_process';

const REPO = process.cwd();
const RUN = path.join(os.tmpdir(), `loopbadge-e2e-1494e2ef-${process.pid}`);
const HOME = path.join(RUN, 'home');
const PORT = 9400 + (process.pid % 90);
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

// ── harness: sway ───────────────────────────────────────────────────────────
fs.mkdirSync(HOME, { recursive: true });
const swayCfg = path.join(RUN, 'sway.cfg');
fs.writeFileSync(swayCfg, 'output HEADLESS-1 resolution 1600x1000\n');
const runtimeDir = process.env.XDG_RUNTIME_DIR || `/run/user/${process.getuid()}`;
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

// ── seed store ──────────────────────────────────────────────────────────────
const WS = {
  loopIdle: 'e2e-loop-idle-1',
  loopBell: 'e2e-loop-bell-1',
  restore: 'e2e-keeper-restore-1',
  linger: 'e2e-keeper-linger-1',
  control: 'e2e-plain-control-1',
  // Transcript-based backfill (loops Orchestra never observed live — CC-daemon
  // hosted iterations): armed transcript + NO flag → badge must appear;
  // stopped transcript + STALE flag → badge must clear.
  backfill: 'e2e-loop-backfill-1',
  stalestop: 'e2e-loop-stalestop-1',
};
const mkWs = (id, name, over = {}) => {
  const dir = path.join(RUN, `scratch-${id}`);
  fs.mkdirSync(dir, { recursive: true });
  return {
    id,
    name,
    kind: 'scratch',
    repoPath: '',
    worktreePath: dir,
    branch: name,
    baseBranch: '',
    createdAt: Date.now(),
    status: 'idle',
    agent: 'claude',
    ...over,
  };
};
const storeDir = path.join(HOME, 'userData', 'orchestra');
fs.mkdirSync(storeDir, { recursive: true });
const HOUR = 3600_000;
fs.writeFileSync(
  path.join(storeDir, 'store.json'),
  JSON.stringify(
    {
      repos: [],
      workspaces: [
        mkWs(WS.loopIdle, 'loop-idle', { loopingSince: Date.now() - HOUR }),
        mkWs(WS.loopBell, 'loop-bell', { autoUnread: true, loopingSince: Date.now() - HOUR }),
        // Persisted `running` — store.load() floors it; the fake keeper
        // (turnInFlight:true) must lift it back. loopingSince too: spinner+badge.
        mkWs(WS.restore, 'keeper-restore', { status: 'running', loopingSince: Date.now() - HOUR }),
        // Negative control: live keeper but NO turn in flight → must stay idle.
        mkWs(WS.linger, 'keeper-linger', { status: 'running' }),
        mkWs(WS.control, 'plain-control'),
        mkWs(WS.backfill, 'loop-backfill', { sdkSessionId: 'e2e-sess-backfill' }),
        mkWs(WS.stalestop, 'loop-stalestop', {
          sdkSessionId: 'e2e-sess-stalestop',
          loopingSince: Date.now() - HOUR, // stale flag the scan must CLEAR
        }),
      ],
    },
    null,
    2,
  ),
);

// ── seed transcripts for the backfill cases (real ~/.claude fallback dir — an
// unpinned workspace resolves there; cleaned up in the finally) ─────────────
const mangle = (p) => p.replace(/[^a-zA-Z0-9]/g, '-');
const wsEntry = (input) =>
  JSON.stringify({
    type: 'assistant',
    isSidechain: false,
    timestamp: new Date(Date.now() - 5 * 60_000).toISOString(),
    message: { content: [{ type: 'tool_use', id: 't1', name: 'ScheduleWakeup', input }] },
  }) + '\n';
const transcriptDirs = [];
function seedTranscript(wsId, sessId, input) {
  const dir = path.join(os.homedir(), '.claude', 'projects', mangle(path.join(RUN, `scratch-${wsId}`)));
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, `${sessId}.jsonl`), wsEntry(input));
  transcriptDirs.push(dir);
}
seedTranscript(WS.backfill, 'e2e-sess-backfill', { delaySeconds: 1800, prompt: '/loop x' });
seedTranscript(WS.stalestop, 'e2e-sess-stalestop', { stop: true });

// ── fake keepers (real pid file + real frame protocol on the real socket) ───
const keeperDir = path.join(HOME, 'keepers');
fs.mkdirSync(keeperDir, { recursive: true });
const fakeKeepers = [];
function startFakeKeeper(wsId, turnInFlight) {
  const sockPath = path.join(keeperDir, `${wsId}.sock`);
  const srv = net.createServer((sock) => {
    let buf = '';
    sock.on('data', (d) => {
      buf += d.toString();
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        try {
          const f = JSON.parse(line);
          if (f.t === 'probe') {
            sock.write(
              JSON.stringify({
                t: 'helloAck',
                running: true,
                pid: process.pid,
                everStarted: true,
                turnInFlight,
              }) + '\n',
            );
          }
        } catch {
          /* garbage line — real keepers ignore too */
        }
      }
    });
  });
  srv.listen(sockPath);
  // pid file with OUR live pid — listLiveKeepers checks process liveness.
  fs.writeFileSync(path.join(keeperDir, `${wsId}.pid`), JSON.stringify({ pid: process.pid }));
  fakeKeepers.push(srv);
}
startFakeKeeper(WS.restore, true);
startFakeKeeper(WS.linger, false);
console.log('[harness] fake keepers listening');

// ── app + CDP ───────────────────────────────────────────────────────────────
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
const app = spawn(
  path.join(REPO, 'node_modules/electron/dist/electron'),
  ['.', '--ozone-platform=wayland'],
  { cwd: REPO, env: appEnv, stdio: 'ignore' },
);

async function connectCdp(port) {
  const url = await waitFor(
    'CDP target',
    async () => {
      try {
        const targets = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
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
  await send('Page.enable');
  const ev = async (expr) => {
    const r = await send('Runtime.evaluate', { expression: expr, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(r.exceptionDetails.exception?.description || 'eval threw');
    return r.result?.value;
  };
  return { send, ev, close: () => ws.close() };
}

// Per-workspace glyph inspection, resolved from the store the renderer holds
// (row DOM is name-keyed; glyph is the row's .ws-glyph). Returns the glyph's
// className, whether the loop badge child exists, and geometry.
const GLYPH_PROBE = (name) => `(() => {
  const rows = [...document.querySelectorAll('.ws-item')];
  const row = rows.find((r) => r.textContent.includes(${JSON.stringify(name)}));
  if (!row) return { error: 'row not found: ' + ${JSON.stringify(name)} };
  const glyph = row.querySelector('.ws-glyph');
  if (!glyph) return { error: 'glyph not found in row' };
  const badge = glyph.querySelector('.ws-glyph-loop');
  const spin = glyph.querySelector('.ws-glyph-spin');
  const badgeRect = badge ? badge.getBoundingClientRect() : null;
  const glyphRect = glyph.getBoundingClientRect();
  return {
    cls: glyph.className,
    hasBadge: !!badge,
    hasSpin: !!spin,
    badgeVisible: badge ? getComputedStyle(badge).display !== 'none' : false,
    badgeBg: badge ? getComputedStyle(badge).backgroundColor : null,
    badgeRect: badgeRect ? { x: badgeRect.x, y: badgeRect.y, w: badgeRect.width, h: badgeRect.height } : null,
    glyphRect: { x: glyphRect.x, y: glyphRect.y, w: glyphRect.width, h: glyphRect.height },
    inViewport: badgeRect
      ? badgeRect.left >= 0 && badgeRect.right <= innerWidth && badgeRect.top >= 0 && badgeRect.bottom <= innerHeight
      : null,
  };
})()`;

let cdp;
try {
  cdp = await connectCdp(PORT);
  // Guard: we are driving OUR build, not an installed one.
  const href = await cdp.ev('location.href');
  check('driving this worktree, not an installed build', !href.includes('app.asar'), href);

  // Sidebar rendered with all seven rows.
  await waitFor(
    'sidebar rows',
    () => cdp.ev(`document.querySelectorAll('.ws-item').length >= 7`),
    15000,
  );

  // ── A. static badge states ────────────────────────────────────────────────
  const idle = await cdp.ev(GLYPH_PROBE('loop-idle'));
  check(
    'idle + loop → green-dot glyph carries the badge',
    !idle.error && idle.cls.includes('ws-glyph-idle') && idle.hasBadge && idle.badgeVisible,
    JSON.stringify(idle),
  );
  check('badge is fully inside the viewport', idle.inViewport === true, JSON.stringify(idle.badgeRect));
  check(
    'badge hangs on the glyph corner (overlaps glyph box)',
    idle.badgeRect &&
      idle.badgeRect.x < idle.glyphRect.x + idle.glyphRect.w + 6 &&
      idle.badgeRect.y < idle.glyphRect.y + idle.glyphRect.h + 6,
    '',
  );

  const bell = await cdp.ev(GLYPH_PROBE('loop-bell'));
  check(
    'bell (autoUnread) + loop → bell glyph carries the badge',
    !bell.error && bell.cls.includes('ws-glyph-autounread') && bell.hasBadge,
    JSON.stringify(bell),
  );

  const control = await cdp.ev(GLYPH_PROBE('plain-control'));
  check(
    'control row has NO badge',
    !control.error && !control.hasBadge && control.cls.includes('ws-glyph-idle'),
    JSON.stringify(control),
  );

  // ── B. keeper restart restore ─────────────────────────────────────────────
  // The reconcile is async post-launch; poll until the restore lands.
  const restored = await waitFor(
    'keeper-restore row shows running',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('keeper-restore'));
      return !g.error && g.cls.includes('ws-glyph-running') ? g : null;
    },
    15000,
  ).catch(() => null);
  check(
    'persisted running + keeper turnInFlight → RESTORED to running (spinner)',
    !!restored && restored.hasSpin,
    JSON.stringify(restored),
  );
  check('restored running row also carries the loop badge', !!restored && restored.hasBadge, '');

  // Negative control: linger keeper (turnInFlight:false) must NOT restore.
  // Sample AFTER the positive case landed, so "still idle" is not just "not yet".
  const linger = await cdp.ev(GLYPH_PROBE('keeper-linger'));
  check(
    'lingering keeper (no turn in flight) stays idle — gate discriminates',
    !linger.error && linger.cls.includes('ws-glyph-idle') && !linger.cls.includes('ws-glyph-running'),
    JSON.stringify(linger),
  );

  // ── A2. LIVE loop detection via the spool ─────────────────────────────────
  // Append the exact lines the hook script writes. seq starts at 1.
  const spool = path.join(HOME, 'events', `${WS.control}.jsonl`);
  fs.mkdirSync(path.dirname(spool), { recursive: true });
  fs.appendFileSync(
    spool,
    `{"seq":1,"event":"submit","tool":"","transcript":""}\n` +
      `{"seq":2,"event":"pretool","tool":"ScheduleWakeup","transcript":""}\n`,
  );
  const live = await waitFor(
    'control row gains badge from live ScheduleWakeup',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('plain-control'));
      return !g.error && g.hasBadge && g.cls.includes('ws-glyph-running') ? g : null;
    },
    15000,
  ).catch(() => null);
  check('live spool ScheduleWakeup → running + badge appears', !!live, JSON.stringify(live));

  // Turn end while unfocused-ish: badge must SURVIVE the stop (loop persists
  // across iterations) and the row lands on the bell.
  fs.appendFileSync(spool, `{"seq":3,"event":"stop","tool":"","transcript":""}\n`);
  const afterStop = await waitFor(
    'control row lands on bell with badge after stop',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('plain-control'));
      return !g.error && !g.cls.includes('ws-glyph-running') && g.hasBadge ? g : null;
    },
    15000,
  ).catch(() => null);
  check(
    'turn-end keeps the badge (loop survives iterations) and arms the bell',
    !!afterStop && (afterStop.cls.includes('autounread') || afterStop.cls.includes('idle')),
    JSON.stringify(afterStop),
  );

  // ── A2b. session_crons level signal (self-healing badge) ──────────────────
  // The seq-3 stop above carried NO crons field (old hook script / old CLI) and
  // correctly kept the badge — that was the no-opinion negative control. Now a
  // turn-end whose Stop payload carried session_crons:[] (the hook script
  // reduces it to crons:"none") must CLEAR the badge: a dynamic /loop dies by
  // simply not re-arming, which no edge-triggered rule can see.
  fs.appendFileSync(spool, `{"seq":4,"event":"stop","tool":"","transcript":"","crons":"none"}\n`);
  const afterNone = await waitFor(
    'control row loses badge on crons:none turn-end',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('plain-control'));
      return !g.error && !g.hasBadge ? g : null;
    },
    15000,
  ).catch(() => null);
  check('stop with crons:none → badge self-heals (clears)', !!afterNone, JSON.stringify(afterNone));

  // And crons:"some" alone — no ScheduleWakeup pretool observed this run (the
  // call happened while the app was closed, or mid-turn events were lost) —
  // must SET the badge purely from the level signal.
  fs.appendFileSync(spool, `{"seq":5,"event":"stop","tool":"","transcript":"","crons":"some"}\n`);
  const afterSome = await waitFor(
    'control row regains badge on crons:some turn-end',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('plain-control'));
      return !g.error && g.hasBadge ? g : null;
    },
    15000,
  ).catch(() => null);
  check(
    'stop with crons:some → badge set from the level signal alone',
    !!afterSome && afterSome.badgeVisible,
    JSON.stringify(afterSome),
  );

  // ── A3. transcript-based backfill (daemon-hosted loops) ───────────────────
  // The startup sweep runs async; poll both directions.
  const backfilled = await waitFor(
    'backfill row gains badge from transcript scan',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('loop-backfill'));
      return !g.error && g.hasBadge ? g : null;
    },
    20000,
  ).catch(() => null);
  check(
    'armed transcript + no flag → badge BACKFILLED at startup',
    !!backfilled && backfilled.badgeVisible,
    JSON.stringify(backfilled),
  );
  const cleared = await waitFor(
    'stalestop row loses its stale badge',
    async () => {
      const g = await cdp.ev(GLYPH_PROBE('loop-stalestop'));
      return !g.error && !g.hasBadge ? g : null;
    },
    20000,
  ).catch(() => null);
  check(
    'stopped transcript + stale flag → badge CLEARED at startup',
    !!cleared,
    JSON.stringify(cleared),
  );

  // Tooltip carries the loop clause.
  const title = await cdp.ev(`(() => {
    const rows = [...document.querySelectorAll('.ws-item')];
    const row = rows.find((r) => r.textContent.includes('loop-idle'));
    return row?.querySelector('.ws-glyph')?.getAttribute('title') ?? null;
  })()`);
  check('tooltip appends the looping clause', typeof title === 'string' && title.includes('looping'), String(title));

  // ── screenshots (the paint half) ──────────────────────────────────────────
  const shot = async (file) => {
    const r = await Promise.race([
      cdp.send('Page.captureScreenshot', { format: 'png' }),
      sleep(8000).then(() => null),
    ]);
    if (!r?.data) return null;
    const buf = Buffer.from(r.data, 'base64');
    fs.writeFileSync(file, buf);
    return crypto.createHash('md5').update(buf).digest('hex');
  };
  const shot1 = path.join(RUN, 'sidebar-loop-badges.png');
  const h1 = await shot(shot1);
  check('screenshot captured (paint half)', !!h1, shot1);
  console.log(`[artifact] screenshot: ${shot1}`);
} finally {
  try {
    app.kill('SIGTERM');
  } catch {}
  for (const srv of fakeKeepers) try { srv.close(); } catch {}
  try {
    sway.kill('SIGTERM');
  } catch {}
  // Remove the transcript dirs seeded into the REAL ~/.claude/projects.
  for (const dir of transcriptDirs) try { fs.rmSync(dir, { recursive: true, force: true }); } catch {}
}

const failed = results.filter((r) => !r.ok);
console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
process.exit(failed.length ? 1 : 0);
