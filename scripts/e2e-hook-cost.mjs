// #198 D20 (T11): the per-call activity hook must cost O(payload), not O(payload²).
//
// Cause (measured): ORCHESTRA_HOOK_SCRIPT mined `tool_use_id` with
// `${payload#*"tool_use_id"}`; bash re-matches every prefix, so the cost is
// quadratic in the stdin PAYLOAD (the transcript is never read). A PostToolUse
// carries the tool_response (an Edit's `originalFile`, a Read's content) BEFORE
// the top-level id: the real 295 KB Edit payload of a 287 KB file took 46 s
// (field max 46.9 s, 2026-09-29). The CLI WAITS for the hook, so the agent is
// blocked the whole time (real CLI 2.1.284, 420 KB Edit: 70.95 s, no kill).
//
// Drives the REAL chain: installOrchestraHooks (SUBJECT tree) writes the hook →
// this rig plays Claude Code's hook dispatcher (payload on stdin, shapes captured
// from CLI 2.1.284) → the real events-spool reader → the real in-flight tracker.
// SUBJECT_REPO=<tree> drives another tree (G1: master must FAIL
// the mustFailOnMaster arms). BASE_REPO=<tree> is the byte-identity reference.
//
// Usage: node --experimental-strip-types --import ./scripts/.r2-register.mjs \
//          scripts/e2e-hook-cost.mjs <arm>      → one JSON line, `ok`.

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync, spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE_REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const REPO = path.resolve(process.env.SUBJECT_REPO ?? HERE_REPO);
const ARM = process.argv[2] ?? 'edit_real_size';
// The CLI logs `Slow PostToolUse hooks` from 2 s (field floor 2043 ms). The cap
// only bounds the rig: the CLI itself waited 70.95 s without a kill (real_cli_edit).
const BUDGET_MS = 2_000;
const RIG_CAP_MS = 120_000;
const HOOK_LANG = 'C.UTF-8';
if (spawnSync('bash', ['-c', 'x=é; printf %s "${#x}"'], { env: { PATH: '/usr/bin:/bin', LANG: HOOK_LANG } }).stdout?.toString() !== '1') {
  console.log(JSON.stringify({ arm: ARM, ok: false, error: `VOID: ${HOOK_LANG} is not a multibyte locale here` }));
  process.exit(0);
}

const ARMS = {
  edit_real_size: { mustFailOnMaster: true },
  failed_write_real_size: { mustFailOnMaster: true },
  scaling: { mustFailOnMaster: true },
  transcript_control: {},
  identity: {},
  websearch_nested_id: { mustFailOnMaster: true },
  reinstall_during_hook: { mustFailOnMaster: true },
  install_failure_no_tmp: {},
  real_cli_edit: { mustFailOnMaster: true },
  real_cli_websearch: { mustFailOnMaster: true },
};

// ── subprocess mode: run one tree's REAL installer into <dir> ─────────────────
if (ARM === '__install') {
  const [, , , repo, dir] = process.argv;
  await bootPlatform(dir, repo);
  const { installOrchestraHooks } = await import(`${repo}/src/main/workspaces.ts`);
  fs.mkdirSync(path.join(dir, 'wt'), { recursive: true });
  await installOrchestraHooks(path.join(dir, 'wt'));
  process.exit(0);
}

if (!ARMS[ARM]) {
  console.error(`unknown arm: ${ARM} (one of ${Object.keys(ARMS).join(', ')})`);
  process.exit(2);
}

// btrfs, never /tmp (ledger #198 briefing).
const REAL_HOME = os.homedir();
const base = path.join(process.env.T11_HOME ?? path.join(REAL_HOME, '.t11-rig', 'arms'), ARM);
if (!base.startsWith(REAL_HOME + path.sep)) throw new Error(`refusing rig dir outside $HOME: ${base}`);
fs.rmSync(base, { recursive: true, force: true });
const home = path.join(base, 'home');
const wt = path.join(base, 'worktree');
fs.mkdirSync(home, { recursive: true });
fs.mkdirSync(wt, { recursive: true });

const out = { arm: ARM, subject: REPO, ok: false };
const done = (extra) => {
  Object.assign(out, extra);
  console.log(JSON.stringify(out));
  process.exit(0);
};

async function bootPlatform(h, repo) {
  process.env.ORCHESTRA_HOME = h;
  process.env.HOME = h;
  const { initPlatform } = await import(`${repo}/src/main/platform/index.ts`);
  initPlatform({
    kind: 'headless-t11',
    broadcast: () => {},
    broadcastPtyData: () => {},
    canBroadcast: () => true,
    isFocused: () => false,
    hasAttachedUi: () => true, // the spool reader drains only with a UI attached
    notify: () => {},
    openExternal: () => {},
    showItemInFolder: () => {},
    openPath: () => {},
    openAccountLoginUrl: () => {},
    closeAccountLogin: () => {},
    getUserDataDir: () => h,
    getLogsDir: () => `${h}/logs`,
    getAppVersion: () => '0.0.0-t11',
    getAppMetrics: () => [],
    isEncryptionAvailable: () => false,
    encryptString: (s) => s,
    decryptString: (s) => s,
  });
}

// ── payloads, in CLI 2.1.284 key order (captured with a logger hook) ──────────
const common = (hookEvent) => ({
  session_id: 't11-session',
  transcript_path: path.join(home, 'transcript.jsonl'),
  cwd: wt,
  prompt_id: 't11-prompt',
  permission_mode: 'bypassPermissions',
  hook_event_name: hookEvent,
});
const preEdit = (id, file) => ({
  ...common('PreToolUse'),
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: '// XYZZY_MARK_1', new_string: '// XYZZY_MARK_2', replace_all: false },
  tool_use_id: id,
});
const postEdit = (id, file, originalFile) => ({
  ...common('PostToolUse'),
  tool_name: 'Edit',
  tool_input: { file_path: file, old_string: '// XYZZY_MARK_1', new_string: '// XYZZY_MARK_2', replace_all: false },
  tool_response: {
    filePath: file,
    oldString: '// XYZZY_MARK_1',
    newString: '// XYZZY_MARK_2',
    originalFile,
    structuredPatch: [{ oldStart: 1, oldLines: 1, newStart: 1, newLines: 1, lines: ['-// XYZZY_MARK_1', '+// XYZZY_MARK_2'] }],
    userModified: false,
    replaceAll: false,
    contentNotInModelContext: true,
  },
  tool_use_id: id,
  duration_ms: 44,
});
// A real 287 KB source file (the rig tree's own workspaces.ts; same bytes for
// every SUBJECT) — the field's Edit that took 46.9 s.
const REAL_FILE = fs.readFileSync(path.join(HERE_REPO, 'src', 'main', 'workspaces.ts'), 'utf8');
const BIG_FILE = REAL_FILE + fs.readFileSync(path.join(HERE_REPO, 'src', 'main', 'agent-sdk.ts'), 'utf8');
const sized = (bytes) => BIG_FILE.slice(0, bytes);

// ── Claude Code's hook dispatcher, for the activity hook only ─────────────────
let settings;
let eventsDir;
let hookEnv;
const WS = 'ws-t11-member';
const COORD = 'ws-t11-coordinator';
function fireRaw(hookEvent, input, timeoutMs = RIG_CAP_MS) {
  let ran = 0;
  let ms = 0;
  let killed = false;
  for (const group of settings.hooks?.[hookEvent] ?? []) {
    for (const h of group.hooks ?? []) {
      if (h.type !== 'command' || !h.command.includes('orchestra-hook.sh')) continue;
      const t0 = process.hrtime.bigint();
      const r = spawnSync('bash', ['-c', h.command], { input, env: hookEnv, cwd: wt, timeout: timeoutMs });
      ms += Number(process.hrtime.bigint() - t0) / 1e6;
      if (r.error?.code === 'ETIMEDOUT' || r.signal) killed = true;
      ran++;
    }
  }
  if (ran !== 1) throw new Error(`expected exactly 1 activity hook on ${hookEvent}, ran ${ran}`);
  return { ms: Math.round(ms), killed, bytes: Buffer.byteLength(input) };
}
const fire = (hookEvent, payload, timeoutMs) => fireRaw(hookEvent, JSON.stringify(payload), timeoutMs);

async function bootChain() {
  await bootPlatform(home, REPO);
  const { store } = await import(`${REPO}/src/main/store.ts`);
  const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
  const spool = await import(`${REPO}/src/main/events-spool.ts`);
  const tracker = await import(`${REPO}/src/main/hibernation-activity.ts`);
  await store.load?.();
  for (const w of [
    { id: COORD, name: 't11-coordinator' },
    { id: WS, name: 't11-member', parentId: COORD, lastTask: 'rig task' },
  ]) {
    await store.upsertWorkspace({
      kind: 'scratch', repoPath: '', worktreePath: wt, status: 'idle', createdAt: Date.now(), hasInput: true, ...w,
    });
  }
  await installOrchestraHooks(wt);
  settings = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8'));
  spool.startEventsSpool();
  eventsDir = spool.getEventsDir();
  if (!eventsDir.startsWith(home)) throw new Error(`events dir escaped the rig: ${eventsDir}`);
  // A UTF-8 LANG like the app's env the CLI hands its hooks (bash is C without one).
  hookEnv = { HOME: REAL_HOME, PATH: '/usr/local/bin:/usr/bin:/bin', LANG: HOOK_LANG, ORCHESTRA_WS_ID: WS, ORCHESTRA_EVENTS_DIR: eventsDir, ORCHESTRA_WORKTREE: wt };
  return { store, tracker };
}

const spoolLines = () => {
  const f = path.join(eventsDir, `${WS}.jsonl`);
  return fs.existsSync(f) ? fs.readFileSync(f, 'utf8').split('\n').filter(Boolean).map((l) => JSON.parse(l)) : [];
};
// Bounded wait until the reader APPLIED every line written so far (its persisted
// cursor reaches the writer's seq counter). Never sleep-then-read.
async function drained(ms = 10_000) {
  const t0 = Date.now();
  for (;;) {
    let want = 0;
    let have = 0;
    try { want = Number(fs.readFileSync(path.join(eventsDir, `${WS}.seq`), 'utf8')) || 0; } catch { /* none yet */ }
    try { have = JSON.parse(fs.readFileSync(path.join(eventsDir, `${WS}.cursor`), 'utf8')).lastSeq ?? 0; } catch { /* none yet */ }
    if (want > 0 && have >= want) return want;
    if (Date.now() - t0 > ms) throw new Error(`spool not drained: seq ${want}, cursor ${have}`);
    await new Promise((r) => setTimeout(r, 20));
  }
}
// ── the one-tree installer, run in a child (module state is per process) ──────
function installedHook(repo, tag) {
  const dir = path.join(base, `install-${tag}`);
  execFileSync(process.execPath, ['--experimental-strip-types', '--import', path.join(HERE_REPO, 'scripts', '.r2-register.mjs'),
    fileURLToPath(import.meta.url), '__install', repo, dir], { stdio: 'ignore', timeout: 60_000 });
  return path.join(dir, 'wt', '.orchestra', 'orchestra-hook.sh');
}
function runHookFile(script, event, input, timeoutMs = RIG_CAP_MS) {
  const ev = fs.mkdtempSync(path.join(base, 'ev-'));
  const t0 = process.hrtime.bigint();
  const r = spawnSync('bash', [script, event], { input, env: { PATH: '/usr/bin:/bin', LANG: HOOK_LANG, HOME: ev, ORCHESTRA_WS_ID: 'w', ORCHESTRA_EVENTS_DIR: ev }, timeout: timeoutMs });
  const ms = Math.round(Number(process.hrtime.bigint() - t0) / 1e6);
  const f = path.join(ev, 'w.jsonl');
  const line = fs.existsSync(f) ? fs.readFileSync(f) : null;
  fs.rmSync(ev, { recursive: true, force: true });
  return { ms, killed: !!(r.error || r.signal), line };
}

// Seeded CLI-shaped payload family for the identity arm: the common prefix, a
// tool_name, random nested tool_input/tool_response (nested tool_use_id /
// tool_name / source / transcript_path keys with string, number, null, object
// values; unicode, escaped quotes, colons, backslashes), then the top-level id.
function corpus() {
  let seed = 198_020;
  const rnd = () => ((seed = (seed * 1103515245 + 12345) & 0x7fffffff) / 0x7fffffff);
  const pick = (a) => a[Math.floor(rnd() * a.length)];
  const KEYS = ['tool_use_id', 'tool_name', 'source', 'transcript_path', 'content', 'a', 'stdout'];
  const STR = ['toolu_01AbC', 'srvtoolu_NESTED', 'é→—中文 💥', 'a:b:c', 'say "hi"', '', 'tool_use_id', '"tool_use_id":"x"', 'line\nbreak', 'back\\slash', ' sp ', '{"k":"v"}'];
  const val = (d) => {
    const r = rnd();
    if (d > 2 || r < 0.45) return pick(STR);
    if (r < 0.55) return Math.floor(rnd() * 1000);
    if (r < 0.6) return null;
    if (r < 0.85) { const o = {}; for (let i = 0; i < 1 + rnd() * 3; i++) o[pick(KEYS)] = val(d + 1); return o; }
    return [val(d + 1), val(d + 1)];
  };
  const list = [];
  const ev = ['PreToolUse', 'PostToolUse', 'PostToolUseFailure'];
  for (let i = 0; i < 240; i++) {
    const hookEvent = pick(ev);
    const p = { ...common(hookEvent), tool_name: pick(['Bash', 'Read', 'Edit', 'WebSearch', 'mcp__x__y', 'é']), tool_input: val(0) };
    if (hookEvent === 'PostToolUse') p.tool_response = val(0);
    p.tool_use_id = `toolu_${i}_${pick(['A', 'B'])}`;
    if (hookEvent === 'PostToolUseFailure') Object.assign(p, { error: pick(STR), is_interrupt: false });
    if (hookEvent !== 'PreToolUse') p.duration_ms = 5;
    list.push(Buffer.from(rnd() < 0.2 ? JSON.stringify(p, null, 1) : JSON.stringify(p)));
  }
  // Event-specific real shapes (Stop with/without crons, SessionStart sources, Notification).
  const stop = (crons) => ({ ...common('Stop'), stop_hook_active: false, last_assistant_message: 'see "session_crons":[] and "tool_use_id":"q"', background_tasks: [], session_crons: crons });
  list.push(Buffer.from(JSON.stringify(stop([]))), Buffer.from(JSON.stringify(stop([{ id: 'd806bf5b', schedule: '51 19 * * *', recurring: false, prompt: 'noop' }]))));
  for (const source of ['startup', 'resume', 'clear', 'compact']) list.push(Buffer.from(JSON.stringify({ ...common('SessionStart'), source, model: 'claude-x' })));
  list.push(Buffer.from(JSON.stringify({ ...common('Notification'), message: 'Claude needs your permission', notification_type: 'permission_prompt' })));
  // A WebSearch whose tool_response nests a server-tool id BEFORE the top-level one.
  list.push(Buffer.from(JSON.stringify({ ...common('PostToolUse'), tool_name: 'WebSearch', tool_input: { query: 'q' }, tool_response: { results: [{ tool_use_id: 'srvtoolu_01NESTED', content: [] }] }, tool_use_id: 'toolu_TOP', duration_ms: 9 })));
  // Invalid UTF-8 inside a mined value (byte semantics must match master's).
  list.push(Buffer.concat([Buffer.from('{"tool_name":"Bash","tool_input":{"c":"a'), Buffer.from([0xff, 0xfe]), Buffer.from('"},"tool_use_id":"to'), Buffer.from([0xe2, 0x82]), Buffer.from('lu_X"}')]));
  // One real-shape Edit big enough to exercise the scan (64 KB: master ~2.4 s).
  list.push(Buffer.from(JSON.stringify(postEdit('toolu_IDENT_64K', path.join(wt, 'big.ts'), sized(64 * 1024)))));
  return list;
}

// The REAL `claude` CLI (haiku) in the rig worktree with the REAL installed hooks.
// Every spool line gets a first-seen timestamp; returns once the CLI exited and
// `minWaitMs` elapsed (to catch a late line from an abandoned hook).
async function realCli(prompt, minWaitMs) {
  const debugFile = path.join(base, 'cli-debug.txt');
  const cliEnv = {
    ...hookEnv,
    CLAUDE_CONFIG_DIR: process.env.CLAUDE_CONFIG_DIR ?? path.join(REAL_HOME, '.claude'),
    PATH: `${path.join(REAL_HOME, '.local', 'bin')}:/usr/local/bin:/usr/bin:/bin`,
    TERM: 'xterm',
  };
  const t0 = Date.now();
  const cli = spawn('claude', ['-p', prompt, '--model', 'haiku', '--output-format', 'text', '--permission-mode', 'bypassPermissions', '--debug-file', debugFile],
    { cwd: wt, env: cliEnv, stdio: ['ignore', 'pipe', 'pipe'] });
  let out = '';
  cli.stdout.on('data', (d) => { out += d; });
  cli.stderr.on('data', (d) => { out += d; });
  const seen = new Map();
  const poll = () => { for (const l of spoolLines()) if (!seen.has(l.seq)) seen.set(l.seq, { ...l, at: Date.now() - t0 }); };
  let exitedAt = null;
  cli.on('exit', () => { exitedAt = Date.now() - t0; });
  for (;;) {
    poll();
    if (exitedAt !== null && Date.now() - t0 > exitedAt + 5_000 && Date.now() - t0 > minWaitMs) break;
    if (Date.now() - t0 > 400_000) { cli.kill('SIGTERM'); break; }
    await new Promise((r) => setTimeout(r, 100));
  }
  poll();
  const debug = fs.existsSync(debugFile) ? fs.readFileSync(debugFile, 'utf8') : '';
  const hookLog = debug.split('\n').filter((l) => /PostToolUse/.test(l) && /(Slow|timed out|timeout|cancel|abort|kill)/i.test(l)).map((l) => l.slice(0, 200)).slice(0, 6);
  return { lines: [...seen.values()], exitedAt, out, hookLog };
}

// ── arms ─────────────────────────────────────────────────────────────────────
try {
  switch (ARM) {
    case 'edit_real_size': {
      // The field incident: one Edit of a 287 KB file. Its posttool must land
      // within the CLI's slow-hook threshold and clear the call from the tracker.
      const { store, tracker } = await bootChain();
      const file = path.join(wt, 'big.ts');
      fire('UserPromptSubmit', { ...common('UserPromptSubmit'), prompt: 'edit it' });
      fire('PreToolUse', preEdit('toolu_T11_EDIT', file));
      const post = fire('PostToolUse', postEdit('toolu_T11_EDIT', file, REAL_FILE));
      await drained();
      const posttool = spoolLines().find((l) => l.event === 'posttool');
      const inFlight = tracker.getInFlightTools(WS).map((c) => `${c.tool}:${c.toolUseId}`);
      done({
        ok: post.ms <= BUDGET_MS && !post.killed && posttool?.toolUseId === 'toolu_T11_EDIT' && inFlight.length === 0 && store.getWorkspace(WS).status === 'running',
        postMs: post.ms, budgetMs: BUDGET_MS, payloadBytes: post.bytes, killed: post.killed,
        posttoolId: posttool?.toolUseId ?? null, inFlight,
      });
      break;
    }
    case 'failed_write_real_size': {
      // reviewer-t6b F1: T6b wired PostToolUseFailure to the same per-call miner. A
      // FAILED Write carries its whole content in tool_input BEFORE tool_use_id
      // (real key order: tool_name, tool_input, tool_use_id, error, is_interrupt,
      // duration_ms). Both its pretool and its failure hook must stay under budget.
      const { store, tracker } = await bootChain();
      const file = path.join(wt, 'big.ts');
      const input = { file_path: file, content: REAL_FILE };
      fire('UserPromptSubmit', { ...common('UserPromptSubmit'), prompt: 'write it' });
      const pre = fire('PreToolUse', { ...common('PreToolUse'), tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_T11_WRITE_FAIL' });
      const failed = fire('PostToolUseFailure', {
        ...common('PostToolUseFailure'), tool_name: 'Write', tool_input: input, tool_use_id: 'toolu_T11_WRITE_FAIL',
        error: 'File has not been read yet. Read it first before writing to it.', is_interrupt: false, duration_ms: 3,
      });
      await drained();
      const posttool = spoolLines().find((l) => l.event === 'posttool');
      const inFlight = tracker.getInFlightTools(WS).map((c) => `${c.tool}:${c.toolUseId}`);
      done({
        ok: pre.ms <= BUDGET_MS && failed.ms <= BUDGET_MS && posttool?.toolUseId === 'toolu_T11_WRITE_FAIL' && inFlight.length === 0 && store.getWorkspace(WS).status === 'running',
        preMs: pre.ms, failureHookMs: failed.ms, budgetMs: BUDGET_MS, payloadBytes: failed.bytes,
        posttoolId: posttool?.toolUseId ?? null, inFlight,
      });
      break;
    }
    case 'scaling': {
      // Hook-only cost per call vs payload size (Edit PostToolUse, and a Write
      // PreToolUse whose tool_input.content is big — the pretool path). Linear →
      // every call under budget; master stops at its first miss.
      await bootChain();
      const rows = [];
      let ok = true;
      for (const kb of [16, 64, 128, 287, 512]) {
        const r = fire('PostToolUse', postEdit(`toolu_S_${kb}`, path.join(wt, 'f.ts'), sized(kb * 1024)));
        rows.push({ event: 'PostToolUse:Edit', kb, ms: r.ms, killed: r.killed });
        if (r.ms > BUDGET_MS || r.killed) { ok = false; break; }
      }
      if (ok) {
        const r = fire('PreToolUse', { ...common('PreToolUse'), tool_name: 'Write', tool_input: { file_path: path.join(wt, 'w.ts'), content: sized(287 * 1024) }, tool_use_id: 'toolu_S_WRITE' });
        rows.push({ event: 'PreToolUse:Write', kb: 287, ms: r.ms, killed: r.killed });
        if (r.ms > BUDGET_MS || r.killed) ok = false;
      }
      await drained();
      const ids = spoolLines().map((l) => l.toolUseId);
      const want = rows.map((r) => (r.event === 'PreToolUse:Write' ? 'toolu_S_WRITE' : `toolu_S_${r.kb}`));
      const idsOk = ok ? JSON.stringify(ids) === JSON.stringify(want) : true;
      done({ ok: ok && idsOk, budgetMs: BUDGET_MS, rows, ids });
      break;
    }
    case 'transcript_control': {
      // The briefed premise ("re-reads the transcript per call") — the hook
      // never opens transcript_path: a 64 MB transcript + a small payload is as
      // cheap as an empty one, on master too.
      await bootChain();
      const tp = path.join(home, 'transcript.jsonl');
      const lineTxt = JSON.stringify({ type: 'assistant', message: { content: 'x'.repeat(1000), usage: { input_tokens: 1 } } }) + '\n';
      fs.writeFileSync(tp, lineTxt.repeat(Math.ceil((64 << 20) / lineTxt.length)));
      const r = fire('PostToolUse', { ...common('PostToolUse'), tool_name: 'Bash', tool_input: { command: 'true' }, tool_response: { stdout: '', stderr: '', interrupted: false }, tool_use_id: 'toolu_T11_SMALL', duration_ms: 3 });
      await drained();
      const l = spoolLines().at(-1);
      done({ ok: r.ms <= BUDGET_MS && l?.transcript === tp && l?.toolUseId === 'toolu_T11_SMALL', transcriptBytes: fs.statSync(tp).size, postMs: r.ms });
      break;
    }
    case 'identity': {
      // Spool line vs BASE_REPO's hook, both from their tree's REAL installer, over
      // every mining event. Identical wherever the base mined the CALL's own id;
      // where it took a nested/value "tool_use_id" (WebSearch srvtoolu_), ONLY
      // toolUseId may differ, and it must be the own id (#198 T11 F1) — enumerated.
      const baseRepo = process.env.BASE_REPO;
      if (!baseRepo) done({ ok: false, error: 'BASE_REPO unset' });
      const subj = installedHook(REPO, 'subject');
      const ref = installedHook(path.resolve(baseRepo), 'base');
      const scriptsDiffer = fs.readFileSync(subj, 'utf8') !== fs.readFileSync(ref, 'utf8');
      const ownRaw = (buf) => {
        try {
          const id = JSON.parse(buf.toString('utf8')).tool_use_id;
          return typeof id === 'string' ? Buffer.from(id, 'utf8').toString('latin1') : undefined;
        } catch { return undefined; }
      };
      const lineId = (raw) => /"toolUseId":"([^"]*)"/.exec(raw.toString('latin1'))?.[1];
      let identical = 0;
      const corrected = new Map();
      const bad = [];
      const list = corpus();
      for (const [i, buf] of list.entries()) {
        const own = ownRaw(buf);
        for (const event of ['pretool', 'posttool', 'stop', 'notify', 'session']) {
          const a = runHookFile(ref, event, buf);
          const b = runHookFile(subj, event, buf);
          if (a.line && b.line && a.line.equals(b.line)) { identical++; continue; }
          const was = a.line && lineId(a.line);
          const want = a.line && own !== undefined && was !== own
            ? a.line.toString('latin1').replace(`"toolUseId":"${was}"`, `"toolUseId":"${own}"`) : null;
          if (want !== null && b.line?.toString('latin1') === want) corrected.set(i, `${was} -> ${own}`);
          else bad.push({ i, event, base: a.line?.toString(), subject: b.line?.toString() });
        }
      }
      // Enumeration: the payloads whose FIRST "tool_use_id" is not the call's own.
      const nestedFirst = list.flatMap((buf, i) => {
        const raw = buf.toString('latin1');
        const own = ownRaw(buf);
        const first = /"tool_use_id"[^:]*:[^"]*"([^"]*)/.exec(raw)?.[1];
        return own !== undefined && raw.split('"tool_use_id"').length > 2 && first !== own ? [i] : [];
      });
      const got = [...corrected.keys()].sort((x, y) => x - y);
      done({
        ok: bad.length === 0 && got.length > 0 && JSON.stringify(got) === JSON.stringify(nestedFirst) && scriptsDiffer,
        payloads: list.length, identicalLines: identical, correctedPayloads: got.length, nestedFirstPayloads: nestedFirst.length,
        badLines: bad.length, scriptsDiffer, correctedSample: [...corrected.values()].slice(0, 3), firstBad: bad.slice(0, 3),
      });
      break;
    }
    case 'websearch_nested_id': {
      // F1: a real-shape WebSearch posttool (CLI 2.1.284 capture: tool_response.
      // results[0].tool_use_id = srvtoolu_… BEFORE the top-level key) must clear ITS
      // call on its own — no PostToolBatch here, so only the per-call hook can.
      const { tracker } = await bootChain();
      const id = 'toolu_01BUYBKT9Jo6HGaGUN8m1zaa';
      const query = 'anthropic claude code hooks';
      fire('UserPromptSubmit', { ...common('UserPromptSubmit'), prompt: 'search' });
      fire('PreToolUse', { ...common('PreToolUse'), tool_name: 'WebSearch', tool_input: { query }, tool_use_id: id });
      fire('PostToolUse', {
        ...common('PostToolUse'), tool_name: 'WebSearch', tool_input: { query },
        tool_response: {
          query,
          results: [
            { tool_use_id: 'srvtoolu_01QKHnHcAnzmMwPRRvpKcqAy', content: Array.from({ length: 9 }, (_, k) => ({ title: `Result ${k}`, url: `https://example.com/${k}` })) },
            'Based on the search results, here is what hooks do…',
          ],
          durationSeconds: 6.8, searchCount: 1,
        },
        tool_use_id: id, duration_ms: 6800,
      });
      await drained();
      const posttool = spoolLines().find((l) => l.event === 'posttool');
      const inFlight = tracker.getInFlightTools(WS).map((c) => `${c.tool}:${c.toolUseId}`);
      done({ ok: posttool?.toolUseId === id && inFlight.length === 0, posttoolId: posttool?.toolUseId ?? null, inFlight });
      break;
    }
    case 'reinstall_during_hook': {
      // F2: an upgrade reinstall while a hook of the PREVIOUS build still runs. Bash
      // has parsed the whole `case … esac` and resumes reading the FILE at its old
      // offset afterwards: an in-place rewrite feeds it the new bytes there (garbage,
      // no spool line); a rename leaves it on its own inode → its posttool lands.
      const { tracker } = await bootChain();
      const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
      const hook = path.join(wt, '.orchestra', 'orchestra-hook.sh');
      const current = fs.readFileSync(hook, 'utf8');
      const at = current.indexOf('    payload="$(cat)"\n');
      if (at < 0) throw new Error('payload line not found in the installed hook');
      const cut = at + '    payload="$(cat)"\n'.length;
      // "Previous build": different bytes (a marker line) + a hook busy mid-case.
      const previous = current.replace('\n', '\n# previous build (t11 rig)\n').slice(0, cut + 27) + '    sleep 4\n' + current.slice(cut);
      fs.writeFileSync(hook, previous, { mode: 0o755 });
      fs.writeFileSync(path.join(wt, '.orchestra', '.hooks-version'), 'digest-of-the-previous-build');
      const inodeBefore = fs.statSync(hook).ino;
      const id = 'toolu_T11_REINSTALL';
      const file = path.join(wt, 'big.ts');
      fire('UserPromptSubmit', { ...common('UserPromptSubmit'), prompt: 'edit it' });
      fire('PreToolUse', preEdit(id, file));
      const cmd = settings.hooks.PostToolUse.flatMap((g) => g.hooks ?? []).find((h) => h.command.includes('orchestra-hook.sh')).command;
      const t0 = Date.now();
      const old = spawn('bash', ['-c', cmd], { env: hookEnv, cwd: wt, stdio: ['pipe', 'pipe', 'pipe'] });
      let stderr = '';
      old.stderr.on('data', (d) => { stderr += d; });
      const exited = new Promise((r) => old.on('exit', (code) => r(code)));
      old.stdin.end(JSON.stringify(postEdit(id, file, 'small')));
      await new Promise((r) => setTimeout(r, 1_500));
      const aliveAtInstall = old.exitCode === null;
      await installOrchestraHooks(wt);
      const reinstalled = fs.readFileSync(hook, 'utf8') === current;
      const aliveAfterInstall = old.exitCode === null;
      const code = await Promise.race([exited, new Promise((r) => setTimeout(() => r('timeout'), 60_000))]);
      // A lost line leaves a seq gap the reader never closes — judge the raw spool.
      const drainError = await drained(5_000).then(() => null, (e) => e.message);
      const posttool = spoolLines().find((l) => l.event === 'posttool' && l.toolUseId === id);
      const inFlight = tracker.getInFlightTools(WS).map((c) => `${c.tool}:${c.toolUseId}`);
      if (!aliveAtInstall || !aliveAfterInstall || !reinstalled) {
        done({ ok: false, error: 'VOID: the reinstall did not land while the old hook ran', aliveAtInstall, aliveAfterInstall, reinstalled });
      }
      const leftoverTmp = fs.readdirSync(path.join(wt, '.orchestra')).filter((n) => n.endsWith('.tmp'));
      done({
        ok: !!posttool && inFlight.length === 0 && !/command not found|syntax error|unexpected/.test(stderr) && leftoverTmp.length === 0,
        leftoverTmp, drainError, spoolEvents: spoolLines().map((l) => `${l.seq}:${l.event}`), oldHookMs: Date.now() - t0, oldHookExit: code, inodeReplaced: fs.statSync(hook).ino !== inodeBefore,
        posttoolId: posttool?.toolUseId ?? null, inFlight, stderr: stderr.slice(0, 300),
      });
      break;
    }
    case 'install_failure_no_tmp': {
      // F2 hygiene: a script whose rename fails (a DIRECTORY squats its path) leaves
      // no temp file behind; the other scripts still land. Passes on master too.
      await bootChain();
      const dir = path.join(wt, '.orchestra');
      fs.writeFileSync(path.join(dir, '.hooks-version'), 'digest-of-the-previous-build');
      fs.rmSync(path.join(dir, 'link-instruction.sh'), { force: true });
      fs.mkdirSync(path.join(dir, 'link-instruction.sh'));
      const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
      await installOrchestraHooks(wt);
      const tmps = () => fs.readdirSync(dir).filter((n) => n.endsWith('.tmp'));
      const t0 = Date.now();
      while (tmps().length && Date.now() - t0 < 3_000) await new Promise((r) => setTimeout(r, 50));
      done({ ok: tmps().length === 0 && fs.existsSync(path.join(dir, 'orchestra-hook.sh')), leftoverTmp: tmps() });
      break;
    }
    case 'real_cli_edit': {
      // The REAL CLI with the REAL installed hooks edits a 420 KB file. The Edit's
      // posttool must land, fast (the CLI waits for the hook: the agent is blocked).
      await bootChain();
      const file = path.join(wt, 'big.ts');
      fs.writeFileSync(file, sized(420 * 1024) + '\n// XYZZY_MARK_1\n');
      // Wait well past any abandoned hook (the master hook here runs ~100 s) to
      // tell "killed" from "late".
      const r = await realCli('Use the Read tool on big.ts with offset 1 and limit 3, then use the Edit tool on big.ts to replace the exact text "XYZZY_MARK_1" with "XYZZY_MARK_2". Make no other tool calls. Then reply DONE.', 150_000);
      const pre = r.lines.find((l) => l.event === 'pretool' && l.tool === 'Edit');
      const post = pre && r.lines.find((l) => l.event === 'posttool' && l.toolUseId === pre.toolUseId);
      const applied = /XYZZY_MARK_2/.test(fs.readFileSync(file, 'utf8'));
      done({
        ok: !!pre && !!post && post.at - pre.at <= BUDGET_MS + 1_000 && applied,
        editApplied: applied, editPretoolAt: pre?.at ?? null, editPosttoolAt: post?.at ?? null, cliExitedAt: r.exitedAt,
        spool: r.lines.map((l) => `${l.event}${l.tool ? ':' + l.tool : ''}@${l.at}`), cliHookLog: r.hookLog, cliOut: r.out.slice(-200),
      });
      break;
    }
    case 'real_cli_websearch': {
      // F1 on the REAL CLI: one WebSearch; its posttool must carry the call's own
      // toolu_ id (the pretool's), not the nested srvtoolu_ one.
      await bootChain();
      const r = await realCli('Use the WebSearch tool exactly once to search for: anthropic claude code hooks. Then reply DONE.', 0);
      const pre = r.lines.find((l) => l.event === 'pretool' && l.tool === 'WebSearch');
      const post = r.lines.find((l) => l.event === 'posttool' && l.tool === 'WebSearch');
      done({
        ok: !!pre && !!post && post.toolUseId === pre.toolUseId,
        pretoolId: pre?.toolUseId ?? null, posttoolId: post?.toolUseId ?? null,
        spool: r.lines.map((l) => `${l.event}${l.tool ? ':' + l.tool : ''}:${(l.toolUseId || '').slice(0, 12)}`), cliOut: r.out.slice(-200),
      });
      break;
    }
  }
} catch (e) {
  done({ ok: false, error: String(e?.stack ?? e) });
}
