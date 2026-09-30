#!/usr/bin/env node
// Removal-assertion E2E rig — wave "Agent view only" (#219), ticket #225.
//
// Boots a BUILT Orchestra (path = argv[2]) in an isolated ORCHESTRA_HOME under ~ (btrfs),
// with a seeded store, inside the compositor scripts/e2e-contained-rig.sh started, and
// reports two observables of the RUNNING app:
//   (1) the workspace TAB LABELS actually rendered (DOM of `.toolbar .tabs .tab`),
//   (2) the LIVE PTY SESSIONS by kind agent|run|nvim|login — `window.orchestra.sampleResources()`,
//       the exact IPC the Resources page polls (`resources:sample` -> `listPtySessions()`
//       -> `classifyPtyId`). Already script-readable through the preload bridge, so NO new
//       exposure was added. Keeper-hosted SDK sessions are NOT PTYs and never appear there.
//
// Run through the wrapper (own sway, env -i allowlist, SCRATCH account dir, btrfs base):
//   scripts/e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control] [--allow-stale]
//   (`pnpm run test:agent-view-removal`; --broken-control = self-test knob, --allow-stale = proceed on a stale dist/, see below.)
//   Any unrecognised flag (incl. `--mode=after`) is an ERROR, rc 2.
//
// MODES — every arm carries BOTH expectations, picked by --mode:
//   baseline  today's behaviour (Raw tab present, opening Raw creates an agent-kind PTY).
//             Must be GREEN on a pre-change master build; RED on a candidate that removed Raw.
//   after     the removal spec (#219): tabs exactly Agent·Run·Diff, no agent PTY from any tab.
//             Must be RED on master (proves the arm can fail); GREEN once the removal lands.
// EXTENDING (tickets #226-#233): add one object to ARMS, put both expectations in EXPECT,
// print through ctx.clause(name, ok, detail) so each line names the clause that fired.
// Flipping a baseline assertion = edit its `baseline` value in EXPECT, nothing else.
//
// GUARDS: an arm that asserts a PTY is ABSENT is REFUSED unless the Run-tab positive control
// fired in the SAME boot (a listing that cannot see PTYs proves nothing). Every boot prints
// IDENTITY (running version + loaded bundle md5) and proves isolation (own compositor,
// own ORCHESTRA_HOME, never wayland-1) before any arm asserts.
//
// THE ACCOUNT IS A SCRATCH DIR, NEVER THE INVOKER'S LIVE ONE (review F1 on #225, MEASURED): the app
// boot runs account-inherit sync, and under this rig's fake HOME its source `~/.claude` is missing,
// so it UNLINKED every inherited link / MCP server of whatever configDir the seeded account named —
// the invoker's live ~/.claude-mc. Each boot now seeds `<home>/claude-config` (fresh, stub claude,
// no login needed); `checkScratchConfig` refuses anything else before launch, and every boot
// asserts the live config dirs' inheritance surface is byte-identical before/after (`liveSnapshot`).
// A later arm that needs a real login must COPY `.credentials.json` into the scratch dir.
// Also: `identity/dist-fresh` REFUSES a dist/ older than src/ or package.json (`--allow-stale` overrides, loudly);
// a clause that cannot measure in a mode prints SKIP (counted apart, `clauses=` stays comparable across modes);
// retention = a PASSED arm's bulky state is deleted (app.log + screenshots kept), a FAILED arm keeps everything, and
// stale rig dirs are pruned only by `pruneStaleRigDirs` (owner-marked, >24 h, unreferenced, not KEEP-marked); the wrapper deletes nothing.

import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn, spawnSync, execFileSync } from 'node:child_process';

// ── expectations: the ONE place baseline↔after flips live ────────────────────
const EXPECT = {
  // Ordered labels as rendered (own text; the Run tab's "· setup" hint is a child span).
  tabs: { baseline: ['Raw', 'Run', 'Structured', 'Diff'], after: ['Agent', 'Run', 'Diff'] },
  // The Agent view's tab label, and that a fresh workspace opens on it.
  agentTab: { baseline: 'Structured', after: 'Agent' },
  // Does opening the (Raw) terminal tab create an agent-kind PTY?
  rawCreatesAgentPty: { baseline: true, after: false },
  // #229: with NO linked PR the toolbar rendered an "Open PR" create button (amber "· ↑N" when commits are unpushed).
  openPrButton: { baseline: true, after: false },
  // #229: the merge IPC's preload wrapper (`window.orchestra.mergeWorktree`) exists on the built app?
  mergeWrapper: { baseline: true, after: false },
  // #229: the loaded stylesheet still carries rules for the removed button (`.pr-link-create`, `.primed`)?
  createButtonCss: { baseline: true, after: false },
  // #228 — `orchestra restart` of a stopped LEGACY terminal-only workspace (hasInput, no sdkSessionId). Baseline = today's PTY
  // restart (`claude --continue` in an agent PTY, `(terminal, …)` in the CLI reply, no adoption); after = the SDK wake path
  // adopts the terminal transcript and the session resumes it in the Agent view (no PTY, reply names no surface).
  legacyRestart: {
    baseline: { wake: false, agentPty: true, surfaceWord: 'terminal', resumeFlag: '--continue' },
    after: { wake: true, agentPty: false, surfaceWord: null, resumeFlag: '--resume' },
  },
  // #226: does a refused sandbox agent start NAME the pause + #220? (baseline: the cryptic spawn error / silent PTY fallback)
  sandboxPaused: { baseline: false, after: true },
};
// #228 legacy seed: a real-shaped TERMINAL transcript (entrypoint 'cli') the wake path must adopt. A valid UUID: the SDK's session index keys on it.
const LEGACY_SESSION_ID = '228c0de0-7e57-4a11-8b3a-00000000b301';
const LEGACY_SENTINEL_USER = 'AVR-LEGACY-USER-228b3 typed into the old terminal agent';
const LEGACY_SENTINEL_ASSISTANT = 'AVR-LEGACY-ASSISTANT-228b3 answered in the old terminal agent';
const ABSENCE_MS = 2500; // window an "absent" claim is observed for after each tab click
const SENTINEL_USER = 'AVR-USER-4f81c2 render probe';
const SENTINEL_ASSISTANT = 'AVR-ASSISTANT-9d03e7 rendered through the real fold path';

// ── args ─────────────────────────────────────────────────────────────────────
const KNOWN_FLAGS = { '--mode': true, '--arm': true, '--list': false, '--broken-control': false, '--allow-stale': false }; // true = takes a value
/** Strict: ANY unrecognised `--*` (incl. `--mode=after`, `--mod`, `--allow_stale`), a missing/invalid value or a stray
 *  positional is an ERROR — a silently-ignored flag runs the default mode, which is exactly the flip B5 performs (F3). */
function parseArgs(argv) {
  const r = { mode: 'baseline', arm: null, list: false, brokenControl: false, allowStale: false, positional: [], error: null };
  const seen = new Set();
  for (let i = 0; i < argv.length && !r.error; i++) {
    const a = argv[i];
    if (!a.startsWith('--')) { r.positional.push(a); continue; }
    if (a in KNOWN_FLAGS && seen.has(a)) { r.error = `${a} given more than once (last-wins would silently drop the first)`; break; }
    seen.add(a);
    if (!(a in KNOWN_FLAGS)) { r.error = `unknown flag '${a}'${a.includes('=') ? " (write '--mode after', not '--mode=after')" : ''} — known: ${Object.keys(KNOWN_FLAGS).join(' ')}`; break; }
    let v = null;
    if (KNOWN_FLAGS[a]) { v = argv[++i]; if (v === undefined || v.startsWith('--')) { r.error = `${a} needs a value`; break; } if (v === '') { r.error = `${a} needs a NON-EMPTY value${a === '--arm' ? ' (an empty --arm would run every arm)' : ''}`; break; } }
    if (a === '--mode') { if (!['baseline', 'after'].includes(v)) { r.error = `bad --mode '${v}' (baseline|after)`; break; } r.mode = v; }
    else if (a === '--arm') r.arm = v;
    else if (a === '--list') r.list = true;
    else if (a === '--broken-control') r.brokenControl = true;
    else if (a === '--allow-stale') r.allowStale = true;
  }
  if (!r.error && r.positional.length > 1) r.error = `unexpected extra argument '${r.positional[1]}' (one <app-dir> only)`;
  return r;
}
const ARGS = parseArgs(process.argv.slice(2));
if (ARGS.error) { console.error(`e2e-agent-view-removal: ${ARGS.error}`); process.exit(2); }
const MODE = ARGS.mode;
const ARM_SEL = ARGS.arm;
const LIST = ARGS.list;
// SELF-TEST knob: seed a repo with NO Run script, so the Run-tab control cannot make a PTY appear
// and every "no agent PTY" assertion must be REFUSED (proves the gate is load-bearing).
const BROKEN_CONTROL = ARGS.brokenControl;
// Escape hatch for a deliberately stale dist/ (default: a dist/ older than src/ is REFUSED — F2).
const ALLOW_STALE = ARGS.allowStale;
let APP_DIR = null;
if (ARGS.positional[0]) { try { APP_DIR = fs.realpathSync(ARGS.positional[0]); } catch { console.error(`e2e-agent-view-removal: <app-dir> '${ARGS.positional[0]}' does not exist`); process.exit(2); } }
const pick = (e) => e[MODE];
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
const RESULTS = [];
function makeCtx(arm) {
  return {
    arm, mode: MODE, controls: { run: false }, app: null,
    clause(name, ok, detail = '') {
      RESULTS.push({ arm, clause: name, ok: !!ok, detail });
      console.log(`${ok ? 'PASS' : 'FAIL'}  ${arm}/${name}${detail ? ' — ' + detail : ''}`);
      return !!ok;
    },
    /** A clause that CANNOT measure in this mode/build: printed as SKIP with the reason, counted apart
     *  from pass/fail so `clauses=` stays comparable across modes (F3). Never a PASS on a constant. */
    skip(name, reason) {
      RESULTS.push({ arm, clause: name, ok: true, skip: true, detail: reason });
      console.log(`SKIP  ${arm}/${name} — ${reason}`);
    },
    /** A protected dir gained entries while a boot ran (the live app re-syncing): tallied apart, never a PASS (S4). */
    externalChange(name, detail) {
      RESULTS.push({ arm, clause: name, ok: true, externalChange: true, detail });
      console.log(`EXTERNAL-CHANGE  ${arm}/${name} — ${detail}`);
      return true;
    },
    /** --allow-stale ONLY: proceeds on a build proven stale — tallied apart as allowed_stale, never as a PASS (S3). */
    allowedStale(name, detail) {
      RESULTS.push({ arm, clause: name, ok: true, allowedStale: true, detail });
      console.log(`ALLOWED-STALE  ${arm}/${name} — ${detail}`);
    },
    note(line) { console.log(`      ${arm}: ${line}`); },
  };
}

// ── isolation guard (pure: the self-test arm drives the same function) ───────
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

/** Seed: a real git repo + registered worktree (prune deletes what it cannot verify), the
 *  repo's Run script, the PINNED account, and a stub `claude` that never touches the API. */
function seedWorld(home, opt = {}) {
  const fakeHome = path.join(home, 'home');
  const repoDir = path.join(home, 'repo'), wtDir = path.join(home, 'wt', 'avr-1');
  fs.mkdirSync(fakeHome, { recursive: true }); fs.mkdirSync(repoDir, { recursive: true });
  git(repoDir, ['init', '-q', '-b', 'main'], fakeHome);
  fs.writeFileSync(path.join(repoDir, 'README.md'), '# avr seed repo\n');
  git(repoDir, ['add', '.'], fakeHome); git(repoDir, ['commit', '-q', '-m', 'seed'], fakeHome);
  fs.mkdirSync(path.dirname(wtDir), { recursive: true });
  git(repoDir, ['worktree', 'add', '-q', '-b', 'e2e/avr-1', wtDir], fakeHome);
  const listed = git(repoDir, ['worktree', 'list', '--porcelain'], fakeHome);
  if (!listed.includes(`worktree ${fs.realpathSync(wtDir)}`)) throw new Error(`seed worktree not registered:\n${listed}`);

  const configDir = opt.configDir ?? path.join(home, 'claude-config');
  if (opt.symlinkConfigTo) fs.symlinkSync(opt.symlinkConfigTo, configDir); // test knob: a path that READS as scratch but resolves into a live dir
  else if (!opt.configDir) fs.mkdirSync(configDir, { recursive: true });
  const cfgGuard = checkScratchConfig(configDir, liveDirs(), home);
  if (!cfgGuard.ok) throw new Error(`REFUSED before seeding [${cfgGuard.clause}]: ${cfgGuard.detail}`);
  const account = { id: 'rig-avr', label: 'rig (scratch config dir)', configDir };
  const ws = {
    id: 'ws-avr-1', name: 'avr-1', repoPath: repoDir, worktreePath: wtDir, branch: 'e2e/avr-1',
    baseBranch: 'main', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: account.id,
    ...(opt.legacy ? { hasInput: true } : {}), // #228: input typed into the terminal agent, NO sdkSessionId
  };
  // #229 seeds. `commitsAhead`: N never-pushed commits on the seed branch → the app's own merge-state poll reports
  // unpushedAhead=N (no origin ref, so every commit ahead of base counts) — the "primed" input of the old Open PR button.
  for (let i = 1; i <= (opt.commitsAhead ?? 0); i++) {
    fs.writeFileSync(path.join(wtDir, `ahead-${i}.txt`), `unpushed ${i}\n`);
    git(wtDir, ['add', '.'], fakeHome); git(wtDir, ['commit', '-q', '-m', `avr unpushed ${i}`], fakeHome);
  }
  // `linkedPr`: a PR the agent "linked" (pointer only; the app re-reads its state via `gh api repos/<o>/<r>/pulls/<n>` — the
  // REAL path). Stub gh answers exactly that call with an OPEN PR and refuses everything else (as an unauthenticated gh would);
  // stub xdg-open keeps a click on the PR button from launching a browser. Both log their argv (positive controls).
  if (opt.linkedPr) { const { owner, repo, number } = opt.linkedPr; ws.linkedPrs = [{ url: `https://github.com/${owner}/${repo}/pull/${number}`, owner, repo, number }]; }
  // #228: the terminal agent's transcript, exactly where `claude --continue` / the SDK session index look for it:
  // <account configDir>/projects/<mangled worktree path>/<session>.jsonl.
  let legacyTranscript = null;
  if (opt.legacy) {
    const projDir = path.join(configDir, 'projects', wtDir.replace(/[^A-Za-z0-9]/g, '-'));
    fs.mkdirSync(projDir, { recursive: true });
    legacyTranscript = path.join(projDir, `${LEGACY_SESSION_ID}.jsonl`);
    const env = { userType: 'external', entrypoint: 'cli', cwd: wtDir, sessionId: LEGACY_SESSION_ID, version: '2.1.284', gitBranch: 'e2e/avr-1' };
    const u = '2280b3a1-0000-4000-8000-000000000001', a = '2280b3a1-0000-4000-8000-000000000002', t0 = Date.now() - 3600e3;
    fs.writeFileSync(legacyTranscript, [
      { parentUuid: null, isSidechain: false, promptId: 'avr-prompt-1', type: 'user', message: { role: 'user', content: LEGACY_SENTINEL_USER }, uuid: u, timestamp: new Date(t0).toISOString(), ...env },
      { parentUuid: u, isSidechain: false, type: 'assistant', message: { id: 'msg_avr228', type: 'message', role: 'assistant', model: 'claude-opus-4-8', content: [{ type: 'text', text: LEGACY_SENTINEL_ASSISTANT }], stop_reason: 'end_turn', stop_sequence: null, usage: { input_tokens: 1, output_tokens: 1 } }, uuid: a, timestamp: new Date(t0 + 1000).toISOString(), ...env },
    ].map((l) => JSON.stringify(l)).join('\n') + '\n');
  }
  const repo = { path: repoDir, name: 'avr-repo', defaultBranch: 'main', scripts: BROKEN_CONTROL ? {} : { run: 'sleep 3600' }, accountId: account.id };
  // #226 seeds (opt.sandbox): two sandbox-hosted records as `importWorkspaceToSandbox` leaves them (host flipped, hasInput false,
  // local worktree retired). `gone` = retired path absent (the normal case); `live` = the retire step failed, so the local dir still
  // exists — the case where a PTY fallback WITHOUT `host` would start a local agent. Listed FIRST so the store's first ws is active at boot.
  const sbxHost = { kind: 'sandbox', endpoint: 'ws://127.0.0.1:9' }; // nothing listens there: a refused start must never dial
  const sbxRec = (tag, wt, extra = {}) => ({ ...ws, id: `ws-avr-sbx-${tag}`, name: `avr-sbx-${tag}`, branch: `e2e/avr-sbx-${tag}`, worktreePath: wt, host: sbxHost, hasInput: false, sdkSessionId: `avr-sbx-${tag}-sess`, ...extra });
  const sbxLiveDir = path.join(home, 'wt', 'avr-sbx-live');
  if (opt.sandbox) fs.mkdirSync(sbxLiveDir, { recursive: true });
  // `legacy` = a terminal-only sandbox ws (hasInput, NO sdkSessionId): the restart classifier routes it to the PTY (host-aware) launcher.
  const sbx = opt.sandbox ? { gone: sbxRec('gone', path.join(home, 'wt', 'avr-sbx-gone')), live: sbxRec('live', sbxLiveDir), legacy: sbxRec('legacy', path.join(home, 'wt', 'avr-sbx-legacy'), { hasInput: true, sdkSessionId: undefined }) } : null;
  const dir = path.join(home, 'userData', 'orchestra'); fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'store.json'), JSON.stringify({ repos: [repo], workspaces: sbx ? [sbx.gone, sbx.live, sbx.legacy, ws] : [ws], accounts: [account], selfTuneRuns: [] }, null, 2));
  // Stub claude: the legacy agent PTY execs `claude` from PATH; a stub keeps the baseline
  // free of API calls. Stays a shell (not exec) so its cmdline names the stub for identity.
  const stubDir = path.join(home, 'stub-bin'); fs.mkdirSync(stubDir, { recursive: true });
  const stub = path.join(stubDir, 'claude');
  // Every start appends `<pid> <argv…>` to stub-argv.log (#228: the OBSERVABLE of "which session did this CLI resume"), from ANY launcher (PTY or SDK keeper).
  const stubLog = path.join(home, 'stub-argv.log');
  fs.writeFileSync(stub, `#!/bin/sh\necho "$$ $*" >> '${stubLog}'\necho AVR-STUB-CLAUDE "$@"\nsleep 3600\n`, { mode: 0o755 });
  if (opt.linkedPr) {
    const { owner, repo, number, title } = opt.linkedPr;
    const q = (f) => `'${path.join(home, f)}'`;
    // gh: answers ONLY `api repos/<owner>/<repo>/pulls/<n>` (already in the jq-mapped shape fetchLinkedPR parses).
    fs.writeFileSync(path.join(stubDir, 'gh'), `#!/bin/sh\necho "$*" >> ${q('gh-calls.log')}\n` +
      `if [ "$1" = api ] && [ "$2" = "repos/${owner}/${repo}/pulls/${number}" ]; then\n` +
      `  echo '{"url":"https://github.com/${owner}/${repo}/pull/${number}","number":${number},"title":${JSON.stringify(title)},"state":"OPEN"}'; exit 0\nfi\n` +
      `echo "gh: avr stub has no answer for: $*" >&2; exit 1\n`, { mode: 0o755 });
    fs.writeFileSync(path.join(stubDir, 'xdg-open'), `#!/bin/sh\necho "$*" >> ${q('xdg-open.log')}\n`, { mode: 0o755 });
  }
  return { fakeHome, repoDir, wtDir, ws, sbx, account, stubDir, stub, stubLog, legacyTranscript, storeFile: path.join(dir, 'store.json') };
}

async function bootApp(arm, opt = {}) {
  if (!APP_DIR) throw new Error('no <app-dir> given');
  const missing = ['RIG_WAYLAND', 'SWAYSOCK', 'ORCHESTRA_HOME', 'CLAUDE_CONFIG_DIR'].filter((k) => !process.env[k]);
  if (missing.length) throw new Error(`not launched via scripts/e2e-agent-view-removal.sh (missing ${missing.join(', ')})`);
  const home = path.join(RIG.base, `${arm}-${Date.now().toString(36)}`);
  fs.mkdirSync(home, { recursive: true });
  const world = seedWorld(home, opt);
  const port = await freePort();
  const electron = opt.electron ?? process.env.E2E_ELECTRON
    ?? [path.join(APP_DIR, 'node_modules/electron/dist/electron'), path.join(path.dirname(new URL(import.meta.url).pathname), '../node_modules/electron/dist/electron')].find((p) => fs.existsSync(p));
  if (!electron) throw new Error('no electron binary (set E2E_ELECTRON)');

  // ALLOWLIST env, built as an object so the guard reads the very values the child gets.
  const env = {
    PATH: `${world.stubDir}:/usr/local/bin:/usr/bin:/bin`,
    HOME: world.fakeHome, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? `/run/user/${process.getuid()}`,
    XDG_CONFIG_HOME: path.join(world.fakeHome, '.config'), XDG_CACHE_HOME: path.join(world.fakeHome, '.cache'),
    WAYLAND_DISPLAY: RIG.wayland, SWAYSOCK: RIG.swaysock, LANG: 'C.UTF-8',
    ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: home, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true',
    CLAUDE_CONFIG_DIR: world.account.configDir,
    ...(opt.env ?? {}),
  };
  const pre = checkChildEnv(env, RIG.wayland);
  if (!pre.ok) throw new Error(`REFUSED before launch [${pre.clause}]: ${pre.detail}`);
  const hand = checkHandOff(env, [world.account], home);
  if (!hand.ok) throw new Error(`REFUSED before launch [${hand.clause}]: ${hand.detail}`);

  const liveBefore = Object.fromEntries(liveDirs().map((d) => [d, liveSnapshot(d)]));
  const log = fs.openSync(path.join(home, 'app.log'), 'w');
  const child = spawn(electron, [APP_DIR, '--ozone-platform=wayland'], { cwd: APP_DIR, env, stdio: ['ignore', log, log] });
  const app = { arm, home, port, child, pid: child.pid, env, world, electron, liveBefore, cdp: null, exited: false };
  child.on('exit', () => { app.exited = true; });
  try {
    const targets = await waitFor(`CDP target on :${port}`, async () => {
      if (app.exited) throw new Error(`electron exited early (see ${home}/app.log)`);
      try {
        const j = await (await fetch(`http://127.0.0.1:${port}/json`)).json();
        const t = j.filter((x) => x.type === 'page' && x.url.includes('dist/index.html'));
        return t.length ? t : null;
      } catch { return null; }
    }, 30000, 300);
    app.target = targets[0];
    app.cdp = await Cdp.connect(app.target.webSocketDebuggerUrl);
    await app.cdp.send('Page.enable');
    return Object.assign(app, appApi(app));
  } catch (e) {
    await appApi(app).close(); // a half-booted app must never outlive the failure
    e.app = app; throw e;
  }
}

function appApi(app) {
  const { cdp } = app;
  const api = {
    async tabs() {
      return cdp.eval(`(() => [...document.querySelectorAll('.toolbar .tabs .tab')].map(b => {
        const r = b.getBoundingClientRect();
        const label = [...b.childNodes].filter(n => n.nodeType === 3).map(n => n.textContent).join('').trim();
        return { label, active: b.classList.contains('active'), visible: r.width > 0 && r.height > 0, cx: r.x + r.width / 2, cy: r.y + r.height / 2 };
      }))()`);
    },
    async ptys() {
      return cdp.eval(`window.orchestra.sampleResources().then(s => s.sessions.map(x => ({
        ptyId: x.ptyId, kind: x.kind, workspaceId: x.workspaceId, remote: x.remote,
        procCount: x.procCount, pids: (x.processes || []).map(p => p.pid) })))`);
    },
    /** #229: every PR-related control the TOOLBAR renders (not the sidebar): `.pr-link` buttons + anything whose text/title/class
     *  reads as the old create/"ready to push" affordance. `create` = the old "Open PR" button; `readyToPush` = its primed surface. */
    async prControls() {
      return cdp.eval(`(() => [...document.querySelectorAll('.toolbar *')].filter((e) => e.matches('button.pr-link')
          || /Open PR|ready to push|create a PR/i.test((e.tagName === 'BUTTON' ? e.textContent : '') + ' ' + (e.getAttribute('title') || '')) || e.classList.contains('primed')).map((e) => {
        const r = e.getBoundingClientRect(), t = e.textContent.trim(), ti = e.getAttribute('title') || '';
        return { tag: e.tagName, text: t, title: ti, cls: e.className, visible: r.width > 0 && r.height > 0, cx: r.x + r.width / 2, cy: r.y + r.height / 2,
          create: /^Open PR/.test(t) || e.classList.contains('pr-link-create'), readyToPush: /ready to push/i.test(ti) || e.classList.contains('primed') };
      }))()`);
    },
    async click(cx, cy) {
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseMoved', x: cx, y: cy });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mousePressed', x: cx, y: cy, button: 'left', clickCount: 1 });
      await cdp.send('Input.dispatchMouseEvent', { type: 'mouseReleased', x: cx, y: cy, button: 'left', clickCount: 1 });
      await sleep(120);
    },
    /** Trusted click on a rendered tab by label; hit-tests first so a covered button fails loudly. */
    async clickTab(label) {
      const t = (await api.tabs()).find((x) => x.label === label);
      if (!t || !t.visible) throw new Error(`tab '${label}' not rendered`);
      const hit = await cdp.eval(`(() => { const e = document.elementFromPoint(${t.cx}, ${t.cy}); const b = e && e.closest('.tab'); return b ? b.textContent.trim() : null; })()`);
      if (!hit || !hit.startsWith(label)) throw new Error(`hit-test for '${label}' landed on '${hit}'`);
      await api.click(t.cx, t.cy);
      await waitFor(`tab '${label}' active`, async () => (await api.tabs()).find((x) => x.label === label)?.active, 5000, 100);
    },
    async shot(name, clip) {
      const r = await cdp.send('Page.captureScreenshot', { format: 'png', ...(clip ? { clip: { ...clip, scale: 1 } } : {}) }, 15000);
      const file = path.join(app.home, `${name}.png`);
      fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
      return file;
    },
    /** Composed-window oracle: the compositor's own capture (grim on MY display), not the renderer's. */
    grim(name) {
      const file = path.join(app.home, `${name}.png`);
      execFileSync('grim', ['-o', 'HEADLESS-1', file], { env: { PATH: '/usr/bin:/bin', XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR, WAYLAND_DISPLAY: RIG.wayland }, timeout: 15000 });
      return file;
    },
    async close() {
      const pids = descendants(app.pid).map((p) => ({ p, s: procStart(p) }));
      app.cdp?.close();
      try { process.kill(app.pid, 'SIGTERM'); } catch { /* gone */ }
      await waitFor('electron exit', () => app.exited, 8000, 200).catch(() => { try { process.kill(app.pid, 'SIGKILL'); } catch { /* */ } });
      await sleep(500);
      // Survivors, by (pid,start-time) so a recycled pid is never signalled.
      for (const { p, s } of pids) if (procStart(p) === s && s !== null) { try { process.kill(p, 'SIGKILL'); } catch { /* */ } }
      // Anything else still carrying THIS boot's ORCHESTRA_HOME in its env (detached daemons).
      for (const d of fs.readdirSync('/proc')) {
        if (!/^\d+$/.test(d)) continue;
        try { if (procEnv(d).ORCHESTRA_HOME === app.home) process.kill(Number(d), 'SIGKILL'); } catch { /* not ours / gone */ }
      }
    },
  };
  return api;
}

const md5f = (f) => crypto.createHash('md5').update(fs.readFileSync(f)).digest('hex').slice(0, 12);
/** Read off the build on disk — printed before ANY arm, including the no-boot ones. */
function staticIdentity(appDir = APP_DIR) {
  const pkgVersion = JSON.parse(fs.readFileSync(path.join(appDir, 'package.json'), 'utf8')).version;
  const chunk = (fs.readFileSync(path.join(appDir, 'dist-electron/main.js'), 'utf8').match(/require\(["']\.\/([^"']+)["']\)/) ?? [])[1];
  let gitInfo = 'no-git';
  try {
    const sha = execFileSync('git', ['-C', appDir, 'rev-parse', '--short=8', 'HEAD'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const dirty = execFileSync('git', ['-C', appDir, 'status', '--porcelain', '--untracked-files=no'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split('\n').filter(Boolean).length;
    gitInfo = `${sha}${dirty ? `+${dirty}dirty` : ''}`;
  } catch { /* not a git checkout */ }
  const assets = path.join(appDir, 'dist/assets');
  const rendererFiles = fs.existsSync(assets) ? fs.readdirSync(assets).filter((f) => /^index-.*\.js$/.test(f)).map((f) => `${f}:${md5f(path.join(assets, f))}`) : [];
  return { pkgVersion, chunk, gitInfo, rendererFiles, mainMd5: chunk ? md5f(path.join(appDir, 'dist-electron', chunk)) : '?' };
}
/** Printed FIRST, before any clause of the arm: what is actually running. */
async function identityAndIsolation(ctx, app) {
  const runningVersion = await app.cdp.eval('window.orchestra.getAppVersion()');
  const sid = staticIdentity(); const pkgVersion = sid.pkgVersion;
  const scripts = await app.cdp.eval(`[...document.scripts].map(s => s.src).filter(Boolean)`);
  const paths = scripts.map((u) => decodeURIComponent(new URL(u).pathname));
  const bundle = paths.find((p) => p.includes('/assets/index-') && p.endsWith('.js')) ?? paths[0] ?? '';
  console.log(`IDENTITY  arm=${ctx.arm} mode=${MODE} app-dir=${APP_DIR} git=${sid.gitInfo} version(running)=${runningVersion} version(package.json)=${pkgVersion}`);
  console.log(`          target-url=${app.target.url}`);
  console.log(`          loaded-renderer-bundle=${path.basename(bundle)} md5=${md5f(bundle)}  main=${sid.chunk ?? '?'} md5=${sid.mainMd5}  electron=${app.electron}`);
  ctx.clause('identity/version', runningVersion === pkgVersion, `running=${runningVersion} package.json=${pkgVersion}`);
  ctx.clause('identity/target-is-this-build', app.target.url.includes(APP_DIR) && !app.target.url.includes('app.asar'), app.target.url);

  // isolation: read back from the RUNNING child, not from the array we built
  const live = procEnv(app.pid);
  const g = checkChildEnv(live, RIG.wayland);
  ctx.clause(`isolation/${g.clause}`, g.ok, `(read back from /proc/${app.pid}/environ) ${g.detail}`);
  ctx.clause('isolation/orchestra-home', live.ORCHESTRA_HOME === app.home && !app.home.startsWith(path.join(REAL_HOME, '.orchestra') + path.sep) && live.ORCHESTRA_HOME !== path.join(REAL_HOME, '.orchestra'),
    `ORCHESTRA_HOME=${live.ORCHESTRA_HOME} (rule: must equal this boot's home ${app.home} and must not be, or sit under, ${path.join(REAL_HOME, '.orchestra')} — a rig base under ~/.orchestra is refused)`);
  const fstype = execFileSync('findmnt', ['-no', 'FSTYPE', '-T', app.home], { encoding: 'utf8' }).trim();
  ctx.clause('isolation/home-not-tmpfs', fstype !== 'tmpfs' && !app.home.startsWith('/tmp/'), `fstype=${fstype}`);
  const inSway = await waitFor('app window in MY sway tree', () => {
    try {
      const tree = execFileSync('swaymsg', ['-t', 'get_tree'], { env: { PATH: '/usr/bin:/bin', SWAYSOCK: RIG.swaysock }, encoding: 'utf8' });
      const has = (n) => n.pid === app.pid || (n.nodes ?? []).some(has) || (n.floating_nodes ?? []).some(has);
      return has(JSON.parse(tree)) ? true : null;
    } catch { return null; }
  }, 20000, 500).catch(() => false);
  ctx.clause('isolation/window-in-my-sway', inSway, `app pid ${app.pid} in get_tree of SWAYSOCK=${RIG.swaysock}`);
  const scratch = checkScratchConfig(app.world.account.configDir, liveDirs(), app.home);
  ctx.clause(`isolation/${scratch.clause}`, scratch.ok && app.world.ws.accountId === app.world.account.id && live.CLAUDE_CONFIG_DIR === app.world.account.configDir,
    `seeded configDir=${app.world.account.configDir} child CLAUDE_CONFIG_DIR(read back)=${live.CLAUDE_CONFIG_DIR} live dirs protected=${liveDirs().join(',')}`);
}

/** After teardown: the invoker's live config dirs must be exactly as before the boot (review F1). */
function liveCheck(ctx, app) {
  liveVerdict(ctx, 'isolation/live-config-untouched', app.liveBefore);
}
/** Build freshness (review F2): identity/version compares the app with the SAME package.json, so it
 *  cannot see a stale dist/. A src file (or package.json) newer than the OLDEST build artifact = stale. */
function distFreshness(appDir = APP_DIR) {
  const walk = (d, out = []) => {
    for (const e of fs.readdirSync(d, { withFileTypes: true })) {
      if (e.name === 'node_modules') continue;
      const f = path.join(d, e.name);
      if (e.isDirectory()) walk(f, out); else if (!/\.test\.ts$/.test(e.name)) out.push(f);
    }
    return out;
  };
  const srcDir = path.join(appDir, 'src');
  if (!fs.existsSync(srcDir)) return { ok: false, detail: 'no src/ under <app-dir> — cannot prove dist/ is fresh (checkout builds only)' };
  const srcFiles = [...walk(srcDir), ...['package.json', 'index.html', 'vite.config.ts'].map((f) => path.join(appDir, f)).filter((f) => fs.existsSync(f))];
  const newest = srcFiles.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).reduce((a, b) => (b.t > a.t ? b : a));
  const sid = staticIdentity(appDir);
  const arts = [path.join(appDir, 'dist/index.html'), path.join(appDir, 'dist-electron/main.js'), path.join(appDir, 'dist-electron', sid.chunk ?? 'main.js'),
    ...sid.rendererFiles.map((x) => path.join(appDir, 'dist/assets', x.split(':')[0]))].filter((f) => fs.existsSync(f));
  const oldest = arts.map((f) => ({ f, t: fs.statSync(f).mtimeMs })).reduce((a, b) => (b.t < a.t ? b : a));
  const ok = newest.t <= oldest.t;
  const rel = (f) => path.relative(appDir, f);
  return { ok, detail: `newest source ${rel(newest.f)} @${new Date(newest.t).toISOString()} ${ok ? '<=' : '> NEWER THAN'} oldest build artifact ${rel(oldest.f)} @${new Date(oldest.t).toISOString()}${ok ? '' : ' — dist/ is STALE: rebuild (npx vite build) or pass --allow-stale'}` };
}
/** The seeded workspace is auto-activated at boot; wait until its toolbar tabs are rendered. */
async function ready(app) {
  await waitFor('toolbar tabs rendered', async () => (await app.tabs()).length > 0, 30000, 300).catch(async (e) => {
    throw new Error(`${e.message} — DOM: ${await app.cdp.eval('document.body.innerText.slice(0,300)')}`);
  });
}

// ── arms ─────────────────────────────────────────────────────────────────────
const kindsOf = (ps) => ps.reduce((m, p) => ((m[p.kind] = (m[p.kind] ?? 0) + 1), m), {});
const fmtP = (ps) => (ps.length ? ps.map((p) => `${p.ptyId}[${p.kind}]`).join(',') : '∅');

/** Positive control: the Run tab → ▶ Run must make a run-kind PTY appear. Idempotent per boot. */
async function runControl(ctx) {
  const { app } = ctx; const wsId = app.world.ws.id;
  if (ctx.controls.run) return true;
  const pre = await app.ptys();
  let post = null, why = '';
  try {
    await app.clickTab('Run');
    const btn = await waitFor('▶ Run button', () => app.cdp.eval(`(() => { const b = document.querySelector('.run-action.start'); if (!b) return null; const r = b.getBoundingClientRect(); return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; })()`), 10000);
    await app.click(btn.cx, btn.cy);
    post = await waitFor(`run-kind PTY ${wsId}:run`, async () => { const ps = await app.ptys(); return ps.some((p) => p.ptyId === `${wsId}:run` && p.kind === 'run') ? ps : null; }, 15000, 250);
  } catch (e) { why = e.message; }
  const fired = !!post && !pre.some((p) => p.ptyId === `${wsId}:run`);
  ctx.clause('control/run-pty-appears', fired, `pre=${fmtP(pre)} -> post=${post ? fmtP(post) : `NO run PTY appeared (${why})`}`);
  ctx.controls.run = fired;
  return fired;
}
/** A "no agent PTY" claim: REFUSED unless the positive control fired in this boot. */
function noAgentPty(ctx, name, ps, already = new Set()) {
  if (!ctx.controls.run) return ctx.clause(name, false, 'REFUSED: Run-tab positive control did not fire in this boot — the listing is unproven');
  // `already` = agent PTYs that existed BEFORE the step under test (V1: a per-tab claim is about what THAT tab created).
  const created = ps.filter((p) => p.kind === 'agent' && !already.has(p.ptyId));
  return ctx.clause(name, created.length === 0, `agent-kind PTYs created by this step=${created.length}${already.size ? ` (pre-existing ${[...already].join(',')} excluded)` : ''} (${fmtP(ps)})`);
}

/** True if any OTHER live process references `dir` in its argv or environment (a running rig owns it). */
function referencedByLiveProcess(dir) {
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    for (const f of ['cmdline', 'environ']) { try { if (fs.readFileSync(`/proc/${d}/${f}`, 'latin1').includes(dir)) return true; } catch { /* not ours / gone */ } }
  }
  return false;
}
/** Sibling-safe prune (S3/F3/F5): delete ONLY `e2e64c-<pid>` dirs that (a) carry THIS INVOKER's owner marker (RIG_OWNER), (b) are older than
 *  24 h, (c) are unreferenced by any live process, (d) have no KEEP marker (a failed or crashed run), and never this
 *  invocation's own dir. Everything else — other rigs' dirs, younger dirs, in-use dirs, forensics — stays. */
const OWNER_MARKER = '.avr-rig-owner';   // written into every rig dir THIS invoker creates; its CONTENT is the invoker identity below
// Per-invoker identity (F5): the realpath of the worktree that holds THESE scripts. Every agent runs the rig from its own
// worktree, so another agent's clean dirs (whose screenshots a ledger comment may cite) never match and are never pruned.
/** realpath of the worktree holding this module, from a file: URL. `fileURLToPath` (NOT `new URL().pathname`, which stays
 *  percent-encoded: a path with a space resolved to nothing and every such invoker shared one 'unknown' owner). null = no identity. */
function ownerFromModuleUrl(url) { try { return fs.realpathSync(path.resolve(path.dirname(fileURLToPath(url)), '..')); } catch { return null; } }
const RIG_OWNER = ownerFromModuleUrl(import.meta.url);
const KEEP_MARKER = 'KEEP-UNTIL-CLEAN';  // written at start, removed only when the invocation ends with 0 FAIL: crashed/failed runs keep their forensics
function pruneStaleRigDirs(base, own, { now = Date.now(), maxAgeMs = 24 * 3600e3, inUse = referencedByLiveProcess, owner = RIG_OWNER } = {}) {
  const removed = [], kept = [];
  if (!owner) return { removed, kept, disabled: true }; // no invoker identity => prune NOTHING (fail closed: never a shared 'unknown' owner)
  for (const n of fs.readdirSync(base)) {
    if (!/^e2e64c-\d+$/.test(n)) continue;
    const d = path.join(base, n);
    if (own && path.resolve(d) === path.resolve(own)) { kept.push([n, 'own']); continue; }
    let mark = null; try { mark = fs.readFileSync(path.join(d, OWNER_MARKER), 'utf8').trim(); } catch { /* no marker */ }
    if (mark !== owner) { kept.push([n, 'not ours']); continue; } // no marker (another rig's dir) OR another invoker's marker
    if (fs.existsSync(path.join(d, KEEP_MARKER))) { kept.push([n, 'failed/incomplete run — forensics']); continue; }
    if (now - fs.statSync(d).mtimeMs < maxAgeMs) { kept.push([n, 'younger than 24 h']); continue; }
    if (inUse(d)) { kept.push([n, 'in use']); continue; }
    fs.rmSync(d, { recursive: true, force: true }); removed.push(n);
  }
  return { removed, kept };
}

/** Retention (F4): a boot whose arm fully PASSED drops its bulky state (profile, repo, worktree, scratch
 *  config) and keeps `app.log` + screenshots; an arm with ANY FAIL/HARNESS-ERROR keeps everything for forensics. */
function retain(ctx, app, { base = RIG.base, results = RESULTS } = {}) {
  if (!app?.home || !app.home.startsWith(base + path.sep)) return;
  if (!results.filter((r) => r.arm === ctx.arm).every((r) => r.ok)) { console.log(`RETAIN    ${app.home} kept whole for forensics (arm ${ctx.arm} has a FAIL)`); return; }
  for (const d of ['userData', 'home', 'repo', 'wt', 'claude-config', 'stub-bin']) fs.rmSync(path.join(app.home, d), { recursive: true, force: true });
  console.log(`RETAIN    ${app.home}: arm ${ctx.arm} PASSED — state deleted, kept app.log + screenshots`);
}

/** #228: run the SHIPPED CLI form — `electron . cli <args>`, the dual-mode entry the AppImage/`orchestra` shim execs — against THIS boot's socket.
 *  ALLOWLIST env (never the invoker's): ORCHESTRA_HOME pins the socket pointer to this boot, ORCHESTRA_SOCK/ORCHESTRA_WS_ID are absent, DISPLAY unset,
 *  WAYLAND_DISPLAY = my marker-verified sway; every path is refused (named) unless inside the boot home (same guards as the app launch). */
function cliRun(app, args) {
  const env = {
    PATH: '/usr/bin:/bin', HOME: app.world.fakeHome, XDG_RUNTIME_DIR: app.env.XDG_RUNTIME_DIR,
    XDG_CONFIG_HOME: app.env.XDG_CONFIG_HOME, XDG_CACHE_HOME: app.env.XDG_CACHE_HOME,
    WAYLAND_DISPLAY: RIG.wayland, ELECTRON_OZONE_PLATFORM_HINT: 'wayland', LANG: 'C.UTF-8',
    ORCHESTRA_HOME: app.home, CLAUDE_CONFIG_DIR: app.world.account.configDir,
  };
  const pre = checkChildEnv(env, RIG.wayland);
  if (!pre.ok) throw new Error(`REFUSED before CLI launch [${pre.clause}]: ${pre.detail}`);
  const hand = checkHandOff(env, [app.world.account], app.home);
  if (!hand.ok) throw new Error(`REFUSED before CLI launch [${hand.clause}]: ${hand.detail}`);
  const r = spawnSync(app.electron, ['.', 'cli', ...args], { cwd: APP_DIR, env, encoding: 'utf8', timeout: 60000 });
  return { status: r.status, signal: r.signal, stdout: r.stdout ?? '', stderr: r.stderr ?? '' };
}
const readText = (f) => { try { return fs.readFileSync(f, 'utf8'); } catch { return ''; } };
/** The app's own diagnostic log (`<ORCHESTRA_HOME>/logs/orchestra.log`). */
const appLog = (app) => readText(path.join(app.home, 'logs', 'orchestra.log'));
/** Every `claude` start the stub recorded, from ANY launcher: [{pid, argv[]}]. */
const stubStarts = (app) => readText(app.world.stubLog).split('\n').filter(Boolean).map((l) => { const [pid, ...argv] = l.split(' '); return { pid: Number(pid), argv, line: l }; });
/** The starts that are a SESSION (agent PTY / SDK keeper CLI): the app also runs `claude --version` at boot as a probe (MEASURED: 1 start, argv exactly `--version`). */
const sessionStarts = (app) => stubStarts(app).filter((x) => !(x.argv.length === 1 && x.argv[0] === '--version'));
/** The resume target a `claude` argv names, in BOTH spellings — the SDK passes `--resume=<id>` (MEASURED), the terminal path `--continue`. */
function resumeOf(argv) {
  const i = argv.findIndex((a) => a === '--resume' || a.startsWith('--resume='));
  const target = i < 0 ? null : argv[i].includes('=') ? argv[i].slice(argv[i].indexOf('=') + 1) : (argv[i + 1] ?? '');
  return { resume: i >= 0, target, continue: argv.includes('--continue') };
}
const listWs = (app) => app.cdp.eval('window.orchestra.listWorkspaces()');
/** Positive control for every arm that claims "a session did / did NOT start": the app installs `dist-electron/keeper.js` at boot; without it NO SDK session can
 *  start, so a "no session started" claim passes vacuously (review #228 F2: a vite-only build left `legacy_restart_fresh` fully green). */
const keeperControl = (ctx) => { const f = path.join(ctx.app.home, 'bin', 'keeper.js'); return ctx.clause('env/keeper-runtime-installed', fs.existsSync(f), `${path.relative(ctx.app.home, f)} ${fs.existsSync(f) ? 'installed at boot' : 'ABSENT — no SDK session can start here, so every session-start claim below is unproven (build with pnpm run build:bundles)'}`); };
// ── #226 helpers: drive the Agent view like a user, and the REAL CLI against this boot's socket ──────────────
/** Trusted click on a sidebar row by (unique) workspace name; asserts the row became active. */
async function activateWorkspace(app, name) {
  const row = await waitFor(`sidebar row '${name}'`, () => app.cdp.eval(`(() => { const e = [...document.querySelectorAll('.ws-item')].find(x => x.textContent.includes(${JSON.stringify(name)})); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? { cx: r.x + r.width / 2, cy: r.y + r.height / 2 } : null; })()`), 15000);
  await app.click(row.cx, row.cy);
  await waitFor(`'${name}' active`, () => app.cdp.eval(`[...document.querySelectorAll('.ws-item.active')].some(x => x.textContent.includes(${JSON.stringify(name)}))`), 8000, 100);
}
/** Open the Agent-view tab of the active workspace. Whichever label the build renders (Structured today, Agent after #230):
 *  this arm is about the START refusal, not the tab rename, so a build that has not renamed yet must still reach its clauses. */
async function openAgentTab(app) {
  const labels = (await app.tabs()).map((t) => t.label);
  const label = ['Agent', 'Structured'].find((l) => labels.includes(l));
  if (!label) throw new Error(`no Agent-view tab (Agent|Structured) in ${JSON.stringify(labels)}`);
  await app.clickTab(label);
}
/** Type into the VISIBLE composer through trusted input and press Enter (the real send path). Returns pre/post composer text. */
async function composerSend(app, text) {
  const box = await waitFor('visible composer', () => app.cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return { cx: r.x + r.width / 2, cy: r.y + r.height / 2 }; } return null; })()`), 15000);
  await app.click(box.cx, box.cy);
  await app.cdp.send('Input.insertText', { text });
  const visibleText = () => app.cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return e.innerText; } return null; })()`);
  const pre = await visibleText();
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13, text: '\r' });
  await app.cdp.send('Input.dispatchKeyEvent', { type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13, nativeVirtualKeyCode: 13 });
  // A REFUSED send clears the composer and then RESTORES it (r2 L1), so "cleared" is a transient: poll fast for ~3 s, remember whether it was ever seen.
  let sawCleared = false, last = pre;
  const t0 = Date.now();
  while (Date.now() - t0 < 3000) { const t = await visibleText(); if (t !== null) { last = t; if (!t.includes(text)) sawCleared = true; } await sleep(20); }
  return { pre, sawCleared, final: last, post: sawCleared ? last : null };
}
/** Current text of the VISIBLE composer (placeholder text when empty). */
const composerText = (app) => app.cdp.eval(`(() => { for (const e of document.querySelectorAll('.cm-content')) { const r = e.getBoundingClientRect(); if (r.width > 50 && r.height > 5) return e.innerText; } return null; })()`);
/** Text of the VISIBLE message list, plus its error rows and user rows (DOM oracle; the screenshot is the paint oracle). */
const messageRows = (app) => app.cdp.eval(`(() => { for (const l of document.querySelectorAll('.av-message-list')) { const r = l.getBoundingClientRect(); if (r.width > 50 && r.height > 50) return { errors: [...l.querySelectorAll('.av-message-error')].map(e => e.innerText), users: [...l.querySelectorAll('.av-message-user')].map(e => e.innerText) }; } return null; })()`);
/** The REAL `orchestra` CLI (dist-electron/cli.js under plain node) against THIS boot's socket, allowlist env only. */
function runCli(app, args, ms = 60000) {
  const cli = path.join(APP_DIR, 'dist-electron/cli.js');
  if (!fs.existsSync(cli)) throw new Error(`${cli} missing — build the CLI (pnpm run build:cli) in <app-dir>`);
  const sock = fs.readFileSync(path.join(app.home, 'sock'), 'utf8').trim();
  const env = { PATH: `${app.world.stubDir}:/usr/local/bin:/usr/bin:/bin`, HOME: app.world.fakeHome, ORCHESTRA_HOME: app.home, ORCHESTRA_SOCK: sock, LANG: 'C.UTF-8' };
  return new Promise((resolve) => {
    const c = spawn(process.execPath, [cli, ...args], { env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    c.stdout.on('data', (d) => (out += d)); c.stderr.on('data', (d) => (err += d));
    const t = setTimeout(() => { c.kill('SIGKILL'); }, ms);
    c.on('close', (rc) => { clearTimeout(t); resolve({ rc, stdout: out.trim(), stderr: err.trim() }); });
  });
}
/** `ws.sdkRestarts` length as the RUNNING app's store holds it (a refused restart must not grow it — F5). */
const restartsOf = (app, id) => app.cdp.eval(`window.orchestra.listWorkspaces().then(l => (l.find(w => w.id === ${JSON.stringify(id)}) || {}).sdkRestarts?.length ?? 0)`);
/** Drive an IPC method that may reject: `{ ok, value|message }` (Electron prefixes the remote error text — clauses match a substring). */
const ipcSettle = (app, expr, ms = 30000) => Promise.race([
  app.cdp.eval(`(${expr}).then(v => ({ ok: true, value: v }), e => ({ ok: false, message: String((e && e.message) || e) }))`),
  new Promise((r) => setTimeout(() => r({ ok: false, message: `TIMEOUT ${ms}ms` }), ms)),
]);
/** One-line message that must name the pause AND the follow-up ticket (all three parts, literal). */
const namesPause = (t) => /paused/i.test(t ?? '') && (t ?? '').includes('#220') && (t ?? '').includes('Reconcile sandbox agents with the Agent view');
const oneLine = (t, n = 200) => String(t ?? '').replace(/\s+/g, ' ').slice(0, n);

const ARMS = [
  {
    name: 'guard_selftest', boots: false, ticket: '#225',
    doc: 'isolation guard can FAIL: wayland-1 / sibling display / X11 DISPLAY / unset each refused with the NAMED clause; a good env passes',
    async run(ctx) {
      const mine = 'wayland-7';
      const cases = [
        [{ WAYLAND_DISPLAY: 'wayland-1' }, 'refuse-wayland-1', false],
        [{ WAYLAND_DISPLAY: 'wayland-1' }, 'refuse-wayland-1', false, 'wayland-1'], // mine==wayland-1: the refusal must STILL fire first
        [{ WAYLAND_DISPLAY: 'wayland-3' }, 'not-my-compositor', false],
        [{ WAYLAND_DISPLAY: mine, DISPLAY: ':0' }, 'x11-display-set', false],
        [{}, 'no-wayland-display', false],
        [{ WAYLAND_DISPLAY: mine }, 'display-isolated', true],
      ];
      for (const [env, want, ok, m] of cases) {
        const r = checkChildEnv(env, m ?? mine);
        ctx.clause(`${want}${m ? '-even-if-mine' : ''}`, r.ok === ok && r.clause === want, `forced ${JSON.stringify(env)} -> ok=${r.ok} clause=${r.clause}`);
      }
    },
  },
  {
    name: 'pixel_selftest', boots: false, ticket: '#225',
    doc: 'the PNG instrument can tell blank from painted: encode PNGs using every filter type, decode them exactly, and apply the SAME painted-vs-blank predicate the content arm gates on',
    async run(ctx) {
      const paeth = (a, b, c) => { const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c); return pa <= pb && pa <= pc ? a : pb <= pc ? b : c; };
      const enc = (w, h, pix, filters) => {
        const stride = w * 3, rows = [];
        for (let y = 0; y < h; y++) {
          const f = filters[y % filters.length]; rows.push(Buffer.from([f]));
          const row = Buffer.alloc(stride);
          for (let x = 0; x < stride; x++) {
            const a = x >= 3 ? pix[y * stride + x - 3] : 0, b = y ? pix[(y - 1) * stride + x] : 0, c = x >= 3 && y ? pix[(y - 1) * stride + x - 3] : 0;
            const pred = f === 0 ? 0 : f === 1 ? a : f === 2 ? b : f === 3 ? (a + b) >> 1 : paeth(a, b, c);
            row[x] = (pix[y * stride + x] - pred) & 255;
          }
          rows.push(row);
        }
        const chunk = (t, d) => { const h4 = Buffer.alloc(8); h4.writeUInt32BE(d.length, 0); h4.write(t, 4, 'latin1'); const crc = Buffer.alloc(4); crc.writeUInt32BE(zlib.crc32(Buffer.concat([h4.subarray(4), d])) >>> 0); return Buffer.concat([h4, d, crc]); };
        const ihdr = Buffer.alloc(13); ihdr.writeUInt32BE(w, 0); ihdr.writeUInt32BE(h, 4); ihdr[8] = 8; ihdr[9] = 2;
        return Buffer.concat([Buffer.from('89504e470d0a1a0a', 'hex'), chunk('IHDR', ihdr), chunk('IDAT', zlib.deflateSync(Buffer.concat(rows))), chunk('IEND', Buffer.alloc(0))]);
      };
      // (1) exact round-trip over all five filter types on non-trivial pixels
      const w = 9, h = 10, pix = Buffer.alloc(w * h * 3); let seed = 12345;
      for (let i = 0; i < pix.length; i++) { seed = (seed * 1103515245 + 12345) & 0x7fffffff; pix[i] = seed >> 16 & 255; }
      const back = decodePng(enc(w, h, pix, [0, 1, 2, 3, 4]));
      ctx.clause('decode-roundtrip-all-filters', back.w === w && back.h === h && Buffer.compare(back.px, pix) === 0, `${w}x${h} pseudo-random pixels, filters 0-4 cycled: exact=${Buffer.compare(back.px, pix) === 0}`);
      // (2) blank frame reads exactly blank; (3) a frame with 5 painted 2x2 blocks reads exactly 5%
      const flat = (n, fill) => { const b = Buffer.alloc(20 * 20 * 3); for (let i = 0; i < b.length; i += 3) { b[i] = fill[0]; b[i + 1] = fill[1]; b[i + 2] = fill[2]; } return b; };
      const blankPx = flat(20, [26, 31, 38]), paintedPx = Buffer.from(blankPx);
      [[0, 0, [255, 0, 0]], [4, 4, [0, 255, 0]], [8, 8, [0, 0, 255]], [12, 12, [255, 255, 0]], [16, 16, [0, 255, 255]]].forEach(([x0, y0, c]) => { for (let y = y0; y < y0 + 2; y++) for (let x = x0; x < x0 + 2; x++) paintedPx.set(c, (y * 20 + x) * 3); });
      const B = pngStats(enc(20, 20, blankPx, [1, 4])), C = pngStats(enc(20, 20, paintedPx, [2, 3]));
      ctx.clause('blank-reads-blank', B.distinct === 1 && B.nonBgPct === 0, `distinct=${B.distinct} nonBg=${B.nonBgPct}%`);
      ctx.clause('painted-reads-painted', C.distinct === 6 && C.nonBgPct === 5, `distinct=${C.distinct} nonBg=${C.nonBgPct}% (5 blocks of 4px in 400 = 5%)`);
      ctx.clause('predicate-accepts-painted', paintedBeyondBlank(C, B) === true, 'painted vs blank -> true');
      ctx.clause('predicate-rejects-blank', paintedBeyondBlank(B, B) === false && paintedBeyondBlank(B, C) === false, 'blank vs blank -> false, blank vs painted -> false (a no-op frame cannot pass)');
      let threw = ''; try { decodePng(Buffer.from('not a png at all, sorry')); } catch (e) { threw = e.message; }
      ctx.clause('garbage-rejected', threw === 'not a PNG', `decodePng(garbage) threw '${threw}'`);
    },
  },
  {
    name: 'live_guard_selftest', boots: false, ticket: '#225',
    doc: 'the live-config protections can FAIL: the scratch-dir refusal names its clause; the before/after snapshot flags every inheritance rewrite and ignores unrelated writes',
    async run(ctx) {
      const root = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-live-selftest-'));
      try {
        const mk = (p, c = '') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, c); return p; };
        const live = path.join(root, 'live'), home = path.join(root, 'boot-home'), other = path.join(root, 'elsewhere');
        for (const d of [live, path.join(live, 'sub'), home, other]) fs.mkdirSync(d, { recursive: true });
        const g = (cfg) => checkScratchConfig(cfg, [live], home);
        const scratch = path.join(home, 'claude-config'); fs.mkdirSync(scratch, { recursive: true });
        const cases = [
          [live, 'is-live-config', false], [path.join(live, 'sub'), 'overlaps-live-config', false], [root, 'overlaps-live-config', false],
          [other, 'outside-boot-home', false], [scratch, 'scratch-config', true],
        ];
        for (const [cfg, want, ok] of cases) { const r = g(cfg); ctx.clause(`scratch-guard:${want}${ok ? '' : ':refused'}`, r.ok === ok && r.clause === want, `configDir=${path.relative(root, cfg) || '.'} -> ok=${r.ok} clause=${r.clause}`); }
        // F2: symlinks are resolved (a path that READS as scratch but lands in a live dir), and a `<home>-sibling` prefix is NOT inside home
        const linkLive = path.join(home, 'link-to-live'); fs.symlinkSync(live, linkLive);
        const linkOut = path.join(home, 'link-to-elsewhere'); fs.symlinkSync(other, linkOut);
        const sibHome = `${home}-sibling`; fs.mkdirSync(path.join(sibHome, 'cfg'), { recursive: true });
        for (const [label, cfg, want] of [['symlink-into-live-dir', linkLive, 'is-live-config'], ['symlink-to-outside-dir', linkOut, 'outside-boot-home'], ['home-prefix-sibling', path.join(sibHome, 'cfg'), 'outside-boot-home']]) {
          const r = g(cfg); ctx.clause(`scratch-guard:${label}:refused`, !r.ok && r.clause === want, `${path.relative(root, cfg)} -> ok=${r.ok} clause=${r.clause} (want ${want})`);
        }
        // F4: one bad ~/.claude-* entry must not hide later siblings
        const fh = path.join(root, 'fake-home'); fs.mkdirSync(path.join(fh, '.claude-a'), { recursive: true }); fs.mkdirSync(path.join(fh, '.claude-c'), { recursive: true });
        fs.symlinkSync(path.join(root, 'no-such-target'), path.join(fh, '.claude-b')); fs.mkdirSync(path.join(fh, '.claude-x-noise-not-prefixed-dash'), { recursive: true });
        let sibs = []; try { sibs = claudeSiblingDirs(fh).map((d) => path.basename(d)); } catch (e) { sibs = [`<claudeSiblingDirs THREW ${e.code ?? e.message}>`]; }
        ctx.clause('sibling-discovery-survives-a-dangling-entry', sibs.includes('.claude-a') && sibs.includes('.claude-c') && !sibs.includes('.claude-b'), `a=dir, b=dangling symlink, c=dir -> ${JSON.stringify(sibs.filter((n) => !n.includes('noise')))} (b skipped ALONE, c kept)`);
        // a live-like config dir: 2 symlinks (one under skills/), a manifest, .claude.json with mcpServers
        const glob = path.join(root, 'global');
        mk(path.join(glob, 'settings.json'), '{}'); mk(path.join(glob, 'x', 'SKILL.md'), 'x');
        const setup = () => {
          fs.rmSync(live, { recursive: true, force: true }); fs.mkdirSync(path.join(live, 'skills'), { recursive: true });
          fs.symlinkSync(path.join(glob, 'settings.json'), path.join(live, 'settings.json'));
          fs.symlinkSync(path.join(glob, 'x'), path.join(live, 'skills', 'x'));
          mk(path.join(live, '.orchestra-inherited.json'), '{"symlinks":["settings.json","skills/x"],"mcpServers":["a"]}');
          mk(path.join(live, '.claude.json'), JSON.stringify({ numStartups: 1, mcpServers: { a: {}, b: {} } }));
        };
        setup(); const S0 = liveSnapshot(live);
        ctx.clause('snapshot-stable-when-untouched', liveSnapshot(live) === S0, 'two reads of an untouched dir agree (no spurious diff)');
        mk(path.join(live, '.claude.json'), JSON.stringify({ numStartups: 99, mcpServers: { a: {}, b: {} }, projects: { p: 1 } })); mk(path.join(live, 'history.jsonl'), 'x'); mk(path.join(live, 'sessions', 's.json'), '{}');
        ctx.clause('snapshot-ignores-unrelated-writes', liveSnapshot(live) === S0, 'numStartups/projects/history/sessions changed -> same snapshot (the invoker\'s own claude writes these)');
        const mutants = [
          ['unlink-top-level-symlink', () => fs.unlinkSync(path.join(live, 'settings.json'))],
          ['unlink-skills-symlink', () => fs.unlinkSync(path.join(live, 'skills', 'x'))],
          ['rewrite-manifest', () => mk(path.join(live, '.orchestra-inherited.json'), '{"symlinks":[],"mcpServers":[]}')],
          ['drop-mcp-server', () => mk(path.join(live, '.claude.json'), JSON.stringify({ mcpServers: { b: {} } }))],
        ];
        for (const [name, mutate] of mutants) { setup(); const base = liveSnapshot(live); mutate(); ctx.clause(`snapshot-detects:${name}`, liveSnapshot(live) !== base, `${name} -> snapshot changed`); }
        // S4: direction. Removals FAIL, additions-only is EXTERNAL (a live-app re-sync), identical is same.
        setup(); const full = liveSnapshot(live);
        fs.unlinkSync(path.join(live, 'settings.json')); fs.unlinkSync(path.join(live, 'skills', 'x')); mk(path.join(live, '.orchestra-inherited.json'), '{"symlinks":[],"mcpServers":[]}'); mk(path.join(live, '.claude.json'), '{"mcpServers":{}}');
        const stripped = liveSnapshot(live);
        const cls = (x, y) => classifySnapshotChange(x, y);
        ctx.clause('classify:strip-is-removals', cls(full, stripped).kind === 'removals', `full -> stripped = ${cls(full, stripped).kind} (-${cls(full, stripped).removed.length})`);
        ctx.clause('classify:restore-is-additions', cls(stripped, full).kind === 'additions' && cls(stripped, full).removed.length === 0, `stripped -> full = ${cls(stripped, full).kind} (+${cls(stripped, full).added.length}, -${cls(stripped, full).removed.length}) — the live app re-syncing`);
        ctx.clause('classify:identical-is-same', cls(full, full).kind === 'same', 'identical -> same');
        // each removal channel in ISOLATION (a classifier that ignores one channel must not hide behind the others)
        const F0 = JSON.parse(full);
        const only = { 'mcp-only': { ...F0, mcp: F0.mcp.slice(1) }, 'manifest-only': { ...F0, manifest: '{"symlinks":[],"mcpServers":["a"]}' }, 'managed-only': { ...F0, managed: [] } };
        for (const [n, v] of Object.entries(only)) ctx.clause(`classify:${n}-loss-is-removals`, cls(full, JSON.stringify(v)).kind === 'removals', `${n}: ${cls(full, JSON.stringify(v)).kind} (-${cls(full, JSON.stringify(v)).removed.join(',-')})`);
        const swap = JSON.stringify({ ...JSON.parse(full), links: ['other -> /x'] });
        ctx.clause('classify:swap-with-a-loss-is-removals', cls(full, swap).kind === 'removals', 'a link replaced by another still LOSES the original -> removals (a mixed change never hides a removal)');
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'refuse_live_handoff', boots: false, ticket: '#225',
    doc: 'must-FAIL: a boot that would be handed the invoker\'s live config dir, ~/.claude, a ~/.claude-* sibling, the real HOME or a path outside the boot home is REFUSED (named) BEFORE any launch; nothing spawns and the live dirs are untouched',
    async run(ctx) {
      const before = Object.fromEntries(liveDirs().map((d) => [d, liveSnapshot(d)]));
      // discovered independently of liveDirs(), so a defect in liveDirs() cannot hide the sibling case behind a SKIP
      const sib = fs.readdirSync(REAL_HOME).filter((n) => n.startsWith('.claude-')).map((n) => path.join(REAL_HOME, n)).find((d) => d !== RIG.liveCfg && fs.statSync(d).isDirectory());
      const outside = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-outside-'));
      // S1/F7: SINGLE-SOURCED net — every boot below goes through `bootRefused`, which forces /bin/false at the bootApp call
      // (an ambient E2E_ELECTRON is dropped by the wrapper's `env -i`), so no case can forget it and a guard regression can
      // never start a real Electron on a real dir.
      const bootRefused = (name, opt) => bootApp(name, { ...opt, electron: '/bin/false' });
      const cfgEnv = (env) => ({ env });
      const liveOne0 = [RIG.liveCfg, path.join(REAL_HOME, '.claude')].find((d) => d && fs.existsSync(d));
      // [name, opts, wanted clause, layer]: 'seeding' = the seed-time guard, 'launch' = checkHandOff on the child env.
      const cases = [
        ['invoker-config-dir', RIG.liveCfg && fs.existsSync(RIG.liveCfg) ? { configDir: RIG.liveCfg } : null, 'is-live-config', 'seeding'],
        ['home-dot-claude', fs.existsSync(path.join(REAL_HOME, '.claude')) ? { configDir: path.join(REAL_HOME, '.claude') } : null, 'is-live-config', 'seeding'],
        ['sibling-dot-claude-star', sib ? { configDir: sib } : null, 'is-live-config', 'seeding'],
        ['outside-boot-home', { configDir: outside }, 'outside-boot-home', 'seeding'],
        // F2: <boot-home>/claude-config is a SYMLINK into a live dir — reads as scratch, resolves live (realpath must catch it)
        ['symlink-into-live-dir', liveOne0 ? { symlinkConfigTo: liveOne0 } : null, 'is-live-config', 'seeding'],
        ['real-home-as-HOME', cfgEnv({ HOME: REAL_HOME }), 'handoff:HOME:is-real-home', 'launch'],
        ['xdg-config-home-live', cfgEnv({ XDG_CONFIG_HOME: path.join(REAL_HOME, '.config') }), 'handoff:XDG_CONFIG_HOME:outside-boot-home', 'launch'],
        // ~/.cache may CONTAIN the invoker's dir (a scratch mirror lives there) => either refusal clause names this same var check
        ['xdg-cache-home-live', cfgEnv({ XDG_CACHE_HOME: path.join(REAL_HOME, '.cache') }), ['handoff:XDG_CACHE_HOME:outside-boot-home', 'handoff:XDG_CACHE_HOME:overlaps-live-config'], 'launch'],
        ['claude-config-dir-env-live', RIG.liveCfg && fs.existsSync(RIG.liveCfg) ? cfgEnv({ CLAUDE_CONFIG_DIR: RIG.liveCfg }) : null, 'handoff:CLAUDE_CONFIG_DIR:is-live-config', 'launch'],
        ['claude-config-dir-env-empty', cfgEnv({ CLAUDE_CONFIG_DIR: '' }), 'handoff:CLAUDE_CONFIG_DIR:unset', 'launch'],
        ['xdg-config-home-is-live-dir', RIG.liveCfg && fs.existsSync(RIG.liveCfg) ? cfgEnv({ XDG_CONFIG_HOME: RIG.liveCfg }) : null, 'handoff:XDG_CONFIG_HOME:is-live-config', 'launch'],
        ['xdg-cache-home-is-dot-claude', fs.existsSync(path.join(REAL_HOME, '.claude')) ? cfgEnv({ XDG_CACHE_HOME: path.join(REAL_HOME, '.claude') }) : null, 'handoff:XDG_CACHE_HOME:is-live-config', 'launch'],
        ['orchestra-home-live', cfgEnv({ ORCHESTRA_HOME: path.join(REAL_HOME, '.orchestra') }), 'handoff:ORCHESTRA_HOME:outside-boot-home', 'launch'],
      ];
      try {
        for (const [name, opt, want, layer] of cases) {
          if (!opt) { ctx.skip(`refused:${name}`, 'no such directory on this machine'); continue; }
          let msg = '';
          try { const app = await bootRefused(`refuse-${name}`, opt); await app.close(); msg = 'BOOTED (no refusal)'; } catch (e) { msg = e.message; }
          const m = msg.match(/^REFUSED before (seeding|launch) \[([^\]]+)\]/);
          const dirs = fs.readdirSync(RIG.base).filter((d) => d.startsWith(`refuse-${name}-`));
          const spawned = dirs.some((d) => fs.existsSync(path.join(RIG.base, d, 'app.log')));
          ctx.clause(`refused:${name}`, !!m && m[1] === layer && [].concat(want).some((w) => m[2].includes(w)) && !spawned, `${m ? `REFUSED before ${m[1]} [${m[2]}]` : msg.slice(0, 120)} (want ${layer} layer, clause ${[].concat(want).join(' | ')}); app.log created=${spawned}`);
        }
        // the accounts[] layer ALONE (the seed-time guard would mask it in a full boot): drive checkHandOff directly.
        const liveOne = [RIG.liveCfg, path.join(REAL_HOME, '.claude')].find((d) => d && fs.existsSync(d));
        const clean = { HOME: '/x/home', CLAUDE_CONFIG_DIR: '/x/cfg', XDG_CONFIG_HOME: '/x/c', XDG_CACHE_HOME: '/x/k', ORCHESTRA_HOME: '/x' };
        if (!liveOne) ctx.skip('refused:accounts-layer-alone', 'no live config dir exists on this machine');
        else {
          const acc = checkHandOff(clean, [{ configDir: liveOne }], '/x');
          ctx.clause('refused:accounts-layer-alone', !acc.ok && acc.clause === 'handoff:accounts[0].configDir:is-live-config', `only accounts[0].configDir=${liveOne} is live -> ok=${acc.ok} clause=${acc.clause}`);
        }
        const ok = checkHandOff(clean, [{ configDir: '/x/cfg' }], '/x');
        ctx.clause('positive-control:scratch-handoff-accepted', ok.ok, `an all-inside-boot-home hand-off is accepted (${ok.clause}) — the guard is not a constant refusal`);
      } finally { fs.rmSync(outside, { recursive: true, force: true }); }
      liveVerdict(ctx, 'live-dirs-untouched', before);
    },
  },
  {
    name: 'prune_selftest', boots: false, ticket: '#225',
    doc: 'the rig-dir prune is sibling-safe: only THIS rig\'s e2e64c-* dirs, older than 24 h, unreferenced by any live process and not marked failed/incomplete go; own, younger, in-use, other rigs\', forensics and differently-named dirs stay',
    async run(ctx) {
      const base = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-prune-selftest-'));
      const day = 24 * 3600e3, old = new Date(Date.now() - 2 * day), fresh = new Date();
      const ME = 'invoker-A', OTHER = 'invoker-B';
      const mk = (n, when, { owner = ME, keep = false } = {}) => {
        const d = path.join(base, n); fs.mkdirSync(d); fs.writeFileSync(path.join(d, 'x'), 'x');
        if (owner) fs.writeFileSync(path.join(d, OWNER_MARKER), owner);
        if (keep) fs.writeFileSync(path.join(d, KEEP_MARKER), '1');
        fs.utimesSync(d, when, when); return d;
      };
      let holder = null;
      try {
        mk('e2e64c-1001', old);                       // stale + unreferenced + owned + clean -> the ONLY one that may go
        const busy = mk('e2e64c-1002', old);          // stale but a live process names it -> keep
        mk('e2e64c-1003', fresh);                     // a sibling's recent forensics -> keep
        const own = mk('e2e64c-1004', old);           // this invocation's own dir -> keep
        mk('keepme', old);                            // not a rig dir at all -> keep
        mk('e2e64c-1005', old, { owner: false });     // another contained-rig user's dir (no owner marker) -> keep
        mk('e2e64c-1006', old, { keep: true });       // a failed/incomplete run's forensics -> keep
        mk('e2e64c-1007', old, { owner: OTHER });     // ANOTHER agent's clean, old, unreferenced dir (a ledger comment may cite its screenshots) -> keep (F5)
        mk('e2e64c-notapid', old);                    // owned + old + clean but not `e2e64c-<digits>` -> keep (pins the name regex)
        mk('e2e64c-1008x', old);                      // trailing junk after the pid -> keep
        holder = spawn('sh', ['-c', 'while :; do sleep 1; done', '_', path.join(busy, 'marker')], { stdio: 'ignore' }); // argv carries the dir; loop ends when the shell is killed
        await sleep(200);
        const r = pruneStaleRigDirs(base, own, { owner: ME });
        const left = fs.readdirSync(base).sort();
        ctx.clause('removes-only-stale-unreferenced', r.removed.join() === 'e2e64c-1001' && !left.includes('e2e64c-1001'), `removed=${JSON.stringify(r.removed)}`);
        ctx.clause('keeps-in-use', left.includes('e2e64c-1002'), 'a >24 h dir named in a live process argv survives');
        ctx.clause('keeps-younger-than-24h', left.includes('e2e64c-1003'), 'a recent sibling dir survives');
        ctx.clause('keeps-own-dir', left.includes('e2e64c-1004'), 'this invocation\'s own dir survives even when old');
        ctx.clause('keeps-non-rig-names', left.includes('keepme'), 'a differently-named dir is never touched');
        ctx.clause('keeps-other-rigs-dirs', left.includes('e2e64c-1005'), 'an e2e64c-* dir without THIS rig\'s owner marker survives (E2E_RIG_BASE=/tmp shares the pattern with every contained-rig user)');
        ctx.clause('keeps-other-agents-dirs', left.includes('e2e64c-1007'), 'an owned-marker dir of ANOTHER invoker (different worktree identity) survives even when clean, old and unreferenced');
        ctx.clause('keeps-non-pid-names', left.includes('e2e64c-notapid') && left.includes('e2e64c-1008x'), 'e2e64c-notapid and e2e64c-1008x survive: only e2e64c-<digits> is a rig dir');
        ctx.clause('keeps-failed-run-forensics', left.includes('e2e64c-1006'), 'a dir carrying KEEP-UNTIL-CLEAN (failed/crashed run) survives even when old and unreferenced');
        // F2: no invoker identity => prune NOTHING (an unmarked dir must not match a null owner).
        const base2 = path.join(base, 'no-owner-base'); fs.mkdirSync(base2);
        for (const [n, marker] of [['e2e64c-2001', 'someone'], ['e2e64c-2002', null]]) { const d = path.join(base2, n); fs.mkdirSync(d); if (marker) fs.writeFileSync(path.join(d, OWNER_MARKER), marker); fs.utimesSync(d, old, old); }
        const noOwner = pruneStaleRigDirs(base2, null, { owner: null });
        ctx.clause('no-owner-prunes-nothing', noOwner.removed.length === 0 && fs.readdirSync(base2).length === 2, `owner=null: removed=${JSON.stringify(noOwner.removed)}, both old dirs (one marked, one unmarked) kept`);
        // F2: the identity is the ABSOLUTE realpath of the repo root that holds THESE scripts, resolved with fileURLToPath.
        ctx.clause('owner-identity-is-the-repo-root', typeof RIG_OWNER === 'string' && path.isAbsolute(RIG_OWNER) && RIG_OWNER !== 'unknown' && fs.realpathSync(RIG_OWNER) === RIG_OWNER && fs.existsSync(path.join(RIG_OWNER, 'scripts', 'e2e-agent-view-removal.mjs')), `RIG_OWNER=${RIG_OWNER}`);
        const spaced = path.join(base, 'with space'); fs.mkdirSync(path.join(spaced, 'scripts'), { recursive: true });
        const viaUrl = ownerFromModuleUrl(pathToFileURL(path.join(spaced, 'scripts', 'x.mjs')).href);
        ctx.clause('owner-identity-survives-a-path-with-a-space', viaUrl === fs.realpathSync(spaced), `file URL of '<…>/with space/scripts/x.mjs' -> ${viaUrl === null ? 'null (percent-encoded path: the pre-fix behaviour)' : path.relative(base, viaUrl)}`);
      } finally { try { holder?.kill('SIGKILL'); } catch { /* gone */ } fs.rmSync(base, { recursive: true, force: true }); }
    },
  },
  {
    name: 'freshness_selftest', boots: false, ticket: '#225',
    doc: 'identity/dist-fresh can FAIL: a fake app dir with a fresh dist is accepted; a src file or package.json newer than the build, or no src/ at all, is refused naming the file',
    async run(ctx) {
      const root = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-fresh-selftest-'));
      const at = (f, sec) => { const t = new Date(Date.now() + sec * 1000); fs.utimesSync(f, t, t); };
      const mkApp = (name, { src = true } = {}) => {
        const d = path.join(root, name);
        for (const f of ['dist/index.html', 'dist/assets/index-R1.js', 'dist-electron/main.js', 'dist-electron/index-Q1.js', 'package.json', ...(src ? ['src/a.ts', 'src/deep/b.ts'] : [])]) {
          fs.mkdirSync(path.dirname(path.join(d, f)), { recursive: true });
          fs.writeFileSync(path.join(d, f), f === 'dist-electron/main.js' ? 'require("./index-Q1.js")' : f === 'package.json' ? '{"version":"1.0.0"}' : 'x');
        }
        for (const f of ['src/a.ts', 'src/deep/b.ts', 'package.json']) if (fs.existsSync(path.join(d, f))) at(path.join(d, f), -600);   // sources 10 min OLD
        for (const f of ['dist/index.html', 'dist/assets/index-R1.js', 'dist-electron/main.js', 'dist-electron/index-Q1.js']) at(path.join(d, f), -60); // build 1 min old
        return d;
      };
      try {
        const fresh = distFreshness(mkApp('fresh'));
        ctx.clause('fresh-build-accepted', fresh.ok, fresh.detail.slice(0, 150));
        const sd = mkApp('stale-src'); at(path.join(sd, 'src/deep/b.ts'), 0);
        const st = distFreshness(sd);
        ctx.clause('stale-src-refused', !st.ok && st.detail.includes('src/deep/b.ts'), `${st.ok ? 'ACCEPTED' : 'refused'}: ${st.detail.slice(0, 130)}`);
        const sp = mkApp('stale-pkg'); at(path.join(sp, 'package.json'), 0);
        const pk = distFreshness(sp);
        ctx.clause('stale-package-json-refused', !pk.ok && pk.detail.includes('package.json'), `${pk.ok ? 'ACCEPTED' : 'refused'}: ${pk.detail.slice(0, 130)} (the version-bumped-without-rebuild case)`);
        // the OLDEST build artifact decides: index.html predates the source while the renderer bundle is newer than it
        const mx = mkApp('mixed-ages'); at(path.join(mx, 'dist/index.html'), -1200); at(path.join(mx, 'dist/assets/index-R1.js'), 60);
        const mixed = distFreshness(mx);
        ctx.clause('mixed-artifact-ages-refused', !mixed.ok && mixed.detail.includes('dist/index.html'), `${mixed.ok ? 'ACCEPTED' : 'refused'}: ${mixed.detail.slice(0, 120)} (a stale artifact must not hide behind a fresher sibling)`);
        const ns = distFreshness(mkApp('no-src', { src: false }));
        ctx.clause('no-src-refused', !ns.ok && ns.detail.includes('no src/'), `${ns.ok ? 'ACCEPTED' : 'refused'}: ${ns.detail.slice(0, 110)}`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'gate_selftest', boots: false, ticket: '#225',
    doc: 'the no-agent-PTY gate: REFUSED without the Run control, a per-tab claim counts only PTYs that step CREATED (V1: no carry-over), a created one reddens it',
    async run(ctx) {
      const probe = (fired, ps, already) => { const got = []; noAgentPty({ controls: { run: fired }, clause: (n, ok, d) => { got.push({ ok, d }); return ok; } }, 'x', ps, already); return got[0]; };
      const run = { ptyId: 'w:run', kind: 'run' }, agent = { ptyId: 'w', kind: 'agent' };
      const r1 = probe(false, [run], new Set());
      ctx.clause('refused-without-control', !r1.ok && r1.d.startsWith('REFUSED'), `control not fired -> ${r1.d.slice(0, 40)}…`);
      const r2 = probe(true, [run], new Set());
      ctx.clause('passes-when-nothing-created', r2.ok, 'control fired, only a run PTY listed -> PASS');
      const r3 = probe(true, [run, agent], new Set());
      ctx.clause('fails-when-step-created-agent-pty', !r3.ok, 'control fired, agent PTY created by this step -> FAIL');
      const r4 = probe(true, [run, agent], new Set(['w']));
      ctx.clause('no-carry-over-from-earlier-step', r4.ok, 'the same agent PTY pre-existing before this step -> PASS (delta, not cumulative)');
    },
  },
  {
    name: 'live_verdict_selftest', boots: false, ticket: '#225',
    doc: 'the post-boot live-dir verdict (liveVerdict) itself can FAIL: removal -> FAIL, addition-only -> EXTERNAL-CHANGE, none -> PASS, removal+addition -> FAIL',
    async run(ctx) {
      const root = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-verdict-selftest-'));
      try {
        const glob = path.join(root, 'global'); fs.mkdirSync(glob, { recursive: true }); fs.writeFileSync(path.join(glob, 'a'), 'a'); fs.writeFileSync(path.join(glob, 'b'), 'b');
        const dir = path.join(root, 'cfg');
        const setup = () => { fs.rmSync(dir, { recursive: true, force: true }); fs.mkdirSync(dir, { recursive: true }); fs.symlinkSync(path.join(glob, 'a'), path.join(dir, 'a.md')); fs.writeFileSync(path.join(dir, '.claude.json'), '{"mcpServers":{"m":{}}}'); };
        const drive = (mutate) => {
          setup(); const before = { [dir]: liveSnapshot(dir) }; mutate();
          const got = []; const fake = { clause: (n, ok, d) => { got.push({ kind: ok ? 'pass' : 'fail', d }); return ok; }, externalChange: (n, d) => { got.push({ kind: 'external', d }); return true; } };
          liveVerdict(fake, 'v', before, [dir]); return got;
        };
        const none = drive(() => {}), rem = drive(() => fs.unlinkSync(path.join(dir, 'a.md'))), add = drive(() => fs.symlinkSync(path.join(glob, 'b'), path.join(dir, 'b.md')));
        const both = drive(() => { fs.unlinkSync(path.join(dir, 'a.md')); fs.symlinkSync(path.join(glob, 'b'), path.join(dir, 'b.md')); });
        ctx.clause('verdict:none-is-pass', none.length === 1 && none[0].kind === 'pass', `no change -> ${none.map((x) => x.kind)}`);
        ctx.clause('verdict:removal-is-fail', rem.length === 1 && rem[0].kind === 'fail' && rem[0].d.includes('a.md'), `link removed -> ${rem.map((x) => x.kind)} ${rem[0]?.d.slice(0, 60)}`);
        ctx.clause('verdict:addition-only-is-external', add.length === 1 && add[0].kind === 'external', `link added -> ${add.map((x) => x.kind)}`);
        ctx.clause('verdict:removal-plus-addition-is-fail', both.length === 1 && both[0].kind === 'fail', `one removed + one added -> ${both.map((x) => x.kind)} (a mixed change never hides a removal)`);
      } finally { fs.rmSync(root, { recursive: true, force: true }); }
    },
  },
  {
    name: 'args_selftest', boots: false, ticket: '#225',
    doc: 'the argument parser REJECTS an unrecognised flag (--mode=after, --mod, --allow_stale), a missing/invalid value and stray positionals; accepts the documented forms',
    async run(ctx) {
      const bad = [['--mode=after'], ['--mod', 'after'], ['--allow_stale'], ['--frobnicate'], ['--mode'], ['--mode', '--arm', 'x'], ['--mode', 'bogus'], ['--arm'], ['app', 'extra']];
      for (const a of bad) { const r = parseArgs(a); ctx.clause(`rejects:${a.join(' ')}`, !!r.error, `${JSON.stringify(a)} -> ${r.error ?? 'ACCEPTED (mode=' + r.mode + ')'}`); }
      for (const [label, a] of [['empty --arm', ['--arm', '']], ['empty --mode', ['--mode', '']], ['repeated --mode', ['--mode', 'after', '--mode', 'baseline']], ['repeated --arm', ['--arm', 'tabs', '--arm', 'observe']], ['repeated --allow-stale', ['--allow-stale', '--allow-stale']], ['repeated --list', ['--list', '--list']]]) {
        const r = parseArgs(a); ctx.clause(`rejects:${label}`, !!r.error, `${JSON.stringify(a)} -> ${r.error ?? 'ACCEPTED (mode=' + r.mode + ', arm=' + JSON.stringify(r.arm) + ')'}`);
      }
      const ok = parseArgs(['/app', '--mode', 'after', '--arm', 'tabs,open_tabs_agent_pty', '--allow-stale', '--broken-control']);
      ctx.clause('accepts:documented-forms', !ok.error && ok.mode === 'after' && ok.arm === 'tabs,open_tabs_agent_pty' && ok.allowStale && ok.brokenControl && ok.positional[0] === '/app', JSON.stringify(ok));
      const def = parseArgs(['/app']);
      ctx.clause('accepts:default-is-baseline', !def.error && def.mode === 'baseline' && !def.list, `mode=${def.mode}`);
      ctx.clause('accepts:--list', !parseArgs(['--list']).error && parseArgs(['--list']).list, '--list alone is valid');
    },
  },
  {
    name: 'wiring_selftest', boots: false, ticket: '#225',
    doc: 'result plumbing can FAIL: tally never counts SKIP/ALLOWED-STALE/EXTERNAL-CHANGE as PASS and names them in the verdict; retain deletes only a PASSED arm\'s bulky state; the KEEP marker survives a failing run',
    async run(ctx) {
      // tally
      const ok = { ok: true }, bad = { ok: false }, sk = { ok: true, skip: true }, st = { ok: true, allowedStale: true }, ex = { ok: true, externalChange: true };
      const t1 = tally([ok, ok, sk, st, ex]);
      ctx.clause('tally:only-real-passes-count', t1.pass === 2 && t1.skip === 1 && t1.stale === 1 && t1.ext === 1 && t1.fail === 0, JSON.stringify(t1));
      ctx.clause('tally:stale-build-is-named', t1.verdict === 'PASS-ON-STALE-BUILD' && tally([ok, ex]).verdict === 'PASS-WITH-EXTERNAL-CHANGE' && tally([ok]).verdict === 'PASS' && tally([ok, bad, st]).verdict === 'FAIL', `verdicts: ${[tally([ok, st]).verdict, tally([ok, ex]).verdict, tally([ok]).verdict, tally([ok, bad, st]).verdict]}`);
      // retain
      const base = fs.mkdtempSync(path.join(REAL_HOME, '.cache', 'avr-retain-selftest-'));
      try {
        const mkBoot = (n) => { const h = path.join(base, n); for (const d of ['userData', 'home', 'repo', 'wt', 'claude-config', 'stub-bin']) fs.mkdirSync(path.join(h, d), { recursive: true }); fs.writeFileSync(path.join(h, 'app.log'), 'log'); fs.writeFileSync(path.join(h, 'shot.png'), 'png'); return h; };
        const has = (h) => ['userData', 'home', 'repo', 'wt', 'claude-config', 'stub-bin'].filter((d) => fs.existsSync(path.join(h, d)));
        const quiet = (fn) => { const l = console.log; console.log = () => {}; try { fn(); } finally { console.log = l; } };
        const pass = mkBoot('pass-arm'), fail = mkBoot('fail-arm'), out = mkBoot('outside-base');
        const results = [{ arm: 'pa', ok: true }, { arm: 'pa', ok: true }, { arm: 'fa', ok: true }, { arm: 'fa', ok: false }];
        quiet(() => { retain({ arm: 'pa' }, { home: pass }, { base, results }); retain({ arm: 'fa' }, { home: fail }, { base, results }); retain({ arm: 'pa' }, { home: out }, { base: path.join(base, 'elsewhere'), results }); });
        ctx.clause('retain:passed-arm-drops-bulky-state-keeps-log', has(pass).length === 0 && fs.existsSync(path.join(pass, 'app.log')) && fs.existsSync(path.join(pass, 'shot.png')), `remaining bulky dirs=${JSON.stringify(has(pass))}; app.log+png kept`);
        ctx.clause('retain:failed-arm-keeps-everything', has(fail).length === 6, `remaining bulky dirs=${has(fail).length}/6`);
        ctx.clause('retain:home-outside-base-untouched', has(out).length === 6, `a home outside the rig base is never deleted (${has(out).length}/6 kept)`);
        // KEEP marker
        const rd = path.join(base, 'rigdir'); fs.mkdirSync(rd);
        fs.writeFileSync(path.join(rd, KEEP_MARKER), '1'); settleKeepMarker(rd, 2);
        const keptOnFail = fs.existsSync(path.join(rd, KEEP_MARKER));
        settleKeepMarker(rd, 0);
        ctx.clause('keep-marker:survives-a-failing-run', keptOnFail && !fs.existsSync(path.join(rd, KEEP_MARKER)), `fail=2 -> marker kept=${keptOnFail}; fail=0 -> marker removed=${!fs.existsSync(path.join(rd, KEEP_MARKER))}`);
      } finally { fs.rmSync(base, { recursive: true, force: true }); }
    },
  },
  {
    name: 'legacy_restart', boots: true, ticket: '#228', boot: { legacy: true },
    doc: 'a stopped LEGACY terminal-only workspace (hasInput, no sdkSessionId, a terminal transcript on disk) restarted through the REAL CLI: baseline = PTY restart (`--continue` in an agent PTY, no adoption); after = the SDK wake path adopts that transcript, the session resumes ITS id in the Agent view, no agent PTY, reply names no surface',
    async run(ctx) {
      const { app } = ctx; const w = app.world; const wsId = w.ws.id; const want = pick(EXPECT.legacyRestart);
      const labels = (await app.tabs()).map((t) => t.label);
      const agentTab = ['Structured', 'Agent'].find((l) => labels.includes(l)); // the build's Agent-view tab (label flips at B5)
      await runControl(ctx);                                                   // positive control: the PTY listing can see PTYs in THIS boot
      await app.clickTab(agentTab);
      // ── pre-state (each must DIFFER from the post-state below, so the arm cannot pass on a state already true) ──
      const rec0 = (await listWs(app)).find((x) => x.id === wsId);
      ctx.clause('seed/legacy-shape', !!rec0 && rec0.hasInput === true && rec0.sdkSessionId === undefined && !rec0.archived, `hasInput=${rec0?.hasInput} sdkSessionId=${JSON.stringify(rec0?.sdkSessionId)} (want hasInput=true, sdkSessionId absent)`);
      ctx.clause('seed/transcript-on-disk', !!w.legacyTranscript && readText(w.legacyTranscript).includes(LEGACY_SENTINEL_USER), `${w.legacyTranscript ? path.relative(app.home, w.legacyTranscript) : 'none seeded'}`);
      const pre = await app.ptys();
      const already = new Set(pre.filter((p) => p.kind === 'agent').map((p) => p.ptyId));
      noAgentPty(ctx, 'pre-state-no-agent-pty', pre);
      const ADOPT = `wake ${wsId} adopting terminal transcript ${LEGACY_SESSION_ID} as resume id`;
      const log0 = appLog(app);
      ctx.clause('log/channel-alive', /loaded \d+ workspace/.test(log0), `${log0.length} bytes in logs/orchestra.log, boot line 'loaded N workspace(s)' ${/loaded \d+ workspace/.test(log0) ? 'present' : 'ABSENT — the log path/channel is unproven, so its silence below means nothing'}`);
      keeperControl(ctx);
      ctx.clause('pre-state-no-adoption-logged', !log0.includes(ADOPT) && sessionStarts(app).length === 0, `adoption line present=${log0.includes(ADOPT)}; claude SESSION starts so far=${sessionStarts(app).length} (+${stubStarts(app).length - sessionStarts(app).length} \`--version\` probe(s))`);

      // ── drive the REAL CLI ──
      const r = cliRun(app, ['restart', wsId]);
      const expectReply = `Restarted ${wsId} (${want.surfaceWord ? `${want.surfaceWord}, ` : ''}conversation preserved)\n`;
      ctx.clause('cli/restart-exits-0', r.status === 0, `rc=${r.status} signal=${r.signal} stderr=${JSON.stringify(r.stderr.slice(0, 160))}`);
      ctx.clause('cli/reply', r.stdout === expectReply, `stdout=${JSON.stringify(r.stdout)} expected(${MODE})=${JSON.stringify(expectReply)} (the reply names ${want.surfaceWord ? `'${want.surfaceWord}'` : 'no surface'})`);

      // ── what the restart actually launched (ANY launcher: PTY or SDK keeper) ──
      const started = await waitFor('a claude session start (stub argv log)', () => sessionStarts(app).length >= 1, 30000, 250).catch(() => false);
      await sleep(ABSENCE_MS);
      const starts = sessionStarts(app);
      ctx.clause('restart/cli-started', !!started, started ? `first start pid=${starts[0]?.pid}` : 'NO claude session start was recorded within 30 s of the restart');
      ctx.clause('restart/exactly-one-cli-start', starts.length === 1, `${starts.length} claude session start(s) after the restart (two on one workspace is the double-process hazard) — ${JSON.stringify(starts.map((x) => x.pid))}`);
      const argv = starts[0]?.argv ?? [];
      const ro = resumeOf(argv);
      const resumeOk = want.resumeFlag === '--resume' ? ro.target === LEGACY_SESSION_ID && !ro.continue : ro.continue && !ro.resume;
      ctx.clause('restart/resume-target', resumeOk, `claude argv (${argv.length} args) starts ${JSON.stringify(argv.slice(0, 4).join(' '))}…: --resume target=${JSON.stringify(ro.target)} --continue=${ro.continue}; want ${want.resumeFlag === '--resume' ? `--resume=${LEGACY_SESSION_ID} (the terminal transcript's session) and no --continue` : '--continue and NO --resume (PTY restart)'}`);

      // ── the wake path really ran, and its write landed ──
      const log1 = appLog(app);
      ctx.clause('wake/adoption-logged', log1.includes(ADOPT) === want.wake, `'${ADOPT}' present=${log1.includes(ADOPT)} expected(${MODE})=${want.wake}`);
      const rec1 = await waitFor('sdkSessionId adopted', async () => { const x = (await listWs(app)).find((y) => y.id === wsId); return x?.sdkSessionId === LEGACY_SESSION_ID ? x : null; }, want.wake ? 10000 : 500, 250).catch(() => null);
      const got = rec1 ?? (await listWs(app)).find((x) => x.id === wsId);
      ctx.clause('wake/store-sdkSessionId', want.wake ? got?.sdkSessionId === LEGACY_SESSION_ID : got?.sdkSessionId === undefined, `ws.sdkSessionId after=${JSON.stringify(got?.sdkSessionId)} expected(${MODE})=${want.wake ? LEGACY_SESSION_ID : 'absent'}`);

      // ── PTYs: the wake path launches none; the PTY restart launches one ──
      const ps = await app.ptys();
      if (want.agentPty) {
        const created = ps.filter((p) => p.kind === 'agent' && !already.has(p.ptyId));
        const cmds = created.flatMap((p) => p.pids.map(procCmdline));
        ctx.clause('restart/agent-pty-created', created.length === 1 && cmds.some((c) => c.includes(w.stub)), `baseline: the PTY restart created ${created.length} agent-kind PTY (${fmtP(ps)}), tree cmdlines=${JSON.stringify(cmds.slice(0, 3))}`);
      } else noAgentPty(ctx, 'restart/no-agent-pty', ps, already);

      // ── the Agent view: the terminal transcript is the conversation it shows ──
      // NOT a discriminator (MEASURED on a master build): the Agent view's history backfill already falls back to the newest on-disk transcript for a
      // workspace with no sdkSessionId, so the conversation is on screen on BOTH builds — what differs is which session the LIVE process resumes (above).
      const hist = await app.cdp.eval(`window.orchestra.agentSdkHistory(${JSON.stringify(wsId)}).then(h => JSON.stringify(h))`).catch((e) => `ERR ${e.message}`);
      ctx.clause('view/history-is-the-terminal-transcript', hist.includes(LEGACY_SENTINEL_USER) && hist.includes(LEGACY_SENTINEL_ASSISTANT), `agent:sdkHistory carries the user+assistant sentinels of the terminal transcript: ${hist.includes(LEGACY_SENTINEL_USER)}/${hist.includes(LEGACY_SENTINEL_ASSISTANT)} (${hist.length} bytes; holds on both builds — not a discriminator)`);
      await app.clickTab('Run'); await app.clickTab(agentTab); // remount the Agent view: a fresh backfill, not a stale pane
      const vis = (t) => `(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes(${JSON.stringify(t)})) { const e = n.parentElement, r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && e.checkVisibility(); } } return false; })()`;
      const seen = await waitFor('terminal transcript rendered in the Agent view', async () => (await app.cdp.eval(vis(LEGACY_SENTINEL_USER))) && (await app.cdp.eval(vis(LEGACY_SENTINEL_ASSISTANT))), 15000, 250).catch(() => false);
      ctx.clause('view/transcript-rendered', !!seen, `terminal transcript rows visible in the '${agentTab}' view=${!!seen} (DOM oracle — pixels below; holds on both builds — not a discriminator)`);
      {
        const settle = () => app.cdp.eval('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))').then(() => sleep(300));
        await settle();
        const rowsRect = await app.cdp.eval(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; const rs = [];
          while ((n = w.nextNode())) if (n.textContent.includes(${JSON.stringify(LEGACY_SENTINEL_USER)}) || n.textContent.includes(${JSON.stringify(LEGACY_SENTINEL_ASSISTANT)})) rs.push(n.parentElement.getBoundingClientRect());
          if (rs.length < 2) return null;
          const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top)), x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
          return { x: Math.max(0, x0 - 8), y: Math.max(0, y0 - 8), width: x1 - x0 + 16, height: y1 - y0 + 16 }; })()`);
        if (!rowsRect) ctx.clause('view/pixels-painted', false, 'sentinel elements not found — nothing to screenshot');
        else {
          const contentFile = await app.shot('legacy-restart-agent-view-rows', rowsRect);
          await app.cdp.eval(`(() => { const s = document.createElement('style'); s.id = 'avr-blank'; s.textContent = '.av-message-list > * { visibility: hidden !important }'; document.head.appendChild(s); })()`);
          await settle();
          const blankFile = await app.shot('legacy-restart-agent-view-rows-blank', rowsRect);
          await app.cdp.eval(`document.getElementById('avr-blank').remove()`);
          const rd = (f) => { const b = fs.readFileSync(f); return { f, md5: crypto.createHash('md5').update(b).digest('hex'), ...pngStats(b) }; };
          const C = rd(contentFile), B = rd(blankFile);
          console.log(`SHOT      legacy-rows   ${C.f} md5=${C.md5} ${C.w}x${C.h} bytes=${C.bytes} distinct=${C.distinct} nonBg=${C.nonBgPct}%`);
          console.log(`SHOT      legacy-blank  ${B.f} md5=${B.md5} ${B.w}x${B.h} bytes=${B.bytes} distinct=${B.distinct} nonBg=${B.nonBgPct}%`);
          ctx.clause('view/pixels-painted', C.md5 !== B.md5 && paintedBeyondBlank(C, B), `rows region: content nonBg=${C.nonBgPct}% distinct=${C.distinct} vs blank nonBg=${B.nonBgPct}% distinct=${B.distinct} (need > +0.05pp and > +4 colours; md5s differ=${C.md5 !== B.md5})`);
        }
      }
    },
  },
  {
    name: 'legacy_restart_fresh', boots: true, ticket: '#228', boot: { legacy: true },
    doc: '`orchestra restart --fresh` of the same legacy workspace NEVER adopts the terminal transcript (the conversation is being dropped): baseline = a vierge agent PTY (no --continue, no --resume); after = sdkClear (ws.sdkSessionId \'\'), no adoption logged, no session started, no agent PTY',
    async run(ctx) {
      const { app } = ctx; const w = app.world; const wsId = w.ws.id; const want = pick(EXPECT.legacyRestart);
      await runControl(ctx);
      const pre = await app.ptys();
      const already = new Set(pre.filter((p) => p.kind === 'agent').map((p) => p.ptyId));
      noAgentPty(ctx, 'pre-state-no-agent-pty', pre);
      const ADOPT = `wake ${wsId} adopting terminal transcript`;   // ANY adoption of this workspace's transcript
      const log0 = appLog(app);
      ctx.clause('log/channel-alive', /loaded \d+ workspace/.test(log0), `${log0.length} bytes in logs/orchestra.log, boot line 'loaded N workspace(s)' ${/loaded \d+ workspace/.test(log0) ? 'present' : 'ABSENT — the log channel is unproven'}`);
      keeperControl(ctx);
      ctx.clause('pre-state-no-adoption-logged', !log0.includes(ADOPT) && sessionStarts(app).length === 0, `adoption line present=${log0.includes(ADOPT)}; claude SESSION starts so far=${sessionStarts(app).length}`);
      const r = cliRun(app, ['restart', '--fresh', wsId]);
      const expectReply = `Restarted ${wsId} (${want.surfaceWord ? `${want.surfaceWord}, ` : ''}fresh (conversation cleared))\n`;
      ctx.clause('cli/restart-exits-0', r.status === 0, `rc=${r.status} signal=${r.signal}`);
      ctx.clause('cli/reply', r.stdout === expectReply, `stdout=${JSON.stringify(r.stdout)} expected(${MODE})=${JSON.stringify(expectReply)}`);
      // baseline: the PTY restart launches a vierge claude; after: sdkClear starts NO session (the next send does) — wait out the same window either way.
      if (want.agentPty) await waitFor('a claude session start', () => sessionStarts(app).length >= 1, 30000, 250).catch(() => false);
      await sleep(ABSENCE_MS);
      const starts = sessionStarts(app);
      if (want.agentPty) {
        const argv = starts[0]?.argv ?? []; const ro = resumeOf(argv);
        ctx.clause('fresh/vierge-launch', starts.length === 1 && !ro.continue && !ro.resume, `baseline: ${starts.length} session start(s), argv (${argv.length} args) starts ${JSON.stringify(argv.slice(0, 3).join(' '))}…, --resume=${ro.resume} --continue=${ro.continue} (want exactly one start with neither)`);
      } else ctx.clause('fresh/no-session-started', starts.length === 0, `${starts.length} claude session start(s) after --fresh (sdkClear starts none; a --resume here would be the adopted conversation coming back): ${JSON.stringify(starts.map((x) => x.line.slice(0, 120)))}`);
      const log1 = appLog(app);
      ctx.clause('fresh/never-adopts', !log1.includes(ADOPT), `'${ADOPT}' present=${log1.includes(ADOPT)} (want absent in BOTH modes: --fresh drops the conversation, adopting it first would persist an id --fresh must never keep)`);
      const rec = (await waitFor('sdkSessionId cleared', async () => { const x = (await listWs(app)).find((y) => y.id === wsId); return x?.sdkSessionId === '' ? x : null; }, want.wake ? 10000 : 500, 250).catch(() => null)) ?? (await listWs(app)).find((x) => x.id === wsId);
      ctx.clause('fresh/store-sdkSessionId', want.wake ? rec?.sdkSessionId === '' : rec?.sdkSessionId === undefined, `ws.sdkSessionId after=${JSON.stringify(rec?.sdkSessionId)} expected(${MODE})=${want.wake ? `'' (the cleared marker)` : 'absent'}`);
      const ps = await app.ptys();
      if (want.agentPty) {
        const created = ps.filter((p) => p.kind === 'agent' && !already.has(p.ptyId));
        ctx.clause('restart/agent-pty-created', created.length === 1, `baseline: the PTY restart created ${created.length} agent-kind PTY (${fmtP(ps)})`);
      } else noAgentPty(ctx, 'restart/no-agent-pty', ps, already);
    },
  },
  {
    name: 'observe', boots: true, ticket: '#225',
    doc: 'record what the app shows on boot: rendered tab labels + live PTY sessions by kind (no assertion beyond identity/isolation)',
    async run(ctx) {
      const tabs = await ctx.app.tabs(); const ps = await ctx.app.ptys();
      console.log(`OBSERVED  tabs=${JSON.stringify(tabs.map((t) => t.label + (t.active ? '*' : '')))} ptys=${fmtP(ps)} kinds=${JSON.stringify(kindsOf(ps))}`);
    },
  },
  {
    name: 'control_run_pty', boots: true, ticket: '#225',
    doc: 'positive control: opening Run (+ ▶ Run) makes a run-kind PTY appear — proves the listing can see PTYs',
    async run(ctx) { await runControl(ctx); },
  },
  {
    name: 'tabs', boots: true, ticket: '#225',
    doc: 'rendered tab labels, in order (baseline Raw·Run·Structured·Diff; after Agent·Run·Diff) + default-active tab',
    async run(ctx) {
      const tabs = await ctx.app.tabs(); const labels = tabs.map((t) => t.label);
      const want = pick(EXPECT.tabs);
      ctx.clause('tab-labels', JSON.stringify(labels) === JSON.stringify(want), `rendered=${JSON.stringify(labels)} expected(${MODE})=${JSON.stringify(want)}`);
      ctx.clause('all-tabs-visible', tabs.length > 0 && tabs.every((t) => t.visible), `visible=${tabs.map((t) => t.visible)}`);
      const active = tabs.find((t) => t.active)?.label;
      ctx.clause('opens-on-agent-view', active === pick(EXPECT.agentTab), `active=${active} expected=${pick(EXPECT.agentTab)}`);
      ctx.clause('raw-tab', labels.includes('Raw') === (MODE === 'baseline'), `Raw present=${labels.includes('Raw')} expected(${MODE})=${MODE === 'baseline'}`);
    },
  },
  {
    name: 'open_tabs_agent_pty', boots: true, ticket: '#225',
    doc: 'opening each tab: baseline Raw creates an agent-kind PTY, every other tab creates none; after — NO tab creates one (gated on the Run-tab control)',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      await runControl(ctx);
      const pre = await app.ptys();
      noAgentPty(ctx, 'pre-state-no-agent-pty', pre);
      const labels = (await app.tabs()).map((t) => t.label);
      for (const label of labels.filter((l) => l !== 'Raw')) {
        const already = new Set((await app.ptys()).filter((p) => p.kind === 'agent').map((p) => p.ptyId));
        await app.clickTab(label);
        await sleep(ABSENCE_MS);
        noAgentPty(ctx, `tab:${label}:no-agent-pty`, await app.ptys(), already);
      }
      if (labels.includes('Raw')) {
        await app.clickTab('Raw');
        const post = await waitFor(`agent-kind PTY ${wsId}`, async () => { const ps = await app.ptys(); return ps.some((p) => p.ptyId === wsId && p.kind === 'agent') ? ps : null; }, 20000, 300).catch(() => null);
        ctx.clause('tab:Raw:creates-agent-pty', !!post === pick(EXPECT.rawCreatesAgentPty), `pre=${fmtP(pre)} -> post=${post ? fmtP(post) : 'NO agent PTY appeared'} expected(${MODE})=${pick(EXPECT.rawCreatesAgentPty)}`);
        if (post) {
          const agent = post.find((p) => p.kind === 'agent');
          const cmds = agent.pids.map(procCmdline);
          ctx.clause('tab:Raw:agent-pty-is-the-stub', cmds.some((c) => c.includes(app.world.stub)), `no real claude was started; PTY tree cmdlines=${JSON.stringify(cmds.slice(0, 3))}`);
        } else ctx.skip('tab:Raw:agent-pty-is-the-stub', 'no agent PTY appeared — nothing to inspect');
      } else {
        ctx.skip('tab:Raw:creates-agent-pty', `no Raw tab rendered — nothing to open; agent-PTY absence is measured by end-state-agent-pty (expected(${MODE})=${pick(EXPECT.rawCreatesAgentPty)})`);
        ctx.skip('tab:Raw:agent-pty-is-the-stub', 'no agent PTY was created — nothing to inspect');
      }
      const end = await app.ptys();
      if (MODE === 'baseline') ctx.clause('end-state-agent-pty', end.filter((p) => p.kind === 'agent').length === 1, `baseline: Raw left exactly one agent-kind PTY (${fmtP(end)})`);
      else noAgentPty(ctx, 'end-state-agent-pty', end);
    },
  },
  {
    name: 'agent_view_content', boots: true, ticket: '#225',
    doc: 'the Agent view renders REAL content (injected through the real fold path: user + assistant rows visible) + a screenshot read back off disk and asserted on its decoded pixels',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      const want = pick(EXPECT.agentTab);
      const labels = (await app.tabs()).map((t) => t.label);
      ctx.clause('agent-tab-rendered', labels.includes(want), `'${want}' in ${JSON.stringify(labels)}`);
      await app.clickTab(labels.includes(want) ? want : ['Structured', 'Agent'].find((l) => labels.includes(l))); // keep going on a broken build: report, don't abort
      // The message-list region: the pane the content must paint into (crop = not diluted by sidebar/composer).
      const rect = await waitFor('agent message list', () => app.cdp.eval(`(() => { const e = document.querySelector('.av-message-list'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 200 && r.height > 200 ? { x: r.x, y: r.y, width: r.width, height: r.height } : null; })()`), 10000);
      const settle = () => app.cdp.eval('document.fonts.ready.then(() => new Promise(r => requestAnimationFrame(() => requestAnimationFrame(r))))').then(() => sleep(300));
      await settle();
      const emptyFile = await app.shot('agent-view-empty', rect);
      const now = Date.now();
      const evs = [
        { type: 'user-message', seq: 1, at: now, text: SENTINEL_USER },
        { type: 'block-start', seq: 2, at: now + 1, index: 0, kind: 'text' },
        { type: 'text-delta', seq: 3, at: now + 2, index: 0, text: SENTINEL_ASSISTANT },
        { type: 'block-stop', seq: 4, at: now + 3, index: 0 },
        { type: 'turn-end', seq: 5, at: now + 4, isError: false, stopReason: 'end_turn', numTurns: 1, costUsd: null, usage: null, resultText: SENTINEL_ASSISTANT, sessionId: 'avr-sess', durationMs: 1 },
      ];
      await app.cdp.eval(`(${JSON.stringify(evs)}).forEach(e => window.__injectAgentEvent(${JSON.stringify(wsId)}, e))`);
      const seen = await waitFor('injected rows rendered', () => app.cdp.eval(`(() => {
        const vis = (t) => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; while ((n = w.nextNode())) { if (n.textContent.includes(t)) { const e = n.parentElement, r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 && r.bottom > 0 && r.top < innerHeight && e.checkVisibility(); } } return false; };
        return vis(${JSON.stringify(SENTINEL_USER)}) && vis(${JSON.stringify(SENTINEL_ASSISTANT)});
      })()`), 10000, 200).catch(() => false);
      ctx.clause('rows-rendered-and-visible', seen, 'user + assistant sentinels are in visible elements (DOM oracle — blind to paint, hence the pixels below)');
      ctx.clause('composer-present', await app.cdp.eval(`!!document.querySelector('.cm-editor, .av-composer, textarea')`), 'a composer element is in the DOM');
      await settle();
      const contentFile = await app.shot('agent-view-content', rect);
      // V2: the painted-vs-blank gate is measured on the crop where the INJECTED ROWS must paint (union of the two
      // sentinel elements' rects), so an empty pane / unpainted rows cannot pass on the empty state's own ink.
      const rowsRect = await app.cdp.eval(`(() => { const w = document.createTreeWalker(document.body, NodeFilter.SHOW_TEXT); let n; const rs = [];
        while ((n = w.nextNode())) if (n.textContent.includes(${JSON.stringify(SENTINEL_USER)}) || n.textContent.includes(${JSON.stringify(SENTINEL_ASSISTANT)})) rs.push(n.parentElement.getBoundingClientRect());
        if (rs.length < 2) return null;
        const x0 = Math.min(...rs.map((r) => r.left)), y0 = Math.min(...rs.map((r) => r.top)), x1 = Math.max(...rs.map((r) => r.right)), y1 = Math.max(...rs.map((r) => r.bottom));
        return { x: Math.max(0, x0 - 8), y: Math.max(0, y0 - 8), width: x1 - x0 + 16, height: y1 - y0 + 16 }; })()`);
      ctx.clause('rows-rect-found', !!rowsRect, rowsRect ? `injected rows occupy ${Math.round(rowsRect.width)}x${Math.round(rowsRect.height)} at (${Math.round(rowsRect.x)},${Math.round(rowsRect.y)})` : 'sentinel elements not found in the DOM');
      const rowsContentFile = rowsRect ? await app.shot('agent-view-rows-content', rowsRect) : null;
      // Blank POPULATION for the threshold: same region with the pane's rows hidden (a real "painted nothing" frame).
      await app.cdp.eval(`(() => { const s = document.createElement('style'); s.id = 'avr-blank'; s.textContent = '.av-message-list > * { visibility: hidden !important }'; document.head.appendChild(s); })()`);
      await settle();
      const rowsBlankFile = rowsRect ? await app.shot('agent-view-rows-blank', rowsRect) : null;
      await app.cdp.eval(`document.getElementById('avr-blank').remove()`);
      // READ BACK off disk: assert on the bytes of the files we report, not the in-memory buffers.
      const rd = (f) => { const b = fs.readFileSync(f); return { f, md5: crypto.createHash('md5').update(b).digest('hex'), ...pngStats(b) }; };
      const E = rd(emptyFile), C = rd(contentFile);
      const shots = [['empty-state', E], ['content', C]];
      let RC = null, RB = null;
      if (rowsRect) { RC = rd(rowsContentFile); RB = rd(rowsBlankFile); shots.push(['rows-content', RC], ['rows-blank', RB]); }
      for (const [n, x] of shots) console.log(`SHOT      ${n.padEnd(12)} ${x.f} md5=${x.md5} ${x.w}x${x.h} bytes=${x.bytes} distinct=${x.distinct} nonBg=${x.nonBgPct}%`);
      ctx.clause('screenshots-distinct', new Set(shots.map(([, x]) => x.md5)).size === shots.length, `md5s ${shots.map(([n, x]) => `${n}=${x.md5.slice(0, 8)}`).join(' ')} (a no-op step would collide)`);
      // Threshold sits BETWEEN the two observed populations: blank (nothing painted) vs content, on the rows' own region.
      ctx.clause('content-painted-not-blank', !!RC && paintedBeyondBlank(RC, RB), RC ? `rows region: content nonBg=${RC.nonBgPct}% distinct=${RC.distinct} vs blank nonBg=${RB.nonBgPct}% distinct=${RB.distinct} (need > +0.05pp and > +4 colours)` : 'no rows region to measure');
      // Composed-window oracle: what the compositor actually shows of the whole app.
      const G = rd(app.grim('compositor-grim'));
      console.log(`SHOT      compositor  ${G.f} md5=${G.md5} ${G.w}x${G.h} bytes=${G.bytes} distinct=${G.distinct} nonBg=${G.nonBgPct}%`);
      ctx.clause('compositor-shows-app', G.distinct >= 12 && G.nonBgPct >= 1, `grim on ${RIG.wayland}: distinct=${G.distinct} nonBg=${G.nonBgPct}% (thresholds >=12 colours, >=1%)`);
    },
  },
  {
    name: 'toolbar_no_pr', boots: true, ticket: '#229', boot: { commitsAhead: 1 },
    doc: 'no linked PR + 1 unpushed commit: baseline the toolbar has the amber "Open PR · ↑1" create button; after — no Open PR button, no "ready to push" affordance, no PR control at all; the merge IPC preload wrapper is gone',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      // POSITIVE CONTROL: the old button's "primed" input really reached the renderer (main reports unpushedAhead>=1 AND the
      // sidebar paints its unpushed pill) — else "no ready-to-push affordance" would be measured on an unprimed workspace.
      const ahead = await waitFor('unpushedAhead>=1 via IPC', async () => { const w = (await app.cdp.eval('window.orchestra.listWorkspaces()')).find((x) => x.id === wsId); return w && w.unpushedAhead >= 1 ? w.unpushedAhead : null; }, 40000, 500).catch(() => 0);
      const pill = await waitFor('sidebar .unpushed-pill painted', () => app.cdp.eval(`(() => { const e = document.querySelector('.unpushed-pill'); if (!e) return null; const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0 ? e.textContent.trim() : null; })()`), 20000, 300).catch(() => null);
      const primed = ahead >= 1 && pill === String(ahead);
      ctx.clause('control/unpushed-input-reached-renderer', primed, `main listWorkspaces unpushedAhead=${ahead}; sidebar .unpushed-pill text=${JSON.stringify(pill)}`);
      const refuse = (name) => ctx.clause(name, false, 'REFUSED: the unpushed-commits input did not reach the renderer in this boot — an absence here would be unproven');
      const controls = await app.prControls();
      const brief = JSON.stringify(controls.map((c) => ({ tag: c.tag, text: c.text, cls: c.cls, title: c.title.slice(0, 60) })));
      const want = pick(EXPECT.openPrButton);
      if (!primed) { refuse('no-pr/open-pr-button'); refuse('no-pr/ready-to-push-affordance'); refuse('no-pr/no-pr-controls'); }
      else {
        const create = controls.filter((c) => c.create && c.visible), rtp = controls.filter((c) => c.readyToPush && c.visible);
        ctx.clause('no-pr/open-pr-button', create.length === (want ? 1 : 0), `toolbar create buttons=${create.length} (${create.map((c) => JSON.stringify(c.text)).join(',') || '∅'}) expected(${MODE})=${want ? 1 : 0}; all toolbar PR controls=${brief}`);
        ctx.clause('no-pr/ready-to-push-affordance', rtp.length === (want ? 1 : 0), `toolbar ready-to-push surfaces=${rtp.length} (${rtp.map((c) => JSON.stringify(c.title.slice(0, 50))).join(',') || '∅'}) expected(${MODE})=${want ? 1 : 0}`);
        ctx.clause('no-pr/no-pr-controls', controls.filter((c) => c.visible).length === (want ? 1 : 0), `visible toolbar PR controls=${controls.filter((c) => c.visible).length} expected(${MODE})=${want ? 1 : 0}: ${brief}`);
      }
      const tb = await app.cdp.eval(`(() => { const e = document.querySelector('.toolbar'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      if (tb) { const f = await app.shot('toolbar-no-pr', tb); const st = pngStats(fs.readFileSync(f)); console.log(`SHOT      toolbar-no-pr ${f} ${st.w}x${st.h} bytes=${st.bytes} distinct=${st.distinct} nonBg=${st.nonBgPct}%`); }
      // Styles used only by the removed button — read off the LOADED stylesheets (CSSOM), with a control: the `.pr-link` rules the
      // surviving "PR #N" button uses must still be there (proves the sheets were readable AND the base rules were not swept out).
      const css = await app.cdp.eval(`(() => { const dead = [], live = []; for (const ss of document.styleSheets) { let rs; try { rs = ss.cssRules; } catch { continue; }
        for (const r of rs) { const t = r.selectorText; if (!t) continue; if (/pr-link-create|\\.primed\\b/.test(t)) dead.push(t); else if (/button\\.pr-link\\b/.test(t)) live.push(t); } } return { dead, live: live.length }; })()`);
      ctx.clause('css/create-button-rules', css.live >= 4 && (css.dead.length > 0) === pick(EXPECT.createButtonCss), `create-button/primed selectors in loaded CSS=${JSON.stringify(css.dead)} expected(${MODE})=${pick(EXPECT.createButtonCss) ? 'present' : 'none'}; surviving button.pr-link rules=${css.live} (control: need >= 4)`);
      // The merge IPC's preload wrapper — read off the RUNNING app's bridge, not the source.
      const wrapper = await app.cdp.eval(`typeof window.orchestra.mergeWorktree`);
      ctx.clause('preload/mergeWorktree-wrapper', (wrapper === 'function') === pick(EXPECT.mergeWrapper), `typeof window.orchestra.mergeWorktree=${wrapper} expected(${MODE})=${pick(EXPECT.mergeWrapper) ? 'function' : 'undefined'}`);
    },
  },
  {
    name: 'toolbar_no_pr_fresh', boots: true, ticket: '#229', boot: {},
    doc: 'FRESH no-PR workspace (0 commits ahead — the commonest no-PR state): baseline the toolbar has the plain "Open PR" create button (never primed); after — none. Control: the actions group rendered and findPR resolved empty',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      // POSITIVE CONTROL 1: a genuinely fresh, PR-less workspace — main says 0 unpushed and findPR resolves with no PR.
      const ws = (await app.cdp.eval('window.orchestra.listWorkspaces()')).find((x) => x.id === wsId);
      const pr = await app.cdp.eval(`window.orchestra.findPR(${JSON.stringify(wsId)})`);
      const fresh = !!ws && (ws.unpushedAhead ?? 0) === 0 && !!pr && pr.open === null && (pr.all ?? []).length === 0 && !pr.error;
      ctx.clause('control/fresh-no-pr-workspace', fresh, `listWorkspaces unpushedAhead=${ws?.unpushedAhead ?? 'absent'}; findPR=${JSON.stringify({ open: pr?.open ?? null, all: (pr?.all ?? []).length, error: pr?.error ?? null })}`);
      // POSITIVE CONTROL 2: the slot the button lived in is rendered — the toolbar actions group has its visible sibling buttons.
      const actions = await waitFor('toolbar actions group rendered', () => app.cdp.eval(`(() => { const g = document.querySelector('.toolbar-actions'); if (!g) return null; const bs = [...g.querySelectorAll('button')].filter((b) => { const r = b.getBoundingClientRect(); return r.width > 0 && r.height > 0; }); return bs.length ? bs.map((b) => b.className.split(' ')[0]) : null; })()`), 15000, 250).catch(() => null);
      ctx.clause('control/actions-group-rendered', !!actions, `visible .toolbar-actions buttons=${JSON.stringify(actions)}`);
      await sleep(ABSENCE_MS); // a late-appearing button (after the renderer's own PR refresh) must have had time to show
      const controls = await app.prControls();
      const brief = JSON.stringify(controls.map((c) => ({ tag: c.tag, text: c.text, cls: c.cls })));
      const want = pick(EXPECT.openPrButton) ? 1 : 0;
      if (!fresh || !actions) {
        for (const n of ['fresh/open-pr-button', 'fresh/no-pr-controls']) ctx.clause(n, false, 'REFUSED: the fresh-workspace / rendered-actions control did not hold in this boot — an absence here would be unproven');
      } else {
        const create = controls.filter((c) => c.create && c.visible);
        ctx.clause('fresh/open-pr-button', create.length === want, `toolbar create buttons=${create.length} (${create.map((c) => JSON.stringify(c.text)).join(',') || '∅'}) expected(${MODE})=${want}; all toolbar PR controls=${brief}`);
        ctx.clause('fresh/no-pr-controls', controls.filter((c) => c.visible).length === want, `visible toolbar PR controls=${controls.filter((c) => c.visible).length} expected(${MODE})=${want}: ${brief}`);
      }
      // Never primed on a fresh workspace, in either mode (nothing is unpushed).
      ctx.clause('fresh/never-ready-to-push', controls.filter((c) => c.readyToPush).length === 0, `ready-to-push surfaces=${controls.filter((c) => c.readyToPush).length} (0 expected in both modes)`);
    },
  },
  {
    name: 'toolbar_with_pr', boots: true, ticket: '#229', boot: { linkedPr: { owner: 'avr-owner', repo: 'avr-repo', number: 4242, title: 'AVR seeded PR' } },
    doc: 'a linked OPEN PR (resolved through the real `gh api` path via a stub gh): the toolbar shows "PR #4242" in BOTH modes, never an Open PR button, and clicking it reaches main\'s openExternal with the PR url',
    async run(ctx) {
      const { app } = ctx; const wsId = app.world.ws.id;
      const url = 'https://github.com/avr-owner/avr-repo/pull/4242';
      // POSITIVE CONTROL: the PR really resolved — the stub gh was consulted for exactly this PR AND main's findPR returns it open.
      const pr = await waitFor('findPR open #4242', async () => { const r = await app.cdp.eval(`window.orchestra.findPR(${JSON.stringify(wsId)})`); return r && r.open && r.open.number === 4242 ? r : null; }, 40000, 500).catch(() => null);
      const ghLog = fs.existsSync(path.join(app.home, 'gh-calls.log')) ? fs.readFileSync(path.join(app.home, 'gh-calls.log'), 'utf8') : '';
      ctx.clause('control/pr-resolved', !!pr && ghLog.includes('api repos/avr-owner/avr-repo/pulls/4242'), `findPR.open=${pr ? JSON.stringify({ n: pr.open.number, state: pr.open.state, url: pr.open.url }) : 'null'}; gh stub calls=${JSON.stringify(ghLog.trim().split('\n').slice(0, 2))}`);
      const btn = await waitFor('toolbar PR button rendered', async () => { const cs = await app.prControls(); return cs.find((c) => c.tag === 'BUTTON' && c.text === 'PR #4242' && c.visible) ?? null; }, 30000, 300).catch(() => null);
      const controls = await app.prControls();
      const brief = JSON.stringify(controls.map((c) => ({ tag: c.tag, text: c.text, cls: c.cls })));
      ctx.clause('with-pr/pr-button', !!btn && controls.filter((c) => c.tag === 'BUTTON' && c.visible).length === 1, `expected exactly one visible toolbar PR button "PR #4242" (both modes): ${brief}`);
      ctx.clause('with-pr/no-open-pr-button', controls.filter((c) => c.create).length === 0 && controls.filter((c) => c.readyToPush).length === 0, `create/ready-to-push controls=${controls.filter((c) => c.create || c.readyToPush).length} (both modes: with a PR the old ternary never showed one)`);
      const tb = await app.cdp.eval(`(() => { const e = document.querySelector('.toolbar'); if (!e) return null; const r = e.getBoundingClientRect(); return { x: r.x, y: r.y, width: r.width, height: r.height }; })()`);
      if (tb) { const f = await app.shot('toolbar-with-pr', tb); const st = pngStats(fs.readFileSync(f)); console.log(`SHOT      toolbar-with-pr ${f} ${st.w}x${st.h} bytes=${st.bytes} distinct=${st.distinct} nonBg=${st.nonBgPct}%`); }
      // CLICK — trusted mouse event, hit-tested, then the effect is read off main's own log (`open external (renderer-ipc): <url>`), which only
      // a click that reached the IPC handler writes; the pre-click log must NOT already contain it.
      const logFile = path.join(app.home, 'logs', 'orchestra.log');
      const readLog = () => (fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '');
      const needle = `open external (renderer-ipc): ${url}`;
      const before = readLog().split(needle).length - 1;
      let clicked = false, why = '';
      try {
        if (!btn) throw new Error('no PR button to click');
        const hit = await app.cdp.eval(`(() => { const e = document.elementFromPoint(${btn.cx}, ${btn.cy}); const b = e && e.closest('button.pr-link'); return b ? b.textContent.trim() : null; })()`);
        if (hit !== 'PR #4242') throw new Error(`hit-test landed on ${JSON.stringify(hit)}`);
        await app.click(btn.cx, btn.cy); clicked = true;
      } catch (e) { why = e.message; }
      const after = await waitFor('main logged the open', () => (readLog().split(needle).length - 1 > before ? true : null), 8000, 200).catch(() => false);
      ctx.clause('with-pr/click-opens-pr-url', clicked && after, `pre-click matches=${before}; clicked=${clicked}${why ? ` (${why})` : ''}; main log line after click=${after} ("${needle}")`);
      const xdg = fs.existsSync(path.join(app.home, 'xdg-open.log')) ? fs.readFileSync(path.join(app.home, 'xdg-open.log'), 'utf8').trim() : '';
      console.log(`OBSERVED  xdg-open stub argv after click=${JSON.stringify(xdg)} (informational: Electron may hand the URL over without xdg-open)`);
    },
  },
  {
    name: 'sandbox_paused', boots: true, ticket: '#226', boot: { sandbox: true },
    doc: 'sandbox-hosted workspaces: starting their agent is refused naming the pause + #220 — Agent-view send (error row), CLI restart (rc!=0 + message), CLI message wake (no local PTY fallback); a local workspace in the same boot is unaffected',
    async run(ctx) {
      const { app } = ctx; const { sbx, ws: local } = app.world; const want = pick(EXPECT.sandboxPaused);
      // seeded state read back from the RUNNING app's store, not from my seed
      const seen = await app.cdp.eval(`window.orchestra.listWorkspaces().then(l => l.map(w => ({ id: w.id, host: w.host ? w.host.kind : null })))`);
      const hostOf = (id) => seen.find((w) => w.id === id)?.host;
      ctx.clause('seed/sandbox-hosted-in-app-store', hostOf(sbx.gone.id) === 'sandbox' && hostOf(sbx.live.id) === 'sandbox' && hostOf(local.id) === null,
        `app store host kinds: gone=${hostOf(sbx.gone.id)} live=${hostOf(sbx.live.id)} local=${hostOf(local.id)}`);
      ctx.clause('seed/gone-path-absent-live-path-present', !fs.existsSync(sbx.gone.worktreePath) && fs.existsSync(sbx.live.worktreePath), `gone=${fs.existsSync(sbx.gone.worktreePath)} live=${fs.existsSync(sbx.live.worktreePath)}`);

      // ── 1. Agent-view send on a sandbox workspace ────────────────────────────────────────────
      await activateWorkspace(app, 'avr-sbx-gone');
      await openAgentTab(app);
      const MARK = 'AVR-SEND-SBX-1f3a';
      const sent = await composerSend(app, MARK);
      const errRow = await waitFor('error row', async () => { const r = await messageRows(app); return r && r.errors.length ? r : null; }, 30000, 250).catch(() => null);
      const errText = errRow ? errRow.errors.join(' | ') : '';
      console.log(`OBSERVED  agent-view-send(${sbx.gone.id}) error rows=${errRow ? errRow.errors.length : 0}: ${JSON.stringify(oneLine(errText, 300))}`);
      // the send fired = the composer was cleared at submit (seen transiently when it is restored) OR main answered with an error row
      ctx.clause('agent-view-send/composer-submitted', !!sent.pre?.includes(MARK) && (sent.sawCleared || !!errRow), `composer text pre=${JSON.stringify(oneLine(sent.pre, 40))} sawCleared=${sent.sawCleared} errorRow=${!!errRow} (trusted Enter)`);
      // r2 L1 (verifier1): a REFUSED send must not eat what the user typed. baseline (master): the lazy start "succeeds", so nothing rejects and the text stays gone.
      const kept = (await composerText(app))?.includes(MARK) ?? false;
      ctx.clause('agent-view-send/refused-send-keeps-typed-text', kept === want, `composer still holds the typed text=${kept} expected(${MODE})=${want} (final composer text ${JSON.stringify(oneLine(await composerText(app), 50))})`);
      ctx.clause('agent-view-send/error-row-appears', !!errRow, errRow ? `error row: ${oneLine(errText)}` : 'NO error row within 30 s');
      ctx.clause('agent-view-send/error-names-pause-and-220', namesPause(errText) === want, `names pause+#220=${namesPause(errText)} expected(${MODE})=${want} :: ${oneLine(errText)}`);
      const listRect = await app.cdp.eval(`(() => { for (const l of document.querySelectorAll('.av-message-list')) { const r = l.getBoundingClientRect(); if (r.width > 50 && r.height > 50) return { x: r.x, y: r.y, width: r.width, height: r.height }; } return null; })()`);
      if (listRect) console.log(`SHOT      agent-view-send-error ${await app.shot('sandbox-agent-view-send', listRect)}`);

      // ── 2. CLI restart of the same workspace: not-ok, same message ───────────────────────────
      const rs = await runCli(app, ['restart', sbx.gone.id]);
      console.log(`OBSERVED  cli restart ${sbx.gone.id}: rc=${rs.rc} stdout=${JSON.stringify(oneLine(rs.stdout))} stderr=${JSON.stringify(oneLine(rs.stderr))}`);
      // baseline (measured on master): the SDK start is lazy, so `restart` reports success and the failure surfaces later as an error row.
      ctx.clause('cli-restart/not-ok', rs.rc !== null && (rs.rc !== 0) === want, `rc=${rs.rc} expected(${MODE}) ${want ? 'not-ok (a restart of a paused sandbox agent must fail)' : 'ok — the pre-pause lazy start'}; stdout=${JSON.stringify(oneLine(rs.stdout, 80))}`);
      ctx.clause('cli-restart/names-pause-and-220', namesPause(rs.stderr) === want, `names pause+#220=${namesPause(rs.stderr)} expected(${MODE})=${want} :: stderr=${oneLine(rs.stderr)}`);
      // F5: a refused restart writes NOTHING (recordRestart ran before the funnel threw). baseline (master): the lazy restart "succeeds" and records.
      const restartsPre = await restartsOf(app, sbx.gone.id);
      const rs2 = await runCli(app, ['restart', sbx.gone.id]);
      const restartsPost = await restartsOf(app, sbx.gone.id);
      console.log(`OBSERVED  cli restart #2 ${sbx.gone.id}: rc=${rs2.rc} sdkRestarts ${restartsPre} -> ${restartsPost}`);
      ctx.clause('cli-restart/refused-restart-writes-no-state', want ? restartsPost === restartsPre : restartsPost > restartsPre, `store sdkRestarts ${restartsPre} -> ${restartsPost} expected(${MODE}) ${want ? 'unchanged' : 'grown (master records a restart that then fails)'}`);
      // F2: `--fresh` (sdkClear) never reaches the funnel — the dispatcher must refuse it too, and must not clear the session id.
      const fr = await runCli(app, ['restart', sbx.gone.id, '--fresh']);
      const sessAfter = await app.cdp.eval(`window.orchestra.listWorkspaces().then(l => (l.find(w => w.id === ${JSON.stringify(sbx.gone.id)}) || {}).sdkSessionId)`);
      console.log(`OBSERVED  cli restart --fresh ${sbx.gone.id}: rc=${fr.rc} stdout=${JSON.stringify(oneLine(fr.stdout))} stderr=${JSON.stringify(oneLine(fr.stderr))} sdkSessionId now ${JSON.stringify(sessAfter)}`);
      ctx.clause('cli-restart-fresh/not-ok', fr.rc !== null && (fr.rc !== 0) === want, `rc=${fr.rc} expected(${MODE}) ${want ? 'not-ok' : 'ok — master clears the conversation of a workspace it cannot run'}`);
      ctx.clause('cli-restart-fresh/names-pause-and-220', namesPause(fr.stderr) === want, `names pause+#220=${namesPause(fr.stderr)} expected(${MODE})=${want} :: stderr=${oneLine(fr.stderr)}`);
      ctx.clause('cli-restart-fresh/session-id-untouched', want ? sessAfter === sbx.gone.sdkSessionId : sessAfter === '', `sdkSessionId=${JSON.stringify(sessAfter)} expected(${MODE}) ${want ? JSON.stringify(sbx.gone.sdkSessionId) : "'' (cleared)"}`);
      // F4: a LEGACY sandbox ws (hasInput, no session id) classifies to the host-aware PTY route — must be refused before the classifier.
      const lg = await runCli(app, ['restart', sbx.legacy.id]);
      console.log(`OBSERVED  cli restart legacy ${sbx.legacy.id}: rc=${lg.rc} stdout=${JSON.stringify(oneLine(lg.stdout))} stderr=${JSON.stringify(oneLine(lg.stderr))}`);
      // baseline (measured on master AFTER #228): the legacy ws is routed to the SDK wake path, whose lazy start "succeeds" (rc 0); before #228 it dialled the container (ECONNREFUSED).
      ctx.clause('cli-restart-legacy/not-ok', lg.rc !== null && (lg.rc !== 0) === want, `rc=${lg.rc} expected(${MODE}) ${want ? 'not-ok (refused before the classifier, no dial)' : 'ok — the pre-pause lazy wake'}`);
      ctx.clause('cli-restart-legacy/names-pause-and-220', namesPause(lg.stderr) === want, `names pause+#220=${namesPause(lg.stderr)} expected(${MODE})=${want} :: stderr=${oneLine(lg.stderr)}`);
      // r2 F1: the TOOLBAR Restart (`restartAgent` IPC) must REJECT naming the pause — its callers show the rejection — not resolve into a silent neutral "Resume your session" row.
      const tb = await ipcSettle(app, `window.orchestra.restartAgent(${JSON.stringify(sbx.gone.id)})`);
      console.log(`OBSERVED  restartAgent(${sbx.gone.id}) [toolbar Restart]: ${JSON.stringify(tb)}`);
      ctx.clause('toolbar-restart/throws-the-pause', want ? (!tb.ok && namesPause(tb.message)) : tb.ok, `settled=${JSON.stringify(tb).slice(0, 200)} expected(${MODE}) ${want ? 'reject naming pause+#220' : 'resolve (master: silent; the failure surfaces later as a cryptic error row)'}`);

      // ── 3. PTY-listing positive control (the local workspace), then CLI message wake of the sandbox workspace whose local dir EXISTS ──
      await activateWorkspace(app, 'avr-1');
      await runControl(ctx);
      const before = await app.ptys();
      const paused = (ps) => ps.filter((p) => p.kind === 'agent' && p.workspaceId === sbx.live.id);
      const wk = await runCli(app, ['message', sbx.live.id, 'AVR-WAKE-PROBE']);
      await sleep(ABSENCE_MS);
      const afterPs = await app.ptys();
      console.log(`OBSERVED  cli message ${sbx.live.id}: rc=${wk.rc} stdout=${JSON.stringify(oneLine(wk.stdout))} stderr=${JSON.stringify(oneLine(wk.stderr))} agent PTYs for it: before=${paused(before).length} after=${paused(afterPs).length} (${fmtP(afterPs)})`);
      // after: parked in the inbox (story 14), never claimed started; baseline (measured on master): 'started' — a FALSE claim, the lazy SDK start "succeeds" and dies later.
      const delivery = /Delivered \((\w+)\)/.exec(wk.stdout)?.[1] ?? null;
      ctx.clause('cli-message-wake/delivery', delivery === (want ? 'inbox' : 'started'), `delivery=${delivery} expected(${MODE})=${want ? 'inbox' : 'started'} rc=${wk.rc} stdout=${JSON.stringify(oneLine(wk.stdout, 80))}`);
      // BOTH modes: no local agent may run for a sandbox workspace whose leftover local dir exists. Master passes (nothing falls back); the funnel refusal ALONE opens the
      // hole (sdkStartAndDeliver -> false -> PTY fallback with no `host`), which only the wake refusal closes — the mutant that drops it turns THIS clause red.
      noAgentPty(ctx, 'cli-message-wake/no-agent-pty-for-paused-workspace', afterPs.filter((p) => p.workspaceId === sbx.live.id));
      const logText = (() => { try { return fs.readFileSync(path.join(app.home, 'logs', 'orchestra.log'), 'utf8'); } catch { return ''; } })();
      ctx.clause('cli-message-wake/app-log-readable', /\bINFO\b|\bWARN\b/.test(logText), `logs/orchestra.log ${logText.length} bytes (the log-line clause below is meaningless on an unreadable log)`);
      const refusedLine = logText.split('\n').find((l) => l.includes(`wake refused for ${sbx.live.id}`)) ?? '';
      ctx.clause('cli-message-wake/refusal-logged-with-pause-message', !!refusedLine === want && (!want || namesPause(refusedLine)), `wake-refused log line present=${!!refusedLine} expected(${MODE})=${want} :: ${oneLine(refusedLine)}`);

      // ── 3b. fix-checks / send-review over IPC: a paused agent THROWS the pause, never answers 'requested' into nothing (F3) ──
      const sr = await ipcSettle(app, `window.orchestra.sendReviewToAgent(${JSON.stringify(sbx.gone.id)}, 'AVR-REVIEW-PROBE')`);
      console.log(`OBSERVED  sendReviewToAgent(${sbx.gone.id}): ${JSON.stringify(sr)}`);
      ctx.clause('send-review/throws-the-pause', want ? (!sr.ok && namesPause(sr.message)) : (sr.ok && sr.value?.status === 'requested'), `settled=${JSON.stringify(sr).slice(0, 200)} expected(${MODE}) ${want ? 'reject naming pause+#220' : "resolve 'requested' (master: a false claim, the failure surfaces later as a cryptic error row)"}`);
      const fx = await ipcSettle(app, `window.orchestra.fixChecks(${JSON.stringify(sbx.gone.id)})`);
      console.log(`OBSERVED  fixChecks(${sbx.gone.id}): ${JSON.stringify(fx)}`);
      ctx.clause('fix-checks/throws-the-pause', want ? (!fx.ok && namesPause(fx.message)) : !namesPause(fx.message ?? ''), `settled=${JSON.stringify(fx).slice(0, 200)} expected(${MODE}) ${want ? 'reject naming pause+#220 (before any gh call)' : 'anything but the pause'}`);

      // ── 3c. UI /clear (`agentSdkClear`): rejects naming the pause and keeps the session id (r2 F3; the CLI `--fresh` clause covers the other caller of sdkClear) ──
      const cl = await ipcSettle(app, `window.orchestra.agentSdkClear(${JSON.stringify(sbx.live.id)})`);
      const liveSess = await app.cdp.eval(`window.orchestra.listWorkspaces().then(l => (l.find(w => w.id === ${JSON.stringify(sbx.live.id)}) || {}).sdkSessionId)`);
      console.log(`OBSERVED  agentSdkClear(${sbx.live.id}): ${JSON.stringify(cl)} sdkSessionId now ${JSON.stringify(liveSess)}`);
      ctx.clause('ui-clear/throws-the-pause', want ? (!cl.ok && namesPause(cl.message)) : cl.ok, `settled=${JSON.stringify(cl).slice(0, 200)} expected(${MODE}) ${want ? 'reject naming pause+#220' : 'resolve (master clears the conversation of a workspace it cannot run)'}`);
      ctx.clause('ui-clear/session-id-untouched', want ? liveSess === sbx.live.sdkSessionId : liveSess === '', `sdkSessionId=${JSON.stringify(liveSess)} expected(${MODE}) ${want ? JSON.stringify(sbx.live.sdkSessionId) : "'' (cleared)"}`);

      // ── 4. Positive control: a LOCAL workspace's Agent-view send is NOT refused ──────────────
      await openAgentTab(app);
      const LMARK = 'AVR-SEND-LOCAL-77c2';
      const ls = await composerSend(app, LMARK);
      // control for the restore: a SUCCESSFUL send still clears the composer and it STAYS cleared (a restore-always mutant turns this red)
      ctx.clause('local-control/composer-submitted', !!ls.pre?.includes(LMARK) && ls.sawCleared && !ls.final.includes(LMARK), `composer text pre=${JSON.stringify(oneLine(ls.pre, 40))} sawCleared=${ls.sawCleared} final=${JSON.stringify(oneLine(ls.final, 40))} (must stay cleared)`);
      await sleep(4000);
      const lr = await messageRows(app);
      const lErr = (lr?.errors ?? []).join(' | ');
      console.log(`OBSERVED  local send(${local.id}): user rows=${JSON.stringify((lr?.users ?? []).map((u) => oneLine(u, 60)))} error rows=${JSON.stringify(oneLine(lErr, 200))}`);
      ctx.clause('local-control/not-refused-with-pause', !!lr && !namesPause(lErr) && !/paused/i.test(lErr), `pause text in local error rows=${namesPause(lErr)} (rows: ${JSON.stringify(oneLine(lErr, 120))})`);
      ctx.clause('local-control/user-turn-rendered', !!lr && lr.users.some((u) => u.includes(LMARK)), `user rows=${JSON.stringify((lr?.users ?? []).map((u) => oneLine(u, 60)))} — the send got past ensureSession`);
      const lsr = await ipcSettle(app, `window.orchestra.sendReviewToAgent(${JSON.stringify(local.id)}, 'AVR-REVIEW-LOCAL')`);
      ctx.clause('local-control/send-review-still-requested', lsr.ok && lsr.value?.status === 'requested', `settled=${JSON.stringify(lsr).slice(0, 160)} (a local ws with a live session takes the review as its next turn)`);
    },
  },
];

// ── driver ───────────────────────────────────────────────────────────────────
async function main() {
  if (LIST) {
    for (const a of ARMS) console.log(`${a.name.padEnd(22)} ${a.boots ? 'boots ' : 'no-boot'} ${a.ticket}  ${a.doc}`);
    process.exit(0);
  }
  if (!APP_DIR) { console.error('usage: e2e-agent-view-removal.sh <app-dir> [--mode baseline|after] [--arm a,b] [--list] [--broken-control] [--allow-stale]'); process.exit(2); }
  const sel = ARM_SEL ? ARM_SEL.split(',') : ARMS.map((a) => a.name);
  const unknown = sel.filter((n) => !ARMS.some((a) => a.name === n));
  if (unknown.length) { console.error(`unknown arm(s): ${unknown.join(', ')} — try --list`); process.exit(2); }
  console.log(`RIG agent-view-removal mode=${MODE} arms=${sel.join(',')} app-dir=${APP_DIR}`);
  const sid = staticIdentity();
  console.log(`IDENTITY(static) git=${sid.gitInfo} version(package.json)=${sid.pkgVersion} main=${sid.chunk ?? '?'} md5=${sid.mainMd5} renderer=${sid.rendererFiles.join(',')}`);
  const pre = makeCtx('preflight'); const fresh = distFreshness();
  if (fresh.ok) pre.clause('identity/dist-fresh', true, fresh.detail);
  else if (ALLOW_STALE) pre.allowedStale('identity/dist-fresh', `${fresh.detail} [--allow-stale: proceeding on a STALE build — results are NOT a clean PASS]`);
  else pre.clause('identity/dist-fresh', false, fresh.detail);
  if (!fresh.ok && !ALLOW_STALE) return finish(sel);
  if (RIG.rigDir) { if (RIG_OWNER) fs.writeFileSync(path.join(RIG.rigDir, OWNER_MARKER), RIG_OWNER); fs.writeFileSync(path.join(RIG.rigDir, KEEP_MARKER), 'removed when this invocation ends with 0 FAIL'); }
  if (RIG.rigDir) {
    const pr = pruneStaleRigDirs(path.dirname(RIG.rigDir), RIG.rigDir);
    if (pr.disabled) console.log('PRUNE     disabled: no invoker identity (could not resolve this worktree) — nothing pruned');
    const why = pr.kept.reduce((m, [, r]) => ((m[r] = (m[r] ?? 0) + 1), m), {});
    console.log(`PRUNE     removed ${pr.removed.length} stale rig dir(s); kept ${pr.kept.length}: ${Object.entries(why).map(([r, n]) => `${n} ${r}`).join(', ') || 'none'}`);
  }
  for (const arm of ARMS.filter((a) => sel.includes(a.name))) {
    const ctx = makeCtx(arm.name);
    console.log(`--- arm ${arm.name}: ${arm.doc}`);
    try {
      if (arm.boots) {
        ctx.app = await bootApp(arm.name, arm.boot ?? {});
        try {
          await identityAndIsolation(ctx, ctx.app);
          await ready(ctx.app);
          await arm.run(ctx);
        } finally { await ctx.app.close(); liveCheck(ctx, ctx.app); }
      } else await arm.run(ctx);
    } catch (e) {
      ctx.clause('arm-completed', false, `HARNESS-ERROR ${e.message}`);
      if (e.app) { liveCheck(ctx, e.app); ctx.app = e.app; } // boot failed after launch: the live dirs must still be untouched
    }
    // F1: a boot arm whose live-dir verdict never ran (liveCheck skipped/removed) must not read as clean.
    if (arm.boots && ctx.app) ctx.clause('isolation/live-config-check-ran', RESULTS.some((r) => r.arm === ctx.arm && r.clause === 'isolation/live-config-untouched'), 'this arm emitted isolation/live-config-untouched');
    if (arm.boots) retain(ctx, ctx.app);
  }
  finish(sel);
}
/** Tally of a result list: skip / allowed-stale / external-change are counted APART from pass (F7), and the verdict names them (F8). */
function tally(results) {
  const fail = results.filter((r) => !r.ok).length, skip = results.filter((r) => r.skip).length, stale = results.filter((r) => r.allowedStale).length, ext = results.filter((r) => r.externalChange).length;
  const pass = results.length - fail - skip - stale - ext;
  const verdict = fail ? 'FAIL' : stale ? 'PASS-ON-STALE-BUILD' : ext ? 'PASS-WITH-EXTERNAL-CHANGE' : 'PASS';
  return { fail, skip, stale, ext, pass, verdict };
}
/** KEEP-UNTIL-CLEAN stays while the invocation has any FAIL (or never finishes); only a 0-FAIL run makes its dir prunable. */
function settleKeepMarker(rigDir, fail) { if (!fail && rigDir) fs.rmSync(path.join(rigDir, KEEP_MARKER), { force: true }); }
function finish(sel) {
  const t = tally(RESULTS);
  const out = path.join(RIG.rigDir || os.tmpdir(), `result-${MODE}.json`);
  fs.writeFileSync(out, JSON.stringify({ mode: MODE, appDir: APP_DIR, results: RESULTS }, null, 2));
  settleKeepMarker(RIG.rigDir, t.fail);
  console.log(`RIG-RESULT verdict=${t.verdict} mode=${MODE} arms=${sel.length} clauses=${RESULTS.length} pass=${t.pass} fail=${t.fail} skip=${t.skip} allowed_stale=${t.stale} external_change=${t.ext} artifact=${out}`);
  process.exit(t.fail ? 1 : 0);
}
main().catch((e) => { console.error(`RIG-RESULT HARNESS-ERROR ${e.stack ?? e}`); process.exit(2); });
