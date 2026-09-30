// #235 residual (C10) — BUILT-APP proof: an EMPTY `inherit` account over a live-shaped config dir survives a real
// app boot (index.ts: seed + syncAll), and the Accounts-UI setter (renderer → preload → IPC `accounts:set`)
// is the only path that may prune it to nothing. One Electron boot per arm; SCRATCH HOME + config dir only.
//
// Arms (ok:true = the shipped behaviour; on an unfixed build the ★ arms print ok:false):
//   refuse_live_seed   ★ the driver REFUSES to seed an account whose configDir is a live ~/.claude* dir (named clause, nothing written)
//   boot_empty         ★ store `inherit:{}` + dir holding 7 links / 3 MCP → after boot: byte-identical + ONE warn caller=boot
//   ui_unrelated_save  ★ same seed; window.orchestra.setAccounts(label edit) → still byte-identical + warn caller=ui-save
//   ui_deselect          must-PASS: store FULL; boot keeps it; setAccounts(no inherit) → links/MCP pruned, own MCP + trust kept
//
// Usage: scripts/e2e-inherit-empty-boot.sh <app-dir> [--arm a,b] [--list]   (own headless sway, env -i allowlist)

import path from 'node:path';
import fs from 'node:fs';
import net from 'node:net';
import crypto from 'node:crypto';
import { spawn, execFileSync } from 'node:child_process';
// Imported before anything re-homes: live dirs are captured at its load.
import { REAL_HOMES, checkScratch, liveCanary, canaryDiff } from './.scratch-guard.mjs';

const ARMS = ['refuse_live_seed', 'boot_empty', 'ui_unrelated_save', 'ui_deselect'];
const argv = process.argv.slice(2);
if (argv.includes('--list')) { console.log(ARMS.join('\n')); process.exit(0); }
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? path.resolve(argv[0]) : null;
const armIdx = argv.indexOf('--arm');
const WANT = armIdx >= 0 ? argv[armIdx + 1].split(',') : ARMS;
for (const a of WANT) if (!ARMS.includes(a)) { console.error(`unknown arm: ${a}`); process.exit(2); }
if (!APP_DIR) { console.error('usage: e2e-inherit-empty-boot.sh <app-dir> [--arm a,b] [--list]'); process.exit(2); }

const need = ['RIG_DIR', 'RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
if (need.length) { console.error(`not launched via scripts/e2e-inherit-empty-boot.sh (missing ${need.join(', ')})`); process.exit(2); }
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms, step = 100) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout waiting for ${what}`);
    await sleep(step);
  }
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const { port } = s.address(); s.close(() => res(port)); }); s.on('error', rej); });

// ---- containment: assert what the child will get BEFORE launch ----------------------------------------
function checkChildEnv(env) {
  if (!env.WAYLAND_DISPLAY) return { ok: false, clause: 'no-wayland', detail: 'child has no WAYLAND_DISPLAY' };
  if (env.WAYLAND_DISPLAY === 'wayland-1') return { ok: false, clause: 'human-compositor', detail: 'refusing wayland-1' };
  if (env.WAYLAND_DISPLAY !== RIG_WAYLAND) return { ok: false, clause: 'not-my-sway', detail: `${env.WAYLAND_DISPLAY} != ${RIG_WAYLAND}` };
  if ('DISPLAY' in env) return { ok: false, clause: 'x11-reachable', detail: `DISPLAY=${env.DISPLAY}` };
  if ('APPIMAGE' in env) return { ok: false, clause: 'appimage-env', detail: 'APPIMAGE would hand off to the installed build' };
  for (const k of ['HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) {
    const v = checkScratch(env[k], RIG_DIR);
    if (!v.ok) return { ok: false, clause: `${k}:${v.clause}`, detail: v.detail };
  }
  return { ok: true, clause: 'contained', detail: '' };
}

// ---- the seeded world (no product code: links, manifest and MCP are written by hand) -------------------
const put = (p, body) => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, body); };
const FULL = { settings: true, statusline: true, skills: ['frontend-design', 'handoff'], mcpServers: ['github', 'linear-server', 'chrome-devtools'] };
const LINKS = ['CLAUDE.md', 'LESSONS.md', 'RTK.md', 'settings.json', 'skills/frontend-design', 'skills/handoff', 'statusline-command.sh'];
const INJECTED = ['github', 'linear-server', 'chrome-devtools'];

function seedWorld(armRoot, { inherit, configDir }) {
  const home = path.join(armRoot, 'home');
  const oh = path.join(armRoot, 'oh');
  const login = configDir ?? path.join(home, '.claude-mc');
  for (const p of [armRoot, home, oh, login]) {
    const g = checkScratch(p, RIG_DIR);
    if (!g.ok) throw new Error(`REFUSED before any write [${g.clause}]: ${g.detail}`);
  }
  fs.mkdirSync(login, { recursive: true });
  const g = path.join(home, '.claude');
  put(path.join(g, 'settings.json'), '{"model":"opus"}\n');
  put(path.join(g, 'CLAUDE.md'), '@RTK.md\n@LESSONS.md\n\n# global\n');
  put(path.join(g, 'RTK.md'), '# rtk\n');
  put(path.join(g, 'LESSONS.md'), '# lessons\n');
  put(path.join(g, 'statusline-command.sh'), '#!/bin/sh\necho hi\n');
  put(path.join(g, 'skills', 'frontend-design', 'SKILL.md'), '# fd\n');
  put(path.join(g, 'skills', 'handoff', 'SKILL.md'), '# handoff\n');
  const defs = { github: { command: 'gh' }, 'linear-server': { url: 'u' }, 'chrome-devtools': { command: 'cd' } };
  put(path.join(home, '.claude.json'), JSON.stringify({ mcpServers: defs }));
  for (const rel of LINKS) { fs.mkdirSync(path.dirname(path.join(login, rel)), { recursive: true }); fs.symlinkSync(path.join(g, rel), path.join(login, rel)); }
  put(path.join(login, '.claude.json'), JSON.stringify({ mcpServers: { ...defs, 'my-own': { command: 'mine' } }, projects: { '/scratch/proj': { hasTrustDialogAccepted: true } } }, null, 2));
  put(path.join(login, '.orchestra-inherited.json'), JSON.stringify({ source: g, symlinks: LINKS, mcpServers: INJECTED }, null, 2));
  const account = { id: 'rig-c10', label: 'mc', configDir: login, ...(inherit === undefined ? {} : { inherit }) };
  put(path.join(oh, 'userData', 'orchestra', 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  return { home, oh, login, account };
}
function snapshot(dir) {
  const o = {};
  const walk = (d, rel) => {
    for (const ent of fs.readdirSync(d, { withFileTypes: true })) {
      const p = path.join(d, ent.name); const r = rel ? `${rel}/${ent.name}` : ent.name;
      const st = fs.lstatSync(p);
      if (st.isSymbolicLink()) o[r] = `L:${fs.readlinkSync(p)}`;
      else if (st.isDirectory()) { o[r] = 'D'; walk(p, r); }
      else o[r] = `F:${crypto.createHash('sha256').update(fs.readFileSync(p)).digest('hex')}`;
    }
  };
  walk(dir, '');
  return o;
}
const linksOf = (s) => Object.keys(s).filter((k) => s[k].startsWith('L:')).sort();
const mcpOf = (login) => Object.keys(JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8')).mcpServers ?? {}).sort();
const manifestOf = (login) => JSON.parse(fs.readFileSync(path.join(login, '.orchestra-inherited.json'), 'utf8'));

// ---- minimal CDP over the global WebSocket -----------------------------------------------------------------
async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
  let id = 0; const pending = new Map();
  ws.onmessage = (m) => { const j = JSON.parse(m.data); if (j.id && pending.has(j.id)) { pending.get(j.id)(j); pending.delete(j.id); } };
  return {
    eval: (expression) => new Promise((res, rej) => {
      const i = ++id; const t = setTimeout(() => rej(new Error('cdp eval timeout')), 20000);
      pending.set(i, (j) => { clearTimeout(t); j.result?.exceptionDetails ? rej(new Error(JSON.stringify(j.result.exceptionDetails).slice(0, 300))) : res(j.result?.result?.value); });
      ws.send(JSON.stringify({ id: i, method: 'Runtime.evaluate', params: { expression, awaitPromise: true, returnByValue: true } }));
    }),
    close: () => { try { ws.close(); } catch { /* gone */ } },
  };
}

// ---- boot one app ------------------------------------------------------------------------------------------------
async function boot(arm, seed) {
  const armRoot = path.join(RIG_DIR, `arm-${arm}`);
  fs.rmSync(armRoot, { recursive: true, force: true });
  const world = seedWorld(armRoot, seed);
  const port = await freePort();
  const electron = path.join(APP_DIR, 'node_modules/electron/dist/electron');
  if (!fs.existsSync(electron)) throw new Error(`no electron binary at ${electron}`);
  const env = {
    PATH: '/usr/local/bin:/usr/bin:/bin', HOME: world.home, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
    XDG_CONFIG_HOME: path.join(world.home, '.config'), XDG_CACHE_HOME: path.join(world.home, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, LANG: 'C.UTF-8',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.oh, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true',
    CLAUDE_CONFIG_DIR: world.login,
  };
  const pre = checkChildEnv(env);
  if (!pre.ok) throw new Error(`REFUSED before launch [${pre.clause}]: ${pre.detail}`);
  const logFd = fs.openSync(path.join(armRoot, 'app.log'), 'w');
  const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', logFd, logFd], detached: true });
  const app = { arm, armRoot, world, port, child, pid: child.pid, exited: false, cdp: null };
  child.on('exit', () => { app.exited = true; });
  app.logLines = () => { try { return fs.readFileSync(path.join(world.oh, 'logs', 'orchestra.log'), 'utf8').split('\n'); } catch { return []; } };
  app.heldWarns = (caller) => app.logLines().filter((l) => l.includes('would leave no inherited item') && l.includes(`caller=${caller} `) && l.includes(world.login));
  app.close = async () => {
    app.cdp?.close();
    if (!app.exited && app.pid) {
      try { process.kill(-app.pid, 'SIGTERM'); } catch { /* gone */ }
      await sleep(1500);
      try { process.kill(-app.pid, 'SIGKILL'); } catch { /* gone */ }
    }
    // the app must not outlive us: nothing whose cmdline names this arm root may remain
    const left = execFileSync('ps', ['-eo', 'pid,args'], { encoding: 'utf8' }).split('\n').filter((l) => l.includes(armRoot) && !l.includes('ps -eo'));
    app.leftovers = left.length;
  };
  try {
    const target = await waitFor(`CDP target on :${port}`, async () => {
      if (app.exited) throw new Error(`electron exited early (see ${armRoot}/app.log)`);
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html'));
        return t.length ? t[0] : null;
      } catch { return null; }
    }, 60000, 300);
    app.target = target;
    app.cdp = await cdpConnect(target.webSocketDebuggerUrl);
    app.version = await app.cdp.eval('window.orchestra.getAppVersion()');
    return app;
  } catch (e) { await app.close(); e.app = app; throw e; }
}

const pkgVersion = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
/** Boot's sync is fire-and-forget: wait for its OBSERVABLE effect (held-block warn, or the strip) — never sleep-then-read. */
const bootSettled = (app) => waitFor('boot sync effect', () => app.heldWarns('boot').length > 0 || linksOf(snapshot(app.world.login)).length < LINKS.length || manifestOf(app.world.login).symlinks.length === 0, 30000, 100).then(() => true, () => false);

async function runArm(arm) {
  const out = { arm };
  if (arm === 'refuse_live_seed') {
    // Under the contained rig the driver's own HOME is the rig's fake one, so REAL_HOMES holds BOTH it and the
    // passwd home — refuse a live `~/.claude-mc` under every one of them (the lexical clause fires even if absent).
    const armRoot = path.join(RIG_DIR, 'arm-refuse');
    const verdicts = REAL_HOMES.map((h) => {
      let refused = null;
      try { seedWorld(armRoot, { inherit: {}, configDir: path.join(h, '.claude-mc') }); } catch (e) { refused = String(e.message); }
      return { home: h, refused };
    });
    Object.assign(out, { verdicts, armRootCreated: fs.existsSync(armRoot) });
    out.ok = verdicts.length >= 1 && verdicts.every((v) => v.refused?.includes('[live-claude-dir]')) && !out.armRootCreated;
    return out;
  }
  const seed = arm === 'ui_deselect' ? { inherit: FULL } : { inherit: {} };
  const app = await boot(arm, seed);
  try {
    const login = app.world.login;
    const settled = await bootSettled(app);
    // give a (buggy) prune time to land after boot's own observable settled, then read
    await sleep(500);
    const afterBoot = snapshot(login);
    Object.assign(out, {
      appVersion: app.version, buildVersion: pkgVersion, targetUrl: app.target.url, loginIsScratch: checkScratch(login, RIG_DIR).ok,
      bootSettled: settled, bootLinks: linksOf(afterBoot).length, bootMcp: mcpOf(login), bootHeldWarns: app.heldWarns('boot').length,
    });
    const identity = app.version === pkgVersion && app.target.url.includes(APP_DIR);
    out.identity = identity;
    if (arm === 'boot_empty') {
      out.ok = identity && settled && linksOf(afterBoot).length === 7 && mcpOf(login).join() === 'chrome-devtools,github,linear-server,my-own' && out.bootHeldWarns === 1
        && manifestOf(login).symlinks.length === 7;
    } else if (arm === 'ui_unrelated_save') {
      const seedSnap = afterBoot;
      // the renderer's own setter: label edit only — the account is ALREADY empty, nothing was de-selected
      await app.cdp.eval(`window.orchestra.setAccounts([{ id: 'rig-c10', label: 'mc-renamed', configDir: ${JSON.stringify(login)} }]).then((a) => a.map((x) => x.label))`);
      const ran = await waitFor('ui-save sync effect', () => app.heldWarns('ui-save').length > 0 || linksOf(snapshot(login)).length < LINKS.length, 20000, 100).then(() => true, () => false);
      await sleep(500);
      const after = snapshot(login);
      Object.assign(out, { syncRan: ran, links: linksOf(after).length, mcp: mcpOf(login), byteIdentical: JSON.stringify(after) === JSON.stringify(seedSnap), uiHeldWarns: app.heldWarns('ui-save').length });
      out.ok = identity && settled && ran && out.byteIdentical && out.uiHeldWarns === 1 && linksOf(after).length === 7;
    } else if (arm === 'ui_deselect') {
      out.preOk = linksOf(afterBoot).length === 7; // boot with a normal FULL selection changes nothing
      const saved = await app.cdp.eval(`window.orchestra.setAccounts([{ id: 'rig-c10', label: 'mc', configDir: ${JSON.stringify(login)} }]).then((a) => a.map((x) => ({ id: x.id, inherit: x.inherit ?? null })))`);
      const pruned = await waitFor('UI de-selection prune', () => linksOf(snapshot(login)).length === 0, 20000, 100).then(() => true, () => false);
      await sleep(500);
      const cj = JSON.parse(fs.readFileSync(path.join(login, '.claude.json'), 'utf8'));
      Object.assign(out, {
        saved, pruned, links: linksOf(snapshot(login)).length, mcp: mcpOf(login), manifest: manifestOf(login),
        trustKept: JSON.stringify(cj.projects) === JSON.stringify({ '/scratch/proj': { hasTrustDialogAccepted: true } }),
        intentLogged: app.logLines().some((l) => l.includes('UI de-selection pruned 7 link(s) + 3 MCP')),
      });
      out.ok = identity && out.preOk && pruned && out.links === 0 && out.mcp.join() === 'my-own' && out.manifest.symlinks.length === 0
        && out.manifest.mcpServers.length === 0 && out.trustKept && saved[0].inherit === null;
    }
    return out;
  } finally {
    await app.close();
    out.leftovers = app.leftovers;
  }
}

const canaryBefore = liveCanary();
const results = [];
for (const arm of WANT) {
  let r;
  try { r = await runArm(arm); } catch (e) { r = { arm, ok: false, error: String(e.message ?? e).slice(0, 400) }; }
  if (r.leftovers) r.ok = false; // a surviving process is a failure of its own
  results.push(r);
  console.log(JSON.stringify(r));
}
const canaryAfter = liveCanary();
const diff = canaryDiff(canaryBefore, canaryAfter);
const unchanged = diff.strict.length === 0;
const bad = results.filter((r) => !r.ok).map((r) => r.arm);
console.log(`LIVE-CANARY (find depth<=2; STRICT = symlink set + inherit manifest + MCP key list; ${Object.keys(canaryBefore).length} dirs): strict ${unchanged ? 'UNCHANGED' : 'CHANGED ' + JSON.stringify(diff.strict)}; churn ${JSON.stringify(diff.churn)}`);
console.log(`SUMMARY arms=${results.length} ok=${results.length - bad.length} notok=${bad.length}${bad.length ? ' [' + bad.join(',') + ']' : ''} appDir=${APP_DIR} version=${pkgVersion} canary=${unchanged ? 'UNCHANGED' : 'CHANGED'}`);
process.exit(bad.length === 0 && unchanged ? 0 : 1);
