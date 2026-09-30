#!/usr/bin/env node
// C2 #209 — per-firing cost of EVERY hook command Orchestra registers on a worktree, measured by running the real
// installed commands (installOrchestraHooks → .claude/settings.local.json) the way Claude Code's dispatcher does
// (`bash -c <command>`, payload on stdin) under the LD_PRELOAD exec logger: processes spawned, wall ms, CPU ms.
//   bash scripts/hidden-cost/hook-cost.sh [--runs 15] [--peers 12] [--with-orchestra-cli 1]
// Runs in scratch HOME/ORCHESTRA_HOME (D7). Zero tokens: no model, no network (netns wrapper).
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync, execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { assertScratch } from '../session-budget/scratch-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const RUNS = Number(opt('runs', '15'));
const PEERS = Number(opt('peers', '12'));
const WITH_CLI = opt('with-orchestra-cli', '1') === '1';
const SO = opt('so', '');
const live = JSON.parse(opt('live', 'null') ?? 'null');
const ROOT = process.env.HC_ROOT;
if (!ROOT || !SO || !fs.existsSync(SO) || !Array.isArray(live) || !live.length) { console.error('run via scripts/hidden-cost/hook-cost.sh'); process.exit(90); }
const home = path.join(ROOT, 'home');
const orchHome = path.join(ROOT, 'orchestra');
const wt = path.join(ROOT, 'worktree');
for (const [l, p] of [['HOME', home], ['ORCHESTRA_HOME', orchHome], ['worktree', wt]]) assertScratch(l, p, ROOT, live);
fs.mkdirSync(home, { recursive: true }); fs.mkdirSync(orchHome, { recursive: true }); fs.mkdirSync(wt, { recursive: true });
process.env.HOME = home; process.env.ORCHESTRA_HOME = orchHome;

const git = (cwd, ...a) => execFileSync('git', ['-c', 'user.name=f', '-c', 'user.email=f@invalid', '-c', 'commit.gpgsign=false', ...a], { cwd, stdio: 'pipe', encoding: 'utf8' });
git(wt, 'init', '-q', '-b', 'main'); fs.writeFileSync(path.join(wt, 'a.txt'), 'x\n'); git(wt, 'add', '-A'); git(wt, 'commit', '-q', '-m', 'base');
git(wt, 'checkout', '-q', '-b', 'nmc-360-run-one-pilot'); // a branch naming a Linear-style key: the per-prompt link nudge takes its LONG path

const { initPlatform } = await import(`${REPO}/src/main/platform/index.ts`);
initPlatform({
  kind: 'headless-hook-cost', broadcast: () => {}, broadcastPtyData: () => {}, canBroadcast: () => true, isFocused: () => false, hasAttachedUi: () => true,
  notify: () => {}, openExternal: () => {}, showItemInFolder: () => {}, openPath: () => {}, openAccountLoginUrl: () => {}, closeAccountLogin: () => {},
  getUserDataDir: () => orchHome, getLogsDir: () => `${orchHome}/logs`, getAppVersion: () => '0.0.0-hook-cost', getAppMetrics: () => [],
  isEncryptionAvailable: () => false, encryptString: (s) => s, decryptString: (s) => s,
});
const { store } = await import(`${REPO}/src/main/store.ts`);
const { installOrchestraHooks } = await import(`${REPO}/src/main/workspaces.ts`);
const hooksServer = await import(`${REPO}/src/main/hooks-server.ts`);
await store.load?.();
const WS = 'ws-hook-me';
await store.upsertWorkspace({ id: WS, name: 'me', kind: 'worktree', repoPath: wt, worktreePath: wt, branch: 'nmc-360-run-one-pilot', baseBranch: 'main', status: 'idle', createdAt: Date.now(), hasInput: true });
for (let i = 0; i < PEERS; i++) await store.upsertWorkspace({ id: `ws-peer-${i}`, name: `peer-${i}`, kind: 'scratch', repoPath: '', worktreePath: wt, status: 'running', createdAt: Date.now(), hasInput: true });
await installOrchestraHooks(wt);
await hooksServer.startHooksServer();
const sock = hooksServer.getHookSocketPath();
if (!sock) throw new Error('hooks server did not listen');
const settings = JSON.parse(fs.readFileSync(path.join(wt, '.claude', 'settings.local.json'), 'utf8'));
const eventsDir = path.join(ROOT, 'events'); fs.mkdirSync(eventsDir, { recursive: true });

// `orchestra` on PATH is the machine's own shim (exec's the installed AppImage in cli mode) — the field path.
const realShimDir = process.env.HC_ORCHESTRA_BIN_DIR;
const PATH = [WITH_CLI && realShimDir ? realShimDir : null, '/usr/local/bin', '/usr/bin', '/bin'].filter(Boolean).join(':');
const hookEnv = (logFile) => ({
  HOME: home, PATH, LANG: 'C.UTF-8', ORCHESTRA_WS_ID: WS, ORCHESTRA_WORKTREE: wt, ORCHESTRA_EVENTS_DIR: eventsDir, ORCHESTRA_SOCK: sock,
  ORCHESTRA_BRANCH: 'nmc-360-run-one-pilot', ORCHESTRA_KIND: 'worktree', ORCHESTRA_BRANCH_AUTO: '1',
  LD_PRELOAD: SO, EXECLOG_FILE: logFile,
});
const common = (ev) => ({ session_id: 'hc-sess', transcript_path: path.join(home, 't.jsonl'), cwd: wt, prompt_id: 'p1', permission_mode: 'bypassPermissions', hook_event_name: ev });
const bashInput = { command: 'git status --short && pnpm run build', description: 'build' };
const payloads = {
  SessionStart: [{ ...common('SessionStart'), source: 'startup' }, undefined],
  UserPromptSubmit: [{ ...common('UserPromptSubmit'), prompt: 'please fix the failing test' }, undefined],
  PreToolUse: [{ ...common('PreToolUse'), tool_name: 'Bash', tool_input: bashInput, tool_use_id: 'toolu_1' }, 'Bash'],
  'PreToolUse:Edit': [{ ...common('PreToolUse'), tool_name: 'Edit', tool_input: { file_path: path.join(wt, 'a.txt'), old_string: 'x', new_string: 'y' }, tool_use_id: 'toolu_2' }, 'Edit'],
  PostToolUse: [{ ...common('PostToolUse'), tool_name: 'Bash', tool_input: bashInput, tool_response: { stdout: 'ok\n'.repeat(400), stderr: '', interrupted: false }, tool_use_id: 'toolu_1', duration_ms: 812 }, 'Bash'],
  PostToolUseFailure: [{ ...common('PostToolUseFailure'), tool_name: 'Bash', tool_input: bashInput, error: 'exit 1', is_interrupt: false, tool_use_id: 'toolu_3' }, 'Bash'],
  PostToolBatch: [{ ...common('PostToolBatch') }, undefined],
  Stop: [{ ...common('Stop'), stop_hook_active: false }, undefined],
  Notification: [{ ...common('Notification'), message: 'Claude needs your permission', notification_type: 'permission_prompt' }, undefined],
};
const hookEvent = (k) => k.split(':')[0];

const median = (a) => { const s = [...a].sort((x, y) => x - y); return s.length ? s[Math.floor(s.length / 2)] : null; };
const short = (c) => c.replace(/^f="\$\{ORCHESTRA_WORKTREE:-\.\}\/\.orchestra\//, '').replace(/"; \[ -f "\$f" \] && bash "\$f"/, ' →').slice(0, 70);
const out = { generatedAt: new Date().toISOString(), runs: RUNS, peers: PEERS, orchestraCliOnPath: WITH_CLI && !!realShimDir, events: {} };
let seq = 0;
for (const [key, [payload, toolName]] of Object.entries(payloads)) {
  const ev = hookEvent(key);
  const groups = (settings.hooks?.[ev] ?? []).filter((g) => !g.matcher || (toolName && new RegExp(g.matcher).test(toolName)));
  const cmds = groups.flatMap((g) => (g.hooks ?? []).filter((h) => h.type === 'command').map((h) => h.command));
  const perCmd = [];
  for (const cmd of cmds) {
    const walls = [], cpus = [], procs = [], byKey = {};
    for (let r = 0; r < RUNS + 2; r++) {
      const logFile = path.join(ROOT, `exec-${++seq}.log`);
      fs.writeFileSync(logFile, '');
      const wrapped = `TIMEFORMAT='HCTIME %3R %3U %3S'; { time bash -c "$1"; } 2>>"$2" >/dev/null`;
      const tf = `${logFile}.time`;
      const t0 = process.hrtime.bigint();
      spawnSync('bash', ['-c', wrapped, '_', cmd, tf], { input: JSON.stringify(payload), env: hookEnv(logFile), cwd: wt, timeout: 60_000 });
      const wall = Number(process.hrtime.bigint() - t0) / 1e6;
      if (r < 2) continue; // 2 warm-up runs (page cache, first curl)
      const tline = fs.existsSync(tf) ? fs.readFileSync(tf, 'utf8').split('\n').reverse().find((l) => l.startsWith('HCTIME')) : null;
      const [, , u, s] = tline ? tline.split(' ') : [];
      const lines = fs.readFileSync(logFile, 'utf8').split('\n').filter((l) => l.startsWith('EXEC '));
      // The `time` wrapper's own `bash -c "$1"` re-exec is not the hook: discount the 2 wrapper execs (outer bash -c wrapper is the driver's spawn; inner is `bash -c cmd`).
      procs.push(lines.length);
      for (const l of lines) { const a = l.split(' ').slice(5); const k = path.basename(l.split(' ')[4]); byKey[k] = (byKey[k] ?? 0) + 1; void a; }
      walls.push(wall); cpus.push((Number(u) + Number(s)) * 1000);
    }
    perCmd.push({ command: short(cmd), wallMsMedian: Math.round(median(walls)), cpuMsMedian: Math.round(median(cpus)), execsPerFire: median(procs), execKinds: Object.fromEntries(Object.entries(byKey).map(([k, n]) => [k, Number((n / RUNS).toFixed(1))])) });
  }
  out.events[key] = {
    hooksFiredPerEvent: cmds.length,
    execsPerEvent: perCmd.reduce((a, c) => a + c.execsPerFire, 0),
    wallMsPerEvent: perCmd.reduce((a, c) => a + c.wallMsMedian, 0),
    cpuMsPerEvent: perCmd.reduce((a, c) => a + c.cpuMsMedian, 0),
    perCommand: perCmd,
  };
}
fs.writeFileSync(path.join(ROOT, 'hook-cost.json'), JSON.stringify(out, null, 1));
console.log(JSON.stringify(out));
process.exit(0);
