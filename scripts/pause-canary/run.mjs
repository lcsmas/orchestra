#!/usr/bin/env node
// Pause canary 1 — dummy-fleet drills (#258, wave F ledger #281 D3):   pnpm run canary:pause [-- options]
//   node scripts/pause-canary/run.mjs [--exercise douce,dure,reprise,auto] [--cycles 3] [--members 10] [--app <dir>/orchestra] [--base <scratch>] [--out <dir>] [--dwell-s 40]
//   node scripts/pause-canary/run.mjs --proof [--only <arm,…>]      the HARNESS proof (G3 F2): clean controls must PASS, every must-FAIL arm (build-level mutants of the PACKAGED app, the
//                                                                    pre-wave-E master, the switch OFF) must turn its named instrument RED — see mutants.mjs / --list
// REAL path, zero tokens: the PACKAGED app (a session's `orchestra` shim needs it) in a headless sway (scripts/e2e-contained-rig.sh), scratch ORCHESTRA_HOME / HOME / CLAUDE_CONFIG_DIR,
// the REAL keepers + `claude` CLI against a scripted local fake Anthropic API, the `pause` switch ON for the scratch fleet's runs only. NEVER pauses a real run (D6).
// Exit: 0 every drill PASS / every proof arm as expected · 1 a drill FAILED (a bug report with raw evidence — never a lowered bar) · 3 VOID (host below the 6 GB / load-20 bar, tooling missing: nothing measured).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { makeMutantApp, MUTANTS } from './mutants.mjs';
import { renderTable, BARS } from './bars.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REAL_HOME = os.userInfo().homedir;
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const BASE = path.resolve(opt('base', path.join(REAL_HOME, '.cache', 'pause-canary')));
const OUT = path.resolve(opt('out', path.join(BASE, 'reports', new Date().toISOString().replace(/[:.]/g, '-'))));
const MIN_AVAIL_GB = Number(opt('min-avail-gb', '6'));
const say = (s = '') => console.log(s);

// ── proof arms (G3 F2): each must-FAIL arm names the instrument it must turn RED; the clean controls run the SAME shape and must PASS ──
const PROOF_ARMS = [
  { name: 'control:clean-dure', exercise: 'dure', expect: 'PASS' },
  { name: 'control:clean-reprise', exercise: 'reprise', expect: 'PASS' },
  { name: 'control:clean-auto', exercise: 'auto', expect: 'PASS' },
  { name: 'control:clean-douce', exercise: 'douce', expect: 'PASS', slow: true },
  ...Object.entries(MUTANTS).map(([m, d]) => ({ name: `mutant:${m}`, mutant: m, exercise: d.exercise, redden: d.redden, slow: d.exercise === 'douce' })),
  // harness-level instrument controls: the drive sabotages its own evidence after the pause — the lost-work instrument must read RED for a rewound branch and for a deleted pause ref
  { name: 'control:sabotage-branch', exercise: 'dure', sabotage: 'branch', redden: ['bar:lost_work_is_zero'] },
  { name: 'control:sabotage-ref', exercise: 'dure', sabotage: 'ref', redden: ['bar:lost_work_is_zero'] },
  { name: 'control:pause-switch-off', exercise: 'dure', pause: 'off', redden: ['pause_accepted'] },
  { name: 'unfixed:pre-wave-E-douce', exercise: 'douce', unfixed: true, redden: ['pause_accepted'] },
  { name: 'unfixed:pre-wave-E-reprise', exercise: 'dure', unfixed: true, redden: ['coordinators_woken', 'bar:every_member_reprise_accused'] },
];
if (flag('list')) { for (const a of PROOF_ARMS) say(`${a.name.padEnd(36)} ${a.exercise}${a.redden ? ` → RED ${a.redden.join(' | ')}` : ' → PASS'}${a.mutant ? ` — ${MUTANTS[a.mutant].desc}` : ''}`); process.exit(0); }

// ── host guards (the OPS bar) ──
function hostNow() {
  const mem = fs.readFileSync('/proc/meminfo', 'utf8');
  return { availGB: Number(/MemAvailable:\s+(\d+) kB/.exec(mem)[1]) / 1048576, load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) };
}
const h0 = hostNow();
if (process.env.PC_IGNORE_HOST !== '1' && (h0.availGB < MIN_AVAIL_GB || h0.load1 > 20)) {
  say(`PAUSE-CANARY: VOID — host below the bar (MemAvailable ${h0.availGB.toFixed(2)} GB < ${MIN_AVAIL_GB}, or load ${h0.load1.toFixed(1)} > 20); nothing was measured (ask the OPS rather than lowering the bar)`);
  process.exit(3);
}
for (const t of ['sway', 'grim', 'python3', 'swaymsg']) if (spawnSync('which', [t], { encoding: 'utf8' }).status !== 0) { say(`PAUSE-CANARY: VOID — \`${t}\` not on PATH (the headless-sway rig needs it)`); process.exit(3); }
const claudeBin = (() => { for (const c of [path.join(REAL_HOME, '.local/bin/claude'), ...String(process.env.PATH ?? '').split(':').map((d) => path.join(d, 'claude'))]) if (fs.existsSync(c)) return c; return null; })();
if (!claudeBin) { say('PAUSE-CANARY: VOID — no `claude` CLI found'); process.exit(3); }

const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20, ...o });
const git = (...a) => sh('git', a).stdout.trim();

// ── the packaged app under test: build it from THIS tree unless one is given (rebuild what you exec — a stale bundle reproduces perfectly) ──
function srcStamp() {
  const dirty = sh('git', ['status', '--porcelain', '--', 'src', 'package.json', 'pnpm-lock.yaml', 'vite.config.ts', 'vite.cli.config.ts', 'vite.keeper.config.ts', 'scripts/after-pack-check.cjs']).stdout.trim();
  const tree = git('rev-parse', 'HEAD:src') + git('rev-parse', 'HEAD:package.json');
  return createHash('sha256').update('recipe2' + tree + dirty + (dirty ? sh('git', ['diff', 'HEAD', '--', 'src', 'package.json']).stdout : '')).digest('hex').slice(0, 12);
}
function ensureApp() {
  if (opt('app', null)) return path.resolve(opt('app'));
  const dir = path.join(BASE, 'apps', `src-${srcStamp()}`);
  if (fs.existsSync(path.join(dir, 'orchestra'))) { say(`app: reusing ${dir} (source stamp unchanged)`); return path.join(dir, 'orchestra'); }
  say(`app: building the PACKAGED app from ${REPO} (HEAD ${git('rev-parse', '--short', 'HEAD')}) …`);
  if (!fs.existsSync(path.join(REPO, 'build', 'bus-abi'))) { const r = sh('pnpm', ['run', 'build:bus-abi']); if (r.status !== 0) { say(`PAUSE-CANARY: VOID — build:bus-abi failed: ${(r.stdout + r.stderr).slice(-300)}`); process.exit(3); } }
  for (const d of ['dist', 'dist-electron', 'release']) fs.rmSync(path.join(REPO, d), { recursive: true, force: true });   // a stale chunk left by an earlier build would ship in app.asar as dead code
  for (const [c, a] of [['pnpm', ['run', 'build:bundles']], ['npx', ['electron-builder', '--dir']]]) { const r = sh(c, a); if (r.status !== 0) { say(`PAUSE-CANARY: VOID — ${c} ${a.join(' ')} failed: ${(r.stdout + r.stderr).slice(-400)}`); process.exit(3); } }
  const unpacked = fs.readdirSync(path.join(REPO, 'release')).find((d) => /-unpacked$/.test(d));
  if (!unpacked) { say('PAUSE-CANARY: VOID — electron-builder produced no *-unpacked dir'); process.exit(3); }
  fs.mkdirSync(path.dirname(dir), { recursive: true });
  sh('cp', ['-a', '--reflink=auto', path.join(REPO, 'release', unpacked), dir]);
  return path.join(dir, 'orchestra');
}

// ── one drive inside the contained rig ──
async function drive({ appBin, appTree, exercise, cycles, members, label, pause, dwell, extra = [] }) {
  fs.mkdirSync(OUT, { recursive: true });
  const outJson = path.join(OUT, `${label}.json`);
  const logFile = path.join(OUT, `${label}.log`);
  const driveArgs = ['--no-warnings', '--experimental-strip-types', path.join(HERE, 'drive.mjs'), '--base', BASE, '--repo', REPO, '--app', appBin, '--claude', claudeBin, '--exercise', exercise, '--cycles', String(cycles), '--members', String(members), '--label', label, '--out', outJson, '--min-avail-gb', String(MIN_AVAIL_GB), ...(appTree ? ['--app-tree', appTree] : []), ...(pause ? ['--pause', pause] : []), ...(dwell ? ['--dwell-s', String(dwell)] : []), ...extra];
  fs.mkdirSync(path.join(BASE, 'rigs'), { recursive: true });
  fs.mkdirSync(path.join(BASE, 'pin-cfg'), { recursive: true });
  const env = { PATH: process.env.PATH, HOME: REAL_HOME, XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR ?? '/run/user/1000', E2E_RIG_BASE: path.join(BASE, 'rigs'), CLAUDE_CONFIG_DIR_PIN: path.join(BASE, 'pin-cfg') };
  const log = fs.createWriteStream(logFile);
  const child = spawn('bash', [path.join(REPO, 'scripts', 'e2e-contained-rig.sh'), process.execPath, ...driveArgs], { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = [];
  let buf = '';
  child.stdout.on('data', (d) => { log.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l); if (!flag('quiet') && /^(ok |RED |── |PAUSE-CANARY|\|)|\bVOID\b|DRIVE-ERROR/.test(l)) say(l); } });
  child.stderr.on('data', (d) => log.write(d));
  const rc = await new Promise((r) => child.on('close', (c, s) => r(c ?? s)));
  log.end();
  const pc = (tag) => lines.filter((l) => l.startsWith(`${tag} `)).map((l) => { try { return JSON.parse(l.slice(tag.length + 1)); } catch { return null; } }).filter(Boolean);
  const verdictLine = lines.reverse().find((l) => l.startsWith('PAUSE-CANARY-DRIVE '));
  lines.reverse();
  return { rc, label, logFile, outJson, exercises: pc('PC-EXERCISE'), cycles: pc('PC-CYCLE'), checks: pc('PC-CHECK'), host: pc('PC-HOST')[0] ?? null, verdict: verdictLine ? verdictLine.split(' ')[1] : 'NO-RESULT' };
}

const gitInfo = () => ({ head: git('rev-parse', 'HEAD'), branch: git('rev-parse', '--abbrev-ref', 'HEAD'), originMaster: sh('git', ['ls-remote', 'origin', 'refs/heads/master']).stdout.slice(0, 40) });

function writeReport(kind, body) { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${kind}.md`), body); say(`\nreport: ${path.join(OUT, `${kind}.md`)}`); }

const claudeVersion = sh(claudeBin, ['--version']).stdout.trim();

if (!flag('proof')) {
  // ── the canary itself ──
  const appBin = ensureApp();
  const exercise = opt('exercise', 'douce,dure,reprise,auto');
  const cycles = Number(opt('cycles', '3')), members = Number(opt('members', '10'));
  say(`pause canary: claude ${claudeVersion} · app ${appBin} · exercises ${exercise} × ${cycles} cycles · ${members} workers + OPS + LEAD · MemAvailable ${h0.availGB.toFixed(2)} GB load ${h0.load1.toFixed(1)}`);
  const r = await drive({ appBin, exercise, cycles, members, label: opt('label', `canary-${Date.now().toString(36).slice(-4)}`), pause: opt('pause', null), dwell: opt('dwell-s', null) });
  const table = renderTable(r.cycles);
  const gi = gitInfo();
  const reds = r.checks.filter((c) => !c.ok);
  const md = [`# Pause canary 1 — dummy fleet (${members} workers + OPS + LEAD, ${cycles} cycles/exercise)`, '', `tree ${gi.head.slice(0, 8)} (${gi.branch}) · origin/master ${gi.originMaster.slice(0, 8)} · claude ${claudeVersion} · app ${appBin}`, `host: min MemAvailable ${r.host?.minAvailGB?.toFixed(2) ?? 'n/a'} GB · max load ${r.host?.maxLoad?.toFixed(1) ?? 'n/a'} · ${r.host?.samples ?? 0} samples`, `bars (never lowered): dure all-paused < ${BARS.hardAllPausedS} s · douce escalation ≤ ${BARS.softDeadlineS}+${BARS.softEscalationSlackS} s then trap < ${BARS.softTrapAfterEscalationS} s · lost work ${BARS.lostWork} · self-restarts ${BARS.selfRestarts} · every member reprise-accused`, '', table, '', `verdict: **${r.verdict}** (${r.exercises.map((e) => `${e.exercise}:${e.result}`).join(' ')})`, `raw evidence: drive log ${r.logFile} · per-exercise rig dirs (api-requests.json, app.log, bus.sqlite, repo/) ${BASE}/h-${r.label}-<exercise>/`, '', reds.length ? `RED checks (raw evidence in ${r.logFile}):\n${reds.map((c) => `- ${c.exercise} c${c.cycle} \`${c.id}\` — ${c.detail}`).join('\n')}` : 'no RED check.', ''].join('\n');
  writeReport('report', md);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ git: gi, claude: claudeVersion, app: appBin, drive: r }, null, 1));
  say(`\n${table}\n`);
  say(`PAUSE-CANARY: ${r.verdict}`);
  process.exit(r.verdict === 'PASS' ? 0 : r.verdict === 'VOID' ? 3 : 1);
}

// ── the HARNESS proof (G3 F2) ──
const baseApp = ensureApp();
const baseDir = path.dirname(baseApp);
const only = new Set((opt('only', '') || '').split(',').filter(Boolean));
const sel = PROOF_ARMS.filter((a) => only.size === 0 || only.has(a.name) || only.has(a.name.replace(/^(mutant|control|unfixed):/, '')));
const members = Number(opt('members', '3'));
// the PRE-wave-E master (b34c8b58: hard Pause only — no Pause douce, no structured Reprise) as a packaged app + its source tree (the seed needs the matching schema); pinned, built once
function ensureUnfixed() {
  const given = opt('unfixed-app', process.env.PC_UNFIXED_APP ?? null);
  if (given) return { app: path.resolve(given), tree: path.resolve(opt('unfixed-tree', process.env.PC_UNFIXED_TREE ?? '')) };
  const sha = sh('git', ['rev-parse', `${process.env.PC_UNFIXED_SHA ?? 'b34c8b58'}^{commit}`]).stdout.trim();
  if (!sha) { say('PAUSE-CANARY: VOID — the pre-wave-E commit b34c8b58 is not in this repo (set PC_UNFIXED_SHA)'); process.exit(3); }
  const tree = path.join(BASE, 'wt', `unfixed-${sha.slice(0, 8)}`);
  const app = path.join(BASE, 'apps', `unfixed-${sha.slice(0, 8)}`, 'orchestra');
  if (fs.existsSync(app)) return { app, tree };
  say(`unfixed: building the pre-wave-E master ${sha.slice(0, 8)} as a PACKAGED app …`);
  if (!fs.existsSync(tree)) {
    const w = sh('git', ['worktree', 'add', '--detach', tree, sha]);
    if (w.status !== 0) { say(`PAUSE-CANARY: VOID — cannot create the unfixed worktree: ${w.stderr.slice(-200)}`); process.exit(3); }
    fs.symlinkSync(path.join(REPO, 'node_modules'), path.join(tree, 'node_modules'));
    fs.mkdirSync(path.join(tree, 'build'), { recursive: true });
    fs.symlinkSync(path.join(REPO, 'build', 'bus-abi'), path.join(tree, 'build', 'bus-abi'));   // the seed runs under system node (ABI 127): bus-binding finds <tree>/build/bus-abi
  }
  for (const [c, a] of [['pnpm', ['run', 'build:bundles']], ['npx', ['electron-builder', '--dir']]]) { const r = sh(c, a, { cwd: tree }); if (r.status !== 0) { say(`PAUSE-CANARY: VOID — unfixed ${c} ${a.join(' ')} failed: ${(r.stdout + r.stderr).slice(-400)}`); process.exit(3); } }
  const unpacked = fs.readdirSync(path.join(tree, 'release')).find((d) => /-unpacked$/.test(d));
  fs.mkdirSync(path.dirname(app), { recursive: true });
  sh('cp', ['-a', '--reflink=auto', path.join(tree, 'release', unpacked), path.dirname(app)]);   // copies INTO apps/unfixed-<sha>/<unpacked dir>; flatten below
  const inner = path.join(path.dirname(app), unpacked);
  for (const f of fs.readdirSync(inner)) fs.renameSync(path.join(inner, f), path.join(path.dirname(app), f));
  fs.rmdirSync(inner);
  return { app, tree };
}
say(`harness proof: ${sel.length} arm(s) at ${members} workers × ${opt('cycles', '1')} cycle(s) · base app ${baseApp}`);
const rows = [];
for (const arm of sel) {
  const h = hostNow();
  if (process.env.PC_IGNORE_HOST !== '1' && (h.availGB < MIN_AVAIL_GB || h.load1 > 20)) { rows.push({ arm: arm.name, verdict: 'VOID', why: `host below the bar (MemAvailable ${h.availGB.toFixed(2)} GB, load ${h.load1.toFixed(1)})` }); continue; }
  let appBin = baseApp, appTree = null, mutInfo = null;
  try {
    if (arm.mutant) { mutInfo = makeMutantApp(baseDir, arm.mutant, path.join(BASE, 'apps', `mut-${arm.mutant}`)); appBin = mutInfo.bin; say(`   mutant ${arm.mutant}: ${mutInfo.edits.map((e) => `${e.hits}×`).join(' ')} edit(s), copy ${mutInfo.copySha} vs base ${mutInfo.baseSha}`); }
    if (arm.unfixed) { const u = ensureUnfixed(); appBin = u.app; appTree = u.tree; }
  } catch (e) { rows.push({ arm: arm.name, verdict: 'VOID', why: String(e.message).slice(0, 200) }); continue; }
  say(`\n=== ${arm.name} (${arm.redden ? `must-FAIL: ${arm.redden.join(' | ')} RED` : 'must-PASS'}) ===`);
  const r = await drive({ appBin, appTree, exercise: arm.exercise, cycles: Number(opt('cycles', '1')), members, label: `proof-${arm.name.replace(/[^a-z0-9]+/gi, '_')}`, pause: arm.pause ?? null, dwell: opt('dwell-s', null), extra: arm.sabotage ? ['--sabotage', arm.sabotage] : [] });
  const red = r.checks.filter((c) => !c.ok);
  const reached = r.checks.some((c) => c.id === 'workers_mid_work' && c.ok);   // the rig itself must have worked: a drive that never got the fleet to mid-work proves nothing
  let verdict, why;
  if (r.verdict === 'VOID') { verdict = 'VOID'; why = 'host guard'; }
  else if (arm.redden) {
    const hit = arm.redden.filter((id) => red.some((c) => c.id === id));
    verdict = hit.length > 0 && (reached || arm.unfixed || arm.name === 'control:pause-switch-off') ? 'AS-EXPECTED (RED)' : !reached ? 'RIG-BROKE' : 'MUTANT-SURVIVED';
    why = `${hit.length ? `RED: ${hit.join(', ')}` : `named check(s) ${arm.redden.join(', ')} stayed green/absent`}; all RED: ${red.map((c) => `c${c.cycle} ${c.id}`).slice(0, 8).join(' · ') || 'none'}`;
  } else { verdict = r.verdict === 'PASS' ? 'AS-EXPECTED (PASS)' : 'UNEXPECTED-RED'; why = r.verdict === 'PASS' ? `${r.checks.length} checks green` : `RED: ${red.map((c) => `c${c.cycle} ${c.id} (${c.detail.slice(0, 100)})`).slice(0, 6).join(' · ')}`; }
  rows.push({ arm: arm.name, verdict, why, log: r.logFile });
  say(`=== ${arm.name}: ${verdict} — ${why}`);
}
const bad = rows.filter((r) => !/^AS-EXPECTED/.test(r.verdict));
const md = [`# Pause canary — harness proof (G3 F2)`, '', `tree ${gitInfo().head.slice(0, 8)} · claude ${claudeVersion} · ${members} workers × ${opt('cycles', '1')} cycle · host MemAvailable at start ${h0.availGB.toFixed(2)} GB`, '', '| arm | verdict | evidence |', '|---|---|---|', ...rows.map((r) => `| ${r.arm} | ${r.verdict} | ${r.why.replace(/\|/g, '/')} |`), '', `PROOF: ${bad.length === 0 ? 'PASS' : 'NOT PROVEN'}`, ''].join('\n');
writeReport('proof', md);
say(`\nPAUSE-CANARY PROOF: ${bad.length === 0 ? 'PASS' : `FAIL (${bad.map((r) => `${r.arm}:${r.verdict}`).join(', ')})`}`);
process.exit(bad.length === 0 ? 0 : bad.some((r) => r.verdict === 'VOID') && bad.every((r) => r.verdict === 'VOID') ? 3 : 1);
