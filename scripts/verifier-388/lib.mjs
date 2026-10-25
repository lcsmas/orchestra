// VERIFIER-OWNED rig lib (seat 1, vague #388): guard helpers copied VERBATIM (line ranges) from scripts/e2e-agent-view-removal.mjs @1ccd897b. Outside the repo tree on purpose.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { execFileSync } from 'node:child_process';
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
async function waitFor(what, fn, ms = 15000, step = 150) {
  const t0 = Date.now();
  for (;;) {
    const v = await fn();
    if (v) return v;
    if (Date.now() - t0 > ms) throw new Error(`timeout ${ms}ms: ${what}`);
    await sleep(step);
  }
}

// ── result bookkeeping ───────────────────────────────────────────────────────
/** `env` = the object the child receives (or read back from /proc/<pid>/environ). */
function checkChildEnv(env, mine) {
  const got = env.WAYLAND_DISPLAY;
  if (!got) return { ok: false, clause: 'no-wayland-display', detail: 'child env carries no WAYLAND_DISPLAY' };
  // ORDER MATTERS: wayland-1 (the human's) must be refused BEFORE the equality can be reached.
  if (got === 'wayland-1') return { ok: false, clause: 'refuse-wayland-1', detail: 'wayland-1 is the human\'s compositor' };
  if (!mine) return { ok: false, clause: 'no-rig-display', detail: 'RIG_WAYLAND unset — not launched via e2e-contained-rig.sh' };
  if (got !== mine) return { ok: false, clause: 'not-my-compositor', detail: `${got} != my marker-verified ${mine}` };
  if ('DISPLAY' in env) return { ok: false, clause: 'x11-display-set', detail: `DISPLAY=${env.DISPLAY} would reach an X server` };
  return { ok: true, clause: 'display-isolated', detail: `WAYLAND_DISPLAY=${got}, DISPLAY absent` };
}

// ── PNG decode (8-bit RGB/RGBA) so a gate asserts DECODED PIXELS, never DOM text ─
function decodePng(buf) {
  if (buf.subarray(0, 8).toString('hex') !== '89504e470d0a1a0a') throw new Error('not a PNG');
  let pos = 8, w = 0, h = 0, ct = 0, bd = 0; const idat = [];
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); const type = buf.toString('latin1', pos + 4, pos + 8);
    const data = buf.subarray(pos + 8, pos + 8 + len);
    if (type === 'IHDR') { w = data.readUInt32BE(0); h = data.readUInt32BE(4); bd = data[8]; ct = data[9]; }
    else if (type === 'IDAT') idat.push(data);
    else if (type === 'IEND') break;
    pos += 12 + len;
  }
  if (bd !== 8 || (ct !== 2 && ct !== 6)) throw new Error(`unsupported PNG bd=${bd} ct=${ct}`);
  const ch = ct === 6 ? 4 : 3, stride = w * ch;
  const raw = zlib.inflateSync(Buffer.concat(idat));
  const px = Buffer.alloc(h * stride); let i = 0;
  for (let y = 0; y < h; y++) {
    const f = raw[i++]; const row = y * stride, prev = row - stride;
    for (let x = 0; x < stride; x++) {
      const a = x >= ch ? px[row + x - ch] : 0, b = y ? px[prev + x] : 0, c = x >= ch && y ? px[prev + x - ch] : 0;
      let v = raw[i++];
      if (f === 1) v += a; else if (f === 2) v += b; else if (f === 3) v += (a + b) >> 1;
      else if (f === 4) { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c; }
      px[row + x] = v & 255;
    }
  }
  return { w, h, ch, px };
}
/** Pixel statistics that separate a painted pane from an empty one: how much of the
 *  image is NOT the modal (background) colour, and how many distinct colours it holds. */
function pngStats(buf) {
  const { w, h, ch, px } = decodePng(buf);
  const counts = new Map();
  for (let i = 0; i < px.length; i += ch) {
    const k = (px[i] << 16) | (px[i + 1] << 8) | px[i + 2];
    counts.set(k, (counts.get(k) ?? 0) + 1);
  }
  let modal = 0; for (const c of counts.values()) if (c > modal) modal = c;
  const total = w * h;
  return { w, h, bytes: buf.length, distinct: counts.size, nonBgPct: +(((total - modal) / total) * 100).toFixed(3) };
}

/** The painted-vs-blank rule the content arm gates on (kept pure so pixel_selftest drives the SAME predicate). */
const paintedBeyondBlank = (C, B) => C.nonBgPct > B.nonBgPct + 0.05 && C.distinct > B.distinct + 4;

// ── /proc helpers ────────────────────────────────────────────────────────────
const procEnv = (pid) => {
  const out = {};
  for (const kv of fs.readFileSync(`/proc/${pid}/environ`, 'latin1').split('\0')) {
    const i = kv.indexOf('=');
    if (i > 0) out[kv.slice(0, i)] = kv.slice(i + 1);
  }
  return out;
};
const procCmdline = (pid) => { try { return fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').split('\0').join(' ').trim(); } catch { return ''; } };
const procStart = (pid) => { try { const s = fs.readFileSync(`/proc/${pid}/stat`, 'latin1'); return s.slice(s.lastIndexOf(')') + 2).split(' ')[19]; } catch { return null; } };
function descendants(root) {
  const kids = new Map();
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    try {
      const s = fs.readFileSync(`/proc/${d}/stat`, 'latin1');
      const ppid = Number(s.slice(s.lastIndexOf(')') + 2).split(' ')[1]);
      (kids.get(ppid) ?? kids.set(ppid, []).get(ppid)).push(Number(d));
    } catch { /* raced exit */ }
  }
  const out = [], stack = [root];
  while (stack.length) { const p = stack.pop(); for (const k of kids.get(p) ?? []) { out.push(k); stack.push(k); } }
  return out;
}

// ── CDP over raw WebSocket (Node 22 global; no dependency) ───────────────────
class Cdp {
  static async connect(url) {
    const ws = new WebSocket(url);
    await new Promise((res, rej) => { ws.onopen = res; ws.onerror = () => rej(new Error('cdp ws error')); });
    return new Cdp(ws);
  }
  constructor(ws) {
    this.ws = ws; this.id = 0; this.pending = new Map();
    ws.onmessage = (m) => {
      const msg = JSON.parse(m.data);
      const p = msg.id && this.pending.get(msg.id);
      if (p) { this.pending.delete(msg.id); msg.error ? p.rej(new Error(`${p.method}: ${msg.error.message}`)) : p.res(msg.result); }
    };
  }
  send(method, params = {}, ms = 15000) {
    const id = ++this.id;
    return new Promise((res, rej) => {
      const t = setTimeout(() => { this.pending.delete(id); rej(new Error(`cdp timeout ${ms}ms: ${method}`)); }, ms);
      this.pending.set(id, { method, res: (v) => { clearTimeout(t); res(v); }, rej: (e) => { clearTimeout(t); rej(e); } });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }
  async eval(expression) {
    const r = await this.send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
    if (r.exceptionDetails) throw new Error(`eval: ${r.exceptionDetails.exception?.description ?? r.exceptionDetails.text}`);
    return r.result.value;
  }
  close() { try { this.ws.close(); } catch { /* */ } }
}

// ── the app under test ───────────────────────────────────────────────────────
const RIG = {
  wayland: process.env.RIG_WAYLAND ?? '',
  swaysock: process.env.SWAYSOCK ?? '',
  base: process.env.ORCHESTRA_HOME ?? '',          // the rig's `oh`; each boot gets a subdir
  liveCfg: process.env.CLAUDE_CONFIG_DIR ?? '',    // the INVOKER's live dir: a dir to PROTECT, never to use
  rigDir: process.env.RIG_DIR ?? '',
};
const REAL_HOME = os.userInfo().homedir;
const gitEnv = (home) => ({ PATH: '/usr/local/bin:/usr/bin:/bin', HOME: home, GIT_AUTHOR_NAME: 'avr', GIT_AUTHOR_EMAIL: 'avr@example.invalid', GIT_COMMITTER_NAME: 'avr', GIT_COMMITTER_EMAIL: 'avr@example.invalid', GIT_CONFIG_NOSYSTEM: '1' });
const git = (cwd, args, home) => execFileSync('git', args, { cwd, env: gitEnv(home), encoding: 'utf8' });
async function freePort() {
  return await new Promise((res, rej) => {
    const s = net.createServer(); s.on('error', rej);
    s.listen(0, '127.0.0.1', () => { const p = s.address().port; s.close(() => res(p)); });
  });
}

/** The scratch account dir must live inside this boot's home and never be, contain or sit
 *  under a live config dir. Pure, so live_guard_selftest drives the shipped function. */
function checkScratchConfig(configDir, live, home, { allowHome = false } = {}) {
  const rp = (x) => { try { return fs.realpathSync(x); } catch { return path.resolve(x); } };
  const c = rp(configDir);
  if (c === rp(REAL_HOME)) return { ok: false, clause: 'is-real-home', detail: `${configDir} IS the invoker's real home ${REAL_HOME}` };
  for (const l of live.filter(Boolean)) {
    const lr = rp(l);
    if (c === lr) return { ok: false, clause: 'is-live-config', detail: `${configDir} IS the live config dir ${l}` };
    if (c.startsWith(lr + path.sep) || lr.startsWith(c + path.sep)) return { ok: false, clause: 'overlaps-live-config', detail: `${configDir} overlaps live ${l}` };
  }
  if (allowHome && c === rp(home)) return { ok: true, clause: 'scratch-config', detail: configDir };
  if (!c.startsWith(rp(home) + path.sep)) return { ok: false, clause: 'outside-boot-home', detail: `${configDir} is not under this boot's home ${home}` };
  return { ok: true, clause: 'scratch-config', detail: configDir };
}
/** What the app's account-inherit sync can rewrite in a config dir: symlinks (top level + skills/),
 *  the managed file names, the manifest, and the mcpServers KEY set of .claude.json. Volatile
 *  files (history, sessions, projects) are deliberately outside it — the invoker's own claude
 *  writes those while a rig runs. */
function liveSnapshot(dir) {
  const snap = { dir, exists: fs.existsSync(dir), links: [], managed: [], manifest: null, mcp: null };
  if (!snap.exists) return JSON.stringify(snap);
  for (const sub of ['', 'skills']) {
    let ents = [];
    try { ents = fs.readdirSync(path.join(dir, sub)); } catch { /* absent */ }
    for (const n of ents.sort()) {
      const f = path.join(dir, sub, n);
      try { if (fs.lstatSync(f).isSymbolicLink()) snap.links.push(`${path.join(sub, n)} -> ${fs.readlinkSync(f)}`); } catch { /* raced */ }
    }
  }
  for (const n of ['CLAUDE.md', 'settings.json', 'LESSONS.md']) if (fs.existsSync(path.join(dir, n))) snap.managed.push(n);
  try { snap.manifest = fs.readFileSync(path.join(dir, '.orchestra-inherited.json'), 'utf8'); } catch { /* none */ }
  try { snap.mcp = Object.keys(JSON.parse(fs.readFileSync(path.join(dir, '.claude.json'), 'utf8')).mcpServers ?? {}).sort(); } catch { snap.mcp = 'unreadable'; }
  return JSON.stringify(snap);
}
/** Every config dir a boot must never touch: the invoker's $CLAUDE_CONFIG_DIR, ~/.claude, and every ~/.claude-* sibling. */
/** Direction of a live-dir change (S4). The app's known failure mode under a fake HOME is REMOVAL (its sync source is
 *  missing), so removals — or an unparseable/structural change — are a FAIL. Pure ADDITIONS cannot come from that app
 *  (nothing exists to link) and are what the LIVE Orchestra's own re-sync produces on a shared dir: `external`, tallied
 *  apart, neither PASS nor FAIL. */
function classifySnapshotChange(beforeStr, afterStr) {
  if (beforeStr === afterStr) return { kind: 'same', removed: [], added: [] };
  let b, a;
  try { b = JSON.parse(beforeStr); a = JSON.parse(afterStr); } catch { return { kind: 'removals', removed: ['<unparseable snapshot>'], added: [] }; }
  if (b.exists !== a.exists) return { kind: 'removals', removed: [`exists ${b.exists} -> ${a.exists}`], added: [] };
  const lst = (x) => new Set([...(x.links ?? []), ...(x.managed ?? []).map((n) => `managed:${n}`), ...(Array.isArray(x.mcp) ? x.mcp.map((n) => `mcp:${n}`) : [`mcp:${x.mcp}`]),
    ...(() => { try { const m = JSON.parse(x.manifest ?? '{}'); return [...(m.symlinks ?? []).map((n) => `manifest-link:${n}`), ...(m.mcpServers ?? []).map((n) => `manifest-mcp:${n}`)]; } catch { return [`manifest-raw:${x.manifest}`]; } })()]);
  const B = lst(b), A = lst(a);
  const removed = [...B].filter((x) => !A.has(x)), added = [...A].filter((x) => !B.has(x));
  return { kind: removed.length ? 'removals' : added.length ? 'additions' : 'same', removed, added };
}
/** Verdict for one arm/clause over every protected dir: removals FAIL, additions-only EXTERNAL-CHANGE, else PASS. */
function liveVerdict(ctx, name, before, dirs = liveDirs()) {
  const rows = dirs.map((d) => ({ d, ...classifySnapshotChange(before[d] ?? liveSnapshot(d), liveSnapshot(d)) }));
  const bad = rows.filter((r) => r.kind === 'removals'), ext = rows.filter((r) => r.kind === 'additions');
  if (bad.length) return ctx.clause(name, false, `REMOVED from a protected dir: ${bad.map((r) => `${r.d}: -${r.removed.join(', -')}`).join(' | ')}`);
  if (ext.length) return ctx.externalChange(name, `only ADDITIONS in ${ext.map((r) => `${r.d} (+${r.added.length}: ${r.added.slice(0, 3).join(', ')}${r.added.length > 3 ? ', …' : ''})`).join(', ')} — a re-sync by the LIVE Orchestra, not this rig's app (whose sync can only remove); nothing removed`);
  return ctx.clause(name, true, `inheritance surface identical before/after for ${dirs.join(', ')}`);
}
/** `~/.claude-*` config dirs of `home`. A dangling symlink / EACCES entry is skipped ALONE — one bad entry must not drop
 *  every later sibling from the protected set (F4: readdir order is alphabetical, so a bad `b` hid `c`). */
function claudeSiblingDirs(home) {
  let names = [];
  try { names = fs.readdirSync(home); } catch { return []; }
  const out = [];
  for (const n of names) {
    if (!n.startsWith('.claude-')) continue;
    try { if (fs.statSync(path.join(home, n)).isDirectory()) out.push(path.join(home, n)); } catch { /* skip THIS entry only */ }
  }
  return out;
}
const liveDirs = () => [...new Set([RIG.liveCfg, path.join(REAL_HOME, '.claude'), ...claudeSiblingDirs(REAL_HOME)].filter(Boolean))].filter((d) => fs.existsSync(d));
/** Resolve EVERY path the app is handed (HOME, CLAUDE_CONFIG_DIR, XDG_*, ORCHESTRA_HOME, each seeded
 *  account's configDir) and REFUSE — named — if any is outside the boot home or is/overlaps a live dir. */
function checkHandOff(env, accounts, home) {
  const vars = { HOME: env.HOME, CLAUDE_CONFIG_DIR: env.CLAUDE_CONFIG_DIR, XDG_CONFIG_HOME: env.XDG_CONFIG_HOME, XDG_CACHE_HOME: env.XDG_CACHE_HOME, ORCHESTRA_HOME: env.ORCHESTRA_HOME };
  accounts.forEach((a, i) => { vars[`accounts[${i}].configDir`] = a.configDir; });
  for (const [k, v] of Object.entries(vars)) {
    if (!v) return { ok: false, clause: `handoff:${k}:unset`, detail: `${k} is not set — the app would fall back to a default under the real home` };
    const r = checkScratchConfig(v, liveDirs(), home, { allowHome: k === 'ORCHESTRA_HOME' });
    if (!r.ok) return { ok: false, clause: `handoff:${k}:${r.clause}`, detail: r.detail };
  }
  return { ok: true, clause: 'handoff-scratch', detail: `${Object.keys(vars).length} paths all inside ${home}` };
}

export { sleep, waitFor, checkChildEnv, decodePng, pngStats, procEnv, procCmdline, procStart, descendants, Cdp, RIG, REAL_HOME, git, freePort, checkScratchConfig, liveSnapshot, classifySnapshotChange, claudeSiblingDirs, liveDirs, checkHandOff };
