#!/usr/bin/env node
// #438-fu (ledger #443 D3) — the REAL-CLOCK liveness soak: N UNMUTATED runs of « one plain parent + one child, the child idle between turns for longer than the liveness window » on the PACKAGED app
// (real keeper + real `claude` vs the local fake API, zero tokens), CONCURRENTLY, each in its own contained rig (headless sway, scratch HOME / ORCHESTRA_HOME / CLAUDE_CONFIG_DIR). Asserts ZERO escalation rows per run, plus
//   · hung            a child REALLY frozen mid-call (CLI SIGSTOPped under a running command) MUST escalate « hung mid-call »
//   · silent-idle     an idle child that never reported done escalates ONCE (policy) — the zero's positive control on the same roster
//   · hung-off        the hung control with `liveness` frozen OFF: MUST read DIRTY (the control can say FAIL)
//   · mutant released-blind   a build-level mutant (the done-and-released exclusion blind): the done-idle run MUST read DIRTY
//   node scripts/pause-canary/liveness-soak.mjs --app <dir>/orchestra [--runs 10] [--window-s 780] [--base ~/.cache/pc-438] [--out <dir>] [--no-controls]
// `--app` = the packaged app of THIS tree (`node scripts/pause-canary/run.mjs --shape plain --exercise dure --cycles 1` builds it under <base>/apps/src-<stamp>).
// Exit 0 SOAK CLEAN (every unmutated run CLEAN, every control as expected) · 1 DIRTY/ERROR · 3 VOID (host below the bar).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { makeMutantApp } from './mutants.mjs';
import { initBase } from './lib.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REAL_HOME = os.userInfo().homedir;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const BASE = path.resolve(opt('base', path.join(REAL_HOME, '.cache', 'pc-438')));
const OUT = path.resolve(opt('out', path.join(BASE, 'reports', `soak-${new Date().toISOString().replace(/[:.]/g, '-')}`)));
const RUNS = Number(opt('runs', '10'));
const WINDOW_S = Number(opt('window-s', '780'));
const APP = opt('app', null);
const MIN_AVAIL_GB = Number(opt('min-avail-gb', '4'));
const PER_RIG_GB = 0.45;
const STAGGER_MS = Number(opt('stagger-ms', '8000'));
if (!APP || !fs.existsSync(path.join(path.dirname(path.resolve(APP)), 'resources', 'app.asar'))) { say('usage: liveness-soak.mjs --app <packaged orchestra> (a PACKAGED build of this tree: see the header)'); process.exit(2); }
initBase(BASE);
const hostNow = () => ({ availGB: Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576, load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) });
const claudeBin = [path.join(REAL_HOME, '.local/bin/claude'), ...String(process.env.PATH ?? '').split(':').map((d) => path.join(d, 'claude'))].find((c) => fs.existsSync(c));
if (!claudeBin) { say('LIVSOAK-SOAK VOID — no `claude` CLI'); process.exit(3); }

const appDir = path.dirname(path.resolve(APP));
const mutApp = makeMutantApp(appDir, 'released-blind', path.join(BASE, 'apps', 'mut-liv-released-blind'));
say(`mutant released-blind: ${mutApp.edits.map((e) => `${e.hits}× ${e.where.join(',')}`).join(' ')} · copy ${mutApp.copySha} vs base ${mutApp.baseSha}`);

const ONLY = (opt('only', '') || '').split(',').filter(Boolean);
const ALL_ARMS = [
  ...Array.from({ length: RUNS }, (_, i) => ({ name: `done-idle-${i + 1}`, arm: 'done-idle', want: 'CLEAN', app: APP })),
  ...(flag('no-controls') ? [] : [
    { name: 'control:hung', arm: 'hung', want: 'CLEAN', app: APP },
    { name: 'control:silent-idle', arm: 'silent-idle', want: 'CLEAN', app: APP },
    { name: 'must-fail:hung-liveness-off', arm: 'hung', switch: 'off', want: 'DIRTY', app: APP },
    { name: 'must-fail:mutant-released-blind', arm: 'done-idle', want: 'DIRTY', app: mutApp.bin },
  ]),
];
const ARMS = ONLY.length ? ALL_ARMS.filter((x) => ONLY.includes(x.name)) : ALL_ARMS;   // `--only control:hung,…` = a PARTIAL soak (labelled)
const need = MIN_AVAIL_GB + PER_RIG_GB * ARMS.length;
// patience, never a lower bar: wait (up to --wait-host-min, default 30) for MemAvailable ≥ the bar + the rigs' footprint and load ≤ 20
{ const tw = Date.now(); const maxMs = Number(opt('wait-host-min', '30')) * 60000; for (;;) { const h = hostNow(); if ((h.availGB >= need && h.load1 <= 20) || Date.now() - tw >= maxMs) break; await sleep(15000); } }
const h0 = hostNow();
say(`liveness soak: ${ARMS.length} concurrent rigs (${RUNS} unmutated done-idle + ${ARMS.length - RUNS} controls) · window ${WINDOW_S}s after the child goes idle · MemAvailable ${h0.availGB.toFixed(1)} GB (need ≥ ${need.toFixed(1)}) load ${h0.load1.toFixed(1)} · claude ${claudeBin}`);
if (h0.availGB < need || h0.load1 > 20) { say(`LIVSOAK-SOAK VOID — host below the bar (MemAvailable ${h0.availGB.toFixed(1)} GB < ${need.toFixed(1)} or load ${h0.load1.toFixed(1)} > 20): nothing run`); process.exit(3); }
fs.mkdirSync(OUT, { recursive: true });

const procs = [];
let voided = null;
const runArm = (a, i) => new Promise((resolve) => {
  const label = `lv${i}-${a.name.replace(/[^a-z0-9]+/gi, '_').slice(0, 24)}`;
  const pin = path.join(BASE, `pin-cfg-${label}`); fs.mkdirSync(pin, { recursive: true });
  const rigs = path.join(BASE, 'rigs', label); fs.mkdirSync(rigs, { recursive: true });
  const driveArgs = ['--no-warnings', '--experimental-strip-types', path.join(HERE, 'drive-liveness.mjs'), '--base', BASE, '--repo', REPO, '--app', a.app, '--claude', claudeBin, '--arm', a.arm, '--switch', a.switch ?? 'on', '--window-s', String(WINDOW_S), '--label', label];
  const env = { PATH: process.env.PATH, HOME: REAL_HOME, E2E_RIG_BASE: rigs, CLAUDE_CONFIG_DIR_PIN: pin };
  const log = fs.createWriteStream(path.join(OUT, `${label}.log`));
  const child = spawn('bash', [path.join(REPO, 'scripts', 'e2e-contained-rig.sh'), process.execPath, ...driveArgs], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  procs.push(child);
  let buf = '', res = null;
  child.stdout.on('data', (d) => { log.write(d); buf += d; let k; while ((k = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, k); buf = buf.slice(k + 1); if (l.startsWith('LIVSOAK-RESULT ')) { try { res = JSON.parse(l.slice(15)); } catch { /* */ } } if (/ESCALATION|DRIVE-ERROR|^LIVSOAK /.test(l)) say(`  [${a.name}] ${l.slice(0, 230)}`); } });
  child.stderr.on('data', (d) => log.write(d));
  child.on('close', (code) => { log.end(); resolve({ ...a, label, rc: code, res }); });
});
// the host guard: MemAvailable read every 5 s — below 2.5 GB the soak is VOID (every rig is stopped), never a verdict
const guard = setInterval(() => {
  const h = hostNow();
  if (h.availGB < 2.5 && !voided) { voided = `MemAvailable ${h.availGB.toFixed(2)} GB < 2.5 GB`; say(`!! VOID — ${voided}: stopping every rig`); for (const p of procs) { try { process.kill(p.pid, 'SIGTERM'); } catch { /* gone */ } } }
}, 5000);
const t0 = Date.now();
const runs = [];
for (let i = 0; i < ARMS.length; i++) { runs.push(runArm(ARMS[i], i + 1)); await sleep(STAGGER_MS); }
const done = await Promise.all(runs);
clearInterval(guard);
const host = hostNow();
const rows = done.map((d) => ({ name: d.name, want: d.want, got: d.res?.verdict ?? 'NO-RESULT', ok: !voided && d.res?.verdict === d.want && d.res?.liveUnchanged === true && d.res?.leftover === 0, res: d.res }));
const table = ['| run | attendu | obtenu | lignes d\'escalade (au bout de, corps) | CLI child | requêtes child |', '|---|---|---|---|---|---|', ...rows.map((r) => `| ${r.name} | ${r.want} | ${r.got}${r.ok ? '' : ' ✗'} | ${r.res?.rows?.length ?? '?'}${r.res?.rows?.length ? ` (${r.res.rows.map((x) => `+${x.atS}s ${x.body.slice(0, 48)}`).join(' ; ')})` : ''} | ${r.res?.cliNow ?? ''} | ${r.res?.childRequests ?? ''} |`)].join('\n');
say(`\n${table}\n`);
const unm = rows.filter((r) => r.name.startsWith('done-idle-'));
const zeroRows = unm.reduce((a, r) => a + (r.res?.rows?.length ?? 0), 0);
const clean = !voided && rows.every((r) => r.ok);
fs.writeFileSync(path.join(OUT, 'soak.json'), JSON.stringify({ tree: REPO, windowS: WINDOW_S, runs: rows, voided, hostEnd: host, wallS: Math.round((Date.now() - t0) / 1000) }, null, 1));
fs.writeFileSync(path.join(OUT, 'soak.md'), `# Liveness soak — real clock, plain parent + 1 child (#438-fu)\n\n${table}\n\nunmutated runs: ${unm.length}, escalation rows in them: ${zeroRows}; wall ${Math.round((Date.now() - t0) / 1000)} s\n`);
say(`LIVSOAK-SOAK ${voided ? `VOID (${voided})` : clean ? 'CLEAN' : 'DIRTY'} — ${unm.length} unmutated runs, ${zeroRows} escalation row(s) in them; controls: ${rows.filter((r) => !r.name.startsWith('done-idle-')).map((r) => `${r.name} ${r.ok ? 'as expected' : 'UNEXPECTED'}`).join(' · ')}; wall ${Math.round((Date.now() - t0) / 1000)} s; report ${OUT}`);
process.exit(voided ? 3 : clean ? 0 : 1);
