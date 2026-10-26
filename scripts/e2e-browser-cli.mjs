// #395 — `orchestra browser <cmd>` end to end: the REAL CLI bundle → the host `/browser` route (ADR 0008 identity) → the per-workspace
// loopback CDP proxy → the pinned agent-browser daemon → the REAL Browser panel of a BUILT Orchestra, against the shared fixture site.
//
// Boots a BUILT Orchestra (argv[2] = app dir) inside the contained rig's own headless sway (scripts/e2e-browser-cli.sh → e2e-contained-rig.sh),
// with a SCRATCH ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR, TWO seeded workspaces (a pinned session key each, hashes in session-keys.json)
// and the fixture site (scripts/fixtures/browser-site). Every page assertion reads an INDEPENDENT oracle: the app's own remote-debugging port
// (a second CDP client on the panel's page), never the CLI/proxy/agent-browser chain under test.
//
// Usage (via scripts/e2e-browser-cli.sh): <app-dir> --live-home <real $HOME> [--arm a,b] [--list] [--mutant <name>] [--out dir]
//   --mutant <name>: patch the BUILT bundle in place (byte-exact backup, `cmp`-verified restore), run, and require the mutant's arms RED
//   (and every control GREEN). Without it the run must be all green.
import { execFileSync, spawn } from 'node:child_process';
import crypto from 'node:crypto';
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { WebSocket as WS } from 'ws';
import { abLayout } from '../src/main/agent-browser-daemon.ts';
import { privateRuntimeDir } from './lib/rig-runtime.mjs';

const repoRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const flag = (n, d) => { const i = argv.indexOf(n); return i >= 0 ? argv[i + 1] : d; };

// ── arms and mutants (single source of truth for --list, the .sh wrapper and the verdict) ───────────────────────────────────────
const ARMS = ['smoke', 'legacy-coexist', 'snapshot-click', 'fill', 'upload', 'dialog', 'stale-ref', 'screenshot', 'loopback-guard', 'cross-workspace', 'background', 'daemon-host-owned', 'allowlist', 'breadth', 'tabs', 'daemon-lifecycle', 'child-session', 'destroy-closes-daemon', 'iframe-churn'];
/** Mutants patch the BUILT bundle in place. `file`: 'chunk' = the main-process chunk main.js requires (hash changes per build), 'cli' = dist-electron/cli.js.
 *  Each edit is a regex that must match EXACTLY once (so a refactor can never leave a mutant silently inert); `arms` must go RED, every ctl/* clause must stay GREEN. */
const MUTANTS = {
  'guard-origin': { file: 'chunk', edits: [[/if\((\w+)\.origin!==void 0\)return\{ok:!1,reason:"origin-present"\};/, '']], arms: ['loopback-guard'], why: 'the proxy accepts a request carrying an Origin header' },
  'guard-host': { file: 'chunk', edits: [[/return (\w+)\?Number\(\1\[2\]\)!==(\w+)\?\{ok:!1,reason:"host-port-mismatch"\}:\{ok:!0\}:\{ok:!1,reason:"host-not-loopback"\}/, 'return{ok:!0}']], arms: ['loopback-guard'], why: 'the proxy accepts any Host (DNS rebinding)' },
  'guard-token': { file: 'chunk', edits: [[/return (\w+)\.length===(\w+)\.length&&\2\.length>0&&(\w+)\.timingSafeEqual\(\1,\2\)/, 'return!0']], arms: ['loopback-guard'], why: 'any path token is accepted' },
  'verify-bypass': { file: 'chunk', edits: [[/if\((\w+)==="superseded"\)return\{ok:!1,code:"superseded",error:"this session was replaced by a newer one/, 'if($1==="__never__")return{ok:!1,code:"superseded",error:"this session was replaced by a newer one']], arms: ['cross-workspace'], why: 'the host stops refusing a session key that belongs to another workspace' },
  'env-scrub': { file: 'cli', edits: [['for (const [k, v] of Object.entries(fromHost)) out[k] = v;', 'for (const [k, v] of Object.entries(fromHost)) out[k] = v; for (const [k, v] of Object.entries(parent)) if (k.startsWith("AGENT_BROWSER_") && typeof v === "string") out[k] = v;']], arms: ['cross-workspace'], why: 'the caller\'s AGENT_BROWSER_* env reaches the client (it can re-point at a sibling\'s daemon)' },
  'stale-map': { file: 'cli', edits: [['const STALE_PATTERNS = [/Could not locate element with role=/i, /Unknown ref:/i, /stale ref/i, /no longer (?:attached|exists)/i];', 'const STALE_PATTERNS = [];']], arms: ['stale-ref'], why: 'a stale ref is reported as the raw agent-browser error, not browser_stale_ref' },
  'allowlist-open': { file: 'cli', edits: [['if (!BROWSER_COMMANDS.has(command)) {', 'if (false) {'], ['if (command in REFUSED_COMMANDS) {', 'if (false) {'], ['if (REFUSED_FLAGS.has(name)) {', 'if (false) {']], arms: ['allowlist'], why: 'every agent-browser command and flag passes through' },
  'frames-guard': { file: 'chunk', edits: [[/framesError:(\w+)=>\{/, 'framesError:$1=>{return null;']], arms: ['background'], why: 'no up-front refusal: a background workspace\'s screenshot waits for a frame that never comes (the probe → deadline → capturePage chain runs for real)' },
  'no-about-blank': { file: 'chunk', edits: [[/!(\w+)\.getURL\(\)&&!\1\.isLoading\(\)&&await Promise\.race\(\[\1\.loadURL\("about:blank"\)\.catch\(\(\)=>\{\}\),new Promise\((\w+)=>setTimeout\(\2,5e3\)\)\]\)[;,]/, '']], arms: ['smoke'], why: 'a never-navigated tab is attached as is (Runtime.evaluate hangs, agent-browser gives up: "tab is not responding")' },
  'daemon-neuter': { file: 'chunk', edits: [[/\(async\(\)=>\{if\(await (\w+)\.canConnect\((\w+)\)\)return;/, '(async()=>{return;']], arms: ['daemon-host-owned'], why: 'the host never starts the daemon; the first agent client does, with the agent\'s env, inside the member\'s scope' },
  'daemon-env-leak': { file: 'chunk', edits: [[/execFile\((\w+),(\w+),\{env:(\w+),timeout/, 'execFile($1,$2,{env:{...process.env,...$3},timeout']], arms: ['daemon-host-owned'], why: 'the host spawns the daemon with the app\'s whole environment' },
  'screenshot-truncated': { file: 'chunk', edits: [[/primary:async\(\)=>\(await (\w+)\.channel\.send\("Page\.captureScreenshot",(\w+)\)\)\.data/, 'primary:async()=>(await $1.channel.send("Page.captureScreenshot",$2)).data.slice(0,64)']], arms: ['screenshot'], why: 'the screenshot chain returns a truncated image' },
  'fill-dropped': { file: 'chunk', edits: [[/(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/, '($2==="Input.insertText"?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(']], arms: ['fill'], why: 'text insertion is acknowledged but never reaches the page' },
  'upload-dropped': { file: 'chunk', edits: [[/(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/, '($2==="DOM.setFileInputFiles"?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(']], arms: ['upload'], why: 'the file-input assignment is acknowledged but never reaches the page' },
  'dialog-dropped': { file: 'chunk', edits: [[/(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/, '($2==="Page.handleJavaScriptDialog"?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(']], arms: ['dialog'], why: 'dialog accept/dismiss is acknowledged but the page stays blocked' },
  'archive-no-dispose': { file: 'chunk', edits: [[/\(([\w$]+),([\w$]+),([\w$]+)\)=>\{\3&&([\w$]+)\(\1\)\}\),\(async\(\)=>\{try\{/, '($1,$2,$3)=>{}),(async()=>{try{']], arms: ['destroy-closes-daemon'], why: 'archiving a workspace leaves its CDP proxy and agent-browser daemon running' },
  'blank-overwrites-pending-load': { file: 'chunk', edits: [[/!(\w+)\.getURL\(\)&&!\1\.isLoading\(\)&&await/, '!$1.getURL()&&await']], arms: ['tabs'], why: 'a tab created with a url is overwritten by the about:blank kick while its load is still in flight' },
  'archived-guard-removed': { file: 'chunk', edits: [[/if\((\w+)\.archived\)return\{ok:!1,code:"unknown-workspace",error:`workspace \$\{(\w+)\} is archived`\};try\{/, 'try{']], arms: ['destroy-closes-daemon'], why: 'the up-front archived refusal is gone: a late /browser call for an archived workspace is only caught after its panel and proxy were rebuilt' },
  'bring-to-front-forwarded': { file: 'chunk', edits: [[/if\((\w+)==="Page\.bringToFront"\)return this\.port\.activateTab\((\w+)\),\{\};/, '']], arms: ['tabs'], why: 'Page.bringToFront reaches the real debugger (OS focus) instead of only activating the tab' },
  'auto-dialog-on': { file: 'chunk', edits: [[/AGENT_BROWSER_NO_AUTO_DIALOG:"1",?/, '']], arms: ['dialog'], why: 'the daemon auto-dismisses alert()/beforeunload again (it could answer the human\'s own dialog unseen)' },
  'token-in-argv': { file: 'cli', edits: [['.spawn(binary, plan.args,', '.spawn(binary, ["--cdp", res.wsUrl, ...plan.args],']], arms: ['daemon-host-owned'], why: 'the CLI puts the token-bearing proxy URL in agent-browser\'s argv (world-readable /proc/<pid>/cmdline)' },
  'relative-paths': { file: 'cli', edits: [['return planBrowserCommand(absolutizeBrowserArgs(argv, cwd));', 'return planBrowserCommand(argv);']], arms: ['screenshot'], why: 'file arguments are not made absolute: a relative screenshot path lands in the host-owned daemon\'s cwd (the app dir)' },
  'dashdash-exempt': { file: 'cli', edits: [['for (const a of argv) {\n    const name = a.startsWith("--")', 'for (const a of argv) {\n    if (a === "--") break;\n    const name = a.startsWith("--")']], arms: ['allowlist'], why: 'flags after `--` are not checked (session -- --session x re-points the client)' },
  'command-not-first': { file: 'cli', edits: [['const command = argv[idx];', 'const command = argv.find((a) => !a.startsWith("-"));']], arms: ['allowlist'], why: 'the command is the first non-flag token again (a leading value-taking option shifts it)' },
  'release-no-reset': { file: 'chunk', edits: [[/of ([\w$]+)\(([\w$]+)\.getUserAgent\(\)\)\)\{/, 'of []){']], arms: ['daemon-lifecycle'], why: 'the agent\'s Emulation overrides are not undone when its daemon leaves (detach alone does not clear them)' },
  'cdp-url-allowed': { file: 'cli', edits: [[/if \(argv\.slice\(idx \+ 1\)\.some\(\(a\) => a\.toLowerCase\(\)\.replace\(\/\['"`\]\/g, ""\)\.replace\(\/\[-_\]\/g, ""\) === "cdpurl"\)\) \{/, 'if (false) {']], arms: ['allowlist'], why: '`get cdp-url` passes the planner: the token-bearing endpoint is printed to any shell step' },
  'tunnel-methods-allowed': { file: 'chunk', edits: [[/if\(([\w$]+)\.has\((\w+)\)\)throw new ([\w$]+)\(`\$\{\2\} is not supported: this proxy speaks flattened sessions only`/, 'if(false)throw new $3(`${$2} is not supported: this proxy speaks flattened sessions only`']], arms: ['allowlist'], why: 'Target.sendMessageToTarget / exposeDevToolsProtocol reach the page debugger (raw CDP past every per-method policy)' },
  'child-session-bypass': { file: 'chunk', edits: [[/return ([\w$]+)\(n\)\?n==="Page\.close"\?this\.browserCommand\(t,"Target\.closeTarget",\{targetId:this\.targetIdFor\(i\)\}\):this\.browserCommand\(t,n,r\):this\.tabCommand\(i,n,r,a\)/, 'return $1(n)&&!a?n==="Page.close"?this.browserCommand(t,"Target.closeTarget",{targetId:this.targetIdFor(i)}):this.browserCommand(t,n,r):this.tabCommand(i,n,r,a)']], arms: ['child-session'], why: 'a CHILD (worker/iframe) session skips the browser-level rules again: its Page.close / Target.closeTarget / Browser.* reach the debugger (close ownership bypass, #397 F1)' },
  'cdp-url-first-token-only': { file: 'cli', edits: [[/if \(argv\.slice\(idx \+ 1\)\.some\(\(a\) => a\.toLowerCase\(\)\.replace\(\/\['"`\]\/g, ""\)\.replace\(\/\[-_\]\/g, ""\) === "cdpurl"\)\) \{/, 'if ([argv.slice(idx + 1).find((a) => !a.startsWith("-"))].some((a) => a !== void 0 && a.toLowerCase().replace(/[-_]/g, "") === "cdpurl")) {']], arms: ['allowlist'], why: 'the get cdp-url refusal looks only at the first non-flag token: `get --max-output 100 cdp-url` passes the planner (layer 2, the redaction, still holds)' },
  'close-any-tab': { file: 'chunk', edits: [[/if\((\w+)\.openedBy!=="agent"\)throw new Error\(`browser tab \$\{(\w+)\} was opened by the user: an agent may only close tabs it opened`\);/, '']], arms: ['tabs'], why: 'an agent may close a tab the human opened' },
  'press-dropped': { file: 'chunk', edits: [[/(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/, '($2==="Input.dispatchKeyEvent"?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(']], arms: ['breadth'], why: 'key events are acknowledged but never reach the page' },
  'click-dropped': { file: 'chunk', edits: [[/(\w+)\.channel\.send\((\w+),(\w+),(\w+)\)\.then\(/, '($2==="Input.dispatchMouseEvent"?Promise.resolve({}):$1.channel.send($2,$3,$4)).then(']], arms: ['snapshot-click'], why: 'mouse events are acknowledged but never reach the page' },
  'child-detach-unsettled': { file: 'chunk', edits: [[/;([\w$]+)&&([\w$]+)\.pending\.abort\(\1\)\}onDebuggerDetached/, ';}onDebuggerDetached']], arms: ['iframe-churn'], why: 'the proxy announces a child\'s detach but leaves the commands in flight on it pending: the daemon\'s awaited attach-time chain stalls for its whole timeout (seat-1 tchurn, ledger #405)' },
};
if (argv.includes('--list')) {
  console.log(`arms: ${ARMS.join(' ')}`);
  console.log(`mutants: ${Object.keys(MUTANTS).join(' ')}`);
  process.exit(0);
}

// --check-anchors <app-dir>: NO app, NO compositor — prove every mutant's edit still matches EXACTLY once in the built bundle (a refactor must never leave a mutant silently inert or REFUSED mid-sweep)
if (argv[0] === '--check-anchors') {
  const app = fs.realpathSync(argv[1] ?? '.');
  const chunk = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(app, 'dist-electron/main.js'), 'utf8'))?.[1];
  let bad = 0;
  for (const [name, m] of Object.entries(MUTANTS)) {
    const file = path.join(app, 'dist-electron', m.file === 'cli' ? 'cli.js' : chunk);
    const src = fs.readFileSync(file, 'utf8');
    const counts = m.edits.map(([from]) => (typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length));
    const ok = counts.every((c) => c === 1);
    if (!ok) bad++;
    console.log(`${ok ? 'OK ' : 'BAD'} ${name.padEnd(30)} ${path.basename(file)} matches=${counts.join(',')}`);
  }
  console.log(bad ? `${bad} mutant anchor(s) stale` : `all ${Object.keys(MUTANTS).length} mutant anchors match exactly once`);
  process.exit(bad ? 1 : 0);
}
const APP_DIR = argv[0] && !argv[0].startsWith('--') ? fs.realpathSync(argv[0]) : null;
const LIVE_HOME = flag('--live-home', null);
const MUTANT = flag('--mutant', null);
// Slow arms (N runs of a 3 s churn) are opt-in: `--arm iframe-churn`, or implied by their own mutant; the default run and every other mutant skip them.
const OPT_IN_ARMS = ['iframe-churn'];
const ARM_LIST = (flag('--arm', null) ?? [...ARMS.filter((a) => !OPT_IN_ARMS.includes(a)), ...(MUTANT ? (MUTANTS[MUTANT]?.arms ?? []).filter((a) => OPT_IN_ARMS.includes(a)) : [])].join(',')).split(',');

const refuse = (m) => { console.log(`REFUSED: ${m}`); process.exit(3); };
if (!APP_DIR) refuse('no <app-dir>');
if (!LIVE_HOME) refuse('--live-home missing (needed to protect the live ~/.claude*, ~/.config, ~/.orchestra and to prove nothing there moved)');
for (const a of ARM_LIST) if (!ARMS.includes(a)) refuse(`unknown arm ${a} (have: ${ARMS.join(', ')})`);
if (MUTANT && !MUTANTS[MUTANT]) refuse(`unknown mutant ${MUTANT} (have: ${Object.keys(MUTANTS).join(', ')})`);
const RIG_DIR = process.env.RIG_DIR;
const RIG_WAYLAND = process.env.RIG_WAYLAND;
if (!RIG_DIR || !RIG_WAYLAND) refuse('RIG_DIR / RIG_WAYLAND unset — run via scripts/e2e-browser-cli.sh (the contained rig)');
if (process.env.DISPLAY) refuse(`X11 DISPLAY=${process.env.DISPLAY} is set — Electron would reach the human's screen`);
if (process.env.WAYLAND_DISPLAY !== RIG_WAYLAND || RIG_WAYLAND === 'wayland-1') refuse(`WAYLAND_DISPLAY=${process.env.WAYLAND_DISPLAY} != marker-verified ${RIG_WAYLAND}`);
const OUT = flag('--out', null) || path.join(RIG_DIR, 'shots');

// ── scratch-containment guard (live dirs are never handed to the app) ─────────────────────────────────────────────────────────
const RIG_BASE = fs.realpathSync(path.dirname(RIG_DIR));
const liveReal = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE_DIRS = [...fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n)),
  path.join(LIVE_HOME, '.orchestra'), path.join(LIVE_HOME, '.config')].map(liveReal);
function checkScratch(p) {
  const r = liveReal(p);
  for (const l of LIVE_DIRS) if (r === l || r.startsWith(l + path.sep) || l.startsWith(r + path.sep)) return { ok: false, clause: 'live-dir' };
  if (!(r === RIG_BASE || r.startsWith(RIG_BASE + path.sep))) return { ok: false, clause: 'outside-rig-base' };
  return { ok: true, clause: 'scratch' };
}
const mustBeScratch = (what, p) => { const r = checkScratch(p); if (!r.ok) refuse(`${what}=${p} [${r.clause}]`); };
{
  const a = checkScratch(path.join(LIVE_HOME, '.claude')), b = checkScratch('/tmp/not-in-the-rig'), c = checkScratch(path.join(RIG_DIR, 'x'));
  if (a.clause !== 'live-dir' || b.clause !== 'outside-rig-base' || !c.ok) refuse(`scratch guard self-test failed: ${JSON.stringify({ a, b, c })}`);
  console.log(`[guard] self-test: live ~/.claude -> ${a.clause} · /tmp path -> ${b.clause} · rig path -> ${c.clause}`);
}

// ── helpers ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const md5 = (b) => crypto.createHash('md5').update(b).digest('hex');
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
async function waitFor(fn, ms, what) {
  const t0 = Date.now(); let last;
  while (Date.now() - t0 < ms) { try { last = await fn(); if (last) return last; } catch (e) { last = e; } await sleep(150); }
  throw new Error(`timeout ${ms}ms waiting for ${what}${last instanceof Error ? `: ${last.message}` : ''}`);
}
const freePort = () => new Promise((res, rej) => { const s = net.createServer(); s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); }); s.on('error', rej); });
const sh = (cmd, args, opt = {}) => execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], ...opt });
const git = (cwd, args, home) => sh('git', ['-c', 'user.name=rig', '-c', 'user.email=rig@example.invalid', ...args], { cwd, env: { PATH: process.env.PATH, HOME: home, GIT_CONFIG_NOSYSTEM: '1' } });

function decodePng(buf) {
  let pos = 8; const idat = []; let w, h, bd, ct, il;
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos), type = buf.toString('latin1', pos + 4, pos + 8), data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; il = data[12]; }
    else if (type === 'IDAT') idat.push(data); else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || il !== 0 || (ct !== 6 && ct !== 2)) throw new Error(`unsupported PNG bd=${bd} ct=${ct} il=${il}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch, raw = zlib.inflateSync(Buffer.concat(idat)), out = Buffer.alloc(stride * h);
  let prev = Buffer.alloc(stride), i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++], line = Buffer.from(raw.subarray(i, i + stride)); i += stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? line[x - ch] : 0, b = prev[x], c = x >= ch ? prev[x - ch] : 0;
      let add = 0;
      if (f === 1) add = a; else if (f === 2) add = b; else if (f === 3) add = (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); add = pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      line[x] = (line[x] + add) & 255;
    }
    line.copy(out, y * stride); prev = line;
  }
  return { w, h, ch, data: out };
}
/** pixels that are not the image's dominant colour = painted "ink". */
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
  send(method, params = {}, ms = 20000) {
    const id = ++this.id;
    return new Promise((res, rej) => { const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`CDP ${method} timed out after ${ms}ms`)); }, ms); this.pending.set(id, { res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } }); this.ws.send(JSON.stringify({ id, method, params })); });
  }
  async eval(expr) { const r = await this.send('Runtime.evaluate', { expression: expr, returnByValue: true, awaitPromise: true }); if (r.exceptionDetails) throw new Error(`eval threw: ${r.exceptionDetails.text} ${r.exceptionDetails.exception?.description ?? ''}`); return r.result.value; }
  async click(x, y) { for (const [type, extra] of [['mouseMoved', {}], ['mousePressed', { button: 'left', clickCount: 1 }], ['mouseReleased', { button: 'left', clickCount: 1 }]]) { await this.send('Input.dispatchMouseEvent', { type, x, y, ...extra }); await sleep(60); } }
  close() { try { this.ws.close(); } catch {} }
}

// ── seeding ─────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const WS_NAMES = ['b395-one', 'b395-two'];
function seedWorld(armDir) {
  const fakeHome = path.join(armDir, 'home'), ohome = path.join(armDir, 'oh'), cfg = path.join(armDir, 'claude-config'), repoDir = path.join(armDir, 'repo');
  for (const d of [fakeHome, ohome, cfg, repoDir]) fs.mkdirSync(d, { recursive: true });
  for (const [k, v] of Object.entries({ HOME: fakeHome, ORCHESTRA_HOME: ohome, CLAUDE_CONFIG_DIR: cfg, repo: repoDir })) mustBeScratch(k, v);
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# b395 seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  const account = { id: 'rig-b395', label: 'rig (scratch config dir)', configDir: cfg };
  mustBeScratch('account.configDir', account.configDir);
  const workspaces = WS_NAMES.map((name, i) => {
    const wt = path.join(armDir, 'wt', name);
    fs.mkdirSync(path.dirname(wt), { recursive: true });
    git(repoDir, ['worktree', 'add', '-q', '-b', `e2e/${name}`, wt], fakeHome);
    return { id: `ws-${name}`, name, repoPath: repoDir, worktreePath: wt, branch: `e2e/${name}`, baseBranch: 'main', createdAt: Date.now() + i, status: 'idle', agent: 'claude', accountId: account.id, key: crypto.randomBytes(24).toString('hex') };
  });
  const dir = path.join(ohome, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [{ path: repoDir, name: 'b395-repo', defaultBranch: 'main', accountId: account.id }], workspaces: workspaces.map(({ key, ...w }) => w), accounts: [account], selfTuneRuns: [] }, null, 2));
  // the host vouches for a CLI only through this registry (ADR 0008): hashes, 0600 — exactly what a fresh keeper spawn writes
  fs.writeFileSync(path.join(ohome, 'session-keys.json'), JSON.stringify({ version: 1, sessions: Object.fromEntries(workspaces.map((w) => [w.id, { hash: sha256(w.key), issuedAt: Date.now() }])) }), { mode: 0o600 });
  const stubDir = path.join(armDir, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  fs.writeFileSync(path.join(stubDir, 'claude'), '#!/bin/sh\necho B395-STUB-CLAUDE "$@"\nsleep 3600\n', { mode: 0o755 });
  return { fakeHome, ohome, cfg, account, workspaces, stubDir };
}

function listProcsByHome(home) {
  const out = [];
  for (const p of fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n))) {
    try { const env = fs.readFileSync(`/proc/${p}/environ`, 'utf8').split('\0'); if (env.includes(`ORCHESTRA_HOME=${home}`)) { out.push(+p); continue; } } catch {}
    try { if (fs.readFileSync(`/proc/${p}/cmdline`, 'utf8').includes(home)) out.push(+p); } catch {} // Chromium rewrites environ once a bus address is set; its children still carry --user-data-dir=<home>/userData
  }
  return out.filter((p) => p !== process.pid);
}

const results = []; // {arm, clause, ok, detail}
function clause(arm, name, ok, detail) { results.push({ arm, clause: name, ok: !!ok, detail }); console.log(`  ${ok ? 'PASS' : 'FAIL'}  [${arm}] ${name} — ${detail}`); }
const shots = [];
function saveShot(name, buf) { fs.mkdirSync(OUT, { recursive: true }); const f = path.join(OUT, name); fs.writeFileSync(f, buf); shots.push({ file: f, md5: md5(buf) }); return f; }

// ── mutants: patch the BUILT bundle in place; restore byte-exact and prove it with cmp ──────────────────────────────────────────
let mutantRestore = null;
function mutantTarget(kind) {
  if (kind === 'cli') return path.join(APP_DIR, 'dist-electron/cli.js');
  const m = /\.\/(index-[A-Za-z0-9_-]+\.js)/.exec(fs.readFileSync(path.join(APP_DIR, 'dist-electron/main.js'), 'utf8'));
  if (!m) refuse('cannot resolve the main-process chunk from dist-electron/main.js');
  return path.join(APP_DIR, 'dist-electron', m[1]);
}
const MARKER = path.join(APP_DIR ?? '/nonexistent', 'dist-electron', '.b395-mutant-active');
function applyMutant() {
  if (fs.existsSync(MARKER)) refuse(`${MARKER} exists — an earlier mutant run died without restoring the bundle: ${fs.readFileSync(MARKER, 'utf8').trim()} (restore it from that backup, or rebuild, then delete the marker)`);
  if (!MUTANT) return;
  const m = MUTANTS[MUTANT], file = mutantTarget(m.file), backup = path.join(RIG_DIR, `mutant-backup-${path.basename(file)}`);
  let src = fs.readFileSync(file, 'utf8');
  for (const [from, to] of m.edits) {
    const hits = typeof from === 'string' ? src.split(from).length - 1 : (src.match(new RegExp(from.source, 'g')) ?? []).length;
    if (hits !== 1) refuse(`mutant ${MUTANT}: ${String(from).slice(0, 70)} occurs ${hits}x in ${path.basename(file)} (must be exactly 1) — the bundle changed, update the mutant`);
    src = typeof from === 'string' ? src.replace(from, () => to) : src.replace(from, to);
  }
  fs.copyFileSync(file, backup);
  fs.writeFileSync(MARKER, `${backup} -> ${file}\n`);
  fs.writeFileSync(file, src);
  console.log(`[mutant] ${MUTANT} applied to ${path.basename(file)} (${m.edits.length} edit(s)): ${m.why}; backup ${backup}`);
  mutantRestore = () => { fs.copyFileSync(backup, file); try { sh('cmp', [backup, file]); fs.rmSync(MARKER, { force: true }); console.log(`[mutant] ${MUTANT} restored byte-exact (cmp OK)`); } catch { console.log(`[mutant] RESTORE NOT BYTE-EXACT — rebuild ${path.basename(file)}`); process.exitCode = 4; } };
}
process.on('uncaughtException', (e) => { clause('rig', 'uncaught-exception', false, String(e?.stack ?? e).slice(0, 400)); });
process.on('exit', () => { try { mutantRestore?.(); } catch {} });
process.on('SIGINT', () => process.exit(130));
process.on('SIGTERM', () => process.exit(143));

// ── one world, all arms ───────────────────────────────────────────────────────────────────────────────────────────────────────
async function main() {
  const armDir = path.join(RIG_DIR, 'world'); fs.mkdirSync(armDir, { recursive: true });
  const world = seedWorld(armDir);
  const [W1, W2] = world.workspaces;
  const fixture = spawn(process.execPath, [path.join(repoRoot, 'scripts/fixtures/browser-site/server.mjs'), '0'], { env: { PATH: process.env.PATH }, stdio: ['ignore', 'pipe', 'inherit'] });
  const FIX = await new Promise((res, rej) => { let b = ''; fixture.stdout.on('data', (d) => { b += d; const m = /LISTENING (\d+)/.exec(b); if (m) res(`http://127.0.0.1:${m[1]}`); }); fixture.on('exit', () => rej(new Error('fixture exited'))); setTimeout(() => rej(new Error('fixture never listened')), 8000); });
  console.log(`[rig] fixture ${FIX}`);

  sh('swaymsg', ['output', 'HEADLESS-1', 'resolution', '1400x900']);
  sh('swaymsg', ['default_border', 'none']);
  const port = await freePort();
  const env = { PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: world.fakeHome, XDG_RUNTIME_DIR: privateRuntimeDir(), DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS ?? '', XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG_WAYLAND, SWAYSOCK: process.env.SWAYSOCK, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: world.ohome, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true', CLAUDE_CONFIG_DIR: world.cfg, LANG: 'C.UTF-8', ORCHESTRA_CDP_RELEASE_GRACE_MS: '1500', ...(argv.includes('--trace') ? { ORCHESTRA_CDP_TRACE: '1' } : {}) };
  for (const k of ['HOME', 'XDG_CONFIG_HOME', 'XDG_CACHE_HOME', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR']) mustBeScratch(`env.${k}`, env[k]);
  if ('DISPLAY' in env || env.WAYLAND_DISPLAY !== RIG_WAYLAND) refuse('child env would reach the human display');
  { const bus = env.DBUS_SESSION_BUS_ADDRESS, busPath = bus.startsWith('unix:path=') ? bus.slice('unix:path='.length) : ''; if (!busPath || !busPath.startsWith(RIG_DIR + path.sep) || fs.existsSync(busPath)) refuse(`child D-Bus address '${bus}' is not the rig's private nonexistent bus (it would reach the human's session bus)`); }
  const logFile = path.join(armDir, 'app.log');
  const fd = fs.openSync(logFile, 'w');
  const app = spawn(path.join(APP_DIR, 'node_modules/electron/dist/electron'), [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', fd, fd], detached: true });
  console.log(`[rig] app pid ${app.pid} debug port ${port} log ${logFile}`);
  let ui;
  const targets = async () => (await (await fetch(`http://127.0.0.1:${port}/json`)).json());
  try {
    const target = await waitFor(async () => (await targets()).find((x) => x.type === 'page' && x.url.includes('dist/index.html')) || null, 60000, 'the app page target');
    clause('ctl', 'app-identity-path', target.url.includes(APP_DIR) && !target.url.includes('app.asar'), `target url ${target.url} ⊇ ${APP_DIR}`);
    ui = await Cdp.connect(target.webSocketDebuggerUrl);
    await ui.send('Page.enable');
    // What the DRIVER handed the app (its /proc/<pid>/environ goes blind once DBUS_SESSION_BUS_ADDRESS is set: Chromium rewrites it, see src/shared/browser-reliquats.ts)
    const handed = env;
    clause('ctl', 'scratch-env', handed.ORCHESTRA_HOME === world.ohome && handed.CLAUDE_CONFIG_DIR === world.cfg && handed.HOME === world.fakeHome && !('DISPLAY' in handed) && handed.WAYLAND_DISPLAY === RIG_WAYLAND && handed.XDG_RUNTIME_DIR === privateRuntimeDir() && handed.DBUS_SESSION_BUS_ADDRESS.includes(RIG_DIR),
      `env handed to the app: ORCHESTRA_HOME=${handed.ORCHESTRA_HOME} CLAUDE_CONFIG_DIR=${handed.CLAUDE_CONFIG_DIR} WAYLAND_DISPLAY=${handed.WAYLAND_DISPLAY} DISPLAY=${'DISPLAY' in handed ? handed.DISPLAY : '<unset>'} XDG_RUNTIME_DIR=${handed.XDG_RUNTIME_DIR} DBUS_SESSION_BUS_ADDRESS=${handed.DBUS_SESSION_BUS_ADDRESS}`);
    const ctx = { world, W1, W2, FIX, port, app, ui, targets, env };
    await runArms(ctx);
  } catch (e) {
    clause('rig', 'completed', false, `ABORTED: ${e.stack || e}`);
  } finally {
    ui?.close();
    try { process.kill(-app.pid, 'SIGTERM'); } catch {}
    await sleep(2000);
    try { process.kill(-app.pid, 'SIGKILL'); } catch {}
    try { fixture.kill('SIGKILL'); } catch {}
    { // daemons a refused-then-leaked mutant run may have left (they carry no ORCHESTRA_HOME), then the scratch socket dir — only ever THIS ORCHESTRA_HOME's hashed one
      const l = abLayout(world.ohome, process.env.XDG_RUNTIME_DIR);
      for (const pid of Object.values(daemonPids({ world }))) { if (environOf(pid)?.includes(`AGENT_BROWSER_SOCKET_DIR=${l.socketDir}`)) { try { process.kill(pid, 'SIGKILL'); } catch {} } }
      if (/\/orch-ab-[0-9a-f]{8}$/.test(l.socketDir) && l.socketDir.startsWith((process.env.XDG_RUNTIME_DIR ?? '/nonexistent') + '/')) fs.rmSync(l.socketDir, { recursive: true, force: true });
    }
    for (const p of listProcsByHome(world.ohome)) { try { process.kill(p, 'SIGKILL'); } catch {} }
    let left = listProcsByHome(world.ohome);
    for (let i = 0; i < 20 && left.length > 0; i++) { await sleep(250); left = listProcsByHome(world.ohome); }
    clause('ctl', 'teardown-no-survivors', left.length === 0, `processes still carrying ${world.ohome}: ${left.length ? left.join(',') : 'none'}`);
  }
}


// ── driving helpers ─────────────────────────────────────────────────────────────────────────────────────────────────────────
const sel = (n) => JSON.stringify(n);
async function selectWs(ctx, W) {
  const { ui } = ctx;
  const pos = await ui.eval(`(() => { const n = [...document.querySelectorAll('.ws-item .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}); if (!n) return null; const b = n.getBoundingClientRect(); return { x: b.left + 20, y: b.top + b.height / 2 }; })()`);
  if (!pos) throw new Error(`sidebar row for ${W.branch} not found`);
  await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ui.click(pos.x, pos.y);
  await waitFor(() => ui.eval(`!!([...document.querySelectorAll('.ws-item.active .ws-name')].find((e) => e.textContent.trim() === ${sel(W.branch)}))`), 15000, `${W.branch} to become the active workspace`);
}
async function openPane(ctx) {
  const { ui } = ctx;
  const state = await ui.eval(`(() => { const b = document.querySelector('button[aria-label="Show browser pane"],button[aria-label="Hide browser pane"]'); if (!b) return null; const r = b.getBoundingClientRect(); return { open: b.getAttribute('aria-label') === 'Hide browser pane', x: r.left + r.width / 2, y: r.top + r.height / 2 }; })()`);
  if (!state) throw new Error('browser pane toggle not found');
  if (!state.open) { await ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: state.x, y: state.y }); await ui.click(state.x, state.y); }
  await waitFor(() => ui.eval(`!!document.querySelector('.browser-panel:not(.browser-panel-hidden) .browser-url-input')`), 15000, 'the Browser pane to be open');
}
/** The REAL CLI bundle, with an `env -i` allowlist: exactly what an agent's Bash tool hands it. */
function cli(ctx, W, args, { env: extra = {}, timeoutMs = 60000, key } = {}) {
  const base = { PATH: `${path.dirname(process.execPath)}:/usr/bin:/bin`, HOME: ctx.world.fakeHome, ORCHESTRA_HOME: ctx.world.ohome, ORCHESTRA_WS_ID: W.id, ORCHESTRA_SESSION_KEY: key ?? W.key,
    ORCHESTRA_AGENT_TMPDIR: path.join(ctx.world.fakeHome, 'agent-tmp', W.name), LANG: 'C.UTF-8', ...extra };
  fs.mkdirSync(base.ORCHESTRA_AGENT_TMPDIR, { recursive: true });
  const t0 = Date.now();
  let child;
  const done = new Promise((resolve) => {
    child = spawn(process.execPath, [path.join(APP_DIR, 'dist-electron/cli.js'), 'browser', ...args], { env: base, stdio: ['ignore', 'pipe', 'pipe'], cwd: ctx.world.fakeHome, detached: true });
    let stdout = '', stderr = '';
    child.stdout.on('data', (d) => (stdout += d)); child.stderr.on('data', (d) => (stderr += d));
    const timer = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { try { child.kill('SIGKILL'); } catch {} } }, timeoutMs);
    child.on('close', (code, signal) => { clearTimeout(timer); resolve({ code: code ?? (signal ? 137 : 0), stdout, stderr, ms: Date.now() - t0 }); });
  });
  done.child = child;
  return done;
}
const show = (r) => `rc=${r.code} ${r.ms}ms stdout=${JSON.stringify(r.stdout.trim().slice(0, 160))} stderr=${JSON.stringify(r.stderr.trim().slice(0, 200))}`;
/** Independent oracle: a second CDP client on the panel's page through the APP's own remote-debugging port. */
async function oracle(ctx, urlPrefix, ms = 15000) {
  const t = await waitFor(async () => (await ctx.targets()).find((x) => x.type === 'page' && x.url.startsWith(urlPrefix)) || null, ms, `a panel page at ${urlPrefix}`);
  return Cdp.connect(t.webSocketDebuggerUrl);
}
/** Put the human's keyboard focus in the workspace composer (the CodeMirror editor in the renderer DOM) and report whether it is there. */
const focusComposer = async (ctx) => {
  // a TRUSTED click into the editor (what the human does) gives the renderer window real focus; a bare .focus() does not
  const pos = await ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); if (!t) return null; const r = t.getBoundingClientRect(); return { x: r.left + Math.min(40, r.width / 2), y: r.top + r.height / 2 }; })()`);
  if (!pos) return null;
  await ctx.ui.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: pos.x, y: pos.y });
  await ctx.ui.click(pos.x, pos.y);
  await sleep(250);
  return composerFocus(ctx);
};
const composerFocus = (ctx) => ctx.ui.eval(`(() => { const t = document.querySelector('.av-composer .cm-content'); return t ? { onComposer: document.activeElement === t, windowFocus: document.hasFocus() } : null; })()`);
/** Oracle read that reports a page stuck behind a JS dialog as 'BLOCKED' instead of hanging the arm. */
const readOrBlocked = async (o, expr, ms = 4000) => {
  try { const r = await o.send('Runtime.evaluate', { expression: expr, returnByValue: true }, ms); return r.result?.value; } catch (e) { return /timed out/.test(String(e)) ? 'BLOCKED' : `ERR ${e}`; }
};
const refOf = (snapshot, role, name) => { const m = new RegExp(`${role} "${name}\\s*"[^\\n]*\\[ref=(e\\d+)\\]`).exec(snapshot); return m ? `@${m[1]}` : null; };
const sockets = (ctx) => { const l = abLayout(ctx.world.ohome, process.env.XDG_RUNTIME_DIR); try { return fs.readdirSync(path.join(l.socketDir, 'namespaces', 'orchestra', 'run')).filter((n) => n.endsWith('.sock')).map((n) => n.slice(0, -5)); } catch { return []; } };
const hooksSock = (ctx) => fs.readFileSync(path.join(ctx.world.ohome, 'sock'), 'utf8').trim();
function hostCall(ctx, route, body) {
  return new Promise((resolve, reject) => {
    const payload = JSON.stringify(body);
    const req = http.request({ socketPath: hooksSock(ctx), method: 'POST', path: route, headers: { 'content-type': 'application/json', 'content-length': Buffer.byteLength(payload) } }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => { try { resolve(JSON.parse(d)); } catch (e) { reject(e); } }); });
    req.on('error', reject); req.end(payload);
  });
}

const ARM_FNS = {
  async smoke(ctx) {
    const { W1, FIX } = ctx; const A = 'smoke';
    await selectWs(ctx, W1); await openPane(ctx);
    clause(A, 'ctl/pane-open', true, `${W1.branch} active, Browser pane open`);
    const open = await cli(ctx, W1, ['open', `${FIX}/cli.html`]);
    clause(A, 'cli-open', open.code === 0, show(open));
    const o = await oracle(ctx, `${FIX}/cli.html`); ctx.o1 = o;
    clause(A, 'ctl/oracle-sees-page', (await o.eval(`document.title`)) === 'CLI fixture', `oracle page title = ${JSON.stringify(await o.eval('document.title'))} (read through the app's own debug port, not the CLI)`);
    const snap = await cli(ctx, W1, ['snapshot', '-i']);
    clause(A, 'cli-snapshot-refs', snap.code === 0 && !!refOf(snap.stdout, 'button', 'Go') && !!refOf(snap.stdout, 'textbox', 'Name'), show(snap));
  },

  async 'legacy-coexist'(ctx) {
    // The old mcp__browser__* path (and design mode) share ONE debugger attach with the proxy, in BOTH orders.
    const { W1, W2, FIX, ui } = ctx; const A = 'legacy-coexist';
    // (a) proxy attached first (smoke ran the CLI on W1) → legacy design-mode arm still works
    await ui.eval(`window.orchestra.browserDesignArm(${sel(W1.id)}).then(() => true)`);
    const armed = await ctx.o1.eval(`typeof window.__orchestraDesignTeardown === 'function'`);
    await ui.eval(`window.orchestra.browserDesignDisarm(${sel(W1.id)}).then(() => true)`);
    clause(A, 'proxy-first-then-legacy', armed === true, `design overlay installed through the legacy debugger path while the proxy holds the attach: ${armed}`);
    // (b) legacy attached first on W2 (never driven by the CLI yet) → the CLI still works
    await ui.eval(`window.orchestra.browserNavigate(${sel(W2.id)}, ${sel(FIX + '/index.html')}).then(() => true)`);
    await ui.eval(`window.orchestra.browserDesignArm(${sel(W2.id)}).then(() => true)`);
    const o2 = await oracle(ctx, `${FIX}/index.html`); ctx.o2 = o2;
    const armed2 = await o2.eval(`typeof window.__orchestraDesignTeardown === 'function'`);
    const snap = await cli(ctx, W2, ['snapshot', '-i']);
    await ui.eval(`window.orchestra.browserDesignDisarm(${sel(W2.id)}).then(() => true)`);
    clause(A, 'legacy-first-then-proxy', armed2 === true && snap.code === 0 && /heading "Fixture home"/.test(snap.stdout), `legacy attach first (overlay=${armed2}), then the CLI: ${show(snap)}`);
  },

  async 'snapshot-click'(ctx) {
    const { W1 } = ctx; const A = 'snapshot-click';
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const go = refOf(snap.stdout, 'button', 'Go');
    const pre = await ctx.o1.eval(`document.getElementById('out').textContent`);
    clause(A, 'ctl/precondition-idle', pre === 'idle' && !!go, `#out=${JSON.stringify(pre)} before the click, Go ref ${go}`);
    const f0 = await focusComposer(ctx);
    const click = await cli(ctx, W1, ['click', go]);
    const post = await ctx.o1.eval(`document.getElementById('out').textContent`);
    clause(A, 'click-changes-dom', click.code === 0 && post === 'clicked', `${show(click)} → oracle #out=${JSON.stringify(post)}`);
    const f1 = await composerFocus(ctx);
    clause(A, 'ctl/composer-focusable', f0?.onComposer === true && f0?.windowFocus === true, `composer editor focused before the click: ${JSON.stringify(f0)}`);
    clause(A, 'click-does-not-steal-keyboard-focus', f1?.onComposer === true && f1?.windowFocus === true, `after an agent click in the panel the human's composer focus is ${JSON.stringify(f1)} (story 44)`);
  },

  async fill(ctx) {
    const { W1 } = ctx; const A = 'fill';
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const box = refOf(snap.stdout, 'textbox', 'Name');
    const r = await cli(ctx, W1, ['fill', box, 'hello orchestra']);
    const v = await ctx.o1.eval(`({ value: document.getElementById('name').value, echo: document.getElementById('echo').textContent })`);
    clause(A, 'fill-sets-value-and-fires-input', r.code === 0 && v.value === 'hello orchestra' && v.echo === 'hello orchestra', `${show(r)} → oracle input.value=${JSON.stringify(v.value)} #echo=${JSON.stringify(v.echo)}`);
  },

  async upload(ctx) {
    const { W1 } = ctx; const A = 'upload';
    const file = path.join(ctx.world.fakeHome, 'upload.bin'); fs.writeFileSync(file, crypto.randomBytes(4321));
    const relName = 'upload.bin'; // passed RELATIVE below: it must resolve against the agent's cwd (the rig runs the CLI from fakeHome)
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const inp = refOf(snap.stdout, 'button', 'Choose File');
    const r = await cli(ctx, W1, ['upload', inp, relName]);
    await waitFor(() => ctx.o1.eval(`document.getElementById('upres').textContent.startsWith('up:')`), 10000, 'the upload echo').catch(() => {});
    const echo = await ctx.o1.eval(`document.getElementById('upres').textContent`);
    clause(A, 'upload-reaches-the-page-and-server', r.code === 0 && echo === 'up:upload.bin:4321', `${show(r)} → oracle #upres=${JSON.stringify(echo)} (name:size echoed by the fixture server from the multipart body)`);
  },

  async dialog(ctx) {
    const { W1 } = ctx; const A = 'dialog';
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const ask = refOf(snap.stdout, 'button', 'Ask');
    const clickP = cli(ctx, W1, ['click', ask], { timeoutMs: 40000 });
    const status = await waitFor(async () => { const s = await cli(ctx, W1, ['dialog', 'status']); return /confirm dialog is open/.test(s.stdout) ? s : null; }, 15000, 'dialog status to report the open confirm');
    clause(A, 'status-sees-the-confirm', /sure\?/.test(status.stdout), show(status));
    const acc = await cli(ctx, W1, ['dialog', 'accept']);
    await Promise.race([clickP, sleep(8000)]); // a page that stays blocked must turn into a RED clause below, not an aborted arm
    const t1 = await readOrBlocked(ctx.o1, `document.getElementById('dlg').textContent`);
    clause(A, 'accept-resolves-true', acc.code === 0 && t1 === 'true', `${show(acc)} → oracle #dlg=${JSON.stringify(t1)}`);
    // pre-review m3: an alert() stays OPEN until an explicit `dialog accept` (the daemon must not auto-dismiss it: on a shared panel it could be the human's)
    const alertRef = refOf((await cli(ctx, W1, ['snapshot', '-i'])).stdout, 'button', 'Alert');
    const alertClick = cli(ctx, W1, ['click', alertRef], { timeoutMs: 40000 });
    await sleep(1500);
    const stillOpen = await cli(ctx, W1, ['dialog', 'status']);
    const accAlert = await cli(ctx, W1, ['dialog', 'accept']);
    await Promise.race([alertClick, sleep(8000)]);
    const t3 = await readOrBlocked(ctx.o1, `document.getElementById('dlg').textContent`);
    clause(A, 'alert-waits-for-an-explicit-accept', /alert dialog is open|dialog is open/.test(stillOpen.stdout) && accAlert.code === 0 && t3 === 'alerted', `1.5 s after the click: ${show(stillOpen)}; accept → ${show(accAlert)} → oracle #dlg=${JSON.stringify(t3)}`);
    const click2 = cli(ctx, W1, ['click', ask], { timeoutMs: 40000 });
    await waitFor(async () => { const s = await cli(ctx, W1, ['dialog', 'status']); return /confirm dialog is open/.test(s.stdout) ? s : null; }, 15000, 'the second confirm');
    const dis = await cli(ctx, W1, ['dialog', 'dismiss']); await Promise.race([click2, sleep(8000)]);
    const t2 = await readOrBlocked(ctx.o1, `document.getElementById('dlg').textContent`);
    clause(A, 'dismiss-resolves-false', dis.code === 0 && t2 === 'false', `${show(dis)} → oracle #dlg=${JSON.stringify(t2)}`);
  },

  async 'stale-ref'(ctx) {
    const { W1, FIX } = ctx; const A = 'stale-ref';
    const snap = await cli(ctx, W1, ['snapshot', '-i']); const go = refOf(snap.stdout, 'button', 'Go'); const home = refOf(snap.stdout, 'link', 'Home');
    const ok = await cli(ctx, W1, ['click', go]);
    clause(A, 'ctl/ref-works-before-navigation', ok.code === 0 && !!home, `click ${go} before navigating: ${show(ok)}`);
    const nav = await cli(ctx, W1, ['click', home]);
    await waitFor(() => ctx.o1.eval(`location.pathname === '/index.html'`), 10000, 'navigation to /index.html');
    const stale = await cli(ctx, W1, ['click', go]);
    clause(A, 'stale-ref-error-after-navigation', nav.code === 0 && stale.code !== 0 && /^browser_stale_ref: /.test(stale.stderr) && stale.stderr.includes(go), `${show(stale)}`);
    const js = await cli(ctx, W1, ['--json', 'click', go]);
    let parsed = null; try { parsed = JSON.parse(js.stdout.trim()); } catch {}
    clause(A, 'stale-ref-json', js.code !== 0 && parsed?.code === 'browser_stale_ref' && parsed?.success === false, `--json: ${show(js)}`);
    const re = await cli(ctx, W1, ['snapshot', '-i']);
    clause(A, 'resnapshot-recovers', re.code === 0 && /heading "Fixture home"/.test(re.stdout), show(re));
    await cli(ctx, W1, ['open', `${FIX}/cli.html`]); // back to the form page for the later arms
    await waitFor(() => ctx.o1.eval(`location.pathname === '/cli.html'`), 10000, 'back on /cli.html');
  },

  async screenshot(ctx) {
    const { W1 } = ctx; const A = 'screenshot';
    const dest = path.join(ctx.world.fakeHome, 'shot.png');
    const r = await cli(ctx, W1, ['screenshot', dest]);
    let img = null, err = '';
    try { img = decodePng(fs.readFileSync(dest)); } catch (e) { err = String(e.message ?? e); }
    clause(A, 'png-written-and-painted', r.code === 0 && !!img && img.w >= 300 && img.h >= 200 && inkPx(img) > 400, `${show(r)} → ${img ? `${img.w}x${img.h}, ${inkPx(img)} ink px` : `unreadable: ${err}`}`);
    const ref = await ctx.o1.send('Page.captureScreenshot', { format: 'png' });
    const refImg = decodePng(Buffer.from(ref.data, 'base64'));
    clause(A, 'matches-the-oracles-own-capture-size', !!img && Math.abs(img.w - refImg.w) <= 2 && Math.abs(img.h - refImg.h) <= 2, `CLI shot ${img?.w}x${img?.h} vs oracle capture of the same view ${refImg.w}x${refImg.h}`);
    if (img) saveShot('cli-screenshot.png', fs.readFileSync(dest));
    // a RELATIVE path must land in the agent's cwd (the daemon is the host's: its cwd is the app's)
    const rel = await cli(ctx, W1, ['screenshot', 'rel-shot.png']);
    const inCwd = path.join(ctx.world.fakeHome, 'rel-shot.png'), inApp = path.join(APP_DIR, 'rel-shot.png');
    clause(A, 'relative-path-lands-in-the-agents-cwd', rel.code === 0 && fs.existsSync(inCwd) && !fs.existsSync(inApp), `${show(rel)} → ${inCwd} ${fs.existsSync(inCwd) ? 'exists' : 'MISSING'}; ${inApp} ${fs.existsSync(inApp) ? 'EXISTS (wrong: the host\'s cwd)' : 'absent'}`);
    fs.rmSync(inApp, { force: true });
    // #399 parity rig G1: a value-taking flag BEFORE the path must not steal it, and the = form must not leak a file named after the flag into the host's cwd
    const fmt = await cli(ctx, W1, ['screenshot', '--screenshot-format=jpeg', '--screenshot-quality=30', 'fmt-shot.jpg']);
    const fmtFile = path.join(ctx.world.fakeHome, 'fmt-shot.jpg');
    const magic = fs.existsSync(fmtFile) ? fs.readFileSync(fmtFile).subarray(0, 2) : null;
    const leaked = fs.readdirSync(APP_DIR).filter((n) => n.startsWith('--screenshot'));
    clause(A, 'value-flags-before-the-path-keep-the-path', fmt.code === 0 && !!magic && magic[0] === 0xff && magic[1] === 0xd8 && leaked.length === 0, `${show(fmt)} → ${fmtFile} ${magic ? `starts ${magic.toString('hex')} (jpeg = ffd8)` : 'MISSING'}; files named --screenshot* in the host cwd: ${leaked.length ? leaked.join(',') : 'none'}`);
    for (const n of leaked) fs.rmSync(path.join(APP_DIR, n), { force: true });
  },
};


/** Raw HTTP to the proxy with full control of Host / Origin (a browser page or a DNS-rebinding page would send these). */
function rawGet(port, pathname, headers = {}) {
  return new Promise((resolve, reject) => {
    const req = http.request({ host: '127.0.0.1', port, path: pathname, method: 'GET', headers }, (res) => { let d = ''; res.on('data', (c) => (d += c)); res.on('end', () => resolve({ status: res.statusCode, body: d })); });
    req.on('error', reject); req.end();
  });
}
function wsTry(url, headers = {}) {
  return new Promise((resolve) => {
    const ws = new WS(url, { headers });
    const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ opened: false, error: 'timeout' }); }, 8000);
    ws.on('unexpected-response', (_q, res) => { clearTimeout(t); resolve({ opened: false, status: res.statusCode }); });
    ws.on('error', (e) => { clearTimeout(t); resolve({ opened: false, error: String(e.message ?? e) }); });
    ws.on('open', () => {
      ws.send(JSON.stringify({ id: 1, method: 'Browser.getVersion' }));
      ws.once('message', (d) => { clearTimeout(t); const m = JSON.parse(String(d)); ws.close(); resolve({ opened: true, version: m.result?.protocolVersion }); });
    });
  });
}
const daemonPids = (ctx) => { const l = abLayout(ctx.world.ohome, process.env.XDG_RUNTIME_DIR); const dir = path.join(l.socketDir, 'namespaces', 'orchestra', 'run'); const out = {}; try { for (const f of fs.readdirSync(dir)) if (f.endsWith('.pid')) out[f.slice(0, -4)] = Number(fs.readFileSync(path.join(dir, f), 'utf8').trim()); } catch {} return out; };
const alive = (pid) => { try { process.kill(pid, 0); return true; } catch { return false; } };
const environOf = (pid) => { try { return fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0').filter(Boolean); } catch { return null; } };
const ppidOf = (pid) => { try { return Number(fs.readFileSync(`/proc/${pid}/stat`, 'utf8').split(') ')[1].split(' ')[1]); } catch { return null; } };

const ARM_FNS2 = {
  async 'loopback-guard'(ctx) {
    const { W1 } = ctx; const A = 'loopback-guard';
    const ep = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const u = new URL(ep.wsUrl); const port = Number(u.port); const token = u.pathname.split('/')[1];
    const good = await rawGet(port, `/${token}/json/version`, { Host: `127.0.0.1:${port}` });
    let gj = null; try { gj = JSON.parse(good.body); } catch {}
    clause(A, 'ctl/valid-request-served', ep.ok === true && good.status === 200 && typeof gj?.webSocketDebuggerUrl === 'string' && gj.webSocketDebuggerUrl.startsWith(`ws://127.0.0.1:${port}/${token}/devtools/browser/`), `host route ok=${ep.ok}; GET /<token>/json/version → ${good.status} ${good.body.replace(/\s+/g, ' ').slice(0, 160)}`);
    const ws0 = await wsTry(ep.wsUrl);
    clause(A, 'ctl/valid-websocket-served', ws0.opened === true && ws0.version === '1.3', `WebSocket to the proxy without Origin: ${JSON.stringify(ws0)}`);
    const org = await rawGet(port, `/${token}/json/version`, { Host: `127.0.0.1:${port}`, Origin: 'http://evil.example' });
    clause(A, 'origin-header-refused', org.status === 403 && /origin-present/.test(org.body), `GET with Origin: http://evil.example → ${org.status} ${JSON.stringify(org.body)}`);
    const wsOrg = await wsTry(ep.wsUrl, { Origin: 'http://evil.example' });
    clause(A, 'origin-websocket-refused', wsOrg.opened === false && wsOrg.status === 403, `WebSocket upgrade with Origin → ${JSON.stringify(wsOrg)}`);
    const rebind = await rawGet(port, `/${token}/json/version`, { Host: `evil.example:${port}` });
    clause(A, 'foreign-host-refused', rebind.status === 403 && /host-not-loopback/.test(rebind.body), `GET with Host: evil.example:${port} (DNS rebinding) → ${rebind.status} ${JSON.stringify(rebind.body)}`);
    const wrongPort = await rawGet(port, `/${token}/json/version`, { Host: `127.0.0.1:${port + 1}` });
    clause(A, 'wrong-port-host-refused', wrongPort.status === 403 && /host-port-mismatch/.test(wrongPort.body), `GET with Host 127.0.0.1:${port + 1} → ${wrongPort.status} ${JSON.stringify(wrongPort.body)}`);
    const notoken = await rawGet(port, `/json/version`, { Host: `127.0.0.1:${port}` });
    const badtoken = await rawGet(port, `/${'x'.repeat(token.length)}/json/version`, { Host: `127.0.0.1:${port}` });
    clause(A, 'missing-or-wrong-token-refused', notoken.status === 404 && badtoken.status === 404, `no token → ${notoken.status}; wrong token → ${badtoken.status} (a same-uid process scanning loopback ports learns nothing)`);
  },

  async 'cross-workspace'(ctx) {
    const { W1, W2, FIX } = ctx; const A = 'cross-workspace';
    const own = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const own2 = await hostCall(ctx, '/browser', { id: W2.id, key: W2.key });
    clause(A, 'ctl/each-workspace-gets-its-own-endpoint', own.ok === true && own2.ok === true && own.wsUrl !== own2.wsUrl && own.env.AGENT_BROWSER_SESSION !== own2.env.AGENT_BROWSER_SESSION, `W1 ${own.wsUrl?.slice(0, 40)}… session ${own.env?.AGENT_BROWSER_SESSION}; W2 ${own2.wsUrl?.slice(0, 40)}… session ${own2.env?.AGENT_BROWSER_SESSION}`);
    const swapped = await hostCall(ctx, '/browser', { id: W1.id, key: W2.key });
    clause(A, 'host-refuses-another-workspaces-key', swapped.ok === false && swapped.code === 'superseded' && !swapped.wsUrl, `{id: W1, key: W2's} → ${JSON.stringify(swapped).slice(0, 200)}`);
    const nokey = await hostCall(ctx, '/browser', { id: W1.id });
    const ghost = await hostCall(ctx, '/browser', { id: 'ws-ghost', key: W1.key });
    clause(A, 'host-refuses-no-key-and-unknown-workspace', nokey.ok === false && ghost.ok === false && !nokey.wsUrl && !ghost.wsUrl, `no key → ${JSON.stringify(nokey).slice(0, 110)}; unknown id → ${JSON.stringify(ghost).slice(0, 110)}`);
    const cliSwap = await cli(ctx, W1, ['get', 'url'], { key: W2.key });
    clause(A, 'cli-with-another-workspaces-key-is-refused', cliSwap.code !== 0 && /replaced|vouch|session/.test(cliSwap.stderr) && cliSwap.stdout.trim() === '', show(cliSwap));
    await cli(ctx, W1, ['open', `${FIX}/cli.html`]);
    const g1 = await cli(ctx, W1, ['get', 'url']); const g2 = await cli(ctx, W2, ['get', 'url']);
    clause(A, 'each-cli-reaches-only-its-own-panel', g1.stdout.trim() === `${FIX}/cli.html` && g2.stdout.trim() === `${FIX}/index.html`, `W1 get url → ${g1.stdout.trim()}; W2 get url → ${g2.stdout.trim()}`);
    // the agent's own env cannot re-point the client at a sibling's daemon / proxy — nor drag the sibling's daemon onto ITS panel
    const sess2 = own2.env.AGENT_BROWSER_SESSION;
    const attempts = [
      { AGENT_BROWSER_SESSION: sess2 },
      { AGENT_BROWSER_CDP: own2.wsUrl },
      { AGENT_BROWSER_SESSION: sess2, AGENT_BROWSER_CDP: own2.wsUrl, AGENT_BROWSER_NAMESPACE: 'elsewhere', AGENT_BROWSER_SOCKET_DIR: path.join(ctx.world.fakeHome, 'elsewhere') },
      // the client follows each call's own --cdp, so a leaked SESSION alone re-points nothing: the observable proof of a leak is a setting the host never sets
      { AGENT_BROWSER_JSON: '1', AGENT_BROWSER_MAX_OUTPUT: '3' },
    ];
    const outs = [];
    for (const extra of attempts) { const r = await cli(ctx, W1, ['get', 'url'], { env: extra }); outs.push(r.stdout.trim()); }
    const w2after = await cli(ctx, W2, ['get', 'url']);
    clause(A, 'caller-agent-browser-env-is-scrubbed', outs.every((o) => o === `${FIX}/cli.html`) && w2after.stdout.trim() === `${FIX}/index.html`,
      `W1 with AGENT_BROWSER_SESSION=<W2's> / _CDP=<W2's> / all four pointing elsewhere / _JSON=1 + _MAX_OUTPUT=3 (a leak would print JSON or htt) → ${JSON.stringify(outs)}; W2's own panel afterwards → ${w2after.stdout.trim()} (a leaked env would re-point W2's daemon at W1's panel)`);
    const f1 = await cli(ctx, W1, ['get', 'url', '--session', own2.env.AGENT_BROWSER_SESSION]);
    const f2 = await cli(ctx, W1, ['get', 'url', '--cdp', own2.wsUrl]);
    const f3 = await cli(ctx, W1, ['--session', own2.env.AGENT_BROWSER_SESSION, 'get', 'url']);
    const f4 = await cli(ctx, W1, ['get', 'url', '--', '--session', own2.env.AGENT_BROWSER_SESSION]);
    clause(A, 'session-and-cdp-flags-refused', f1.code !== 0 && f2.code !== 0 && f3.code !== 0 && f4.code !== 0 && /--session is not allowed/.test(f1.stderr) && /--cdp is not allowed/.test(f2.stderr) && /put the command first/.test(f3.stderr) && /--session is not allowed/.test(f4.stderr) && [f1, f2, f3, f4].every((r) => r.stdout.trim() === ''),
      `after the command: --session → ${show(f1)}; --cdp → ${show(f2)}; leading --session → ${show(f3)}; after \`--\` → ${show(f4)}`);
  },

  async background(ctx) {
    const { W1, W2 } = ctx; const A = 'background';
    await selectWs(ctx, W1); // W1 is the focused workspace with its pane open; W2's panel exists but is not composited
    const snap = await cli(ctx, W2, ['snapshot', '-i']);
    const link = refOf(snap.stdout, 'link', 'CLI page');
    clause(A, 'ctl/background-workspace-can-read', snap.code === 0 && !!link, `W2 (not on screen) snapshot: ${show(snap)}`);
    const shot = await cli(ctx, W2, ['screenshot', path.join(ctx.world.fakeHome, 'bg.png')], { timeoutMs: 45000 });
    clause(A, 'screenshot-fails-fast-with-the-reason', shot.code !== 0 && shot.ms < 9000 && /Browser pane is not on screen/.test(shot.stderr), show(shot));
    const click = await cli(ctx, W2, ['click', link], { timeoutMs: 45000 });
    clause(A, 'click-fails-fast-nothing-dispatched', click.code !== 0 && click.ms < 9000 && /not on screen|outside the viewport/.test(click.stderr), show(click));
    const still = await ctx.o2.eval(`location.pathname`);
    clause(A, 'ctl/nothing-was-clicked', still === '/index.html', `W2's page is still ${still} (the refused click was not dispatched or queued)`);
  },

  async 'daemon-host-owned'(ctx) {
    const { W1, W2 } = ctx; const A = 'daemon-host-owned';
    const pids = daemonPids(ctx); const l = abLayout(ctx.world.ohome, process.env.XDG_RUNTIME_DIR);
    const entries = Object.entries(pids);
    clause(A, 'ctl/two-workspaces-two-daemons', entries.length === 2 && entries.every(([, p]) => alive(p)), `daemons: ${JSON.stringify(pids)}`);
    for (const [session, pid] of entries) {
      const env = environOf(pid) ?? [];
      const has = (k, v) => env.includes(`${k}=${v}`);
      const keys = env.filter((e) => /^(ORCHESTRA_SESSION_KEY|ORCHESTRA_WS_ID|ANTHROPIC)/.test(e));
      clause(A, `daemon-${session}-runs-with-the-host-env-only`, has('AGENT_BROWSER_SESSION', session) && has('AGENT_BROWSER_SOCKET_DIR', l.socketDir) && has('HOME', l.home) && keys.length === 0 && !env.some((e) => e.startsWith('PATH=')),
        `pid ${pid}: SESSION/SOCKET_DIR/HOME are the host's, no ORCHESTRA_*/ANTHROPIC secrets, no inherited PATH (the daemon was started by the host's \`connect\`, not by an agent's client); env keys: ${env.map((e) => e.split('=')[0]).join(',')}`);
      clause(A, `daemon-${session}-is-not-a-cli-child`, ppidOf(pid) !== process.pid, `ppid ${ppidOf(pid)} (rig pid ${process.pid})`);
    }
    // pre-review M2: the token-bearing proxy URL is in NO process's argv (/proc/<pid>/cmdline is world-readable here; environ is 0400) while a client call runs
    const own = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const token = new URL(own.wsUrl).pathname.split('/')[1];
    const scan = () => fs.readdirSync('/proc').filter((n) => /^\d+$/.test(n)).filter((n) => { try { return fs.readFileSync(`/proc/${n}/cmdline`, 'utf8').includes(token); } catch { return false; } });
    const ctlProc = spawn(process.execPath, ['-e', 'setTimeout(() => {}, 4000)', token], { stdio: 'ignore' }); // positive control: the scan CAN see a token in an argv
    const during = cli(ctx, W1, ['wait', '1500']);
    await sleep(600);
    const seen = scan();
    await during;
    const ctlPid = String(ctlProc.pid);
    try { ctlProc.kill('SIGKILL'); } catch {}
    clause(A, 'ctl/scan-sees-a-token-in-an-argv', seen.includes(ctlPid), `scanning /proc/*/cmdline for the proxy token found pid(s) ${seen.join(',') || 'none'}; the planted control process is ${ctlPid}`);
    clause(A, 'token-in-no-cmdline-while-a-call-runs', seen.filter((n) => n !== ctlPid).length === 0, `during \`orchestra browser wait 1500\` no process other than the planted control carries the token in its argv: ${seen.filter((n) => n !== ctlPid).join(',') || 'none'}`);
  },

  async allowlist(ctx) {
    const { W1 } = ctx; const A = 'allowlist';
    const before = sockets(ctx).length;
    const cases = [['profiles'], ['--session', 'x', 'get', 'url'], ['connect', 'ws://127.0.0.1:1/x'], ['plugin', 'list'], ['batch', 'get url'], ['frobnicate'],
      // verified bypasses of an earlier planner (pre-review B2): a flag after `--`, and a leading value-taking option that shifts the command
      ['get', 'url', '--', '--session', 'x'], ['session', '--', '--session', 'x'], ['--screenshot-dir', 'open', 'session', 'info'],
      // pre-review M3: a known value flag is split and its VALUE is then judged (`--x=--cdp`), judged on the final argv
      ['snapshot', '--screenshot-format=--cdp', '9222']];
    const outs = [];
    for (const args of cases) { const r = await cli(ctx, W1, args, { timeoutMs: 20000 }); outs.push({ args: args.join(' '), r }); }
    const refused = outs.every(({ r }) => r.code !== 0 && /not available|not allowed|unknown command|put the command first/.test(r.stderr) && r.stdout.trim() === '');
    clause(A, 'out-of-scope-commands-and-flags-refused', refused, outs.map(({ args, r }) => `[${args}] rc=${r.code} ${JSON.stringify(r.stderr.trim().slice(0, 70))}`).join(' · '));
    // seam review m1: a command smuggled inside Target.sendMessageToTarget would pass every per-method policy; both tunnels are refused outright
    const ep1 = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const tun = await rawCdpOnProxy(ep1.wsUrl, [
      { method: 'Target.sendMessageToTarget', params: { message: JSON.stringify({ id: 1, method: 'Runtime.evaluate', params: { expression: 'document.title' } }) } },
      { method: 'Target.exposeDevToolsProtocol', params: { targetId: 'x', bindingName: 'cdp' } },
      { method: 'Runtime.evaluate', params: { expression: '1+1', returnByValue: true } },
    ]);
    clause(A, 'raw-cdp-tunnels-refused-normal-commands-pass', tun.replies.length === 3 && /flattened sessions only/.test(tun.replies[0]) && /flattened sessions only/.test(tun.replies[1]) && /"value":2/.test(tun.replies[2]), `sendMessageToTarget → ${tun.replies[0]}; exposeDevToolsProtocol → ${tun.replies[1]}; a plain Runtime.evaluate → ${tun.replies[2]}${tun.error ? ` (error ${tun.error})` : ''}`);
    const after = sockets(ctx).length;
    clause(A, 'refusal-happens-before-the-host', before === after, `daemon sockets ${before} → ${after} (a refused command never reached the host or spawned a client)`);
    // seam review m2: `get cdp-url` would print the token-bearing endpoint (raw CDP for any shell step, past the allowlist): refused before the host
    const own0 = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const tok0 = new URL(own0.wsUrl).pathname.split('/')[1];
    const cu = await cli(ctx, W1, ['get', 'cdp-url']);
    const cuJson = await cli(ctx, W1, ['--json', 'get', 'cdp-url']);
    const cuShift = await cli(ctx, W1, ['get', '--max-output', '100', 'cdp-url']); // final-tip review m5: a value flag shifts the sub-command position
    const cuTail = await cli(ctx, W1, ['get', 'cdp-url', '--json']);
    clause(A, 'get-cdp-url-refused-and-endpoint-never-printed', [cu, cuJson, cuShift, cuTail].every((r) => r.code !== 0 && /get cdp-url/.test(r.stderr)) && ![cu, cuJson, cuShift, cuTail].some((r) => r.stdout.includes(tok0) || r.stderr.includes(tok0)), `${show(cu)}; --json → ${show(cuJson)}; shifted by --max-output → ${show(cuShift)}; trailing --json → ${show(cuTail)}; the token appears in none of the outputs: ${![cu, cuJson, cuShift, cuTail].some((r) => r.stdout.includes(tok0) || r.stderr.includes(tok0))}`);
    const ok = await cli(ctx, W1, ['get', 'url']);
    clause(A, 'ctl/allowed-command-passes', ok.code === 0 && /^http/.test(ok.stdout.trim()), show(ok));
  },

  async 'destroy-closes-daemon'(ctx) {
    const { W2, ui } = ctx; const A = 'destroy-closes-daemon';
    const own = await hostCall(ctx, '/browser', { id: W2.id, key: W2.key });
    const u = new URL(own.wsUrl); const port = Number(u.port); const session = own.env.AGENT_BROWSER_SESSION;
    const pid = daemonPids(ctx)[session];
    clause(A, 'ctl/daemon-and-proxy-up-before', alive(pid) && (await wsTry(own.wsUrl)).opened === true, `daemon pid ${pid} alive, proxy 127.0.0.1:${port} serving`);
    await ui.eval(`window.orchestra.archiveWorkspace(${sel(W2.id)}).then(() => true)`);
    await waitFor(() => !alive(pid), 15000, 'the archived workspace\'s daemon to exit').catch(() => {});
    const dead = !alive(pid);
    const refused = await new Promise((resolve) => { const sck = net.connect(port, '127.0.0.1'); sck.on('connect', () => { sck.destroy(); resolve(false); }); sck.on('error', () => resolve(true)); });
    clause(A, 'archive-closes-daemon-and-proxy', dead && refused && !sockets(ctx).includes(session), `after archiving ${W2.branch}: daemon ${pid} ${dead ? 'exited' : 'STILL ALIVE'}, proxy port ${refused ? 'closed' : 'STILL OPEN'}, socket ${sockets(ctx).includes(session) ? 'still listed' : 'gone'}`);
    const late = await hostCall(ctx, '/browser', { id: W2.id, key: W2.key });
    const bw = (await ctx.targets()).filter((t) => t.type === 'page' && t.url.startsWith(`${ctx.FIX}/index.html`)).length;
    clause(A, 'late-call-for-an-archived-workspace-is-refused', late.ok === false && /archived/.test(late.error ?? '') && sockets(ctx).length === 1, `/browser as the archived ${W2.branch} → ${JSON.stringify(late).slice(0, 140)}; daemon sockets left: ${sockets(ctx).length} (no panel, proxy or daemon is resurrected)`);
  },
};
Object.assign(ARM_FNS, ARM_FNS2);


/** One-shot raw CDP client on the proxy: attach to the page target whose url matches (flatten) and send Page.bringToFront on that session. */
function bringToFrontViaProxy(wsUrl, urlRe) {
  return new Promise((resolve) => {
    const ws = new WS(wsUrl);
    let nextId = 0, sid = null;
    const send = (method, params, sessionId) => ws.send(JSON.stringify({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ reply: 'timeout' }); }, 10000);
    ws.on('error', (e) => { clearTimeout(t); resolve({ reply: `error ${e.message}` }); });
    ws.on('open', () => send('Target.getTargets'));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.error && m.id !== 3) { clearTimeout(t); ws.close(); return resolve({ reply: `error ${JSON.stringify(m.error)}` }); } // e.g. a mutant that breaks the attach: a RED clause, never a crashed driver
        if (m.id === 1) send('Target.attachToTarget', { targetId: (m.result.targetInfos.find((i) => urlRe.test(i.url)) ?? m.result.targetInfos[0]).targetId, flatten: true });
        else if (m.id === 2) { sid = m.result.sessionId; send('Page.bringToFront', {}, sid); }
        else if (m.id === 3) { clearTimeout(t); ws.close(); resolve({ reply: JSON.stringify(m.result ?? m.error) }); }
      } catch (e) { clearTimeout(t); try { ws.close(); } catch {} resolve({ reply: `driver error ${e.message}` }); }
    });
  });
}

/** Raw CDP on the proxy: attach (flatten) to the first page and send `calls` on that session; returns each reply as text. */
function rawCdpOnProxy(wsUrl, calls) {
  return new Promise((resolve) => {
    const ws = new WS(wsUrl);
    const replies = []; let nextId = 0, sid = null, i = 0;
    const send = (method, params, sessionId) => ws.send(JSON.stringify({ id: ++nextId, method, params, ...(sessionId ? { sessionId } : {}) }));
    const t = setTimeout(() => { try { ws.terminate(); } catch {} resolve({ replies, timeout: true }); }, 12000);
    ws.on('error', (e) => { clearTimeout(t); resolve({ replies, error: e.message }); });
    ws.on('open', () => send('Target.getTargets'));
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.method || m.id === undefined) return;
        if (m.id === 1) send('Target.attachToTarget', { targetId: m.result.targetInfos[0].targetId, flatten: true });
        else if (m.id === 2) { sid = m.result.sessionId; send(calls[i].method, calls[i].params, sid); }
        else { replies.push(JSON.stringify(m.error ?? m.result)); i++; if (i < calls.length) send(calls[i].method, calls[i].params, sid); else { clearTimeout(t); ws.close(); resolve({ replies }); } }
      } catch (e) { clearTimeout(t); try { ws.close(); } catch {} resolve({ replies, error: e.message }); }
    });
  });
}

/** Raw CDP on the proxy: attach (flatten) to the page whose url matches, turn auto-attach on, let `spawn()` create a worker, wait for its CHILD session, then
 *  send `calls` on the ROOT session and on the CHILD session; returns both reply lists. */
function childSessionProbe(wsUrl, urlRe, spawn, calls) {
  return new Promise((resolve) => {
    const ws = new WS(wsUrl);
    const out = { rootReplies: [], childReplies: [], childType: null, error: null };
    let nextId = 0, root = null, child = null, pageTarget = null;
    const pending = new Map();
    const send = (method, params, sessionId) => new Promise((res) => { const id = ++nextId; pending.set(id, res); ws.send(JSON.stringify({ id, method, params, ...(sessionId ? { sessionId } : {}) })); });
    const t = setTimeout(() => { out.error = out.error ?? 'timeout'; try { ws.terminate(); } catch {} resolve(out); }, 25000);
    const finish = () => { clearTimeout(t); try { ws.close(); } catch {} resolve(out); };
    let childWaiter = null;
    ws.on('error', (e) => { out.error = e.message; finish(); });
    ws.on('message', (d) => {
      try {
        const m = JSON.parse(String(d));
        if (m.id !== undefined && pending.has(m.id)) { const r = pending.get(m.id); pending.delete(m.id); r(m); return; }
        if (m.method === 'Target.attachedToTarget' && m.params?.sessionId && m.params.sessionId !== root && m.params?.targetInfo?.type !== 'page') { child = m.params.sessionId; out.childType = m.params.targetInfo?.type ?? null; childWaiter?.(); }
      } catch (e) { out.error = e.message; finish(); }
    });
    ws.on('open', async () => {
      try {
        const targets = (await send('Target.getTargets')).result.targetInfos;
        const pg = targets.find((i) => urlRe.test(i.url)) ?? targets[0];
        pageTarget = pg.targetId;
        root = (await send('Target.attachToTarget', { targetId: pg.targetId, flatten: true })).result.sessionId;
        await send('Target.setAutoAttach', { autoAttach: true, flatten: true, waitForDebuggerOnStart: false }, root);
        const got = new Promise((r) => { childWaiter = r; });
        await spawn();
        await Promise.race([got, new Promise((r) => setTimeout(r, 8000))]);
        if (!child) { out.error = 'no child session was auto-attached'; return finish(); }
        const run = async (sid, list) => { for (const [method, params] of calls(pageTarget)) { const r = await send(method, params, sid); list.push(`${method}: ${JSON.stringify(r.error ?? r.result).slice(0, 110)}`); } };
        await run(root, out.rootReplies);
        await run(child, out.childReplies);
        finish();
      } catch (e) { out.error = e.message; finish(); }
    });
  });
}

const ARM_FNS3 = {
  async breadth(ctx) {
    // The surface the ticket names beyond click/fill/upload/dialog: type, press, wait, scroll, hover, console, network, cookies, storage, eval.
    const { W1, FIX } = ctx; const A = 'breadth';
    const open = await cli(ctx, W1, ['open', `${FIX}/cli-keys.html`]);
    const o = await oracle(ctx, `${FIX}/cli-keys.html`);
    try {
      const w = await cli(ctx, W1, ['wait', '#late']);
      clause(A, 'wait-for-selector-waits', open.code === 0 && w.code === 0 && w.ms >= 250 && (await o.eval(`!!document.getElementById('late')`)), `${show(w)} (the element is inserted 900 ms after load; the oracle sees it)`);
      const snap = await cli(ctx, W1, ['snapshot', '-i']);
      const box = refOf(snap.stdout, 'textbox', 'keys') ?? refOf(snap.stdout, 'textbox', ''); const hov = refOf(snap.stdout, 'button', 'hover me');
      const ty = await cli(ctx, W1, ['type', box, 'abc']);
      const v = await o.eval(`document.getElementById('k').value`);
      clause(A, 'type-into-element', ty.code === 0 && v === 'abc', `${show(ty)} → oracle value=${JSON.stringify(v)}`);
      const pr = await cli(ctx, W1, ['press', 'Enter']);
      const keys = await o.eval(`document.getElementById('keys').textContent`);
      clause(A, 'press-key', pr.code === 0 && /Enter,/.test(keys), `${show(pr)} → oracle keydown log=${JSON.stringify(keys)}`);
      const hv = await cli(ctx, W1, ['hover', hov]);
      clause(A, 'hover', hv.code === 0 && (await o.eval(`document.getElementById('hov').dataset.h`)) === '1', `${show(hv)}`);
      const sc = await cli(ctx, W1, ['scroll', 'down', '400']);
      const y = await o.eval(`Math.round(window.scrollY)`);
      clause(A, 'scroll', sc.code === 0 && y >= 300, `${show(sc)} → oracle scrollY=${y}`);
      await cli(ctx, W1, ['eval', "console.log('b395-console-x')"]);
      const con = await cli(ctx, W1, ['console']);
      clause(A, 'console-messages', con.code === 0 && /b395-console-x/.test(con.stdout), show(con));
      await cli(ctx, W1, ['eval', "fetch('/whoami').then(r => r.text())"]);
      const net = await cli(ctx, W1, ['network', 'requests']);
      clause(A, 'network-requests', net.code === 0 && /\/whoami/.test(net.stdout), show(net));
      const ck = await cli(ctx, W1, ['cookies', 'set', 'sid', 'b395cookie', '--url', FIX]);
      const who = await o.eval(`fetch('/whoami').then((r) => r.text())`);
      const ckg = await cli(ctx, W1, ['cookies', 'get']);
      clause(A, 'cookies-set-and-get', ck.code === 0 && who === 'b395cookie' && /sid=b395cookie/.test(ckg.stdout), `set ${show(ck)} → the fixture server sees sid=${who}; get → ${JSON.stringify(ckg.stdout.trim().slice(0, 80))}`);
      const st = await cli(ctx, W1, ['storage', 'local', 'set', 'b395k', 'b395v']);
      const sv = await o.eval(`localStorage.getItem('b395k')`);
      const sg = await cli(ctx, W1, ['storage', 'local', 'get', 'b395k']);
      clause(A, 'storage-set-and-get', st.code === 0 && sv === 'b395v' && /b395v/.test(sg.stdout), `${show(st)} → oracle localStorage=${JSON.stringify(sv)}; get → ${JSON.stringify(sg.stdout.trim())}`);
      await o.eval(`localStorage.removeItem('b395k')`);
      await cli(ctx, W1, ['open', `${FIX}/cli.html`]); // leave the form page for later arms
    } finally { o.close(); }
  },

  async tabs(ctx) {
    // Story 36/37: list, open and close tabs; an agent closes the tabs it opened and NEVER the human's. The REGISTRY (read over the app's own IPC) is the
    // truth: agent-browser v0.39.2 prints "closed" even when the proxy refused (it swallows the Target.closeTarget error).
    const { W1, FIX, ui } = ctx; const A = 'tabs';
    const reg = async () => (await ui.eval(`window.orchestra.browserState(${sel(W1.id)})`)).tabs;
    const labelOf = (list, re) => (list.stdout.split('\n').find((l) => re.test(l)) ?? '').match(/\[(t\d+)\]/)?.[1];
    const openOwn = async () => {
      const nw = await cli(ctx, W1, ['tab', 'new', `${FIX}/index.html`]);
      await waitFor(async () => (await reg()).some((t) => t.openedBy === 'agent' && /\/index\.html$/.test(t.url)), 10000, 'the new tab to load /index.html').catch(() => {});
      return nw;
    };
    const before = await reg();
    const human = before.find((t) => t.openedBy === 'human');
    clause(A, 'ctl/one-human-tab-to-start', before.length === 1 && !!human, `registry tabs: ${JSON.stringify(before.map((t) => [t.id, t.openedBy, t.url]))}`);
    const nw = await openOwn();
    const after = await reg();
    const mine = after.find((t) => t.openedBy === 'agent');
    clause(A, 'tab-new-creates-a-loaded-agent-tab', nw.code === 0 && after.length === 2 && !!mine && mine.active === true && /\/index\.html$/.test(mine.url), `${show(nw)} → registry ${JSON.stringify(after.map((t) => [t.id, t.openedBy, t.active, t.url.slice(-12)]))}`);
    const list = await cli(ctx, W1, ['tab', 'list']);
    clause(A, 'tab-list-shows-both', list.code === 0 && list.stdout.split('\n').filter((l) => /\[t\d+\]/.test(l)).length === 2 && /cli\.html/.test(list.stdout) && /index\.html/.test(list.stdout), show(list));
    const fT0 = await focusComposer(ctx);
    const humanLabel0 = labelOf(list, /\/cli\.html/);
    const sw = await cli(ctx, W1, ['tab', humanLabel0 ?? 't1']);
    const fT1 = await composerFocus(ctx);
    clause(A, 'tab-switch-does-not-steal-keyboard-focus', sw.code === 0 && fT0?.onComposer === true && fT1?.onComposer === true && fT1?.windowFocus === true, `tab ${humanLabel0}: ${show(sw)} → composer focus before ${JSON.stringify(fT0)}, after ${JSON.stringify(fT1)} (Page.bringToFront / Target.activateTarget never take OS focus)`);
    // Page.bringToFront straight to the proxy (agent-browser does not send it in the flows driven here): it must activate the tab, answer {}, and never take the human's focus
    await cli(ctx, W1, ['tab', labelOf(list, /\/index\.html/) ?? 't2']); // make the agent's tab the active one first
    const ep = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
    const fB0 = await focusComposer(ctx);
    const activeBefore = (await reg()).find((t) => t.active)?.id;
    const btf = await bringToFrontViaProxy(ep.wsUrl, /\/cli\.html/); // the HUMAN's tab, while the agent's new tab is the active one
    const fB1 = await composerFocus(ctx);
    const activeAfter = (await reg()).find((t) => t.active)?.id;
    clause(A, 'page-bringtofront-activates-the-tab-and-keeps-keyboard-focus', btf.reply === '{}' && activeBefore !== human.id && activeAfter === human.id && fB0?.onComposer === true && fB1?.onComposer === true && fB1?.windowFocus === true,
      `Page.bringToFront on the human tab's session → ${btf.reply}; active tab ${activeBefore} → ${activeAfter}; composer focus before ${JSON.stringify(fB0)}, after ${JSON.stringify(fB1)} (measured: forwarding it to Electron's debugger neither activates the tab nor moves focus)`);
    const myLabel = labelOf(list, /\/index\.html/);
    const closeMine = await cli(ctx, W1, ['tab', 'close', myLabel ?? 't0']);
    await waitFor(async () => (await reg()).length === 1, 8000, 'the agent tab to leave the registry').catch(() => {});
    const end = await reg();
    clause(A, 'agent-closes-its-own-tab', closeMine.code === 0 && end.length === 1 && end[0].id === human.id && end[0].active, `tab close ${myLabel}: ${show(closeMine)} → registry ${JSON.stringify(end.map((t) => [t.id, t.openedBy, t.active]))}`);
    const ok = await cli(ctx, W1, ['get', 'url']);
    clause(A, 'human-tab-drivable-after', ok.code === 0 && /cli\.html$/.test(ok.stdout.trim()), show(ok));
    // now try to close the HUMAN's tab while an agent tab exists
    await openOwn();
    const list2 = await cli(ctx, W1, ['tab', 'list']);
    const humanLabel = labelOf(list2, /\/cli\.html/);
    const closeHuman = await cli(ctx, W1, ['tab', 'close', humanLabel ?? 't0']);
    await sleep(500);
    const still = await reg();
    clause(A, 'agent-cannot-close-the-humans-tab', !!humanLabel && still.some((t) => t.id === human.id), `tab close ${humanLabel}: ${show(closeHuman)} → registry still has the human tab: ${still.some((t) => t.id === human.id)} (agent-browser says "closed" regardless; the registry is the truth)`);
  },
};
Object.assign(ARM_FNS, ARM_FNS3);


const ARM_FNS4 = {
  async 'daemon-lifecycle'(ctx) {
    const { W1, FIX } = ctx; const A = 'daemon-lifecycle';
    await cli(ctx, W1, ['open', `${FIX}/cli.html`]);
    const o = await oracle(ctx, `${FIX}/cli.html`);
    try {
      const own = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
      const session = own.env.AGENT_BROWSER_SESSION;
      const width0 = await o.eval(`window.innerWidth`);
      const sv = await cli(ctx, W1, ['set', 'viewport', '360', '640']);
      const width1 = await o.eval(`window.innerWidth`);
      clause(A, 'ctl/set-viewport-takes-effect', sv.code === 0 && width1 === 360 && width0 !== 360, `${show(sv)} → oracle innerWidth ${width0} → ${width1}`);
      await sleep(3500); // longer than the release grace (1.5 s): while the agent's daemon is connected, its override must NOT be reset
      const width2 = await o.eval(`window.innerWidth`);
      clause(A, 'override-kept-while-the-daemon-is-connected', width2 === 360, `3.5 s after set viewport (grace 1.5 s) the oracle still sees innerWidth ${width2} (a spurious reset would undo the agent's own work)`);
      // the agent's daemon goes away (idle exit, crash, quit): its Emulation override must not stay on the human's tab
      const pid1 = daemonPids(ctx)[session];
      try { process.kill(pid1, 'SIGKILL'); } catch {}
      await waitFor(() => !alive(pid1), 5000, 'the daemon to die').catch(() => {});
      const restored = await waitFor(async () => (await o.eval(`window.innerWidth`)) === width0, 8000, 'the viewport override to be cleared').then(() => true, () => false);
      clause(A, 'override-cleared-when-the-daemon-leaves', restored, `daemon ${pid1} killed → oracle innerWidth back to ${await o.eval('window.innerWidth')} (was ${width0}; override ${width1}) — the proxy detaches what it attached when its last session leaves`);
      // the next calls re-start the daemon; several at once must all succeed (single-flight connect)
      const par = await Promise.all([1, 2, 3, 4].map(() => cli(ctx, W1, ['get', 'url'])));
      const pid2 = daemonPids(ctx)[session];
      clause(A, 'parallel-first-calls-after-the-daemon-died-all-succeed', par.every((r) => r.code === 0 && r.stdout.trim() === `${FIX}/cli.html`) && !!pid2 && pid2 !== pid1 && alive(pid2), `4 concurrent calls: rc ${par.map((r) => r.code).join(',')}; new daemon pid ${pid2} (was ${pid1})`);
    } finally { o.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS4);


const ARM_FNS5 = {
  async 'child-session'(ctx) {
    // final-tip review M4: Browser.* / Page.close / Target.closeTarget … on an auto-attached CHILD session (a worker here) must get the same
    // browser-level rules as on the root tab session — close ownership first. Before the fix a child's Page.close reached the debugger.
    const { W1, FIX, ui } = ctx; const A = 'child-session';
    const reg = async () => (await ui.eval(`window.orchestra.browserState(${sel(W1.id)})`)).tabs;
    let o = null;
    try {
      // Precondition: ONLY the human's tab exists (earlier arms leave agent tabs behind, and the probe attaches to the first listed — the ACTIVE — page,
      // which must be the human's: an agent tab is legitimately closable and would make the replies differ for the wrong reason).
      // set up as the HUMAN (the pane's own IPC): the human may close any tab; the CLI could not (and must not) close the others
      for (const t of (await reg()).filter((x) => x.openedBy === 'agent')) await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(t.id)}).then(() => true)`);
      const h0 = (await reg()).find((x) => x.openedBy === 'human'); if (h0 && !h0.active) await ui.eval(`window.orchestra.browserTabActivate(${sel(W1.id)}, ${sel(h0.id)}).then(() => true)`);
      await waitFor(async () => (await reg()).every((t) => t.openedBy === 'human'), 8000, 'only the human tab to remain').catch(() => {});
      const humanId = (await reg()).find((t) => t.openedBy === 'human')?.id;
      clause(A, 'ctl/only-the-humans-tab-exists', (await reg()).length === 1 && !!humanId, `registry: ${JSON.stringify((await reg()).map((t) => [t.id, t.openedBy, t.active]))}`);
      await cli(ctx, W1, ['open', `${FIX}/cli.html`]); // the human's tab, fresh
      o = await oracle(ctx, `${FIX}/cli.html`); // connected AFTER the setup: closing a tab kills an oracle attached to it
      const ep = await hostCall(ctx, '/browser', { id: W1.id, key: W1.key });
      const calls = (pageTarget) => [['Page.close', {}], ['Target.closeTarget', { targetId: pageTarget }], ['Browser.close', {}], ['Browser.grantPermissions', { permissions: ['geolocation'] }]];
      const probe = await childSessionProbe(ep.wsUrl, /\/cli\.html/, () => o.eval(`(() => { window.__w = new Worker(URL.createObjectURL(new Blob(['setInterval(()=>{},1000)']))); return true; })()`), calls);
      clause(A, 'ctl/a-real-child-session-was-auto-attached', !!probe.childType, `Electron auto-attached a child session of type ${probe.childType} (error: ${probe.error ?? 'none'})`);
      clause(A, 'child-session-gets-the-root-sessions-rules', probe.rootReplies.length === 4 && JSON.stringify(probe.childReplies) === JSON.stringify(probe.rootReplies) && /opened by the user/.test(probe.childReplies[0]) && /opened by the user/.test(probe.childReplies[1]) && /Browser\.close: \{\}/.test(probe.childReplies[2]),
        `root: ${probe.rootReplies.join(' | ')} — child: ${probe.childReplies.join(' | ')}`);
      const tabs = await reg();
      clause(A, 'the-humans-tab-is-still-open', tabs.some((t) => t.id === humanId), `registry after the child-session attempts: ${JSON.stringify(tabs.map((t) => [t.id, t.openedBy]))}`);
      const ok = await cli(ctx, W1, ['get', 'url']);
      clause(A, 'ctl/panel-still-drivable', ok.code === 0 && /cli\.html$/.test(ok.stdout.trim()), show(ok));
    } finally { o?.close(); }
  },
};
Object.assign(ARM_FNS, ARM_FNS5);

const ARM_FNS6 = {
  async 'iframe-churn'(ctx) {
    // Cross-site iframes created and removed within 0-25 ms for 3 s on the agent's tab, the agent-browser daemon attached: `get title` must answer DURING and AFTER the churn.
    // Before the fix a child detaching mid-attach left a request unanswered and the daemon stayed wedged (seat-1 `tchurn`, ledger #405). N runs, each in a fresh agent tab.
    const { W1, FIX, ui } = ctx; const A = 'iframe-churn'; const N = Number(flag('--churn-n', 30));
    const reg = async () => (await ui.eval(`window.orchestra.browserState(${sel(W1.id)})`)).tabs;
    const logFile = path.join(ctx.world.ohome, 'logs', 'orchestra.log');
    await selectWs(ctx, W1); await openPane(ctx);
    const rows = [];
    for (let i = 0; i < N; i++) {
      for (const t of (await reg()).filter((x) => x.openedBy === 'agent')) await ui.eval(`window.orchestra.browserTabClose(${sel(W1.id)}, ${sel(t.id)}).then(() => true)`);
      await waitFor(async () => (await reg()).every((t) => t.openedBy === 'human'), 10000, 'only the human tab to remain').catch(() => {});
      let off0 = 0; try { off0 = fs.statSync(logFile).size; } catch {}
      const stamp = async (f) => { const t = Date.now(); const r = await f(); return Object.assign(r, { t0: t, t1: Date.now() }); };
      const nw = await stamp(() => cli(ctx, W1, ['tab', 'new', `${FIX}/iframe-churn.html?i=${i}`], { timeoutMs: 60000 }));
      await waitFor(async () => (await reg()).some((t) => /Churn fixture/.test(t.title)), 15000, 'the churn tab').catch(() => {});
      const sn = await stamp(() => cli(ctx, W1, ['snapshot', '-i'], { timeoutMs: 60000 })); // the daemon is attached from here on
      await sleep(250 + (i % 4) * 400); // inside the 3 s churn
      const gt = await stamp(() => cli(ctx, W1, ['get', 'title'], { timeoutMs: 8000 }));
      await sleep(3200);
      const gt2 = await stamp(() => cli(ctx, W1, ['get', 'title'], { timeoutMs: 8000 }));
      let created = null, churn = null;
      try { const o = await oracle(ctx, `${FIX}/iframe-churn.html`, 5000); try { churn = await o.eval('({ ...window.__churn })'); created = churn.created; } finally { o.close(); } } catch {}
      let slice = ''; try { const size = fs.statSync(logFile).size; const start = size >= off0 ? off0 : 0; const fd = fs.openSync(logFile, 'r'); const buf = Buffer.alloc(Math.min(size - start, 12e6)); fs.readSync(fd, buf, 0, buf.length, start); fs.closeSync(fd); slice = buf.toString('utf8'); } catch {}
      // regex, not JSON.parse: the host truncates each trace line at 400 chars (a long reply would read as "unanswered")
      const reqs = new Map(), answered = new Set(), detachedSids = new Set(); let attachedN = 0, detachedN = 0;
      for (const line of slice.split('\n')) {
        let m;
        if ((m = /client->proxy (\{.*\})\s*$/.exec(line))) { const q = /^\{"id":(\d+),"method":"([^"]+)"/.exec(m[1]); if (q) reqs.set(+q[1], { method: q[2], sid: /"sessionId":"([0-9A-F]{32})"\}\s*$/.exec(m[1])?.[1] }); }
        else if ((m = /proxy->client (\{.*\})\s*$/.exec(line))) { const r = /^\{"id":(\d+),/.exec(m[1]); if (r) answered.add(+r[1]); else if (m[1].startsWith('{"method":"Target.attachedToTarget"')) attachedN++; else { const d = /^\{"method":"Target\.detachedFromTarget","params":\{"sessionId":"([0-9A-F]+)"/.exec(m[1]); if (d) { detachedN++; detachedSids.add(d[1]); } } }
      }
      const unanswered = [...reqs].filter(([id]) => !answered.has(id)).map(([id, r]) => `${id}:${r.method}@${(r.sid || 'root').slice(0, 6)}${detachedSids.has(r.sid) ? '(DETACHED)' : ''}`);
      if (gt.code !== 0 || gt2.code !== 0) { try { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `churn-trace-run${i}.txt`), slice.split('\n').slice(-2500).join('\n')); } catch {} }
      if (reqs.size > 0) console.log(`  MEASURED [${A}] run ${i} trace: attachedToTarget=${attachedN} detachedToClient=${detachedN} requests=${reqs.size} UNANSWERED=${unanswered.length} ${JSON.stringify(unanswered.slice(0, 6))}`);
      console.log(`  MEASURED [${A}] run ${i}: tab new rc=${nw.code} snapshot rc=${sn.code} | get title DURING rc=${gt.code} ${gt.ms} ms | AFTER rc=${gt2.code} ${gt2.ms} ms | iframes created=${created}`);
      for (const [what, r] of [['tab new', nw], ['snapshot', sn], ['get title DURING', gt], ['get title AFTER', gt2]]) if (r.code !== 0) console.log(`    ${what} failed: ${show(r)}`);
      rows.push({ i, nw: nw.code, sn: sn.code, during: gt.code, after: gt2.code, created, unanswered: unanswered.length,
        duringInside: churn ? gt.t0 >= churn.t0 && gt.t0 < churn.t1 : null, afterOutside: churn ? gt2.t0 >= churn.t1 : null });
    }
    const hungDuring = rows.filter((r) => r.during !== 0), hungAfter = rows.filter((r) => r.after !== 0);
    const attachedRuns = rows.filter((r) => r.nw === 0 && r.sn === 0).length;
    const socks = sockets(ctx).length;
    clause(A, 'ctl/a-real-daemon-was-driven', socks >= 1, `agent-browser daemon sockets of this ORCHESTRA_HOME: ${socks} (independent of how many commands stalled)`);
    clause(A, 'ctl/at-least-20-runs', N >= 20, `${N} runs (--churn-n)`);
    clause(A, 'ctl/the-churn-really-ran', rows.every((r) => (r.created ?? 0) >= 50), `iframes created per run (page oracle, window.__churn.created): ${rows.map((r) => r.created).join(',')} (>= 50 each)`);
    // the commands must overlap the churn (a slow host that ate the 3 s before the daemon attached would make the arm green for nothing); judged only on runs whose attach steps returned, so a stall under test cannot void its own control
    const judged = rows.filter((r) => r.nw === 0 && r.sn === 0 && r.duringInside !== null), inside = judged.filter((r) => r.duringInside).length;
    clause(A, 'ctl/get-title-DURING-started-inside-the-churn', judged.length >= N / 2 && inside >= judged.length * 0.8, `${inside}/${judged.length} runs (page window.__churn.t0/t1 vs the call's start, same host clock; >= 80% of the ${judged.length} judged, which must be >= half of ${N})`);
    clause(A, 'ctl/get-title-AFTER-started-after-the-churn-ended', rows.every((r) => r.afterOutside !== false), `runs whose AFTER call started before the churn ended: ${rows.filter((r) => r.afterOutside === false).map((r) => r.i).join(',') || 'none'}`);
    clause(A, 'tab-new-and-snapshot-answer-under-churn', attachedRuns === N, `${N - attachedRuns}/${N} runs had \`tab new\` or \`snapshot\` fail (30 s daemon timeout): ${rows.filter((r) => r.nw !== 0 || r.sn !== 0).map((r) => r.i).join(',') || 'none'}`);
    clause(A, 'get-title-answers-DURING-child-churn', hungDuring.length === 0, `${hungDuring.length}/${N} timed out (8 s): ${hungDuring.map((r) => r.i).join(',') || 'none'}`);
    clause(A, 'get-title-answers-AFTER-child-churn', hungAfter.length === 0, `${hungAfter.length}/${N} timed out (8 s): ${hungAfter.map((r) => r.i).join(',') || 'none'}`);
  },
};
Object.assign(ARM_FNS, ARM_FNS6);

async function runArms(ctx) {
  await waitFor(() => ctx.ui.eval(`document.body.innerText.includes(${sel(ctx.W1.branch)})`), 60000, 'the seeded workspaces in the sidebar');
  await sleep(1500);
  clause('ctl', 'app-in-my-sway', new RegExp(`"pid":\\s*${ctx.app.pid}\\b`).test(sh('swaymsg', ['-t', 'get_tree'])), `app pid ${ctx.app.pid} present in my sway's get_tree`);
  for (const arm of ARM_LIST) {
    console.log(`\n== arm ${arm} ==`);
    if (!ARM_FNS[arm]) { clause(arm, 'implemented', false, 'arm not implemented yet'); continue; }
    try { await ARM_FNS[arm](ctx); } catch (e) { clause(arm, 'arm-completed', false, `ARM ABORTED: ${e.stack || e}`); }
  }
}

// ── live-dir canary: independent tool (find) + json, before/after ─────────────────────────────────────────────────────────────
function liveCanary() {
  const snap = {};
  for (const d of fs.readdirSync(LIVE_HOME).filter((n) => n === '.claude' || n.startsWith('.claude-')).map((n) => path.join(LIVE_HOME, n))) {
    let links = ''; try { links = sh('find', [d, '-maxdepth', '1', '-type', 'l', '-printf', '%f->%l\\n']).split('\n').sort().join('|'); } catch {}
    let mcp = ''; for (const f of [path.join(d, '.claude.json'), path.join(LIVE_HOME, '.claude.json')]) { try { mcp += Object.keys(JSON.parse(fs.readFileSync(f, 'utf8')).mcpServers || {}).sort().join(',') + ';'; } catch {} }
    snap[d] = md5(links) + ':' + md5(mcp) + ` (${links.split('|').filter(Boolean).length} symlinks)`;
  }
  // the host gives every agent-browser process a scratch HOME: the user's own dot-dir for it must never appear
  const abDot = path.join(LIVE_HOME, '.agent' + '-browser');
  snap['agent-browser dot-dir in the real home'] = fs.existsSync(abDot) ? 'exists' : 'absent';
  return snap;
}

const before = liveCanary();
console.log(`[rig] app ${APP_DIR} arms ${ARM_LIST.join(',')} mutant=${MUTANT ?? 'none'} out=${OUT}`);
applyMutant();
await main();
const after = liveCanary();
const same = JSON.stringify(before) === JSON.stringify(after);
clause('ctl', 'live-dirs-untouched', same, `${Object.keys(before).length} live probes (symlink-set + mcpServers hashes of each ~/.claude*, agent-browser dot-dir existence) ${same ? 'identical before/after' : 'CHANGED: ' + JSON.stringify({ before, after })}`);

// ── verdict ───────────────────────────────────────────────────────────────────────────────────────────────────────────────────
const isCtl = (c) => c.arm === 'ctl' || c.clause.startsWith('ctl/');
const targetArms = new Set(MUTANT ? MUTANTS[MUTANT].arms : ARM_LIST);
// A mutant may break OTHER arms (collateral): their arm-scoped controls are not the mutant's concern. Global controls (app identity, containment, teardown, live dirs) always are.
const ctlRed = results.filter((c) => isCtl(c) && !c.ok && (c.arm === 'ctl' || targetArms.has(c.arm))), armRed = results.filter((c) => !isCtl(c) && !c.ok);
fs.mkdirSync(OUT, { recursive: true });
fs.writeFileSync(path.join(OUT, 'result.json'), JSON.stringify({ app: APP_DIR, mutant: MUTANT, results, shots }, null, 2));
let verdict, rc;
if (MUTANT) {
  const want = MUTANTS[MUTANT].arms;
  const redArms = new Set(armRed.map((c) => c.arm));
  const missed = want.filter((a) => !redArms.has(a));
  ({ verdict, rc } = ctlRed.length === 0 && missed.length === 0
    ? { verdict: `MUTANT ${MUTANT} KILLED: arm(s) ${want.join(', ')} red (${armRed.filter((c) => want.includes(c.arm)).map((c) => c.clause).join(', ')}), every control green; other red arms: ${[...redArms].filter((a) => !want.includes(a)).join(', ') || 'none'}`, rc: 0 }
    : { verdict: `MUTANT ${MUTANT} SURVIVED/INVALID: arms not red: ${missed.join(', ') || 'none'}; controls red: ${ctlRed.map((c) => c.clause).join('; ') || 'none'}`, rc: 1 });
} else {
  ({ verdict, rc } = ctlRed.length === 0 && armRed.length === 0
    ? { verdict: `ALL GREEN: ${results.length} clauses (${results.filter(isCtl).length} controls, ${results.length - results.filter(isCtl).length} arm clauses) over ${ARM_LIST.length} arms`, rc: 0 }
    : { verdict: `RED: ${results.filter((c) => !c.ok).map((c) => `${c.arm}:${c.clause}`).join('; ')}`, rc: 1 });
}
console.log(`\nVERDICT: ${verdict}`);
process.exit(process.exitCode || rc);
