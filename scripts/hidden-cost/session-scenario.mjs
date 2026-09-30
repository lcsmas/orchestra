#!/usr/bin/env node
// C2 #209 — launcher for scenario-runner.mjs (one fresh process per scenario, inside C1's containment: bwrap net+pid ns).
//   node scripts/hidden-cost/session-scenario.mjs --label base --turns 0,1,3 --idle 60 [--hooks 0] [--profile '{"mcpServers":0}'] [--out file.json]
// Turns are tool-call counts per turn (0 = a plain text turn). Zero tokens (D6): fake API only, no network reachable.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { detectContainment } from '../session-budget/harness.mjs';
import { liveDirs, assertScratch } from '../session-budget/scratch-guard.mjs';

const REPO = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..', '..');
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const label = opt('label', 'scenario');
// --turns 0,1,3  or with streaming deltas: 0:500 (tools:deltas)
const turns = opt('turns', '0,1,3').split(',').map((t) => { const [n, st] = t.split(':'); return { tools: Number(n), stream: Number(st ?? 0) }; });
const idleSeconds = Number(opt('idle', '60'));
const hooks = opt('hooks', '1') === '1';
const profile = JSON.parse(opt('profile', '{}'));
const outFile = opt('out', '');
const probeModels = opt('probe-models', '0') === '1';
const httpMcp = Number(opt('http-mcp', '0'));
const parity = opt('parity', '0') === '1';

const load1 = Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]);
const memAvailKB = Number(/MemAvailable:\s+(\d+)/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]);
if (load1 > 20) { console.error(`REFUSED: load ${load1} > 20 (D7)`); process.exit(90); }
if (memAvailKB < 4 * 1024 * 1024) { console.error(`REFUSED: MemAvailable ${Math.round(memAvailKB / 1024)} MB < 4 GB (D7)`); process.exit(90); }
const containment = detectContainment();
const so = path.join(REPO, 'scripts', 'hidden-cost', 'execlog', 'execlog.so');
spawnSync('bash', [path.join(REPO, 'scripts', 'hidden-cost', 'execlog', 'build.sh')], { stdio: 'ignore' });
if (!fs.existsSync(so)) { console.error('execlog.so missing'); process.exit(2); }
const keeperOut = path.join(REPO, 'dist-electron', 'keeper.js');
if (!fs.existsSync(keeperOut)) { console.error('dist-electron/keeper.js missing — pnpm run build:keeper'); process.exit(2); }

const base = path.join(os.homedir(), '.cache', 'hidden-cost', 'scenarios');
const root = path.join(base, `${label}-${process.pid}-${Date.now().toString(36).slice(-4)}`);
const live = liveDirs(process.env);
fs.mkdirSync(root, { recursive: true });
assertScratch('root', root, base, live);
const claude = spawnSync('sh', ['-c', 'command -v claude'], { encoding: 'utf8' }).stdout.trim();
const cfg = { REPO, root, live, turns, idleSeconds, hooks, profile, probeModels, httpMcp, parity, execlogSo: so, label, containment: containment.name };
// PATH: a scratch bin holding ONLY a `claude` symlink — ~/.local/bin also holds the `orchestra` shim (an AppImage that cannot FUSE-mount inside bwrap),
// which the SessionStart hooks would call and fail on; the CLI's real cost is measured apart (scripts/hidden-cost/cli-cost.sh).
const scratchBin = path.join(root, 'bin'); fs.mkdirSync(scratchBin, { recursive: true }); fs.symlinkSync(fs.realpathSync(claude), path.join(scratchBin, 'claude'));
const env = { PATH: [scratchBin, path.dirname(process.execPath), '/usr/local/bin', '/usr/bin', '/bin'].join(':'), HOME: path.join(root, 'home'), LANG: 'C.UTF-8', TERM: 'dumb', HC_CONFIG: JSON.stringify(cfg) };
const argv = [...containment.prefix, process.execPath, '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--experimental-strip-types', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(REPO, 'scripts', 'hidden-cost', 'scenario-runner.mjs')];
const child = spawn(argv[0], argv.slice(1), { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'], detached: true });
let out = '', err = '';
child.stdout.on('data', (d) => (out += d)); child.stderr.on('data', (d) => (err += d));
const rc = await new Promise((res) => { const t = setTimeout(() => { try { process.kill(-child.pid, 'SIGKILL'); } catch { /* gone */ } res('TIMEOUT'); }, (turns.length * 100 + idleSeconds + 120) * 1000); child.on('exit', (c, s) => { clearTimeout(t); res(c ?? s); }); });
const line = out.split('\n').reverse().find((l) => l.startsWith('{"result"'));
let result = line ? JSON.parse(line).result : { error: `no result line (rc=${rc}); stderr tail: ${err.slice(-1500)}` };
result.rc = rc; result.containment = containment.name; result.loadavgAtStart = load1;
if (outFile) fs.writeFileSync(outFile, JSON.stringify(result, null, 1));
if (!process.env.HC_KEEP && !result.error) fs.rmSync(root, { recursive: true, force: true }); else result.root = root;
console.log(JSON.stringify(result));
process.exit(result.error ? 1 : 0);
