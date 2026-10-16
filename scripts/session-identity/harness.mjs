// Session-identity rig HARNESS (#379 / ADR 0008): runs ONE arm in a fresh child process inside the session-budget
// containment (bwrap net+pid namespaces, scratch HOME/ORCHESTRA_HOME/CLAUDE_CONFIG_DIR, fake Anthropic API — zero tokens).
// Copied from session-budget/harness.mjs `runContained` (private there); the shared helpers are imported, not re-implemented.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { detectContainment, findOnPath, reapScratchProcesses } from '../session-budget/harness.mjs';
import { liveDirs, assertScratch } from '../session-budget/scratch-guard.mjs';

const RUN_MARKER = '.session-identity-run';
export const SCRATCH_BASE = path.join(os.homedir(), '.cache', 'session-identity');

/** Rebuild the two bundles the run EXECUTES (a stale bundle reproduces perfectly in isolation): the CLI the agent's Bash tool runs and the keeper. */
export function ensureBuilt(repo) {
  if (process.env.SESSION_IDENTITY_SKIP_BUILD === '1') return;
  for (const script of ['build:cli', 'build:keeper']) {
    const r = spawnSync('pnpm', ['run', script], { cwd: repo, encoding: 'utf8' });
    if (r.status !== 0) throw new Error(`${script} failed (rc=${r.status}): ${(r.stdout + r.stderr).slice(-600)}`);
  }
}

/** The CLI under test must open the bus under SYSTEM node (ABI 127): see bus-probe.mjs. */
export function busAbiProbe(repo) {
  const probe = path.join(repo, 'scripts', 'session-identity', 'bus-probe.mjs');
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=ExperimentalWarning', probe, repo], { cwd: repo, encoding: 'utf8' });
  return { ok: r.status === 0 && /BUS_OK/.test(r.stdout), detail: (r.stdout + r.stderr).trim().split('\n').pop() };
}

/** Run `identity-runner.mjs` for one arm inside net+pid namespaces; returns `{identity|error, rc, root, reaped, hostSurvivors}`. */
export async function runIdentityArm(o) {
  const { repo, arm, timeoutMs = 100_000 } = o;
  const containment = o.containment ?? detectContainment();
  // Mandatory: a weaker containment lets the app's own egress/leftovers escape the run (no opt-out here, unlike the budget suite).
  if (containment.name !== 'netns+pidns') return { error: `containment is '${containment.name}', not 'netns+pidns' (bwrap --unshare-net --unshare-pid unusable on this host) — refusing to run`, void: true };
  fs.mkdirSync(SCRATCH_BASE, { recursive: true });
  const live = liveDirs(process.env);
  const root = path.join(SCRATCH_BASE, `si-${arm}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
  fs.mkdirSync(root, { recursive: true });
  assertScratch('root', root, SCRATCH_BASE, live);
  fs.writeFileSync(path.join(root, RUN_MARKER), `${process.pid} ${new Date().toISOString()}\n`);
  const claude = findOnPath('claude');
  if (!claude) return { error: 'no `claude` CLI on PATH — the rig drives the real CLI', void: true, root };
  // Ports are chosen HERE: the runner must START with its HTTP traffic already pointed at the recording proxy (Node reads NODE_USE_ENV_PROXY at bootstrap).
  const apiPort = 30000 + Math.floor(Math.random() * 15000) * 2;
  const proxyPort = apiPort + 1;
  const cfg = { REPO: repo, root, arm, mutant: o.mutant ?? null, phase: arm === 'attach_keeps_key' ? 'supervise' : 'all', timeoutMs, live, apiPort, proxyPort, containment: containment.name };
  const proxyUrl = `http://127.0.0.1:${proxyPort}`;
  const env = {
    PATH: [path.dirname(claude), path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'),
    HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', SB_CONFIG: JSON.stringify(cfg),
    NODE_USE_ENV_PROXY: '1', HTTPS_PROXY: proxyUrl, HTTP_PROXY: proxyUrl, NO_PROXY: '127.0.0.1,localhost',
  };
  const argv = [...containment.prefix, process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--disable-warning=UNDICI-EHPA', '--experimental-strip-types', '--import', path.join(repo, 'scripts', '.r2-register.mjs'), path.join(repo, 'scripts', 'session-identity', 'identity-runner.mjs')];
  const child = spawn(argv[0], argv.slice(1), { cwd: repo, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
  let out = '', err = '';
  child.stdout.on('data', (d) => (out += d));
  child.stderr.on('data', (d) => (err += d));
  const rc = await new Promise((resolve) => {
    const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } resolve('TIMEOUT'); }, timeoutMs + 60_000);
    child.on('close', (code, sig) => { clearTimeout(t); resolve(code ?? sig); });
  });
  const line = out.split('\n').reverse().find((l) => l.startsWith('{"identity"'));
  let result;
  if (line) {
    try { result = JSON.parse(line).identity; } catch (e) { result = { error: `unparsable result line: ${e}` }; }
  } else {
    const errLine = err.split('\n').find((l) => /Error:/.test(l)) ?? err.trim().slice(-400).replace(/\s+/g, ' ');
    result = { error: `no result line (rc=${rc}): ${errLine.trim()}${out.trim() ? ` | stdout tail: ${out.trim().slice(-300).replace(/\s+/g, ' ')}` : ''}` };
  }
  result.rc = rc;
  result.root = root;
  result.hostSurvivors = reapScratchProcesses(root); // 0 under a pid namespace; >0 would mean the containment leaked a process
  if (!o.keep && !process.env.SB_KEEP && !result.error) fs.rmSync(root, { recursive: true, force: true });
  return result;
}
