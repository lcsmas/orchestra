// In-place mutation sweep of the resource service. Each mutant of mutants/<ticket>.json edits real source (one or more exact-once `find` strings),
// runs the named test files, and must turn red a test whose NAME contains one of `expect`. Byte-exact backup + compare after every mutant; an
// anchor that does not match exactly once REFUSES the sweep (a stale mutant proves nothing).
// Run: node scripts/mutants.mjs [--ticket a1] [--only M01,M02] [--check-anchors]
import { spawnSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const flag = (name) => (args.includes(name) ? args[args.indexOf(name) + 1] : null);
const ticket = flag('--ticket');
const only = flag('--only') ? new Set(flag('--only').split(',')) : null;
const checkOnly = args.includes('--check-anchors');

const files = fs.readdirSync(path.join(ROOT, 'mutants')).filter((f) => f.endsWith('.json') && (!ticket || f === `${ticket}.json`)).sort();
if (files.length === 0) throw new Error(`no mutants/${ticket ?? '*'}.json`);
const mutants = files.flatMap((f) => JSON.parse(fs.readFileSync(path.join(ROOT, 'mutants', f), 'utf8')).map((m) => ({ ...m, from: f })));
const selected = mutants.filter((m) => !only || only.has(m.id) || [...only].some((o) => m.id.startsWith(`${o}_`)));
if (new Set(mutants.map((m) => m.id)).size !== mutants.length) throw new Error('duplicate mutant ids');

const count = (text, needle) => (needle === '' ? 0 : text.split(needle).length - 1);
function checkAnchors(m) {
  for (const e of m.edits) {
    const n = count(fs.readFileSync(path.join(ROOT, e.file), 'utf8'), e.find);
    if (n !== 1) throw new Error(`${m.id}: anchor occurs ${n}x (must be exactly 1) in ${e.file}: ${JSON.stringify(e.find.slice(0, 80))}`);
    if (e.find === e.to) throw new Error(`${m.id}: find === to (a no-op mutant)`);
  }
}
for (const m of selected) checkAnchors(m);
console.log(`anchors OK for ${selected.length} mutant(s)`);
if (checkOnly) process.exit(0);

// Restore guard: whatever happens, put the originals back.
const backups = new Map(); // abs path -> Buffer
function restoreAll() {
  for (const [p, buf] of backups) fs.writeFileSync(p, buf);
}
for (const sig of ['SIGINT', 'SIGTERM', 'SIGHUP']) process.on(sig, () => { restoreAll(); process.exit(130); });
process.on('exit', restoreAll);

function runTests(testFiles) {
  const r = spawnSync(process.execPath, ['--test', '--test-timeout=90000', '--test-reporter=tap', ...testFiles], { cwd: ROOT, encoding: 'utf8', timeout: 300_000, env: { ...process.env, TMPDIR: process.env.TMPDIR ?? os.tmpdir() } });
  const out = `${r.stdout}\n${r.stderr}`;
  const num = (k) => Number((new RegExp(`^# ${k} (\\d+)`, 'm').exec(out) ?? [0, NaN])[1]);
  const failed = [...out.matchAll(/^\s*not ok \d+ - (.+?)(?: # .*)?$/gm)].map((x) => x[1]);
  return { status: r.status, timedOut: r.error?.code === 'ETIMEDOUT', pass: num('pass'), fail: num('fail'), skipped: num('skipped'), failed, out };
}

// Baseline: the whole suite must be green with 0 skipped before any mutant means anything.
const allTests = fs.readdirSync(path.join(ROOT, 'test')).filter((f) => f.endsWith('.test.ts')).map((f) => `test/${f}`);
const base = runTests(allTests);
console.log(`baseline: pass ${base.pass} fail ${base.fail} skipped ${base.skipped} (exit ${base.status})`);
if (base.status !== 0 || base.fail !== 0 || base.skipped !== 0 || !(base.pass > 0)) {
  console.error(base.out.split('\n').slice(-40).join('\n'));
  throw new Error('baseline suite is not green: refusing to mutate');
}

// A mutant that breaks cleanup must not leave processes behind: after each mutant, kill (by identity read now) whatever still carries a test rig's state-dir marker.
const RIG_MARK = `RESCTL_STATE_DIR=${path.join(process.env.TMPDIR ?? os.tmpdir(), 'resctl-test-')}`;
function reapLeaks() {
  let n = 0;
  for (const pid of fs.readdirSync('/proc').filter((x) => /^\d+$/.test(x)).map(Number)) {
    if (pid === process.pid) continue;
    let env;
    try { env = fs.readFileSync(`/proc/${pid}/environ`, 'utf8').split('\0'); } catch { continue; }
    if (!env.some((e) => e.startsWith(RIG_MARK))) continue;
    try { process.kill(pid, 'SIGKILL'); n++; } catch { /* already gone */ }
  }
  return n;
}
const results = [];
for (const m of selected) {
  const abs = [...new Set(m.edits.map((e) => path.join(ROOT, e.file)))];
  for (const p of abs) backups.set(p, fs.readFileSync(p));
  const t0 = Date.now();
  let verdict;
  let detail = '';
  try {
    for (const e of m.edits) {
      const p = path.join(ROOT, e.file);
      const cur = fs.readFileSync(p, 'utf8');
      const next = cur.replace(e.find, () => e.to);
      if (next === cur) throw new Error('mutation changed nothing');
      fs.writeFileSync(p, next);
    }
    const r = runTests(m.tests);
    const hit = r.failed.filter((n) => m.expect.some((x) => n.includes(x)));
    if (r.timedOut) { verdict = 'TIMEOUT'; }
    else if (r.status === 0 && r.fail === 0) { verdict = 'SURVIVED'; }
    else if (hit.length > 0) { verdict = 'KILLED'; detail = `by: ${hit[0]}`; }
    else { verdict = 'WRONG-KILLER'; detail = `red, but not by [${m.expect.join(' | ')}]: ${r.failed.slice(0, 3).join(' ; ')}`; }
    if (verdict !== 'KILLED') detail += `\n${r.out.split('\n').slice(-12).join('\n')}`;
  } catch (e) {
    verdict = 'ERROR';
    detail = String(e.message);
  } finally {
    for (const [p, buf] of backups) fs.writeFileSync(p, buf);
    for (const [p, buf] of backups) if (!fs.readFileSync(p).equals(buf)) throw new Error(`RESTORE FAILED for ${p}`);
    backups.clear();
  }
  const leaked = reapLeaks();
  results.push({ id: m.id, verdict, leaked });
  console.log(`${verdict.padEnd(12)} ${m.id} (${((Date.now() - t0) / 1000).toFixed(1)}s)${leaked ? ` [reaped ${leaked} leaked process(es)]` : ''} ${detail}`);
}
const bad = results.filter((r) => r.verdict !== 'KILLED');
console.log(`\n${results.length - bad.length}/${results.length} killed${bad.length ? `; NOT killed: ${bad.map((b) => `${b.id}=${b.verdict}`).join(', ')}` : ''}`);
process.exit(bad.length ? 1 : 0);
