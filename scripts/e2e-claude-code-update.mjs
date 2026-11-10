// « Mise à jour disponible » (Claude Code) driven in a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway, with a scratch HOME holding a
// native-style install (`~/.local/bin/claude` → `~/.local/share/claude/versions/<v>`) and a local server standing in for the release channel.
//   launch A: disponible at boot → popover (inside the window, ONE button, Escape closes) → the command fails (red, its own stderr) → the failure survives the 30 s re-read →
//             « Réessayer » (en cours, button disabled, a second click starts nothing) → installé → « OK » → no strip. The command ran as `claude update` under NO Compte.
//   launch B: disponible → the install is updated OUTSIDE Orchestra (the link is re-pointed, as `claude update` in a terminal does) → the strip goes away by itself; idle CPU of main.
// The fake `claude` prints what the real 2.1.310 printed (measured 2026-11-10). `--real-claude <binary>` swaps it for a copy of a REAL older Claude Code and the REAL
// release server: launch A then runs the true `claude update` (≈ 340 MB download into the scratch HOME) and skips the fake-only clauses.
//
// Usage (via scripts/e2e-claude-code-update.sh): <app-dir> --live-home <real $HOME> [--out dir] [--label name] [--only A|B] [--real-claude <binary>]
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import path from 'node:path';
import { handedEnvProblems, privateRuntimeDir } from './lib/rig-runtime.mjs';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', 'ccu');
const REAL_CLAUDE = flag('--real-claude', null);
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-claude-code-update.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const XDG = privateRuntimeDir();
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard: nothing this driver hands the app may be a live dir ─────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config'), path.join(LIVE_HOME, '.local')].map(real);
function checkScratch(p) {
  const r = real(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.local/bin')), b = checkScratch('/usr/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.local/bin -> ${a.clause} · /usr path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(100); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });

class Cdp {
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(m.error.message)) : p.res(m.result); } };
  }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms);
      this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async move(x, y) { await this.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y }); }
  async click(x, y) { await this.move(x, y); for (const type of ['mousePressed', 'mouseReleased']) await this.send('Input.dispatchMouseEvent', { type, x, y, button: 'left', clickCount: 1 }); }
  async key(key, code, vk) { for (const type of ['rawKeyDown', 'keyUp']) await this.send('Input.dispatchKeyEvent', { type, key, code, windowsVirtualKeyCode: vk, nativeVirtualKeyCode: vk }); }
  async shot(clip) { const r = await this.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── the fake Claude Code: one script per version, the link re-pointed by a successful `update` — the shape of the native install ──
const REAL_FAILURE = ['Error: Failed to install native update', 'TelemetrySafeError: Failed to fetch version from https://downloads.claude.ai/claude-code-releases/latest after 3 attempt(s): connect ECONNREFUSED 127.0.0.1:9', 'Try running "claude doctor" for diagnostics'];
const fakeScript = (v) => `#!/bin/sh
V=${v}
CTL="$HOME/cc-rig"; VDIR="$HOME/.local/share/claude/versions"
case "$1" in
  --version) echo "$V (Claude Code)"; exit 0 ;;
  update)
    printf 'argv=%s config=%s\\n' "$*" "\${CLAUDE_CONFIG_DIR:-<unset>}" >> "$CTL/calls.log"
    echo "Current version: $V"; echo "Checking for updates to latest version..."
    sleep "$(cat "$CTL/delay")"
    if [ "$(cat "$CTL/mode")" = ok ]; then
      T="$(cat "$CTL/target")"
      sed "s/^V=.*/V=$T/" "$VDIR/$V" > "$VDIR/$T"; chmod +x "$VDIR/$T"; ln -sfn "$VDIR/$T" "$HOME/.local/bin/claude"
      echo "Updating to $T..."; echo "Successfully updated from $V to version $T"; exit 0
    fi
${REAL_FAILURE.map((l) => `    echo '${l}' >&2`).join('\n')}
    exit 1 ;;
esac
exit 2
`;

function seedWorld(armDir, installed) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config');
  const binDir = path.join(fakeHome, '.local/bin'), vdir = path.join(fakeHome, '.local/share/claude/versions'), ctl = path.join(fakeHome, 'cc-rig');
  for (const d of [fakeHome, ohome, cfg, binDir, vdir, ctl]) { fs.mkdirSync(d, { recursive: true }); mustBeScratch('world dir', d); }
  const account = { id: 'rig-ccu', label: 'rig (scratch config dir)', configDir: cfg };
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  let version = installed;
  if (REAL_CLAUDE) {
    version = /(\d+\.\d+\.\d+)/.exec(sh(REAL_CLAUDE, ['--version']))[1];
    fs.copyFileSync(fs.realpathSync(REAL_CLAUDE), path.join(vdir, version), fs.constants.COPYFILE_FICLONE);
    fs.chmodSync(path.join(vdir, version), 0o755);
  } else fs.writeFileSync(path.join(vdir, version), fakeScript(version), { mode: 0o755 });
  const link = path.join(binDir, 'claude');
  fs.symlinkSync(path.join(vdir, version), link);
  const set = (k, v) => fs.writeFileSync(path.join(ctl, k), `${v}\n`);
  set('mode', 'fail'); set('delay', '0'); set('target', '0.0.0');
  const calls = () => { try { return fs.readFileSync(path.join(ctl, 'calls.log'), 'utf8').split('\n').filter(Boolean); } catch { return []; } };
  const pointsAt = () => path.basename(fs.readlinkSync(link));
  /** what `claude update` typed in a terminal does to a native install: a new version file, the link re-pointed */
  const updateElsewhere = (v) => { fs.writeFileSync(path.join(vdir, v), fakeScript(v), { mode: 0o755 }); fs.rmSync(link); fs.symlinkSync(path.join(vdir, v), link); };
  return { fakeHome, ohome, cfg, binDir, link, version, set, calls, pointsAt, updateElsewhere };
}

function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { if (fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0').includes(`ORCHESTRA_HOME=${home}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}
/** the live things this rig must never touch: every ~/.claude* dir's links + MCP keys, ~/.claude.json, and the REAL Claude Code install */
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    // what `claude update` could write there — NOT size/mtime: the live sessions of this machine rewrite .claude.json all day
    snap[`${d} links`] = md5(links);
    try { snap[`${d} settings.json`] = md5(fs.readFileSync(path.join(d, 'settings.json'))); } catch {}
    try { const j = JSON.parse(fs.readFileSync(path.join(d, '.claude.json'), 'utf8')); snap[`${d} install keys`] = JSON.stringify([j.installMethod, j.autoUpdates, j.autoUpdatesProtectedForNative, Object.keys(j.mcpServers || {}).sort()]); } catch {}
  }
  try { const j = JSON.parse(fs.readFileSync(path.join(LIVE_HOME, '.claude.json'), 'utf8')); snap['home .claude.json install keys'] = JSON.stringify([j.installMethod, j.autoUpdates, j.autoUpdatesProtectedForNative]); } catch {}
  try { snap['real claude link'] = fs.readlinkSync(path.join(LIVE_HOME, '.local/bin/claude')); } catch {}
  try { snap['real claude versions'] = fs.readdirSync(path.join(LIVE_HOME, '.local/share/claude/versions')).sort().join(','); } catch {}
  return snap;
}
/** CPU seconds (user + system) the process has used so far */
function cpuSeconds(pid) {
  const f = fs.readFileSync(`/proc/${pid}/stat`, 'utf8'); const a = f.slice(f.lastIndexOf(')') + 2).split(' ');
  return (Number(a[11]) + Number(a[12])) / Number(sh('getconf', ['CLK_TCK']).trim());
}

const dom = (cdp) => cdp.eval(`(() => {
  const q = (s) => document.querySelector(s), R = (el) => { if (!el) return null; const b = el.getBoundingClientRect(); return { top: b.top, bottom: b.bottom, left: b.left, right: b.right, width: b.width, height: b.height }; };
  const strip = q('[data-claude-code-update]'), pop = q('[data-claude-code-update-pop]'), action = q('[data-claude-code-update-action]');
  return { vw: innerWidth, vh: innerHeight, footer: R(q('.sidebar-footer')), sidebar: R(q('.sidebar')),
    strip: strip && { kind: strip.getAttribute('data-claude-code-update'), tone: strip.className.replace('claude-code-update-strip', '').trim(), label: q('.claude-code-update-label').textContent, ver: q('.claude-code-update-ver').textContent, expanded: strip.getAttribute('aria-expanded'), r: R(strip),
      border: getComputedStyle(strip).borderTopColor },
    pop: pop && { kind: pop.getAttribute('data-claude-code-update-pop'), title: pop.querySelector('h3').textContent, installed: q('[data-claude-code-update-installed]').textContent, published: q('[data-claude-code-update-published]') ? q('[data-claude-code-update-published]').textContent : null,
      note: pop.querySelector('p') ? pop.querySelector('p').textContent : '', error: q('[data-claude-code-update-error]') ? q('[data-claude-code-update-error]').textContent.trim() : '', buttons: [...pop.querySelectorAll('button')].map((b) => b.textContent.trim()), r: R(pop),
      action: action && { what: action.getAttribute('data-claude-code-update-action'), label: action.textContent.trim(), disabled: action.disabled, r: R(action) } } };
})()`);
const centre = (r) => [r.left + r.width / 2, r.top + r.height / 2];
const inside = (r, d) => r.left >= 0 && r.top >= 0 && r.right <= d.vw && r.bottom <= d.vh;

async function launch(label, { installed, published }) {
  const armDir = path.join(RIG_DIR, `arm-${label}`); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir, installed);
  // the release channel: a bare version per channel URL, like downloads.claude.ai/claude-code-releases/<channel>
  const channel = { published, hits: [] };
  const server = http.createServer((req, res) => { channel.hits.push(req.url); res.end(`${channel.published}\n`); });
  await new Promise((r) => server.listen(0, '127.0.0.1', r));
  const releases = `http://127.0.0.1:${server.address().port}/claude-code-releases`;
  const port = await freePort();
  const env = { PATH: `${world.binDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: XDG, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8',
    ...(REAL_CLAUDE ? {} : { ORCHESTRA_CLAUDE_RELEASES_URL: releases }) };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  const handed = handedEnvProblems(env, { ohome: world.ohome, cfg: world.cfg, home: world.fakeHome, wayland: RIG_WAYLAND, xdg: XDG, noBusPath: path.join(RIG_DIR, 'no-session-bus') });
  if (handed.length) refuse(`child env: ${handed.join('; ')}`);
  const logFile = path.join(armDir, 'app.log'); const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`\n== launch ${label}: app pid ${app.pid} port ${port} log ${logFile} — installed ${world.version}, channel ${REAL_CLAUDE ? 'the REAL release server' : `${releases} → ${published}`}`);
  let cdp;
  const stop = async () => {
    cdp?.close(); server.closeAllConnections(); server.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    await sleep(500);
    const left = listProcsByHome(world.ohome);
    clause(`${label}/teardown-no-survivors`, left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  };
  try {
    const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
    clause(`${label}/ctl-app-identity-path`, target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
    await waitFor(() => cdp.eval(`!!document.querySelector('.sidebar-footer')`), 60000, 'the sidebar footer');
    const srcs = await cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
    const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
    const frameId = (await cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc = await cdp.send('Page.getResourceContent', { frameId, url: bundle });
    const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
    clause(`${label}/ctl-app-identity-bundle`, !!onDisk && fs.existsSync(onDisk) && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('claude-code-update-strip'), `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file, and contains the strip's marker`);
    const version = await cdp.eval(`window.orchestra.getAppVersion ? window.orchestra.getAppVersion() : null`).catch(() => null);
    const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
    clause(`${label}/ctl-app-identity-version`, version === built, `running app says ${version}, built tree is ${built}`);
    clause(`${label}/ctl-app-in-my-sway`, new RegExp(`"pid":\\s*${app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${app.pid} in my sway's get_tree`);
    // the app honoured the scratch world: it loaded the seeded store (an effect — /proc/<pid>/environ is blind once the D-Bus address is set)
    const accounts = await cdp.eval(`window.orchestra.listAccounts ? window.orchestra.listAccounts().then((a) => a.map((x) => x.id)) : null`).catch((e) => String(e));
    clause(`${label}/ctl-scratch-world`, JSON.stringify(accounts) === '["rig-ccu"]', `accounts the running app lists: ${JSON.stringify(accounts)} (the seeded scratch store)`);
    return { world, channel, app, cdp, stop, appLog: () => { try { return fs.readFileSync(path.join(world.ohome, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } } };
  } catch (e) {
    await stop();
    throw e;
  }
}

async function launchA() {
  const L = await launch('A', { installed: '2.1.310', published: '2.1.322' });
  const { world, channel, cdp } = L;
  const settled = (pred, what, ms = 15000) => waitFor(async () => { const d = await dom(cdp); return pred(d) ? d : null; }, ms, what);
  try {
    // A1 — disponible at boot, quietly above the footer
    const a1 = await settled((d) => d.strip?.kind === 'available', 'the strip « disponible »', REAL_CLAUDE ? 40000 : 20000);
    const want = REAL_CLAUDE ? a1.strip.label.replace(/^Claude Code | disponible$/g, '') : '2.1.322';
    clause('A1/disponible-at-boot', a1.strip.label === `Claude Code ${want} disponible` && a1.strip.ver === world.version && (REAL_CLAUDE || channel.hits.includes('/claude-code-releases/latest')), `strip « ${a1.strip.label} » · installed figure ${a1.strip.ver} · channel requests ${JSON.stringify(channel.hits)}`);
    clause('A1/strip-in-the-sidebar-above-the-footer', a1.strip.r.left >= a1.sidebar.left && a1.strip.r.right <= a1.sidebar.right && a1.strip.r.bottom <= a1.footer.top + 0.5 && a1.strip.r.height > 20 && a1.pop === null, `strip ${JSON.stringify(a1.strip.r)} · sidebar right ${a1.sidebar.right} · footer top ${a1.footer.top} · popover closed`);
    await cdp.move(700, 300);
    saveShot(`${LABEL}-a1-disponible.png`, await cdp.shot());
    const stripClip = { x: Math.floor(a1.strip.r.left), y: Math.floor(a1.strip.r.top), width: Math.ceil(a1.strip.r.width), height: Math.ceil(a1.strip.r.height) };
    const stripPixels = md5(await cdp.shot(stripClip));

    // A2 — the popover: inside the window, both versions, ONE button, Escape closes it and the strip stays
    await cdp.click(...centre(a1.strip.r));
    const a2 = await settled((d) => d.pop, 'the popover');
    clause('A2/popover-content', a2.pop.title === 'Mise à jour de Claude Code disponible' && a2.pop.installed === world.version && a2.pop.published === want && a2.pop.action.label === 'Mettre à jour' && !a2.pop.action.disabled && a2.strip.expanded === 'true',
      `closed -> open · title « ${a2.pop.title} » · Installée ${a2.pop.installed} · Publiée ${a2.pop.published} · button « ${a2.pop.action.label} »`);
    clause('A2/one-button-no-plus-tard', a2.pop.buttons.length === 1, `buttons in the popover: ${JSON.stringify(a2.pop.buttons)}`);
    clause('A2/popover-inside-the-window', inside(a2.pop.r, a2) && a2.pop.r.bottom <= a2.strip.r.top, `popover ${JSON.stringify(a2.pop.r)} in ${a2.vw}x${a2.vh}, above the strip (top ${a2.strip.r.top})`);
    await cdp.move(700, 300);
    saveShot(`${LABEL}-a2-popover.png`, await cdp.shot());
    await cdp.key('Escape', 'Escape', 27);
    const esc = await settled((d) => !d.pop, 'the popover to close on Escape');
    clause('A2/escape-closes-the-strip-stays', esc.pop === null && esc.strip?.kind === 'available', `popover open -> ${esc.pop ? 'open' : 'closed'}; strip still « ${esc.strip?.label} »`);
    await cdp.click(...centre(esc.strip.r));
    let open = await settled((d) => d.pop, 'the popover again');

    if (!REAL_CLAUDE) {
      // A3 — the command fails: red, its own words, « Réessayer »; it ran as `claude update` under no Compte
      world.set('mode', 'fail');
      await cdp.click(...centre(open.pop.action.r));
      const a3 = await settled((d) => d.strip?.kind === 'failed' && d.pop?.kind === 'failed', 'the failure');
      clause('A3/échec-in-the-commands-own-words', a3.strip.label === 'Mise à jour impossible' && a3.strip.tone === 'error' && a3.pop.error === REAL_FAILURE.join('\n') && a3.pop.action.label === 'Réessayer' && a3.strip.border !== a1.strip.border,
        `disponible -> ${a3.strip.kind} · strip « ${a3.strip.label} » border ${a1.strip.border} -> ${a3.strip.border} · error shown = the command's stderr (${a3.pop.error.split('\n').length} lines) · button « ${a3.pop.action.label} »`);
      clause('A3/error-inside-the-window', inside(a3.pop.r, a3), `popover ${JSON.stringify(a3.pop.r)} in ${a3.vw}x${a3.vh}`);
      const calls = world.calls();
      clause('A3/claude-update-under-no-compte', calls.length === 1 && calls[0] === 'argv=update config=<unset>', `the app itself runs with CLAUDE_CONFIG_DIR=${world.cfg}; the command saw: ${JSON.stringify(calls)}`);
      await cdp.move(700, 300);
      saveShot(`${LABEL}-a3-echec.png`, await cdp.shot());

      // A4 — the failure survives the 30 s re-read of the installed version
      await sleep(33000);
      const a4 = await dom(cdp);
      clause('A4/échec-survives-the-re-read', a4.strip?.kind === 'failed' && a4.pop?.kind === 'failed', `33 s later (> one 30 s re-read): strip ${a4.strip?.kind}, popover ${a4.pop?.kind}`);
      open = a4;
    }

    // A5 — « Mettre à jour » / « Réessayer »: en cours, button disabled, a second click starts nothing
    world.set('mode', 'ok'); world.set('delay', '4'); world.set('target', '2.1.322');
    const before = world.calls().length;
    await cdp.click(...centre(open.pop.action.r));
    const a5 = await settled((d) => d.strip?.kind === 'running' && d.pop?.action?.disabled, 'en cours');
    clause('A5/en-cours', a5.strip.label === 'Mise à jour de Claude Code…' && a5.pop.action.label === 'Mise à jour…' && a5.pop.action.disabled, `${open.strip.kind} -> ${a5.strip.kind} · strip « ${a5.strip.label} » · button « ${a5.pop.action.label} » disabled=${a5.pop.action.disabled}`);
    await cdp.click(...centre(a5.pop.action.r));
    await cdp.eval(`window.orchestra.runClaudeCodeUpdate().then(() => 0)`); // a second request while one runs starts nothing
    await cdp.move(700, 300);
    if (!REAL_CLAUDE) saveShot(`${LABEL}-a5-en-cours.png`, await cdp.shot());

    // A6 — installé: the link moved, the popover says which sessions keep the old one
    const a6 = await settled((d) => d.strip?.kind === 'installed', 'installé', REAL_CLAUDE ? 600000 : 20000);
    const now = world.pointsAt();
    clause('A6/installé', a6.strip.label === `Claude Code ${now} installé` && a6.strip.tone === 'ok' && a6.pop.installed === now && a6.pop.published === null && a6.pop.note.includes(`gardent ${world.version} jusqu’à leur prochain démarrage`) && a6.pop.action.label === 'OK' && now !== world.version,
      `running -> ${a6.strip.kind} · strip « ${a6.strip.label} » · the install link points at ${world.version} -> ${now} · note « ${a6.pop.note} »`);
    if (!REAL_CLAUDE) clause('A6/one-command-per-click', world.calls().length === before + 1, `claude update calls ${before} -> ${world.calls().length} across one click, one click on the disabled button and one more request`);
    await cdp.move(700, 300);
    saveShot(`${LABEL}-a6-installe.png`, await cdp.shot());

    // A7 — « OK »: nothing left to say
    await cdp.click(...centre(a6.pop.action.r));
    const a7 = await settled((d) => !d.strip && !d.pop, 'the strip to go away');
    const gone = md5(await cdp.shot(stripClip));
    clause('A7/ok-clears-the-notice', a7.strip === null && a7.pop === null && gone !== stripPixels, `installed -> no strip, no popover · pixels where the strip was: ${stripPixels} -> ${gone}`);
    saveShot(`${LABEL}-a7-rien.png`, await cdp.shot());
    clause('A/app-log-tells-the-story', /state → available/.test(L.appLog()) && /state → installed/.test(L.appLog()), `orchestra.log claude-code-update lines: ${L.appLog().split('\n').filter((l) => l.includes('claude-code-update')).map((l) => l.replace(/^.*claude-code-update\]?\s*/, '')).join(' | ').slice(0, 400)}`);
  } catch (e) {
    clause('A/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    await L.stop();
  }
}

async function launchB() {
  const L = await launch('B', { installed: '2.1.310', published: '2.1.322' });
  const { world, cdp } = L;
  const settled = (pred, what, ms) => waitFor(async () => { const d = await dom(cdp); return pred(d) ? d : null; }, ms, what);
  try {
    const b1 = await settled((d) => d.strip?.kind === 'available', 'the strip « disponible »', 20000);
    await cdp.move(700, 300);
    const clip = { x: Math.floor(b1.strip.r.left), y: Math.floor(b1.strip.r.top), width: Math.ceil(b1.strip.r.width), height: Math.ceil(b1.strip.r.height) };
    const shown = md5(await cdp.shot(clip));
    // idle: nothing happens for 20 s — what the two clocks cost the main process
    const c0 = cpuSeconds(L.app.pid), t0 = Date.now();
    await sleep(20000);
    const pct = ((cpuSeconds(L.app.pid) - c0) / ((Date.now() - t0) / 1000)) * 100;
    clause('B/idle-cpu-of-main', pct < 10, `main process used ${pct.toFixed(1)} % of one core over 20 s idle with the strip shown`);
    // updated in a terminal: the notice clears by itself, Orchestra ran nothing
    await cdp.click(...centre(b1.strip.r));
    const opened = await settled((d) => d.pop, 'the popover', 8000);
    await cdp.move(700, 300);
    const t1 = Date.now();
    world.updateElsewhere('2.1.322');
    const b2 = await settled((d) => !d.strip, 'the strip to go away by itself', 45000).catch(() => dom(cdp)); // still there: the clause below says so
    const dt = (Date.now() - t1) / 1000;
    const gone = md5(await cdp.shot(clip)); // same picture as A7 by design, so compared in place rather than kept as a capture
    clause('B/updated-elsewhere-clears-by-itself', b1.strip.label === 'Claude Code 2.1.322 disponible' && b2.strip === null && b2.pop === null && !!opened.pop && dt <= 40 && world.calls().length === 0 && gone !== shown,
      `disponible (popover open) -> ${b2.strip ? `STILL « ${b2.strip.label} »` : 'no strip'}, popover ${b2.pop ? 'STILL open' : 'gone'} ${dt.toFixed(1)} s after the link was re-pointed (30 s re-read) · claude update calls by Orchestra: ${world.calls().length} · pixels where the strip was: ${shown} -> ${gone}`);
  } catch (e) {
    clause('B/completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    await L.stop();
  }
}

const before = liveCanary();
sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
const ONLY = flag('--only', null); // A | B: one launch (mutant runs)
if (ONLY !== 'B') await launchA();
if (!REAL_CLAUDE && ONLY !== 'A') await launchB();
const after = liveCanary();
const moved = [...new Set([...Object.keys(before), ...Object.keys(after)])].filter((k) => before[k] !== after[k]);
clause('ctl/live-dirs-and-the-real-install-untouched', moved.length === 0, `${Object.keys(before).length} live items read before/after (per live .claude* dir: links, settings.json, install keys of .claude.json; the real claude link → ${before['real claude link'] ?? '?'} and its versions): ${moved.length ? `CHANGED: ${moved.join(', ')}` : 'identical'}`);
const dup = shots.length - new Set(shots.map((s) => s.md5)).size;
clause('ctl/no-duplicate-captures', dup === 0, `${shots.length} captures, ${dup} byte-identical duplicate(s)`);

console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, realClaude: REAL_CLAUDE, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
