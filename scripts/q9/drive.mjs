// Q9 research driver: node drive.mjs <label> <arm> <runs> [KEY=VAL ...]   → runs `q9-arm.mjs <arm>` <runs> times (one process each, allowlisted env), appends one JSON row per run to
// $Q9_OUT/runs.jsonl, prints one line per run, and PRINTS the survivors (processes carrying the arm's scratch dir, units with the rig prefix) after EVERY run — must be 0. Cleans leftovers by identity/name.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createHash, randomBytes } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const [label, arm, runsArg, ...kv] = process.argv.slice(2);
const HERE = path.dirname(fileURLToPath(import.meta.url));
const REAL_HOME = os.homedir();
const OUT = process.env.Q9_OUT ?? path.join(REAL_HOME, '.orchestra', 'ops-wave-h', 'h1', 'q9');
const PREFIX = 'orchestra-rig-wh-h1-q9-';
const extra = Object.fromEntries(kv.map((s) => [s.slice(0, s.indexOf('=')), s.slice(s.indexOf('=') + 1)]));
const unitsNow = (glob) => (spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);
function survivorsOf(base) {
  const out = [];
  for (const name of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(name) || Number(name) === process.pid) continue;
    try {
      const hit = fs.readFileSync(`/proc/${name}/cmdline`, 'latin1').includes(base) || fs.readFileSync(`/proc/${name}/environ`, 'latin1').includes(base) || fs.readlinkSync(`/proc/${name}/cwd`).startsWith(base);
      if (hit) out.push(Number(name));
    } catch { /* gone / not ours */ }
  }
  return out;
}
for (let i = 0; i < Number(runsArg); i++) {
  const token = randomBytes(2).toString('hex');
  const root = path.join(REAL_HOME, '.cache', 'memory-cap-rig', token);
  const base = path.join(root, createHash('sha1').update(arm).digest('hex').slice(0, 6));
  fs.mkdirSync(root, { recursive: true });
  const env = { PATH: process.env.PATH, HOME: path.join(base, 'home'), LANG: 'C.UTF-8', SHELL: process.env.SHELL ?? '/bin/bash', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS, MC_REAL_HOME: REAL_HOME, MC_RUN_TOKEN: token, ...extra };
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const before = new Set(unitsNow(`${PREFIX}*`));
  const t0 = Date.now();
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(HERE, '..', '.r2-register.mjs'), path.join(HERE, 'q9-arm.mjs'), arm], { env, encoding: 'utf8', timeout: 400_000, cwd: path.join(HERE, '..', '..') });
  const line = (r.stdout ?? '').split('\n').reverse().find((l) => l.startsWith('{"arm"'));
  let res; try { res = line ? JSON.parse(line) : { ok: false, error: `no result line (rc=${r.status} ${r.signal ?? ''}): ${(r.stderr ?? '').trim().slice(-300)}` }; } catch (e) { res = { ok: false, error: String(e) }; }
  const procs = survivorsOf(base);
  const leftUnits = unitsNow(`${PREFIX}*`).filter((u) => !before.has(u));
  for (const u of leftUnits) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });
  for (const pid of procs) { try { if (fs.readFileSync(`/proc/${pid}/environ`, 'latin1').includes(base) || fs.readFileSync(`/proc/${pid}/cmdline`, 'latin1').includes(base)) process.kill(pid, 'SIGKILL'); } catch { /* gone */ } }
  fs.rmSync(root, { recursive: true, force: true });
  const row = { label, arm, i, env: extra, ms: Date.now() - t0, ok: !!res.ok, detail: res.detail, data: res.data ?? null, error: res.error ?? null, leaked: { procs: procs.length, units: leftUnits.length } };
  fs.appendFileSync(path.join(OUT, 'runs.jsonl'), JSON.stringify(row) + '\n');
  console.log(`${label} #${i} ${res.ok ? 'ok' : 'ERR'} ${res.detail ?? res.error ?? ''}  SURVIVORS procs=${procs.length} scopes=${leftUnits.length}${procs.length || leftUnits.length ? '  ← LEAK (cleaned)' : ''}`);
}
