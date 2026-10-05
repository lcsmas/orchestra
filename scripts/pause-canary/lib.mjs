// Pause canary (#258, wave F ledger #281) — rig library. The PACKAGED Orchestra app (`release/linux-arm64-unpacked/orchestra`) in a headless sway
// (scripts/e2e-contained-rig.sh), scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR, a LEAD ⊃ OPS ⊃ w1..wN fleet seeded in store.json + a scratch
// bus.sqlite (pause switch ON for THAT run only), structured sessions = the REAL keeper + REAL `claude` CLI against a LOCAL scripted fake Anthropic
// API (zero tokens). Derived from the wave-E G3 skeleton (ledger #276). Every path is under the scratch base; nothing live is ever touched.
import { execFileSync, spawn } from 'node:child_process';
import fs from 'node:fs';
import http from 'node:http';
import net from 'node:net';
import os from 'node:os';
import path from 'node:path';
import readline from 'node:readline';
import { fileURLToPath } from 'node:url';
import { createHash } from 'node:crypto';
import { uid, branchOf, namesOf } from './ids.mjs';

export const HERE = path.dirname(fileURLToPath(import.meta.url));
export const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
export const say = (...a) => console.log(...a);
/** the passwd home — `$HOME` inside the contained rig is the FAKE home */
export const REAL_HOME = os.userInfo().homedir;
const realpathOr = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };
const LIVE = ['.orchestra', '.claude', '.claude-mc', '.claude-perso', '.config'].flatMap((d) => { const a = path.join(REAL_HOME, d); const b = realpathOr(a); return b === a ? [a] : [a, b]; });   // the symlink AND what it points to (a dotfiles-managed ~/.claude)
/** any top-level dir of the real home that LOOKS like a live agent/config home (`.claude-work`, `.orchestra-dev`, `.config`…) is off limits too */
const liveLike = (r) => { const rel = path.relative(REAL_HOME, r); return !rel.startsWith('..') && !path.isAbsolute(rel) && /^\.(claude|orchestra|config)/.test(rel.split(path.sep)[0] ?? ''); };
const real = (p) => { try { return fs.realpathSync(p); } catch { return path.resolve(p); } };

let BASE = null;
/** Declare the scratch base once (the runner passes it). It must not be, or be inside, a live config dir. */
export function initBase(base) {
  const r = real(path.resolve(base));
  for (const l of LIVE) if ((r + path.sep).startsWith(l + path.sep) || (l + path.sep).startsWith(r + path.sep)) throw new Error(`SCRATCH-ONLY: base ${r} overlaps live ${l}`);
  if (liveLike(r)) throw new Error(`SCRATCH-ONLY: base ${r} sits in a live-looking home dir`);
  BASE = r;
  process.env.PC_BASE = r;
}
export const scratchBase = () => BASE;
export function assertScratch(label, p) {
  if (!BASE) throw new Error('SCRATCH-ONLY: initBase() was not called');
  const r = real(path.resolve(p));
  if (!(r + path.sep).startsWith(BASE + path.sep) || r === BASE) throw new Error(`SCRATCH-ONLY: ${label}=${r} is not strictly inside ${BASE}`);
  for (const l of LIVE) if ((r + path.sep).startsWith(l + path.sep)) throw new Error(`SCRATCH-ONLY: ${label}=${r} is inside live ${l}`);
  if (liveLike(r)) throw new Error(`SCRATCH-ONLY: ${label}=${r} sits in a live-looking home dir`);
}

// ── containment: the values must come from the rig's own sway (e2e-contained-rig.sh) ────────────────────────────
export function preflight() {
  if (process.env.DISPLAY) throw new Error('ABORT: X11 DISPLAY present');
  const WL = process.env.WAYLAND_DISPLAY;
  if (!process.env.RIG_WAYLAND || WL !== process.env.RIG_WAYLAND || WL === 'wayland-1') throw new Error(`ABORT: WAYLAND_DISPLAY ${WL} != rig's ${process.env.RIG_WAYLAND}`);
  say(`CONTAINMENT rig_wayland=${process.env.RIG_WAYLAND} WAYLAND_DISPLAY=${WL} DISPLAY=<unset> SWAYSOCK=${process.env.SWAYSOCK}`);
  return WL;
}

// ── live snapshot (D6: nothing under ~/.claude* / the live bus may change during a drill) ───────────────────────
/** A name a live config dir creates and removes by itself (`.claude.json.tmp`, `*.lock`, editor swap files): counting it made `liveSnapshot` flap (`.claude` 43→42 with identical manifests = a FALSE FAIL, verifier n°2 H-2). Trade-off: a leak NAMED like this is ignored too (the real CLI writes such names itself); every other entry, link count and the inherit-manifest hash are still compared. */
export const isTransientName = (n) => /(^|\.)(tmp|lock|swp)(\.|-|$)|\.tmp\b|~$/.test(n);
export function liveSnapshot(home = REAL_HOME) {
  const out = {};
  for (const d of ['.claude', '.claude-mc', '.claude-perso']) {
    const p = path.join(home, d);
    try {
      const names = fs.readdirSync(p).filter((n) => !isTransientName(n)).sort();
      const links = names.filter((n) => { try { return fs.lstatSync(path.join(p, n)).isSymbolicLink(); } catch { return false; } });
      const man = path.join(p, '.orchestra-inherited.json');
      out[d] = { n: names.length, links: links.length, manifest: fs.existsSync(man) ? execFileSync('sha256sum', [man], { encoding: 'utf8' }).slice(0, 16) : null };
    } catch { out[d] = null; }
  }
  // the live bus MUST NOT be read for content (D6) — only its identity (it grows with live traffic, so size/mtime are not compared: existence only)
  out.liveBusPresent = fs.existsSync(path.join(home, '.orchestra', 'bus.sqlite'));
  return out;
}

// ── host guards (the OPS bar: MemAvailable ≥ 6 GB, load ≤ 20) ───────────────────────────────────────────────────
export function hostNow() {
  const mem = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = (k) => Number(new RegExp(`${k}:\\s+(\\d+) kB`).exec(mem)?.[1] ?? 0);
  return { availGB: kb('MemAvailable') / 1048576, load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]), swapUsedGB: (kb('SwapTotal') - kb('SwapFree')) / 1048576 };
}

// ── scripted fake Anthropic API ─────────────────────────────────────────────────────────────────────────────────
const sse = (ev, data) => `event: ${ev}\ndata: ${JSON.stringify(data)}\n\n`;
const usage = (n = 12) => ({ input_tokens: n, output_tokens: 2, cache_creation_input_tokens: 0, cache_read_input_tokens: 0 });
function streamReply({ model, id, step }) {
  const head = sse('message_start', { type: 'message_start', message: { id, type: 'message', role: 'assistant', model, content: [], stop_reason: null, stop_sequence: null, usage: usage() } });
  if (step.tool) {
    const toolId = `toolu_${id.slice(-8)}`;
    return [head,
      sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'tool_use', id: toolId, name: step.tool.name, input: {} } }),
      sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'input_json_delta', partial_json: JSON.stringify(step.tool.input) } }),
      sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
      sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'tool_use', stop_sequence: null }, usage: usage() }),
      sse('message_stop', { type: 'message_stop' })].join('');
  }
  return [head,
    sse('content_block_start', { type: 'content_block_start', index: 0, content_block: { type: 'text', text: '' } }),
    sse('content_block_delta', { type: 'content_block_delta', index: 0, delta: { type: 'text_delta', text: step.text ?? 'ok' } }),
    sse('content_block_stop', { type: 'content_block_stop', index: 0 }),
    sse('message_delta', { type: 'message_delta', delta: { stop_reason: 'end_turn', stop_sequence: null }, usage: usage() }),
    sse('message_stop', { type: 'message_stop' })].join('');
}
export const textOf = (c) => (typeof c === 'string' ? c : Array.isArray(c) ? c.map((b) => (b && b.type === 'text' ? b.text : b && b.type === 'tool_result' ? textOf(b.content) : '')).join('\n') : '');
/** the Pause-douce order the host injects at a tool-result boundary (src/shared/pause-douce.ts renderPauseOrder) */
export const ORDER_RE = /PAUSE DOUCE — run /;
const ROLE_RE = /auto-generated branch 'pc-([a-z0-9]+)'/;

/** `decide({ messages, lastText, tools, seq, role, cred }) → step | { http: {status, headers, body} }`. A request with tools is a member's main request (side requests get `ok`).
 *  `role` = which workspace's session this is (the SessionStart hook text names its branch `pc-<role>`). Every request is logged (`requests`) with its timestamp. */
export async function startApi({ decide, usageHeaders = null }) {
  const requests = [];
  let n = 0;
  const server = http.createServer(async (req, res) => {
    req.socket.on('error', () => {});
    const chunks = [];
    for await (const c of req) chunks.push(c);
    const body = Buffer.concat(chunks);
    const t = Date.now();
    const p = new URL(req.url ?? '/', 'http://fake.invalid').pathname.replace(/\/+$/, '');
    if (req.method === 'POST' && p === '/v1/messages') {
      let b = {};
      try { b = JSON.parse(body.toString('utf8')); } catch { /* {} */ }
      const messages = b.messages ?? [];
      const tools = Array.isArray(b.tools) ? b.tools.length : 0;
      const last = messages[messages.length - 1];
      const lastText = last ? textOf(last.content) : '';
      let lastAsst = -1;
      for (let i = messages.length - 1; i >= 0; i--) if (messages[i].role === 'assistant') { lastAsst = i; break; }
      const order = tools > 0 && messages.slice(lastAsst + 1).some((m) => ORDER_RE.test(textOf(m.content)));
      // the request answers the harness's own human `SCN:limit` prompt AND nothing else: a 429 leaves no assistant reply, so a LATER wake still carries that prompt in its tail — it is told apart by its own text
      const tailText = messages.slice(lastAsst + 1).map((m) => textOf(m.content)).join('\n');
      const limitPrompt = tools > 0 && /SCN:limit/.test(tailText) && !/lot pending|task-notification|PAUSE DOUCE|consigne de reprise/i.test(tailText);
      const latePrompt = tools > 0 && /SCN:late/.test(tailText);   // the request that answers the harness's `--inject late-request` human prompt (the tail, not the last block: the CLI appends reminder blocks after the prompt)
      const cred = String(req.headers['x-api-key'] ?? req.headers.authorization ?? '').replace(/^Bearer /, '');
      const sysText = textOf(b.system);
      const role = (ROLE_RE.exec(JSON.stringify(messages.slice(0, 4)))?.[1]) ?? (ROLE_RE.exec(JSON.stringify(messages))?.[1]) ?? (/\/wt-([a-z0-9]+)\b/.exec(sysText)?.[1]) ?? null;
      let step = { text: 'ok' };
      if (tools > 0) { try { step = (await decide({ messages, lastText, tools, seq: n + 1, sys: sysText, role, cred, order })) ?? step; } catch (e) { step = { text: `decide-error ${e}` }; } }
      const rec = { seq: ++n, t, model: b.model, tools, stream: b.stream === true, role, cred, order, limitPrompt, latePrompt, tool: step.tool?.name ?? null, http: step.http?.status ?? 200, probe: tools === 0 && b.max_tokens === 1, last: lastText.slice(0, 200) };
      requests.push(rec);
      if (step.http) { res.writeHead(step.http.status, { 'content-type': 'application/json', ...(step.http.headers ?? {}) }); res.end(JSON.stringify(step.http.body ?? {})); return; }
      const id = `msg_fake_${n}`;
      const probeHeaders = rec.probe && usageHeaders ? (usageHeaders(cred) ?? {}) : {};
      if (b.stream === true) {
        res.writeHead(200, { 'content-type': 'text/event-stream', 'cache-control': 'no-cache', 'request-id': `req_${n}` });
        res.end(streamReply({ model: b.model ?? 'claude-fake', id, step }));
      } else {
        res.writeHead(200, { 'content-type': 'application/json', 'request-id': `req_${n}`, ...probeHeaders });
        res.end(JSON.stringify({ id, type: 'message', role: 'assistant', model: b.model ?? 'claude-fake', content: [{ type: 'text', text: 'ok' }], stop_reason: 'end_turn', stop_sequence: null, usage: usage() }));
      }
      return;
    }
    if (req.method === 'POST' && p === '/v1/messages/count_tokens') { res.writeHead(200, { 'content-type': 'application/json' }); res.end(JSON.stringify({ input_tokens: Math.max(1, Math.ceil(body.length / 4)) })); return; }
    res.writeHead(404, { 'content-type': 'application/json' });
    res.end(JSON.stringify({ type: 'error', error: { type: 'not_found_error', message: `no route ${req.method} ${p}` } }));
  });
  await new Promise((resolve, reject) => { server.once('error', reject); server.listen(0, '127.0.0.1', resolve); });
  return { url: `http://127.0.0.1:${server.address().port}`, requests, stop: () => new Promise((r) => { server.closeAllConnections?.(); server.close(() => r()); }) };
}

// ── the rig: scratch dirs, fleet seed, app launch ───────────────────────────────────────────────────────────────
const GIT_ENV = { PATH: '/usr/bin:/bin', GIT_AUTHOR_NAME: 'pc', GIT_AUTHOR_EMAIL: 'pc@x', GIT_COMMITTER_NAME: 'pc', GIT_COMMITTER_EMAIL: 'pc@x', GIT_CONFIG_GLOBAL: '/dev/null', GIT_CONFIG_SYSTEM: '/dev/null' };
export const git = (cwd, ...a) => execFileSync('git', a, { cwd, encoding: 'utf8', env: { ...GIT_ENV, HOME: '/nonexistent' }, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'pipe'] }).trim();
export const gitSafe = (cwd, ...a) => { try { return git(cwd, ...a); } catch (e) { return `ERR ${String(e.stderr ?? e).slice(0, 120)}`; } };
/** null when git fails (a missing path / ref), the content otherwise — a missing marker is data, not an exception */
export const gitShow = (cwd, spec) => { try { return execFileSync('git', ['show', spec], { cwd, encoding: 'utf8', env: { ...GIT_ENV, HOME: '/nonexistent' }, maxBuffer: 16 << 20, stdio: ['ignore', 'pipe', 'ignore'] }).trim(); } catch { return null; } };

/** Account A = OAuth-env token (the real CLI turns a fake unified 429 into a real `rate_limit_event`); account B = an API-key account (its usage probe is answered by the fake API). */
export const TOKENS = { 'pc-a': 'sk-ant-oat01-pc-token-a' };
export const B_KEY = 'sk-ant-api03-pc-b-key-not-real';
export const ACCT_A = 'pc-a';
export const ACCT_B = 'pc-b';

/** Where the keeper of `wsId` listens (mirror of src/main/keeper-client.ts `keeperSocketPath`): `<home>/keepers/<id>.sock` when ≤ 100 chars, else the HOME-INDEPENDENT `/tmp/okeeper-<sha256(wsId)[:16]>.sock`. */
export function keeperSocketOf(H, wsId) {
  const full = path.join(H, 'keepers', `${wsId}.sock`);
  return full.length <= 100 ? { path: full, hashed: false, len: full.length } : { path: path.join(os.tmpdir(), `okeeper-${createHash('sha256').update(wsId).digest('hex').slice(0, 16)}.sock`), hashed: true, len: full.length };
}
/** Pre-flight: no keeper socket may ALREADY exist at a path this rig will use (another rig on the host with the same ws id would be cross-connected). Throws when one does. */
export function assertNoForeignKeeperSockets(H, spec) {
  const ids = [spec.lead, spec.ops, ...spec.workers.map((w) => w.id)];
  const socks = ids.map((id) => keeperSocketOf(H, id));
  const clash = socks.filter((s) => fs.existsSync(s.path));
  if (clash.length) throw new Error(`ABORT: keeper socket(s) already exist at ${clash.map((s) => s.path).join(', ')} — another rig on this host uses the same workspace ids (ids are random per rig: a stale socket of a crashed rig, or a collision) — refusing to cross-connect`);
  return { hashed: socks.filter((s) => s.hashed).length, total: socks.length, maxLen: Math.max(...socks.map((s) => s.len)) };
}

export async function makeRig({ label, spec, apiUrl, appBin, claudeBin }) {
  if (!appBin || !fs.existsSync(path.join(path.dirname(appBin), 'resources', 'app.asar'))) throw new Error(`ABORT: appBin ${appBin} is not a PACKAGED build (no resources/app.asar beside it) — the session \`orchestra\` shim only works packaged`);
  if (!/^[A-Za-z0-9._-]+$/.test(label) || label.includes('..')) throw new Error(`ABORT: rig label ${JSON.stringify(label)} must be [A-Za-z0-9._-]+ (it names a directory that is rm -rf'd)`);
  const H = path.join(BASE, `h-${label}`);
  assertScratch('H', H);
  const sockInfo = assertNoForeignKeeperSockets(H, spec);
  say(`[${label}] keeper sockets: ${sockInfo.hashed}/${sockInfo.total} fall back to /tmp/okeeper-<hash(wsId)> (path ≤ 100: no; longest ${sockInfo.maxLen} chars) — ids are per-rig random (${spec.prefix}), none pre-exists`);
  fs.rmSync(H, { recursive: true, force: true });
  for (const d of ['home', 'cfg', 'cfg-b', 'bin', 'userData/orchestra']) fs.mkdirSync(path.join(H, d), { recursive: true });
  fs.symlinkSync(fs.realpathSync(claudeBin), path.join(H, 'bin', 'claude'));
  const cfg = path.join(H, 'cfg'), cfgB = path.join(H, 'cfg-b');
  for (const c of [cfg, cfgB]) fs.writeFileSync(path.join(c, '.claude.json'), JSON.stringify({ hasCompletedOnboarding: true, numStartups: 5 }));
  const repo = path.join(H, 'repo');
  fs.mkdirSync(repo);
  git(repo, 'init', '-q', '-b', 'master');
  fs.writeFileSync(path.join(repo, 'a.txt'), 'base\n');
  git(repo, 'add', '-A'); git(repo, 'commit', '-q', '-m', 'init');
  const remote = path.join(H, 'remote.git');   // a bare "remote": a member's `git push` is a real push
  git(H, 'init', '-q', '--bare', remote);
  git(repo, 'remote', 'add', 'origin', remote);
  git(repo, 'push', '-q', 'origin', 'master');
  const acct = { id: ACCT_A, label: `pc rig A (oauth env, ${cfg})`, configDir: cfg, env: { ANTHROPIC_BASE_URL: apiUrl, NO_PROXY: '127.0.0.1,localhost', CLAUDE_CODE_OAUTH_TOKEN: TOKENS[ACCT_A] } };
  const acctB = { id: ACCT_B, label: `pc rig B (api key, ${cfgB})`, configDir: cfgB, auth: { mode: 'apiKey' } };
  const wt = (k) => path.join(H, `wt-${k}`);
  const mk = (k, id, extra = {}) => {
    git(repo, 'worktree', 'add', '-q', '-b', branchOf(k), wt(k));
    git(wt(k), 'config', 'user.email', 'pc@x'); git(wt(k), 'config', 'user.name', 'pc');
    return { id, name: `pc-${k}`, repoPath: repo, worktreePath: wt(k), branch: branchOf(k), baseBranch: 'master', createdAt: Date.now(), status: 'idle', agent: 'claude', accountId: acct.id, sdkSessionId: '', ...extra };
  };
  const wsList = [
    mk('lead', spec.lead, { canOrchestrate: true, kind: 'orchestrator' }),
    mk('ops', spec.ops, { canOrchestrate: true, kind: 'orchestrator', parentId: spec.lead }),
    ...spec.workers.map((w) => mk(w.k, w.id, { parentId: spec.ops, lastTask: `pc task ${w.k}` })),
  ];
  fs.writeFileSync(path.join(H, 'userData/orchestra/store.json'), JSON.stringify({ repos: [], workspaces: wsList, accounts: [acct, acctB], selfTuneRuns: [] }, null, 2));
  return { H, cfg, cfgB, repo, remote, wt, acct, acctB, wsList, spec, names: namesOf(spec), appBin, bus: null, sockInfo };
}

/** Seed the lead (mission) and ops (vague, parent lead) run rows with every switch ON (`seedTree` = the SOURCE tree matching the app under drive). */
export function seedRuns(rig, seedTree, mode = 'none') {
  const out = execFileSync(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(HERE, 'bus-tool.mjs'), 'seed', rig.H, seedTree, rig.spec.lead, rig.spec.ops, mode], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', HOME: path.join(rig.H, 'home'), PC_BASE: BASE }, maxBuffer: 16 << 20 });
  const line = out.split('\n').filter((l) => l.startsWith('{')).pop();
  return line ? JSON.parse(line) : null;
}

/** Persistent read-only SQL on the rig bus (spawned from MY tree: raw SQL needs no schema knowledge, so it also reads an older app's DB). */
export function startBusReader(rig, readerTree) {
  const child = spawn(process.execPath, ['--no-warnings', '--experimental-strip-types', path.join(HERE, 'bus-tool.mjs'), 'serve', rig.H, readerTree], { env: { PATH: '/usr/bin:/bin', HOME: path.join(rig.H, 'home'), PC_BASE: BASE }, stdio: ['pipe', 'pipe', 'inherit'] });
  const pend = new Map();
  let id = 0;
  readline.createInterface({ input: child.stdout }).on('line', (l) => { try { const d = JSON.parse(l); const r = pend.get(d.id); if (r) { pend.delete(d.id); r(d); } } catch { /* not ours */ } });
  /** rows, or null when the query fails (a table the app's schema does not have yet) */
  const q = (sql, ...args) => new Promise((resolve) => { const i = ++id; pend.set(i, (d) => resolve(d.err ? null : d.rows)); child.stdin.write(`${JSON.stringify({ id: i, sql, args })}\n`); });
  return { q, close: () => { try { child.stdin.end(); child.kill(); } catch { /* gone */ } } };
}

export async function launchApp(rig, { extraEnv = {} } = {}) {
  const WL = process.env.WAYLAND_DISPLAY;
  const port = await new Promise((res) => { const s = net.createServer().listen(0, () => { const p = s.address().port; s.close(() => res(p)); }); });
  const baseEnv = {
    PATH: `${rig.H}/bin:/usr/local/bin:/usr/bin:/bin`, HOME: path.join(rig.H, 'home'), XDG_RUNTIME_DIR: '/run/user/1000', LANG: 'C.UTF-8',
    WAYLAND_DISPLAY: WL, SWAYSOCK: process.env.SWAYSOCK ?? '', ELECTRON_OZONE_PLATFORM_HINT: 'wayland', ORCHESTRA_OZONE: 'wayland', ORCHESTRA_OZONE_RELAUNCHED: '1',
    ORCHESTRA_HOME: rig.H, CLAUDE_CONFIG_DIR: rig.cfg, ...extraEnv,
  };
  assertScratch('ORCHESTRA_HOME', baseEnv.ORCHESTRA_HOME); assertScratch('CLAUDE_CONFIG_DIR', baseEnv.CLAUDE_CONFIG_DIR); assertScratch('HOME', baseEnv.HOME);
  const logf = path.join(rig.H, 'app.log');
  const app = spawn(rig.appBin, ['--ozone-platform=wayland'], { cwd: rig.H, env: { ...baseEnv, ORCHESTRA_DEBUG_PORT: String(port), ORCHESTRA_SELF_TUNE_CMD: '/bin/true' }, stdio: ['ignore', fs.openSync(logf, 'w'), fs.openSync(logf, 'a')] });
  say(`APP pid=${app.pid} cdp=${port} PACKAGED ${rig.appBin}`);
  let target;
  for (let i = 0; i < 120 && !target; i++) { await sleep(500); try { const t = await (await fetch(`http://127.0.0.1:${port}/json`)).json(); target = t.find((x) => x.type === 'page' && x.url.includes('index.html')); } catch { /* not up */ } }
  if (!target) throw new Error('ABORT no page target');
  const env = fs.readFileSync(`/proc/${app.pid}/environ`, 'utf8').split('\0');
  const hasEnv = (k) => env.find((l) => l.startsWith(`${k}=`)) ?? `${k}=<unset>`;
  say(`APP-ENV ${hasEnv('WAYLAND_DISPLAY')} ${hasEnv('DISPLAY')} ${hasEnv('ORCHESTRA_HOME')} ${hasEnv('CLAUDE_CONFIG_DIR')} ${hasEnv('HOME')}`);
  if (env.some((l) => l.startsWith('DISPLAY='))) throw new Error('ABORT app env has DISPLAY');
  let swayHas = 0;
  for (let i = 0; i < 30 && !swayHas; i++) { // the window maps a moment after the page target appears: poll, still fail closed
    try { swayHas = (execFileSync('swaymsg', ['-t', 'get_tree'], { encoding: 'utf8', env: { PATH: '/usr/bin:/bin', SWAYSOCK: process.env.SWAYSOCK, XDG_RUNTIME_DIR: '/run/user/1000' } }).match(new RegExp(`"pid": ${app.pid}`, 'g')) ?? []).length; } catch { /* below */ }
    if (!swayHas) await sleep(500);
  }
  say(`SWAY-HAS-APP-PID ${swayHas}`);
  if (!swayHas) throw new Error('ABORT the app pid is not in MY sway tree');
  const cdp = await cdpConnect(target.webSocketDebuggerUrl);
  const cli = (who, args, o = {}) => runCli(rig, baseEnv, who, args, o);
  return { app, port, cdp, cli, baseEnv, kill: () => killTree(app.pid) };
}

function killTree(pid) { try { for (const k of execFileSync('pgrep', ['-P', String(pid)], { encoding: 'utf8' }).split('\n').filter(Boolean)) { try { process.kill(Number(k)); } catch { /* gone */ } } } catch { /* none */ } try { process.kill(pid); } catch { /* gone */ } }

/** The REAL built CLI (`<packaged binary> cli …`) as `who` (a workspace id; `run` = its $ORCHESTRA_RUN_ID). */
export function runCli(rig, baseEnv, who, args, { timeoutMs = 60000, run } = {}) {
  return new Promise((res) => {
    const env = { ...baseEnv, ORCHESTRA_WS_ID: who, ...(run ? { ORCHESTRA_RUN_ID: run } : {}) };
    const t0 = Date.now();
    const p = spawn(rig.appBin, ['cli', ...args], { cwd: rig.H, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let out = '', err = '';
    const t = setTimeout(() => { try { p.kill('SIGKILL'); } catch { /* gone */ } }, timeoutMs);
    p.stdout.on('data', (d) => (out += d)); p.stderr.on('data', (d) => (err += d));
    p.on('exit', (code) => { clearTimeout(t); res({ code, ms: Date.now() - t0, tStart: t0, out: out.trim(), err: err.split('\n').filter((l) => !/ERROR:bus\.cc|dbus|gpu_/i.test(l)).join('\n').trim() }); });
  });
}

// ── minimal CDP client (Node 22 global WebSocket) ───────────────────────────────────────────────────────────────
export async function cdpConnect(url) {
  const ws = new WebSocket(url);
  await new Promise((r, j) => { ws.onopen = r; ws.onerror = () => j(new Error('cdp ws error')); });
  let id = 0; const pend = new Map();
  ws.onmessage = (m) => { const d = JSON.parse(m.data); if (d.id && pend.has(d.id)) { pend.get(d.id)(d); pend.delete(d.id); } };
  const send = (method, params = {}) => new Promise((r) => { const i = ++id; pend.set(i, r); ws.send(JSON.stringify({ id: i, method, params })); });
  return {
    send,
    async eval(expression) {
      const r = await send('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true });
      if (r.result?.exceptionDetails) throw new Error(`cdp eval: ${JSON.stringify(r.result.exceptionDetails).slice(0, 300)}`);
      return r.result?.result?.value;
    },
    close: () => ws.close(),
  };
}

// ── process census (rig processes = environ ORCHESTRA_HOME == rig.H), identity = pid + /proc start time ────────
export function census(rig) {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d)) continue;
    const pid = Number(d);
    try {
      const env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8');
      if (!env.includes(`ORCHESTRA_HOME=${rig.H}\0`) && !env.endsWith(`ORCHESTRA_HOME=${rig.H}`)) continue;
      const stat = fs.readFileSync(`/proc/${pid}/stat`, 'utf8');
      const f = stat.slice(stat.lastIndexOf(')') + 2).split(' ');
      let cwd = ''; try { cwd = fs.readlinkSync(`/proc/${pid}/cwd`); } catch { /* */ }
      const cmd = fs.readFileSync(`/proc/${pid}/cmdline`, 'utf8').split('\0').join(' ').trim();
      let rssKB = 0; try { rssKB = Number(/VmRSS:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${pid}/status`, 'utf8'))?.[1] ?? 0); } catch { /* */ }
      out.push({ pid, ppid: Number(f[1]), startTicks: Number(f[19]), state: f[0], cwd, cmd, rssKB });
    } catch { /* gone or unreadable = not ours */ }
  }
  return out;
}
export const kindOf = (p) => (/keeper\.js/.test(p.cmd) ? 'keeper' : /\/claude(\s|$)|claude-code|\.local\/share\/claude\/versions|cli\.js.*--output-format/.test(p.cmd) || /\/versions\/\d/.test(p.cmd) ? 'claude' : /^(\S*\/)?orchestra( |$)/.test(p.cmd) && !/ cli /.test(p.cmd) ? 'app' : /^sleep |\bsleep \d/.test(p.cmd) ? 'tool-sleep' : /bash|sh -c/.test(p.cmd) ? 'tool-shell' : 'other');
/** Rig memory by process kind (PSS from /proc/<pid>/smaps_rollup: shared Electron/node pages counted once, so the sum is the real footprint; RSS when unreadable). */
export function rigMemory(rig) {
  const by = {};
  let totalMB = 0;
  for (const p of census(rig)) {
    let kb = p.rssKB;
    try { kb = Number(/Pss:\s+(\d+) kB/.exec(fs.readFileSync(`/proc/${p.pid}/smaps_rollup`, 'utf8'))?.[1] ?? kb); } catch { /* keep RSS */ }
    const k = kindOf(p);
    by[k] = by[k] ?? { n: 0, mb: 0 };
    by[k].n++; by[k].mb += kb / 1024; totalMB += kb / 1024;
  }
  return { totalMB, by };
}
/** the member (`w3`, `lead`, …) a process belongs to by its cwd (`<H>/wt-<k>`), or null */
export const memberOfCwd = (rig, p) => { const m = new RegExp(`^${rig.H.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')}/wt-([a-z0-9]+)(/|$)`).exec(p.cwd); return m ? m[1] : null; };

/** Teardown by IDENTITY: every rig process (ORCHESTRA_HOME == rig.H), pid+start re-read right before each signal; own pid never. */
export async function teardown(rig, app) {
  try { app?.kill(); } catch { /* */ }
  await sleep(1500);
  for (const sig of ['SIGTERM', 'SIGKILL']) {
    for (const p of census(rig)) {
      if (p.pid === process.pid) continue;
      try {
        const st = fs.readFileSync(`/proc/${p.pid}/stat`, 'utf8'); const f = st.slice(st.lastIndexOf(')') + 2).split(' ');
        if (Number(f[19]) !== p.startTicks) continue;
        process.kill(p.pid, sig);
      } catch { /* gone */ }
    }
    await sleep(1500);
  }
  return census(rig).filter((p) => p.pid !== process.pid);
}

export { uid, namesOf, branchOf };
