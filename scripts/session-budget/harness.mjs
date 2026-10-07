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
import { spawn, spawnSync } from 'node:child_process';
import { liveDirs, assertScratch } from './scratch-guard.mjs';

const HERE = path.dirname(new URL(import.meta.url).pathname);
export const WEAK_ENV = 'SESSION_BUDGET_ALLOW_WEAK_CONTAINMENT';
const WEAK_OK = process.env[WEAK_ENV] === '1';

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

/** Absolute path of `bin` on PATH, or null (never throws). */
export function findOnPath(bin) {
  const r = spawnSync('sh', ['-c', `command -v ${bin}`], { encoding: 'utf8' });
  return r.status === 0 ? r.stdout.trim() || null : null;
}

/**
 * Kill every process whose environment carries THIS run's scratch HOME (identity read from
 * /proc/<pid>/environ at signal time — a pid or pidfile alone is only a name). The pid namespace makes
 * this a no-op; without one (containment 'proxy-only'/'netns') the detached keeper would outlive the run.
 * Returns the number of processes signalled.
 */
export function reapScratchProcesses(root) {
  const needle = `HOME=${path.join(root, 'home')}\0`;
  let n = 0;
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      if (fs.readFileSync(`/proc/${name}/environ`, 'latin1').includes(needle)) { process.kill(Number(name), 'SIGKILL'); n++; }
    } catch { /* not ours / gone */ }
  }
  return n;
}

const RUN_MARKER = '.session-budget-run';

/** Drop scratch dirs left by earlier FAILED runs (kept for autopsy) once they are a day old. ONLY dirs carrying
 *  this harness's own marker: the base dir is shared (other tracks drop measurement files there). */
function sweepOld(base) {
  try {
    for (const n of fs.readdirSync(base)) {
      const p = path.join(base, n);
      if (fs.statSync(p).isDirectory() && fs.existsSync(path.join(p, RUN_MARKER)) && Date.now() - fs.statSync(p).mtimeMs > 24 * 3600 * 1000) {
        fs.rmSync(p, { recursive: true, force: true });
      }
    }
  } catch { /* first run */ }
}

/**
 * Run a script INSIDE the mandatory containment (net+pid namespaces, scratch HOME) and return its last
 * JSON line starting with `resultPrefix`. Shared by the session arms and the host-dependent self-tests.
 */
async function runContained(o, script, label, extraCfg, resultPrefix) {
  const { repo, replyDelayMs = 500, settleMs = 2500, timeoutMs = 90_000 } = o;
  const containment = o.containment ?? detectContainment();
  // F1: egress containment is part of the measurement — anything weaker than net+pid namespaces makes the run VOID,
  // unless the caller says so explicitly (the opt-out is echoed into the report and printed in the verdict).
  if (containment.name !== 'netns+pidns' && !WEAK_OK) {
    return { void: true, error: `containment is '${containment.name}', not 'netns+pidns' (bwrap --unshare-net --unshare-pid unusable on this host) — egress is not contained, so nothing was measured. Set ${WEAK_ENV}=1 to run anyway (the verdict will say so).` };
  }
  const base = path.join(os.homedir(), '.cache', 'session-budget');
  sweepOld(base);
  const root = path.join(base, `${label}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  const live = liveDirs(process.env);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, base, live);
  fs.writeFileSync(path.join(root, RUN_MARKER), `${process.pid} ${new Date().toISOString()}\n`);

  const claude = findOnPath('claude');
  if (!claude) return { void: true, error: 'no `claude` CLI on PATH — the suite drives the real CLI, so nothing was measured', root };
  // Ports are chosen HERE because the runner must START with its HTTP(S) traffic already pointed at the recording proxy
  // (Node reads NODE_USE_ENV_PROXY at bootstrap, not later). Inside the fresh netns nothing else listens; the random
  // base only matters in the opt-out modes, where parallel runs share a loopback.
  const apiPort = 30000 + Math.floor(Math.random() * 15000) * 2;
  const proxyPort = apiPort + 1;
  const cfg = { REPO: repo, root, replyDelayMs, settleMs, timeoutMs, pidns: containment.name === 'netns+pidns', containment: containment.name, containmentOptOut: WEAK_OK, live, apiPort, proxyPort, ...extraCfg };
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const env = {
    PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', SB_CONFIG: JSON.stringify(cfg),
    // The APP process's own fetch()/http(s) traffic goes through the recording proxy too (review round 2 F2): a startup call
    // to a NEW host from main is counted, not lost to a DNS failure inside the netns. Loopback (the fake API) is exempt.
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost',
  };
  const argv = [...containment.prefix, process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=UNDICI-EHPA', '--experimental-strip-types', '--import', path.join(repo, 'scripts', '.r2-register.mjs'), path.join(repo, 'scripts', 'session-budget', script)];
  const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const rc = await new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, timeoutMs + 60_000);
    // 'close', not 'exit': 'exit' can fire before stdout/stderr are drained, losing the result line or the error text.
    child.on('close', (code, sig) => { clearTimeout(t); resolve(code ?? sig); });
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith(resultPrefix));
  let result;
  if (line) {
    try { result = JSON.parse(line); } catch (e) { result = { error: `unparsable result line: ${e}` }; }
  } else {
    const errLine = err.split('\n').find((l) => /Error:/.test(l)) ?? err.trim().slice(-300).replace(/\s+/g, ' ');
    result = { error: `no result line (rc=${rc}): ${errLine.trim()}${out.trim() ? ` | stdout tail: ${out.trim().slice(-300).replace(/\s+/g, ' ')}` : ''}` };
  }
  result.rc = rc;
  result.root = root;
  result.reaped = reapScratchProcesses(root); // 0 under a pid namespace; the keeper's descendants otherwise
  if (!o.keep && !process.env.SB_KEEP && !result.error) fs.rmSync(root, { recursive: true, force: true });
  return result;
}

/**
 * Run ONE arm and return `{ report, judgement }` (or `{ error }` when the run itself broke, `{ void: true, error }`
 * when the host cannot contain it).
 * @param {{repo: string, arm: string, mutant?: string|null, profile?: object, replyDelayMs?: number,
 *          settleMs?: number, timeoutMs?: number, keep?: boolean, containment?: {name:string,prefix:string[]}}} o
 */
export function runSessionArm(o) {
  return runContained(o, 'session-runner.mjs', o.arm, { arm: o.arm, mutant: o.mutant ?? null, profile: o.profile ?? {}, secondTurn: o.secondTurn ?? null }, '{"report"');
}

/**
 * Host-dependent self-tests of the instruments themselves, run under the SAME containment as the arms (so they
 * cannot live in `pnpm run test`, which must not depend on bwrap or a real `claude`). Modes: `census` (the
 * pid-namespace census is exactly the runner's tree), `smoke` (the real-API smoke's flag path, real CLI, fake API).
 * Returns `{ selftest, ok, ... }`.
 */
export function runSelfTest(o) {
  return runContained(o, 'selftest-runner.mjs', `selftest-${o.mode}`, { mode: o.mode }, '{"selftest"');
}
