// #406 must-FAIL proof for the go/no-go verdict: each mutant breaks ONE clause of src/shared/hidden-view-cost.ts; the test file must go RED.
// The mutant string is verified to occur EXACTLY once (live), the source is restored byte-exact and `cmp`-ed. Run: node scripts/mutate-hidden-view-cost.mjs
import fs from 'node:fs';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
const ROOT = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const SRC = path.join(ROOT, 'src/shared/hidden-view-cost.ts'), TEST = 'src/shared/hidden-view-cost.test.ts';
const MUTANTS = [
  ['single-run rule removed', 'd.delta <= limit && d.worst <= LIMITS.singleRunFactor * limit', 'd.delta <= limit'],
  ['limit comparison strict (< instead of ≤)', 'ok: d.delta <= limit &&', 'ok: d.delta < limit &&'],
  ['M1@8 limit loosened to 81 MB', '8: 80 * MB, 40: 250 * MB', '8: 81 * MB, 40: 250 * MB'],
  ['M2 factor 3 instead of 2', 'm2Factor: 2,', 'm2Factor: 3,'],
  ['positive control accepts any reading', 'pos.delta >= LIMITS.positiveControlMinBytes && pos.delta > LIMITS.m1RssBytes[8]!', 'true'],
  ['null control never fails', 'if (Math.abs(d.delta) > max) bad.push', 'if (false) bad.push'],
  ['projection R² never refused', 'if (fit.r2 < LIMITS.projectionMinR2)', 'if (false)'],
  ['projection allowed without a measured N=40', "if (!pts.some((p) => p[0] === 40))", 'if (false)'],
  ['N≤40 failures ignored', 'fail40.length) return', 'false) return'],
  ['crash counter ignored', 'ok: rs.length > 0 && bad === 0', 'ok: rs.length > 0'],
  ['idle-frames equality ignored', 'const ok = !!fd && fd.delta === 0 && fd.worst <= 0;', 'const ok = !!fd;'],
  ['arm-state assertion ignored by isValid', 'r.stateOk === true &&', 'true &&'],
  ['dev-length runs counted', 'if (r.windowS < LIMITS.windowS || r.settleS < LIMITS.settleS) return false;', ''],
  ['alternation never required', 'Math.floor(reps.length / Math.max(inCell, 1))) lead.push', '-1) lead.push'],
  ['A2 substitution without A2 holding', 'if (alt.every((x) => x !== undefined && x.ok))', 'if (alt.every(() => true))'],
  ['abort control not required', "ok: ab.length >= 1,", 'ok: true,'],
  ['GPU-kill control not required', 'ok: gp.length >= 1,', 'ok: true,'],
  ['C2@40 limit loosened to 11.5 %', 'c2CpuPct: { 40: 10, 160: 25 }', 'c2CpuPct: { 40: 11.5, 160: 25 }'],
  ['C1 limit loosened to 2.4 %', 'c1CpuPct: { 160: 2 }', 'c1CpuPct: { 160: 2.4 }'],
  ['G1 GPU limit loosened to 200 MB', 'g1GpuRssBytes: { 160: 150 * MB }', 'g1GpuRssBytes: { 160: 200 * MB }'],
  ['window 60 s → 50 s', 'windowS: 60,', 'windowS: 50,'],
  ['settle 30 s → 20 s', 'settleS: 30,', 'settleS: 20,'],
  ['projection R² floor 0.98 → 0.5', 'projectionMinR2: 0.98,', 'projectionMinR2: 0.5,'],
  ['positive control floor 80 MB → 60 MB (both clauses)', 'pos.delta >= LIMITS.positiveControlMinBytes && pos.delta > LIMITS.m1RssBytes[8]!', 'pos.delta >= 60 * MB'],
  ['memory floor 8 GB → 6 GB', 'memFloorKB: 8 * 1024 * 1024,', 'memFloorKB: 6 * 1024 * 1024,'],
  ['min runs 5 → 3', 'minRuns: 5,', 'minRuns: 3,'],
  ['single-run factor 1.5 → 3', 'singleRunFactor: 1.5,', 'singleRunFactor: 3,'],
  ['crash check ignores N=1', 'crashNs: [1, 8, 40, 160]', 'crashNs: [8, 40, 160]'],
  ['hung (deadline) run not counted as a failure', '(r.contextLost ?? 0) + (r.aborted ? 1 : 0)', '(r.contextLost ?? 0)'],
  ['attempted N=160 row silently projected', "if (runs.some((r) => r.kind === 'cell' && r.set === set && r.page === page && r.n === 160 && (r.arm === arm || r.arm === 'A0'))) return", "if (false) return"],
  ['frames single-run rule dropped', 'fd.delta === 0 && fd.worst <= 0', 'fd.delta === 0'],
  ['alternation read off schedule seq not clock', 'r.t ? Date.parse(r.t) : r.seq', 'r.seq'],
  ['GPU RSS 0 accepted by isValid', 'r.gpuRssKB > 0 /* a gpu-process was sampled */', 'true'],
  ['null crash counters accepted by isValid', 'r.crashes !== null && r.contextLost !== null;', 'true;'],
  ['CPU window length not checked', 'r.cpuWindowS != null && r.cpuWindowS >= LIMITS.windowS - LIMITS.cpuWindowSlackS &&', ''],
];
const orig = fs.readFileSync(SRC);
const run = () => spawnSync('node', ['--test', '--experimental-strip-types', '--disable-warning=MODULE_TYPELESS_PACKAGE_JSON', TEST], { cwd: ROOT, encoding: 'utf8' });
const base = run();
if (base.status !== 0) { console.error('ABORT: the unmutated suite is not green'); process.exit(2); }
console.log(`baseline: green (${/# pass (\d+)/.exec(base.stdout)?.[1]} pass)`);
let survived = 0;
try {
  for (const [name, from, to] of MUTANTS) {
    const text = orig.toString('utf8'); const n = text.split(from).length - 1;
    if (n !== 1) { console.log(`MUTANT-INVALID ${name}: string occurs ${n}×`); survived++; continue; }
    fs.writeFileSync(SRC, text.replace(from, () => to));
    const r = run(); const red = r.status !== 0;
    console.log(`${red ? 'KILLED  ' : 'SURVIVED'} ${name}${red ? ` (${/# fail (\d+)/.exec(r.stdout)?.[1]} failing)` : ''}`);
    if (!red) survived++;
    fs.writeFileSync(SRC, orig);
  }
} finally { fs.writeFileSync(SRC, orig); }
const same = Buffer.compare(fs.readFileSync(SRC), orig) === 0; // byte-exact restore
console.log(`restore: ${same ? 'byte-exact' : 'DIFFERENT'}; ${MUTANTS.length - survived}/${MUTANTS.length} killed`);
process.exit(survived || !same ? 1 : 0);
