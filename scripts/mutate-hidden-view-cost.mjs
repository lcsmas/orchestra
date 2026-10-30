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
  ['idle-frames equality ignored', 'ok: !!fd && Math.abs(fd.delta) <= LIMITS.g1IdleFramesDelta', 'ok: !!fd'],
  ['arm-state assertion ignored by isValid', 'r.stateOk === true &&', 'true &&'],
  ['dev-length runs counted', 'if (r.windowS < LIMITS.windowS || r.settleS < LIMITS.settleS) return false;', ''],
  ['alternation never required', 'Math.floor(reps.length / Math.max(inCell, 1))) lead.push', '-1) lead.push'],
  ['A2 substitution without A2 holding', 'if (alt.every((x) => x !== undefined && x.ok))', 'if (alt.every(() => true))'],
  ['abort control not required', "ok: ab.length >= 1,", 'ok: true,'],
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
