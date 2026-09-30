// Session-budget HARNESS API (#208) — what C3 #210, C4 #211, C7 #214 build on.
//
//   import { runSessionArm, ensureBuilt, detectContainment } from './scripts/session-budget/harness.mjs';
//   ensureBuilt(repo);                                   // rebuilds dist-electron/keeper.js (the thing the run EXECS)
//   const { report, judgement } = await runSessionArm({ repo, arm: 'normal' });
//   //  report.requests.beforeFirstReply -> {model, count_tokens, other, total}; report.timing; report.processes
//   //  judgement -> { ok, void, verdicts[] } from src/shared/session-budget.ts (the ONE budget file)
//
// Each arm is a fresh child process: agent-sdk.ts holds global state, so one session per process. The child
// runs under `bwrap --unshare-net --unshare-pid` when available (no egress possible, every descendant dies
// with the run, the process census IS the namespace), else with only the refusing proxy (containment says so).
// Extra fixtures/profiles: pass `profile`. Extra load-time mutants of src/: add to mutants.mjs, pass `mutant`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync, execFileSync } from 'node:child_process';
import { liveDirs, assertScratch } from './scratch-guard.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);

/** Rebuild the bundles the run EXECUTES (a stale keeper bundle reproduces perfectly in isolation). */
export function ensureBuilt(repo) {
  const r = spawnSync('pnpm', ['run', 'build:keeper'], { cwd: repo, encoding: 'utf8', env: { ...process.env, PATH: process.env.PATH } });
  if (r.status !== 0) throw new Error(`build:keeper failed (rc=${r.status}): ${(r.stdout + r.stderr).slice(-600)}`);
  const out = path.join(repo, 'dist-electron', 'keeper.js');
  if (!fs.existsSync(out)) throw new Error(`build:keeper printed success but ${out} is absent`);
  return { path: out, mtimeMs: fs.statSync(out).mtimeMs };
}

/** The strongest containment this host offers: 'netns+pidns' | 'netns' | 'proxy-only' (+ the argv prefix). */
export function detectContainment() {
  const tries = [
    ['netns+pidns', ['--dev-bind', '/', '/', '--unshare-net', '--unshare-pid', '--proc', '/proc', '--die-with-parent', '--tmpfs', '/tmp']],
    ['netns', ['--dev-bind', '/', '/', '--unshare-net', '--die-with-parent']],
  ];
  for (const [name, args] of tries) {
    const r = spawnSync('bwrap', [...args, 'true'], { encoding: 'utf8' });
    if (r.status === 0) return { name, prefix: ['bwrap', ...args] };
  }
  return { name: 'proxy-only', prefix: [] };
}

function resolveOnPath(bin) {
  return execFileSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' }).trim();
}

/**
 * Run ONE arm and return `{ report, judgement }` (or `{ error }` when the run itself broke).
 * @param {{repo: string, arm: string, mutant?: string|null, profile?: object, replyDelayMs?: number,
 *          settleMs?: number, timeoutMs?: number, keep?: boolean, containment?: {name:string,prefix:string[]}}} o
 */
export async function runSessionArm(o) {
  const { repo, arm, mutant = null, profile = {}, replyDelayMs = 250, settleMs = 2500, timeoutMs = 90_000 } = o;
  const containment = o.containment ?? detectContainment();
  const base = path.join(os.homedir(), '.cache', 'session-budget');
  const root = path.join(base, `${arm}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  const live = liveDirs(process.env);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, base, live);

  const claude = resolveOnPath('claude');
  const cfg = { REPO: repo, root, arm, mutant, profile, replyDelayMs, settleMs, timeoutMs, pidns: containment.name === 'netns+pidns', containment: containment.name, live };
  const env = {
    PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', SB_CONFIG: JSON.stringify(cfg),
  };
  const argv = [...containment.prefix, process.execPath, '--experimental-strip-types', '--import', path.join(repo, 'scripts', '.r2-register.mjs'), path.join(repo, 'scripts', 'session-budget', 'session-runner.mjs')];
  const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const rc = await new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, timeoutMs + 60_000);
    child.on('exit', (code, sig) => { clearTimeout(t); resolve(code ?? sig); });
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"report"'));
  let result;
  if (line) {
    try { result = JSON.parse(line); } catch (e) { result = { error: `unparsable result line: ${e}` }; }
  } else {
    result = { error: `no result line (rc=${rc}); stderr tail: ${err.slice(-1200)}` };
  }
  result.rc = rc;
  result.root = root;
  if (!o.keep && !process.env.SB_KEEP && !result.error) fs.rmSync(root, { recursive: true, force: true });
  return result;
}
