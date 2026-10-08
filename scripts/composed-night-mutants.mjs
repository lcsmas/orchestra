#!/usr/bin/env node
// #294 — IN-PLACE mutation sweep of the COMPOSED NIGHT (scripts/e2e-composed-night.mjs). One mutant = one clause of tickets #285–#292 edited in the REAL source (anchors reused from the tracks' own harnesses,
// scripts/composed-night-mutants.table.mjs); the night is replayed up to the arm the mutant names (RIG_UPTO) and the mutant is KILLED only if THAT arm is red AND its named CHECK is among the red ones
// (a crash, a different arm or a different check is "no kill"). Byte-exact backup before, restore + `cmp` after every mutant (also on SIGINT/SIGTERM); `git diff -- src` must be empty at the end (commit
// first); a clean control (the whole night ALL PASS) gates the sweep and is re-run after it. HEAVY by the wave rule (a mutation sweep): needs the heavy-rig token — it refuses below 9 GB MemAvailable.
//
//   node scripts/composed-night-mutants.mjs [--only <id[,id]>] [--check-anchors] [--list] [--no-memcheck]        →  last line: MUTATE-NIGHT: PASS|FAIL (n/N killed)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { MUTANTS } from './composed-night-mutants.table.mjs';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;
const RIG = path.join(HERE, 'e2e-composed-night.mjs');
const REGISTER = pathToFileURL(path.join(HERE, '.r2-register.mjs')).href;
const rigText = fs.readFileSync(RIG, 'utf8');
const ARMS = [...(/const ARM_NAMES = \[([^\]]*)\]/.exec(rigText)?.[1] ?? '').matchAll(/'([^']+)'/g)].map((m) => m[1]);   // the rig's own arm list (a new arm needs no edit here)
if (ARMS.length === 0) { console.log('MUTATE-NIGHT: ABORT (cannot read ARM_NAMES from the rig)'); process.exit(2); }

const read = (rel) => fs.readFileSync(path.join(REPO, rel), 'utf8');
const count = (text, find) => text.split(find).length - 1;

// ── anchors: every edit matches EXACTLY once, every arm / check named exists in the rig ──
const rigSrc = rigText;
function anchors() {
  const bad = [];
  for (const m of MUTANTS) {
    if (!ARMS.includes(m.arm)) bad.push(`${m.id}: unknown arm ${m.arm}`);
    if (!rigSrc.includes(`'${m.check}'`)) bad.push(`${m.id}: check ${m.check} is not in the rig`);
    // edits of one file apply in order on the evolving text
    const texts = new Map();
    for (const e of m.edits) {
      const t = texts.get(e.file) ?? read(e.file);
      const n = count(t, e.find);
      if (n !== 1) bad.push(`${m.id}: anchor matched ${n}× in ${e.file}: ${JSON.stringify(e.find.slice(0, 80))}`);
      else texts.set(e.file, t.replace(e.find, () => e.to));
    }
  }
  return bad;
}
if (args.includes('--list')) {
  for (const m of MUTANTS) console.log(`${m.id.padEnd(40)} ${m.ticket.padEnd(5)} ${m.arm}/${m.check} — ${m.clause}`);
  process.exit(0);
}
const bad = anchors();
if (args.includes('--check-anchors')) {
  for (const b of bad) console.log(`✗ ${b}`);
  console.log(bad.length ? `ANCHORS: FAIL (${MUTANTS.length} mutants, ${bad.length} stale)` : `ANCHORS: OK (${MUTANTS.length} mutants, 0 stale)`);
  process.exit(bad.length ? 1 : 0);
}
if (bad.length) { for (const b of bad) console.log(`✗ ${b}`); console.log('MUTATE-NIGHT: ABORT (stale anchors — fix the table first)'); process.exit(2); }

// ── refusals ──
if (!args.includes('--no-memcheck')) {
  const mi = fs.readFileSync('/proc/meminfo', 'utf8');
  const kb = Number(/MemAvailable:\s+(\d+)/.exec(mi)?.[1] ?? 0);
  if (kb <= 9 * 1048576) { console.log(`MUTATE-NIGHT: ABORT (MemAvailable ${(kb / 1048576).toFixed(1)} GB <= 9 GB — heavy rig refused, wave launch rule)`); process.exit(2); }
}
const dirty = spawnSync('git', ['status', '--porcelain', '--', 'src'], { cwd: REPO, encoding: 'utf8' }).stdout.trim();
if (dirty) { console.log(`MUTATE-NIGHT: ABORT (src/ is dirty — commit first so the restore proof means something):\n${dirty}`); process.exit(2); }

const BACKUP = fs.mkdtempSync(path.join(os.homedir(), '.cache', 'composed-night-mutants-'));
const backedUp = new Map();   // rel → backup path (this mutant's files)
function restoreAll() {
  let ok = true;
  for (const [rel, bak] of backedUp) {
    try { fs.copyFileSync(bak, path.join(REPO, rel)); } catch { ok = false; continue; }
    if (spawnSync('cmp', [path.join(REPO, rel), bak]).status !== 0) ok = false;
  }
  backedUp.clear();
  return ok;
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });

/** The night execs `dist-electron/cli.js` (bus-status): a mutant of src/cli or src/shared is only visible through a bundle rebuilt AFTER the edit — and the restore must rebuild too (review F1). */
function buildCli() {
  const r = spawnSync('pnpm', ['run', 'build:cli'], { cwd: REPO, encoding: 'utf8', timeout: 120_000 });
  return r.status === 0;
}
function night(upto) {
  if (!buildCli()) return { arms: {}, verdict: 'CLI BUNDLE BUILD FAILED', status: 1 };
  const env = { ...process.env };
  delete env.RIG_REPO;
  if (upto) env.RIG_UPTO = upto; else delete env.RIG_UPTO;
  const r = spawnSync(process.execPath, ['--experimental-strip-types', '--import', REGISTER, RIG], { cwd: REPO, env, encoding: 'utf8', timeout: 240_000, killSignal: 'SIGKILL' });
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  const arms = {};
  for (const l of out.split('\n')) {
    const m = /^(PASS|FAIL) (\S+) \((\d+) checks, \d+ ms\)(?: — (.*))?$/.exec(l);
    if (m) arms[m[2]] = { ok: m[1] === 'PASS', why: m[4] ?? '' };
  }
  const verdict = /^COMPOSED NIGHT: (.*)$/m.exec(out)?.[1] ?? null;
  return { arms, verdict, status: r.status };
}
const failedChecks = (why) => [...String(why ?? '').matchAll(/(?:^| \| )(\w+): got /g)].map((m) => m[1]);

// ── control ──
console.log(`control: the whole night on the clean tree …`);
const c0 = night(null);
if (!new RegExp(`^ALL PASS \\(${ARMS.length}/${ARMS.length} arms\\)`).test(c0.verdict ?? '')) {
  console.log(`CONTROL NOT GREEN: ${c0.verdict ?? 'no verdict'} ${JSON.stringify(Object.entries(c0.arms).filter(([, v]) => !v.ok).map(([k, v]) => [k, v.why.slice(0, 200)]))}`);
  process.exit(2);
}
console.log(`control: ${c0.verdict}`);

// ── sweep ──
let killed = 0, n = 0;
const lines = [];
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  n++;
  const t0 = Date.now();
  let res = null, restored = true, applyErr = null;
  try {
    const texts = new Map();
    for (const e of m.edits) {
      if (!backedUp.has(e.file)) { const bak = path.join(BACKUP, `${n}-${e.file.replace(/\//g, '_')}`); fs.copyFileSync(path.join(REPO, e.file), bak); backedUp.set(e.file, bak); }
      const t = texts.get(e.file) ?? read(e.file);
      if (count(t, e.find) !== 1) { applyErr = `PATTERN-GONE in ${e.file}`; break; }
      texts.set(e.file, t.replace(e.find, () => e.to));
    }
    if (!applyErr) {
      for (const [rel, t] of texts) fs.writeFileSync(path.join(REPO, rel), t);
      res = night(m.arm);
    }
  } finally {
    restored = restoreAll();
  }
  const arm = res?.arms?.[m.arm];
  const reds = arm ? failedChecks(arm.why) : [];
  const dead = !!arm && !arm.ok && reds.includes(m.check);
  if (dead) killed++;
  const secs = Math.round((Date.now() - t0) / 1000);
  const line = applyErr ? `✗ ${m.id}: ${applyErr}` : dead ? `✓ ${m.id} [${m.ticket}] ${m.arm} → ${m.check} (${secs}s)` : `✗ ${m.id} [${m.ticket}] ${m.arm}/${m.check}: ${arm ? (arm.ok ? 'SURVIVED (arm green)' : `arm red but NOT by the named check — red: ${reds.join(',') || arm.why.slice(0, 160)}`) : `NO VERDICT (${res?.verdict ?? 'no output'})`}${restored ? '' : ' — NOT RESTORED'}`;
  lines.push(line);
  console.log(line);
  if (!restored) { console.log('MUTATE-NIGHT: ABORT (a file was not restored byte-exact)'); process.exit(3); }
}

// ── proof the tree is back + a clean control after the sweep ──
const gitClean = spawnSync('git', ['diff', '--quiet', '--', 'src'], { cwd: REPO }).status === 0;
const post = night(null);
console.log(`post-restore: ${post.verdict}; git diff -- src ${gitClean ? 'CLEAN' : 'DIRTY'}`);
fs.rmSync(BACKUP, { recursive: true, force: true });
const ok = killed === n && gitClean && /^ALL PASS/.test(post.verdict ?? '');
console.log(`MUTATE-NIGHT: ${ok ? 'PASS' : 'FAIL'} (${killed}/${n} killed)`);
process.exit(ok ? 0 : 1);
