#!/usr/bin/env node
// Pause canary 1b — the MEMORY-HOG exercise (#324, wave H ledger #329):   pnpm run canary:memhog [-- options]
//   node scripts/pause-canary/memhog-run.mjs --heavy-token <ref> [--exercise memhog,chain] [--cycles 3] [--members 6] [--out <dir>]
//   node scripts/pause-canary/memhog-run.mjs --heavy-token <ref> --proof [--only <arm,…>]    the HARNESS proof: a clean control must PASS, the cap OFF must FAIL, every instrument must be seen RED by a sabotage, Q9 must stay KNOWN-RED
//   node scripts/pause-canary/memhog-run.mjs --list                                          the proof arms (no token, nothing run)
// WHAT IT PROVES (OPS lot 6198): on a dummy fleet LEAD ⊃ OPS ⊃ N workers each in its own kernel memory scope (256 MiB), a process that overflows the cap is killed · the worker's session (keeper + CLI) survives ·
// the worker AND its coordinator are told (#322, read through the coordinator's own relève) · only the coordinator is told · 0 survivors. The `memory_cap` DEFAULT is NOT flipped by this work (Q9 blocks it, the LEAD decides).
// SUBSTRATE: the real keeper + real systemd scopes + real scratch bus + the production notice sink, with the H1 stand-in CLI (a real `claude` is ~330 MB: it needs the LEAD's waiver of D2, `--cli claude` is refused).
// HEAVY: real scopes and kernel OOM kills — run ONLY under the heavy-rig token (ask the OPS), MemAvailable ≥ 6 GB + the rig's footprint, one heavy rig at a time; return the token right after.
// Exit: 0 PASS (full shape: ≥ 6 workers × ≥ 3 cycles, chain run) · 4 green but PARTIAL · 5 green but a KNOWN-RED instrument went green (Q9 fixed? promote it) · 1 a bar is RED (a bug report, never a retuned number) · 3 VOID (host / tooling: nothing measured).
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawn, spawnSync } from 'node:child_process';
import { randomBytes } from 'node:crypto';
import { randomPrefix } from './ids.mjs';
import { liveSnapshot } from './lib.mjs';
import { MEMHOG_BARS, KNOWN_RED, REQUIRED_CYCLE_CHECKS, renderMemhogTable, drillVerdict, missingChecks, splitChecks, evaluateSurvivors, evaluateLiveUntouched, memhogArmVerdict } from './memhog-bars.mjs';
import { rigProcesses, killByIdentity } from './memhog-os.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..', '..');
const REAL_HOME = os.userInfo().homedir;
const UNIT_PREFIX = 'orchestra-rig-wh-h3-';
const args = process.argv.slice(2);
const opt = (k, d) => { const i = args.indexOf(`--${k}`); return i >= 0 ? args[i + 1] : d; };
const flag = (k) => args.includes(`--${k}`);
const say = (s = '') => console.log(s);
const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
const TOKEN_RUN = randomBytes(2).toString('hex');
// Short on purpose: a unix socket path must stay < ~100 bytes (`<root>/<run>/<arm>/home/keepers/<36-char ws id>.sock`) or keeperSocketPath hashes it into /tmp.
const ROOT = path.resolve(opt('base', path.join(REAL_HOME, '.cache', 'mhc')));
const RUN_DIR = path.join(ROOT, TOKEN_RUN);
const OUT = path.resolve(opt('out', path.join(ROOT, 'reports', new Date().toISOString().replace(/[:.]/g, '-'))));
const MIN_AVAIL_GB = Number(opt('min-avail-gb', '6'));

// ── proof arms: each must-FAIL arm names the instrument(s) it must turn RED with a MEASURED reason, and the ones that must stay GREEN (precision); the clean control runs the SAME shape and must PASS ──
const PROOF_ARMS = [
  { name: 'control:clean', exercise: 'memhog', expect: 'PASS' },
  { name: 'control:cap-off', exercise: 'memhog', switch: 'off', redden: ['bar:cap_scope_applied', 'bar:hog_killed', 'bar:cap_holds_after_kill', 'bar:member_told', 'bar:coordinator_told'], stayGreen: ['bar:session_survives'] },   // the ticket's must-FAIL: the same drill with the frozen `memory_cap` switch OFF
  { name: 'control:hog-small', exercise: 'memhog', sabotage: 'hog-small', redden: ['bar:hog_killed', 'bar:member_told', 'bar:coordinator_told'], stayGreen: ['bar:cap_scope_applied', 'bar:session_survives'], expectDetail: /hog NOT killed: killed=0 survived=1|no kill to tell/ },   // the scope is there, the hog stays below the cap
  { name: 'control:sabotage-session', exercise: 'memhog', sabotage: 'session', redden: ['bar:session_survives'], stayGreen: ['bar:hog_killed', 'bar:member_told', 'bar:coordinator_told'], expectDetail: /w1: CLI (GONE|REPLACED)/ },   // a worker's CLI is SIGTERMed after the kill
  { name: 'control:sabotage-member-sink', exercise: 'memhog', sabotage: 'member-sink', redden: ['bar:member_told'], reddenAny: ['published:time_to_member_told_s'], stayGreen: ['bar:coordinator_told', 'bar:hog_killed', 'bar:session_survives'], expectDetail: /0 notice row\(s\) for [1-9]/ },
  { name: 'control:sabotage-coord-sink', exercise: 'memhog', sabotage: 'coord-sink', redden: ['bar:coordinator_told'], reddenAny: ['published:time_to_coordinator_told_s'], stayGreen: ['bar:member_told', 'bar:hog_killed', 'bar:session_survives'], expectDetail: /0 escalation\(s\) for [1-9]/ },
  { name: 'control:sabotage-stray-lead', exercise: 'memhog', sabotage: 'stray-lead', redden: ['bar:only_coordinator_told'], stayGreen: ['bar:member_told', 'bar:coordinator_told', 'bar:hog_killed'], expectDetail: /the LEAD saw [1-9]/ },   // every escalation is copied to the coordinator's coordinator
  { name: 'control:sabotage-leak', exercise: 'memhog', sabotage: 'leak', redden: ['bar:no_survivors'], stayGreen: ['bar:hog_killed', 'bar:member_told', 'bar:coordinator_told', 'bar:session_survives'], expectDetail: /[1-9]\d* process\(es\) carrying the rig dir/ },   // the drill leaves a process behind on purpose: the parent's survivors count must see it
  { name: 'control:sabotage-leak-unit', exercise: 'memhog', sabotage: 'leak-unit', redden: ['bar:no_survivors'], stayGreen: ['bar:hog_killed', 'bar:member_told', 'bar:coordinator_told', 'bar:session_survives'], expectDetail: /[1-9]\d* scope\(s\) with the rig prefix/ },   // the SCOPES leg of the survivors count: a ≤ 64 MB unit the drill leaves behind
  { name: 'control:sabotage-no-worker', exercise: 'memhog', sabotage: 'no-worker', redden: ['workers_up'], stayGreen: [], expectDetail: /w1: session never came up/, workersUpExpectedRed: true },   // the first worker is never started: the « fleet is up » instrument must say so (the others stay measured)
  { name: 'control:live-config', internal: 'live-config' },   // the live-config instrument on a SCRATCH home (no drive): unchanged ⇒ green, an added entry ⇒ RED with the change in the detail
  { name: 'control:chain-cap-off', exercise: 'chain', switch: 'off', cycles: 1, expectVerdict: 'VOID', redden: ['premise_chain_killed_tools'], expectDetail: /^0 kernel kill/ },   // the Q9 instrument with nothing to measure: VOID, never a green
  { name: 'known-red:q9-chain', exercise: 'chain', cycles: 3, expectVerdict: 'KNOWN-RED' },   // Q9 / residual (d): must stay RED until Q9 is fixed (then KNOWN-RED-GONE: promote it to a bar)
];
if (flag('list')) { for (const a of PROOF_ARMS) say(`${a.name.padEnd(32)} ${a.internal ? `internal: ${a.internal} (scratch home, no drive)` : a.exercise}${a.expect ? ' → PASS' : a.expectVerdict ? ` → verdict ${a.expectVerdict}` : ''}${a.redden ? ` → RED ${a.redden.join(' | ')}` : ''}${a.reddenAny ? ` + RED (any reason) ${a.reddenAny.join(' | ')}` : ''}${a.stayGreen?.length ? ` (stay GREEN ${a.stayGreen.join(' | ')})` : ''}`); process.exit(0); }

if (opt('cli', 'stand-in') !== 'stand-in') { say('MEMHOG-CANARY: VOID — `--cli claude` needs the LEAD\'s waiver of ledger D2 (test scopes ≤ 300 MB; the real claude is ~330 MB). Not run.'); process.exit(3); }
const HEAVY = opt('heavy-token', process.env.MEMHOG_HEAVY_TOKEN ?? '');
if (HEAVY.startsWith('--')) { say(`MEMHOG-CANARY: usage — --heavy-token takes the token reference, got a flag (${HEAVY})`); process.exit(2); }
// the live-config control runs on a scratch home with no drive, no scope, no docker: it needs no token
const onlyNames = (opt('only', '') || '').split(',').filter(Boolean);
const internalOnly = flag('proof') && onlyNames.length > 0 && onlyNames.every((n) => PROOF_ARMS.some((a) => a.internal && (a.name === n || a.name.replace(/^(control|known-red):/, '') === n)));
if (!HEAVY && !internalOnly) { say('MEMHOG-CANARY: VOID — real scopes + kernel OOM kills = a HEAVY rig: run it only under the heavy-rig token (ask the OPS), then pass --heavy-token <ref> (or MEMHOG_HEAVY_TOKEN). Nothing was run.'); process.exit(3); }

// ── host guards ──
const hostNow = () => ({ availGB: Number(/MemAvailable:\s+(\d+) kB/.exec(fs.readFileSync('/proc/meminfo', 'utf8'))[1]) / 1048576, load1: Number(fs.readFileSync('/proc/loadavg', 'utf8').split(' ')[0]) });
/** What a drill costs in MemAvailable: per worker a 256 MiB scope + (cap OFF) the 400 MB hog that nothing bounds; the chain is one worker at a time. */
const footprintGB = (members, off) => members * (off ? 0.7 : 0.3) + 0.3;
const FOREIGN = /(pause-canary\/(drive|memhog)\.mjs|e2e-memory-cap\.mjs|e2e-contained-rig\.sh)/;
function foreignRigs() {
  const out = [];
  for (const d of fs.readdirSync('/proc')) {
    if (!/^\d+$/.test(d) || Number(d) === process.pid) continue;
    try { const c = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' '); if (FOREIGN.test(c) && !c.includes(RUN_DIR)) out.push(Number(d)); } catch { /* gone */ }
  }
  return out;
}
async function waitForHost(members, off = false) {
  const maxMs = Number(opt('wait-host-min', '20')) * 60000;
  const need = MIN_AVAIL_GB + footprintGB(members, off);
  const t0 = Date.now();
  for (;;) {
    const h = hostNow(); const others = foreignRigs();
    const ok = h.availGB >= need && h.load1 <= 20 && others.length === 0;
    if (ok || Date.now() - t0 >= maxMs) return { ...h, need, ok, waitedS: Math.round((Date.now() - t0) / 1000), foreign: others.length };
    await sleep(15000);
  }
}
const unitsNow = (glob) => (spawnSync('systemctl', ['--user', 'list-units', '--all', '--no-legend', '--plain', glob], { encoding: 'utf8' }).stdout ?? '').split('\n').map((l) => l.trim().split(/\s+/)[0]).filter(Boolean);

// ── one drill = one child process (singletons) under an allowlisted env ──
async function drive({ exercise, members, cycles, off = false, sabotage = null, label }) {
  fs.mkdirSync(OUT, { recursive: true });
  const base = path.join(RUN_DIR, label);
  fs.mkdirSync(base, { recursive: true });
  fs.writeFileSync(path.join(base, '.memhog-scratch'), `${process.pid}\n`);   // the sentinel the driver's `rm -rf` of its own scratch dir requires
  const prefix = randomPrefix();
  const logFile = path.join(OUT, `${label}.log`);
  const driveArgs = ['--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', '--import', path.join(REPO, 'scripts', '.r2-register.mjs'), path.join(HERE, 'memhog.mjs'),
    '--base', base, '--prefix', prefix, '--exercise', exercise, '--members', String(members), '--cycles', String(cycles), '--switch', off ? 'off' : 'on', '--min-avail-gb', String(MIN_AVAIL_GB), ...(sabotage ? ['--sabotage', sabotage] : [])];
  const env = { PATH: process.env.PATH, HOME: REAL_HOME, MC_REAL_HOME: REAL_HOME, LANG: 'C.UTF-8', SHELL: process.env.SHELL ?? '/bin/bash', XDG_RUNTIME_DIR: process.env.XDG_RUNTIME_DIR, DBUS_SESSION_BUS_ADDRESS: process.env.DBUS_SESSION_BUS_ADDRESS };   // systemd-run --user needs the user manager
  for (const k of Object.keys(env)) if (env[k] === undefined) delete env[k];
  const unitsBefore = new Set(unitsNow(`${UNIT_PREFIX}${prefix}*`));
  const log = fs.createWriteStream(logFile);
  const child = spawn(process.execPath, driveArgs, { cwd: REPO, env, stdio: ['ignore', 'pipe', 'pipe'] });
  const lines = []; let buf = '';
  child.stdout.on('data', (d) => { log.write(d); buf += d; let i; while ((i = buf.indexOf('\n')) >= 0) { const l = buf.slice(0, i); buf = buf.slice(i + 1); lines.push(l); if (!flag('quiet') && /^(ok |RED |chain:|fleet:|MEMHOG|DRIVE-ERROR)/.test(l)) say(l); } });
  child.stderr.on('data', (d) => log.write(d));
  const timeout = setTimeout(() => { try { child.kill('SIGKILL'); } catch { /* gone */ } }, (180 + cycles * (exercise === 'chain' ? 420 : 300)) * 1000);
  const rc = await new Promise((r) => child.on('close', (c, s) => r(c ?? s)));
  clearTimeout(timeout);
  log.end();
  // G5: the survivors of THIS drill, measured from OUTSIDE — exactly the processes carrying `ORCHESTRA_HOME=<base>/home` in their environment (never a substring of an argv) and the units carrying our prefix + this rig's id
  // prefix (absent before) — printed, then cleaned by identity (pid + start time re-read at signal time) / by NAME.
  const home = path.join(base, 'home');
  const procs = rigProcesses(home);
  const newUnits = unitsNow(`${UNIT_PREFIX}${prefix}*`).filter((u) => !unitsBefore.has(u));
  const survivors = { procs: procs.length, units: newUnits.length, pids: procs.map((p) => p.pid) };
  for (const u of newUnits) spawnSync('systemctl', ['--user', 'stop', u], { encoding: 'utf8' });
  killByIdentity(procs, home);
  say(`SURVIVORS drill=${label} procs=${survivors.procs} scopes=${survivors.units}${survivors.procs || survivors.units ? '  ← LEAK (cleaned by identity)' : ''}`);
  fs.rmSync(base, { recursive: true, force: true });
  const pc = (tag) => lines.filter((l) => l.startsWith(`${tag} `)).map((l) => { try { return JSON.parse(l.slice(tag.length + 1)); } catch { return null; } }).filter(Boolean);
  const verdictLine = [...lines].reverse().find((l) => l.startsWith('MEMHOG-DRIVE '));
  const surv = evaluateSurvivors(survivors);
  const checks = [...pc('PC-CHECK'), { exercise, cycle: 0, ...surv }];
  say(`${surv.ok ? 'ok ' : 'RED'} ${exercise} ${surv.id} — ${surv.detail}`);
  const plantedLeak = Number(/leakPid=(\d+)/.exec(verdictLine ?? '')?.[1] ?? 0) || null;
  return { rc, label, logFile, plantedLeak, exercises: pc('PC-EXERCISE'), cycles: pc('PC-CYCLE'), chains: pc('PC-CHAIN'), checks, host: pc('PC-HOST')[0] ?? null, survivors, verdict: verdictLine ? verdictLine.split(' ')[1] : 'NO-RESULT', exercise: pc('PC-EXERCISE')[0] ?? null };
}

/** A drive that did not measure every wanted cycle has NO verdict: an empty check list must never read PASS. */
const complete = (r, cycles) => r.cycles.length === cycles && r.exercises.some((e) => e.result !== 'VOID');
const sh = (cmd, a, o = {}) => spawnSync(cmd, a, { cwd: REPO, encoding: 'utf8', ...o });
const gitHead = sh('git', ['rev-parse', '--short', 'HEAD']).stdout.trim();
const gitBranch = sh('git', ['rev-parse', '--abbrev-ref', 'HEAD']).stdout.trim();
const writeReport = (kind, body) => { fs.mkdirSync(OUT, { recursive: true }); fs.writeFileSync(path.join(OUT, `${kind}.md`), body); say(`\nreport: ${path.join(OUT, `${kind}.md`)}`); };
const h0 = hostNow();
const live0 = liveSnapshot(REAL_HOME);   // D6: nothing under ~/.claude* (or the live bus) may change during a drill
fs.mkdirSync(RUN_DIR, { recursive: true });

if (!flag('proof')) {
  const exercises = opt('exercise', 'memhog,chain').split(',').filter(Boolean);
  const cycles = Number(opt('cycles', '3')), members = Number(opt('members', '6'));
  if (exercises.length === 0 || exercises.some((e) => !['memhog', 'chain'].includes(e)) || !Number.isInteger(cycles) || cycles < 1 || !Number.isInteger(members) || members < 1 || members > 10) { say('usage: --exercise ⊂ memhog,chain · --cycles ≥ 1 · --members 1..10'); process.exit(2); }
  say(`memhog canary: ${exercises.join(',')} × ${cycles} cycles · ${members} workers + OPS + LEAD (256 MiB scopes, stand-in CLI) · token ${HEAVY} · MemAvailable ${h0.availGB.toFixed(2)} GB load ${h0.load1.toFixed(1)}`);
  const parts = [];
  for (const ex of exercises) {
    const w = await waitForHost(ex === 'chain' ? 1 : members);
    if (!w.ok) { parts.push({ exercise: ex, verdict: 'VOID', exercises: [{ exercise: ex, result: 'VOID', reason: 'host below the bar' }], cycles: [], checks: [], chains: [], host: null, survivors: { procs: 0, units: 0 } }); continue; }
    let p = await drive({ exercise: ex, members: ex === 'chain' ? 1 : members, cycles, label: `${opt('label', 'mh')}-${ex.slice(0, 3)}` });
    for (let n = 1; p.rc === 3 && n <= Number(opt('void-retries', '2')); n++) {   // a drill the host guard cut short is no verdict: wait for the host, run THAT exercise again (the bar is never relaxed)
      const w2 = await waitForHost(ex === 'chain' ? 1 : members);
      say(`   ${ex}: VOID (host guard) — retry ${n} after waiting ${w2.waitedS} s`);
      if (!w2.ok) break;
      p = await drive({ exercise: ex, members: ex === 'chain' ? 1 : members, cycles, label: `${opt('label', 'mh')}-${ex.slice(0, 3)}-r${n}` });
    }
    parts.push({ ...p, exercise: ex });
  }
  const live1 = liveSnapshot(REAL_HOME);
  const liveCheck = evaluateLiveUntouched(live0, live1);
  say(`${liveCheck.ok ? 'ok ' : 'RED'} ${liveCheck.id} — ${liveCheck.detail}`);
  const mh = parts.find((p) => p.exercise === 'memhog');
  const ch = parts.find((p) => p.exercise === 'chain');
  const chainSurv = ch ? ch.checks.filter((c) => c.id === 'bar:no_survivors').map((c) => ({ ...c, exercise: 'chain' })) : [];
  const mhChecks = mh ? [...mh.checks, ...chainSurv, { exercise: 'memhog', cycle: 0, ...liveCheck }] : [];
  const mhVerdict = !mh ? null : mh.rc === 3 || mh.verdict === 'VOID' ? 'VOID' : !complete(mh, cycles) ? 'FAIL' : drillVerdict(mhChecks, [...REQUIRED_CYCLE_CHECKS, 'bar:no_survivors', 'bar:live_config_untouched']);
  // the Q9 chain's state: a result is only believed when EVERY wanted run reported (a chain cut short is neither KNOWN-RED nor GONE)
  const chRaw = ch ? (ch.exercises[0]?.result ?? ch.verdict) : null;
  const chV = !ch ? null : ['KNOWN-RED', 'KNOWN-RED-GONE'].includes(chRaw) ? (ch.chains.length === cycles ? chRaw : 'INCOMPLETE') : chRaw === 'VOID' || ch.rc === 3 ? 'VOID' : 'ERROR';
  const chainSurvBad = !!ch && ch.checks.some((c) => c.id === 'bar:no_survivors' && !c.ok);
  const table = mh ? renderMemhogTable(mh.cycles.map((c) => ({ ...c, checks: c.checks }))) : '(memhog not run)';
  const reds = mhChecks.filter((c) => !c.ok);
  const full = exercises.includes('memhog') && exercises.includes('chain') && members >= 6 && cycles >= 3 && (chV === 'KNOWN-RED' || chV === 'KNOWN-RED-GONE');
  const md = [`# Pause canary 1b — memory-hog exercise (${members} workers + OPS + LEAD, ${cycles} cycles)`, '',
    `tree ${gitHead} (${gitBranch}) · stand-in CLI (a real claude does not fit D2's ≤ 300 MB scopes: NOT run) · cap ${0.25} GB (256 MiB), warning 0.2 GB · heavy token ${HEAVY}`,
    `host: bar ${MIN_AVAIL_GB} GB / load 20 · min MemAvailable ${mh?.host?.minAvailGB?.toFixed(2) ?? 'n/a'} GB · \`memory_cap\` default NOT flipped (Q9 blocks it; the LEAD decides)`, '', table, '',
    `verdict memhog: **${mhVerdict ?? 'not run'}**${mhVerdict === 'PASS' && !full ? ` (PARTIAL: not ${exercises.includes('chain') ? '' : 'memhog+chain × '}≥ 6 workers × ≥ 3 cycles)` : ''}`,
    ch ? `Q9 chain (KNOWN-RED, not a bar — ${KNOWN_RED['q9:session_survives_chain'].ref}): **${chV}** — ${ch.exercises[0]?.detail ?? ''}` : 'Q9 chain: not run',
    `survivors: ${parts.map((p) => `${p.exercise} procs=${p.survivors.procs} scopes=${p.survivors.units}`).join(' · ')}`,
    `bars (never lowered): hog killed (tool + kernel + named record) · keeper + CLI same pid+start and still answer · scope active, cap.state active · exactly one #322 notice row per kill · exactly one escalation per kill to the coordinator, read by its own relève · only the coordinator told · 0 survivors · live config untouched. No latency bar: published.`, '',
    reds.length ? `RED checks:\n${reds.map((c) => `- ${c.exercise} c${c.cycle} \`${c.id}\` — ${c.detail}`).join('\n')}` : 'no RED bar.', ''].join('\n');
  writeReport('report', md);
  fs.writeFileSync(path.join(OUT, 'report.json'), JSON.stringify({ tree: gitHead, members, cycles, token: HEAVY, memhog: mh && { verdict: mhVerdict, cycles: mh.cycles, checks: mhChecks }, chain: ch && { verdict: chV, runs: ch.chains, detail: ch.exercises[0]?.detail } }, null, 1));
  say(`\n${table}\n`);
  fs.rmSync(RUN_DIR, { recursive: true, force: true });
  const gone = chV === 'KNOWN-RED-GONE';
  const chainMeasured = chV === 'KNOWN-RED' || gone;
  // the verdict word: memhog's (PARTIAL when green but not the contract shape), else — chain alone — the chain's own state. A chain that was ASKED FOR and never measured is no PASS; a leak or a changed live config fails whatever ran.
  let word = mh ? (mhVerdict === 'PASS' && !full ? 'PARTIAL' : mhVerdict) : ch ? (chV === 'KNOWN-RED' ? 'KNOWN-RED' : gone ? 'KNOWN-RED-GONE' : chV === 'VOID' ? 'VOID' : 'FAIL') : 'NOT-RUN';
  if (mh && ch && !chainMeasured && (word === 'PASS' || word === 'PARTIAL')) word = chV === 'VOID' ? 'VOID' : 'FAIL';
  if (!mh && (chainSurvBad || !liveCheck.ok)) word = 'FAIL';
  say(`MEMHOG-CANARY: ${word}${members < 6 && mh ? ` (${members} workers — labelled, not the 6 of the ticket)` : ''}${ch ? ` · Q9 chain ${chV}` : ''}${gone ? ' — THE KNOWN-RED INSTRUMENT WENT GREEN: Q9 fixed or the chain stopped reproducing; look, then promote it to a bar' : ''}`);
  process.exit(gone && ['PASS', 'PARTIAL', 'KNOWN-RED-GONE'].includes(word) ? 5 : word === 'PASS' || word === 'KNOWN-RED' ? 0 : word === 'PARTIAL' ? 4 : word === 'VOID' || word === 'NOT-RUN' ? 3 : 1);
}

// ── the HARNESS proof ──
const only = new Set((opt('only', '') || '').split(',').filter(Boolean));
const sel = PROOF_ARMS.filter((a) => only.size === 0 || only.has(a.name) || only.has(a.name.replace(/^(control|known-red):/, '')));
if (sel.length === 0) { say(`MEMHOG-CANARY PROOF: no arm matches --only ${JSON.stringify([...only])} (have: ${PROOF_ARMS.map((a) => a.name).join(', ')})`); process.exit(2); }
const members = Number(opt('members', '3'));
say(`harness proof: ${sel.length} arm(s) at ${members} workers × ${opt('cycles', '1')} cycle(s) · token ${HEAVY} · MemAvailable ${h0.availGB.toFixed(2)} GB`);
const rows = [];
/** The live-config instrument on a SCRATCH home (no drive, nothing heavy): unchanged ⇒ green; an added entry ⇒ RED with the change in the detail. */
function liveConfigControl() {
  const fake = path.join(RUN_DIR, 'fakehome');
  fs.mkdirSync(path.join(fake, '.claude'), { recursive: true });
  for (const f of ['a.json', 'b.json']) fs.writeFileSync(path.join(fake, '.claude', f), '{}');
  const before = liveSnapshot(fake);
  const same = evaluateLiveUntouched(before, liveSnapshot(fake));
  fs.writeFileSync(path.join(fake, '.claude', 'c.json'), '{}');
  const changed = evaluateLiveUntouched(before, liveSnapshot(fake));
  fs.symlinkSync(path.join(fake, '.claude', 'a.json'), path.join(fake, '.claude', 'link'));
  const linked = evaluateLiveUntouched(before, liveSnapshot(fake));
  fs.rmSync(fake, { recursive: true, force: true });
  const ok = same.ok === true && changed.ok === false && /CHANGED/.test(changed.detail) && linked.ok === false;
  return { verdict: ok ? 'AS-EXPECTED (RED seen)' : 'MUTANT-SURVIVED', why: `unchanged → ${same.ok ? 'green' : 'RED'}; an added entry → ${changed.ok ? 'GREEN (!)' : 'RED'}; a new symlink → ${linked.ok ? 'GREEN (!)' : 'RED'}` };
}

for (const arm of sel) {
  if (arm.internal === 'live-config') {
    const c = liveConfigControl();
    rows.push({ arm: arm.name, ...c });
    say(`\n=== ${arm.name}: ${c.verdict} — ${c.why}`);
    continue;
  }
  const m = arm.exercise === 'chain' ? 1 : members;
  const hw = await waitForHost(m, arm.switch === 'off');
  if (!hw.ok) { rows.push({ arm: arm.name, verdict: 'VOID', why: `host below the bar+rig (${hw.need.toFixed(1)} GB) for ${hw.waitedS} s (MemAvailable ${hw.availGB.toFixed(2)} GB, load ${hw.load1.toFixed(1)})` }); continue; }
  say(`\n=== ${arm.name} (${arm.expect ? 'must-PASS' : arm.expectVerdict ? `verdict ${arm.expectVerdict}` : `must-FAIL: ${arm.redden.join(' | ')} RED`}) ===`);
  const cyc = arm.cycles ?? Number(opt('cycles', '1'));
  const runArm = () => drive({ exercise: arm.exercise, members: m, cycles: cyc, off: arm.switch === 'off', sabotage: arm.sabotage ?? null, label: `p-${arm.name.replace(/[^a-z0-9]+/gi, '').slice(-9)}` });
  let r = await runArm();
  for (let n = 1; r.rc === 3 && n <= Number(opt('void-retries', '2')); n++) { const w = await waitForHost(m, arm.switch === 'off'); say(`   ${arm.name}: VOID (host guard) — retry ${n} after waiting ${w.waitedS} s`); if (!w.ok) break; r = await runArm(); }
  const red = r.checks.filter((c) => !c.ok);
  let verdict, why;
  if (r.rc === 3) { verdict = 'VOID'; why = 'host guard (the drill was cut short)'; }
  else if (arm.exercise === 'chain') {
    const ex = r.exercises[0];
    const got = ex?.result ?? r.verdict;
    const measured = (arm.redden ?? []).filter((id) => red.some((c) => c.id === id && !/NOT MEASURED/.test(c.detail) && (!arm.expectDetail || arm.expectDetail.test(c.detail))));
    verdict = got === arm.expectVerdict && (arm.redden ? measured.length === arm.redden.length : true) ? 'AS-EXPECTED' : got === 'KNOWN-RED-GONE' ? 'STALE (KNOWN-RED-GONE: Q9 fixed or the chain stopped reproducing — look, then promote it to a bar)' : `UNEXPECTED (${got})`;
    why = `${got}: ${ex?.detail ?? ''}${arm.redden ? ` · RED with a measured reason: ${measured.join(', ') || 'none'}` : ''}`;
  } else if (arm.expect) {
    // a drive that died, was cut short, or measured only the runner's own check is NOT a pass: it needs every required check present and green, a complete set of cycles and a clean exit
    const miss = missingChecks(r.checks, [...REQUIRED_CYCLE_CHECKS, 'bar:no_survivors']);
    const green = r.rc === 0 && complete(r, cyc) && drillVerdict(r.checks, [...REQUIRED_CYCLE_CHECKS, 'bar:no_survivors']) === 'PASS';
    verdict = green ? 'AS-EXPECTED (PASS)' : 'UNEXPECTED-RED';
    why = green ? `${r.checks.length} checks green` : `${miss.length ? `MISSING checks: ${miss.join(', ')}; ` : ''}rc=${r.rc}; RED: ${red.map((c) => `c${c.cycle} ${c.id} (${c.detail.slice(0, 100)})`).slice(0, 6).join(' · ') || 'none'}`;
  }
  else {
    // the named instrument must be RED with a MEASURED reason (a check red only because its metric is absent proves nothing), and the instruments that must stay GREEN did
    const hit = arm.redden.filter((id) => red.some((c) => c.id === id && !/NOT MEASURED/.test(c.detail) && (!arm.expectDetail || arm.expectDetail.test(c.detail))));
    const overRed = (arm.stayGreen ?? []).filter((id) => red.some((c) => c.id === id));
    const premiseRed = red.filter((c) => /^premise_/.test(c.id));
    // instruments that must read RED for ANY reason (a metric that cannot exist once the thing under sabotage is gone — « NOT MEASURED » is the honest red of a published timing)
    const anyMissing = (arm.reddenAny ?? []).filter((id) => !red.some((c) => c.id === id));
    // the rig itself must have got the fleet up and measured: a drive that never did proves nothing (the no-worker control EXPECTS workers_up red — the cycle must still have been evaluated)
    const reached = (arm.workersUpExpectedRed ? r.checks.some((c) => c.id === 'bar:hog_killed') : r.checks.some((c) => c.id === 'workers_up' && c.ok)) && complete(r, cyc);
    // the leak control: the PLANTED process (its own pid, announced by the drill) must be among the survivors the parent measured — any other leftover would not prove the instrument sees THIS one
    const plantedMissing = arm.sabotage === 'leak' && !(r.plantedLeak && r.survivors.pids.includes(r.plantedLeak));
    verdict = memhogArmVerdict({ reached, premiseRed, hit: hit.length === arm.redden.length && anyMissing.length === 0 && !plantedMissing ? hit : [], overRed });
    why = `${premiseRed.length ? `PREMISE RED (${premiseRed.map((c) => c.id).join(', ')}); ` : ''}RED with a measured reason: ${hit.join(', ') || 'none'}${anyMissing.length ? `; NOT red (must be): ${anyMissing.join(', ')}` : ''}${plantedMissing ? '; the planted leak pid is not among the survivors the parent measured' : ''}${overRed.length ? `; OVER-RED (must stay green): ${overRed.join(', ')}` : ''}; all RED: ${red.map((c) => `c${c.cycle} ${c.id}`).slice(0, 8).join(' · ') || 'none'}`;
  }
  rows.push({ arm: arm.name, verdict, why, log: r.logFile });
  say(`=== ${arm.name}: ${verdict} — ${why}`);
}
const live1 = liveSnapshot(REAL_HOME);
const liveCheck = evaluateLiveUntouched(live0, live1);
say(`${liveCheck.ok ? 'ok ' : 'RED'} ${liveCheck.id} — ${liveCheck.detail}`);
const bad = rows.filter((r) => !/^AS-EXPECTED/.test(r.verdict));
const proven = bad.length === 0 && liveCheck.ok;
const md = ['# Pause canary 1b — memory-hog harness proof (#324)', '', `tree ${gitHead} (${gitBranch}) · ${members} workers × ${opt('cycles', '1')} cycle · token ${HEAVY} · host MemAvailable at start ${h0.availGB.toFixed(2)} GB`, '', '| arm | verdict | evidence |', '|---|---|---|', ...rows.map((r) => `| ${r.arm} | ${r.verdict} | ${r.why.replace(/\|/g, '/')} |`), '', `${liveCheck.id}: ${liveCheck.ok ? 'ok' : liveCheck.detail}`, `PROOF: ${proven ? (only.size === 0 ? 'PASS' : `PARTIAL (${rows.length}/${PROOF_ARMS.length} arms)`) : 'NOT PROVEN'}`, ''].join('\n');
writeReport('proof', md);
fs.rmSync(RUN_DIR, { recursive: true, force: true });
say(`\nMEMHOG-CANARY PROOF: ${proven ? (only.size === 0 ? 'PASS' : `PARTIAL (${rows.length}/${PROOF_ARMS.length} arms)`) : `FAIL (${bad.map((r) => `${r.arm}:${r.verdict}`).join(', ')}${liveCheck.ok ? '' : ', live config changed'})`}`);
process.exit(proven ? (only.size === 0 ? 0 : 4) : bad.length > 0 && bad.every((r) => r.verdict === 'VOID') ? 3 : 1);
