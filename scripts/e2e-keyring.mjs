// #389 — Linux keyring selection / re-encryption / Settings warning, driven in a BUILT Orchestra (argv[2] = app dir) inside the
// contained rig's own headless sway, in the rig's HIDDEN WORLD (the human's runtime dir is an empty tmpfs: the real keyring daemon and bus are
// unreachable by construction). One ARM = one private world: its own XDG_RUNTIME_DIR (<rig>/xdg/k-<arm>: the daemon's control + pkcs11 sockets
// and the bus socket live there), its own `dbus-run-session` (a bus config that lists NO host service dirs), its own gnome-keyring-daemon under
// scratch XDG_DATA_HOME, its own ORCHESTRA_HOME / HOME / claude config.
// Arms: forged · unlocked · locked · nosvc · recognised · hung · gnome · relock · isolated · isolated-gnome. `forged` is the must-FAIL preflight arm
// (a forced real XDG_RUNTIME_DIR / DBUS address / env value must be REFUSED before anything starts); every other arm but isolated* opts in with
// ORCHESTRA_KEYRING=probe (an ORCHESTRA_HOME instance never touches a keyring otherwise — review F1). Every clause is cross-read from independent
// surfaces: the app's log line, the renderer's IPC answer (`getSecretsState`), the secrets file bytes, the PRIVATE keyring itself over its own bus
// (Locked / item count), the DOM and a screenshot. World clauses (`<arm>/world/*`, src/shared/keyring-rig-world.ts): the secrets owner on the
// private bus is OUR daemon, no env/fd of any rig process names the human's runtime dir, the rig runtime root holds nothing but wayland + arm dirs.
// This rig NEVER reads the human's bus, keyring daemon or keyring files, and never scans /proc/*/environ: processes are tracked by identity
// (pid + start time, from the private bus's peer list and the app's own process tree).
//
// Usage (via scripts/e2e-keyring.sh): <app-dir> --live-home <real $HOME> [--arms a,b] [--out dir] [--label name] | --preflight-only
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';
import { descendantsOf, isAlive, procStat, signalIfSame } from './lib/rig-procs.mjs';
import { absolutePieces, physicalForms, physicalPath } from './lib/rig-paths.mjs';
import {
  armWorldChecks, busConfigChecks, driverWorldChecks, envHumanRuntimeRefs, failed, humanRuntimeDir, buildSocketScan, parseUnixSockets, physicalWorldChecks, referencesHumanRuntime,
  rootCensusChecks, secretsOwnerChecks, socketInode, socketPaths, treeChecks, unparsedAbout,
} from '../src/shared/keyring-rig-world.ts';

const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };
const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };

// ── the driver's OWN world, proved before anything is created or started ───────────────────────────────────────────────────
// (scripts/e2e-contained-rig.sh already refuses a bad env; this re-proves it from the driver's side, and adds the keyring clauses. The forged
// arm re-runs exactly this path with a hostile env via --preflight-only and requires REFUSED.)
const PREFLIGHT_ONLY = argv.includes('--preflight-only');
const RIG_DIR = process.env.RIG_DIR;
// `env -i` strips RIG_HIDDEN_WORLD from this process, so the proof is ALSO asked of my parent: the contained rig's bash, which re-exec'd itself
// under bwrap with it set and aborted unless the human's runtime dir was an empty tmpfs. Only MY OWN parent's environ is read (never a /proc scan).
const readNul = (f) => { try { return fs.readFileSync(f, 'utf8').split('\0').filter(Boolean); } catch { return []; } };
const hiddenWorldProof = () => process.env.RIG_HIDDEN_WORLD === '1' || readNul(`/proc/${process.ppid}/environ`).includes('RIG_HIDDEN_WORLD=1');
let RIG_XDG;
try { RIG_XDG = privateRuntimeDir(); } catch (e) { refuse(e.message); }
{
  let noBusExists = true;
  try { fs.lstatSync(path.join(RIG_DIR, 'no-session-bus')); } catch { noBusExists = false; }
  // The hidden-world PROOF is the mount namespace itself (pure read of /proc/self/mountinfo); the env var above is only the cheap precondition.
  // `--mountinfo-file` (a synthetic mountinfo, for the unit tests and the forged arm) is honoured ONLY with `--preflight-only`, which exits right
  // after these checks — it can never steer a real run, which refuses the flag outright.
  const miFlag = flag('--mountinfo-file', null);
  if (miFlag && !PREFLIGHT_ONLY) refuse('--mountinfo-file is a --preflight-only test flag: a real run reads its own /proc/self/mountinfo');
  let mountinfo = null;
  try { mountinfo = fs.readFileSync(miFlag ?? '/proc/self/mountinfo', 'utf8'); } catch {}
  const cs = driverWorldChecks({ rigDir: RIG_DIR, env: process.env, noBusExists, hiddenWorld: hiddenWorldProof(), mountinfo, uid: process.getuid() });
  const bad = failed(cs);
  if (bad.length) refuse(`keyring rig world preflight failed — ${bad.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  console.log(`[preflight] keyring rig world: ${cs.length}/${cs.length} clauses ok (${cs.map((c) => c.id).join(', ')})`);
  // The same facts, PHYSICALLY (symlinks resolved): a link `<rig>/xdg -> <human runtime dir>`, a symlinked RIG_DIR or a link-valued env entry passes every lexical
  // clause above. Gathered only now — after the lexical clauses passed — so a hostile string is refused before anything is resolved.
  const rigReal = physicalPath(RIG_DIR);
  const envPhysical = {};
  for (const [k, v] of Object.entries(process.env)) {
    const forms = absolutePieces(v ?? '').flatMap(physicalForms);
    if (forms.length) envPhysical[k] = forms;
  }
  const pcs = physicalWorldChecks({ rigDir: RIG_DIR, rigReal, xdgReal: physicalPath(RIG_XDG), envPhysical });
  const pbad = failed(pcs);
  if (pbad.length) refuse(`keyring rig physical preflight failed — ${pbad.map((c) => `${c.id} (${c.detail})`).join('; ')}`);
  console.log(`[preflight] physical: ${pcs.length}/${pcs.length} clauses ok (${pcs.map((c) => c.id).join(', ')})`);
  if (PREFLIGHT_ONLY) { console.log('PREFLIGHT-OK'); process.exit(0); }
}

const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const LABEL = flag('--label', APP_DIR ? path.basename(APP_DIR) : 'app');
const ARMS = (flag('--arms', 'forged,unlocked,locked,nosvc,recognised,hung,gnome,relock,isolated,isolated-gnome')).split(',').filter(Boolean);
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing');
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_WAYLAND) refuse('RIG_WAYLAND unset — run via scripts/e2e-keyring.sh (the contained rig)');
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != the rig's marker-verified alias ${RIG_WAYLAND}`);
try { if (!fs.statSync(path.join(RIG_XDG, RIG_WAYLAND)).isSocket()) throw new Error('not a socket'); } catch (e) { refuse(`the display alias ${path.join(RIG_XDG, RIG_WAYLAND)} does not lead to a socket: ${e.message}`); }
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');
const UID = process.getuid();

// ── scratch-containment guard (same shape as e2e-memory-guard-ui.mjs) ───────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = physicalPath; // realpath of the deepest EXISTING ancestor + the remainder: a path about to be created under a symlinked parent resolves to where it would land
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)), path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
function checkScratch(p) {
  if (referencesHumanRuntime(p)) return { ok: false, clause: 'human-runtime' }; // string test FIRST: nothing under the human's runtime dir is ever stat'ed
  const r = liveReal(p);
  if (referencesHumanRuntime(r)) return { ok: false, clause: 'human-runtime' }; // …and the PHYSICAL landing place of a path that goes through a link
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.config/orchestra')), b = checkScratch(path.join(humanRuntimeDir(UID), 'bus')), c = checkScratch(path.join(path.dirname(RIG_BASE), 'not-in-the-rig')), d = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'human-runtime' || c.clause !== 'outside-rig-base' || !d.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c, d })}`);
  console.log(`[guard] self-test: human app config -> ${a.clause} · human runtime bus -> ${b.clause} · outside path -> ${c.clause} · rig path -> ${d.clause}`);
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
// Config / secrets files of the human's Orchestra and Claude — never a keyring file, never the bus, never the runtime dir.
function liveFiles() {
  const out = [];
  const add = (p) => { try { if (fs.statSync(p).isFile()) out.push(p); } catch {} };
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) for (const f of ['settings.json', 'settings.local.json']) add(path.join(d, f)); // NOT .credentials.json: the live sessions refresh their own OAuth token there (normal churn; the rig's app never has these dirs)
  for (const base of [path.join(LIVE_HOME, '.config/orchestra'), path.join(LIVE_HOME, '.orchestra')]) {
    try { for (const f of sh('find', [base, '-maxdepth', '4', '-name', 'secrets.json', '-type', 'f'], { stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean)) add(f); } catch {}
  }
  return out.sort();
}
const liveHash = () => Object.fromEntries(liveFiles().map((f) => [f, sha(fs.readFileSync(f))]));

// ── the private world of one arm ─────────────────────────────────────────────────────────────────────────────────────
const SEED = {
  linear: 'lin_api_RIG389_PLAINTEXT_LINEAR',
  key: 'sk-ant-RIG389-PLAINTEXT-ACCOUNT',
  url: 'https://gateway-rig389.internal.example',
};
function seedWorld(name, spec) {
  const armDir = path.join(RIG_DIR, `arm-${name}`);
  const w = { name, armDir, tracked: new Map() };
  for (const k of ['home', 'oh', 'claude-config', 'data', 'config', 'cache', 'stub-bin', 'svc']) w[k] = path.join(armDir, k);
  // The arm's PRIVATE XDG_RUNTIME_DIR, inside the rig's own private runtime dir (0700): the bus socket and the keyring daemon's control/pkcs11 sockets live here.
  w.run = path.join(RIG_XDG, `k-${name}`);
  w.bus = path.join(w.run, 'bus');
  w.address = `unix:path=${w.bus}`;
  w.dirs = { arm: armDir, home: w.home, oh: w.oh, claude: w['claude-config'], data: w.data, config: w.config, cache: w.cache };
  // EVERY guard runs BEFORE the first mkdir / symlink: with a symlinked parent the creation itself would write THROUGH the link before the refusal.
  for (const [k, v] of Object.entries({ ...w.dirs, run: w.run })) mustBeScratch(`world.${k}`, v);
  for (const k of ['home', 'oh', 'claude-config', 'data', 'config', 'cache', 'stub-bin', 'svc']) fs.mkdirSync(w[k], { recursive: true });
  fs.mkdirSync(w.run, { mode: 0o700 }); fs.chmodSync(w.run, 0o700);
  // The app's display NAME is bare (the rig refuses a path); inside its own runtime dir that name leads to the rig's marker-verified socket.
  fs.symlinkSync(path.join(RIG_XDG, RIG_WAYLAND), path.join(w.run, RIG_WAYLAND));
  const account = { id: 'rig-kr389', label: 'rig (scratch config dir)', configDir: w['claude-config'] };
  const dir = path.join(w.oh, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [], workspaces: [], accounts: [account], selfTuneRuns: [] }, null, 2));
  w.secretsFile = path.join(dir, 'secrets.json');
  // The state of "the human used Orchestra on a box with no keyring": every kind of entry stored in plaintext.
  fs.writeFileSync(w.secretsFile, JSON.stringify({ linearApiKey: SEED.linear, enc: false, accountApiKeys: { [account.id]: { value: SEED.key, enc: false } }, accountBaseUrls: { [account.id]: { value: SEED.url, enc: false } } }), { mode: 0o600 });
  w.logFile = path.join(w.oh, 'logs', 'orchestra.log');
  fs.writeFileSync(path.join(w['stub-bin'], 'claude'), '#!/bin/sh\nsleep 3600\n', { mode: 0o755 });
  w.hungPidFile = path.join(armDir, 'hung-gdbus.pid');
  if (spec.hungGdbus) fs.writeFileSync(path.join(w['stub-bin'], 'gdbus'), `#!/bin/sh\necho $$ > '${w.hungPidFile}'\nexec sleep 30\n`, { mode: 0o755 }); // a Secret Service probe that never answers (its pid is recorded so teardown can reap it by identity)
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
/** The env of each process class an arm starts — pure functions of the world, so the SAME objects are checked (armWorldChecks) and spawned. */
const busEnv = (w) => ({ PATH: '/usr/bin:/bin', HOME: w.home, XDG_RUNTIME_DIR: w.run, XDG_DATA_HOME: w.data, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, LANG: 'C.UTF-8' });
/** helper tools (keyring daemon, gdbus oracle) — an allowlist, scratch XDG dirs, the PRIVATE bus */
const toolEnv = (w) => ({ ...busEnv(w), DBUS_SESSION_BUS_ADDRESS: w.address });
function appEnv(w, spec, port) {
  const env = { PATH: `${w['stub-bin']}:/usr/local/bin:/usr/bin:/bin`, HOME: w.home, XDG_RUNTIME_DIR: w.run, XDG_CONFIG_HOME: w.config, XDG_CACHE_HOME: w.cache, XDG_DATA_HOME: w.data,
    XDG_SESSION_TYPE: 'wayland', WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: w.oh, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: w['claude-config'], LANG: 'C.UTF-8' };
  if (spec.desktop) env.XDG_CURRENT_DESKTOP = spec.desktop;
  if (spec.optIn !== false) env.ORCHESTRA_KEYRING = 'probe'; // the rig's private bus is the point; isolated arms leave it unset
  if (spec.bus === 'env') env.DBUS_SESSION_BUS_ADDRESS = w.address; // else: the host's shape — no address variable, the bus only at $XDG_RUNTIME_DIR/bus
  return env;
}
// The oracle talks to the arm's bus by EXPLICIT address (`--address`), never the session-bus lookup: it cannot fall back to any other bus.
// A LONG per-call timeout (30 s, like the shipped probe): a client that vanishes mid-call aborts a gnome-keyring-daemon, and under rig load a 2 s timeout would do exactly that to the arm's own
// daemon. The spawnSync deadline sits above it as a wedged-process backstop only.
const gdbus = (w, args, ms = 45000) => spawnSync('gdbus', ['call', '--address', w.address, '--timeout', '30', ...args], { encoding: 'utf8', env: toolEnv(w), timeout: ms, killSignal: 'SIGKILL' });
const secretsGet = (w, prop) => gdbus(w, ['--dest', 'org.freedesktop.secrets', '--object-path', '/org/freedesktop/secrets/aliases/default', '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Collection', prop]);
const busCall = (w, method, ...a) => gdbus(w, ['--dest', 'org.freedesktop.DBus', '--object-path', '/org/freedesktop/DBus', '--method', `org.freedesktop.DBus.${method}`, ...a]);
const busNames = (w) => busCall(w, 'ListNames').stdout;
const lockedOf = (w) => { const r = secretsGet(w, 'Locked'); return r.status === 0 ? (/<true>/.test(r.stdout) ? 'locked' : /<false>/.test(r.stdout) ? 'unlocked' : `odd:${r.stdout.trim()}`) : 'no-service'; };
const itemLabels = (w) => { // labels of the PRIVATE collection's items (metadata only) — attribution evidence: whose "<app> Safe Storage" is it
  const r = secretsGet(w, 'Items'); if (r.status !== 0) return [];
  return (r.stdout.replace(/\n/g, '').match(/\/org\/freedesktop\/secrets\/collection\/[^'\]]*/g) || []).map((it) => { const l = gdbus(w, ['--dest', 'org.freedesktop.secrets', '--object-path', it, '--method', 'org.freedesktop.DBus.Properties.Get', 'org.freedesktop.Secret.Item', 'Label']); return /<'(.*)'>/.exec(l.stdout || '')?.[1] ?? '?'; });
};
const itemCount = (w) => { const r = secretsGet(w, 'Items'); return r.status === 0 ? (r.stdout.match(/\/org\/freedesktop\/secrets\/collection\//g) || []).length : -1; };

// ── process identity: (pid, start time) via scripts/lib/rig-procs.mjs — never a host-wide /proc/*/environ scan ───────────────────
function track(w, pid) { if (!pid || pid <= 1 || pid === process.pid || pid === process.ppid) return; const s = procStat(pid); if (s && s.state !== 'Z' && !w.tracked.has(pid)) w.tracked.set(pid, s.start); }
const exeBaseOf = (pid) => { try { return path.basename(fs.readlinkSync(`/proc/${pid}/exe`).replace(/ \(deleted\)$/, '')); } catch { return ''; } };
const readList = readNul;
const fdTargetsOf = (pid) => { try { return fs.readdirSync(`/proc/${pid}/fd`).map((f) => { try { return fs.readlinkSync(`/proc/${pid}/fd/${f}`); } catch { return null; } }).filter(Boolean); } catch { return []; } };

/** pids of the connections on THIS arm's private bus (the bus daemon reports each peer's SO_PEERCRED pid) */
function busPeerPids(w) {
  const names = (busNames(w).match(/'([^']+)'/g) || []).map((s) => s.slice(1, -1)).filter((n) => n !== 'org.freedesktop.DBus');
  const pids = new Set();
  for (const n of names) { const m = /uint32 (\d+)/.exec(busCall(w, 'GetConnectionUnixProcessID', n).stdout || ''); if (m) pids.add(+m[1]); }
  return [...pids];
}
function secretsOwnerPid(w) {
  const name = /'(:[^']+)'/.exec(busCall(w, 'GetNameOwner', 'org.freedesktop.secrets').stdout || '')?.[1];
  if (!name) return null;
  const m = /uint32 (\d+)/.exec(busCall(w, 'GetConnectionUnixProcessID', name).stdout || '');
  return m ? +m[1] : null;
}
/** `ss -xnaeH`: every unix socket on the host as NAMES only (a netlink dump — nothing is connected to) — the only way to turn a `socket:[N]` fd into the path it is bound / connected to. */
function ssRows(interest) {
  // Two snapshots (ss, then /proc/net/unix) of a host where sockets come and go: a row can name an inode that closed in between. A row that is STILL
  // unplaceable on the 3rd try AND mentions one of OUR socket inodes (`interest`) is a real ambiguity — abort (a row that vanishes is a connection the scan
  // cannot see). An unplaceable row that mentions none of them cannot hide a connection of ours (another agent's odd socket): tolerated, not silent — counted.
  let mine = [];
  for (let attempt = 1; attempt <= 3; attempt++) {
    const r = spawnSync('ss', ['-xnaeH'], { encoding: 'utf8', maxBuffer: 64 * 1024 * 1024, timeout: 15000 });
    if (r.status !== 0 || !r.stdout) throw new Error(`ss -xnaeH failed (rc ${r.status}) — the socket scan cannot run, so no clause may rely on it`);
    const built = buildSocketScan(fs.readFileSync('/proc/net/unix', 'utf8'), r.stdout);
    mine = unparsedAbout(built.unparsed, interest);
    if (!mine.length) {
      if (built.scan.peerOf.size === 0) throw new Error('ss -xnaeH produced no (inode, peer) pairs — the socket scan saw nothing');
      if (built.unparsed.length) console.log(`  [scan] ${built.unparsed.length} unplaceable ss row(s) mention none of this arm's socket inodes — tolerated (first: ${JSON.stringify(built.unparsed[0].slice(0, 120))})`);
      return built.scan;
    }
    spawnSync('sleep', ['0.05']);
  }
  throw new Error(`ss -xnaeH: ${mine.length} row(s) mentioning this arm's sockets could not be placed after 3 snapshots (first: ${JSON.stringify(mine[0].slice(0, 160))}) — a row that vanishes is a connection the scan cannot see`);
}
const inodesOf = (fds) => fds.map(socketInode).filter((i) => i !== null);
function ownerEvidence(w) {
  const pid = secretsOwnerPid(w);
  const ev = { ownerPid: pid, driverPid: process.pid, exeBase: '', cmdline: [], fdTargets: [], socketPaths: [], envEntries: [], sockets: parseUnixSockets(fs.readFileSync('/proc/net/unix', 'utf8')), run: w.run };
  if (pid) { track(w, pid); ev.exeBase = exeBaseOf(pid); ev.cmdline = readList(`/proc/${pid}/cmdline`); ev.fdTargets = fdTargetsOf(pid); ev.socketPaths = socketPaths(inodesOf(ev.fdTargets), ssRows(new Set(inodesOf(ev.fdTargets)))); ev.envEntries = readList(`/proc/${pid}/environ`); }
  return ev;
}
/** the app's process tree: fds + env of every descendant (tracked for teardown as a side effect — keepers detach and outlive the app) */
function treeEvidence(w, a) {
  const pids = descendantsOf(a.app.pid);
  const t = { pids: pids.length, fdTargets: [], socketPaths: [], envEntries: [], run: w.run };
  for (const p of pids) { track(w, p); t.fdTargets.push(...fdTargetsOf(p)); t.envEntries.push(...readList(`/proc/${p}/environ`)); }
  t.socketPaths = socketPaths(inodesOf(t.fdTargets), ssRows(new Set(inodesOf(t.fdTargets))));
  return t;
}
/** a bus peer is ours only if it holds a socket bound / connected under THIS arm's runtime dir (a pid reported by the bus could have been reused since) */
const holdsArmSocket = (w, pid, rows) => socketPaths(inodesOf(fdTargetsOf(pid)), rows).some((x) => x === w.run || x.startsWith(w.run + path.sep));
const unixListenersUnder = (dirs) => parseUnixSockets(fs.readFileSync('/proc/net/unix', 'utf8')).filter((s) => dirs.some((d) => s.path === d || s.path.startsWith(d + path.sep)));
function signalTracked(w, pid, sig) { const st = w.tracked.get(pid); if (st) signalIfSame(pid, st, sig); } // identity re-read at signal time
const groupAlive = (pid) => { try { process.kill(-pid, 0); return true; } catch { return false; } };
/** kill a detached process GROUP only while its recorded leader is still the same process (a pgid is the leader's pid) */
function killGroup(g, sig) { if (g && isAlive(g.pid, g.start)) { try { process.kill(-g.pid, sig); } catch {} } }
async function reapWorld(w) {
  try { const peers = busPeerPids(w); const rows = ssRows(new Set(peers.flatMap((p) => inodesOf(fdTargetsOf(p))))); for (const p of peers) if (holdsArmSocket(w, p, rows)) track(w, p); } catch {}
  if (w.busProc) for (const p of descendantsOf(w.busProc.pid)) track(w, p);
  if (w.appProc) for (const p of descendantsOf(w.appProc.pid)) track(w, p); // keepers detach and outlive the app
  try { const hp = +fs.readFileSync(w.hungPidFile, 'utf8'); if (hp > 1 && readList(`/proc/${hp}/cmdline`).join(' ') === 'sleep 30' && readList(`/proc/${hp}/environ`).includes(`XDG_RUNTIME_DIR=${w.run}`)) track(w, hp); } catch {}
  for (const sig of ['SIGTERM', 'SIGKILL']) { killGroup(w.appProc, sig); killGroup(w.busProc, sig); for (const pid of w.tracked.keys()) signalTracked(w, pid, sig); await sleep(sig === 'SIGTERM' ? 1500 : 300); }
}
// A killed / interrupted driver must not strand an arm's bus, daemon or Electron: SIGKILL what the current arm tracked, by identity, then leave.
let activeWorld = null;
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => {
  const w = activeWorld;
  if (w) { killGroup(w.appProc, 'SIGKILL'); killGroup(w.busProc, 'SIGKILL'); for (const [pid, st] of w.tracked) signalIfSame(pid, st, 'SIGKILL'); }
  process.exit(130);
});

async function startBus(w) {
  const child = spawn('dbus-run-session', [`--config-file=${path.join(w.armDir, 'session.conf')}`, '--', 'sleep', '7200'], { env: busEnv(w), stdio: 'ignore', detached: true });
  child.unref();
  w.busProc = { pid: child.pid, start: procStat(child.pid)?.start }; // recorded BEFORE the wait: a bus that never comes up is still reaped
  track(w, child.pid);
  await waitFor(() => { try { return fs.statSync(w.bus).isSocket(); } catch { return false; } }, 10000, 'the private session bus socket');
  for (const p of descendantsOf(child.pid)) track(w, p);
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
async function keyringStopOnly(w) { // stop JUST the keyring daemon of THIS arm (found as a peer of the private bus), keep the bus up
  const pids = busPeerPids(w).filter((p) => exeBaseOf(p) === 'gnome-keyring-daemon');
  if (!pids.length) throw new Error('no gnome-keyring-daemon among the private bus peers');
  for (const p of pids) { track(w, p); signalTracked(w, p, 'SIGTERM'); }
  await waitFor(() => pids.every((p) => !isAlive(p, w.tracked.get(p))), 8000, 'the keyring daemon to exit');
}

// ── the app ────────────────────────────────────────────────────────────────────────────────────────────────────────
async function bootApp(w, spec) {
  const port = await freePort();
  const env = appEnv(w, spec, port);
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'XDG_DATA_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR', 'XDG_RUNTIME_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND || env.WAYLAND_DISPLAY.includes('/')) throw new Error('child env would not use the rig\'s bare display alias');
  if (env.DBUS_SESSION_BUS_ADDRESS && env.DBUS_SESSION_BUS_ADDRESS !== w.address) throw new Error('child DBUS_SESSION_BUS_ADDRESS is not the private bus');
  if (envHumanRuntimeRefs(env).length) throw new Error(`child env names the human's runtime dir: ${envHumanRuntimeRefs(env).join(', ')}`);
  const logFile = path.join(w.armDir, `app-${Date.now()}.out`); const fd = fs.openSync(logFile, 'w');
  const t0 = Date.now();
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  w.appProc = { pid: app.pid, start: procStat(app.pid)?.start }; // recorded BEFORE any wait: a boot that throws still gets its group reaped
  track(w, app.pid);
  console.log(`  app pid ${app.pid} port ${port} stdout ${logFile}`);
  const target = await waitFor(async () => { const r = await fetch(`http://127.0.0.1:${port}/json`); return (await r.json()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null; }, 60000, 'the app page target');
  const tTarget = Date.now() - t0;
  const cdp = await Cdp.connect(target.webSocketDebuggerUrl); await cdp.send('Page.enable');
  await waitFor(() => cdp.eval('!!window.orchestra && !!document.querySelector(\'[aria-label="Linear settings"]\')'), 60000, 'the sidebar footer');
  return { app, port, cdp, target, tTarget, t0, env };
}
async function stopApp(a, w) {
  a?.cdp?.close();
  if (w?.appProc) for (const p of descendantsOf(w.appProc.pid)) track(w, p); // keepers detach: record the whole tree BEFORE the main process dies
  killGroup(w?.appProc, 'SIGTERM');
  await sleep(2500);
  killGroup(w?.appProc, 'SIGKILL');
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
async function identity(a, w, tag) {
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
  clause(`${tag}/ctl/scratch-env`, homeFromLog === w.oh && !!hookSock && hookSock.startsWith(w.run + path.sep) && (!environReadable || (ev('XDG_RUNTIME_DIR') === w.run && ev('HOME') === w.home && ev('CLAUDE_CONFIG_DIR') === w['claude-config'] && !environ.some((e) => e.startsWith('DISPLAY=')) && ev('WAYLAND_DISPLAY') === RIG_WAYLAND && !environ.some(referencesHumanRuntime))),
    `app log home=${homeFromLog}, hooks socket ${hookSock}; environ ${environReadable ? `readable: DBUS_SESSION_BUS_ADDRESS=${ev('DBUS_SESSION_BUS_ADDRESS') || '<unset>'} XDG_CURRENT_DESKTOP=${ev('XDG_CURRENT_DESKTOP') || '<unset>'} DISPLAY=${ev('DISPLAY') || '<unset>'}` : 'clobbered by Chromium\'s title rewrite (expected when a bus address is set); the spawn env was asserted scratch before launch'}`);
  clause(`${tag}/ctl/app-in-my-sway`, new RegExp(`"pid":\\s*${a.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${a.app.pid} in my sway's get_tree`);
  const te = treeEvidence(w, a);
  for (const c of treeChecks(te)) clause(`${tag}/world/${c.id}`, c.ok, c.detail);
}
async function grimShot(name) {
  const f = path.join(OUT, name); fs.mkdirSync(OUT, { recursive: true });
  sh('grim', ['-o', 'HEADLESS-1', f], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: RIG_XDG, WAYLAND_DISPLAY: RIG_WAYLAND } });
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
};
const ARM_DIR_NAMES = () => ARMS.filter((n) => n in SPECS).map((n) => `k-${n}`);
const STATE_BOUND_MS = 8000;       // getSecretsState must answer within this (a stall is tens of seconds)
const TARGET_BOUND_MS = 30000;     // spawn → page target
async function stateOf(a) { const t = Date.now(); const s = await a.cdp.eval('window.orchestra.getSecretsState()', 25000); return { s, ms: Date.now() - t }; }

// ── the must-FAIL preflight arm: the driver's own entry, run with a HOSTILE env, must be REFUSED before anything starts ──────────────────────
// `--preflight-only` is the whole preflight and nothing else (no arm dir, no bus, no daemon, no app), so this arm cannot start a keyring daemon even
// if the preflight under test were broken; it only runs in the hidden world (a stray string cannot name anything real there).
function runForged() {
  console.log('\n── arm forged (must-FAIL preflight: forced real XDG_RUNTIME_DIR / DBUS address / env value) ──');
  const human = humanRuntimeDir(UID);
  const rootBefore = fs.readdirSync(RIG_XDG).sort().join(',');
  const listenersBefore = unixListenersUnder([RIG_XDG]).length;
  const hidden = hiddenWorldProof(); // proved by THIS driver's own preflight already; the children inherit it explicitly (a child's parent is this driver, not the rig)
  const child = (mut, extra = []) => {
    const env = { ...process.env, ...(hidden ? { RIG_HIDDEN_WORLD: '1' } : {}) }; mut(env);
    const r = spawnSync(process.execPath, ['--no-warnings', '--experimental-strip-types', fs.realpathSync(process.argv[1]), '--preflight-only', ...extra], { env, encoding: 'utf8', timeout: 20000 });
    return { rc: r.status, out: `${r.stdout}${r.stderr}` };
  };
  const ctl = child(() => {});
  clause('forged/ctl/the-true-rig-env-passes-the-same-entry', ctl.rc === 0 && /PREFLIGHT-OK/.test(ctl.out), `--preflight-only under THIS driver's own env → rc ${ctl.rc}: ${ctl.out.trim().split('\n').pop()}`);
  // [mutation of the env, the refusal that MUST name it] — any other refusal (a plumbing slip) does not count as the forged case being caught
  const forged = {
    'real-xdg': [(e) => { e.XDG_RUNTIME_DIR = human; }, /human's runtime dir/],
    'real-xdg-subdir': [(e) => { e.XDG_RUNTIME_DIR = `${human}/x`; }, /human's runtime dir/],
    'unset-xdg': [(e) => { delete e.XDG_RUNTIME_DIR; }, /XDG_RUNTIME_DIR unset/],
    'real-dbus': [(e) => { e.DBUS_SESSION_BUS_ADDRESS = `unix:path=${human}/bus`; }, /dbus-is-the-rigs-nonexistent-address/],
    'unset-dbus': [(e) => { delete e.DBUS_SESSION_BUS_ADDRESS; }, /dbus-is-the-rigs-nonexistent-address/],
    'stray-value': [(e) => { e.GNOME_KEYRING_CONTROL = `${human}/keyring`; }, /no-env-value-reaches-the-human-runtime \(env keys naming it: GNOME_KEYRING_CONTROL\)/],
    'path-list-value': [(e) => { e.PATH = `${e.PATH}:${human}/bin`; }, /no-env-value-reaches-the-human-runtime/],
    'absolute-display': [(e) => { e.WAYLAND_DISPLAY = `${human}/wayland-1`; }, /display-is-a-bare-private-name/],
    'x11': [(e) => { e.DISPLAY = ':0'; }, /display-is-a-bare-private-name/],
    'not-hidden': [(e) => { delete e.RIG_HIDDEN_WORLD; }, /hidden-world/],
  };
  for (const [name, [mut, why]] of Object.entries(forged)) {
    const r = child(mut);
    clause(`forged/${name}-is-refused`, r.rc === 3 && /^REFUSED: /m.test(r.out) && why.test(r.out) && !/PREFLIGHT-OK/.test(r.out), `rc ${r.rc} (3 = REFUSED), wanted ${why}: ${r.out.trim().split('\n').pop().slice(0, 220)}`);
  }
  // the mount proof, forged: the env var says hidden, the namespace says otherwise (a host-shaped mountinfo with ONE mount at the runtime dir)
  const forgedMi = path.join(RIG_DIR, 'forged-mountinfo');
  fs.writeFileSync(forgedMi, `472 50 0:64 / ${human} rw,nosuid,nodev,relatime shared:223 - tmpfs tmpfs rw,size=3241904k,mode=700,uid=${UID},gid=${UID}\n`);
  const fm = child(() => {}, ['--mountinfo-file', forgedMi]);
  clause('forged/host-mountinfo-is-refused', fm.rc === 3 && /^REFUSED: /m.test(fm.out) && /hidden-world-mount-proof/.test(fm.out) && !/PREFLIGHT-OK/.test(fm.out), `env says hidden, a host-shaped mountinfo (one mount at the runtime dir) says not → rc ${fm.rc}: ${fm.out.trim().split('\n').pop().slice(0, 220)}`);
  const rootAfter = fs.readdirSync(RIG_XDG).sort().join(',');
  clause('forged/nothing-was-started', rootAfter === rootBefore && unixListenersUnder([RIG_XDG]).length === listenersBefore && !fs.existsSync(path.join(RIG_DIR, 'arm-forged')), `rig runtime root before [${rootBefore}] / after [${rootAfter}]; unix listeners under it ${listenersBefore} → ${unixListenersUnder([RIG_XDG]).length}; no arm dir created`);
}


async function runArm(name) {
  const spec = SPECS[name];
  const tag = name;
  console.log(`\n── arm ${name} (desktop=${spec.desktop || '<unset>'}, keyring=${spec.keyring}, bus=${spec.bus}${spec.hungGdbus ? ', gdbus probe HUNG' : ''}) ──`);
  const w = seedWorld(name, spec);
  let a;
  activeWorld = w;
  try {
    // The arm's world is proved private BEFORE a single process of it exists.
    const worldCs = [
      ...armWorldChecks({ rigDir: RIG_DIR, run: w.run, dirs: w.dirs, address: w.address, envs: { bus: busEnv(w), tool: toolEnv(w), app: appEnv(w, spec, 0) } }),
      ...busConfigChecks(fs.readFileSync(path.join(w.armDir, 'session.conf'), 'utf8'), { svc: w.svc, address: w.address }),
      { id: 'bus-service-dir-is-empty', ok: fs.readdirSync(w.svc).length === 0, detail: `${w.svc} holds ${fs.readdirSync(w.svc).length} entries (no service can be activated into this arm)` },
    ];
    for (const c of worldCs) clause(`${tag}/world/${c.id}`, c.ok, c.detail);
    if (failed(worldCs).length) throw new Error('the arm world is not private — nothing was started');
    await startBus(w);
    clause(`${tag}/ctl/private-bus-empty`, !/org\.freedesktop\.secrets/.test(busNames(w)) && lockedOf(w) === 'no-service', `private bus names before any daemon: ${busNames(w).trim()} — no Secret Service yet (positive control for the nosvc state)`);
    if (spec.keyring !== 'none') { keyringStart(w, { unlock: true }); }
    if (spec.keyring === 'locked') { await keyringStopOnly(w); await sleep(300); keyringStart(w, { unlock: false }); }
    const want = { unlocked: 'unlocked', locked: 'locked', none: 'no-service' }[spec.keyring];
    clause(`${tag}/ctl/private-keyring-state`, lockedOf(w) === want, `independent oracle (gdbus Properties.Get Locked on the PRIVATE default collection, explicit --address) = ${lockedOf(w)}, wanted ${want}`);
    const ownerCs = (when) => {
      if (spec.keyring === 'none') { const p = secretsOwnerPid(w); clause(`${tag}/world/no-secrets-owner-on-the-private-bus${when}`, p === null, `GetNameOwner(org.freedesktop.secrets) on the private bus → ${p === null ? 'no owner' : `pid ${p}`}`); return; }
      for (const c of secretsOwnerChecks(ownerEvidence(w))) clause(`${tag}/world/${c.id}${when}`, c.ok, c.detail);
    };
    ownerCs('');
    const itemsBefore = spec.keyring === 'none' ? -1 : itemCount(w);
    const fileBefore = fs.readFileSync(w.secretsFile);
    const live0 = liveHash();

    a = await bootApp(w, spec);
    await identity(a, w, tag);
    clause(`${tag}/startup-bounded`, a.tTarget < TARGET_BOUND_MS, `spawn → renderer target in ${a.tTarget} ms (bound ${TARGET_BOUND_MS} ms; a locked-keyring stall is tens of seconds)`);

    const expectLine = {
      unlocked: /password-store: gnome-libsecret — unlocked-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir \(exported\)\]/,
      locked: /password-store: Chromium default — locked-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir\]/,
      nosvc: /password-store: Chromium default — no-service \(probe \d+ ms\) \[desktop="sway" session="" bus=runtime-dir\]/,
      recognised: /password-store: Chromium default — recognised-desktop \[desktop="LXQt" session="" bus=env\]/,
      isolated: /password-store: basic — isolated-instance \[desktop="sway" session="" bus=runtime-dir\]$/m,
      'isolated-gnome': /password-store: basic — isolated-instance \[desktop="GNOME" session="" bus=env\]$/m,
      gnome: /password-store: Chromium default — recognised-desktop \[desktop="GNOME" session="" bus=env\]/,
      hung: /password-store: Chromium default — no-service \(probe (4[89]\d\d|5[0-4]\d\d) ms\)/, // the 5 s WAIT deadline (the stub gdbus ignores --timeout and is left running, never signalled), not the stub's 30 s
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
      await stopApp(a, w); a = null;
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
      await stopApp(a, w); a = null;
      await keyringStopOnly(w); await sleep(300); keyringStart(w, { unlock: false });
      ownerCs('/after-relock');
      clause(`${tag}/ctl/keyring-now-locked`, lockedOf(w) === 'locked', `private keyring Locked → ${lockedOf(w)}`);
      const fileMid = fs.readFileSync(w.secretsFile);
      a = await bootApp(w, spec);
      const st2 = await stateOf(a);
      clause(`${tag}/relocked-state`, st2.s.encrypted === false && st2.s.encryptedEntries === 3 && st2.s.plaintextEntries === 0 && st2.ms < STATE_BOUND_MS, `getSecretsState → ${JSON.stringify(st2.s)} in ${st2.ms} ms`);
      clause(`${tag}/relocked-ciphertext-kept`, fs.readFileSync(w.secretsFile).equals(fileMid), 'secrets.json byte-identical: the ciphertext waits for the keyring, nothing was rewritten or dropped');
      await openDialog(a.cdp, SEL.linearBtn, SEL.linear);
      const n2 = await waitFor(() => noticeIn(a.cdp, SEL.linear), 8000, 'the unreadable notice');
      clause(`${tag}/relocked-notice`, n2.kind === 'unreadable' && /3 stored secrets are encrypted and unreadable until the keyring is unlocked and Orchestra restarted/.test(n2.text) && /stored unencrypted on this machine: the keyring is locked — unlock it, then restart Orchestra/.test(n2.text) && !/no keyring is available/.test(n2.text), `notice ${JSON.stringify(n2)} (the probe found the keyring LOCKED, so the notice names that cause — #389 round-3 MINOR 2)`);
      clause(`${tag}/relocked-decision-logged`, /password-store: Chromium default — locked-service \(probe \d+ ms\)/.test(decisionLine(w)), decisionLine(w));
      saveShot(`${LABEL}-${name}-relocked-linear-dialog.png`, await a.cdp.shot());
    }

    for (const c of rootCensusChecks(fs.readdirSync(RIG_XDG), ARM_DIR_NAMES())) clause(`${tag}/world/${c.id}`, c.ok, c.detail);
    const live1 = liveHash();
    clause(`${tag}/ctl/live-files-byte-equal`, JSON.stringify(live0) === JSON.stringify(live1), `${Object.keys(live0).length} host config/secrets files hashed before/after this arm: ${JSON.stringify(live0) === JSON.stringify(live1) ? 'identical' : 'CHANGED ' + JSON.stringify(Object.keys(live0).filter((k) => live0[k] !== live1[k]))}`);
  } catch (e) {
    clause(`${tag}/completed`, false, `ABORTED: ${e.stack || e}`);
  } finally {
    await stopApp(a, w);
    await reapWorld(w);
    const left = [...w.tracked].filter(([pid, st]) => isAlive(pid, st)).map(([pid]) => pid);
    const live = unixListenersUnder([w.run, w.oh]);
    const groups = [w.appProc, w.busProc].filter((g) => g && groupAlive(g.pid)).map((g) => g.pid);
    activeWorld = null;
    clause(`${tag}/teardown-no-survivors`, left.length === 0 && live.length === 0 && groups.length === 0, `tracked processes (pid + start time) still alive: ${left.length ? left.join(',') : 'none'} of ${w.tracked.size}; process groups (app, bus) still populated: ${groups.length ? groups.join(',') : 'none'}; unix listeners still bound under ${w.run} / ${w.oh}: ${live.length ? live.map((s) => s.path).join(',') : 'none'}`);
  }
}

async function main() {
  const before = liveHash();
  console.log(`[host] ${Object.keys(before).length} live config/secrets files hashed (this rig reads no keyring file, no real bus, no real runtime dir)`);
  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']); sh('swaymsg', ['default_border', 'none']);
  for (const name of ARMS) {
    if (name === 'forged') { runForged(); continue; }
    if (!SPECS[name]) refuse(`unknown arm ${name}`);
    await runArm(name);
  }
  const after = liveHash();
  clause('ctl/host-files-byte-equal-whole-run', JSON.stringify(before) === JSON.stringify(after), `${Object.keys(before).length} host files (secrets.json of the human's Orchestra homes, Claude settings; credentials.json excluded as live-session churn) before/after the whole run: ${JSON.stringify(before) === JSON.stringify(after) ? 'identical' : 'CHANGED'}`);
  for (const c of rootCensusChecks(fs.readdirSync(RIG_XDG), ARM_DIR_NAMES())) clause(`ctl/whole-run/${c.id}`, c.ok, c.detail);
  // The hidden world's stand-in for the human's runtime dir (an empty tmpfs inside this namespace): ANYTHING in it was created by a rig process that reached for the real path.
  const hiddenEntries = fs.readdirSync(humanRuntimeDir(UID));
  clause('ctl/hidden-runtime-dir-stayed-empty', hiddenEntries.length === 0, `entries created in the hidden stand-in of the human's runtime dir: [${hiddenEntries.join(' ')}] (must be empty: nothing reached for it)`);
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
