#!/usr/bin/env node
// #294 — BUILD-LEVEL mutants of the PACKAGED-APP drive (scripts/e2e-composed-drive.sh). The clauses only a REAL keeper + relay + app can show: the keeper's Docker relay STAMPS creates (#291), the member's DOCKER_HOST points
// at it (#291), and the app's `setWakeKeeperResident` wiring makes a keeper-resident member's wake a reattach instead of a held start (#287 seat-2 F1 → W59 of the admission harness). Each mutant edits ONE source clause in the
// scratch app tree (`<base>/app-src`, made by `e2e-composed-drive.sh --build`), REBUILDS the packaged app from it, runs the drive, and is KILLED only if its NAMED check is red (anything else is no kill). The source file is
// restored from git and `git diff` of the app tree must be empty after every mutant; the clean packaged app must PASS the same drive first (control). HEAVY (packaged builds + a compositor + Docker): needs the heavy-rig token.
//
//   node scripts/composed-drive-mutants.mjs [--only <id[,id]>] [--check-anchors] [--list]        →  last line: MUTATE-DRIVE: PASS|FAIL (n/N killed)

import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const REPO = path.resolve(HERE, '..');
const BASE = process.env.E2E_COMPOSED_BASE ?? path.join(os.homedir(), '.cache', 'g10d');
const TREE = path.join(BASE, 'app-src');
const args = process.argv.slice(2);
const only = args.includes('--only') ? new Set(args[args.indexOf('--only') + 1].split(',')) : null;

// id · source row (the tracks' own anchors) · ticket/clause · drive phases to run · the check that must be RED
const MUTANTS = [
  { id: '291-R1', from: 'docker-relay-mutants.mjs:R1', ticket: '#291', clause: 'the relay STAMPS orchestra.ws / orchestra.run on every create', phases: 'main', containers: 4, check: 'A1_the_relay_stamped_orchestra_ws_and_orchestra_run',
    file: 'src/keeper/docker-relay.ts', find: 'if (stamped) body = stamped;', to: 'if (false as boolean) body = stamped as Buffer;' },
  { id: '291-K7', from: 'docker-relay-mutants.mjs:K7', ticket: '#291', clause: "the member's DOCKER_HOST points at the keeper's relay", phases: 'main', containers: 4, check: 'A1_the_relay_stamped_orchestra_ws_and_orchestra_run',
    file: 'src/keeper/index.ts', find: '    return { ...env, DOCKER_HOST: `unix://${relaySock}` };', to: '    return env;' },
  { id: '287-W59', from: 'admission-mutants.mjs:W59', ticket: '#287', clause: "setWakeKeeperResident is wired in the app: a keeper-resident member's wake only REATTACHES (seat-2 F1)", phases: 'resident', containers: 3, check: 'B3_the_resident_members_wake_was_a_reattach_not_held',
    file: 'src/main/index.ts', find: '  setWakeKeeperResident(keeperResident);', to: '  void setWakeKeeperResident;' },
  { id: '289-banner-never-renders', from: 'memory-banner/mutate-unit.mjs (component clause, build level)', ticket: '#289', clause: 'the banner renders while Admission is held (the packaged app shows it)', phases: 'main', containers: 4, check: 'A2_the_amber_banner_shows_while_admission_is_held',
    file: 'src/renderer/components/MemoryBanner.tsx', find: '  if (!banner || !bannerVisible(banner, dismissed)) return null;', to: '  return null;' },
];
if (args.includes('--list')) { for (const m of MUTANTS) console.log(`${m.id.padEnd(9)} ${m.ticket} ${m.phases}/${m.check} — ${m.clause}`); process.exit(0); }

const git = (...a) => spawnSync('git', ['-C', TREE, ...a], { encoding: 'utf8' });
if (!fs.existsSync(path.join(TREE, '.git'))) { console.log(`MUTATE-DRIVE: ABORT (no app tree at ${TREE} — run scripts/e2e-composed-drive.sh --build first)`); process.exit(2); }
const bad = MUTANTS.filter((m) => (fs.readFileSync(path.join(TREE, m.file), 'utf8').split(m.find).length - 1) !== 1).map((m) => `${m.id}: anchor in ${m.file} does not match exactly once`);
if (args.includes('--check-anchors')) { for (const b of bad) console.log(`✗ ${b}`); console.log(bad.length ? 'ANCHORS: FAIL' : `ANCHORS: OK (${MUTANTS.length} mutants)`); process.exit(bad.length ? 1 : 0); }
if (bad.length) { for (const b of bad) console.log(`✗ ${b}`); process.exit(2); }
if (git('status', '--porcelain', '--', 'src').stdout.trim()) { console.log('MUTATE-DRIVE: ABORT (the app tree is dirty)'); process.exit(2); }

function build(dest) {
  for (const [c, a] of [['pnpm', ['run', 'build:bundles']], ['npx', ['electron-builder', '--dir']]]) {
    const r = spawnSync(c, a, { cwd: TREE, encoding: 'utf8', maxBuffer: 64 << 20 });
    if (r.status !== 0) return { ok: false, why: `${c} ${a.join(' ')} failed: ${(r.stdout + r.stderr).slice(-300)}` };
  }
  const unp = fs.readdirSync(path.join(TREE, 'release')).find((d) => /-unpacked$/.test(d));
  if (!unp) return { ok: false, why: 'no *-unpacked dir' };
  fs.rmSync(dest, { recursive: true, force: true });
  spawnSync('cp', ['-a', '--reflink=auto', path.join(TREE, 'release', unp), dest]);
  return { ok: true };
}
function drive(app, m) {
  const r = spawnSync('timeout', ['-k', '30', '900', 'bash', path.join(HERE, 'e2e-composed-drive.sh'), '--app', path.join(app, 'orchestra'), '--phases', m.phases, '--containers', String(m.containers), '--label', 'm'], { cwd: REPO, encoding: 'utf8', maxBuffer: 64 << 20 });   // `timeout -k` signals the whole process group: no orphaned driver overlaps the next mutant's build
  const out = (r.stdout ?? '') + (r.stderr ?? '');
  return { red: [...out.matchAll(/^RED (\S+)/gm)].map((x) => x[1]), verdict: /^COMPOSED-DRIVE (\w+)/m.exec(out)?.[1] ?? null, out };
}

let killed = 0, n = 0, controlOk = false;
if (!only || only.has('control')) {
  // the control is the CLEAN packaged app `e2e-composed-drive.sh --build` made from the same commit (the newest apps/src-*)
  const clean = fs.readdirSync(path.join(BASE, 'apps')).filter((d) => d.startsWith('src-')).map((d) => path.join(BASE, 'apps', d)).sort((a, b) => fs.statSync(b).mtimeMs - fs.statSync(a).mtimeMs)[0];
  if (!clean) { console.log('MUTATE-DRIVE: ABORT (no clean packaged app — run e2e-composed-drive.sh --build)'); process.exit(2); }
  console.log(`control: the CLEAN packaged app ${clean}, the whole drive …`);
  const c = drive(clean, { phases: 'main,resident', containers: 4 });
  console.log(`control: COMPOSED-DRIVE ${c.verdict} ${c.red.length ? `RED ${c.red.join(',')}` : ''}`);
  if (c.verdict !== 'PASS') { console.log('CONTROL NOT GREEN'); process.exit(2); }
  controlOk = true;
}
for (const m of MUTANTS) {
  if (only && !only.has(m.id)) continue;
  n++;
  const abs = path.join(TREE, m.file);
  const orig = fs.readFileSync(abs);
  let res = null, why = null;
  const dest = path.join(BASE, 'apps', `mut-${m.id}`);
  try {
    fs.writeFileSync(abs, orig.toString('utf8').replace(m.find, () => m.to));
    const b = build(dest);
    if (!b.ok) why = b.why; else res = drive(dest, m);
  } finally {
    git('checkout', '--', m.file);
    fs.rmSync(dest, { recursive: true, force: true });
  }
  const restored = git('status', '--porcelain', '--', 'src').stdout.trim() === '' && fs.readFileSync(abs).equals(orig);
  const dead = !!res && res.red.includes(m.check);
  if (dead) killed++;
  console.log(dead ? `✓ ${m.id} [${m.ticket}] ${m.phases} → ${m.check}  (also red: ${res.red.filter((r) => r !== m.check).join(',') || '—'})` : `✗ ${m.id} [${m.ticket}] ${m.phases}/${m.check}: ${why ?? (res ? `${res.verdict}: red = ${res.red.join(',') || 'none'}` : 'no result')}${restored ? '' : ' — NOT RESTORED'}`);
  if (!restored) { console.log('MUTATE-DRIVE: ABORT (source not restored)'); process.exit(3); }
}
console.log(`MUTATE-DRIVE: ${killed === n ? 'PASS' : 'FAIL'} (${killed}/${n} killed${controlOk ? ', control PASS' : ''})`);
process.exit(killed === n ? 0 : 1);
