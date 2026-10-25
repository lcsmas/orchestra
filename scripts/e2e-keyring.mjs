// #389 — Linux keyring selection / re-encryption / Settings warning, driven in a BUILT Orchestra (argv[2] = app dir) inside the
// contained rig's own headless sway. One ARM = one private world: its own `dbus-run-session` (a bus config that lists NO host service
// dirs), its own gnome-keyring-daemon under scratch XDG_DATA_HOME / XDG_RUNTIME_DIR, its own ORCHESTRA_HOME / HOME / claude config.
// Arms: unlocked · locked · nosvc · recognised · hung · gnome · relock · isolated · fleet. Every arm but isolated/fleet opts in with ORCHESTRA_KEYRING=probe
// (an ORCHESTRA_HOME instance never touches a keyring otherwise — review F1); `fleet` is the REAL fleet-rig env (real XDG_RUNTIME_DIR, no opt-in). Every clause is cross-read from independent surfaces: the app's log line,
// the renderer's IPC answer (`getSecretsState`), the secrets file bytes, the PRIVATE keyring itself over D-Bus (Locked / item count), the DOM
// and a screenshot. Positive controls: app identity, scratch env read back out of the running process, app present in MY sway, the private
// bus really lacks / has org.freedesktop.secrets before the app starts. The host's real keyring files are hashed before/after.
//
// Usage (via scripts/e2e-keyring.sh): <app-dir> --live-home <real $HOME> [--arms a,b] [--out dir] [--label name]
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const ARMS = (flag('--arms', 'unlocked,locked,nosvc,recognised,hung,gnome,relock,isolated,isolated-gnome,fleet')).split(',').filter(Boolean);
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-keyring.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const HUMAN_RUNTIME = '/run/user/1000'; // where the human's REAL bus + keyring control socket live — never an app input

// ── scratch-containment guard (same shape as e2e-memory-guard-ui.mjs) ───────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config'), path.join(LIVE_HOME, '.local/share/keyrings'), HUMAN_RUNTIME].map(liveReal);
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.local/share/keyrings')), b = checkScratch(`${HUMAN_RUNTIME}/bus`), c = checkScratch('/tmp/not-in-the-rig'), d = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'live-dir' || c.clause !== 'outside-rig-base' || !d.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c, d })}`);
  console.log(`[guard] self-test: human keyrings -> ${a.clause} · human runtime bus -> ${b.clause} · /tmp path -> ${c.clause} · rig path -> ${d.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha = (b) => crypto.createHash('sha256').update(b).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(120); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; } else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0; let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1; else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
function crop(I, x, y, w, h) { const out = Buffer.alloc(w * h * I.ch); for (let r = 0; r < h; r++) I.data.copy(out, r * w * I.ch, ((y + r) * I.w + x) * I.ch, ((y + r) * I.w + x + w) * I.ch); return { w, h, ch: I.ch, data: out }; }
function inkPx(I, tol = 6) {
  const cnt = new Map();
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch, k = (I.data[o] << 16) | (I.data[o + 1] << 8) | I.data[o + 2]; cnt.set(k, (cnt.get(k) || 0) + 1); }
  let mode = 0, best = -1; for (const [k, v] of cnt) if (v > best) { best = v; mode = k; }
  const mr = mode >> 16, mg = (mode >> 8) & 255, mb = mode & 255; let n = 0;
  for (let p = 0; p < I.w * I.h; p++) { const o = p * I.ch; if (Math.abs(I.data[o] - mr) > tol || Math.abs(I.data[o + 1] - mg) > tol || Math.abs(I.data[o + 2] - mb) > tol) n++; }
  return n;
}

class Cdp {
  constructor(ws) { this.ws = ws; this.id = 0; this.pending = new Map(); ws.onmessage = (ev) => { const m = JSON.parse(ev.data); const p = m.id && this.pending.get(m.id); if (p) { this.pending.delete(m.id); m.error ? p.rej(new Error(`${m.error.message}`)) : p.res(m.result); } }; }
  static async connect(url) { const ws = new WebSocket(url); await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('ws error')); }); return new Cdp(ws); }
  send(method, params = {}, ms = 20000) { const id = ++this.id; return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); }); }
  async eval(expr, ms = 20000) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }, ms); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  async shot() { const r = await this.send('Page.captureScreenshot', { format: 'png' }, 25000); return Buffer.from(r.data, 'base64'); }
  close() { try { this.ws.close(); } catch {} }
}

const results = [];
const shots = [];
function clause(name, ok, detail) { results.push({ clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  ${name} — ${detail}`); }
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── what is on the human's host that this rig must leave byte-equal (G10) ─────────────────────────────────────────────
function liveFiles() {
  const out = [];
  const add = (p) => { try { if (fs.statSync(p).isFile()) out.push(p); } catch {} };
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) for (const f of ['settings.json', 'settings.local.json']) add(path.join(d, f)); // NOT .credentials.json: the live sessions refresh their own OAuth token there (normal churn; the rig's app never has these dirs)
  for (const base of [path.join(LIVE_HOME, '.config/orchestra'), path.join(LIVE_HOME, '.orchestra')]) {
    try { for (const f of sh('find', [base, '-maxdepth', '4', '-name', 'secrets.json', '-type', 'f'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) add(f); } catch {}
  }
  try { for (const f of fs.readdirSync(path.join(LIVE_HOME, '.local/share/keyrings'))) add(path.join(LIVE_HOME, '.local/share/keyrings', f)); } catch {}
  return out.sort();
}
function realItems() { // READ-ONLY metadata (labels + creation times, never a secret value) of the human's default collection — only used to ATTRIBUTE a changed keyring file
  const env = { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: HUMAN_RUNTIME };
  const g = (obj, iface, prop) => spawnSync('gdbus', ['call', '--session', '--timeout', '3', '--dest', 'org.freedesktop.secrets', '--object-path', obj, '--method', 'org.freedesktop.DBus.Properties.Get', iface, prop], { encoding: 'utf8', env, timeout: 6000 }).stdout || '';
  const items = (g('/org/freedesktop/secrets/aliases/default', 'org.freedesktop.Secret.Collection', 'Items').replace(/\n/g, '').match(/\/org\/freedesktop\/secrets\/collection\/[^'\]]*/g) || []);
  return items.map((it) => `${it.split('/').pop()}:"${/<'(.*)'>/.exec(g(it, 'org.freedesktop.Secret.Item', 'Label'))?.[1] ?? '?'}"@${new Date(Number(/\d{9,}/.exec(g(it, 'org.freedesktop.Secret.Item', 'Created'))?.[0] ?? 0) * 1000).toTimeString().slice(0, 8)}`).join(' ');
}
const liveHash = () => Object.fromEntries(liveFiles().map((f) => [f, sha(fs.readFileSync(f))]));
function realLoginCollectionLocked() { // READ-ONLY: one Properties.Get Locked on the human's real bus (allowed by the brief); never a write
  const r = spawnSync('gdbus', ['call', '--session', '--timeout', '3', '--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets/aliases/default', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', 'Locked'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: HUMAN_RUNTIME }, timeout: 5000 });
  return r.status === 0 ? r.stdout.trim() : `unavailable(${r.status ?? r.error?.code})`;
}

// ── the private world of one arm ─────────────────────────────────────────────────────────────────────────────────────
const SEED = {
  linear: 'lin_api_RIG389_PLAINTEXT_LINEAR',
  key: 'sk-ant-RIG389-PLAINTEXT-ACCOUNT',
  url: 'https://gateway-rig389.internal.example',
};
function seedWorld(armDir, spec) {
  const w = { armDir };
  for (const k of ['home', 'oh', 'claude-config', 'run', 'data', 'config', 'cache', 'stub-bin', 'svc']) { w[k] = path.join(armDir, k); fs.mkdirSync(w[k], { recursive: true }); }
  fs.chmodSync(w.run, 0o700);
  w.bus = path.join(w.run, 'bus');
  w.address = `unix:path=${w.bus}`;
  for (const [k, v] of Object.entries({ home: w.home, oh: w.oh, cfg: w['claude-config'], run: w.run, data: w.data, config: w.config, cache: w.cache })) mustBeScratch(`world.${k}`, v);
  const account = { id: 'rig-kr389', label: 'rig (scratch config dir)', configDir: w['claude-config'] };
  const dir = path.join(w.oh, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  w.secretsFile = path.join(dir, 'secrets.json');
  // The state of "the human used Orchestra on a box with no keyring": every kind of entry stored in plaintext.
  fs.writeFileSync(w.secretsFile, JSON.stringify({ linearApiKey: SEED.linear, enc: false, accountApiKeys: { [account.id]: { value: SEED.key, enc: false } }, accountBaseUrls: { [account.id]: { value: SEED.url, enc: false } } }), { mode: 0o600 });
  w.logFile = path.join(w.oh, 'logs', 'orchestra.log');
  fs.writeFileSync(path.join(w['stub-bin'], 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
  if (spec.hungGdbus) fs.writeFileSync(path.join(w['stub-bin'], 'gdbus'), '#!/bin/sh\nsleep 30\n', { mode: 0o755 }); // a Secret Service probe that never answers
  fs.writeFileSync(path.join(armDir, 'session.conf'), `<!DOCTYPE busconfig PUBLIC "-//freedesktop//DTD D-Bus Bus Configuration 1.0//EN" "http://www.freedesktop.org/standards/dbus/1.0/busconfig.dtd">
<busconfig>
  <type>session</type>
  <keep_umask/>
  <listen>${w.address}</listen>
  <auth>EXTERNAL</auth>
  <servicedir>${w.svc}</servicedir>
  <policy context="default">
    <allow send_destination="*" eavesdrop="true"/>
    <allow eavesdrop="true"/>
    <allow own="*"/>
  </policy>
</busconfig>
`);
  return w;
}
/** env for the helper tools (bus daemon, keyring daemon, gdbus oracle) — an allowlist, scratch XDG dirs, the PRIVATE bus */
const toolEnv = (w) => ({ PATH: '/usr/bin:/bin', HOME: w.home, XDG_RUNTIME_DIR: w.run, XDG_DATA_HOME: w.data, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, DBUS_SESSION_BUS_ADDRESS: w.address, LANG: 'C.UTF-8' });
const gdbus = (w, args, ms = 4000) => spawnSync('gdbus', ['call', '--session', '--timeout', '2', ...args], { encoding: 'utf8', env: toolEnv(w), timeout: ms });
const secretsGet = (w, prop) => gdbus(w, ['--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets/aliases/default', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', prop]);
const busNames = (w) => gdbus(w, ['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', 'org.freedesktop.DBus.ListNames']).stdout;
const lockedOf = (w) => { const r = secretsGet(w, 'Locked'); return r.status === 0 ? (/<true>/.test(r.stdout) ? 'locked' : /<false>/.test(r.stdout) ? 'unlocked' : `odd:${r.stdout.trim()}`) : 'no-service'; };
const itemLabels = (w) => { // labels of the PRIVATE collection's items (metadata only) — attribution evidence: whose "<app> Safe Storage" is it
  const r = secretsGet(w, 'Items'); if (r.status !== 0) return [];
  return (r.stdout.replace(/\n/g, '').match(/\/org\/freedesktop\/secrets\/collection\/[^'\]]*/g) || []).map((it) => { const l = gdbus(w, ['--dest', 'org.freedesktop.secrets', '--object-path', it, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Item', 'Label']); return /<'(.*)'>/.exec(l.stdout || '')?.[1] ?? '?'; });
};
const itemCount = (w) => { const r = secretsGet(w, 'Items'); return r.status === 0 ? (r.stdout.match(/\/org\/freedesktop\/secrets\/collection\//g) || []).length : -1; };

/** processes (any depth) whose ORIGINAL environment carries this exact XDG_RUNTIME_DIR — i.e. this arm's world and nothing else */
function procsOfWorld(w) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) { try { const e = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (e.includes(`XDG_RUNTIME_DIR=${w.run}`) || e.includes(`ORCHESTRA_HOME=${w.oh}`)) out.push(+p); } catch {} }
  return out.filter((p) => p !== process.pid);
}
const killWorld = async (w) => { for (const sig of ['SIGTERM', 'SIGKILL']) { for (const p of procsOfWorld(w)) { try { process.kill(p, sig); } catch {} } await sleep(sig === 'SIGTERM' ? 1500 : 300); } };

async function startBus(w) {
  const child = spawn('dbus-run-session', [`--config-file=${path.join(w.armDir, 'session.conf')}`, '--', 'sleep', '7200'], { env: { PATH: '/usr/bin:/bin', HOME: w.home, XDG_RUNTIME_DIR: w.run, XDG_DATA_HOME: w.data, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, LANG: 'C.UTF-8' }, stdio: 'ignore', detached: true });
  child.unref();
  await waitFor(() => { try { return fs.statSync(w.bus).isSocket(); } catch { return false; } }, 10000, 'the private session bus socket');
  return child;
}
function keyringStart(w, { unlock }) {
  const env = toolEnv(w);
  if (unlock) {
    const r = spawnSync('gnome-keyring-daemon', ['--login', '--components=secrets'], { env, input: 'rigpw', encoding: 'utf8', timeout: 15000 });
    if (r.status !== 0) throw new Error(`gnome-keyring-daemon --login rc=${r.status} ${r.stderr}`);
  }
  const r2 = spawnSync('gnome-keyring-daemon', ['--start', '--components=secrets'], { env, encoding: 'utf8', timeout: 15000 });
  if (r2.status !== 0) throw new Error(`gnome-keyring-daemon --start rc=${r2.status} ${r2.stderr}`);
}
async function keyringStopOnly(w) { // stop JUST the keyring daemons, keep the bus up (the world's other processes are the bus + sleep)
  for (const p of procsOfWorld(w)) { try { if (fs.readFileSync(`/proc/${p}/comm`, 'utf8').startsWith('gnome-keyring')) process.kill(p, 'SIGTERM'); } catch {} }
  await waitFor(() => !procsOfWorld(w).some((p) => { try { return fs.readFileSync(`/proc/${p}/comm`, 'utf8').startsWith('gnome-keyring'); } catch { return false; } }), 8000, 'the keyring daemon to exit');
}

// ── the app ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function bootApp(w, spec) {
  const port = await freePort();
  const env = { PATH: `${w['stub-bin']}:/usr/local/bin:/usr/bin:/bin`, HOME: w.home, XDG_RUNTIME_DIR: spec.realRuntime ? HUMAN_RUNTIME : w.run, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, XDG_DATA_HOME: w.data,
    XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: `${HUMAN_RUNTIME}/${RIG_WAYLAND}`, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: w.oh, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: w['claude-config'], LANG: 'C.UTF-8' };
  if (spec.desktop) env.XDG_CURRENT_DESKTOP = spec.desktop;
  if (spec.optIn !== false) env.ORCHESTRA_KEYRING = 'probe'; // the rig's private bus is the point; isolated/fleet arms leave it unset
  if (spec.bus === 'env') env.DBUS_SESSION_BUS_ADDRESS = w.address; // else: the host's shape — no address variable, the bus only at $XDG_RUNTIME_DIR/bus
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', ...(spec.realRuntime ? [] : ['XDG_RUNTIME_DIR'])]) mustBeScratch(`env.${k}`, env[k]);
  if (spec.realRuntime && (env.ORCHESTRA_KEYRING || env.DBUS_SESSION_BUS_ADDRESS || env.XDG_RUNTIME_DIR !== HUMAN_RUNTIME)) refuse('fleet arm env must be exactly the fleet shape: real runtime dir, no opt-in, no bus address');
  if ('DISPLAY' in env || path.basename(env.WAYLAND_DISPLAY) !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse('child env would reach the human display');
  if (env.DBUS_SESSION_BUS_ADDRESS && !env.DBUS_SESSION_BUS_ADDRESS.includes(w.run)) refuse('child DBUS_SESSION_BUS_ADDRESS is not the private bus');
  if (Object.values(env).some((v) => String(v).includes(`${HUMAN_RUNTIME}/bus`) || String(v).includes(`${HUMAN_RUNTIME}/keyring`))) refuse('child env references the human\'s real bus/keyring');
  const logFile = path.join(w.armDir, `app-${Date.now()}.out`); const fd = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`  app pid ${app.pid} port ${port} stdout ${logFile}`);
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  const tTarget = Date.now() - t0;
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('!!window.orchestra && !!document.querySelector(\'[aria-label="Linear settings"]\')'), 60000, 'the sidebar footer');
  return { app, port, cdp, target, tTarget, t0, env };
}
async function stopApp(a) {
  a.cdp?.close();
  try { process.kill(-a.app.pid, 'SIGTERM'); } catch {}
  await sleep(2500);
  try { process.kill(-a.app.pid, 'SIGKILL'); } catch {}
  await sleep(300);
}
const appLog = (w) => { try { return fs.readFileSync(w.logFile, 'utf8'); } catch { return ''; } };
const decisionLine = (w) => (appLog(w).split('\n').filter((l) => l.includes('[secrets] password-store:')).pop() ?? '(no [secrets] password-store line)');
const diskEntries = (w) => { const d = JSON.parse(fs.readFileSync(w.secretsFile, 'utf8')); return { linear: d.enc === true, key: Object.values(d.accountApiKeys ?? {}).every((v) => v.enc === true), url: Object.values(d.accountBaseUrls ?? {}).every((v) => v.enc === true) }; };

// ── UI helpers ────────────────────────────────────────────────────────────────────────────────────────────────────────
const SEL = {
  linearBtn: '[aria-label="Linear settings"]', linear: '.modal.linear-settings',
  accountsBtn: '[aria-label="Claude accounts settings"]', accounts: '[aria-label="Claude accounts"]',
};
const rectOf = (cdp, sel) => cdp.eval(`(() => { const e = document.querySelector(${JSON.stringify(sel)}); if (!e) return null; const b = e.getBoundingClientRect(); return { left: b.left, top: b.top, right: b.right, bottom: b.bottom, width: b.width, height: b.height, x: b.left + b.width / 2, y: b.top + b.height / 2, vw: innerWidth, vh: innerHeight }; })()`);
async function openDialog(cdp, btnSel, dlgSel) {
  const b = await rectOf(cdp, btnSel);
  if (!b || b.top < 0 || b.bottom > b.vh) throw new Error(`button ${btnSel} not in the viewport: ${JSON.stringify(b)}`);
  await cdp.click(b.x, b.y);
  await waitFor(() => rectOf(cdp, dlgSel), 8000, `dialog ${dlgSel}`);
  await sleep(700); await cdp.eval('document.fonts.ready.then(() => true)');
  await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: 5, y: 895 });
}
async function closeDialog(cdp, dlgSel) { await cdp.click(4, 4); await waitFor(async () => !(await rectOf(cdp, dlgSel)), 5000, `dialog ${dlgSel} to close`); }
const noticeIn = (cdp, dlgSel) => cdp.eval(`(() => { const n = document.querySelector(${JSON.stringify(dlgSel + ' [data-secrets-notice]')}); if (!n) return null; const b = n.getBoundingClientRect(), d = document.querySelector(${JSON.stringify(dlgSel)}).getBoundingClientRect(); return { kind: n.getAttribute('data-secrets-notice'), text: n.textContent.trim(), inDialog: b.left >= d.left && b.right <= d.right && b.top >= d.top && b.bottom <= d.bottom, inViewport: b.left >= 0 && b.right <= innerWidth && b.top >= 0 && b.bottom <= innerHeight, h: b.height }; })()`);
const textOf = (cdp, sel) => cdp.eval(`(document.querySelector(${JSON.stringify(sel)}) || {}).textContent || null`);

/** the arm's shared opening clauses: identity, scratch env, my sway, and the private world's initial state */
async function identity(a, w, tag, spec) {
  const RUN = spec.realRuntime ? HUMAN_RUNTIME : w.run;
  clause(`${tag}/ctl/app-identity-path`, a.target.url.includes(APP_DIR) && !a.target.url.includes('app.asar'), `target url ${a.target.url} ⊇ ${APP_DIR}`);
  const srcs = await a.cdp.eval(`[...document.querySelectorAll('script[src]')].map((s) => s.src)`); const bundle = srcs.find((s) => /assets\/index-.*\.js/.test(s));
  const onDisk = bundle && path.join(APP_DIR, 'dist', bundle.split('/dist/')[1]);
  const frameId = (await a.cdp.send('Page.getResourceTree')).frameTree.frame.id; const rc = await a.cdp.send('Page.getResourceContent', { frameId, url: bundle });
  const served = Buffer.from(rc.content, rc.base64Encoded ? 'base64' : 'utf8');
  const ver = await a.cdp.eval('window.orchestra.getAppVersion()'); const built = JSON.parse(fs.readFileSync(path.join(APP_DIR, 'package.json'), 'utf8')).version;
  clause(`${tag}/ctl/app-identity-bundle-version`, !!onDisk && md5(served) === md5(fs.readFileSync(onDisk)) && served.toString('utf8').includes('data-secrets-notice') && ver === built, `renderer bundle ${path.basename(bundle || '?')} served md5 ${md5(served)} == dist file and carries the notice; version running ${ver} vs built ${built}`);
  // /proc/<pid>/environ is clobbered when Chromium rewrites its own title (it does so when DBUS_SESSION_BUS_ADDRESS is set), so the scratch
  // readback has two independent sources: the app's OWN log (home=, and its hooks socket, which lives in XDG_RUNTIME_DIR) and — when readable — environ.
  const environ = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0'); const ev = (k) => (environ.find((e) => e.startsWith(k + '=')) || '').slice(k.length + 1);
  const environReadable = environ.includes(`ORCHESTRA_HOME=${w.oh}`);
  const logTxt = appLog(w); const homeFromLog = /=== Orchestra .* home=(\S+)/.exec(logTxt)?.[1]; const hookSock = /hooks server listening on (\S+)/.exec(logTxt)?.[1];
  clause(`${tag}/ctl/scratch-env`, homeFromLog === w.oh && !!hookSock && hookSock.startsWith(RUN + path.sep) && (!environReadable || (ev('XDG_RUNTIME_DIR') === RUN && ev('HOME') === w.home && ev('CLAUDE_CONFIG_DIR') === w['claude-config'] && !environ.some((e) => e.startsWith('DISPLAY=')) && path.basename(ev('WAYLAND_DISPLAY')) === RIG_WAYLAND && !environ.some((e) => e.includes(`${HUMAN_RUNTIME}/bus`) || e.startsWith('DBUS_SESSION_BUS_ADDRESS=unix') && spec.realRuntime))),
    `app log home=${homeFromLog}, hooks socket ${hookSock}; environ ${environReadable ? `readable: DBUS_SESSION_BUS_ADDRESS=${ev('DBUS_SESSION_BUS_ADDRESS') || '<unset>'} XDG_CURRENT_DESKTOP=${ev('XDG_CURRENT_DESKTOP') || '<unset>'} DISPLAY=${ev('DISPLAY') || '<unset>'}` : 'clobbered by Chromium\'s title rewrite (expected when a bus address is set); the spawn env was asserted scratch before launch'}`);
  clause(`${tag}/ctl/app-in-my-sway`, new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${a.app.pid} in my sway's get_tree`);
}
async function grimShot(name) {
  const f = path.join(OUT, name); fs.mkdirSync(OUT, { recursive: true });
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: HUMAN_RUNTIME, WAYLAND_DISPLAY: RIG_WAYLAND } });
  shots.push({ file: f, md5: md5(fs.readFileSync(f)) }); return f;
}

// ── arms ───────────────────────────────────────────────────────────────────────────────────────────────────────────────
const SPECS = {
  unlocked: { desktop: 'sway', keyring: 'unlocked', bus: 'runtime-dir' }, // THE HOST'S SHAPE: no address variable, unrecognised desktop
  locked: { desktop: 'sway', keyring: 'locked', bus: 'runtime-dir' },
  nosvc: { desktop: 'sway', keyring: 'none', bus: 'runtime-dir' },
  recognised: { desktop: 'LXQt', keyring: 'unlocked', bus: 'env' }, // Chromium picks basic_text for LXQt on purpose: its choice must be kept
  hung: { desktop: 'sway', keyring: 'unlocked', bus: 'runtime-dir', hungGdbus: true },
  gnome: { desktop: 'GNOME', keyring: 'unlocked', bus: 'env' }, // Chromium's OWN choice (libsecret): startup must NOT touch safeStorage; Settings seals the plaintext
  relock: { desktop: 'sway', keyring: 'unlocked', bus: 'runtime-dir' },
  'isolated-gnome': { desktop: 'GNOME', keyring: 'unlocked', bus: 'env', optIn: false }, // review m1: on a RECOGNISED desktop Chromium would pick libsecret itself — the isolated instance must force `basic`
  isolated: { desktop: 'sway', keyring: 'unlocked', bus: 'runtime-dir', optIn: false }, // review F1: the same world as `unlocked` minus the opt-in → the unlocked keyring must NOT be touched
  fleet: { desktop: '', keyring: 'none', bus: 'runtime-dir', optIn: false, realRuntime: true, noBus: true }, // review F1: the real fleet-rig env — REAL XDG_RUNTIME_DIR, scratch ORCHESTRA_HOME, no opt-in
};
const STATE_BOUND_MS = 8000;       // getSecretsState must answer within this (a stall is tens of seconds)
const TARGET_BOUND_MS = 30000;     // spawn → page target
async function stateOf(a) { const t = Date.now(); const s = await a.cdp.eval('window.orchestra.getSecretsState()', 25000); return { s, ms: Date.now() - t }; }


// ── review F1: the REAL fleet-rig env (real XDG_RUNTIME_DIR, scratch ORCHESTRA_HOME, no opt-in) must never select libsecret or export the real bus ──
/** Run the SHIPPED selection source (src/main/linux-keyring.ts) in a child node under `env`, with spies instead of the real appendSwitch / export. */
function selectionUnder(w, env, { probeThrows = false, stubUnlocked = false } = {}) {
  if (stubUnlocked) { // a `gdbus` that answers "unlocked": the control must not depend on the human's keyring being unlocked right now (it is not always — and then nothing real is read at all)
    const dir = path.join(w.armDir, 'stub-gdbus'); fs.mkdirSync(dir, { recursive: true });
    fs.writeFileSync(path.join(dir, 'gdbus'), '#!/bin/sh\necho "(<false>,)"\n', { mode: 0o755 });
    env = { ...env, PATH: `${dir}:/usr/bin:/bin` };
  }
  const code = `import { pathToFileURL } from 'node:url';
const { selectLinuxPasswordStore } = await import(pathToFileURL(process.env.SEL_MODULE).href);
const env = JSON.parse(process.env.SEL_ENV); const applied = []; let probed = false;
const deps = { platform: 'linux', env, argv: [], hasSwitch: () => false, appendSwitch: (n, v) => applied.push('--' + n + '=' + v), exportBusAddress: (a) => applied.push('export DBUS_SESSION_BUS_ADDRESS=' + a) };
if (process.env.SEL_THROW === '1') deps.probe = () => { probed = true; throw new Error('PROBE RAN'); };
const d = selectLinuxPasswordStore(deps);
console.log(JSON.stringify({ store: d.store, reason: d.reason, facts: d.facts, probeMs: d.probeMs, applied, probed }));`;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', '--input-type=module', '-e', code],
    { encoding: 'utf8', timeout: 20000, env: { PATH: '/usr/bin:/bin', HOME: w.home, XDG_RUNTIME_DIR: HUMAN_RUNTIME, LANG: 'C.UTF-8', SEL_ENV: JSON.stringify(env), SEL_THROW: probeThrows ? '1' : '0', SEL_MODULE: path.join(APP_DIR, 'src/main/linux-keyring.ts') } });
  try { return JSON.parse(r.stdout.trim().split('\n').pop()); } catch { return { error: `rc ${r.status}: ${(r.stderr || r.stdout).slice(0, 300)}` }; }
}
async function fleetPreflight(w) {
  // The built bundle's behaviour is proven in the PRIVATE world first (arm `isolated`: same clause, nothing real reachable); only then may an app run against the real runtime dir.
  const need = ['isolated/decision-logged', 'isolated/keyring-untouched-by-the-app', 'isolated-gnome/decision-logged', 'isolated-gnome/keyring-untouched-by-the-app'];
  if (!need.every((c) => results.some((r) => r.clause === c && r.ok))) throw new Error(`fleet preflight: ${need.join(' + ')} must have PASSED on this build in this run — REFUSING to launch an app against the real runtime dir`);
  const mainFile = path.join(APP_DIR, 'dist-electron', fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8').match(/require\("\.\/(index-[^"]+\.js)"\)/)[1]);
  const clauseCount = fs.readFileSync(mainFile, 'utf8').split('reason:"isolated-instance"').length - 1;
  const fleetEnv = { PATH: '/usr/bin:/bin', HOME: w.home, XDG_RUNTIME_DIR: HUMAN_RUNTIME, LANG: 'C.UTF-8', ORCHESTRA_HOME: w.oh, DBUS_SESSION_BUS_ADDRESS: 'disabled:' }; // `disabled:` = what Electron puts in its own env
  const iso = selectionUnder(w, fleetEnv, { probeThrows: true });
  const ok = clauseCount === 1 && iso.store === 'basic' && iso.reason === 'isolated-instance' && JSON.stringify(iso.applied) === JSON.stringify(['--password-store=basic']) && iso.probed === false;
  clause('fleet/preflight-isolated-forces-basic-never-probes-or-exports', ok, `built main bundle carries the isolation clause ${clauseCount}×; shipped source under the fleet env (real XDG_RUNTIME_DIR=${HUMAN_RUNTIME}, scratch ORCHESTRA_HOME) → ${JSON.stringify(iso)}`);
  if (!ok) throw new Error('fleet preflight failed — REFUSING to launch an app against the real runtime dir');
  const { ORCHESTRA_HOME: _drop, ...noHome } = fleetEnv;
  const ctl = selectionUnder(w, noHome, { stubUnlocked: true }); // a STUBBED probe (answers unlocked): nothing of the human's is read and nothing is applied (spies)
  console.log(`  [host] the human's REAL default collection answers ${realLoginCollectionLocked()} right now (informational — the control above does not depend on it)`);
  clause('fleet/ctl/control-without-orchestra-home-selects-libsecret', ctl.store === 'gnome-libsecret' && ctl.reason === 'unlocked-service' && ctl.applied?.some((x) => x === `export DBUS_SESSION_BUS_ADDRESS=unix:path=${HUMAN_RUNTIME}/bus`) && ctl.applied?.includes('--password-store=gnome-libsecret'),
    `the SAME env minus ORCHESTRA_HOME, probe stubbed unlocked → ${JSON.stringify(ctl)} (spied, not applied) — what the app would have done to the human's keyring without the rule`);
}

async function runArm(name) {
  const spec = SPECS[name];
  const tag = name;
  console.log(`\n── arm ${name} (desktop=${spec.desktop || '<unset>'}, keyring=${spec.keyring}, bus=${spec.bus}${spec.hungGdbus ? ', gdbus probe HUNG' : ''}) ──`);
  const w = seedWorld(path.join(RIG_DIR, `arm-${LABEL}-${name}`), spec);
  let busProc, a;
  try {
    if (spec.realRuntime) await fleetPreflight(w);
    if (!spec.noBus) busProc = await startBus(w);
    if (!spec.noBus) clause(`${tag}/ctl/private-bus-empty`, !/org\.freedesktop\.secrets/.test(busNames(w)) && lockedOf(w) === 'no-service', `private bus names before any daemon: ${busNames(w).trim()} — no Secret Service yet (positive control for the nosvc state)`);
    if (spec.keyring !== 'none') { keyringStart(w, { unlock: true }); }
    if (spec.keyring === 'locked') { await keyringStopOnly(w); await sleep(300); keyringStart(w, { unlock: false }); }
    const want = { unlocked: 'unlocked', locked: 'locked', none: 'no-service' }[spec.keyring];
    if (!spec.noBus) clause(`${tag}/ctl/private-keyring-state`, lockedOf(w) === want, `independent oracle (gdbus Properties.Get Locked on the PRIVATE default collection) = ${lockedOf(w)}, wanted ${want}`);
    const itemsBefore = spec.noBus || spec.keyring === 'none' ? -1 : itemCount(w);
    const fileBefore = fs.readFileSync(w.secretsFile);
    const live0 = liveHash();

    a = await bootApp(w, spec);
    await identity(a, w, tag, spec);
    if (spec.realRuntime) {
      const env = fs.readFileSync(`/proc/${a.app.pid}/environ`, 'utf8').split('\0');
      clause(`${tag}/ctl/uses-the-real-runtime-dir`, env.includes(`XDG_RUNTIME_DIR=${HUMAN_RUNTIME}`) && !env.some((e) => e.startsWith('DBUS_SESSION_BUS_ADDRESS=') || e.startsWith('ORCHESTRA_KEYRING=')), `app environ XDG_RUNTIME_DIR=${HUMAN_RUNTIME}, no DBUS_SESSION_BUS_ADDRESS, no ORCHESTRA_KEYRING — the fleet-rig shape`);
    }
    clause(`${tag}/startup-bounded`, a.tTarget < TARGET_BOUND_MS, `spawn → renderer target in ${a.tTarget} ms (bound ${TARGET_BOUND_MS} ms; a locked-keyring stall is tens of seconds)`);

    const expectLine = {
      unlocked: /password-store: gnome-libsecret — unlocked-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir \(exported\)\]/,
      locked: /password-store: Chromium default — locked-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir\]/,
      nosvc: /password-store: Chromium default — no-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir\]/,
      recognised: /password-store: Chromium default — recognised-desktop \[desktop="LXQt" session="" bus=env\]/,
      isolated: /password-store: basic — isolated-instance \[desktop="sway" session="" bus=runtime-dir\]$/m,
      'isolated-gnome': /password-store: basic — isolated-instance \[desktop="GNOME" session="" bus=env\]$/m,
      fleet: /password-store: basic — isolated-instance \[desktop="" session="" bus=runtime-dir\]$/m,
      gnome: /password-store: Chromium default — recognised-desktop \[desktop="GNOME" session="" bus=env\]/,
      hung: /password-store: Chromium default — no-service \(probe (1[5-9]\d\d|2\d\d\d) ms\)/, // killed at ~1.5 s, not 30 s
      relock: /password-store: gnome-libsecret — unlocked-service/,
    }[name];
    const dl = decisionLine(w);
    clause(`${tag}/decision-logged`, expectLine.test(dl), dl);

    if (name === 'gnome') {
      await sleep(2500); // a recognised desktop's keyring is never touched at startup — nothing has asked for the state yet
      clause(`${tag}/startup-did-not-touch-secrets`, fs.readFileSync(w.secretsFile).equals(fileBefore) && !/\(startup\) re-encrypted/.test(appLog(w)), `2.5 s after boot, before any Settings access: secrets.json byte-identical (sha ${sha(fileBefore).slice(0, 12)}), no "(startup) re-encrypted" log line`);
    }
    // The state, as the renderer asks for it. Encrypted arms wait for the re-encryption (startup, or the Settings-triggered one) to finish.
    const encryptedArm = name === 'unlocked' || name === 'relock' || name === 'gnome';
    let st;
    if (encryptedArm) {
      // Poll; on timeout fall through with the LAST state so the clauses below report it (a diagnosable FAIL, not an abort).
      const t0 = Date.now();
      do { st = await stateOf(a); if (st.s.plaintextEntries === 0) break; await sleep(500); } while (Date.now() - t0 < 25000);
    } else st = await stateOf(a);
    clause(`${tag}/state-answers-fast`, st.ms < STATE_BOUND_MS, `getSecretsState answered in ${st.ms} ms (bound ${STATE_BOUND_MS} ms)`);
    if (encryptedArm) {
      clause(`${tag}/state-encrypted`, st.s.encrypted === true && st.s.backend === 'gnome_libsecret' && st.s.plaintextEntries === 0 && st.s.encryptedEntries === 3, `getSecretsState → ${JSON.stringify(st.s)}`);
      const raw = fs.readFileSync(w.secretsFile, 'utf8');
      clause(`${tag}/file-re-encrypted`, JSON.stringify(diskEntries(w)) === JSON.stringify({ linear: true, key: true, url: true }) && ![SEED.linear, SEED.key, SEED.url].some((s) => raw.includes(s)), `secrets.json enc flags ${JSON.stringify(diskEntries(w))}; plaintext values present in the file: ${[SEED.linear, SEED.key, SEED.url].filter((s) => raw.includes(s)).length}; mode ${(fs.statSync(w.secretsFile).mode & 0o777).toString(8)}`);
      clause(`${tag}/file-changed`, !fs.readFileSync(w.secretsFile).equals(fileBefore), `secrets.json before ${sha(fileBefore).slice(0, 12)} → after ${sha(fs.readFileSync(w.secretsFile)).slice(0, 12)}`);
      clause(`${tag}/readable-after-reencryption`, (await a.cdp.eval('window.orchestra.getLinearKeySource()')) === 'stored', `getLinearKeySource → ${await a.cdp.eval('window.orchestra.getLinearKeySource()')} (a stored key that decrypts; "none" would mean the ciphertext cannot be read back)`);
      clause(`${tag}/private-keyring-holds-the-key`, itemCount(w) > itemsBefore, `PRIVATE keyring items ${itemsBefore} → ${itemCount(w)} (Chromium stored its safe-storage key there — independent of the app's own claims); labels ${JSON.stringify(itemLabels(w))}`);
      const trigger = name === 'gnome' ? 'settings' : 'startup';
      clause(`${tag}/reencrypt-logged`, new RegExp(`\\[secrets\\] \\(${trigger}\\) re-encrypted 3 plaintext entr\\(ies\\), 0 left in plaintext`).test(appLog(w)), `wanted trigger "${trigger}": ` + (appLog(w).split('\n').find((l) => l.includes('re-encrypted')) ?? '(no line)'));
    } else {
      clause(`${tag}/state-not-encrypted`, st.s.encrypted === false && st.s.backend === 'basic_text' && st.s.plaintextEntries === 3 && st.s.encryptedEntries === 0, `getSecretsState → ${JSON.stringify(st.s)}`);
      clause(`${tag}/plaintext-kept`, fs.readFileSync(w.secretsFile).equals(fileBefore), `secrets.json byte-identical after boot (sha ${sha(fileBefore).slice(0, 12)})`);
      clause(`${tag}/readable-plaintext`, (await a.cdp.eval('window.orchestra.getLinearKeySource()')) === 'stored', `getLinearKeySource → ${await a.cdp.eval('window.orchestra.getLinearKeySource()')}`);
      if (spec.keyring !== 'none') clause(`${tag}/keyring-untouched-by-the-app`, itemCount(w) === itemsBefore && lockedOf(w) === want, `PRIVATE keyring items ${itemsBefore} → ${itemCount(w)}, Locked ${lockedOf(w)} (the app neither stored into it nor unlocked it)`);
    }

    // ── the Settings dialogs ──
    const pre = { linear: await rectOf(a.cdp, SEL.linear), accounts: await rectOf(a.cdp, SEL.accounts) };
    await openDialog(a.cdp, SEL.linearBtn, SEL.linear);
    // Poll for the settled dialog; on timeout fall through with what is there, so the clause below FAILS naming the missing/extra notice (not an abort).
    const lin = await waitFor(async () => { const n = await noticeIn(a.cdp, SEL.linear); const t = await textOf(a.cdp, `${SEL.linear} .sound-hint`); return encryptedArm || name === 'recognised' ? (/stored encrypted on this machine/.test(t || '') || n ? { n, t } : null) : (n ? { n, t } : null); }, 8000, 'the Linear dialog to settle')
      .catch(async () => ({ n: await noticeIn(a.cdp, SEL.linear), t: await textOf(a.cdp, `${SEL.linear} .sound-hint`) }));
    clause(`${tag}/ctl/dialog-opened`, !pre.linear && !!(await rectOf(a.cdp, SEL.linear)), `Linear dialog ${!!pre.linear} -> ${!!(await rectOf(a.cdp, SEL.linear))} after a trusted click on the footer icon`);
    const linHint = lin.t || '';
    const f1 = saveShot(`${LABEL}-${name}-linear-dialog.png`, await a.cdp.shot());
    if (st.s.encrypted) {
      clause(`${tag}/linear-no-warning`, lin.n === null && /stored encrypted on this machine/.test(linHint), `Linear dialog notice ${JSON.stringify(lin.n)}; hint "${linHint.slice(-70)}"`);
    } else {
      clause(`${tag}/linear-warning`, !!lin.n && lin.n.kind === 'unencrypted' && /stored unencrypted on this machine/.test(lin.n.text) && lin.n.inDialog && lin.n.inViewport && !/stored encrypted on this machine/.test(linHint), `notice ${JSON.stringify(lin.n)}; hint "${linHint.slice(-70)}" (must not promise encryption)`);
    }
    await closeDialog(a.cdp, SEL.linear);
    await openDialog(a.cdp, SEL.accountsBtn, SEL.accounts);
    await waitFor(() => a.cdp.eval(`!!document.querySelector('${SEL.accounts} .account-card')`), 8000, 'the Accounts dialog rows');
    await sleep(800);
    const acc = await noticeIn(a.cdp, SEL.accounts);
    const f2 = saveShot(`${LABEL}-${name}-accounts-dialog.png`, await a.cdp.shot());
    if (st.s.encrypted) clause(`${tag}/accounts-no-warning`, acc === null, `Accounts dialog notice ${JSON.stringify(acc)} (state loaded: encrypted=${st.s.encrypted})`);
    else clause(`${tag}/accounts-warning`, !!acc && acc.kind === 'unencrypted' && /stored unencrypted on this machine/.test(acc.text) && acc.inDialog && acc.inViewport, `notice ${JSON.stringify(acc)}`);
    if (name === 'nosvc') {
      const g = await grimShot(`${LABEL}-${name}-accounts-dialog-compositor.png`);
      const grim = decodePng(fs.readFileSync(g)); const rend = decodePng(fs.readFileSync(f2)); const dr = await rectOf(a.cdp, SEL.accounts);
      const c = crop(grim, Math.floor(dr.left), Math.floor(dr.top), Math.floor(dr.width), Math.floor(dr.height));
      clause(`${tag}/ctl/compositor-frame-shows-the-dialog`, grim.w === rend.w && grim.h === rend.h && inkPx(c) > 400, `grim ${grim.w}x${grim.h} vs renderer ${rend.w}x${rend.h}; dialog crop has ${inkPx(c)} ink px (>400: not a blank frame)`);
    }
    console.log(`  shots: ${f1}, ${f2}`);
    if (spec.optIn === false) { // review m2: an isolated instance skipped the keyring ON PURPOSE — the notice must say so and name the opt-in, not "no keyring is available"
      const okText = (n) => !!n && /isolated home \(ORCHESTRA_HOME\)/.test(n.text) && /ORCHESTRA_KEYRING=probe/.test(n.text) && !/no keyring is available/.test(n.text);
      clause(`${tag}/notice-says-isolated-not-no-keyring`, okText(lin.n) && okText(acc), `Linear notice "${lin.n?.text}" · Accounts notice "${acc?.text}"`);
    }
    await closeDialog(a.cdp, SEL.accounts);

    // ── a second boot: encrypted arms prove the entries survive a restart and are not re-sealed again ──
    if (name === 'unlocked') {
      await stopApp(a); a = null;
      const logLen = appLog(w).length;
      const fileMid = fs.readFileSync(w.secretsFile);
      a = await bootApp(w, spec);
      const st2 = await stateOf(a);
      clause(`${tag}/restart-still-readable`, st2.s.encrypted === true && st2.s.encryptedEntries === 3 && (await a.cdp.eval('window.orchestra.getLinearKeySource()')) === 'stored', `after restart getSecretsState → ${JSON.stringify(st2.s)}, getLinearKeySource → ${await a.cdp.eval('window.orchestra.getLinearKeySource()')}`);
      await sleep(1500);
      clause(`${tag}/restart-does-not-reseal`, !appLog(w).slice(logLen).includes('[secrets] re-encrypted') && fs.readFileSync(w.secretsFile).equals(fileMid), `no second "re-encrypted" log line; secrets.json byte-identical across the restart`);
    }
    // ── relock: the keyring is gone at the next boot — the encrypted entries become unreadable, and Settings says so ──
    if (name === 'relock') {
      await stopApp(a); a = null;
      await keyringStopOnly(w); await sleep(300); keyringStart(w, { unlock: false });
      clause(`${tag}/ctl/keyring-now-locked`, lockedOf(w) === 'locked', `private keyring Locked → ${lockedOf(w)}`);
      const fileMid = fs.readFileSync(w.secretsFile);
      a = await bootApp(w, spec);
      const st2 = await stateOf(a);
      clause(`${tag}/relocked-state`, st2.s.encrypted === false && st2.s.encryptedEntries === 3 && st2.s.plaintextEntries === 0 && st2.ms < STATE_BOUND_MS, `getSecretsState → ${JSON.stringify(st2.s)} in ${st2.ms} ms`);
      clause(`${tag}/relocked-ciphertext-kept`, fs.readFileSync(w.secretsFile).equals(fileMid), 'secrets.json byte-identical: the ciphertext waits for the keyring, nothing was rewritten or dropped');
      await openDialog(a.cdp, SEL.linearBtn, SEL.linear);
      const n2 = await waitFor(() => noticeIn(a.cdp, SEL.linear), 8000, 'the unreadable notice');
      clause(`${tag}/relocked-notice`, n2.kind === 'unreadable' && /3 stored secrets are encrypted and unreadable until a keyring is available again/.test(n2.text) && /stored unencrypted on this machine/.test(n2.text), `notice ${JSON.stringify(n2)}`);
      saveShot(`${LABEL}-${name}-relocked-linear-dialog.png`, await a.cdp.shot());
    }

    const live1 = liveHash();
    clause(`${tag}/ctl/live-files-byte-equal`, JSON.stringify(live0) === JSON.stringify(live1), `${Object.keys(live0).length} host config/secrets/keyring files hashed before/after this arm: ${JSON.stringify(live0) === JSON.stringify(live1) ? 'identical' : 'CHANGED ' + JSON.stringify(Object.keys(live0).filter((k) => live0[k] !== live1[k])) + ' — real collection items now (read-only metadata): ' + realItems()}`);
  } catch (e) {
    clause(`${tag}/completed`, false, `ABORTED: ${e.stack || e}`);
  } finally {
    if (a) await stopApp(a);
    await killWorld(w);
    if (spec.realRuntime) { // this arm's OWN hooks socket in the real runtime dir (parsed from its own log), nothing else
      const m = /hooks server listening on (\S+)/.exec(appLog(w));
      try { if (m && m[1].startsWith(`${HUMAN_RUNTIME}/orchestra-`) && fs.statSync(m[1]).isSocket()) fs.rmSync(m[1]); } catch {}
    }
    try { process.kill(-busProc?.pid, 'SIGKILL'); } catch {}
    const left = procsOfWorld(w);
    clause(`${tag}/teardown-no-survivors`, left.length === 0, `processes still carrying ${w.run}: ${left.length ? left.join(',') : 'none'}`);
  }
}

async function main() {
  const before = liveHash(); const lockedBefore = realLoginCollectionLocked();
  console.log(`[host] human's REAL default collection (read-only probe): ${lockedBefore}; ${Object.keys(before).length} live files hashed`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  const order = [...ARMS]; // `fleet` always follows the two private isolated arms (see fleetPreflight)
  if (order.includes('fleet')) for (const dep of ['isolated', 'isolated-gnome']) { const i = order.indexOf(dep); if (i < 0) order.splice(order.indexOf('fleet'), 0, dep); else if (i > order.indexOf('fleet')) { order.splice(i, 1); order.splice(order.indexOf('fleet'), 0, dep); } }
  for (const name of order) { if (!SPECS[name]) refuse(`unknown arm ${name}`); await runArm(name); }
  const after = liveHash();
  clause('ctl/host-files-byte-equal-whole-run', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} host files (keyring files, secrets.json under ~/.config/orchestra + ~/.orchestra, ~/.claude* settings; credentials.json excluded as live-session churn) before/after the whole run: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED — real collection items now (read-only metadata): ' + realItems()}`);
  clause('ctl/host-collection-unchanged', realLoginCollectionLocked() === lockedBefore, `real default collection Locked before ${lockedBefore} / after ${realLoginCollectionLocked()}`);
  // Same state → same pixels, so duplicates are only a no-op detector WITHIN an arm (linear / accounts / relock are three different frames).
  const byArm = {}; for (const sh of shots) (byArm[[...ARMS].sort((a, b) => b.length - a.length).find((x) => path.basename(sh.file).startsWith(`${LABEL}-${x}-`)) ?? '?'] ||= []).push(sh); // longest arm name wins (isolated vs isolated-gnome)
  const dups = Object.entries(byArm).map(([arm, l]) => [arm, l.length - new Set(l.map((x) => x.md5)).size]).filter(([, n]) => n > 0);
  clause('ctl/no-duplicate-captures-within-an-arm', dups.length === 0, `${shots.length} captures; byte-identical duplicates within an arm: ${dups.length ? JSON.stringify(dups) : 'none'}`);
  const m5 = (arm, what) => shots.find((x) => path.basename(x.file) === `${LABEL}-${arm}-${what}.png`)?.md5;
  if (ARMS.includes('unlocked') && ARMS.includes('nosvc')) clause('ctl/encrypted-and-warning-frames-differ', m5('unlocked', 'linear-dialog') && m5('nosvc', 'linear-dialog') && m5('unlocked', 'linear-dialog') !== m5('nosvc', 'linear-dialog'), `Linear dialog md5 encrypted ${m5('unlocked', 'linear-dialog')} vs no-keyring ${m5('nosvc', 'linear-dialog')} (the warning really paints)`);
}

await main();
console.log('\n== shots (md5) ==');
for (const s of shots) console.log(`  ${s.md5}  ${s.file}`);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, `${LABEL}-result.json`), JSON.stringify({ app: APP_DIR, label: LABEL, arms: ARMS, results, shots }, null, 2));
const red = results.filter((r) => !r.ok);
console.log(`\nVERDICT: ${red.length === 0 ? `ALL GREEN: ${results.length} clauses` : `RED: ${red.map((r) => r.clause).join(', ')}`}`);
process.exit(red.length === 0 ? 0 : 1);
